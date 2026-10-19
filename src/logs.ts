// 调用日志：每次模型请求（成功或失败）都落一条，可查、可统计。
//
// 为什么单独建表而不是只打 console.log：
// 一次对话里可能有多次模型调用（回复、记忆抽取、主动性判断），
// 出了问题时用户只会说"它不回我了"。有了这张表，`/api/logs` 和 `/healthz`
// 就能直接回答"上一次失败在哪一步、什么原因、耗时多久"。
// 这就是"失败必须可见"的落地方式。

import { config } from "./config.ts";
import { db, ensureColumn, kvGet, kvSet } from "./db.ts";

export type ModelCallRow = {
  id: number;
  turn_id: string | null;
  purpose: string;
  ok: number;
  code: string | null;
  status: number | null;
  model: string | null;
  url: string | null;
  elapsed_ms: number;
  message: string | null;
  detail: string | null;
  /** 发给模型的完整请求体 JSON。仅 DEV_MODE 下落盘，且只在最近 FULL_TEXT_WINDOW 条内可见。 */
  req_full: string | null;
  /** 模型返回的完整响应正文（失败时为原始错误报文）。只在最近 FULL_TEXT_WINDOW 条内保留。 */
  res_full: string | null;
  created_at: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  contact_id: string | null;
  profile_id: string | null;
};

db.exec(`
CREATE TABLE IF NOT EXISTS model_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id    TEXT,
  purpose    TEXT NOT NULL DEFAULT 'chat',
  ok         INTEGER NOT NULL,
  code       TEXT,
  status     INTEGER,
  model      TEXT,
  url        TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  message    TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls (created_at);
-- 「累计失败 N 次」只数 ok=0 的行。没有这个部分索引就是全表扫：1924 行 3.4ms，
-- 涨到保留上限 2 万行时每开一次状态页要白扫 35ms。
CREATE INDEX IF NOT EXISTS idx_model_calls_failed ON model_calls (id) WHERE ok = 0;
`);

/** 原文全文的环形窗口：只有最近这么多条调用留着请求/响应全文，更早的自动剥掉。 */
const FULL_TEXT_WINDOW = 10;
/**
 * 单条全文的字节上限。
 *
 * ⚠️ 从前只给 `detail` 切了 2000 字，`res_full` / `res_raw` 原样落库：一个回 2MB HTML
 * 502 页的网关就是 2MB 一行，几次就把库撑到没法备份——正是这个文件为 `req_full`
 * 记下过的那个事故（"原样落盘等于每条日志几 MB"），只是当年只修了请求那一侧。
 */
const FULL_TEXT_MAX_CHARS = 200_000;

/** 超长的全文截断并标注：排障要看的是"回了什么"，不是把整个页面搬进库。 */
function capFullText(text: string): string {
  return text.length <= FULL_TEXT_MAX_CHARS
    ? text
    : text.slice(0, FULL_TEXT_MAX_CHARS) + `\n…（原文 ${text.length} 字，已截断，仅留前 ${FULL_TEXT_MAX_CHARS} 字）`;
}

/**
 * 通道投递类用途。它们和模型调用记在同一张表里（当初没有独立的通道日志表，
 * 图省事就共用了 logModelCall），但打的根本不是模型：
 *   qq     —— QQ 机器人接口：取 accessToken、发消息、绑定，一条投递能记两三行
 *   wechat —— 微信出站投递
 * 凡是口径写着「模型调用」的地方（调用记录、用量统计、体检信号）都得把它们择开，
 * 否则「按模型」表里会冒出 qqbot / ilink 这种"模型"。
 */
export const CHANNEL_PURPOSES = ["qq", "wechat"] as const;

/** 上面那组用途的 SQL 字面量形式：统计查询直接内联，省得每处都摆一遍参数。 */
const CHANNEL_SQL = CHANNEL_PURPOSES.map((p) => `'${p}'`).join(", ");
/** 只数模型调用的口径。 */
const MODEL_ONLY_SQL = `purpose NOT IN (${CHANNEL_SQL})`;

/**
 * DEV_MODE 落请求原文时，把内联的 base64 图/音换成占位。
 * 调试要看的是提示词与消息结构，不是一串 base64——而现在一次调用最多能带 1.5MB 图，
 * 原样落盘等于每条日志几 MB，几次就把库撑到没法备份。长度留着，好判断体积。
 */
function stripInlineDataUrls(json: string): string {
  return json.replace(
    /data:(?:image|audio)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/g,
    (match) => match.slice(0, match.indexOf(";base64,") + ";base64,".length) + `<${match.length} 字符已省略>`,
  );
}

/**
 * 密钥字段一律换成占位——这是 `model_calls` 唯一的脱敏闸门，所有调用方都从这过。
 *
 * 为什么必须在这而不是各调用点：`configure_model` 这类助手工具把 `apiKey` 放在工具参数里，
 * 而工具轮没有正文时 `detail` / `res_full` 会被填成 `工具名(参数原文)`，
 * 于是**用户刚贴的密钥明文落进状态页「调用记录」渲染的那一列**，保留 30 天 / 2 万行。
 * `req_full` 更糟：下一轮回放的 messages 里还带着那份参数，等于把 A 家的 key 发给 B 家服务商。
 * 只靠「不要在回复里复述」这句软指令是挡不住的——它此刻就在模型的上下文窗口里。
 *
 * 顺带遮 `Bearer <token>`：模型偶尔会把请求头回映到回复里，那是服务商报文，拦在入库前。
 */
function redactSecrets(text: string): string {
  return text
    .replace(/"([A-Za-z_]*(?:api[_-]?key|secret|password|authorization)[A-Za-z_]*)"\s*:\s*"[^"]*"/gi, '"$1":"<已省略>"')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/g, "Bearer <已省略>");
}

export function logModelCall(row: {
  turnId?: string | null;
  purpose: string;
  ok: boolean;
  code?: string | null;
  status?: number | null;
  model?: string | null;
  url?: string | null;
  elapsedMs: number;
  message?: string | null;
  detail?: string | null;
  /** 完整响应正文（模型回复原文），不给则退回 detail 摘要。 */
  resFull?: string | null;
  /** 服务商返回的原始 JSON 报文：DEV_MODE 下响应原文落这份，否则落 resFull。 */
  resRaw?: string | null;
  /** 发给模型的请求体。仅 DEV_MODE 下序列化落盘。 */
  requestBody?: unknown;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  contactId?: string | null;
  profileId?: string | null;
  /** 调用方主动取消（barge-in / 跨进程取消 / 到点放弃）——不是故障，不落失败行。 */
  cancelled?: boolean;
}): void {
  // 取消不该记成失败：用户在她说话时插一句就会触发一次，落成 ok=0 会让
  // 状态页红点与「累计失败」虚高——"失败必须可见"这条纪律反过来被噪声淹了。
  // 想看"刚才为什么停了"有处理单那边的记录，不缺这一行。
  if (row.cancelled === true) return;
  const reqFull = config.devMode && row.requestBody !== undefined
    ? capFullText(redactSecrets(stripInlineDataUrls(JSON.stringify(row.requestBody))))
    : null;
  const resFull = (config.devMode && row.resRaw !== undefined && row.resRaw !== null)
    ? capFullText(redactSecrets(row.resRaw))
    : (row.resFull == null ? null : capFullText(redactSecrets(row.resFull)));
  db.prepare(
    `INSERT INTO model_calls (turn_id, purpose, ok, code, status, model, url, elapsed_ms, message, detail, created_at, prompt_tokens, completion_tokens, total_tokens, contact_id, profile_id, req_full, res_full)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.turnId ?? null,
    row.purpose,
    row.ok ? 1 : 0,
    row.code ?? null,
    row.status ?? null,
    row.model ?? null,
    row.url ?? null,
    Math.round(row.elapsedMs),
    row.message ?? null,
    row.detail ? redactSecrets(row.detail).slice(0, 2000) : null,
    Date.now(),
    row.promptTokens ?? null,
    row.completionTokens ?? null,
    row.totalTokens ?? null,
    row.contactId ?? null,
    row.profileId ?? null,
    reqFull,
    resFull,
  );
  if (reqFull !== null || resFull !== null) {
    // 环形窗口：全文只留最近 FULL_TEXT_WINDOW 条，其余剥成摘要（detail 本来就在）。
    //
    // ⚠️ 外层必须用 id 下限把扫描圈住。原语句的外层谓词
    // （req_full IS NOT NULL OR res_full IS NOT NULL）没有索引可走——
    // idx_model_calls_created 在 created_at 上、idx_model_calls_failed 是 `WHERE ok=0`
    // 的部分索引，两者都用不上——于是每次带全文的调用都全表扫一遍 model_calls。
    // 而成功聊天**每次**都带 res_full，等于每条回复的请求路径上都同步扫全表
    // （2 万行保留上限时尤其明显）。加上"只看最近窗口附近的行"之后，实际访问的是个位数行。
    db.prepare(
      `UPDATE model_calls SET req_full = NULL, res_full = NULL
       WHERE id >= (SELECT MAX(id) - ? FROM model_calls)
         AND (req_full IS NOT NULL OR res_full IS NOT NULL)
         AND id NOT IN (
           SELECT id FROM model_calls
           WHERE req_full IS NOT NULL OR res_full IS NOT NULL
           ORDER BY id DESC LIMIT ?)`,
    ).run(FULL_TEXT_WINDOW, FULL_TEXT_WINDOW);
  }
}

/** 倒序取一段调用记录；offset 供界面「加载更多」翻页用。 */
export function recentModelCalls(limit = 20, offset = 0): ModelCallRow[] {
  return db
    .prepare(`SELECT * FROM model_calls ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as unknown as ModelCallRow[];
}

/**
 * 列表页用的行：两列原文换成字数。
 * 实测一页 25 行里，摘要是 12.8 KB、而 req_full/res_full 占掉 98%（一行请求原文能到 93 KB），
 * 可这些字节在列表里一个都不显示，只有点开那一行才用得上——那就点开那一行时再取。
 */
export type ModelCallSummary = Omit<ModelCallRow, "req_full" | "res_full"> & {
  req_chars: number | null;
  res_chars: number | null;
};

const SUMMARY_COLUMNS = `id, turn_id, purpose, ok, code, status, model, url, elapsed_ms, message, detail,
  created_at, prompt_tokens, completion_tokens, total_tokens, contact_id, profile_id,
  LENGTH(req_full) AS req_chars, LENGTH(res_full) AS res_chars`;

/** 列表的筛选条件：只看失败 / 按用途 / 限定某条处理单。
    modelOnly 与 channelOnly 互斥，管的是「这张表里混着通道投递」那件事：
    界面默认给 modelOnly（调用记录首先是模型调用），另有一个「通道投递」档看投递。 */
export type CallFilter = {
  onlyFailed?: boolean;
  purpose?: string;
  turnId?: string;
  modelOnly?: boolean;
  channelOnly?: boolean;
};

function filterClause(filter: CallFilter): { where: string; args: Array<string | number> } {
  const parts: string[] = [];
  const args: Array<string | number> = [];
  if (filter.onlyFailed) parts.push("ok = 0");
  if (filter.purpose) { parts.push("purpose = ?"); args.push(filter.purpose); }
  if (filter.turnId) { parts.push("turn_id = ?"); args.push(filter.turnId); }
  // 参数要紧跟占位符的顺序推：上面几项先推，这里后推，和 SQL 里出现的次序一致。
  if (filter.modelOnly || filter.channelOnly) {
    const marks = CHANNEL_PURPOSES.map(() => "?").join(",");
    parts.push(filter.modelOnly ? `purpose NOT IN (${marks})` : `purpose IN (${marks})`);
    args.push(...CHANNEL_PURPOSES);
  }
  return { where: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", args };
}

export function recentModelCallSummaries(
  limit = 20, offset = 0, filter: CallFilter = {},
): ModelCallSummary[] {
  const { where, args } = filterClause(filter);
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM model_calls${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as unknown as ModelCallSummary[];
}

/** 与列表同一套 WHERE：total 必须跟着筛选走，否则「已显示 / 共」会是两个口径。 */
export function countModelCalls(filter: CallFilter = {}): number {
  const { where, args } = filterClause(filter);
  const row = db.prepare(`SELECT COUNT(*) AS c FROM model_calls${where}`).get(...args) as { c: number };
  return row.c;
}

/** 单行的完整原文（含两列全文）：原文抽屉按需取这一条，列表里永远不带着跑。 */
export function modelCallById(id: number): ModelCallRow | null {
  const row = db.prepare(`SELECT * FROM model_calls WHERE id = ?`).get(id) as ModelCallRow | undefined;
  return row ?? null;
}

export function modelCallCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM model_calls`).get() as { c: number };
  return row.c;
}

/**
 * 最近一次模型调用（无论成败）——体检看的是"现在到底坏没坏"。
 * 不能看"历史里最近的一次失败"：修好之后那条失败还挂着，红灯就一直骗人。
 * 通道投递不算：一条 QQ 投递记录顶到最前面，体检就跟着报告"最近一次调用是 qq"。
 */
export function lastModelCall(): ModelCallRow | null {
  const row = db
    .prepare(`SELECT * FROM model_calls WHERE ${MODEL_ONLY_SQL} ORDER BY id DESC LIMIT 1`)
    .get() as ModelCallRow | undefined;
  return row ?? null;
}

const RETENTION_MS = 30 * 86_400_000;
const RETENTION_ROWS = 20_000;

/** 日志保留策略：30 天 + 2 万条封顶——本地单机应用也不该让 model_calls 无限膨胀。 */
export function pruneModelCalls(): void {
  db.prepare(`DELETE FROM model_calls WHERE created_at < ?`).run(Date.now() - RETENTION_MS);
  db.prepare(`DELETE FROM model_calls WHERE id <= (SELECT MAX(id) - ? FROM model_calls)`).run(RETENTION_ROWS);
}

// 启动时先跑一次；之后由 index.ts 的维护定时器周期性地跑——这是个常驻进程，
// 只在这里执行一次等于跑几周不重启就永远不清，表照样无界增长。
pruneModelCalls();

/**
 * 在飞的调用登记（只在内存里，不落库、不参与失败统计）。
 *
 * 为什么需要它：model_calls 只落**已完成**的行，而一次调用可能十几秒不返回。
 * 那段时间「调用记录」页面一片安静，用户分不清是没在跑还是正在跑——
 * 尤其是点了「重新生成」之后，界面上没有任何一处能证明后端真的在干活。
 */
export type InflightCall = {
  id: number;
  purpose: string;
  model: string;
  contactId: string | null;
  turnId: string | null;
  startedAt: number;
};

const inflight = new Map<number, InflightCall>();
let inflightSeq = 0;

export function beginModelCall(info: { purpose: string; model: string; contactId?: string | null; turnId?: string | null }): number {
  const id = ++inflightSeq;
  inflight.set(id, {
    id,
    purpose: info.purpose,
    model: info.model,
    contactId: info.contactId ?? null,
    turnId: info.turnId ?? null,
    startedAt: Date.now(),
  });
  return id;
}

export function endModelCall(id: number): void {
  inflight.delete(id);
}

/** 最新在前，附带已耗时与它在回哪句话——界面显示「进行中 · 3.2s · 正在回复「…」」。
 *  turn 文本在这里才查（不是登记时快照）：只有几行在飞，一次一条主键查询，换掉的是
 *  model.ts 对 db 的耦合。 */
export function listInflightCalls(): Array<InflightCall & { elapsedMs: number; turnText: string | null }> {
  const now = Date.now();
  const probe = db.prepare("SELECT text FROM turns WHERE id = ?");
  return [...inflight.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((call) => {
      const row = call.turnId === null ? undefined : probe.get(call.turnId) as { text: string } | undefined;
      return { ...call, elapsedMs: now - call.startedAt, turnText: row?.text ?? null };
    });
}

/**
 * 「重新计数」的水印：早于它的调用不再计入任何失败读数。
 *
 * 状态页的红点数的是累计失败（实测 957 次），修好之后它照样挂着——用户去看了一眼，
 * 但没有任何地方告诉他"这条已经翻篇了"。这个水印就是那一下：只挪读数起点，
 * model_calls 里的记录一条都不删，调用记录页照旧能翻到全部历史。
 */
const KV_FAILURE_WATERMARK = "status.failureWatermark";

export function failureWatermark(): number {
  return Number(kvGet(KV_FAILURE_WATERMARK) ?? "0") || 0;
}

export function resetFailureCounters(): number {
  const at = Date.now();
  kvSet(KV_FAILURE_WATERMARK, String(at));
  return at;
}

/** 「累计失败 N 次」红点：只数模型调用。通道投递失败归各自的通道卡管
    （总览的微信/QQ 行自己报连接问题），混在这儿会让模型红点替 QQ 背锅。 */
export function modelFailureCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM model_calls WHERE ok = 0 AND ${MODEL_ONLY_SQL} AND created_at >= ?`)
    .get(failureWatermark()) as { c: number };
  return row.c;
}

/**
 * 近 N 小时的调用数与失败数。健康信号必须有时间窗——累计值里 8 天前的一次失败
 * 会把这一行永久标黄，而昨天连不上模型可能一次都没记上（截存另有保留策略）。
 * 同样只数模型调用：这一行顶着的名头就是"调用/失败"的模型口径。
 */
export function modelCallWindow(hours: number): { calls: number; fail: number } {
  // 窗口起点与水印取较晚的那个：刚点过「重新计数」，24 小时窗口也不该把旧失败算回来
  const since = Math.max(Date.now() - hours * 3_600_000, failureWatermark());
  const row = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(1 - ok), 0) AS fail
    FROM model_calls WHERE created_at >= ? AND ${MODEL_ONLY_SQL}`).get(since) as { calls: number; fail: number };
  return { calls: row.calls, fail: row.fail };
}

ensureColumn("model_calls", "prompt_tokens", "prompt_tokens INTEGER");
ensureColumn("model_calls", "completion_tokens", "completion_tokens INTEGER");
ensureColumn("model_calls", "total_tokens", "total_tokens INTEGER");
ensureColumn("model_calls", "contact_id", "contact_id TEXT");
ensureColumn("model_calls", "profile_id", "profile_id TEXT");
ensureColumn("model_calls", "req_full", "req_full TEXT");
ensureColumn("model_calls", "res_full", "res_full TEXT");

export type UsageBucket = {
  calls: number;
  ok: number;
  fail: number;
  avgMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UsageStats = {
  today: UsageBucket;
  week: UsageBucket;
  total: UsageBucket;
  byDay: Array<{ day: string; calls: number; fail: number; totalTokens: number }>;
  byPurpose: Array<{ purpose: string; calls: number; totalTokens: number }>;
  /** 近 30 天按模型档聚合；profileId null = 走的全局配置（不属于任何档）。purposes 用于识别语音类调用。 */
  byModel: Array<{ profileId: string | null; model: string | null; purposes: string; calls: number; fail: number; totalTokens: number }>;
  /** 近 30 天按联系人聚合；contactId null = 无联系人归属的调用（如记忆抽取兜底）。 */
  byContact: Array<{ contactId: string | null; calls: number; fail: number; totalTokens: number }>;
};

const BUCKET_SQL = `
  COUNT(*) AS calls,
  COALESCE(SUM(ok), 0) AS ok,
  COALESCE(SUM(1 - ok), 0) AS fail,
  COALESCE(AVG(elapsed_ms), 0) AS avgMs,
  COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
  COALESCE(SUM(completion_tokens), 0) AS completionTokens,
  COALESCE(SUM(total_tokens), 0) AS totalTokens
`;

/** 今日/近 7 天/累计三个 KPI 与下面各分布同一口径：只数模型调用（见 MODEL_ONLY_SQL）。 */
function bucketSince(since: number | null): UsageBucket {
  const where = since === null ? `WHERE ${MODEL_ONLY_SQL}` : `WHERE created_at >= ? AND ${MODEL_ONLY_SQL}`;
  const row = db.prepare(`SELECT ${BUCKET_SQL} FROM model_calls ${where}`)
    .get(...(since === null ? [] : [since])) as unknown as UsageBucket;
  return row;
}

/** 模型用量统计：今日 / 近 7 天 / 累计，外加按日、按用途、按模型档、按联系人的分布。token 依赖服务商返回 usage，旧记录为 0。 */
export function usageStats(): UsageStats {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const todayStart = d.getTime();
  const weekStart = todayStart - 6 * 86_400_000;
  const monthStart = todayStart - 29 * 86_400_000;

  // 按日窗口给满 30 天，**新的一天在前**：界面默认只显最近 7 行，「加载更多」再展开。
  // 排序不能用 day 本身——它是 '%m-%d'，跨年那一周会把 12-31 排在 01-02 之后。
  const byDayRows = db.prepare(`
    SELECT strftime('%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
           COUNT(*) AS calls,
           COALESCE(SUM(1 - ok), 0) AS fail,
           COALESCE(SUM(total_tokens), 0) AS totalTokens
    FROM model_calls
    WHERE created_at >= ? AND ${MODEL_ONLY_SQL}
    GROUP BY day ORDER BY MIN(created_at) DESC`).all(monthStart) as unknown as UsageStats["byDay"];

  const byPurpose = db.prepare(`
    SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS totalTokens
    FROM model_calls WHERE ${MODEL_ONLY_SQL} GROUP BY purpose ORDER BY calls DESC`).all() as unknown as UsageStats["byPurpose"];

  const byModel = db.prepare(`
    SELECT profile_id AS profileId, model,
           GROUP_CONCAT(DISTINCT purpose) AS purposes,
           COUNT(*) AS calls,
           COALESCE(SUM(1 - ok), 0) AS fail,
           COALESCE(SUM(total_tokens), 0) AS totalTokens
    FROM model_calls
    WHERE created_at >= ? AND purpose NOT IN ('asr', 'tts') AND ${MODEL_ONLY_SQL}
    GROUP BY profile_id, model
    ORDER BY calls DESC LIMIT 12`).all(monthStart) as unknown as UsageStats["byModel"];

  const byModelAudio = db.prepare(`
    SELECT NULL AS profileId, model, purpose AS purposes,
           COUNT(*) AS calls,
           COALESCE(SUM(1 - ok), 0) AS fail,
           0 AS totalTokens
    FROM model_calls
    WHERE created_at >= ? AND purpose IN ('asr', 'tts')
    GROUP BY model, purpose
    ORDER BY calls DESC LIMIT 12`).all(monthStart) as unknown as UsageStats["byModel"];

  const byContact = db.prepare(`
    SELECT contact_id AS contactId,
           COUNT(*) AS calls,
           COALESCE(SUM(1 - ok), 0) AS fail,
           COALESCE(SUM(total_tokens), 0) AS totalTokens
    FROM model_calls
    WHERE created_at >= ? AND ${MODEL_ONLY_SQL}
    GROUP BY contact_id
    ORDER BY calls DESC LIMIT 12`).all(monthStart) as unknown as UsageStats["byContact"];

  return {
    today: bucketSince(todayStart),
    week: bucketSince(weekStart),
    total: bucketSince(null),
    byDay: byDayRows,
    byPurpose,
    byModel: [...byModel, ...byModelAudio].sort((a, b) => b.calls - a.calls).slice(0, 12),
    byContact,
  };
}
