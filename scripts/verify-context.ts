// 上下文与记忆层的回归测试：预算裁剪 / 超长 400 重丢 / 抽取改写 / 窗口边缘梗概 / 召回口径。
// 用法：npm run verify-context
//
// 为什么单独一个脚本而不是塞进 smoke.ts：smoke 全程 echo 模式（不需要网络与密钥），
// 而这里必须看见真发出去的请求体。用独立数据库（data/verify-context.db），不碰正式数据。

process.env.DB_PATH = "./data/verify-context.db";
// 图片目录隔开，理由同 smoke.ts：别把测试图混进真实数据目录。
process.env.MEDIA_DIR = "./data/media-verify";
process.env.MODEL_MODE = "openai";
process.env.MODEL_API_KEY = "test-key";
process.env.MODEL_BASE_URL = "http://fake.test/v1";
process.env.PROACTIVE_ENABLED = "false";
process.env.CONSOLIDATE_INTERVAL_DAYS = "7";

import { rmSync } from "node:fs";
for (const f of ["./data/verify-context.db", "./data/verify-context.db-wal", "./data/verify-context.db-shm"]) rmSync(f, { force: true });
rmSync("./data/media-verify", { recursive: true, force: true });

type Req = { messages: Array<{ role: string; content: unknown }> };
const sent: Req[] = [];
/** 当前用例决定的回复：body 就是模型「回复原文」——对话通道给人话，副通道给 JSON 字符串。delayMs 用来模拟慢模型，供打断用例。 */
let responder: (req: Req) => { status?: number; body?: string; delayMs?: number } = () => ({ body: "好呀" });
const json = (o: unknown): { body: string } => ({ body: typeof o === "string" ? o : JSON.stringify(o) });
const SIDE_CHANNEL = /记忆抽取器|整理一段长期陪伴|挤出对话窗口/;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const parsed = JSON.parse(String(init?.body ?? "{}")) as { messages?: Req["messages"] };
  const req: Req = { messages: parsed.messages ?? [] };
  sent.push(req);
  const r = responder(req);
  // 慢模型：延迟期间外部 signal 被打断 → 像真 fetch 一样抛 AbortError。
  if (r.delayMs && r.delayMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, r.delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });
  }
  if (r.status !== undefined && r.status >= 400) return new Response(r.body ?? "bad request", { status: r.status });
  return new Response(JSON.stringify({ choices: [{ message: { content: r.body ?? "好呀" } }] }), { status: 200 });
}) as typeof fetch;

const { updateModel, updatePersona } = await import("../src/settings.ts");
const { createContact, updateContact, getContact, companionPromptExtras } = await import("../src/contacts.ts");
const { createTurn, getTurn, insertMessage, contextUsage, recentMessages, respondToTurn, editAndRegenerate, retryTurn } = await import("../src/agent.ts");
const { listInflightCalls } = await import("../src/logs.ts");
const { addMemoryEvent, deleteMemoryEvent, extractFailures, extractMemories, keywords, listMemoryEventsFiltered, recall } = await import("../src/memory.ts");
const { maybeRefreshRecap } = await import("../src/recap.ts");
const { maybeRunConsolidation } = await import("../src/consolidate.ts");
const { buildSystemPrompt } = await import("../src/persona.ts");
const { db } = await import("../src/db.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const cid = createContact({ name: "回归验证" }).id;
const lastChat = (): Req => [...sent].reverse().find((r) => !SIDE_CHANNEL.test(String(r.messages[0]?.content ?? "")))!;
const maxId = (): number => Number((db.prepare("SELECT MAX(id) AS m FROM messages WHERE contact_id = ?").get(cid) as { m: number }).m);
let turnSeq = 0;
const runTurn = (text: string): Promise<string> => {
  const id = "verify-" + (turnSeq += 1);
  createTurn({ id, channel: "web", text, contactId: cid });
  return respondToTurn(getTurn(id)!, {});
};
const longTurns = (n: number, filler: string): void => {
  for (let i = 0; i < n; i += 1) {
    insertMessage({ channel: "web", role: "user", text: `第${i}轮 ${filler}`, contactId: cid });
    insertMessage({ channel: "web", role: "assistant", text: `第${i}轮 ${filler.slice(0, 40)}`, contactId: cid });
  }
};

console.log("\n[1] 窗口按轮回放：分条气泡不该把窗口悄悄缩小");
updateModel({ maxInputTokens: 0, maxOutputTokens: 0 });
updatePersona({ recentTurns: 20 });
longTurns(20, "这段对话有点长，需要多写一些字才能把场景和细节说清楚，好让上下文真的占地方。");
check("20 轮设置就真带 20 轮（一轮落多条也一样）", recentMessages(cid).filter((m) => m.role === "user").length === 20,
  `实际 ${recentMessages(cid).filter((m) => m.role === "user").length} 轮`);

console.log("\n[2] 预算裁剪：装不下就从最旧一轮丢，本轮与系统提示词永不丢");
responder = () => ({ body: "收到" });
const rowsBefore = recentMessages(cid).length;
await runTurn("这一轮是新的一问");
const baseline = lastChat().messages.length;
check("未填输入上限→按 32K 保守估算，且不裁剪", contextUsage(cid).limitIsFallback === true && baseline >= rowsBefore, `发 ${baseline} 条`);
updateModel({ maxInputTokens: 2000 });
const usage = contextUsage(cid);
check("小窗口：圆环报出被预算挡掉的轮数", (usage.droppedByBudget ?? 0) > 0 && usage.limit === 2000 && usage.limitIsFallback === false,
  `丢 ${usage.droppedByBudget} 轮 / 带 ${usage.turns} 轮`);
// 轮 ≠ 条：她一轮可以分好几条气泡，总量必须按 user 消息数算，不能按消息条数。
const liveUserRows = (db.prepare(
  `SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND superseded_at IS NULL AND kind != 'tool' AND role = 'user'`,
).get(cid) as { c: number }).c;
check("totalTurns 按轮算（= 活着的 user 消息数），且不小于带入轮数", usage.totalTurns === liveUserRows && usage.totalTurns >= (usage.turns ?? 0),
  `总 ${usage.totalTurns} 轮 / 带 ${usage.turns} 轮 / 库 ${liveUserRows}`);
await runTurn("这一轮是新的一问");
const trimmed = lastChat();
check("发送前真的裁了：请求比不裁时短", trimmed.messages.length < baseline, `发 ${trimmed.messages.length} 条 vs 基线 ${baseline}`);
check("系统提示词永远在第一位", trimmed.messages[0]?.role === "system");

// 她的一轮回复会按句子拆成多条气泡落库；进模型上下文必须合回一轮一条——
// 连续同角色消息既不像一次完整发言，也有服务商当协议错误拒掉。
responder = () => ({ body: "拆成三句试试。第二句在这里。第三句收尾。" });
await runTurn("这一轮会收到被拆开的回复");
responder = () => ({ body: "收到" });
await runTurn("下一轮检查历史形状");
const mergedReq = lastChat();
const roles = mergedReq.messages.map((m) => m.role);
check(
  "历史里不出现连续两条 assistant（拆分的气泡已合回一轮一条）",
  !roles.some((r, i) => i > 0 && r === "assistant" && roles[i - 1] === "assistant"),
  roles.join(","),
);
check(
  "合并后的 assistant 消息包含全部气泡内容",
  mergedReq.messages.some((m) => m.role === "assistant"
    && String(m.content).includes("拆成三句试试。") && String(m.content).includes("第三句收尾。")),
);
check("本轮问题没被裁掉", String(JSON.stringify(trimmed.messages[trimmed.messages.length - 1])).includes("这一轮是新的一问"));
check("裁掉的是整轮：首条历史是 user，不留孤儿回复", trimmed.messages[1]?.role === "user", `实际 ${String(trimmed.messages[1]?.role)}`);

console.log("\n[3] 真值兜底：服务商报超长 → 丢一轮重发");
updateModel({ maxInputTokens: 524_288 }); // 让预检放行，逼它去撞 400
let hits = 0;
responder = () => {
  hits += 1;
  return hits === 1
    ? { status: 400, body: '{"error":{"code":"context_length_exceeded","message":"This model has a maximum context length of 4096 tokens"}}' }
    : { body: "第二次成功了" };
};
const beforeRetry = sent.length;
const reply = await runTurn("再来一轮");
check("撞 400 后自动重发而不是直接失败", sent.length > beforeRetry && reply === "第二次成功了", `多发了 ${sent.length - beforeRetry} 次`);
check("重发那次确实少带了历史", sent[sent.length - 1].messages.length < sent[sent.length - 2].messages.length);

console.log("\n[4] 抽取查重：同一件事改写旧条目，不新增");
updateModel({ maxInputTokens: 0 });
const seedId = addMemoryEvent({ kind: "plan", content: "他在赶一个画展的方案", contactId: cid });
const countBefore = listMemoryEventsFiltered(cid, { limit: 500 }).length;
responder = () => json({ events: [{ op: "update", id: seedId, kind: "plan", content: "他在赶 2026-10 的画展布展方案", weight: 2 }], bond: null });
let extracted = await extractMemories({ turnId: "t-dedupe", userText: "画展方案还没弄完", assistantText: "别熬太晚", contactId: cid });
check("改写生效：条数一条都不增", extracted.added === 0 && extracted.updated === 1 && listMemoryEventsFiltered(cid, { limit: 500 }).length === countBefore, JSON.stringify(extracted));
check("旧条目内容被更新", String((db.prepare("SELECT content FROM memory_events WHERE id = ?").get(seedId) as { content: string }).content).includes("2026-10"));

responder = () => json({ events: [{ op: "update", id: 999999, content: "越权改写" }], bond: null });
extracted = await extractMemories({ turnId: "t-forged", userText: "画展方案", assistantText: "嗯", contactId: cid });
check("模型编出来的 id 改不动任何条目", extracted.updated === 0, JSON.stringify(extracted));

console.log("\n[5] 窗口边缘梗概：攒够一批才折叠，游标只前进");
updateContact(cid, { features: { recap: true } });
responder = () => json({ recap: "他这周一直在忙画展布展，两人约好周末去看新开的馆。" });
await maybeRefreshRecap(cid, 1);
check("窗口边界之前没东西时什么都不写", getContact(cid)!.recap === "" && getContact(cid)!.recap_upto === 0);
await maybeRefreshRecap(cid, maxId() - 2);
check("折叠后写入梗概并推进游标", getContact(cid)!.recap.includes("画展") && getContact(cid)!.recap_upto > 0, `upto=${getContact(cid)!.recap_upto}`);
const cursor = getContact(cid)!.recap_upto;
await maybeRefreshRecap(cid, 2);
check("窗口边界退回不会重复折叠（游标只向前）", getContact(cid)!.recap_upto === cursor);
check("梗概注入系统提示词的 [上次说到] 段", buildSystemPrompt([], { companion: { recap: "他这周一直在忙画展布展" } }).includes("[上次说到]"));
updateContact(cid, { features: { recap: false } });
check("开关关掉后整段不出现（不留空壳）", companionPromptExtras(getContact(cid)!).recap === "");

console.log("\n[6] 整理触发：新增堆积可以不等满一周");
updateContact(cid, { features: { consolidate: true, lastConsolidatedAt: Date.now() } });
for (let i = 0; i < 22; i += 1) addMemoryEvent({ kind: "fact", content: `堆积条目 ${i}`, contactId: cid });
let consolidateSeen = false;
responder = (req) => {
  if (String(req.messages[0]?.content ?? "").includes("整理一段长期陪伴")) {
    consolidateSeen = true;
    return json({ merges: [], expire: [], lifeline: "", bond: null });
  }
  return json({ events: [], bond: null });
};
maybeRunConsolidation();
await new Promise((r) => setTimeout(r, 400));
check("距上次整理才几小时，但堆积够 → 照样整理", consolidateSeen);
check("失败退避不再伪造「上次整理时间」", (getContact(cid)!.features.lastConsolidatedAt ?? 0) <= Date.now());

console.log("\n[7] 召回口径：只有她的回忆行为写 last_used_at");
const probe = addMemoryEvent({ kind: "promise", content: "答应周末一起去新开的馆", contactId: cid });
const usedAt = (): number | null => (db.prepare("SELECT last_used_at FROM memory_events WHERE id = ?").get(probe) as { last_used_at: number | null }).last_used_at;
contextUsage(cid);
check("刷上下文占用圆环不算被想起", usedAt() === null);
recall(cid, "周末 新开的馆");
check("真实对话召回算被想起", usedAt() !== null);
const { executeTool } = await import("../src/tools.ts");
const probe2 = addMemoryEvent({ kind: "fact", content: "她喜欢看展，尤其是画展", contactId: cid });
// ⚠️ executeTool 是 async：少了 await 这个 promise 就悬空，
// 断言只是因为 recallExplained 的 markUsed 在第一个微任务段同步跑完才碰巧过的。
// scripts/ 不在 tsconfig 的 include 里，这类漏写只有跑一遍才看得见（development.md §六·五.4）。
await executeTool("search_memory", JSON.stringify({ query: "画展" }), { contactId: cid, lastUserAt: null });
check("她主动 search_memory 也算被想起", (db.prepare("SELECT last_used_at FROM memory_events WHERE id = ?").get(probe2) as { last_used_at: number | null }).last_used_at !== null);

console.log("\n[8] 打断（barge-in）：同一联系人新消息 = 旧轮取消，不并发");
responder = () => ({ body: "慢慢回的第一句。", delayMs: 1200 });
const barge1 = "barge-" + Date.now();
createTurn({ id: barge1, channel: "web", text: "第一句，你会回得很慢", contactId: cid });
const p1 = respondToTurn(getTurn(barge1)!, {});
await new Promise((r) => setTimeout(r, 250)); // 确保旧轮已经进了模型请求
check("旧轮在飞", getTurn(barge1)!.status === "running", getTurn(barge1)!.status);
responder = () => ({ body: "第二句秒回。" });
const barge2 = "barge2-" + Date.now();
createTurn({ id: barge2, channel: "web", text: "第二句，打断你", contactId: cid });
await respondToTurn(getTurn(barge2)!, {});
await p1;
const t1 = getTurn(barge1)!;
const t2 = getTurn(barge2)!;
check("旧轮被标 cancelled 而不是 failed", t1.status === "cancelled", `${t1.status} / ${t1.error ?? ""}`);
const oldBubbles = (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE turn_id = ? AND role = 'assistant'").get(barge1) as { c: number }).c;
check("被打断的旧轮不插任何气泡（非流式，没有半截文本）", oldBubbles === 0, `bubbles=${oldBubbles}`);
check("新轮正常完成", t2.status === "done", t2.status);
const ctxAfter = recentMessages(cid, 50).map((r) => r.text).join("\n");
check("旧轮的慢回复没进上下文", !ctxAfter.includes("慢慢回的第一句"));
check("新轮的回复进了上下文", ctxAfter.includes("第二句秒回。"));
responder = () => ({ body: "好呀" });

console.log("\n[9] 编辑正在生成的那一轮：拒绝，而不是让同一轮跑两遍");
responder = () => ({ body: "这一句要慢慢想。", delayMs: 1200 });
const editTid = "edit-" + Date.now();
createTurn({ id: editTid, channel: "web", text: "先说一句", contactId: cid });
const pEdit = respondToTurn(getTurn(editTid)!, {});
await new Promise((r) => setTimeout(r, 250));
const editMsg = db.prepare("SELECT id FROM messages WHERE turn_id = ? AND role = 'user'").get(editTid) as { id: number };
let refused = "";
try {
  editAndRegenerate({ messageId: editMsg.id, text: "改成这样说" });
} catch (error) {
  refused = error instanceof Error ? error.message : String(error);
}
check("还在生成时编辑被拒（否则同一轮两个执行体并发写回复）", refused.includes("还在生成"), refused);
await pEdit;
check("被拒之后这一轮照常跑完", getTurn(editTid)!.status === "done", getTurn(editTid)!.status);

// 万一还有别的路径让同一个 turnId 重入（重试、导入脚本），也只能有一个活着：
// 单飞登记按 controller 身份比，收尾只注销自己那一份。
responder = () => ({ body: "重入的第一份。", delayMs: 1200 });
const reTid = "reenter-" + Date.now();
createTurn({ id: reTid, channel: "web", text: "重入测试", contactId: cid });
const pReA = respondToTurn(getTurn(reTid)!, {});
await new Promise((r) => setTimeout(r, 250));
responder = () => ({ body: "重入的第二份。" });
const pReB = respondToTurn(getTurn(reTid)!, { isRetry: true });
await Promise.all([pReA.catch(() => { }), pReB]);
const reBubbles = (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE turn_id = ? AND role = 'assistant'").get(reTid) as { c: number }).c;
check("同一轮重入最多只留一份回复（旧执行体被打断）", reBubbles <= 1, `bubbles=${reBubbles}`);

// 登记项没被上一轮的收尾误删：这个联系人之后照样能被打断
responder = () => ({ body: "再来一句慢的。", delayMs: 1200 });
const post1 = "post1-" + Date.now();
createTurn({ id: post1, channel: "web", text: "慢的一句", contactId: cid });
const pPost = respondToTurn(getTurn(post1)!, {});
await new Promise((r) => setTimeout(r, 250));
responder = () => ({ body: "打断成功。" });
const post2 = "post2-" + Date.now();
createTurn({ id: post2, channel: "web", text: "打断它", contactId: cid });
await respondToTurn(getTurn(post2)!, {});
await pPost;
check("重入过一轮之后打断依然有效", getTurn(post1)!.status === "cancelled", getTurn(post1)!.status);
responder = () => ({ body: "好呀" });

console.log("\n[10] 在飞的调用要有登记（否则「调用记录」看不出正在回复）");
responder = () => ({ body: "这句要想一会儿。", delayMs: 800 });
const liveTid = "inflight-" + Date.now();
createTurn({ id: liveTid, channel: "web", text: "在飞登记测试", contactId: cid });
const pLive = respondToTurn(getTurn(liveTid)!, {});
await new Promise((r) => setTimeout(r, 200));
// 只看对话通道：回复落库后还会异步跑一次记忆抽取，那是另一条登记，不该干扰这里的判断。
const chatLive = (): ReturnType<typeof listInflightCalls> => listInflightCalls().filter((c) => c.purpose === "chat");
check("调用期间登记在飞（带用途与处理单）",
  chatLive().length === 1 && chatLive()[0]!.turnId === liveTid,
  JSON.stringify(chatLive().map((c) => ({ purpose: c.purpose, turnId: c.turnId, model: c.model }))));
check("登记里看得见它在回哪句话", chatLive()[0]?.turnText === "在飞登记测试", String(chatLive()[0]?.turnText));
check("登记带已耗时（界面显示「进行中 · N 秒」靠它）", (chatLive()[0]?.elapsedMs ?? 0) >= 150, `${chatLive()[0]?.elapsedMs}ms`);
await pLive;
check("调用结束后登记清掉", chatLive().length === 0, JSON.stringify(chatLive()));
responder = () => ({ body: "好呀" });

console.log("\n[11] 编辑早先一句之后，刚重生成的那一轮就是「最新的有效轮」");
const waitTurn = async (id: string): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    const status = getTurn(id)?.status;
    if (status === "done" || status === "failed" || status === "cancelled") return;
    await new Promise((r) => setTimeout(r, 20));
  }
};
const regenA = "regen-a-" + Date.now();
createTurn({ id: regenA, channel: "web", text: "早先一句", contactId: cid });
await respondToTurn(getTurn(regenA)!, {});
const regenB = "regen-b-" + Date.now();
createTurn({ id: regenB, channel: "web", text: "后面一句", contactId: cid });
await respondToTurn(getTurn(regenB)!, {});
const regenAMsg = db.prepare("SELECT id FROM messages WHERE turn_id = ? AND role = 'user'").get(regenA) as { id: number };
editAndRegenerate({ messageId: regenAMsg.id, text: "早先一句（改过）" });
await waitTurn(regenA);
check("编辑把后面那一轮整批作废", getTurn(regenB)!.superseded_at !== null);
// 此前的口径按 rowid 取最新一轮、不看 superseded_at：作废的那轮 rowid 仍然最大，
// 于是刚重生成的这轮被判成「不是最新」，再点重新生成就被拒（用户报的就是这个）。
let regenErr = "";
try {
  await retryTurn(regenA, { regenerate: true });
  await waitTurn(regenA);
} catch (error) {
  regenErr = error instanceof Error ? error.message : String(error);
}
check("刚重生成的那一轮还能再重新生成", regenErr === "" && getTurn(regenA)!.status === "done", regenErr || getTurn(regenA)!.status);
db.prepare(`UPDATE turns SET superseded_at = NULL WHERE id = ?`).run(regenB);
let guardErr = "";
try {
  await retryTurn(regenA, { regenerate: true });
} catch (error) {
  guardErr = error instanceof Error ? error.message : String(error);
}
// 这一条原来断的是「只许重答最新一轮」，而 src/agent.ts 已改成任何一轮都能重答
// （区别只在写回原气泡还是分条重插），断言留着就是假红灯。
check("后面还有有效轮次时也能重答（按现行口径：区别只在写回位置）", guardErr === "", guardErr);

console.log("\n[12] 召回精度：整句都参与筛选，不再只看前半句");
// 这一组全部对着真实语料的形状写：主题词在句子后半段时旧实现（slice(0,12)）一条都捞不到。
const kidneyId = addMemoryEvent({ kind: "fact", content: "他肾透支过不能太累", contactId: cid });
const longAsk = "射一次两次问题不大，但是榨干的话，我也会肾透支、身体亏空呀？";
check("长句的关键词覆盖到句子后半段", keywords(longAsk).length > 12, `切出 ${keywords(longAsk).length} 个`);
check("通用二字词被剔掉", !keywords("这个周末我们到底干什么啊").includes("什么"));
check("主题词在后半句也能召回", recall(cid, longAsk).some((e) => e.id === kidneyId));

// 追问短句：自己这句没词，就借上一句自己说的话
const followId = addMemoryEvent({ kind: "plan", content: "答应周三陪她去西湖吃藕粉", contactId: cid });
insertMessage({ channel: "web", role: "user", text: "周三去西湖吃藕粉好不好", contactId: cid });
insertMessage({ channel: "web", role: "assistant", text: "好呀，我下班就过去。", contactId: cid });
check("追问句靠上一句自己的话扩展查询", recall(cid, "那个事呢？").some((e) => e.id === followId));

console.log("\n[13] 注入位子：复读不占两遍，同类不霸满，约定有保底");
for (const text of ["今天情绪很低落", "今天情绪很低落啦", "今天情绪很低落呀"]) {
  addMemoryEvent({ kind: "mood", content: text, contactId: cid });
}
const moodHits = recall(cid, "今天情绪很低落", 6);
check("只差一个语气词的复读只占一个位子",
  moodHits.filter((e) => e.kind === "mood").length === 1, moodHits.map((e) => e.content).join(" | "));

// 保底：先记那条约定，再记 6 条更新的事实/偏好。全部同分时它排在最末，
// 6 个位子被事实与偏好（各限 3 条）占满 → 承诺的保底位子必须把它捞回来。
const promiseId = addMemoryEvent({ kind: "promise", content: "答应带她去吃火锅", contactId: cid });
for (const text of ["他偏好牛油火锅", "他喜欢安静的就餐环境", "他挑火锅店只看环境"]) {
  addMemoryEvent({ kind: "preference", content: text, contactId: cid });
}
for (const text of ["他爱吃毛肚火锅", "火锅底料他自己炒", "汤锅他要清汤的"]) {
  addMemoryEvent({ kind: "fact", content: text, contactId: cid });
}
const guardedHits = recall(cid, "火锅 底料 环境 汤锅", 6);
check("同类最多占 3 个位子", guardedHits.filter((e) => e.kind === "fact").length <= 3 && guardedHits.length === 6,
  guardedHits.map((e) => `${e.kind}:${e.content}`).join(" | "));
check("承诺/计划至少留一个位子", guardedHits.some((e) => e.id === promiseId));

console.log("\n[14] 写入侧机械闸：重复与「他删过的事」");
const beforeGate = listMemoryEventsFiltered(cid, { limit: 500 }).length;
addMemoryEvent({ kind: "preference", content: "他喜欢美式不加糖", contactId: cid });
responder = () => json({ events: [{ kind: "preference", subject: "他", content: "他喜欢美式不加糖", weight: 2 }], bond: null });
const dupRun = await extractMemories({ turnId: "t-dup", userText: "美式还是要不加糖", assistantText: "记下了", contactId: cid });
check("同一件事由代码挡下：一条都不增", dupRun.added === 0 && dupRun.suppressed === 1
  && listMemoryEventsFiltered(cid, { limit: 500 }).length === beforeGate + 1, JSON.stringify(dupRun));

const doomed = addMemoryEvent({ kind: "fact", content: "他讨厌被催着做决定", contactId: cid });
deleteMemoryEvent(doomed, cid);
responder = () => json({ events: [{ kind: "fact", subject: "他", content: "他讨厌被催做决定", weight: 2 }], bond: null });
const resRun = await extractMemories({ turnId: "t-res", userText: "别催我", assistantText: "好", contactId: cid });
check("他删掉的事不再被自动重新记下（P0-2 的验收项）",
  resRun.added === 0 && resRun.blocked === 1 && listMemoryEventsFiltered(cid, { limit: 500 }).length === beforeGate + 1,
  JSON.stringify(resRun));

console.log("\n[15] 抽取失败计数：按联系人各记一份，通道恢复就清零");
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));
const failuresBefore = extractFailures(cid);
// 只让副通道（抽取）坏掉、主通道照常——这样测的是"通道坏了要看得见"，不是整轮对话失败。
responder = (req) => (SIDE_CHANNEL.test(String(req.messages[0]?.content ?? ""))
  ? { body: "这轮我不想记东西" }
  : { body: "好呀" });
await runTurn("今晚吃点啥呢");
await settle();
check("抽取失败按联系人计数", extractFailures(cid) === failuresBefore + 1, `第 ${extractFailures(cid)} 次`);
responder = () => json({ events: [], bond: null });
await runTurn("那就这么定");
await settle();
check("通道恢复即清零：空返回（本轮不值得记）也算通道健康", extractFailures(cid) === failuresBefore);

console.log("\n[16] 梗概重叠守卫：已原文回放的那段不再重复注入");
updateContact(cid, { features: { recap: true }, recap: "上次说到：两人约好周三去西湖" });
const anchor = maxId();
db.prepare(`UPDATE contacts SET recap_upto = ? WHERE id = ?`).run(anchor, cid);
check("梗概覆盖的消息已在窗口内 → 不注入（同一段话喂两遍）",
  companionPromptExtras(getContact(cid)!, anchor).recap === ""
  && companionPromptExtras(getContact(cid)!, anchor - 3).recap === "");
check("梗概覆盖的那段确实在窗口之外 → 照常注入",
  companionPromptExtras(getContact(cid)!, anchor + 3).recap.includes("西湖"));
check("省略窗口边界时不做这项判断（手写梗概照旧可见）",
  companionPromptExtras(getContact(cid)!).recap.includes("西湖"));
updateContact(cid, { features: { recap: false } });
check("开关关掉后整段不出现（不留空壳）", companionPromptExtras(getContact(cid)!, anchor + 9).recap === "");

console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
