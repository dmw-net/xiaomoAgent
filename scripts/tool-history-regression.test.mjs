/**
 * 工具往返历史回放的回归测试。
 *
 * 背景：从前历史里只有「正文 + 一句 [图片：这是你自己发出的图…] 占位符」，
 * 模型在上下文里从来没见过一次真正的 tool_call。2026-11-03 那次「让它发表情，
 * 它回了一段 [表情：…] 文字」就是照着历史抄的占位符——思考里明明打算调 send_emote。
 *
 * 覆盖：
 *   1. 不给工具回放时，行为与从前一字不差（气泡按 turn_id 合并）；
 *   2. 原生回放的顺序必须是 user → assistant(tool_calls) → tool → assistant(正文)，
 *      id 与 tool_call_id 对得上，气泡仍合并成一条；
 *   3. 老轮次折成一行备注，补在**合并后**的整段话末尾，且不产生任何 tool 消息；
 *   4. 回放窗口：只回放最近 N 轮（按所有轮算，不是按有工具的轮）；
 *   5. 字符预算：超预算时从最旧的一轮降级成备注，但最新一轮永远原生回放；
 *   6. 载荷被清理过的轮（result=null）拼不出合法往返，只能给备注；
 *   7. 落库与清理：结构化往返存得下、取得出、顺序对；超出存档窗口只丢载荷不丢名字；
 *      手动 purge 能立刻清空。
 *
 * 运行：node --experimental-sqlite scripts/tool-history-regression.test.mjs
 */
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/tool-history-regression.db";
process.env.MEDIA_DIR = "./data/tool-history-regression-media";
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/tool-history-regression.db${suffix}`, { force: true });
rmSync("data/tool-history-regression-media", { recursive: true, force: true });

const { q } = await import("../src/db.ts");
const { toChatMessages } = await import("../src/persona.ts");
const { insertMessage, recentMessages } = await import("../src/agent.ts");
const { DEFAULT_CONTACT_ID } = await import("../src/contacts.ts");
const {
  loadToolExchanges,
  planToolReplay,
  purgeToolHistory,
  trimToolStore,
  TOOL_STORE_TURNS,
} = await import("../src/tool-history.ts");

// ── 1) 不给工具回放：与从前完全一致 ────────────────────────────
const rows = [
  { role: "user", text: "发个表情来", turn_id: "t1" },
  { role: "assistant", text: "喏，发了。", turn_id: "t1" },
  { role: "assistant", text: "这张是趴在桌上摸鱼的本鲸。", turn_id: "t1" },
];
const plain = toChatMessages(rows);
assert.deepEqual(plain.map((m) => m.role), ["user", "assistant"], "同一轮的气泡必须合并成一条");
assert.equal(plain[1].content, "喏，发了。\n这张是趴在桌上摸鱼的本鲸。");
assert.equal(plain[1].tool_calls, undefined, "没有回放数据时不许凭空长出 tool_calls");

// ── 2) 原生回放：协议顺序与 id 对应 ────────────────────────────
const native = new Map([["t1", {
  native: [{ callId: "call_emote_1", name: "send_emote", args: '{"keyword":"得意"}', result: '{"ok":true,"sent":true}' }],
  note: null,
}]]);
const withTool = toChatMessages(rows, native);
assert.deepEqual(withTool.map((m) => m.role), ["user", "assistant", "tool", "assistant"],
  "顺序必须是 user → assistant(tool_calls) → tool → assistant(正文)");
assert.equal(withTool[1].content, "", "带 tool_calls 的那条不该混进正文");
assert.equal(withTool[1].tool_calls?.[0]?.id, "call_emote_1");
assert.equal(withTool[1].tool_calls?.[0]?.function.name, "send_emote");
assert.equal(withTool[1].tool_calls?.[0]?.function.arguments, '{"keyword":"得意"}');
assert.equal(withTool[2].tool_call_id, "call_emote_1", "tool 结果的 id 必须与调用 id 逐字一致");
assert.equal(withTool[2].content, '{"ok":true,"sent":true}');
assert.equal(withTool[3].content, "喏，发了。\n这张是趴在桌上摸鱼的本鲸。", "插了往返之后气泡照样合并");
assert.equal(withTool[3].tool_calls, undefined, "正文那条不许再挂 tool_calls");

// ── 3) 老轮次：只补一行备注，不产生 tool 消息 ───────────────────
const noted = toChatMessages(rows, new Map([["t1", { native: [], note: "[这一轮用过工具：send_emote；结果已省略]" }]]));
assert.deepEqual(noted.map((m) => m.role), ["user", "assistant"], "折叠的轮次不该插任何工具消息");
assert.equal(noted[1].content, "喏，发了。\n这张是趴在桌上摸鱼的本鲸。\n[这一轮用过工具：send_emote；结果已省略]",
  "备注要补在合并完的整段话末尾，不能夹在两句气泡中间");

// ── 4) 回放窗口按「所有轮」算 ──────────────────────────────────
const turnRows = [];
const exchanges = new Map();
for (const tid of ["t1", "t2", "t3", "t4", "t5"]) {
  turnRows.push({ role: "user", text: `问 ${tid}`, turn_id: tid });
  turnRows.push({ role: "assistant", text: `答 ${tid}`, turn_id: tid });
  exchanges.set(tid, [{ callId: `call_${tid}`, name: "send_emote", args: "{}", result: '"ok"' }]);
}
const windowed = planToolReplay(turnRows, exchanges, { nativeTurns: 2, maxChars: 1_000_000 });
assert.equal(windowed.get("t5")?.native.length, 1, "最新一轮原生回放");
assert.equal(windowed.get("t4")?.native.length, 1, "窗口内第二轮原生回放");
assert.equal(windowed.get("t3")?.native.length, 0, "窗口外的轮次折成备注");
assert.equal(windowed.get("t3")?.note, "[这一轮用过工具：send_emote；结果已省略]");
// 中间夹了几轮没有工具的闲天，也不能把老的工具调用算进窗口。
const sparse = [...turnRows.slice(0, 2), ...["t6", "t7", "t8"].flatMap((tid) => ([
  { role: "user", text: `闲话 ${tid}`, turn_id: tid },
  { role: "assistant", text: `回 ${tid}`, turn_id: tid },
]))];
const sparsePlan = planToolReplay(sparse, exchanges, { nativeTurns: 2, maxChars: 1_000_000 });
assert.equal(sparsePlan.get("t1")?.native.length, 0, "聊过几轮闲天之后，老的工具调用不该还挂在原生回放里");

// ── 5) 字符预算：从最旧的一轮降级，最新一轮永远原生 ──────────────
const tight = planToolReplay(turnRows, exchanges, { nativeTurns: 99, maxChars: 8 });
assert.equal(tight.get("t5")?.native.length, 1, "最新一轮即使超预算也要原生回放（否则这次改造白做）");
assert.equal(tight.get("t4")?.native.length, 0, "预算不够时从旧的一轮开始降级");

// ── 6) 载荷被清理过的轮：只能给备注 ────────────────────────────
const purged = new Map([["t1", [{ callId: "call_x", name: "web_search", args: "{}", result: null }]]]);
const purgedPlan = planToolReplay([{ role: "user", text: "查", turn_id: "t1" }, { role: "assistant", text: "查了", turn_id: "t1" }], purged, { nativeTurns: 9 });
assert.equal(purgedPlan.get("t1")?.native.length, 0, "缺结果的往返拼不合法，不许原生回放");
assert.ok((purgedPlan.get("t1")?.note ?? "").includes("web_search"), "但名字要留在备注里");

// ── 7) 落库 → 取回 → 清理 ─────────────────────────────────────
const CONV = `local-${DEFAULT_CONTACT_ID}`;
const insertTool = (turnId, callId, name, result) => insertMessage({
  channel: "web", role: "assistant", kind: "tool", text: JSON.stringify({ tool: name, ok: true, summary: "查了" }),
  turnId, contactId: DEFAULT_CONTACT_ID, conversationId: CONV,
  toolCallId: callId, toolName: name, toolArgs: '{"q":"鲸鱼"}', toolResult: result,
});
insertTool("turn-a", "call_a1", "send_emote", '{"ok":true}');
insertTool("turn-a", "call_a2", "web_search", '{"hits":[]}');
insertTool("turn-b", "call_b1", "get_current_time", '{"text":"23:40"}');
const loaded = loadToolExchanges(DEFAULT_CONTACT_ID, CONV, ["turn-a", "turn-b"]);
assert.deepEqual((loaded.get("turn-a") ?? []).map((c) => c.callId), ["call_a1", "call_a2"], "同一轮多个调用按调用顺序取回");
assert.equal(loaded.get("turn-b")?.[0]?.result, '{"text":"23:40"}', "结果原文要能取回");
assert.equal(loaded.get("turn-b")?.[0]?.name, "get_current_time");

// 存档窗口：造出 TOOL_STORE_TURNS + 1 轮，最旧那一轮的载荷该被清掉、名字留下。
for (let i = 0; i <= TOOL_STORE_TURNS; i += 1) insertTool(`bulk-${i}`, `call_bulk_${i}`, "web_fetch", '{"content":"很长"}');
trimToolStore(DEFAULT_CONTACT_ID);
const oldest = q(`SELECT tool_name, tool_args, tool_result FROM messages WHERE tool_call_id = 'call_a1'`).get();
assert.equal(oldest?.tool_result, null, "滚出存档窗口的载荷要清掉（库不该被几个月的网页正文撑爆）");
assert.equal(oldest?.tool_name, "send_emote", "名字必须留下：备注靠它");
const newestBulk = q(`SELECT tool_result FROM messages WHERE tool_call_id = 'call_bulk_${TOOL_STORE_TURNS}'`).get();
assert.equal(newestBulk?.tool_result, '{"content":"很长"}', "窗口内的载荷不动");

// 手动清理：立刻清空载荷与详情。
purgeToolHistory(DEFAULT_CONTACT_ID);
const left = q(`SELECT COUNT(*) AS c FROM messages WHERE kind = 'tool' AND (tool_args IS NOT NULL OR tool_result IS NOT NULL)`).get();
assert.equal(left?.c, 0, "purge 之后不该再有载荷");
const cardsKept = q(`SELECT COUNT(*) AS c FROM messages WHERE kind = 'tool'`).get();
assert.ok((cardsKept?.c ?? 0) > 0, "只清载荷，工具卡本身要留着");

// ── 8) 端到端形状：真实一轮（问 → 工具往返 → 正文）拼出来的历史 ──
// 这正是 2026-11-03 那次事故的现场：库里只有「喏，发了。」+ 一句占位符，
// 模型下一轮照着占位符写。现在这条历史里必须能看见真正的 send_emote 调用。
const turnId = "turn-e2e";
insertMessage({
  channel: "web", role: "user", text: "发个表情来", turnId,
  contactId: DEFAULT_CONTACT_ID, conversationId: CONV,
});
insertMessage({
  channel: "web", role: "assistant", kind: "tool", text: JSON.stringify({ tool: "send_emote", ok: true, summary: "发了「得意」" }),
  turnId, contactId: DEFAULT_CONTACT_ID, conversationId: CONV,
  toolCallId: "call_e2e", toolName: "send_emote", toolArgs: '{"keyword":"得意"}', toolResult: '{"ok":true,"sent":true}',
});
insertMessage({
  channel: "web", role: "assistant", text: "喏，发了。", turnId,
  contactId: DEFAULT_CONTACT_ID, conversationId: CONV,
});
const e2eRows = recentMessages(DEFAULT_CONTACT_ID, undefined, null, CONV).filter((row) => row.turn_id === turnId);
const e2eExchanges = loadToolExchanges(DEFAULT_CONTACT_ID, CONV, e2eRows.map((row) => row.turn_id));
const e2eHistory = toChatMessages(e2eRows, planToolReplay(e2eRows, e2eExchanges, { nativeTurns: 4 }));
assert.deepEqual(e2eHistory.map((m) => m.role), ["user", "assistant", "tool", "assistant"],
  "一轮里发过表情，历史里就必须有真正的 assistant.tool_calls + tool 结果");
assert.equal(e2eHistory[1].tool_calls?.[0]?.function.name, "send_emote");
assert.equal(e2eHistory[2].tool_call_id, "call_e2e");
assert.equal(e2eHistory[3].content, "喏，发了。");

console.log("[tool-history] 全部断言通过");
