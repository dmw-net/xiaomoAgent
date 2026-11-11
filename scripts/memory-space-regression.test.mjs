/**
 * 记忆空间与工具卡归属的回归测试。
 *
 * 反证口径（每条都对应真库里实测到过的坏样本）：
 * 1. 群轮次的工具卡曾 100% 落进联系人的主私聊——真库实测某群 58 轮产生的 330 张卡
 *    全部挂在 local-* 上，群会话里一张都没有；
 * 2. 群内记忆曾由抽取模型判归属，模型不给 scope 就默认 global——同一位联系人 23 条
 *    群记忆里 20 条被标成全局，其中来自「主人发言」的 0 条；
 * 3. 记忆整理曾把全部空间的条目摊平给模型合并，合并只保留 keep 那条的归属，
 *    于是群里的事能被并进全局；
 * 4. 观测路径（记忆检查 / 上下文圆环 / 提示词预览）曾不带 scope 召回，
 *    把别的群也算进「她下次会看到」。
 *
 * 空间只有两层（全局 / 某一段会话）：没有「群内某成员」层——它需要一套跨渠道
 * 身份归并才站得住，而成员数据本来就在 messages 每行上，单建名册表等于给磁盘
 * 造第二份真相源。旧库若还带名册表，迁移要并回会话层，这里也测迁移。
 *
 * 运行：node --experimental-sqlite scripts/memory-space-regression.test.mjs
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { strict as assert } from "node:assert";

const agentSrc = readFileSync("src/chat/agent.ts", "utf8");
const memorySrc = readFileSync("src/mind/memory.ts", "utf8");
const routeSrc = readFileSync("src/server/routes/memory.ts", "utf8");
const contactListSrc = readFileSync("src/chat/contact-list.ts", "utf8");
const panelSrc = readFileSync("frontend/src/features/memory/MemoryPanel.tsx", "utf8");
const cardSrc = readFileSync("frontend/src/features/memory/MemoryCard.tsx", "utf8");
const selectSrc = readFileSync("frontend/src/features/memory/MemorySpaceSelect.tsx", "utf8");

// ── 1. 工具卡必须跟着这一轮的会话 ─────────────────────────────
const toolCall = /insertMessage\(\{\s*channel: turn\.channel,\s*role: "assistant",\s*kind: "tool",[\s\S]{0,600}?\btext: JSON\.stringify/.exec(agentSrc);
assert(toolCall !== null, "找到工具卡落库那一处调用");
assert(/conversationId,/.test(toolCall[0]), "工具卡 insertMessage 必须显式带 conversationId，否则缺省落进主私聊");

// ── 2. 作用域由代码判，不由模型判 ─────────────────────────────
const testDb = "./data/memory-space-regression.db";
for (const suffix of ["", "-wal", "-shm"]) {
  const file = testDb + suffix;
  if (existsSync(file)) rmSync(file, { force: true });
}
process.env.DB_PATH = testDb;

const { db } = await import("../src/core/db.ts");
const { createContact } = await import("../src/chat/contacts.ts");
const { ensureConversation, ensureDefaultConversations, ensureLocalConversation } = await import("../src/chat/conversations.ts");
const {
  addMemoryEvent,
  countMemoryEvents,
  decideMemoryScope,
  getMemoryEvent,
  listMemoryEventsFiltered,
  listMemorySpaces,
  recall,
  setMemorySpace,
} = await import("../src/mind/memory.ts");

assert.equal(decideMemoryScope({ conversationKind: "group", modelScope: "global" }), "conversation",
  "群轮次里模型说 global 一律不给——群里别人的话不能变成全局记忆");
assert.equal(decideMemoryScope({ conversationKind: "group", modelScope: "conversation" }), "conversation",
  "群轮次一律归这个群");
assert.equal(decideMemoryScope({ conversationKind: "private", modelScope: "global" }), "global",
  "私聊里主人本人的长期事实仍然跨场景成立");
assert.equal(decideMemoryScope({ conversationKind: "private", modelScope: "conversation" }), "conversation",
  "私聊里模型标了 conversation 就留在私聊");

// ── 3. 三层归并到两层的启动迁移 ───────────────────────────────
const contact = createContact({ name: "空间回归" });
const local = ensureLocalConversation(contact.id, contact.name);
const group = ensureConversation({
  contactId: contact.id, channel: "qq", kind: "group",
  externalId: "regression-space-group", accountId: "a1", title: "测试群",
});
db.prepare(`INSERT INTO memory_events (kind, subject, content, weight, created_at, contact_id,
  scope_kind, scope_conversation_id, subject_id, subject_name)
  VALUES ('fact','依蓝','在群里自称是本鲸的主人',1,?,?,'member',?,?,?)`)
  .run(Date.now(), contact.id, group.id, "2475285611", "依蓝");
ensureDefaultConversations();
const migrated = db.prepare(`SELECT id, scope_kind, scope_conversation_id, subject_id, subject_name, content
  FROM memory_events WHERE contact_id = ?`).all(contact.id)[0];
assert.equal(migrated.scope_kind, "conversation", "老的 member 条目并回它所在的群");
assert.equal(migrated.scope_conversation_id, group.id, "并回之后仍指向原来那个群");
assert.equal(migrated.subject_id, "2475285611", "发言人 id 原样留着当出处，不参与读写");
assert.equal(migrated.content, "在群里自称是本鲸的主人", "迁移不改内容");

// ── 4. 记忆的可见范围与分区口径 ───────────────────────────────
const groupMem = addMemoryEvent({
  kind: "fact", content: "群里约定说话要带喵字", contactId: contact.id,
  scopeKind: "conversation", scopeConversationId: group.id, sourceConversationId: group.id,
});
const privateMem = addMemoryEvent({
  kind: "promise", content: "答应只在这段私聊里说的事", contactId: contact.id,
  scopeKind: "conversation", scopeConversationId: local.id, sourceConversationId: local.id,
});
const globalMem = addMemoryEvent({ kind: "fact", content: "生日在三月", contactId: contact.id, scopeKind: "global" });
const migratedId = Number(migrated.id);

// 一个查询同时命中所有条目：只有"这条在不在当前空间的可见范围里"能决定结果。
const PROBE = "群里 约定 喵 生日 三月 主人 私聊 答应 本鲸";
// 正向对照：不带空间时每条都得命中。少了这一条，下面的"没召回"可能只是因为压根没匹配上。
const unscoped = recall(contact.id, PROBE, 20, null).map((e) => e.id);
assert(unscoped.includes(globalMem) && unscoped.includes(groupMem) && unscoped.includes(privateMem) && unscoped.includes(migratedId),
  "正向对照：不带空间时全部都能命中，排除才是空间挡的");

const inPrivate = recall(contact.id, PROBE, 20, null, { conversationId: local.id }).map((e) => e.id);
assert(inPrivate.includes(globalMem), "全局记忆在私聊可见");
assert(inPrivate.includes(privateMem), "本私聊记忆在私聊可见");
assert(!inPrivate.includes(groupMem), "群会话记忆不得出现在私聊召回里");
assert(!inPrivate.includes(migratedId), "并回群的老成员记忆同样不该漏进私聊");

const inGroup = recall(contact.id, PROBE, 20, null, { conversationId: group.id }).map((e) => e.id);
assert(inGroup.includes(globalMem), "全局记忆在群里同样可见");
assert(inGroup.includes(groupMem), "本群记忆在群里可见");
assert(!inGroup.includes(privateMem), "私聊里答应的事不该被带到群里说");

// 清单是**归属分区**：一条只属于一个空间，与上面的可见性口径不同。
assert.deepEqual(listMemoryEventsFiltered(contact.id, { space: { kind: "conversation", conversationId: group.id } }).map((e) => e.id).sort(),
  [groupMem, migratedId].sort(), "群空间清单只列归属这个群的条目");
assert.deepEqual(listMemoryEventsFiltered(contact.id, { space: { kind: "global" } }).map((e) => e.id), [globalMem],
  "全局清单只列全局");
assert.equal(countMemoryEvents(contact.id, { space: { kind: "conversation", conversationId: group.id } }), 2,
  "计数与清单同口径，否则「共 N 条」和列表对不上");
assert.equal(countMemoryEvents(contact.id, {}), 4, "不筛时是这位联系人的全部");

// 空间盘点：群那栏把并回来的老成员条目也计在群下。
const spaces = listMemorySpaces(contact.id);
assert.equal(spaces.groups.length, 1, "列出一个群");
assert.equal(spaces.groups[0].count, 2, "群栏 = 群记忆 + 并回来的老成员记忆");
assert.equal(spaces.groups[0].title, "QQ 群 · 测试群", "群这一栏是「类别 · 真名」，和「私聊」同一套句式");
assert(!("members" in spaces.groups[0]), "群不再往下列成员");
// 没拿到平台群名的群，库里 title 就是字面的「QQ 群」——不能拼成「QQ 群 · QQ 群」。
const unnamedGroup = ensureConversation({
  contactId: contact.id, channel: "qq", kind: "group", externalId: "987654321", accountId: "a1",
});
assert.equal(unnamedGroup.title, "QQ 群", "无名群在会话表里存的就是占位名");
assert.equal(listMemorySpaces(contact.id).groups.find((g) => g.conversationId === unnamedGroup.id).title,
  "QQ 群 · 987654321", "无名群用数字群号分辨，避免几个群同名");
assert.equal(spaces.private.count, 1, "私聊栏只数归属私聊的");
assert.equal(spaces.private.title, "私聊", "这一栏就叫「私聊」，不拿联系人名冒充空间名");
assert.equal(spaces.global, 1, "全局栏只数全局的");

// ── 4b. 手动转移空间 ─────────────────────────────────────────
assert(setMemorySpace(globalMem, contact.id, { kind: "all" }) === false, "「全部」不是可归属的空间");
assert(setMemorySpace(globalMem, contact.id, { kind: "conversation", conversationId: group.id }), "把全局记忆收进某个群");
assert.equal(getMemoryEvent(globalMem, contact.id).scope_kind, "conversation", "转移后归属列已改写");
assert(!recall(contact.id, PROBE, 20, null, { conversationId: local.id }).map((e) => e.id).includes(globalMem),
  "收进群之后，私聊不该再想起这条");
// 转移只动归属：内容与来源都不该被改写
assert.equal(getMemoryEvent(globalMem, contact.id).content, "生日在三月", "转移不改内容");
assert.equal(getMemoryEvent(globalMem, contact.id).source_conversation_id, null, "转移不改来源会话（那是取证用的原文）");
assert(setMemorySpace(globalMem, contact.id, { kind: "global" }), "再提升回全局");
assert.equal(getMemoryEvent(globalMem, contact.id).scope_conversation_id, null, "提升回全局要清掉会话");
assert(setMemorySpace(globalMem, contact.id, { kind: "conversation", conversationId: local.id }), "也可以收到主私聊这一栏");
assert.equal(getMemoryEvent(globalMem, contact.id).scope_conversation_id, local.id, "收到私聊后归属指向主私聊");
assert(setMemorySpace(globalMem, contact.id, { kind: "global" }), "移回全局供后续断言");

// ── 5. 整理不许跨空间合并 ─────────────────────────────────────
const { sameMemorySpace } = await import("../src/chat/consolidate.ts");
const rows = db.prepare("SELECT * FROM memory_events WHERE contact_id = ? ORDER BY id").all(contact.id);
const byId = new Map(rows.map((r) => [r.id, r]));
assert(!sameMemorySpace(byId.get(globalMem), byId.get(groupMem)), "全局与群条目不是同一个空间");
assert(!sameMemorySpace(byId.get(groupMem), byId.get(privateMem)), "两个会话不是同一个空间");
assert(sameMemorySpace(byId.get(groupMem), byId.get(groupMem)), "同一条自然是同一个空间");

// ── 6. 观测路径与界面接线 ─────────────────────────────────────
assert(/recallExplained\(cid, lastUser\.text, undefined, \{ scope: \{ conversationId: convId \} \}\)/.test(agentSrc),
  "上下文圆环要按会话收窄召回，不能全库算");
assert(/scope: spaceToScope\(space\)/.test(routeSrc), "记忆检查按所选空间召回");
assert(/getConversation\(conversationId\)\?\.contact_id === contactId/.test(routeSrc),
  "空间参数里的会话 id 必须属于当前联系人，否则能翻别人的群");
assert(/conv\.contact_id !== contactId/.test(routeSrc), "转移目标必须是这位联系人的会话");
assert(/promoteMemoryEvent[\s\S]{0,200}setMemorySpace\(id, contactId, \{ kind: "global" \}\)/.test(memorySrc),
  "提升与转移共用同一个写入函数，不许留两条改归属的路");
assert(!/member/.test(memorySrc.match(/export type MemoryScopeKind =[^;]+/)[0]), "作用域枚举里不该再有 member");
assert(!/members\.ts/.test(readFileSync("src/core/db.ts", "utf8")), "群成员名册表已撤掉，不给磁盘留第二份真相源");
assert(/MemorySpaceSelect/.test(panelSrc) && /onSpaceChange/.test(panelSrc), "记忆清单要有空间选择器");
assert(!/当前会话<\/span>/.test(cardSrc), "徽标不能再写「当前会话」——管理页里没有指代对象");
assert(/convName/.test(cardSrc), "徽标要报得出是哪个群");
assert(/inventory.groups.length === 0/.test(selectSrc) && /return null/.test(selectSrc),
  "没有群的联系人不该看到空间筛选（三个没区别的选项）");
assert(!/<select/.test(selectSrc), "不用原生 select：它的弹层不吃主题");
assert(!/member/.test(selectSrc), "下拉里不再有成员这一层");
assert(/mode === "target"[\s\S]{0,400}mem-space-list/.test(selectSrc),
  "转移弹窗里的目标空间要直接列出来——弹窗内叠绝对定位的浮层会被后面的内容压住（实测截图里选项名被说明文字盖掉）");
assert(/label: inventory\.private\.title \|\| "私聊"/.test(selectSrc), "私聊那栏用后端给的名字，不拼联系人名");

// 工具卡不是消息：既不能当侧栏那句预览，也不能算进未读。
assert(/m2\.kind != 'tool'/.test(contactListSrc), "侧栏「最近一条」要跳过工具卡，否则会显示成一段工具 JSON");
assert(!/WHERE m\.role = 'assistant' AND m\.superseded_at IS NULL AND m\.id >/.test(contactListSrc),
  "未读计数必须排除工具卡，否则一轮连查五样就是五条未读");

db.close();
for (const suffix of ["", "-wal", "-shm"]) {
  const file = testDb + suffix;
  if (existsSync(file)) rmSync(file, { force: true });
}

console.log("记忆空间与工具卡归属回归测试：全部通过");
