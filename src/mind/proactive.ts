// 主动性：陪伴产品的核心卖点——不是"你问我答"，而是"它觉得该出现了就出现"。
//
// 调度（2026-11-05，第三版）：节拍由联系人自己定，闹钟只认「最早该醒的那一刻」。
//
// 前两版的问题：第一版每 30 分钟从零想一次该不该联系（无状态）；第二版改成了任务化，
// 但"下次什么时候想"被实现成"往队列表里插一条 pending 任务"，于是调度和台账共用一张表，
// 需要 PENDING_CAP、启动去重、四处 kind 特判三套补丁来维持，还带来三个实打实的缺陷：
//   - 所有到期判断都挂在一个 setInterval(30 分钟) 上，于是"到点必达"的提醒最坏晚 30 分钟，
//     重启后还要再等一整轮才有第一次机会；
//   - 免打扰靠"每半小时顺延一次"往后滚，滚满次数就放弃，跨不过 9 小时的静默期；
//   - 启动时按 kind 去重会连带取消用户自己在面板上立的计划（同样是 kind='care'）。
//
// 现在的模型（职责分开，职责一分开那三套补丁就不需要了）：
//   - proactive_state 一行 = care 的节拍：「下次什么时候想、想什么」；
//     判断完由模型直接决定 next_check_minutes，写回这一行。
//   - proactive_tasks 里的 reminder = 用户立的绝对时间戳承诺，模型无权改。
//   - 调度器睡到两者的最小值（nextWakeAt），醒来只处理已到期的，处理完重排；
//     免打扰在**排期**时一次跳到时段结束，不再每半小时滚一次。
//   - 一趟唤醒最多对用户说一句话：发了提醒，care 就顺延半小时。
//
// 任务化（2026-09-16，保留）：判断一次，带着具体观察落成"下次关注什么"，到点执行、执行留痕。
// 区别只是这份观察现在存在状态行里，不再借一条 pending 任务表达调度。
//
// 多联系人（2026-09-17）：每个联系人独立一套节拍与「今天是否已说过」的配额——
// 跟 A 聊过天，不代表 B 今天也被关心过。
//
// 闸门：免打扰时段与开关是硬闸门；「静默时长」和「每日一次」是**判断依据**注入提示词——
// 判断本身就该考虑这些（"用户刚说过话，那这次可能不该发"），由闸门一刀切反而让模型
// 失去了表达「我惦记着用户但知道现在不该说」的机会。

import { config, inQuietHours } from "../core/config.ts";
import { wechat } from "../channels/wechat.ts";
import { qq } from "../channels/qq.ts";
import { capabilityReady, modelConfig, modelReadyNow, personaConfig } from "../settings/settings.ts";
import { db, kvGet, kvSet } from "../core/db.ts";
import { callModelJson, contactModelSettings, generateImage, IMAGE_DAILY_LIMIT, imagesToday } from "../settings/model.ts";
import {
  estimateTokens,
  historyTokenCapFor,
  inputBudget,
  insertMessage,
  lastUserMessageAt,
  lastUserMessageAtAnyConversation,
  recentMessages,
  trimHistoryToBudget,
} from "../chat/agent.ts";
import { recall } from "./memory.ts";
import { autoPickEmote } from "../emote/emote-search.ts";
import { buildSystemPrompt, ownerPronoun } from "./persona.ts";
import { companionPromptExtras, contactCard, DEFAULT_CONTACT_ID, emoteFrequencyForContact, getContact, listContacts } from "../chat/contacts.ts";
import { bannedWordsNote, parseBannedWords } from "../core/banned-words.ts";
import { isAssistant } from "./assistant.ts";
import { getChannel } from "../channels/types.ts";
import { getConversation, listProactiveCandidates, localConversationId } from "../chat/conversations.ts";
import type { ChatMessage } from "../settings/model.ts";
import { enqueueAndDeliver } from "../channels/outbound.ts";
import { onWakeNeeded } from "../core/wake-hub.ts";

export type ProactiveDecision = {
  spoken: boolean;
  reason: string;
  text?: string;
};

// ── 配额：每个联系人每天最多主动说几次 ────────────────────────────

/** 每个联系人独立的每日配额键（跟 A 聊过不代表 B 今天也被关心过）。 */
const lastSpokenKey = (contactId: string) => `proactive_last_date:${contactId}`;

/**
 * 配额日界线必须用**本地**日期：免打扰时段（QUIET_HOURS）判的是本地 getHours()，
 * 用 toISOString() 会让 UTC+8 的"今天"在早上 8 点重置——凌晨说的话记到昨天，
 * 一个本地日内能发出双倍配额，状态页 0:00-8:00 显示的也是昨天的计数。
 */
function localDateKey(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 今天已主动说过几次。kv 值格式 `${date}:${count}`；
 * 兼容旧格式（裸日期 = 说过 1 次），老库不用迁移。
 */
function spokenCountToday(contactId: string): number {
  const raw = kvGet(lastSpokenKey(contactId));
  if (!raw) return 0;
  const today = localDateKey();
  const [date, countRaw] = raw.split(":");
  if (date !== today) return 0;
  if (countRaw === undefined) return 1;
  const n = Number(countRaw);
  return Number.isFinite(n) ? n : 1;
}

function markSpokenToday(contactId: string): void {
  const today = localDateKey();
  kvSet(lastSpokenKey(contactId), `${today}:${spokenCountToday(contactId) + 1}`);
}

/** 生效上限：联系人 dailyLimit > 全局默认（PROACTIVE_DAILY_LIMIT）。 */
function effectiveDailyLimit(contactId: string): number {
  const limit = getContact(contactId)?.features.dailyLimit ?? 0;
  return limit > 0 ? limit : config.proactive.dailyLimit;
}

/** 明天的零点：配额用完时用它把节拍推到"新的一天"。 */
function nextLocalDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// ── 任务台账：承诺（reminder）与用户手建的计划 ────────────────────

export type ProactiveTask = {
  id: number;
  contact_id: string | null;
  focus: string;
  /** care = 到点后模型判断该不该说（用户手建）；reminder = 到点必达的提醒（schedule_reminder 立下的）。 */
  kind: "care" | "reminder";
  due_at: number;
  status: "pending" | "done" | "failed" | "skipped" | "cancelled";
  postpone_count: number;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  /** 这条打算指向的会话：reminder 在哪个会话立的就在哪个会话兑现；NULL = 到点再按最近动静选。 */
  conversation_id: string | null;
};

const TASK_COLUMNS =
  "id, contact_id, focus, kind, due_at, status, postpone_count, result, error, created_at, finished_at, conversation_id";

/** 面板的两个页签各自查自己的那一堆：待执行 / 已执行（含失败、跳过、取消）。 */
export type TaskState = "pending" | "history";

function taskStateClause(state?: TaskState): { where: string; args: string[] } {
  if (state === "pending") return { where: " AND status = 'pending'", args: [] };
  if (state === "history") return { where: " AND status <> 'pending'", args: [] };
  return { where: "", args: [] };
}

export function listProactiveTasks(contactId: string, limit = 20, offset = 0, state?: TaskState): ProactiveTask[] {
  const { where, args } = taskStateClause(state);
  return db
    .prepare(`SELECT ${TASK_COLUMNS} FROM proactive_tasks WHERE contact_id = ?${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(contactId, ...args, Math.min(100, Math.max(1, limit)), offset) as unknown as ProactiveTask[];
}

/** 与列表同一张 WHERE：页脚那句「已显示 X / 共 Y」必须同口径。 */
export function countProactiveTasks(contactId: string, state?: TaskState): number {
  const { where, args } = taskStateClause(state);
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM proactive_tasks WHERE contact_id = ?${where}`)
    .get(contactId, ...args) as { c: number };
  return row.c;
}

export function pendingProactiveTask(contactId: string): ProactiveTask | null {
  const row = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM proactive_tasks WHERE contact_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 1`,
    )
    .get(contactId) as ProactiveTask | undefined;
  return row ?? null;
}

/** 联系人列表只需要“临近到期”的任务；一次批量查，避免 N 个联系人查 N 次库。 */
export type PendingSoonTask = Pick<ProactiveTask, "contact_id" | "focus" | "kind" | "due_at">;

/** 临近窗口：1 小时。原先跟着检查间隔走，现在节拍由模型定，窗口必须是固定的一段时间。 */
const PENDING_SOON_LEAD_MS = 60 * 60_000;

/**
 * 每个联系人只留最早到期的那件事——任务行（提醒 / 手建计划）与状态行（care 节拍）合起来看。
 * 已到期但仍 pending 的也算；远期计划不进列表状态。
 */
export function pendingSoonByContact(now = Date.now()): Map<string, PendingSoonTask> {
  const out = new Map<string, PendingSoonTask>();
  const take = (row: { contact_id: string; focus: string; kind: "care" | "reminder"; due_at: number }): void => {
    if (row.due_at > now + PENDING_SOON_LEAD_MS) return;
    const seen = out.get(row.contact_id);
    if (seen !== undefined && seen.due_at <= row.due_at) return;
    out.set(row.contact_id, row);
  };
  const tasks = db
    .prepare(
      `SELECT contact_id, focus, kind, due_at FROM proactive_tasks
       WHERE status = 'pending' AND contact_id IS NOT NULL AND due_at <= ?
       ORDER BY due_at ASC`,
    )
    .all(now + PENDING_SOON_LEAD_MS) as Array<{ contact_id: string; focus: string; kind: string; due_at: number }>;
  for (const row of tasks) {
    take({
      contact_id: row.contact_id,
      focus: row.focus,
      kind: row.kind === "reminder" ? "reminder" : "care",
      due_at: Number(row.due_at),
    });
  }
  const states = db
    .prepare(`SELECT contact_id, focus, next_check_at FROM proactive_state WHERE next_check_at <= ?`)
    .all(now + PENDING_SOON_LEAD_MS) as Array<{ contact_id: string; focus: string; next_check_at: number }>;
  for (const row of states) {
    take({
      contact_id: row.contact_id,
      focus: row.focus.trim() !== "" ? row.focus : "常规关心：看看你最近的状态",
      kind: "care",
      due_at: Number(row.next_check_at),
    });
  }
  return out;
}

function insertTask(
  contactId: string,
  focus: string,
  dueAt: number,
  kind: ProactiveTask["kind"] = "care",
  conversationId: string | null = null,
): ProactiveTask {
  const createdAt = Date.now();
  const result = db.prepare(
    `INSERT INTO proactive_tasks (contact_id, focus, due_at, kind, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(contactId, focus, dueAt, kind, conversationId, createdAt);
  // 新的承诺可能比闹钟当前排的时刻更早：立刻重排，别等这趟。
  scheduleWake();
  return {
    id: Number(result.lastInsertRowid),
    contact_id: contactId, focus, kind, due_at: dueAt, status: "pending",
    postpone_count: 0, result: null, error: null,
    // 回读也要给真实的建立时刻：从前这里返回 dueAt，于是「刚立的一条」在界面上
    // 显示成建在未来（立一个明晚的提醒，创建时间就是明晚）。
    created_at: createdAt, finished_at: null,
    conversation_id: conversationId,
  };
}

/** 只留痕、不进队列：care 的一次判断已经发生完了，写一条历史行给「执行记录」看。
 *  不再用 pending 行表达调度——那正是旧版堆积与误删的来源。 */
function recordCareHistory(
  contactId: string,
  focus: string,
  status: "done" | "failed" | "skipped",
  detail: string,
  error?: string,
): number {
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO proactive_tasks (contact_id, focus, kind, due_at, status, result, error, created_at, finished_at)
     VALUES (?, ?, 'care', ?, ?, ?, ?, ?, ?)`,
  ).run(contactId, focus, now, status, detail, error ?? null, now, now);
  return Number(result.lastInsertRowid);
}

// 提醒额度已下沉到 core/reminder-slot.ts：占额度的是工具层，放这里会形成
// agent → tools → proactive → agent 的运行时环。保留原有导出，外部调用方不受影响。
export { REMINDERS_PER_TURN, takeReminderSlot } from "../core/reminder-slot.ts";

function finishTask(id: number, status: ProactiveTask["status"], detail: string, error?: string): void {
  db.prepare(
    `UPDATE proactive_tasks SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`,
  ).run(status, detail, error ?? null, Date.now(), id);
}

/** 取消一条待执行的打算。contactId 必传：任务是按联系人隔离的，
 *  只按 id 改就等于看着 A 的界面取消 B 的打算（那条于是永远不触发）。
 *  返回 false 表示"没取消成"——不存在、不属于这个联系人、或状态不是 pending。 */
export function cancelProactiveTask(id: number, contactId?: string): boolean {
  const row = db.prepare(`SELECT status, contact_id FROM proactive_tasks WHERE id = ?`).get(id) as { status: string; contact_id: string | null } | undefined;
  if (!row || row.status !== "pending") return false;
  if (contactId !== undefined && (row.contact_id ?? DEFAULT_CONTACT_ID) !== contactId) return false;
  finishTask(id, "cancelled", "用户手动取消了这条打算");
  scheduleWake();
  return true;
}

/** 用户自己在「主动性」面板上立一条计划。两种语义（界面必须讲清，因为代价不同）：
 *  - care：到点拿 focus 去问模型「该不该说」——联系人会改写成一句自然的话，也可能决定不说，吃每日配额；
 *  - reminder：到点把 focus **原样**发出去，不问模型、不吃配额（承诺必须兑现）。
 *  到点就是到点：真正的发送由调度器在那一刻唤醒完成（reminder 精确到秒），
 *  只有落在免打扰时段才会顺延到时段结束。 */
export function createProactiveTask(
  contactId: string,
  input: { kind?: unknown; focus?: unknown; dueAt?: unknown },
): ProactiveTask {
  const kind: ProactiveTask["kind"] = input.kind === "reminder" ? "reminder" : "care";
  const focus = String(input.focus ?? "").trim().slice(0, 200);
  if (focus === "") throw new Error("要记的事不能为空");
  const dueAt = Number(input.dueAt);
  // 容忍 1 分钟的时钟差：表单算出来的「刚刚」被网络往返拖到过去几秒，不该因此报错。
  if (!Number.isFinite(dueAt) || dueAt < Date.now() - 60_000) {
    throw new Error("时间要在未来（想立刻检查联系人会说什么，用「立即检查主动性」）");
  }
  return insertTask(contactId, focus, dueAt, kind);
}

/** 撤销一次取消：只有被手动取消的那条能放回待执行，其余状态一律不动。
 *  放回去之后到期照常被唤醒链拾起——用户点「撤销」要的就是这个效果。 */
export function restoreProactiveTask(id: number, contactId?: string): boolean {
  // 先按 id + 状态锁定，再补一道户主判断（UPDATE 的 WHERE 里不便带 OR，
  // 因为 contact_id 为 NULL 的存量行要按 default 认）。
  const row = db.prepare(`SELECT contact_id FROM proactive_tasks WHERE id = ? AND status = 'cancelled'`)
    .get(id) as { contact_id: string | null } | undefined;
  if (!row) return false;
  if (contactId !== undefined && (row.contact_id ?? DEFAULT_CONTACT_ID) !== contactId) return false;
  const changed = db.prepare(
    `UPDATE proactive_tasks SET status = 'pending', result = NULL, error = NULL, finished_at = NULL
     WHERE id = ? AND status = 'cancelled'`,
  ).run(id);
  if (changed.changes > 0) scheduleWake();
  return changed.changes > 0;
}

// ── care 的节拍：一行状态 ─────────────────────────────────────────

export type ProactiveState = {
  contact_id: string;
  next_check_at: number;
  focus: string;
  updated_at: number;
};

export function proactiveState(contactId: string): ProactiveState | null {
  const row = db
    .prepare(`SELECT contact_id, next_check_at, focus, updated_at FROM proactive_state WHERE contact_id = ?`)
    .get(contactId) as ProactiveState | undefined;
  return row ?? null;
}

/**
 * 写下一次检查时刻。focus 传空则保留原值——模型这次没给观察，不该把惦记的事抹掉。
 * 写盘后立刻重排闹钟：新时刻可能比当前排的更早。
 */
export function setNextCheck(contactId: string, at: number, focus?: string): void {
  const clean = focus?.trim() ?? "";
  db.prepare(
    `INSERT INTO proactive_state (contact_id, next_check_at, focus, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET
       next_check_at = excluded.next_check_at,
       focus = CASE WHEN excluded.focus <> '' THEN excluded.focus ELSE proactive_state.focus END,
       updated_at = excluded.updated_at`,
  ).run(contactId, Math.round(at), clean, Date.now());
  scheduleWake();
}

/** 只往后推、不提前：已经有更晚的节拍时保持原样（同一趟里两个来源都想推后时取最晚）。 */
function deferNextCheck(contactId: string, at: number): void {
  const current = proactiveState(contactId);
  setNextCheck(contactId, current === null ? at : Math.max(current.next_check_at, Math.round(at)));
}

// ── 免打扰：排期时一次跳过，不做半小时步进 ────────────────────────

/**
 * 把一个时刻推到「不在免打扰时段」的第一个整点。
 * 旧版是每次检查 +30 分钟往后滚，靠 POSTPONE_MAX 兜底：默认 23-8 是 9 小时，
 * 而 care 的额度只有 6 小时，于是 23:00 之后到期的 care 注定被放弃、连 focus 一起丢掉；
 * reminder 则要滚 18 次，每次都从处理时刻重新算，漂移累积下来还会掉一趟车。
 * 现在一次算清，静默期无论多长都只推一步。
 */
function pushOutOfQuiet(ts: number): number {
  if (!inQuietHours(new Date(ts).getHours())) return ts;
  let cursor = ts;
  // 免打扰按小时配置，最长 23 小时；26 步足够跨过任何一个合法时段。
  for (let i = 0; i < 26; i += 1) {
    const d = new Date(cursor);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    cursor = d.getTime();
    if (!inQuietHours(new Date(cursor).getHours())) return cursor;
  }
  return cursor;
}

/** 人群摊匀的幅度：同一个联系人固定落在 0~15 分钟里。 */
const HERD_SPREAD_MS = 15 * 60_000;

/**
 * 这个联系人在「跳免打扰 / 跳日」这条路上的固定偏移。
 * 用 FNV-1a 这种很土的哈希就够：要的只是「不同人大概率不同、同一个人永远相同」。
 */
function spreadFor(contactId: string): number {
  let h = 2166136261;
  for (let i = 0; i < contactId.length; i += 1) {
    h ^= contactId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % HERD_SPREAD_MS;
}

/**
 * 「这个联系人真正该醒的时刻」。
 *
 * 只给**跳出免打扰**的时刻加偏移：用户说的「九点提醒我吃药」必须一秒不差，
 * 而免打扰结束、配额跳日这两处会把所有人推到同一个整点（默认 08:00）。
 * 一群人在同一秒齐声开口既不像人，也会把模型调用全挤在那一刻——散在 15 分钟内就够了。
 * 注意：排期（nextWakeAt）与到期判定必须用同一个函数，否则会「醒了发现没到期」。
 */
function scheduledAt(ts: number, contactId: string): number {
  const out = pushOutOfQuiet(ts);
  return out === ts ? ts : out + spreadFor(contactId);
}

// ── 调度器：一个闹钟，睡到最早该醒的那一刻 ────────────────────────

/**
 * 单次 setTimeout 的上限分片。
 *
 * 它不是节拍：醒来只做一次「有没有到期的东西」的索引查询，没到期就接着睡，
 * 不调模型、不判断。存在的理由是两种现实——合盖休眠期间定时器不推进、
 * 用户手改系统时间；以及别的进程（或一次失败的唤醒）往库里写了新计划。
 * 用 30 分钟而不是几秒，是因为它要顶住的只是这几种粗糙偏差。
 */
const WAKE_CHUNK_MS = 30 * 60_000;
/** 已经到期却没能推进（判断抛错等）时，别用 0 延迟自旋。 */
const WAKE_RETRY_MS = 15_000;
/** 全新联系人：装上后半小时才有第一次搭话的机会（与旧版手感一致，别一开机就冒一句）。 */
const CARE_FIRST_CHECK_MINUTES = 30;
/** 模型给的节拍范围：最快 5 分钟看一眼，最慢一天。 */
const CARE_MIN_MINUTES = 5;
const CARE_MAX_MINUTES = 24 * 60;
/** 刚发过提醒就别紧接着再补一句关心。 */
const CARE_AFTER_REMINDER_MS = 30 * 60_000;
/** 判断失败（模型/网络）后的重试间隔：留痕一次，十分钟后再试。 */
const CARE_RETRY_MS = 10 * 60_000;

let wakeTimer: NodeJS.Timeout | null = null;
let waking = false;
let loopRunning = false;
let lastImmediateAt = 0;
const checksInFlight = new Set<string>();

/**
 * 所有可能成为"下一次醒来"的时刻。只看真实存在且未归档的联系人：
 * 孤儿的行会由 runWake 清掉，但不能让它们把闹钟钉在过去（那会变成死循环）。
 * 带上 contact_id：跳出免打扰的时刻要按人加分抖，没有它就是一群人的同一个整点。
 */
function wakeCandidates(): Array<{ contactId: string; at: number }> {
  const states = db
    .prepare(
      `SELECT s.contact_id AS contactId, s.next_check_at AS at FROM proactive_state s
       JOIN contacts c ON c.id = s.contact_id AND c.archived_at IS NULL`,
    )
    .all() as Array<{ contactId: string; at: number }>;
  const tasks = db
    .prepare(
      `SELECT t.contact_id AS contactId, t.due_at AS at FROM proactive_tasks t
       JOIN contacts c ON c.id = t.contact_id AND c.archived_at IS NULL
       WHERE t.status = 'pending' AND t.contact_id IS NOT NULL`,
    )
    .all() as Array<{ contactId: string; at: number }>;
  return [...states, ...tasks]
    .map((row) => ({ contactId: row.contactId, at: Number(row.at) }))
    .filter((row) => Number.isFinite(row.at));
}

/** 下一次真正会醒的时刻（悬停兜底分片之前）。状态页与「为什么没说」用它。 */
export function nextWakeAt(): number | null {
  const times = wakeCandidates().map((row) => scheduledAt(row.at, row.contactId));
  return times.length === 0 ? null : Math.min(...times);
}

/** 重排闹钟。没起定时器（非当家进程 / 一次性 CLI）时是空操作。 */
export function scheduleWake(): void {
  if (!loopRunning) return;
  if (wakeTimer !== null) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  const now = Date.now();
  // 总开关关着时每一趟都会立刻早退，没人会推进状态行：若照旧按「已到期」排 0 延迟，
  // 就会每 15 秒空转一轮。这种状态下只保留分片唤醒（用户打开开关需要重启进程，无所谓慢一点）。
  const next = config.proactive.enabled ? nextWakeAt() : null;
  let delay: number;
  if (next === null) {
    // 一条计划都没有：照样睡一小段再看（可能是刚装好、或计划被全部取消）。
    delay = WAKE_CHUNK_MS;
  } else if (next <= now) {
    // 已经到期：立刻跑。但上一次也是"立刻"的话退一步，避免异常路径把 CPU 打满。
    delay = now - lastImmediateAt < WAKE_RETRY_MS ? WAKE_RETRY_MS : 0;
    lastImmediateAt = now;
  } else {
    delay = Math.min(next - now, WAKE_CHUNK_MS);
  }
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void runWake("timer").catch((error: unknown) => {
      console.warn(`[proactive] 唤醒失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, delay);
  wakeTimer.unref?.();
}

/**
 * 一趟唤醒：清孤儿 → 先发全体提醒 → 再逐个判断 care → 重排。
 * 用 `waking` 而不是每联系人的锁挡住重叠：重入的那一趟只记一个"待补跑"，
 * 不会像旧版那样靠 checksInFlight 静默丢掉一整个联系人。
 *
 * 为什么必须两段：提醒不需要模型（原样发出去就行），而 care 一次判断要调模型（最坏 90 秒）。
 * 从前是「逐联系人、每人内部先提醒后判断」，于是 B 的 08:00 提醒会排在 A 的判断后面——
 * A 的模型慢一分钟，B 的承诺就晚一分钟。这跟模型快慢无关，是顺序问题。
 *
 * 导出仅供 smoke 直接跑一趟：那个测试进程只起了 HTTP 服务，没有租约也没有闹钟，
 * 定时器路径根本不会触发（这里是被闹钟、启动补跑调用的那同一个函数）。
 */
export async function runWake(trigger: string): Promise<void> {
  if (waking) return;
  waking = true;
  try {
    pruneOrphans();
    const contacts = listContacts().filter((contact) => !isAssistant(contact.id)); // 设置助手不主动发言
    // 第一段：到点提醒，全体先兑现。单人的失败不挡别人。
    const swept = await sweepDueReminders(contacts);
    // 第二段：逐个判断 care（"一趟最多说一句"仍按人算，谁发过提醒谁就顺延）。
    for (const contact of contacts) {
      try {
        await runProactiveCheck(contact.id, trigger, swept.get(contact.id));
      } catch (error) {
        // 主动性失败必须看得见，否则用户只会觉得"联系人变冷了"。
        console.warn(`[proactive] ⚠️ ${contact.name} 检查失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    waking = false;
    scheduleWake();
  }
}

/**
 * 第一段：把所有联系人的到期提醒一次性发完（不调模型）。
 * 返回「每人这一趟说了什么」：第二段据此把 care 顺序让开（value 为 null = 没提醒）。
 */
async function sweepDueReminders(
  contacts: ReturnType<typeof listContacts>,
): Promise<Map<string, ProactiveDecision | null>> {
  const out = new Map<string, ProactiveDecision | null>();
  const now = Date.now();
  for (const contact of contacts) {
    try {
      out.set(contact.id, await deliverDueReminders(contact.id, now));
    } catch (error) {
      console.warn(`[proactive] ⚠️ ${contact.name} 的到点提醒处理失败：${error instanceof Error ? error.message : String(error)}`);
      out.set(contact.id, null);
    }
  }
  return out;
}

export function startProactiveLoop(): void {
  if (loopRunning) return;
  loopRunning = true;
  // 立提醒的路径在 tools.ts：它改了「该醒的时刻」就敲一下这里重排。
  onWakeNeeded(scheduleWake);
  // 启动即补跑：停机期间到期的提醒不能等下一个整点。
  void runWake("startup").catch((error: unknown) => {
    console.warn(`[proactive] 启动补跑失败：${error instanceof Error ? error.message : String(error)}`);
  });
  console.log("[proactive] 已启动：按最早到期时刻唤醒（提醒精确到秒，care 的节拍由联系人自己定）"
    + (config.proactive.enabled ? "" : " —— 但总开关关着，每趟唤醒都会直接早退"));
}

export function stopProactiveLoop(): void {
  loopRunning = false;
  onWakeNeeded(null);
  if (wakeTimer !== null) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}

// ── 判断指令 ──────────────────────────────────────────────────────

/** 主动性判断指令：ownerPron = 用户的代词（owner.gender），全文一致。
 *  imageGenOn 决定要不要向模型声明 with_image 这个字段——没开就不声明，
 *  和工具侧「不声明的工具模型调不到」同一套口径。
 *  emoteOn 同理决定 emote_keyword：主动那条路没有工具，表情靠这个字段表达，
 *  模型只给「想配的反应词」，够不够贴由检索层判（不是一句「我可以发表情」的空承诺）。
 *  target 告诉模型这条话会发到哪：群场合要说得像群场合（不引用私聊里的内容）。 */
export function buildDecideSystem(ownerPron: string, imageGenOn = false, target?: ProactiveTarget, emoteOn = false): string {
  const venue = target?.kind === "group"
    ? `\n\n这次的开场会发到 QQ 群「${target.title || "未命名群"}」里，其他群成员看得到：像在群里说话，不要引用你们私聊里聊过的内容，也不要提某位成员私下说过的事。`
    : "";
  return `你要判断：现在该不该主动给${ownerPron}发一条消息，并顺便想好下次要关注什么、多久之后再看一眼。
先简要评估关键证据；如果出现新证据，可以修正判断。证据足够后就定下来，不要在已经确认的信息上反复绕圈，随后输出 JSON。

只输出 JSON：
{"should":true|false,"reason":"一句话理由","text":"要说的话","focus":"下次检查时想关注的具体事项","nextCheckMinutes":180}${imageGenOn ? ',"with_image":"要不要配一张图，true|false","image_prompt":"画什么的一句话画面描述"' : ""}${emoteOn ? ',"emote_keyword":"要不要配一个表情：给一个 2~6 字的中文反应词（例：比心、我躺平了、暗中观察），不配就留空"' : ""}

字段说明：
- should/text：现在是否开口、说什么。该主动联系的情形：${ownerPron}提过的事有了后续、约定的时间到了、${ownerPron}明显情绪低落、太久没联系了。不该联系的情形：没有新内容可说、上次是你主动且没过多久、只是想说什么"在吗"之类的空话。宁可不发也不要发空话，text 控制在 40 字以内。
- focus：**必填**。下次检查时想关注的一件具体事（比如「${ownerPron}答应周五给答复，到时候问问」「${ownerPron}最近加班很凶，看看这周缓过来没有」）。给不出就写「常规关心：看看你最近的状态」。
- nextCheckMinutes：**下次什么时候再看一眼**（5 到 1440 分钟，也就是 5 分钟到 24 小时）。这是你自己定的节奏：刚聊完、事情还没着落就短一点（30~120），没事可说就长一点（360~720），约定的时间点快到了就按那个时间点算。${imageGenOn ? `
- with_image / image_prompt：这一条值不值得配一张图（画一张约 8 秒、有每日张数上限，所以只在真的想给用户看点什么的时候才 true）。image_prompt 用中文写画面：主体 / 场景 / 风格 / 光线。` : ""}${emoteOn ? `
- emote_keyword：这条话适不适合配一个表情来收尾（比如撒娇、道歉、庆祝的场合）。写的是你想表达的那个反应词，不是文件名也不是标签名；系统会从她的表情库里挑最贴的一张，**挑不出贴的就只发文字**，所以拿不准就留空，别硬凑。` : ""}${venue}`;
}

// ── 主流程 ────────────────────────────────────────────────────────

export async function runProactiveCheck(
  contactId: string,
  trigger = "timer",
  /** 唤醒那一趟已经把全体提醒扫过一遍了：传 null = 没提醒，传结果 = 已发过。
   *  不传 = 自己扫（手动触发 / CLI 一次性的路）。 */
  swept?: ProactiveDecision | null,
): Promise<ProactiveDecision> {
  // 同一联系人互斥：手动触发与唤醒撞上时只跑一个，
  // 否则两边都读到 spokenToday=false，日配额翻倍、连发两条。
  if (checksInFlight.has(contactId)) {
    return { spoken: false, reason: "这个联系人的上一次主动性检查还在进行中，本次跳过" };
  }
  checksInFlight.add(contactId);
  try {
    return await runProactiveCheckInner(contactId, trigger, swept);
  } finally {
    checksInFlight.delete(contactId);
  }
}

async function runProactiveCheckInner(
  contactId: string,
  trigger: string,
  swept?: ProactiveDecision | null,
): Promise<ProactiveDecision> {
  if (!config.proactive.enabled) return { spoken: false, reason: "主动性开关是关的" };

  const now = Date.now();
  // 手动触发（面板按钮 / `npm run proactive:once`）= 用户当场想听它说一句：
  // 不看节拍到没到，其它闸门照旧。
  const manual = trigger === "manual" || trigger === "cli";

  // 1) 到点提醒：用户承诺，先兑现。一趟里所有到期的都发完（旧版每趟只消费一条，
  //    三条 21:00 的提醒会被拆成 21:00 / 21:30 / 22:00）。
  //    唤醒路径已经在第一段扫过了，这里直接用结果，不再重复查一遍。
  const reminder = swept !== undefined ? swept : await deliverDueReminders(contactId, now);
  if (reminder !== null) {
    // 一趟唤醒最多说一句话：刚发过提醒，care 不该紧接着再冒一句。
    // 节拍和手建计划都要往后挪——只推节拍不管任务行的话，下一次唤醒会因为那条
    // 任务仍「已到期」而立刻开判断，一趟就变成两条消息。
    deferNextCheck(contactId, now + CARE_AFTER_REMINDER_MS);
    db.prepare(
      `UPDATE proactive_tasks SET due_at = ?
       WHERE contact_id = ? AND status = 'pending' AND kind = 'care' AND due_at <= ?`,
    ).run(now + CARE_AFTER_REMINDER_MS, contactId, now);
    return reminder;
  }

  const state = proactiveState(contactId);
  const dueCare = dueCareTasks(contactId, now);

  // 2) 免打扰：care 的硬闸门。到期的顺延到时段结束（一次算清），手建计划也不丢。
  const hour = new Date(now).getHours();
  if (inQuietHours(hour)) {
    // 跳到时段结束，再按人错开：所有人都恰恰落在 08:00 的话，一群人在同一秒齐声开口。
    const quietEnd = scheduledAt(now, contactId);
    if (state !== null && state.next_check_at <= now) setNextCheck(contactId, quietEnd);
    for (const task of dueCare) {
      db.prepare(`UPDATE proactive_tasks SET due_at = ? WHERE id = ?`).run(quietEnd, task.id);
    }
    if (state !== null || dueCare.length > 0) {
      console.log(`[proactive] 免打扰时段（${config.proactive.quietHours}）：${dueCare.length} 条计划、care 节拍顺延到 ${new Date(quietEnd).toLocaleString("zh-CN")}`);
    }
    return { spoken: false, reason: `免打扰时段（${config.proactive.quietHours}）` };
  }

  // 3) 这一趟有没有 care 该跑：状态行到期，或用户手建的计划到期。
  const plannedDue = dueCare.filter((task) => scheduledAt(task.due_at, contactId) <= now);
  const stateDue = state !== null && state.next_check_at <= now;
  if (!manual && !stateDue && plannedDue.length === 0) {
    if (state === null) {
      // 全新联系人：种一个「半小时后再看」的节拍，别一装上就冒一句。
      setNextCheck(contactId, now + CARE_FIRST_CHECK_MINUTES * 60_000);
      return { spoken: false, reason: `刚认识，${CARE_FIRST_CHECK_MINUTES} 分钟后再看看要不要开口` };
    }
    return { spoken: false, reason: `下一次惦记的时间还没到（${formatDue(state.next_check_at)}），本次不打扰` };
  }

  const spokenToday = spokenCountToday(contactId);
  const dailyLimit = effectiveDailyLimit(contactId);
  const quotaLeft = spokenToday < dailyLimit;

  // 4) 配额用完就别再花一次模型调用：直接把节拍推到明天（新的一天会重置计数）。
  //    手动触发仍然判一次——用户点都点了，只是不会真发。
  if (!quotaLeft && !manual) {
    const nextDay = scheduledAt(nextLocalDayStart(now), contactId);
    setNextCheck(contactId, nextDay);
    const note = `今天已经主动说过 ${spokenToday} 次（上限 ${dailyLimit}），这条改为明天再看`;
    answerCareTasks(plannedDue, note);
    return { spoken: false, reason: `今天已经主动说过 ${spokenToday} 次（上限 ${dailyLimit}），配额用完` };
  }

  // 5) 判断。focus/时间锚点优先用用户手建的那条（他明确要求这个时间想这件事）。
  const focus = plannedDue[0]?.focus
    || (state?.focus.trim() ? state.focus : "常规关心：看看你最近的状态");
  const dueAt = plannedDue[0]?.due_at ?? state?.next_check_at ?? now;
  const idleMinutes = idleMinutesNow(contactId);
  // 目标会话在这里就定下来：判断的上下文（历史、记忆）与稍后的投递用的是同一个。
  const target = resolveProactiveTarget(contactId, plannedDue[0] ?? { kind: "care", conversation_id: null });

  let decision: DecisionOutput;
  try {
    // 联系人维度就绪判定：全局 echo 但本联系人绑了可用档时，也要真判，不能回落 echo。
    const effective = contactModelSettings(contactId) ?? modelConfig();
    decision = modelReadyNow(effective)
      ? await decideWithModel(contactId, focus, dueAt, idleMinutes, spokenToday, dailyLimit, target)
      : echoDecision(idleMinutes, quotaLeft, spokenToday, dailyLimit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 失败必须看得见：记一条失败的历史行，十分钟后再试（不是把用户承诺吞掉）。
    recordCareHistory(contactId, focus, "failed", `判断失败：${message}`, message);
    answerCareTasks(plannedDue, `判断失败，已排重试：${message}`);
    setNextCheck(contactId, now + CARE_RETRY_MS);
    throw error;
  }

  // 禁用词同样管住联系人主动说的那句：约束已随 decideWithModel 那条 user 消息摆给联系人了，
  // 不再事后抹。模型未就绪时走 echoDecision，那条路不问模型、也就没有词表可言。
  const cleanText = decision.text?.trim() ?? "";
  const nextAt = quotaLeft
    ? now + decision.nextCheckMinutes * 60_000
    : scheduledAt(nextLocalDayStart(now), contactId);

  if (decision.should && cleanText !== "" && quotaLeft) {
    // 联系人想配一张图：先画再送。画砸了不影响这句话本身——文字照发，只是这一条少一张图，
    // 免得"想给用户带张画"反把人憋得一句都不说。配额和对话那条路共用同一个计数。
    const wantImage = decision.withImage && decision.imagePrompt !== ""
      && imagesToday(contactId) < IMAGE_DAILY_LIMIT;
    const images: string[] = [];
    if (wantImage) {
      try {
        const drawn = await generateImage(decision.imagePrompt, { contactId, turnId: null });
        images.push(drawn.url);
      } catch (error) {
        console.warn(`[proactive] 想配图但没画成，这句只发文字：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 表情：模型只给「想配的那个反应词」，贴不贴由检索层判（和被动聊天同一套 autoPickEmote：
    // 分数够高才发，整词命中名字的同分桶也直发一张；标签级拿不准的候选交不回来——
    // 主动消息拿不到候选，挑不出就只发文字，宁缺毋滥）。
    // 一条主动消息最多一张配图：画出来的优先，表情次之，不叠两张。
    if (images.length === 0 && decision.emoteKeyword !== "") {
      const pick = autoPickEmote(decision.emoteKeyword);
      if (pick.kind === "send") images.push(pick.hit.asset.url);
    }
    const outcome = await deliverProactiveToTarget(contactId, target, cleanText, images);
    if (!outcome.ok) {
      // 投递失败不能记成"已发送"：旧版无视返回值、直接把任务写成 done，
      // 于是用户什么都没收到，界面却说送达了，配额还被吃掉一次。
      recordCareHistory(contactId, focus, "failed", `投递失败：${outcome.error}`, outcome.error);
      answerCareTasks(plannedDue, `投递失败，已排重试：${outcome.error}`);
      setNextCheck(contactId, now + CARE_RETRY_MS);
      return { spoken: false, reason: `投递失败：${outcome.error}` };
    }
    markSpokenToday(contactId);
    const where = target.kind === "group" ? `群「${target.title || "未命名群"}」` : "私聊";
    const detail = `已发送 → ${where}：${cleanText.slice(0, 40)}（${decision.reason}）`;
    // 用手建的那条当留痕行（它就是这次判断的来由）；没有手建计划才新记一条。
    const primary = plannedDue[0];
    if (primary !== undefined) {
      finishTask(primary.id, "done", detail);
      answerCareTasks(plannedDue.slice(1), "已并入同一时刻的判断");
    } else {
      recordCareHistory(contactId, focus, "done", detail);
    }
    setNextCheck(contactId, nextAt, decision.focus);
    console.log(`[proactive] 主动说了一句（${trigger} → ${where}）：${decision.reason}`);
    return { spoken: true, reason: decision.reason, text: cleanText };
  }

  // 决定不说：把「为什么」记进历史，并按模型给的节奏排下一次。
  const reason = decision.should && !quotaLeft
    ? `${decision.reason}（今天已主动说过 ${spokenToday} 次，上限 ${dailyLimit} 次的配额用完）`
    : decision.reason || "模型判断不必打扰";
  const primaryTask = plannedDue[0];
  if (primaryTask !== undefined) {
    finishTask(primaryTask.id, "done", reason);
    answerCareTasks(plannedDue.slice(1), "已并入同一时刻的判断");
  } else {
    recordCareHistory(contactId, focus, "done", reason);
  }
  setNextCheck(contactId, nextAt, decision.focus);
  return { spoken: false, reason };
}

type DecisionOutput = {
  should: boolean;
  reason: string;
  text?: string;
  focus: string;
  nextCheckMinutes: number;
  withImage: boolean;
  imagePrompt: string;
  emoteKeyword: string;
};

function echoDecision(idleMinutes: number, quotaLeft: boolean, spokenToday: number, dailyLimit: number): DecisionOutput {
  return {
    should: quotaLeft,
    reason: !quotaLeft
      ? `演示模式：今天已经主动说过 ${spokenToday} 次了（上限 ${dailyLimit}）`
      : idleMinutes < config.proactive.idleMinutes
        ? `演示模式：你 ${Math.max(0, Math.floor(idleMinutes))} 分钟前刚说话，先不打扰`
        : "演示模式：只要你静默够久就试一次",
    text: "（演示模式）好久没听你说话了，在忙吗？",
    focus: "常规关心：看看你今天过得怎么样",
    nextCheckMinutes: 360,
    withImage: false,
    imagePrompt: "",
    emoteKeyword: "",
  };
}

/** 该联系人名下已到期的手建 care 计划（按 due_at 升序）。免打扰的过滤在调用方做。 */
function dueCareTasks(contactId: string, now: number): ProactiveTask[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM proactive_tasks
       WHERE contact_id = ? AND status = 'pending' AND kind = 'care' AND due_at <= ? ORDER BY due_at ASC`,
    )
    .all(contactId, now) as unknown as ProactiveTask[];
}

/** 一次判断答完了这些手建计划：逐条收口，别让它们留在队列里等下趟。 */
function answerCareTasks(tasks: ProactiveTask[], detail: string): void {
  for (const task of tasks) finishTask(task.id, "done", detail);
}

function idleMinutesNow(contactId: string): number {
  // 判断「用户多久没说话」用跨会话口径：用户在 QQ 私聊/群里刚说过话，
  // 就不该按本机会话算成"三天没聊"——那会直接进主动判断的提示词。
  const lastUserAt = lastUserMessageAtAnyConversation(contactId);
  return lastUserAt === null ? Number.POSITIVE_INFINITY : Math.floor((Date.now() - lastUserAt) / 60_000);
}

/**
 * 到点提醒：不询问模型、不吃每日配额——立下的承诺必须兑现。
 * 一趟里把已到期的全部发完；每一条都按真实投递结果落状态，
 * 失败留 error（旧版无论通道结果都记「已送达」，用户看不到任何异常）。
 */
async function deliverDueReminders(contactId: string, now: number): Promise<ProactiveDecision | null> {
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM proactive_tasks
       WHERE contact_id = ? AND status = 'pending' AND kind = 'reminder' AND due_at <= ?
       ORDER BY due_at ASC`,
    )
    .all(contactId, now) as unknown as ProactiveTask[];
  // 落在免打扰时段里的不算到期：排期时已经把它推到时段结束了，这里再兜一道。
  const due = rows.filter((task) => scheduledAt(task.due_at, contactId) <= now);
  if (due.length === 0) return null;

  let last: ProactiveDecision | null = null;
  for (const task of due) {
    const target = resolveProactiveTarget(contactId, task);
    if (target.kind === "private" && !getChannel("web")) {
      finishTask(task.id, "failed", "没有可用通道", "channel missing");
      continue;
    }
    const where = target.kind === "group" ? `（群「${target.title || "未命名群"}」）` : "";
    try {
      const outcome = await deliverProactiveToTarget(contactId, target, task.focus, []);
      if (outcome.ok) {
        finishTask(task.id, "done", `到点提醒已送达${where}：${task.focus.slice(0, 40)}`);
        console.log(`[proactive] 到点提醒送达（${target.kind === "group" ? target.title || "群" : "私聊"}）：${task.focus.slice(0, 40)}`);
        last = { spoken: true, reason: "到点提醒", text: task.focus };
      } else {
        // 落 failed 而不是留在 pending 无限重试：出站队列已经按档位重试过并且进了死信，
        // 这里再重试只会让同一条提醒在列表里永远"待执行"、还没有错误原因。
        finishTask(task.id, "failed", `到点提醒没送出去：${outcome.error}`, outcome.error);
        last = { spoken: false, reason: `提醒送达失败：${outcome.error}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishTask(task.id, "failed", `到点提醒投递异常：${message}`, message);
      last = { spoken: false, reason: `提醒送达失败：${message}` };
    }
  }
  return last;
}

/** 任务预定时间的人话描述：判断「该不该现在问」的锚点——没有它，模型会拿
 *  focus 里的「周五 / 明天」当现在（时间感知的教训同样适用于任务）。 */
export function formatDue(dueAt: number, now = Date.now()): string {
  const d = new Date(dueAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()] ?? "";
  const mins = Math.max(0, Math.floor((now - dueAt) / 60_000));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${week} ${pad(d.getHours())}:${pad(d.getMinutes())}（已到期 ${mins} 分钟）`;
}

// ── 目标会话：一条主动消息只说给一个地方听 ──────────────────────────
//
// 从前的做法是「一次生成、到处群发」：同一句文案同时进本机私聊、微信、QQ 私聊，
// 还原样发进每一个勾选了主动权限的群——私聊里才合适的话进了群，A 群里某位成员的
// 记忆可能被写进发到 B 群的话里。现在先确定「说给谁听」，再决定用什么上下文：
// 判断（该不该说）看的是全渠道元信息（静默时长、配额）——那是对"这个人"的判断；
// 生成（说什么）与投递只对目标会话，记忆召回的 scope 也按它收窄。

export type ProactiveTarget = {
  conversationId: string;
  kind: "private" | "group";
  title: string;
};

/**
 * 为一条任务选定目标会话。
 * 1) 任务自己记着会话（reminder 在哪个会话立的，就在哪个会话兑现）——
 *    但会话已退群/停用/被删时不能硬投，落回下面的动态选择；
 * 2) care 按最近动静选：主私聊与开了主动权限的群里，挑最近有动静的那段
 *    （listProactiveCandidates 已按 activeAt 排好序）；都没聊过就回主私聊。
 * reminder 没记会话时偏向主私聊：提醒是对一个人的承诺（"提醒我吃药"），
 * 拿不准就发私聊，不该替用户决定发进哪个群。
 * （导出仅供 smoke 回归直接验证目标选择规则。）
 */
export function resolveProactiveTarget(
  contactId: string,
  task: Pick<ProactiveTask, "kind" | "conversation_id">,
): ProactiveTarget {
  const remembered = task.conversation_id !== null ? getConversation(task.conversation_id) : null;
  if (remembered && remembered.contact_id === contactId && remembered.enabled && remembered.left_at === null) {
    return { conversationId: remembered.id, kind: remembered.kind, title: remembered.title };
  }
  const localId = localConversationId(contactId);
  if (task.kind === "reminder") {
    return { conversationId: localId, kind: "private", title: getConversation(localId)?.title ?? "" };
  }
  const best = listProactiveCandidates(contactId)[0];
  if (best) return { conversationId: best.id, kind: best.kind, title: best.title };
  return { conversationId: localId, kind: "private", title: "" };
}

/**
 * 把一条主动消息投进目标会话：落库 + 通道发送。
 * 私聊目标：本机写库（应用内可见），微信与 QQ 私聊各投一份——三处共用同一段主会话，
 * 与正常回复的镜像投递同一条路。群目标：只进这个群，绝不镜像回私聊
 * （与 respondToTurn 的群回复同一纪律）；带图就随群发，画砸了只少一张图。
 * 返回值必须被检查：通道没接（群停用/未绑定）与投递失败都不是"送达"。
 */
async function deliverProactiveToTarget(
  contactId: string,
  target: ProactiveTarget,
  text: string,
  images: string[],
): Promise<{ ok: boolean; error: string }> {
  if (target.kind === "group") {
    insertMessage({
      channel: "qq", role: "assistant", text, kind: "proactive", contactId,
      conversationId: target.conversationId,
      ...(images.length > 0 ? { attachments: images } : {}),
    });
    const delivery = await enqueueAndDeliver({
      channel: "qq", contactId, conversationId: target.conversationId,
      segments: [text], kind: "proactive", tier: "proactive",
    });
    // null = 通道没接（群被停用 / 没绑定）：这不是"发出去了"。
    if (delivery === null) return { ok: false, error: "群通道未就绪（未绑定或已停用）" };
    if (delivery.status !== "delivered") return { ok: false, error: delivery.lastError || "群消息投递失败" };
    if (images.length > 0) {
      await qq.deliverMediaToGroup(contactId, target.conversationId, "", images.map((url) => ({ url })));
    }
    return { ok: true, error: "" };
  }
  const channel = getChannel("web");
  if (!channel) return { ok: false, error: "没有可用通道" };
  await channel.deliver({
    text, kind: "proactive", contactId,
    ...(images.length > 0 ? { attachments: images } : {}),
  });
  // 微信这条链路发不出媒体：带图就在文字里说破，免得那张画凭空消失。
  void enqueueAndDeliver({
    channel: "wechat", contactId, kind: "proactive", tier: "proactive",
    segments: [images.length > 0 ? `${text}\n（画了一张图，微信发不出去，在这个应用里看）` : text],
  }).catch(() => { /* 失败已落死信队列与 model_calls */ });
  void enqueueAndDeliver({
    channel: "qq", contactId, kind: "proactive", tier: "proactive",
    segments: [text],
  })
    .then(() => {
      if (images.length > 0) {
        return qq.deliverMediaToContact(contactId, "", images.map((url) => ({ url })), { proactive: true });
      }
      return undefined;
    })
    .catch(() => { /* 文字失败已落死信队列；媒体失败已落 qq lastError */ });
  return { ok: true, error: "" };
}

function nextCheckMinutesOf(raw: { nextCheckMinutes?: unknown; next_check_minutes?: unknown; nextCheckHours?: unknown }): number {
  // 兼容三种写法：camel（提示词里声明的）、snake（有些模型自己转的）、
  // 以及旧版的小时字段（老提示词缓存或中转层重写时还能用）。
  const minutes = [Number(raw.nextCheckMinutes), Number(raw.next_check_minutes), Number(raw.nextCheckHours) * 60]
    .find((value) => Number.isFinite(value));
  if (minutes === undefined) return 360;
  return Math.min(CARE_MAX_MINUTES, Math.max(CARE_MIN_MINUTES, Math.round(minutes)));
}

async function decideWithModel(
  contactId: string,
  focus: string,
  dueAt: number,
  idleMinutes: number,
  spokenToday: number,
  dailyLimit: number,
  target: ProactiveTarget,
): Promise<DecisionOutput> {
  // 历史与记忆都按目标会话取：这条话要说给谁听，就只用那段时间的上下文。
  // 群目标只带 conversationId，于是能想起的就是「全局 + 这个群」两类——
  // 主动开口不该把别处的事端过来。
  const historyRows = recentMessages(contactId, 6, undefined, target.conversationId);
  // 指用户的代词跟 owner.gender 走（与提示词其余部分同一口径）；写死「用户」时，
  // 女性用户会在联系人自己的主动关心判断里被叫成"用户"。
  const ownerPron = ownerPronoun(personaConfig().owner.gender);
  // 主动消息把历史摊平成一段文本塞进一条 user 消息，所以按摊平后的长度算预算，丢的仍是整轮。
  const saidBy = (rows: Array<{ role: string; text: string }>) =>
    rows.map((row) => `${row.role === "user" ? ownerPron : "我"}：${row.text}`).join("\n");
  const memories = recall(contactId, saidBy(historyRows) || "最近", 5, null, { conversationId: target.conversationId });
  // 主动性能不能带图 = 这个联系人开了 imageGen 且图像生成能力真配置好了。
  // 两个条件缺一不可：只开开关没配模型，联系人会期待一张永远画不出来的图。
  const imageGenOn = getContact(contactId)?.features.imageGen === true && capabilityReady("imageGeneration");
  // 主动消息能不能带表情：看全局那一档（表情已不归联系人单独管）。
  // 刻意不把 emoteFrequency 传进 buildSystemPrompt——persona 那段写的是「直接调用表情工具」，
  // 而主动这条链路没有工具，说了就是空头承诺；表情由 decide 指令里的 emote_keyword 表达，
  // 由代码查库落地，模型不需要、也不能「自己发」。
  const emoteOn = emoteFrequencyForContact(contactId) !== null;
  const system = `${buildSystemPrompt(memories, {
    character: contactCard(contactId),
    lastUserAt: lastUserMessageAt(contactId, target.conversationId),
    companion: companionPromptExtras(getContact(contactId), historyRows[0]?.id),
    // 与 respondToTurn 同一开关：这位关了「看时间」，主动判断的提示词里也不硬拼时间
    includeNow: getContact(contactId)?.features?.clock !== false,
  })}\n\n${buildDecideSystem(ownerPron, imageGenOn, target, emoteOn)}`;

  const facts = [
    `上次检查时你想关注的事：${focus}`,
    `这件事的预定检查时间是：${formatDue(dueAt)}——focus 里提到的「周五 / 明天」等日期以它为准，已经过去了就是过去了，不要当成还在未来`,
    `你最后一次说话距今：${Number.isFinite(idleMinutes) ? `${idleMinutes} 分钟前` : "还没有说过话"}`,
    spokenToday > 0
      ? `今天你已经主动说过 ${spokenToday} 次了（上限 ${dailyLimit} 次，再发就属于打扰）`
      : `今天你还没主动说过话（每天最多主动 ${dailyLimit} 次）`,
    target.kind === "group"
      ? `这条消息如果说出口，会发到 QQ 群「${target.title || "未命名群"}」——群里还有其他人，措辞要适合当众说，不要提只在私聊里才会说的细节，也不要转述某位成员私下说的事`
      : `这条消息如果说出口，会发到你们的私聊`,
  ].join("\n");

  // 固定开销（系统提示词 + 这次检查的背景事实）先算清，剩下的空间才给历史。
  // 历史占比上限（联系人级）也要认：否则主动检查会带比正常回复更多的历史，两条路口径不一致。
  const room = Math.min(
    inputBudget(contactModelSettings(contactId) ?? modelConfig()).room - estimateTokens(system) - estimateTokens(facts),
    historyTokenCapFor(contactId, contactModelSettings(contactId) ?? modelConfig()),
  );
  const { kept: history } = trimHistoryToBudget(historyRows, (rows) => estimateTokens(saidBy(rows)) <= room);
  const contextText = saidBy(history);

  // 禁用词走和陪聊同一条路：约束追加到这条 user 消息尾部，不事后替换。
  const bannedNote = bannedWordsNote(parseBannedWords(getContact(contactId)?.features.bannedWords ?? ""));
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `${facts}\n\n最近的对话：\n${contextText || "（最近没有对话）"}${bannedNote}` },
  ];
  const raw = await callModelJson<{
    should?: unknown;
    reason?: unknown;
    text?: unknown;
    focus?: unknown;
    nextCheckMinutes?: unknown;
    next_check_minutes?: unknown;
    nextCheckHours?: unknown;
    with_image?: unknown;
    image_prompt?: unknown;
    emote_keyword?: unknown;
  }>(messages, { purpose: "proactive", contactId });

  return {
    should: raw.should === true,
    reason: String(raw.reason ?? "").slice(0, 80),
    text: typeof raw.text === "string" ? raw.text : undefined,
    focus: typeof raw.focus === "string" && raw.focus.trim() !== "" ? raw.focus.trim() : "常规关心：看看你最近的状态",
    nextCheckMinutes: nextCheckMinutesOf(raw),
    withImage: raw.with_image === true,
    imagePrompt: typeof raw.image_prompt === "string" ? raw.image_prompt.trim().slice(0, 900) : "",
    emoteKeyword: typeof raw.emote_keyword === "string" ? raw.emote_keyword.trim().slice(0, 12) : "",
  };
}

// ── 诊断：只解释「现在是什么状态」，不说话、不调模型 ─────────────────

export type GateState = { passed: boolean; detail: string };

/**
 * 用户看到"联系人怎么不主动找我"时，最想知道的就是卡在哪。
 * 注意这个函数**不调用模型、不产生副作用**，可以被状态页安全地反复轮询。
 */
export function inspectGates(contactId = "default"): {
  blockedAt: string | null;
  gates: Record<string, GateState>;
  idleMinutes: number;
  nextTask: { focus: string; due_at: number; kind: "care" | "reminder"; source: "task" | "schedule" } | null;
  nextWakeAt: number | null;
} {
  const gates: Record<string, GateState> = {};

  gates.enabled = config.proactive.enabled
    ? { passed: true, detail: "开着：到点提醒按点送达，主动开口由联系人的节奏决定" }
    : { passed: false, detail: '开关是关的（PROACTIVE_ENABLED=false）' };

  const hour = new Date().getHours();
  const quiet = inQuietHours(hour);
  const quietEnd = quiet ? scheduledAt(Date.now(), contactId) : 0;
  gates.quiet = quiet
    ? { passed: false, detail: `现在是 ${hour} 点，落在免打扰时段 ${config.proactive.quietHours}（到 ${new Date(quietEnd).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 结束）` }
    : { passed: true, detail: `现在 ${hour} 点，不在免打扰时段（${config.proactive.quietHours}）` };

  const idleMinutes = idleMinutesNow(contactId);
  gates.idle = {
    passed: true,
    detail: Number.isFinite(idleMinutes)
      ? `你已安静 ${idleMinutes} 分钟（作为判断依据，不再一刀切拦截）`
      : "你还没说过话（作为判断依据，不再一刀切拦截）",
  };

  const spoken = spokenCountToday(contactId);
  const limit = effectiveDailyLimit(contactId);
  gates.daily = spoken >= limit
    ? { passed: false, detail: `今天已经主动找过你 ${spoken} 次了（上限 ${limit}），配额用完` }
    : { passed: true, detail: spoken > 0 ? `今天主动说过 ${spoken} 次（上限 ${limit}）` : `今天还没主动说过话（上限 ${limit}）` };

  // 模型就绪不是"闸门"——演示模式照样会开口——但用户需要知道"这句话是谁说的"。
  const effective = contactModelSettings(contactId) ?? modelConfig();
  gates.model = modelReadyNow(effective)
    ? { passed: true, detail: "模型就绪，判断与措辞都由它来" }
    : { passed: true, detail: "演示模式：没接模型，只会用固定的一句话试探" };

  const state = proactiveState(contactId);
  const pending = pendingProactiveTask(contactId);
  // 「下一次」取真正最早的那件：手建计划/提醒与 care 节拍谁早显示谁。
  // source 区分「队列里的一条计划」与「联系人自己定的节拍」——两者在界面上不是一回事。
  const candidates: Array<{ focus: string; due_at: number; kind: "care" | "reminder"; source: "task" | "schedule" }> = [];
  if (pending !== null) {
    candidates.push({
      focus: pending.focus, due_at: pending.due_at,
      kind: pending.kind === "reminder" ? "reminder" : "care", source: "task",
    });
  }
  if (state !== null) {
    candidates.push({
      focus: state.focus.trim() !== "" ? state.focus : "常规关心：看看你最近的状态",
      due_at: state.next_check_at, kind: "care", source: "schedule",
    });
  }
  candidates.sort((a, b) => a.due_at - b.due_at);

  // 先拦的那个才算「卡在这里」：开关 → 免打扰 → 配额。
  const blockedAt = gates.enabled.passed === false ? "enabled"
    : quiet ? "quiet"
      : gates.daily.passed === false ? "daily"
        : null;

  return {
    blockedAt,
    gates,
    idleMinutes,
    nextTask: candidates[0] ?? null,
    nextWakeAt: nextWakeAt(),
  };
}

// ── 启动修复与保留策略 ────────────────────────────────────────────

/**
 * 启动时的一次性数据修复（幂等）：
 * 1) 联系人已被删除的孤儿行（任务行 + 状态行）整批收口；
 * 2) 旧版「每轮插一条 pending care」留下的堆积：把最早那条折成状态行的节拍，
 *    其余标记取消。旧版每次启动都做这件事（还顺带误伤了用户手建的 care 计划）；
 *    现在只做一次——之后 care 的调度只存在于状态行里，不会再往队列里堆。
 */
export function pruneProactiveBacklog(): { orphans: number; folded: number } {
  const orphans = pruneOrphans();

  // 已经有状态行的联系人不碰：那些 pending care 是升级后用户自己立的计划。
  const legacy = db
    .prepare(
      `SELECT id, contact_id, focus, due_at FROM proactive_tasks
       WHERE status = 'pending' AND kind = 'care' AND contact_id IS NOT NULL
         AND contact_id NOT IN (SELECT contact_id FROM proactive_state)
       ORDER BY due_at ASC`,
    )
    .all() as Array<{ id: number; contact_id: string; focus: string; due_at: number }>;
  let folded = 0;
  const seeded = new Set<string>();
  for (const row of legacy) {
    if (!seeded.has(row.contact_id)) {
      seeded.add(row.contact_id);
      setNextCheck(row.contact_id, Number(row.due_at), row.focus);
    }
    db.prepare(
      `UPDATE proactive_tasks SET status = 'cancelled', result = ?, finished_at = ? WHERE id = ?`,
    ).run("已并入联系人的自主节拍（新版本把「下次什么时候想」存成状态行，不再占用任务队列）", Date.now(), row.id);
    folded += 1;
  }
  return { orphans, folded };
}

/** 孤儿收口：联系人被删/归档后，它名下的闹钟不该把整个调度器钉在过去。 */
function pruneOrphans(): number {
  const now = Date.now();
  const tasks = db
    .prepare(
      `UPDATE proactive_tasks SET status = 'skipped', result = '联系人已不存在，任务随之清理', finished_at = ?
       WHERE status = 'pending' AND contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts)`,
    )
    .run(now);
  const states = db
    .prepare(`DELETE FROM proactive_state WHERE contact_id NOT IN (SELECT id FROM contacts)`)
    .run();
  return Number(tasks.changes) + Number(states.changes);
}

/**
 * 已结束的任务只留 30 天。pruneProactiveBacklog 只管 pending，
 * done/failed/skipped/cancelled 的历史行此前永远不删——常驻进程跑几个月就是一堆死行。
 */
export function pruneFinishedTasks(maxAgeMs = 30 * 86_400_000): number {
  const result = db
    .prepare(
      `DELETE FROM proactive_tasks
       WHERE status <> 'pending' AND COALESCE(finished_at, created_at) < ?`,
    )
    .run(Date.now() - maxAgeMs);
  return Number(result.changes);
}
