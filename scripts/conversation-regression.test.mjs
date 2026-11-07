/**
 * 会话来源与未读红点的回归测试。
 *
 * 覆盖两个真实问题：
 * 1. QQ 群曾被摊平渲染在联系人列表里，联系人下面又长出“群 · 群名”行；
 * 2. 个人 QQ 曾与主私聊分成两段，应用/微信/QQ 的同一段关系上下文不连续；
 * 3. 会话级已读表首次建立时会把机器人历史分条回复重新算成未读，侧栏突然满屏红点。
 *
 * 运行：node --experimental-sqlite scripts/conversation-regression.test.mjs
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { strict as assert } from "node:assert";

const app = readFileSync("frontend/src/App.tsx", "utf8");
const sidebar = readFileSync("frontend/src/components/Sidebar.tsx", "utf8");
const chat = readFileSync("frontend/src/features/chat/ChatView.tsx", "utf8");
const switcher = readFileSync("frontend/src/features/chat/ConversationSwitcher.tsx", "utf8");
const qqSection = readFileSync("frontend/src/features/profile/QQSection.tsx", "utf8");

assert(!/className=\{[^}]*s-item s-conv/.test(sidebar), "QQ 会话不应再作为联系人列表的独立行渲染");
assert(/c\.id === current && !isArchived \? " active"/.test(sidebar), "联系人行应按联系人而不是某个 QQ 会话做选中态");
assert(/<ConversationSwitcher[\s\S]*?onSelect=\{onOpenConversation\}/.test(chat), "聊天页顶栏应挂载会话来源切换器");
assert(/aria-label="选择会话来源"/.test(switcher), "会话切换器应有明确的可访问名称");
assert(/私聊/.test(switcher) && /QQ 群/.test(switcher), "切换器应提供统一私聊与独立 QQ 群");
assert(/conv-switch-search/.test(switcher) && /conv-switch-scroll/.test(switcher), "群多时切换器应提供搜索与独立滚动区");
assert(/scrollIntoView/.test(switcher), "打开切换器时应把当前群滚入可视区");
assert(/已离群/.test(switcher) && /leftAt/.test(switcher), "切换器应区分已离群群并保留历史入口");
assert(/latestConv\?\.channel === "web" \? undefined : latestConv/.test(sidebar), "主私聊不应携带 local-* 会话 id");
assert(/conversationId && readOnly === true/.test(app), "应用层应把主私聊规范为 null，只让 QQ 群保留独立 id");
assert(/应用、微信、QQ 共用这一段对话/.test(switcher), "切换器应明确一对一私聊跨入口共用上下文");
assert(!/本机对话/.test(switcher), "主私聊不应再沿用割裂的“本机对话”命名");
assert(/renameQQConversation/.test(qqSection) && /恢复自动/.test(qqSection), "QQ 群列表应支持自定义群名并可恢复平台名称");
assert(/qq-conv-search/.test(qqSection) && /qq-conv-scroll/.test(qqSection), "QQ 群列表应支持多群搜索与限高滚动");
assert(/startRename\(conv\)[\s\S]{0,160}PencilLine[\s\S]{0,40}重命名/.test(qqSection), "群名可重命名：入口在行内「更多」面板里（铅笔 + 文案可辨）");
assert(/role="switch"/.test(qqSection) && /qq-conv-switch-track/.test(qqSection), "群消息接收状态应使用可识别的开关");
assert(!/私聊已并入主对话 · 群名自动读取，也可以手动改/.test(qqSection), "群列表不应再渲染冗长说明");
assert(/已离群/.test(qqSection) && /disabled=\{toggleBusyId === conv.id \|\| conv.leftAt !== null\}/.test(qqSection), "已离群群的历史可看，但收件开关必须禁用");
assert(/clearQQConversationHistory/.test(qqSection) && /确认清除/.test(qqSection), "已离群群应提供带二次确认的清除历史入口");
assert(/removeQQConversation/.test(qqSection) && /移除群聊/.test(qqSection) && /确认移除/.test(qqSection), "已离群群应提供带二次确认的移除群聊入口");
assert(/xiaomo:conversation-removed/.test(readFileSync("frontend/src/App.tsx", "utf8")), "移除当前群后应自动回到主私聊");

const testDb = "./data/conversation-regression.db";
for (const suffix of ["", "-wal", "-shm"]) {
  const file = testDb + suffix;
  if (existsSync(file)) rmSync(file, { force: true });
}
process.env.DB_PATH = testDb;

const { db, kvGet } = await import("../src/core/db.ts");
const { createContact, markConversationRead, unreadCount } = await import("../src/chat/contacts.ts");
const { clearQQGroupHistory, ensureConversation, ensureDefaultConversations, ensureLocalConversation, getConversation, removeQQGroupConversation, renameQQGroupConversation, setConversationEnabled, setConversationMembership } = await import("../src/chat/conversations.ts");
const { addMemoryEvent } = await import("../src/mind/memory.ts");

const contact = createContact({ name: "未读回归" });
const local = ensureLocalConversation(contact.id, contact.name);
const group = ensureConversation({
  contactId: contact.id,
  channel: "qq",
  kind: "group",
  externalId: "regression-group",
  accountId: "regression-account",
  title: "测试群",
});
const privateQq = ensureConversation({
  contactId: contact.id,
  channel: "qq",
  kind: "private",
  externalId: "regression-private",
  accountId: "regression-account",
  title: "QQ 私聊",
});
// 群名：平台名可自动补齐；手动命名后，后续平台事件只能更新后备名，不能覆盖用户选择。
const unnamed = ensureConversation({
  contactId: contact.id,
  channel: "qq",
  kind: "group",
  externalId: "regression-unnamed-group",
  accountId: "regression-account",
});
assert.equal(unnamed.title, "QQ 群", "没有 group_name 时应使用明确占位名");
const discovered = ensureConversation({
  contactId: contact.id,
  channel: "qq",
  kind: "group",
  externalId: "regression-unnamed-group",
  accountId: "regression-account",
  title: "平台读到的群名",
});
assert.equal(discovered.title, "平台读到的群名", "后续事件带回 group_name 时应自动补上群名");
assert.equal(discovered.title_source, "auto", "自动读取的群名应标记为 auto");
const custom = renameQQGroupConversation(discovered.id, contact.id, "  我的 群名  ");
assert.equal(custom?.title, "我的 群名", "自定义群名应清理首尾空白并保留中间空格");
assert.equal(custom?.title_source, "custom", "手动改过的群名应标记为 custom");
const afterPlatformRename = ensureConversation({
  contactId: contact.id,
  channel: "qq",
  kind: "group",
  externalId: "regression-unnamed-group",
  accountId: "regression-account",
  title: "平台后改的群名",
});
assert.equal(afterPlatformRename.title, "我的 群名", "后续平台事件不能覆盖自定义群名");
assert.equal(afterPlatformRename.auto_title, "平台后改的群名", "自定义期间仍应记住最新平台群名");
const restored = renameQQGroupConversation(discovered.id, contact.id, null);
assert.equal(restored?.title, "平台后改的群名", "恢复自动名称时应使用最近一次平台群名");
assert.equal(restored?.title_source, "auto", "恢复后应重新接受平台群名更新");

// 离群/解散：停用收件、保留会话；重新入群时恢复，但普通 ADD 事件不覆盖用户手动暂停。
const membershipGroup = ensureConversation({
  contactId: contact.id,
  channel: "qq",
  kind: "group",
  externalId: "regression-membership-group",
  accountId: "regression-account",
  title: "临别群",
});
const leftAt = Date.now();
const left = setConversationMembership(membershipGroup.id, false, leftAt);
assert.equal(left?.enabled, false, "机器人离群后必须停止收件");
assert.equal(left?.left_at, leftAt, "离群时间应落库，用于区分手动暂停");
const leftAgain = setConversationMembership(membershipGroup.id, false, leftAt + 5000);
assert.equal(leftAgain?.left_at, leftAt, "重复离群事件不应改写首次离群时间");
const rejoined = setConversationMembership(membershipGroup.id, true, leftAt + 10000);
assert.equal(rejoined?.enabled, true, "重新入群后应恢复收件");
assert.equal(rejoined?.left_at, null, "重新入群后应清除离群标记");
setConversationEnabled(membershipGroup.id, false);
const activeButPaused = setConversationMembership(membershipGroup.id, true, leftAt + 20000);
assert.equal(activeButPaused?.enabled, false, "普通的入群事件不能覆盖用户手动暂停");

assert.equal(renameQQGroupConversation(privateQq.id, contact.id, "不能改私聊"), null, "私聊不能被当作 QQ 群改名");
const otherContact = createContact({ name: "另一位联系人" });
const foreignGroup = ensureConversation({
  contactId: otherContact.id,
  channel: "qq",
  kind: "group",
  externalId: "regression-foreign-group",
  accountId: "regression-account",
  title: "别人的群",
});
assert.equal(renameQQGroupConversation(foreignGroup.id, contact.id, "越权改名"), null, "不能改其他联系人的群名");

const insert = db.prepare(
  "INSERT INTO messages (channel, role, text, created_at, contact_id, conversation_id) VALUES (?, ?, ?, ?, ?, ?)",
);
// 已离群群可手动清历史：会话壳与标题保留，消息/轮次/群记忆清空。
setConversationMembership(membershipGroup.id, false, leftAt + 30000);
insert.run("qq", "user", "不会被保留的群消息", Date.now() + 100, contact.id, membershipGroup.id);
insert.run("qq", "assistant", "不会被保留的群回复", Date.now() + 101, contact.id, membershipGroup.id);
db.prepare(`INSERT INTO turns (id, channel, text, status, created_at, contact_id, conversation_id)
  VALUES (?, 'qq', ?, 'done', ?, ?, ?)`)
  .run("clear-history-turn", "不会被保留的轮次", Date.now() + 102, contact.id, membershipGroup.id);
addMemoryEvent({ kind: "fact", content: "会被清除的群记忆", contactId: contact.id, scopeKind: "conversation", scopeConversationId: membershipGroup.id, sourceConversationId: membershipGroup.id });
addMemoryEvent({ kind: "fact", content: "提升后应保留的全局记忆", contactId: contact.id, scopeKind: "global", sourceConversationId: membershipGroup.id });
const clearedHistory = clearQQGroupHistory(membershipGroup.id, contact.id);
assert.deepEqual(clearedHistory, { messages: 2, turns: 1, memories: 1, media: 0 }, "清除历史应返回真实清理数量");
assert.equal(getConversation(membershipGroup.id)?.title, "临别群", "清除历史不能删除群会话或自定义信息");
assert.equal(getConversation(membershipGroup.id)?.left_at, leftAt + 30000, "清除历史不能改变离群状态");
assert.equal((db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?").get(membershipGroup.id)).c, 0, "清除后群消息应为空");
assert.equal((db.prepare("SELECT COUNT(*) AS c FROM turns WHERE conversation_id = ?").get(membershipGroup.id)).c, 0, "清除后群轮次应为空");
assert.equal((db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE scope_conversation_id = ?").get(membershipGroup.id)).c, 0, "清除后群级记忆应为空");
const promoted = db.prepare("SELECT source_conversation_id FROM memory_events WHERE content = '提升后应保留的全局记忆'").get();
assert.equal(promoted?.source_conversation_id, null, "全局记忆应保留，只清掉已清空会话的来源引用");
// 在收的群同样可清历史（清完继续收，防手滑由入口确认框负责）：返回真实清理数量，会话壳保留。
insert.run("qq", "user", "在收群的历史消息", Date.now() + 90, contact.id, group.id);
const clearedInGroup = clearQQGroupHistory(group.id, contact.id);
assert.deepEqual(clearedInGroup, { messages: 1, turns: 0, memories: 0, media: 0 }, "在收群清历史应返回真实清理数量");
assert.equal(getConversation(group.id)?.title, "测试群", "在收群清历史不能删除群会话");
assert.equal(getConversation(group.id)?.enabled, true, "在收群清完历史应继续收");
// 彻底移除仍要求先离群/关收件，防手滑。
assert.equal(removeQQGroupConversation(group.id, contact.id), null, "仍在群内的会话不能从列表移除");
const removal = removeQQGroupConversation(membershipGroup.id, contact.id);
assert.deepEqual(removal, { messages: 0, turns: 0, memories: 0, media: 0 }, "移除空历史群应返回零计数");
assert.equal(getConversation(membershipGroup.id), null, "移除后群会话必须从列表消失");



insert.run("web", "user", "本地用户", Date.now(), contact.id, local.id);
insert.run("web", "assistant", "本地回复 1", Date.now() + 1, contact.id, local.id);
insert.run("web", "assistant", "本地回复 2", Date.now() + 2, contact.id, local.id);
insert.run("qq", "user", "群里用户", Date.now() + 3, contact.id, group.id);
insert.run("qq", "assistant", "群里回复", Date.now() + 4, contact.id, group.id);
insert.run("qq", "user", "QQ 私聊用户", Date.now() + 5, contact.id, privateQq.id);
insert.run("qq", "assistant", "QQ 私聊回复", Date.now() + 6, contact.id, privateQq.id);

// 模拟旧版本数据库：已创建会话，但只有 0 号游标，尚未做过历史水位迁移。
assert.equal(kvGet("chat.conversation_reads.seeded"), null, "一次性迁移标记不应提前存在");

// 首次迁移前会把三段会话里的历史回复都视作未读；迁移后应一次性归零。
assert.equal(unreadCount(contact.id), 4, "迁移前应按会话水位回推出 4 条历史未读");
ensureDefaultConversations();
assert.equal(unreadCount(contact.id), 0, "升级迁移必须清掉历史红点，不能把旧回复全算成未读");
assert.equal(kvGet("chat.conversation_reads.seeded"), "1", "会话级已读迁移应留下一次性标记");
assert.equal(
  (db.prepare("SELECT COUNT(*) AS c FROM conversations WHERE kind = 'private' AND channel = 'qq'").get()).c,
  0,
  "个人 QQ 会话应合并进联系人主私聊",
);
assert.equal(
  (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND conversation_id = ? AND channel = 'qq'").get(contact.id, local.id)).c,
  2,
  "个人 QQ 历史消息应保留并迁移到主私聊",
);

// 迁移之后的新回复仍必须如实算未读，并只清当前群。
insert.run("qq", "user", "群里新问题", Date.now() + 7, contact.id, group.id);
const newReply = insert.run("qq", "assistant", "群里新回复", Date.now() + 8, contact.id, group.id);
assert.equal(unreadCount(contact.id), 1, "迁移后新回复应产生 1 条未读");
markConversationRead(group.id, Number(newReply.lastInsertRowid));
assert.equal(unreadCount(contact.id), 0, "读掉当前群后该会话红点应熄灭");

db.close();
for (const suffix of ["", "-wal", "-shm"]) {
  const file = testDb + suffix;
  if (existsSync(file)) rmSync(file, { force: true });
}

console.log("会话来源与未读红点回归测试：全部通过");
