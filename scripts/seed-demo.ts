// 演示数据脚本：给一个空库塞一段"像真的聊过几天"的内容。
//
// 为什么要它：界面打磨阶段必须拿真实形状的数据看效果，
// 空库下的页面永远"看起来还行"，因为有数据时才会暴露排版问题。
//
// 用法：
//   node --experimental-sqlite scripts/seed-demo.ts            # 写入演示数据
//   node --experimental-sqlite scripts/seed-demo.ts --reset    # 先清空再写入
//
// 注意：它写的是 DB_PATH 指向的库（默认 ./data/xiaomo.db），会动到真实数据，所以只在本地用。

process.env.DB_PATH = process.env.DB_PATH ?? "./data/xiaomo.db";

const reset = process.argv.includes("--reset");

const { db } = await import("../src/db.ts");
const { addMemoryEvent } = await import("../src/memory.ts");
const { insertMessage } = await import("../src/agent.ts");

// 记忆与消息都按联系人隔离（每条都带 contact_id），所以先把默认联系人准备好——
// 空库上直接写 messages / memory_events 会因为没有归属人而绑参失败。
const { DEFAULT_CONTACT_ID, ensureDefaultContact } = await import("../src/contacts.ts");

if (reset) {
  db.exec("DELETE FROM messages; DELETE FROM memory_events; DELETE FROM turns; DELETE FROM kv;");
  console.log("[seed] 已清空 messages / memory_events / turns / kv");
}

// 空库时先把默认联系人建出来（表里已经有联系人就不动它）。
ensureDefaultContact();
const contactId = DEFAULT_CONTACT_ID;

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 一段跨三天的对话。时间戳从"三天前"线性推进，好让界面的时间分隔真的被触发。 */
const SCRIPT: Array<{ at: number; role: "user" | "assistant"; kind?: "chat" | "proactive"; text: string }> = [
  { at: now - 3 * DAY - 2 * HOUR, role: "user", text: "今天开会被怼了一顿，有点郁闷" },
  { at: now - 3 * DAY - 2 * HOUR + 9000, role: "assistant", text: "是那个每周一的例会吗？上次你也说在会上被问得很难受。" },
  { at: now - 3 * DAY - 2 * HOUR + 40000, role: "user", text: "对，就是那个。我方案里少写了一块，被组长当着所有人问住了" },
  { at: now - 3 * DAY - 2 * HOUR + 55000, role: "assistant", text: "被当众问住确实难受。不过少写一块和想错一块是两回事，前者下次补上就好了。" },
  { at: now - 3 * DAY - 2 * HOUR + 90000, role: "user", text: "也是。我晚上把方案补完再发他一次" },
  { at: now - 3 * DAY - 2 * HOUR + 110000, role: "assistant", text: "行。别熬太晚，你上次说熬到两点第二天头疼了一整天。" },

  { at: now - 2 * DAY - 5 * HOUR, role: "assistant", kind: "proactive", text: "昨天那个方案补完了吗？没别的事，就是想起来问一句。" },
  { at: now - 2 * DAY - 4 * HOUR, role: "user", text: "补完了，他说可以了。谢啦" },
  { at: now - 2 * DAY - 4 * HOUR + 8000, role: "assistant", text: "那就好。" },

  { at: now - 1 * DAY - 6 * HOUR, role: "user", text: "周末想去看电影，但不知道看什么" },
  { at: now - 1 * DAY - 6 * HOUR + 7000, role: "assistant", text: "你之前说不太喜欢悬疑片，说看完晚上睡不着。要避开这类吗？" },
  { at: now - 1 * DAY - 6 * HOUR + 25000, role: "user", text: "对，避开。喜剧或者动画都行" },
  { at: now - 1 * DAY - 6 * HOUR + 38000, role: "assistant", text: "那周末挑个喜剧吧。看完顺路去吃点什么？你上次说想吃那家湘菜但一直没去。" },
  { at: now - 1 * DAY - 6 * HOUR + 52000, role: "user", text: "哈哈哈你还记得这个。行，就这么定" },
  { at: now - 1 * DAY - 6 * HOUR + 66000, role: "assistant", text: "记着的。那就说好了，周日。" },

  { at: now - 3 * HOUR, role: "user", text: "今天又加班到八点，还没吃饭" },
  { at: now - 3 * HOUR + 6000, role: "assistant", text: "又加班？这周第三次了。先去吃点东西吧，别硬撑。" },
  { at: now - 3 * HOUR + 20000, role: "user", text: "公司楼下随便吃点算了" },
  { at: now - 3 * HOUR + 30000, role: "assistant", text: "别随便啊，你胃不好这件事自己说过不止一次了。楼下那家粉店还开着的话去吃碗热的。" },
];

const MEMORIES: Array<{ at: number; kind: "promise" | "preference" | "fact" | "plan" | "mood"; subject: string; content: string; weight: number }> = [
  { at: now - 3 * DAY, kind: "mood", subject: "他", content: "周一例会上被组长当众问住，很郁闷", weight: 2 },
  { at: now - 3 * DAY, kind: "fact", subject: "他", content: "每周一有例会，会上要被问方案", weight: 2 },
  { at: now - 3 * DAY, kind: "preference", subject: "他", content: "熬夜到两点后会头疼一整天", weight: 2 },
  { at: now - 2 * DAY, kind: "plan", subject: "他", content: "要把方案补完再发给组长", weight: 1 },
  { at: now - 1 * DAY, kind: "preference", subject: "他", content: "不喜欢悬疑片，看完会睡不着", weight: 3 },
  { at: now - 1 * DAY, kind: "preference", subject: "他", content: "看电影偏好喜剧和动画", weight: 2 },
  { at: now - 1 * DAY, kind: "promise", subject: "我们", content: "约好周日一起去看电影", weight: 3 },
  { at: now - 1 * DAY, kind: "fact", subject: "他", content: "一直想去那家湘菜馆，还没去成", weight: 2 },
  { at: now - 12 * HOUR, kind: "fact", subject: "他", content: "胃不太好", weight: 3 },
  { at: now - 3 * HOUR, kind: "fact", subject: "他", content: "这周已经第三次加班到八点后", weight: 2 },
  { at: now - 3 * HOUR, kind: "preference", subject: "他", content: "公司楼下有家粉店", weight: 1 },
];

let memCount = 0;
for (const item of MEMORIES) {
  const id = addMemoryEvent({ kind: item.kind, content: item.content, subject: item.subject, weight: item.weight, contactId });
  db.prepare("UPDATE memory_events SET created_at = ?, last_used_at = ? WHERE id = ?").run(
    item.at,
    // 一部分标记为"最近被想起过"，好让记忆页的"近 7 天被想起过"不是 0
    memCount % 3 === 0 ? now - 2 * HOUR : null,
    id,
  );
  memCount += 1;
}

for (const item of SCRIPT) {
  const row = insertMessage({
    channel: "web",
    role: item.role,
    text: item.text,
    kind: item.kind ?? "chat",
    contactId,
  });
  db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(item.at, row);
}

console.log(`[seed] 写入 ${MEMORIES.length} 条关系事件、${SCRIPT.length} 条消息`);

// 补一批处理单与调用记录：状态页的两张表在空数据下看不出任何排版问题，
// 而有数据时才会暴露列宽、截断、失败行的可读性。
const CALL_ROWS: Array<{ purpose: string; ok: boolean; code: string | null; ms: number; msg: string; at: number }> = [
  { purpose: "chat", ok: true, code: null, ms: 843, msg: "126 字", at: now - 3 * HOUR + 6000 },
  { purpose: "extract", ok: true, code: null, ms: 512, msg: "写入 2 条关系事件", at: now - 3 * HOUR + 8000 },
  { purpose: "chat", ok: true, code: null, ms: 691, msg: "88 字", at: now - 3 * HOUR + 30000 },
  { purpose: "extract", ok: true, code: null, ms: 478, msg: "写入 1 条关系事件", at: now - 3 * HOUR + 32000 },
  { purpose: "proactive", ok: false, code: "TIMEOUT", ms: 90000, msg: "请求超时（90000ms，上限 90000ms）", at: now - 5 * HOUR },
  { purpose: "chat", ok: true, code: null, ms: 764, msg: "104 字", at: now - 1 * DAY - 6 * HOUR + 7000 },
  { purpose: "extract", ok: true, code: null, ms: 601, msg: "写入 3 条关系事件", at: now - 1 * DAY - 6 * HOUR + 9000 },
  { purpose: "chat", ok: true, code: null, ms: 802, msg: "112 字", at: now - 1 * DAY - 6 * HOUR + 66000 },
  { purpose: "proactive", ok: true, code: null, ms: 934, msg: "决定不打扰", at: now - 28 * HOUR },
];

db.exec("DELETE FROM model_calls");
for (const row of CALL_ROWS) {
  db.prepare(
    `INSERT INTO model_calls (turn_id, purpose, ok, code, status, model, url, elapsed_ms, message, detail, created_at)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    row.purpose,
    row.ok ? 1 : 0,
    row.code,
    row.ok ? 200 : null,
    "agnes-2.5-flash",
    "https://api.agnes-ai.cn/v1/chat/completions",
    row.ms,
    row.msg,
    row.at,
  );
}

// 处理单：覆盖 done / failed / running 三种状态，好让状态页的失败行样式被看到
const TURN_ROWS: Array<{ text: string; status: string; reply: string | null; error: string | null; at: number; ms: number | null }> = [
  { text: "周末想去看电影，但不知道看什么", status: "done", reply: "你之前说不太喜欢悬疑片，说看完晚上睡不着。要避开这类吗？", error: null, at: now - 1 * DAY - 6 * HOUR, ms: 764 },
  { text: "今天又加班到八点，还没吃饭", status: "done", reply: "又加班？这周第三次了。先去吃点东西吧，别硬撑。", error: null, at: now - 3 * HOUR, ms: 843 },
  { text: "公司楼下随便吃点算了", status: "done", reply: "别随便啊，你胃不好这件事自己说过不止一次了。", error: null, at: now - 3 * HOUR + 22000, ms: 691 },
  { text: "在吗", status: "failed", reply: null, error: "请求超时（等了 90 秒）。最常见的原因是模型名「agnes-3.0-flash」在该服务商没有可用渠道——有的服务商会让请求一直挂着而不报错。请先运行 npm run doctor 查看可用模型。（可点重试，或调 POST /api/turn/xxx/retry）", at: now - 5 * HOUR, ms: 90000 },
];

db.exec("DELETE FROM turns");
for (const row of TURN_ROWS) {
  db.prepare(
    `INSERT INTO turns (id, channel, text, status, reply, error, created_at, finished_at)
     VALUES (?, 'web', ?, ?, ?, ?, ?, ?)`,
  ).run(
    `seed-${row.at}`,
    row.text,
    row.status,
    row.reply,
    row.error,
    row.at,
    row.ms === null ? null : row.at + row.ms,
  );
}

console.log(`[seed] 写入 ${TURN_ROWS.length} 条处理单、${CALL_ROWS.length} 条调用记录`);
console.log("[seed] 打开 http://localhost:8787 查看效果");
