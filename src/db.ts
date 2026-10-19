// SQLite（Node 内置 node:sqlite，零依赖、无需编译原生模块）。
//
// 为什么用它：MVP 阶段一个文件就够，备份=复制一个文件，无需装数据库服务。
// 上量后的迁移路径：Postgres + pgvector，本文件的表结构可几乎原样搬过去。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.ts";

const dbFile = resolve(config.dbPath);
mkdirSync(dirname(dbFile), { recursive: true });

export const db = new DatabaseSync(dbFile);

// WAL：读写并发时不容易互相阻塞（一个进程在写、另一个在查也不卡）。
db.exec("PRAGMA journal_mode = WAL");
// 桌面多窗口 = 多进程共享同一个库文件：写冲突时先等而不是立刻抛 SQLITE_BUSY。
db.exec("PRAGMA busy_timeout = 5000");

/** 多语句写必须同生共死：中途抛错回滚，不留半截脏状态。 */
export function withTx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch { /* 事务已被 SQLite 自动中止 */ }
    throw error;
  }
}

db.exec(`
-- 消息：只放"说过的话"，用于拼最近上下文与界面展示。
-- superseded_at 非空表示这条已不在对话里。superseded_kind 说明是**为什么**不在：
--   'edit'    被一次编辑取代（连同它之后的都作废）→ 界面折叠成一块，可展开查看
--   'retract' 被单独撤回 → 界面显示成「你撤回了一条消息」
-- 两者界面表现不同，所以必须能区分；旧数据的 kind 为 NULL，按 'edit' 处理。
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel         TEXT    NOT NULL DEFAULT 'web',
  role            TEXT    NOT NULL,              -- user | assistant
  text            TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'chat', -- chat | proactive（主动发起）
  created_at      INTEGER NOT NULL,
  superseded_at   INTEGER,
  superseded_kind TEXT
);

-- 一次「用户说话 → 助手回应」的处理单。先建单立即返回，再异步推进。
CREATE TABLE IF NOT EXISTS turns (
  id            TEXT    PRIMARY KEY,
  channel       TEXT    NOT NULL DEFAULT 'web',
  text          TEXT    NOT NULL,
  status        TEXT    NOT NULL,             -- queued | running | done | failed | cancelled（被新消息打断）
  reply         TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  superseded_at INTEGER
);

-- 关系事件：这套记忆只存"状态与承诺"，不存原始聊天记录。
-- content 是一句话事实，例如「他答应周日一起吃饭」「他偏好咸口」。
CREATE TABLE IF NOT EXISTS memory_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,            -- promise | preference | fact | mood | plan
  subject      TEXT    NOT NULL DEFAULT '',
  content      TEXT    NOT NULL,
  weight       REAL    NOT NULL DEFAULT 1,  -- 重要度，越高越容易被想起
  source_turn  TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
CREATE INDEX IF NOT EXISTS idx_memory_created   ON memory_events (created_at);

-- 主动性任务：借鉴参考项目——判断一次，带着具体观察落成一条定时任务，
-- 到点执行、执行留痕。用户能在状态页看到「她接下来想做什么、为什么」。
CREATE TABLE IF NOT EXISTS proactive_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  focus          TEXT    NOT NULL DEFAULT '',  -- 下次检查时想关注的点（模型生成的观察）
  due_at         INTEGER NOT NULL,             -- 到期时间戳
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending | done | failed | skipped | cancelled
  postpone_count INTEGER NOT NULL DEFAULT 0,   -- 免打扰顺延次数（防止无限顺延）
  result         TEXT,                          -- 执行结果（说了什么 / 为什么没说）
  error          TEXT,                          -- 失败原因（失败必须可见）
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_proactive_due ON proactive_tasks (status, due_at);

-- 联系人：一个联系人 = 一段独立的关系（人格 + 记忆 + 对话完全隔离）。
-- type 留 group 口子（群聊：一个会话多个参与者），当前只实现 single。
CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  type        TEXT    NOT NULL DEFAULT 'single',
  name        TEXT    NOT NULL,
  card        TEXT    NOT NULL,            -- CharacterCard JSON（identity/background/relationship/name）
  created_at  INTEGER NOT NULL,
  archived_at INTEGER                          -- 归档而非删除（人格数据不可再生）
);

-- 键值表：模型/角色卡设置与各能力配置档、助手工作区注册表、微信绑定与游标、
-- 多进程当家心跳，以及运行状态（例如记忆抽取连续失败次数）。
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 多进程共库时「谁来跑后台副作用」的租约。单独一张表而不是塞进 kv：
-- 抢租约必须靠一条带 WHERE 的 UPSERT 原子完成，而 kv.v 是字符串，比不了时间戳。
-- id 是 fencing token：续租与交还都只认自己那一行，抢不回别人的锁。
CREATE TABLE IF NOT EXISTS instance_lease (
  k   TEXT    PRIMARY KEY,
  id  TEXT    NOT NULL,
  pid INTEGER NOT NULL,
  at  INTEGER NOT NULL
);
`);

export function kvGet(key: string): string | null {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(key: string, value: string): void {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
}

// 迁移记账：当前结构靠 ensureColumn 增量补列（幂等），这个号留给未来
// 需要"知道旧库处在哪个版本"才能做的破坏性迁移。
if (kvGet("schema_version") === null) kvSet("schema_version", "1");

/**
 * 轻量迁移：列不存在就加上。
 * MVP 不引入迁移框架，但所有结构变更都走这个函数——
 * 好处是老的数据库文件不用删也能继续用（用户的数据不会被清掉）。
 */
export function ensureColumn(table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[db] 已补充字段 ${table}.${column}`);
}

// turn_id 用来把消息归属到具体那轮处理单：重试时才不会重复写一遍用户消息。
ensureColumn("messages", "turn_id", "turn_id TEXT");
// 模型这一轮的思考原文：只给界面折叠回看，滚动窗口外置 NULL（见 agent.ts trimReasoningWindow）。
// 刻意不进 recentMessages 的列白名单 —— 思考内容绝不能被回放进上下文。
ensureColumn("messages", "reasoning", "reasoning TEXT");
// 工具卡的可展开详情（搜到的条目 / 抓到的正文摘要 / 技能正文）：同样只给界面回看，
// 不进上下文回放，且每联系人只保留最近若干轮（滚出即 NULL，见 agent.ts trimToolDetailWindow）。
ensureColumn("messages", "tool_detail", "tool_detail TEXT");

// superseded_at：这条消息已不在对话里（还在库里，可以回溯）。
//   NULL  = 仍在对话上下文里
//   有值  = 已从上下文摘除；配合 superseded_kind 决定界面怎么显示
//
// 为什么用标记而不是真删：这是"事件日志只增不改"纪律的落地。
// 用户改了自己说过的话，历史不该消失——但要让它不再进入模型上下文。
// 真删会让"我刚才说的话去哪了"变成一个无法回答的问题。
ensureColumn("messages", "superseded_at", "superseded_at INTEGER");

// superseded_kind：'edit'（被编辑取代）| 'retract'（被撤回）。界面表现不同，必须能区分。
ensureColumn("messages", "superseded_kind", "superseded_kind TEXT");

// 处理单同理：被编辑作废的那些轮次不该出现在状态页的"最近处理单"里，
// 否则用户会看到一堆"已完成"但其实已经不成立的记录。
ensureColumn("turns", "superseded_at", "superseded_at INTEGER");

// 客户端幂等键：离线发件箱断网重发时，同一句话绝不能建出两个处理单。
ensureColumn("turns", "client_id", "client_id TEXT");

// 联系人头像（dataURL，png/jpg/webp、≤150KB，客户端压到最长边 1280）。存库而非文件：
// 「备份一个文件 = 全部数据」的纪律不因头像破例。
ensureColumn("contacts", "avatar", "avatar TEXT");

// 记忆有效期（借鉴「三重时间」设计）：NULL = 长期有效；
// 有值 = 到期后不再进入召回（界面仍显示但标记"已过期"）。
// 场景：换了的住址、结束了的项目——她记住的旧信息不该一直冒出来。
ensureColumn("memory_events", "valid_until", "valid_until INTEGER");
// 记忆可删（P0-2）：墓碑列，旧库补列。
ensureColumn("memory_events", "deleted_at", "deleted_at INTEGER");

// ── 多联系人迁移（2026-09-17）────────────────────────────
// 每张业务表挂上联系人维度；存量数据全部归属默认联系人 "default"
// （首次启动时由 contacts.ts 把旧的全局角色卡迁移成这个联系人）。
ensureColumn("messages", "contact_id", "contact_id TEXT");
ensureColumn("turns", "contact_id", "contact_id TEXT");
ensureColumn("memory_events", "contact_id", "contact_id TEXT");
ensureColumn("proactive_tasks", "contact_id", "contact_id TEXT");

// 图片附件：JSON 数组（["/media/xxx.jpg", …]），文件本体在 db 同级的 media 目录。
// 绝大多数消息没有附件，保持 NULL 而不是 "[]"——历史行不用动。
ensureColumn("messages", "attachments", "attachments TEXT");
ensureColumn("turns", "attachments", "attachments TEXT");

// 联系人绑定的模型配置档 id（NULL/空 = 跟随全局模型）。
// 只存档 id 不拷配置：档改了所有绑定它的联系人立刻跟着变。
ensureColumn("contacts", "model_profile", "model_profile TEXT");
ensureColumn("contacts", "recent_turns", "recent_turns INTEGER NOT NULL DEFAULT 0");
ensureColumn("contacts", "gender", "gender TEXT NOT NULL DEFAULT 'female'");
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages (contact_id, created_at);
   CREATE INDEX IF NOT EXISTS idx_memory_contact   ON memory_events (contact_id, created_at);
   -- turns 此前一个索引都没有，而它是只增不减的：状态页与聊天页失败横幅每拍都查
   -- 「最近的处理单」（ORDER BY created_at DESC），常驻进程跑几个月就是每次全表扫 + 排序。
   CREATE INDEX IF NOT EXISTS idx_turns_created    ON turns (created_at);
   CREATE INDEX IF NOT EXISTS idx_turns_contact    ON turns (contact_id, created_at);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_client ON turns (contact_id, client_id) WHERE client_id IS NOT NULL;`,
);

// ── 可插拔陪伴能力（借鉴功能包，2026-09-21）───────────────────
// features：每联系人的功能开关 JSON（生活线摘要 / 记忆整理 / 到点提醒 / 关系温度计 /
// 每日主动上限 / 角色作息）。缺省即 FEATURE_DEFAULTS——老库升级零迁移成本。
ensureColumn("contacts", "features", "features TEXT NOT NULL DEFAULT '{}'");
// 生活线摘要与其生成时间：记忆整理任务的产出，界面可手改（派生状态也要用户主权）。
ensureColumn("contacts", "lifeline", "lifeline TEXT NOT NULL DEFAULT ''");
ensureColumn("contacts", "recap", "recap TEXT NOT NULL DEFAULT ''");
ensureColumn("contacts", "recap_upto", "recap_upto INTEGER NOT NULL DEFAULT 0");
ensureColumn("contacts", "lifeline_at", "lifeline_at INTEGER");
// 关系温度计 JSON（stage/warmth/mood）：抽取顺手更新 + 用户可编辑。
ensureColumn("contacts", "bond", "bond TEXT NOT NULL DEFAULT ''");
// 长相参考图：存 /media 路径而不是 dataURL。头像那份是客户端压过的 ≤150KB 内联 dataURL，
// 而参考图要拿得出细节（实测一张 1024×1024 PNG 0.5~1.2MB），内联进 contacts 会把
// 联系人列表接口的载荷重新撑回去（分页那轮刚把它从 357KB 压到 4KB）。
ensureColumn("contacts", "face_ref", "face_ref TEXT NOT NULL DEFAULT ''");
// 主动任务分类：care = 模型判断该不该说；reminder = schedule_reminder 工具立下的
// 到点提醒——必须说，不吃每日配额（陪伴承诺比"防打扰节奏"更硬）。
ensureColumn("proactive_tasks", "kind", "kind TEXT NOT NULL DEFAULT 'care'");
