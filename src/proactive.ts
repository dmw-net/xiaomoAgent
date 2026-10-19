// 主动性：陪伴产品的核心卖点——不是"你问我答"，而是"它觉得该出现了就出现"。
//
// 任务化（2026-09-16，借鉴参考项目）：
// 之前的模式是「每 30 分钟到点、从零想一次该不该联系」——无状态、每次判断都是凭空的。
// 现在改成任务化模式：**判断一次，带着具体观察落成一条定时任务，到点执行、执行留痕**。
//   - 判断时模型顺手产出「下次想关注的点」（focus），比如「他答应周五给答复，明天问问」；
//   - focus 连同到期时间写进 proactive_tasks 表；
//   - 到期后检查器拿 focus 作为「这次重点关注什么」再判断；
//   - 每次执行都留痕（说了什么/为什么没说/失败原因），状态页可查。
// 于是「她怎么突然找我」变成一个可以回答的问题：看一眼任务就知道她惦记着什么。
//
// 多联系人（2026-09-17）：每个联系人独立一套任务与「今天是否已说过」的配额——
// 跟 A 聊过天，不代表 B 今天也被关心过。循环对每个未归档联系人各跑一遍检查。
//
// 闸门的变化：免打扰时段仍是硬闸门（顺延任务）；开关也是。
// 「静默时长」和「每日一次」从硬闸门改为**判断依据**注入提示词——
// 因为判断本身就该考虑这些（"他刚说过话，那这次可能不该发"），
// 由闸门一刀切反而让模型失去了表达「我惦记着他但知道现在不该说」的机会。

import { config, inQuietHours } from "./config.ts";
import { wechat } from "./wechat.ts";
import { qq } from "./qq.ts";
import { capabilityReady, modelConfig, modelReadyNow, personaConfig } from "./settings.ts";
import { db, kvGet, kvSet } from "./db.ts";
import { callModelJson, contactModelSettings, generateImage, IMAGE_DAILY_LIMIT, imagesToday } from "./model.ts";
import { estimateTokens, historyTokenCapFor, inputBudget, lastUserMessageAt, recentMessages, trimHistoryToBudget } from "./agent.ts";
import { recall } from "./memory.ts";
import { buildSystemPrompt, ownerPronoun } from "./persona.ts";
import { companionPromptExtras, contactCard, DEFAULT_CONTACT_ID, getContact, listContacts } from "./contacts.ts";
import { bannedWordsNote, parseBannedWords } from "./banned-words.ts";
import { isAssistant } from "./assistant.ts";
import { maybeRunConsolidation } from "./consolidate.ts";
import { getChannel } from "./channels/types.ts";
import type { ChatMessage } from "./model.ts";

export type ProactiveDecision = {
  spoken: boolean;
  reason: string;
  text?: string;
};

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

/**
 * 免打扰顺延的步长与上限：每次顺延 30 分钟，累计 12 次（约 6 小时）后放弃并说明。
 *
 * ⚠️ 这个上限**只对 care 生效**。默认 QUIET_HOURS=23-8 是 9 小时，比 6 小时的顺延额度长——
 * 从前不过滤 kind，于是 22:00 立的 23:30 提醒会在约 04:30 被标成 skipped「放弃本次」，
 * 用户等到早上什么都没有。reminder 是「到点必达」的用户承诺（schedule_reminder 的契约），
 *  quiet hours 只该**顺延**它，不该吞掉它。
 */
const POSTPONE_STEP_MS = 30 * 60_000;
const POSTPONE_MAX = 12;
/** reminder 被顺延这么多次（≈12 小时）就喊一声：quiet hours 配成一整天时它得看得见。 */
const POSTPONE_WARN_AT = 24;

export type ProactiveTask = {
  id: number;
  contact_id: string | null;
  focus: string;
  /** care = 到点后模型判断该不该说；reminder = 到点必达的提醒（schedule_reminder 立下的）。 */
  kind: "care" | "reminder";
  due_at: number;
  status: "pending" | "done" | "failed" | "skipped" | "cancelled";
  postpone_count: number;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
};

const TASK_COLUMNS = "id, contact_id, focus, kind, due_at, status, postpone_count, result, error, created_at, finished_at";

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

function insertTask(contactId: string, focus: string, dueAt: number, kind: ProactiveTask["kind"] = "care"): ProactiveTask {
  const createdAt = Date.now();
  const result = db.prepare(
    `INSERT INTO proactive_tasks (contact_id, focus, due_at, kind, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(contactId, focus, dueAt, kind, createdAt);
  return {
    id: Number(result.lastInsertRowid),
    contact_id: contactId, focus, kind, due_at: dueAt, status: "pending",
    postpone_count: 0, result: null, error: null,
    // 回读也要给真实的建立时刻：从前这里返回 dueAt，于是「刚立的一条」在界面上
    // 显示成建在未来（立一个明晚的提醒，创建时间就是明晚）。
    created_at: createdAt, finished_at: null,
  };
}

/**
 * 一轮里最多立几条提醒。
 *
 * 模型一次回复可能带多个 tool_calls（`schedule_reminder` 也在内），轮数上限又是 8——
 * 不设这道闸就是一轮 8 条到点推送。而 reminder 是「到点必达、不吃每日主动配额」的，
 * 配额那边拦不住它，只能在这儿按轮数挡。
 */
export const REMINDERS_PER_TURN = 2;
/** 这一轮已经立了几条提醒（进程内计数；turnId 为空 = 手动创建，不拦）。 */
const remindersThisTurn = new Map<string, number>();

/** 判断这一轮还能不能再立一条提醒；能就占一个额度。 */
export function takeReminderSlot(turnId: string | null): boolean {
  if (!turnId) return true;
  const used = remindersThisTurn.get(turnId) ?? 0;
  if (used >= REMINDERS_PER_TURN) return false;
  remindersThisTurn.set(turnId, used + 1);
  // 别让这张表跟着 turnId 无限长：一轮结束就不会再有人来取，超过一屏就整体丢掉最早的。
  if (remindersThisTurn.size > 256) {
    for (const key of [...remindersThisTurn.keys()].slice(0, 128)) remindersThisTurn.delete(key);
  }
  return true;
}

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
  return true;
}

/** 用户自己在「主动性」面板上立一条计划。两种语义（界面必须讲清，因为代价不同）：
 *  - care：到点拿 focus 去问模型「该不该说」——她会改写成一句自然的话，也可能决定不说，吃每日配额；
 *  - reminder：到点把 focus **原样**发出去，不问模型、不吃配额（承诺必须兑现）。
 *  到点不等于立刻：真正的发送落在下一次检查（默认每 PROACTIVE_INTERVAL_MINUTES 分钟一趟），
 *  落在免打扰时段会顺延。 */
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
    throw new Error("时间要在未来（想立刻看她说什么，用「立即检查主动性」）");
  }
  return insertTask(contactId, focus, dueAt, kind);
}

/** 撤销一次取消：只有被手动取消的那条能放回待执行，其余状态一律不动。
 *  放回去之后到期照常被检查链拾起——用户点「撤销」要的就是这个效果。 */
export function restoreProactiveTask(id: number, contactId?: string): boolean {
  // 先按 id + 状态锁定，再补一道户主判断（UPDATE 的 WHERE 里不便带 OR，
  // 因为 contact_id 为 NULL 的存量行要按 default 认）。
  const row = db.prepare(`SELECT contact_id FROM proactive_tasks WHERE id = ? AND status = 'cancelled'`)
    .get(id) as { contact_id: string | null } | undefined;
  if (!row) return false;
  if (contactId !== undefined && (row.contact_id ?? DEFAULT_CONTACT_ID) !== contactId) return false;
  const changed = db.prepare(
    `UPDATE proactive_tasks SET status = 'pending', result = NULL, error = NULL, finished_at = ?
     WHERE id = ? AND status = 'cancelled'`,
  ).run(null, id);
  return changed.changes > 0;
}

/** 主动性判断指令：ownerPron = 用户的代词（owner.gender），全文一致。
 *  imageGenOn 决定要不要向模型声明 with_image 这个字段——没开就不声明，
 *  和工具侧「不声明的工具模型调不到」同一套口径。 */
export function buildDecideSystem(ownerPron: string, imageGenOn = false): string {
  return `你要判断：现在该不该主动给${ownerPron}发一条消息，并顺便想好下次要关注什么。

只输出 JSON：
{"should":true|false,"reason":"一句话理由","text":"要说的话","focus":"下次检查时想关注的具体事项","nextCheckHours":6}${imageGenOn ? ',"with_image":"要不要配一张图，true|false","image_prompt":"画什么的一句话画面描述"' : ""}

字段说明：
- should/text：现在是否开口、说什么。该主动联系的情形：${ownerPron}提过的事有了后续、约定的时间到了、${ownerPron}明显情绪低落、太久没联系了。不该联系的情形：没有新内容可说、上次是你主动且没过多久、只是想说什么"在吗"之类的空话。宁可不发也不要发空话，text 控制在 40 字以内。
- focus：**必填**。下次检查时想关注的一件具体事（比如「${ownerPron}答应周五给答复，到时候问问」「${ownerPron}最近加班很凶，看看这周缓过来没有」）。给不出就写「常规关心：看看你最近的状态」。
- nextCheckHours：下次检查放在几小时后（1 到 24 的整数）。接近约定时间就设小一点，没有明确节点就 6-12。${imageGenOn ? `
- with_image / image_prompt：这一条值不值得配一张图（画一张约 8 秒、有每日张数上限，所以只在真的想给他看点什么的时候才 true）。image_prompt 用中文写画面：主体 / 场景 / 风格 / 光线。` : ""}`;
}

export async function runProactiveCheck(
  contactId: string,
  trigger = "timer",
): Promise<ProactiveDecision> {
  // 同一联系人互斥：手动触发与定时器撞上时只跑一个，
  // 否则两边都读到 spokenToday=false，日配额翻倍、连发两条。
  if (checksInFlight.has(contactId)) {
    return { spoken: false, reason: "这个联系人的上一次主动性检查还在进行中，本次跳过" };
  }
  checksInFlight.add(contactId);
  try {
    return await runProactiveCheckInner(contactId, trigger);
  } finally {
    checksInFlight.delete(contactId);
  }
}

const checksInFlight = new Set<string>();

async function runProactiveCheckInner(
  contactId: string,
  trigger: string,
): Promise<ProactiveDecision> {
  if (!config.proactive.enabled) return { spoken: false, reason: "主动性开关是关的" };

  // 免打扰时段：硬闸门。到期的任务顺延而不是丢弃——她惦记的事不该因为时间点不好就丢了。
  const hour = new Date().getHours();
  if (inQuietHours(hour)) {
    postponeDueTasks(contactId, `落在免打扰时段（${config.proactive.quietHours}）`);
    return { spoken: false, reason: `免打扰时段（${config.proactive.quietHours}）` };
  }

  // 取该联系人最早到期的任务。没有到期任务时：
  //   - 若有排在未来的 pending（她清楚自己惦记什么、到什么时候）→ 本次直接跳过。
  //     旧逻辑在这里「新建一条立即到期再消费」，每 tick 净增一条 pending，任务无限堆积。
  //   - 只有完全没有 pending（首次启动/任务被取消后）才建一条兜底。
  let task = dueTask(contactId);

  // 到点提醒（reminder）：不询问模型、不吃每日配额——立下的承诺必须兑现，
  // 免打扰时段已经在上面的硬闸门里顺延过了。
  if (task?.kind === "reminder") {
    const channel = getChannel("web");
    if (!channel) {
      finishTask(task.id, "failed", "没有可用通道", "channel missing");
      return { spoken: false, reason: "提醒送达失败：没有可用通道" };
    }
    await channel.deliver({ text: task.focus, kind: "proactive", contactId });
    void wechat.deliverToContact(contactId, task.focus, { proactive: true });
    void qq.deliverToContact(contactId, task.focus, { proactive: true });
    finishTask(task.id, "done", `到点提醒已送达：${task.focus.slice(0, 40)}`);
    console.log(`[proactive] 到点提醒送达（${trigger}）：${task.focus.slice(0, 40)}`);
    return { spoken: true, reason: "到点提醒", text: task.focus };
  }

  if (!task) {
    const upcoming = pendingProactiveTask(contactId);
    if (upcoming) {
      return { spoken: false, reason: `下一次惦记的时间还没到（${formatDue(upcoming.due_at)}），本次不打扰` };
    }
    task = insertTask(contactId, "常规关心：看看你最近的状态", Date.now());
  }

  const idleMinutes = idleMinutesNow(contactId);
  const spokenToday = spokenCountToday(contactId);
  const dailyLimit = effectiveDailyLimit(contactId);
  const quotaLeft = spokenToday < dailyLimit;

  let decision: DecisionOutput;
  try {
    // 联系人维度就绪判定：全局 echo 但本联系人绑了可用档时，也要真判，不能回落 echo。
    const effective = contactModelSettings(contactId) ?? modelConfig();
    decision = modelReadyNow(effective)
      ? await decideWithModel(contactId, task.focus, task.due_at, idleMinutes, spokenToday, dailyLimit)
      : echoDecision(idleMinutes, quotaLeft, spokenToday, dailyLimit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishTask(task.id, "failed", `判断失败：${message}`, message);
    // 失败必须看得见，否则用户只会觉得"她变冷了"。
    throw error;
  }

  // 禁用词同样管住她主动说的那句：约束已随 decideWithModel 那条 user 消息摆给她了，
  // 不再事后抹。模型未就绪时走 echoDecision，那条路不问模型、也就没有词表可言。
  const cleanText = decision.text?.trim() ?? "";

  if (decision.should && cleanText !== "" && quotaLeft) {
    const channel = getChannel("web");
    if (!channel) {
      finishTask(task.id, "failed", "没有可用通道", "channel missing");
      return { spoken: false, reason: "没有可用通道" };
    }
    // 她想配一张图：先画再送。画砸了不影响这句话本身——文字照发，只是这一条少一张图，
    // 免得"想给他带张画"反把人憋得一句都不说。配额和对话那条路共用同一个计数。
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
    await channel.deliver({
      text: cleanText, kind: "proactive", contactId,
      ...(images.length > 0 ? { attachments: images } : {}),
    });
    // 绑定过微信且允许主动触达的联系人，同一句投到微信（内部静默跳过/不抛错）。
    // 带图就在文字里说破：微信那条链路发不出媒体，不说她等于凭空消失了这张画。
    void wechat.deliverToContact(
      contactId,
      images.length > 0 ? `${cleanText}\n（画了一张图，微信发不出去，在这个应用里看）` : cleanText,
      { proactive: true },
    );
    void qq.deliverToContact(
      contactId,
      images.length > 0 ? `${cleanText}\n（画了一张图，QQ 这条只送文字，在这个应用里看）` : cleanText,
      { proactive: true },
    );
    markSpokenToday(contactId);
    finishTask(task.id, "done", `已发送：${cleanText.slice(0, 40)}（${decision.reason}）`);
    scheduleNext(contactId, decision.focus, decision.nextCheckHours);
    console.log(`[proactive] 主动说了一句（${trigger}）：${decision.reason}`);
    return { spoken: true, reason: decision.reason, text: cleanText };
  }

  // 决定不说：把「为什么」记进任务，并按模型给的节奏排下一次。
  const reason = decision.should && !quotaLeft
    ? `${decision.reason}（今天已主动说过 ${spokenToday} 次，上限 ${dailyLimit} 次的配额用完）`
    : decision.reason || "模型判断不必打扰";
  finishTask(task.id, "done", reason);
  scheduleNext(contactId, decision.focus, decision.nextCheckHours);
  return { spoken: false, reason };
}

type DecisionOutput = { should: boolean; reason: string; text?: string; focus: string; nextCheckHours: number; withImage: boolean; imagePrompt: string };

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
    nextCheckHours: 6,
    withImage: false,
    imagePrompt: "",
  };
}

function dueTask(contactId: string): ProactiveTask | null {
  const row = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM proactive_tasks
       WHERE contact_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT 1`,
    )
    .get(contactId, Date.now()) as ProactiveTask | undefined;
  return row ?? null;
}

function idleMinutesNow(contactId: string): number {
  const lastUserAt = lastUserMessageAt(contactId);
  return lastUserAt === null ? Number.POSITIVE_INFINITY : Math.floor((Date.now() - lastUserAt) / 60_000);
}

/** 免打扰时段：把到期的任务顺延，攒多了就放弃（说明这天实在没有开口的时机）。
 *  reminder 不走「放弃」那条路——见 POSTPONE_MAX 上方的说明。 */
function postponeDueTasks(contactId: string, reason: string): void {
  const rows = db
    .prepare(`SELECT id, kind, postpone_count FROM proactive_tasks WHERE contact_id = ? AND status = 'pending' AND due_at <= ?`)
    .all(contactId, Date.now()) as Array<{ id: number; kind: string; postpone_count: number }>;
  for (const row of rows) {
    const next = row.postpone_count + 1;
    if (row.kind !== "reminder" && next >= POSTPONE_MAX) {
      finishTask(row.id, "skipped", `${reason}；已顺延 ${row.postpone_count} 次仍无时机，放弃本次`);
      continue;
    }
    if (row.kind === "reminder" && next >= POSTPONE_WARN_AT) {
      // 不丢，但必须响一声：正常 9 小时免打扰最多顺延 18 次，走到 24 次说明时段配成一整天了
      console.warn(`[proactive] 提醒 #${row.id} 已顺延 ${row.postpone_count} 次仍未送出——免打扰时段是不是配太长了？（${config.proactive.quietHours}）`);
    }
    db.prepare(`UPDATE proactive_tasks SET due_at = ?, postpone_count = ? WHERE id = ?`)
      .run(Date.now() + POSTPONE_STEP_MS, next, row.id);
  }
}

/** 单联系人 pending 上限：防御任何逻辑回归再次造成无限堆积。 */
const PENDING_CAP = 8;

/** 按模型给的节奏排下一次检查；focus 空则给默认值。 */
function scheduleNext(contactId: string, focus: string, nextCheckHours: number): void {
  const hours = Number.isFinite(nextCheckHours) ? Math.min(24, Math.max(1, Math.round(nextCheckHours))) : 6;
  const cleanFocus = focus.trim() || "常规关心：看看你最近的状态";
  // 接近上限时先取消最早排期的，pending 永远不无限增长。
  // 只淘汰 care：reminder 是"到点必达"的用户承诺（明晚九点提醒吃药），
  // 而它按 due_at ASC 恰好排在最前面——不过滤 kind 就会最先被当成堆积垃圾清掉。
  const pending = db
    .prepare(`SELECT id FROM proactive_tasks WHERE contact_id = ? AND status = 'pending' AND kind = 'care' ORDER BY due_at ASC`)
    .all(contactId) as unknown as Array<{ id: number }>;
  const excess = pending.length - (PENDING_CAP - 1);
  if (excess > 0) {
    const ids = pending.slice(0, excess).map((p) => p.id);
    db.prepare(
      `UPDATE proactive_tasks SET status = 'skipped', result = '待执行任务堆积过多，这条被自动清理', finished_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(Date.now(), ...ids);
  }
  insertTask(contactId, cleanFocus.slice(0, 200), Date.now() + hours * 3_600_000);
}

/**
 * 启动时的一次性数据修复（幂等）：
 * 1) 联系人已被删除的孤儿 pending 任务（历史上出过 contact_id='timer'）整批改状态；
 * 2) 旧版「每 tick 新建并消费」留下的堆积：每联系人只保留最早到期的一条 pending，其余取消。
 */
export function pruneProactiveBacklog(): { orphans: number; deduped: number } {
  const orphans = db
    .prepare(
      `UPDATE proactive_tasks SET status = 'skipped', result = '联系人已不存在，任务随之清理', finished_at = ?
       WHERE status = 'pending' AND contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts)`,
    )
    .run(Date.now());
  const deduped = db
    .prepare(
      `UPDATE proactive_tasks SET status = 'cancelled', result = '旧版本任务堆积，已自动并入最早的一条', finished_at = ?
       WHERE status = 'pending' AND kind = 'care' AND EXISTS (
         SELECT 1 FROM proactive_tasks x
         WHERE x.status = 'pending' AND x.kind = 'care' AND x.contact_id = proactive_tasks.contact_id
           AND (x.due_at < proactive_tasks.due_at OR (x.due_at = proactive_tasks.due_at AND x.id < proactive_tasks.id))
       )`,
    )
    .run(Date.now());
  return { orphans: Number(orphans.changes), deduped: Number(deduped.changes) };
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

/** 任务预定时间的人话描述：判断「该不该现在问」的锚点——没有它，模型会拿
 *  focus 里的「周五 / 明天」当现在（时间感知的教训同样适用于任务）。 */
export function formatDue(dueAt: number, now = Date.now()): string {
  const d = new Date(dueAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()] ?? "";
  const mins = Math.max(0, Math.floor((now - dueAt) / 60_000));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${week} ${pad(d.getHours())}:${pad(d.getMinutes())}（已到期 ${mins} 分钟）`;
}

async function decideWithModel(
  contactId: string,
  focus: string,
  dueAt: number,
  idleMinutes: number,
  spokenToday: number,
  dailyLimit: number,
): Promise<DecisionOutput> {
  const historyRows = recentMessages(contactId, 6);
  // 指用户的代词跟 owner.gender 走（与提示词其余部分同一口径）；写死「他」时，
  // 女性用户会在她自己的主动关心判断里被叫成"他"。
  const ownerPron = ownerPronoun(personaConfig().owner.gender);
  // 主动消息把历史摊平成一段文本塞进一条 user 消息，所以按摊平后的长度算预算，丢的仍是整轮。
  const saidBy = (rows: Array<{ role: string; text: string }>) =>
    rows.map((row) => `${row.role === "user" ? ownerPron : "我"}：${row.text}`).join("\n");
  const memories = recall(contactId, saidBy(historyRows) || "最近", 5);
  // 主动性能不能带图 = 这个联系人开了 imageGen 且图像生成能力真配置好了。
  // 两个条件缺一不可：只开开关没配模型，她会期待一张永远画不出来的图。
  const imageGenOn = getContact(contactId)?.features.imageGen === true && capabilityReady("imageGeneration");
  const system = `${buildSystemPrompt(memories, {
    character: contactCard(contactId),
    lastUserAt: lastUserMessageAt(contactId),
    companion: companionPromptExtras(getContact(contactId), historyRows[0]?.id),
  })}\n\n${buildDecideSystem(ownerPron, imageGenOn)}`;

  const facts = [
    `上次检查时你想关注的事：${focus}`,
    `这件事的预定检查时间是：${formatDue(dueAt)}——focus 里提到的「周五 / 明天」等日期以它为准，已经过去了就是过去了，不要当成还在未来`,
    `你最后一次说话距今：${Number.isFinite(idleMinutes) ? `${idleMinutes} 分钟前` : "还没有说过话"}`,
    spokenToday > 0
      ? `今天你已经主动说过 ${spokenToday} 次了（上限 ${dailyLimit} 次，再发就属于打扰）`
      : `今天你还没主动说过话（每天最多主动 ${dailyLimit} 次）`,
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
    nextCheckHours?: unknown;
    with_image?: unknown;
    image_prompt?: unknown;
  }>(messages, { purpose: "proactive", maxTokens: 400, contactId });

  const hoursRaw = Number(raw.nextCheckHours);
  return {
    should: raw.should === true,
    reason: String(raw.reason ?? "").slice(0, 80),
    text: typeof raw.text === "string" ? raw.text : undefined,
    focus: typeof raw.focus === "string" && raw.focus.trim() !== "" ? raw.focus.trim() : "常规关心：看看你最近的状态",
    nextCheckHours: Number.isFinite(hoursRaw) ? hoursRaw : 6,
    withImage: raw.with_image === true,
    imagePrompt: typeof raw.image_prompt === "string" ? raw.image_prompt.trim().slice(0, 900) : "",
  };
}

/**
 * 只解释「现在检查是什么状态」，不真的说话。
 * 用户看到"她怎么不主动找我"时，最想知道的就是卡在哪。
 * 注意这个函数**不调用模型、不产生副作用**，可以被状态页安全地反复轮询。
 */
export type GateState = { passed: boolean; detail: string };

export function inspectGates(contactId = "default"): {
  blockedAt: string | null;
  gates: Record<string, GateState>;
  idleMinutes: number;
  nextTask: { focus: string; due_at: number } | null;
} {
  const gates: Record<string, GateState> = {};

  gates.enabled = config.proactive.enabled
    ? { passed: true, detail: `开着，每 ${config.proactive.intervalMinutes} 分钟检查一次` }
    : { passed: false, detail: '开关是关的（PROACTIVE_ENABLED=false）' };

  const hour = new Date().getHours();
  const quiet = inQuietHours(hour);
  gates.quiet = quiet
    ? { passed: false, detail: `现在是 ${hour} 点，落在免打扰时段 ${config.proactive.quietHours}` }
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

  const order: Array<keyof typeof gates> = ["enabled", "quiet", "idle", "daily"];
  const pending = pendingProactiveTask(contactId);
  return {
    blockedAt: gates.enabled.passed === false ? "enabled" : quiet ? "quiet" : null,
    gates,
    idleMinutes,
    nextTask: pending ? { focus: pending.focus, due_at: pending.due_at } : null,
  };
}

export function startProactiveLoop(): NodeJS.Timeout {
  const everyMs = config.proactive.intervalMinutes * 60_000;
  // 每轮对每个未归档联系人各检查一次——他们的任务、配额、记忆互不相干。
  const timer = setInterval(() => {
    void (async () => {
      for (const contact of listContacts()) {
        if (isAssistant(contact.id)) continue; // 设置助手不主动发言
        try {
          await runProactiveCheck(contact.id, "timer");
        } catch (error) {
          // 主动性失败必须看得见，否则用户只会觉得"她变冷了"。
          console.warn(`[proactive] ⚠️ ${contact.name} 检查失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 记忆整理搭同一趟车（内部按开关与最小间隔节流；失败只告警）。
      maybeRunConsolidation();
    })();
  }, everyMs);
  console.log(`[proactive] 已启动，每 ${config.proactive.intervalMinutes} 分钟检查一次（按联系人 · 任务化）`
    + (config.proactive.enabled ? "" : " —— 但总开关关着，每趟检查都会直接早退"));
  return timer;
}
