/**
 * 回复多版本（swipe）的回归测试。
 *
 * 背景：重答从前是销毁式的——旧回复被 deleteAssistantMessagesForTurn 删掉或被
 * collapse 原地覆写，用户想要旧版本没得选。现在重答前把旧回复序列化进 turns.variants
 * 留档，新回复追加为下一个版本，气泡下方 ◀ 2/3 ▶ 左右切换。
 *
 * 覆盖：
 *   1. 存档初始化：重答前旧气泡（含分条、附件、思考）原样进 variants[0]；
 *   2. 追加：新版本入列、活跃指针指过去，第一条气泡上的 variant_index/count 同步；
 *   3. 切换：选中版本写回气泡行（写回原位，id 不变），后续对话读到的就是它；
 *   4. 切换回多气泡版本且该轮仍是最新一轮时，分条气泡补插到末尾；
 *      较早的轮次保持整段一条（与重答旧轮同一套写回原位纪律）；
 *   5. 封顶：超过 TURN_VARIANT_CAP 裁最旧的（连最初版本一起）；
 *   6. 守卫：没存档的轮、越界序号、不存在的轮都要挡住；手改文本同步回活跃版本存档；
 *   7. 媒体 GC 认得版本存档：只被 turns.variants 引用的图片不进孤儿清扫；
 *   8. 编辑（改后重聊）= 版本式重答：不作废后续、不清存档、respondToTurn 带 variants 旗标；
 *   9. 普通回复天生 1/1：没重答过的轮也落版本元信息，生成入口常驻。
 *
 * 运行：node --experimental-sqlite scripts/swipe-regression.test.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

// ── 源码断言：结构在，链路接上了 ────────────────────────────────
const dbSrc = readFileSync("src/core/db.ts", "utf8");
const agentSrc = readFileSync("src/chat/agent.ts", "utf8");
const routeSrc = readFileSync("src/server/routes/chat.ts", "utf8");
const apiSrc = readFileSync("frontend/src/api/chat.ts", "utf8");
const rowSrc = readFileSync("frontend/src/features/chat/MessageRow.tsx", "utf8");
const viewSrc = readFileSync("frontend/src/features/chat/ChatView.tsx", "utf8");
const menuSrc = readFileSync("frontend/src/features/chat/MessageMenu.tsx", "utf8");
const cssSrc = readFileSync("frontend/src/styles/components.css", "utf8");
const contractSrc = readFileSync("shared/api.ts", "utf8");
const mediaSrc = readFileSync("src/media/media.ts", "utf8");

assert(dbSrc.includes('ensureColumn("turns", "variants"'), "turns 表要有 variants 存档列");
assert(dbSrc.includes('ensureColumn("turns", "variant_index"'), "turns 表要有活跃版本指针");
assert(dbSrc.includes('ensureColumn("messages", "variant_count"'), "messages 表要有版本计数列");
assert(dbSrc.includes("存量回复补齐版本元信息"), "存量回复要有 1/1 元信息回填，老对话才有常驻切换条");
assert(/\} else \{\r?\n\s*syncVariantMeta\(turn\.id\);/.test(agentSrc),
  "普通回复也要落版本元信息（常驻 1/1 + 生成入口）");
assert(/MESSAGE_COLUMNS = "[^"]*variant_index, variant_count/.test(agentSrc), "下发列白名单必须带版本字段，否则 /api/messages 看不见");
assert(/export function setTurnVariant/.test(agentSrc), "切换入口要导出给路由");
assert(/variants: opts\.regenerate === true/.test(agentSrc), "retryTurn 必须把版本旗标传进 respondToTurn");
// 编辑（改后重聊）= 版本式重答：不再作废后续、不再清存档，旧回复进版本条。
const editFn = agentSrc.slice(
  agentSrc.indexOf("export function editAndRegenerate"),
  agentSrc.indexOf("撤回一条消息"),
);
assert(editFn.length > 0, "editAndRegenerate 函数应存在");
assert(!editFn.includes("supersedeAfter") && !agentSrc.includes("function supersedeAfter"),
  "作废式编辑（supersedeAfter）已由版本式重答取代，函数应删除");
assert(!editFn.includes("deleteAssistantMessagesForTurn"),
  "编辑路径不得提前硬删旧回复：存档在 respondToTurn 里做，提前删就没有可存的了");
assert(/respondToTurn\(turn, \{ isRetry: true, collapseReply, variants: true \}\)/.test(editFn),
  "编辑重答必须带 variants: true，走与重新生成同一套版本存档");
// 媒体引用收口必须认 turns.variants：旧版本回复的图片只住在存档 JSON 里，
// 不认的话孤儿清扫会把它们删掉，切回旧版本整版裂图。
assert(/in_variants/.test(mediaSrc), "releaseMediaFiles 引用探测必须覆盖 turns.variants");
assert(/历史版本回复/.test(mediaSrc) && mediaSrc.includes("FROM turns WHERE variants LIKE"),
  "collectMediaSources 引用来源必须扫描 turns.variants");
assert(routeSrc.includes('"/variant"') && routeSrc.includes("setTurnVariant"), "切换路由要注册且走 setTurnVariant");
assert(/messages = messagesForTurn\(id/.test(routeSrc), "切换响应要随带新行，前端不必再打一趟 /api/messages?turn=");
assert(/idx_messages_turn ON messages \(turn_id\)/.test(dbSrc), "turn_id 要有索引：按轮取行是高频路径，全表扫会越用越慢");
assert(/return withTx\(\(\) => \{/.test(agentSrc.slice(agentSrc.indexOf("export function setTurnVariant"), agentSrc.indexOf("recentMessages("))),
  "切换必须包进单事务：散着提交是四五次 fsync，弱盘上就是肉眼可见的卡");
assert(/setTurnVariant/.test(apiSrc), "前端 API 层要有 setTurnVariant");
assert(/variantCount/.test(rowSrc) && rowSrc.includes("variant-bar"), "气泡组件要有版本切换条");
assert(/variantCount >= 1/.test(rowSrc), "版本条要常驻（1/1 也显示），不能只在重答后才出现");
assert(/changeVariant/.test(viewSrc) && viewSrc.includes("onVariantChange={changeVariant}"), "聊天页要接上切换回调");
assert(/onVariantGenerate/.test(rowSrc) && viewSrc.includes("onVariantGenerate={requestVariantGenerate}"),
  "版本条右位（已是最新版本时）要提供重新生成入口，不能灰着");
assert(/\(a\.variant_index \?\? 0\) === \(b\.variant_index \?\? 0\)/.test(viewSrc),
  "sameRow 必须比较版本字段，否则切换后 memo 挡住不重绘");
assert(/旧版本保留可切换/.test(menuSrc), "菜单提示要说清旧版本会保留");
assert(/\.variant-bar/.test(cssSrc), "切换条要有样式");
assert(/variant_count\?/.test(contractSrc), "前后端契约要有版本字段");

// ── 行为断言：真库驱动 ────────────────────────────────────────
const testDb = "./data/swipe-regression.db";
const testMediaDir = "./data/swipe-regression-media";
for (const suffix of ["", "-wal", "-shm"]) rmSync(testDb + suffix, { force: true });
rmSync(testMediaDir, { recursive: true, force: true });
mkdirSync(testMediaDir, { recursive: true });
// MEDIA_DIR 是模块级常量，必须在 import media.ts 之前定好。
process.env.DB_PATH = testDb;
process.env.MEDIA_DIR = testMediaDir;

const { q } = await import("../src/core/db.ts");
const { createContact } = await import("../src/chat/contacts.ts");
const { createTurn, insertMessage, ensureTurnVariants, appendTurnVariant, setTurnVariant, updateAssistantText, syncVariantMeta, TURN_VARIANT_CAP } = await import("../src/chat/agent.ts");
const { messagesForTurn } = await import("../src/chat/agent.ts");

function variantsOf(turnId) {
  const row = q(`SELECT variants, variant_index FROM turns WHERE id = ?`).get(turnId);
  return { index: row.variant_index ?? 0, list: row.variants ? JSON.parse(row.variants) : [] };
}
function firstBubble(turnId) {
  return q(`SELECT id, text, reasoning, variant_index, variant_count FROM messages
     WHERE turn_id = ? AND role = 'assistant' AND kind = 'chat' ORDER BY id ASC LIMIT 1`).get(turnId);
}
function assistantRows(turnId) {
  return messagesForTurn(turnId).filter((r) => r.role === "assistant");
}

const contact = createContact({ name: "版本回归" });
const cid = contact.id;

// 造一轮分条回复：两颗气泡，第一颗带思考
createTurn({ id: "t1", channel: "web", text: "讲个故事", contactId: cid });
insertMessage({ channel: "web", role: "user", text: "讲个故事", turnId: "t1", contactId: cid });
insertMessage({ channel: "web", role: "assistant", text: "版本一·上", turnId: "t1", contactId: cid, reasoning: "想了想" });
insertMessage({ channel: "web", role: "assistant", text: "版本一·下", turnId: "t1", contactId: cid });

// ── 1) 存档初始化 ──
ensureTurnVariants("t1");
const init = variantsOf("t1");
assert.equal(init.list.length, 1, "首次重答前应把现有回复存成 variants[0]");
assert.deepEqual(init.list[0].texts, ["版本一·上", "版本一·下"], "分条气泡要按序存进 texts");
assert.equal(init.list[0].reasoning, "想了想", "思考原文跟着第一颗气泡存档");
assert.equal(init.index, 0);
ensureTurnVariants("t1");
assert.equal(variantsOf("t1").list.length, 1, "已有存档时再调不许重复存");

// ── 2) 追加 ──
appendTurnVariant("t1", ["版本二"], null, null, "想了二");
const afterAppend = variantsOf("t1");
assert.equal(afterAppend.list.length, 2);
assert.equal(afterAppend.index, 1, "活跃指针要指到刚生成的版本");
assert.deepEqual(afterAppend.list[0].texts, ["版本一·上", "版本一·下"], "旧版本存档保持原样");
let bubble = firstBubble("t1");
assert.equal(bubble.text, "版本一·上", "追加版本不立即改写气泡（用户没切换）");
assert.equal(bubble.variant_index, 1, "但第一条气泡上的活跃序号要跟上");
assert.equal(bubble.variant_count, 2);

// ── 3) 切换 ──
const before = firstBubble("t1");
// append 后指针已指向新版本（真实流程里气泡行就是新内容，两边一致）；
// 测试里气泡行还是旧的，先切走再切到版本二。
assert.equal(setTurnVariant("t1", 0).applied, true);
assert.equal(setTurnVariant("t1", 1).applied, true);
bubble = firstBubble("t1");
assert.equal(bubble.id, before.id, "切换必须写回原位（id 不变），不能重插掉到对话末尾");
assert.equal(bubble.text, "版本二");
assert.equal(bubble.reasoning, "想了二");
assert.equal(bubble.variant_index, 1);
assert.equal(messagesForTurn("t1").length, 2, "user 行要保留");
assert.equal(assistantRows("t1").length, 1, "换到单气泡版本时多余的分条气泡要删掉");

// 切回去：t1 是该联系人最新一轮，多气泡版本要补插回分条形状
setTurnVariant("t1", 0);
const rows = assistantRows("t1");
assert.deepEqual(rows.map((r) => r.text), ["版本一·上", "版本一·下"], "切回最初版本要恢复分条气泡");
assert.equal(rows[0].variant_count, 2, "切换后第一条气泡的版本计数还在");

// ── 4) 较早的轮次：切换后保持整段一条 ──
createTurn({ id: "t2", channel: "web", text: " newer ", contactId: cid });
insertMessage({ channel: "web", role: "user", text: "newer", turnId: "t2", contactId: cid });
insertMessage({ channel: "web", role: "assistant", text: "更新的回复", turnId: "t2", contactId: cid });
// t1 现在不是最新一轮了。追加（指针自动指到新版本，但气泡行还是旧内容——
// 真实流程里 append 紧跟新回复落库，两边天然一致；这里先切走再切回来对齐）。
ensureTurnVariants("t1");
appendTurnVariant("t1", ["版本三·甲", "版本三·乙"], null, null, null);
setTurnVariant("t1", 0);
setTurnVariant("t1", 2);
const olderRows = assistantRows("t1");
assert.equal(olderRows.length, 1, "较早的轮次切换后必须整段一条，不许把气泡插到后面的对话末尾");
assert.equal(olderRows[0].text, "版本三·甲\n\n版本三·乙", "分条要合回整段（与重答旧轮同一写法）");

// ── 5) 封顶 ──
for (let i = 0; i < 6; i += 1) appendTurnVariant("t1", [`灌版${i}`], null, null, null);
const capped = variantsOf("t1");
assert.equal(capped.list.length, TURN_VARIANT_CAP, `存档不能超过 ${TURN_VARIANT_CAP} 条`);
assert.deepEqual(capped.list[capped.list.length - 1].texts, ["灌版5"], "活跃版本必须是最新的那个");
assert.equal(firstBubble("t1").variant_count, TURN_VARIANT_CAP, "气泡上的计数要跟着封顶");

// ── 6) 守卫与手改同步 ──
assert.throws(() => setTurnVariant("t1", 99), "越界序号要被挡住");
assert.throws(() => setTurnVariant("不存在", 0), "不存在的轮要被挡住");
// 没存档的轮：appendTurnVariant 直接调要被守卫挡下（普通首答不留档）
appendTurnVariant("t2", ["不该有版本"], null, null, null);
assert.equal(variantsOf("t2").list.length, 0, "没经过 ensure 的轮不许凭空长出存档");
// 手改文本要同步回活跃版本的存档
setTurnVariant("t1", 0);
assert.equal(variantsOf("t1").index, 0);
assert.equal(updateAssistantText(firstBubble("t1").id, "手改过的版本"), true);
const synced = variantsOf("t1");
assert.deepEqual(synced.list[0].texts, ["手改过的版本"], "手改必须写回存档，否则一切版本手改就丢");
assert.equal(firstBubble("t1").text, "手改过的版本");

// ── 7) 媒体 GC 认得版本存档：只被旧版本引用的图片不许被清扫 ──
// 必须经 saveImage 落盘（落盘即登记 assets，resolveMediaFile 按 rel_path 找真身；
// 直接 writeFileSync 的文件不在库里，sweep 定位不到它，测了等于没测）。
// 存在性用 mediaDataUrl 判（读得到 dataURL = 文件在）：图片目录名是本地化的，别手拼路径。
const { saveImage, sweepOrphanMedia, mediaDataUrl } = await import("../src/media/media.ts");
const kept = saveImage(Buffer.from("fake-jpg-bytes-for-regression-test"), "image/jpeg");
const orphan = saveImage(Buffer.from("orphan-jpg-bytes-for-regression-test"), "image/jpeg");
assert(mediaDataUrl(kept.url) !== null, "测试图应真实落盘");
// 给 t2 塞一个引用 kept 图的版本存档（模拟重答带图回复后的旧版本）。
const archive = [{
  texts: ["看图"],
  attachments: JSON.stringify([kept.url]),
  attachment_meta: null,
  reasoning: null,
  created_at: Date.now(),
}];
q(`UPDATE turns SET variants = ? WHERE id = 't2'`).run(JSON.stringify(archive));
sweepOrphanMedia(0);
assert(mediaDataUrl(kept.url) !== null, "只被版本存档引用的图片不许被清扫（否则切回旧版本裂图）");
assert(mediaDataUrl(orphan.url) === null, "无引用的图片应照常被清扫");

// ── 9) 普通回复天生 1/1：没重答过的轮也要有版本元信息，生成入口才常驻 ──
createTurn({ id: "t3", channel: "web", text: "首次回答", contactId: cid });
insertMessage({ channel: "web", role: "assistant", text: "第一次的回答", turnId: "t3", contactId: cid });
syncVariantMeta("t3");
bubble = firstBubble("t3");
assert.equal(bubble.variant_count, 1, "没重答过的回复计数应为 1");
assert.equal(bubble.variant_index, 0, "活跃序号应为 0（显示成 1/1）");
assert.throws(() => setTurnVariant("t3", 0), "没有存档的轮不许切换（1/1 的左箭头本就是灰的）");

console.log("swipe-regression: 全部通过 ✓");
