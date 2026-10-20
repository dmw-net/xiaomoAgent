// Agent 层：一次「收消息 → 回消息」的完整处理。
//
// 关键设计：这是"薄循环"。它只做四件事——召回记忆、拼上下文、调模型、落库。

import { randomUUID } from "node:crypto";
import { db, withTx } from "./db.ts";
import { config } from "./config.ts";
import { extractMemories, likePattern, recall, recallExplained, recordExtractFailure } from "./memory.ts";
import { buildSystemPrompt, toChatMessages } from "./persona.ts";
import { capabilityReady, effectiveRecentTurns, modelConfig, modelReadyNow, resolveToolRounds } from "./settings.ts";import { callModel, callModelWithTools, contactModelSettings, friendlyModelError, ModelError, toolsUnsupportedFor, type CallOptions, type ChatMessage, type MessageContentPart } from "./model.ts";
import { executeTool, toolDefsForApi, type ToolContext } from "./tools.ts";
import { bannedWordsNote, parseBannedWords } from "./banned-words.ts";
import { ALL_TURNS, companionPromptExtras, contactCard, DEFAULT_CONTACT_ID, getContact } from "./contacts.ts";
import { buildAssistantSystemPrompt, isAssistant, pinAssistantToActiveProfile } from "./assistant.ts";
import { maybeRefreshRecap } from "./recap.ts";
import { segmentReply } from "./reply-segmentation.ts";
import { dataUrlBytes, mediaDataUrl, releaseMediaFiles } from "./media.ts";
import type { CapabilityName } from "./settings.ts";

export type TurnRow = {
  id: string;
  channel: string;
  text: string;
  contact_id: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  reply: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  /** 图片附件的 JSON 数组字符串（"/media/…"），可为 null。 */
  attachments?: string | null;
  /** 被编辑作废的时间戳（supersedeAfter 打的）。非空 = 这一轮已不属于当前对话。 */
  superseded_at?: number | null;
};

export function createTurn(input: {
  id: string;
  channel: string;
  text: string;
  contactId: string;
  attachments?: string[];
  /** 离线发件箱幂等键；同一联系人 + 同一键只会建出一条处理单。 */
  clientId?: string;
}): void {
  db.prepare(
    `INSERT INTO turns (id, channel, text, contact_id, attachments, client_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    input.id,
    input.channel,
    input.text,
    input.contactId,
    input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
    input.clientId || null,
    Date.now(),
  );
}

export function getTurn(id: string): TurnRow | null {
  const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | undefined;
  return row ?? null;
}

export function getTurnByClientId(contactId: string, clientId: string): TurnRow | null {
  const row = db.prepare("SELECT * FROM turns WHERE contact_id = ? AND client_id = ?").get(contactId, clientId) as TurnRow | undefined;
  return row ?? null;
}

export function insertMessage(input: {
  channel: string;
  role: "user" | "assistant";
  text: string;
  kind?: "chat" | "proactive" | "tool";
  turnId?: string | null;
  contactId: string;
  attachments?: string[];
  /** 模型这一轮的思考原文（仅用于界面折叠回看；不进上下文、不进记忆抽取）。 */
  reasoning?: string | null;
  /** 工具卡的可展开详情（仅 kind=tool 用；不进上下文回放，滚出窗口即 NULL）。 */
  toolDetail?: string | null;
}): number {
  const result = db
    .prepare(
      `INSERT INTO messages (channel, role, text, kind, turn_id, contact_id, attachments, reasoning, tool_detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.channel,
      input.role,
      input.text,
      input.kind ?? "chat",
      input.turnId ?? null,
      input.contactId,
      input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
      input.reasoning ?? null,
      input.toolDetail ?? null,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

/**
 * 思考原文的滚动窗口：每个联系人只留最近 REASONING_WINDOW 条，其余置 NULL。
 * 抄的是调用记录全文那套（logs.ts 的 FULL_TEXT_WINDOW）——**丢的是原文，不是记录**：
 * 气泡本身永远在，滚出窗口后只是折叠条不再出现。
 * 按联系人算而不是全局：切到小猫想看她刚才想过什么，不该被阿米的二十轮挤掉。
 */
export const REASONING_WINDOW = 20;

export function trimReasoningWindow(contactId: string): void {
  db.prepare(
    `UPDATE messages SET reasoning = NULL
     WHERE contact_id = ? AND reasoning IS NOT NULL
       AND id NOT IN (
         SELECT id FROM messages WHERE contact_id = ? AND reasoning IS NOT NULL ORDER BY id DESC LIMIT ?)`,
  ).run(contactId, contactId, REASONING_WINDOW);
}

/**
 * 工具卡详情的滚动窗口：每个联系人只留最近 TOOL_DETAIL_WINDOW **轮**（不是条），其余置 NULL。
 * 与 reasoning 同一套「丢的是原文，不是记录」：卡片本身永远在，滚出窗口后只是点不开详情。
 * 按轮而不是按条：一轮里可能连查好几样，只留一半会显得「刚才那条有、这条没有」。
 * 详情里塞的是抓回的网页正文/搜索条目，体积远大于摘要，必须封顶——
 * 否则聊天列表会被最近几张抓取页撑回几百 KB（见调用记录分页审计那条）。
 */
export const TOOL_DETAIL_WINDOW = 10;

export function trimToolDetailWindow(contactId: string): void {
  db.prepare(
    `UPDATE messages SET tool_detail = NULL
     WHERE contact_id = ? AND tool_detail IS NOT NULL AND kind = 'tool'
       AND turn_id NOT IN (
         SELECT turn_id FROM messages
         WHERE contact_id = ? AND kind = 'tool' AND tool_detail IS NOT NULL AND turn_id IS NOT NULL
         GROUP BY turn_id ORDER BY MAX(id) DESC LIMIT ?)`,
  ).run(contactId, contactId, TOOL_DETAIL_WINDOW);
}

/** 这条处理单的用户消息是否已经写过（重试时用来避免重复）。 */
export function turnHasUserMessage(turnId: string): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE turn_id = ? AND role = 'user'`)
    .get(turnId) as { c: number };
  return row.c > 0;
}

/** 删掉某轮助手的回复（重试前清理，避免界面上出现两次回复）。 */
export function deleteAssistantMessagesForTurn(turnId: string): number {
  const result = db
    .prepare(`DELETE FROM messages WHERE turn_id = ? AND role = 'assistant'`)
    .run(turnId);
  return Number(result.changes);
}

/**
 * 最近若干【轮】消息，用来拼上下文（一问一答算一轮，轮以 user 消息为边界）。
 *
 * ⚠️ 这里的 `superseded_at IS NULL` 是「编辑后从这里重新开始对话」的**真正实现**。
 * 如果编辑只改文本、不在这里过滤，界面看着是改了，模型却照样看得见被改掉的那段话——
 * 那就是自欺欺人。上下文过滤必须发生在这一个地方，而不是在界面上做样子。
 */
/** 这段会话聊了多少轮（活着的 user 消息数）：按会话比例回放时要拿它当分母。 */
export function countLiveTurns(contactId: string): number {
  return (db
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND superseded_at IS NULL AND kind != 'tool' AND role = 'user'`)
    .get(contactId) as { c: number }).c;
}

/** 生效回放轮数：联系人覆盖 > 全局应用内覆盖 > .env > 默认（与模型绑定同一套分层）。
 *  返回 ALL_TURNS(-1) 表示这位要带全部历史。
 *  features.turnPct > 0 时它优先：带「这段会话总轮数 × 百分比」的最近轮 ——
 *  轮数是固定形状，比例会随这段关系聊了多久自己伸缩。 */
export function effectiveRecentTurnsFor(contactId: string): number {
  const c = getContact(contactId);
  const pct = c?.features.turnPct ?? 0;
  if (pct > 0) return Math.max(1, Math.ceil(countLiveTurns(contactId) * pct / 100));
  const t = c?.recent_turns ?? 0;
  if (t === ALL_TURNS) return ALL_TURNS;
  return t > 0 ? t : effectiveRecentTurns();
}

/**
 * 历史这一块的 token 上限：features.tokenPct > 0 时为「输入上限 × 百分比」，否则不设限。
 * 与「回放轮数」是两条独立的闸门，同时生效、谁先到算谁；系统提示词/记忆/工具不受它管。
 * 没填输入上限时按保守估算的窗口算，界面必须说破那是估的（沿用 limitIsFallback）。
 */
export function historyTokenCapFor(contactId: string, settings: { maxInputTokens: number }): number {
  const pct = getContact(contactId)?.features.tokenPct ?? 0;
  if (pct <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(inputBudget(settings).limit * pct / 100);
}

export function recentMessages(
  contactId: string,
  limitTurns = effectiveRecentTurnsFor(contactId),
  /**
   * 只取到这条消息为止（含）。重答**较早**的一轮时必须把窗口截到那一轮，
   * 否则默认取的"最近窗口"会把那一轮**之后**的对话也带进去——
   * 于是模型看到的最后一句根本不是它要重答的那句，答得头头是道却答错了问题（实测踩过）。
   */
  upToMessageId?: number | null,
): Array<{ id: number; role: string; text: string; attachments: string | null; turn_id: string | null }> {
  const live = `contact_id = ? AND superseded_at IS NULL AND kind != 'tool'`;
  const cap = upToMessageId === undefined || upToMessageId === null ? "" : " AND id <= ?";
  const capArgs: number[] = cap === "" ? [] : [upToMessageId as number];
  // 窗口边界 = 倒数第 N 条「你说的话」。按轮数定位，而不是"取 N*2+8 行再倒着数"——
  // 她的回复是分条落库的，一轮可以有好几行，按行数猜会把窗口悄悄缩小。
  // turn_id 必须带出来：toChatMessages 靠它把同一轮的气泡合回一条 assistant 消息。
  const cols = `id, role, text, attachments, turn_id`;
  // 「全部」不做窗口边界：直接走下面那条无 id>=? 的分支，把整段历史带出来。
  // 真正的重量由 token 预算兜底（trimHistoryToBudget 会丢掉装不下的老轮）。
  const boundary = limitTurns === ALL_TURNS ? undefined : db
    .prepare(`SELECT id FROM messages WHERE ${live}${cap} AND role = 'user' ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(contactId, ...capArgs, Math.max(1, limitTurns) - 1) as { id: number } | undefined;
  return (boundary
    ? db.prepare(`SELECT ${cols} FROM messages WHERE ${live}${cap} AND id >= ? ORDER BY id ASC`).all(contactId, ...capArgs, boundary.id)
    : db.prepare(`SELECT ${cols} FROM messages WHERE ${live}${cap} ORDER BY id ASC`).all(contactId, ...capArgs)
  ) as unknown as Array<{ id: number; role: string; text: string; attachments: string | null; turn_id: string | null }>;
}

// 消息行的形状是前后端契约，唯一真源在 shared/api.ts。
import type { MessageRow } from "../shared/api.ts";

export type { MessageRow };

const MESSAGE_COLUMNS = "id, role, text, kind, created_at, superseded_at, superseded_kind, contact_id, attachments, turn_id, reasoning, tool_detail";

/** attachments 存的是 JSON 字符串；对界面下发前解析成数组，脏数据按无附件处理。 */
function withParsedAttachments(row: MessageRow & { attachments: unknown }): MessageRow {
  let list: string[] | null = null;
  if (typeof row.attachments === "string" && row.attachments !== "") {
    try {
      const parsed: unknown = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) list = parsed.filter((u): u is string => typeof u === "string" && u.startsWith("/media/"));
    } catch { /* 存坏了就当没附件 */ }
  }
  return { ...row, attachments: list };
}

/**
 * 聊天窗口的两档大小：首屏 500 条、每点一次「载入更早」再回 200 条。
 * 只有这一处定义——从前界面用 `返回行数 >= 200` 反推「还有没有下一页」，
 * 那个 200 在前后端各写一遍，改一边就悄悄失效（改成 300 后前端会以为到底了）。
 * 现在由服务端直接下发还剩多少条更早的没进界面。
 */
export const CHAT_FIRST_PAGE = 500;
export const CHAT_EARLIER_PAGE = 200;

export function messagesSince(contactId: string, sinceId: number, limit = 100): MessageRow[] {
  const rows = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .all(contactId, sinceId, limit) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments);
}

/** 这一位库里总共有多少条消息（含已失效的）——界面上那句「共 N 条」。 */
export function countMessagesFor(contactId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ?`)
    .get(contactId) as { c: number };
  return row.c;
}

/** 比 beforeId 更早的还有多少条——决定「载入更早」要不要继续显示、上面报什么数。 */
export function countMessagesBefore(contactId: string, beforeId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND id < ?`)
    .get(contactId, beforeId) as { c: number };
  return row.c;
}

/**
 * 只看一条处理单产生的行（按 id 升序）。
 * 撤回 / 删除 / 停止 / 改一句文字都只动某一轮，为一行变化重敲整页不值。
 */
/**
 * 只取一条处理单产生的行：撤回 / 删除 / 停止 / 改一句文字之后按轮窄取，不必重敲整页。
 *
 * contactId 必传：处理单 id 是 UUID，但前端完全可能拿着 A 的作用域来问 B 的轮次
 * （陈旧标签页、第二个窗口），不按 contact_id 过滤就是把对方的对话原文交出去。
 */
export function messagesForTurn(turnId: string, contactId?: string): MessageRow[] {
  const rows = contactId === undefined
    ? db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE turn_id = ? ORDER BY id ASC`)
        .all(turnId) as unknown as Array<MessageRow & { attachments: unknown }>
    : db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE turn_id = ? AND contact_id = ? ORDER BY id ASC`)
        .all(turnId, contactId) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments);
}

/**
 * 从某条消息往回取一页——「载入更早的消息」入口。
 *
 * 为什么需要全量模式（all=1）：编辑会让**已经渲染过的**消息变成失效态，而增量拉取
 * （id > since）看不到旧消息的状态变化，所以编辑之后必须整体重绘一次。
 */
export function messagesBefore(contactId: string, beforeId: number, limit = CHAT_EARLIER_PAGE): MessageRow[] {
  const rows = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(contactId, beforeId, limit) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments).reverse();
}

export type MessageHit = { id: number; contact_id: string; role: string; text: string; created_at: number };

/** 全历史搜索（微信式「我上周说的那句话在哪」）：只搜仍在对话里的活跃消息。 */
export function searchMessages(text: string, limit = 50): MessageHit[] {
  return db
    .prepare(
      `SELECT id, contact_id, role, text, created_at FROM messages
       WHERE superseded_at IS NULL AND kind != 'tool' AND text LIKE ? ESCAPE '\\'
         AND contact_id IN (SELECT id FROM contacts WHERE archived_at IS NULL)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(likePattern(text), limit) as unknown as MessageHit[];
}

export function allMessages(contactId: string, limit = CHAT_FIRST_PAGE): MessageRow[] {
  const rows = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT ?`)
    .all(contactId, Math.min(1000, Math.max(1, limit))) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments).reverse();
}

/** 会话内搜索：只在当前联系人、仍有效且不是工具卡的正文里找。 */
export function searchMessagesForContact(contactId: string, text: string, limit = 200): MessageRow[] {
  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE contact_id = ? AND superseded_at IS NULL AND kind != 'tool' AND text LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(contactId, likePattern(text), Math.min(500, Math.max(1, limit))) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments);
}

/** 搜索命中不在当前窗口时，取命中消息前后各半页，直接把它带进视口。 */
export function messagesAround(contactId: string, messageId: number, limit = 160): MessageRow[] | null {
  const anchor = db.prepare("SELECT id FROM messages WHERE id = ? AND contact_id = ?").get(messageId, contactId) as { id: number } | undefined;
  if (!anchor) return null;
  const cap = Math.min(300, Math.max(40, limit));
  const beforeLimit = Math.floor(cap / 2) + 1;
  const before = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND id <= ? ORDER BY id DESC LIMIT ?`)
    .all(contactId, messageId, beforeLimit) as unknown as Array<MessageRow & { attachments: unknown }>;
  const after = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .all(contactId, messageId, cap - before.length) as unknown as Array<MessageRow & { attachments: unknown }>;
  return [...before.reverse(), ...after].map(withParsedAttachments);
}

export function getMessage(id: number): (MessageRow & { turn_id: string | null }) | null {
  const row = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`)
    .get(id) as (MessageRow & { turn_id: string | null; attachments: unknown }) | undefined;
  return row === undefined ? null : (withParsedAttachments(row) as MessageRow & { turn_id: string | null });
}

/**
 * 启动清扫：进程崩溃/重启时留在 queued|running 的 turn 永远不会有人认领，
 * 且 retryTurn 拒绝 running——不扫就等于永久卡死。统一标 failed（可重试）。
 * 返回受影响条数。
 */
export function sweepStaleTurns(): number {
  const result = db
    .prepare(`UPDATE turns SET status = 'failed', error = '服务重启时这一轮没有跑完，可重试', finished_at = ? WHERE status IN ('queued', 'running')`)
    .run(Date.now());
  return Number(result.changes);
}

/** 状态页用的：最近若干条处理单，用于发现"卡住的处理"和"失败的处理"。offset 供翻页。 */
/** 某条消息属于哪个联系人（撤回/删除回执要按该联系人的性别说话）。找不到返回 null。 */
export function contactOfMessage(messageId: number): string | null {
  const row = db.prepare("SELECT contact_id FROM messages WHERE id = ?").get(messageId) as { contact_id: string | null } | undefined;
  return row?.contact_id ?? null;
}

/**
 * 最近的处理单。contactId 省略 = 全局（状态页要的就是跨联系人的总览）；
 * 传了 = 只看这一个联系人的轮次——聊天页的失败横幅靠它，
 * 不过滤就会把别人的失败轮当成"本会话上一条回复失败了"，重试还会重跑别人的轮。
 */
export function recentTurns(limit = 15, offset = 0, contactId?: string): TurnRow[] {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const safeOffset = Math.max(0, offset);
  if (contactId !== undefined) {
    return db
      .prepare(
        `SELECT id, channel, text, status, reply, error, created_at, finished_at
         FROM turns WHERE superseded_at IS NULL AND contact_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(contactId, safeLimit, safeOffset) as unknown as TurnRow[];
  }
  return db
    .prepare(
      `SELECT id, channel, text, status, reply, error, created_at, finished_at
       FROM turns WHERE superseded_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(safeLimit, safeOffset) as unknown as TurnRow[];
}

export type TurnStats = {
  total: number;
  done: number;
  failed: number;
  inFlight: number;
  avgLatencyMs: number | null;
  lastFailedAt: number | null;
};

/**
 * 处理单的汇总数字。avgLatencyMs 只统计成功的那批，失败的不该拉高平均值。
 * 被编辑作废的轮次（superseded_at 非空）一律不计入——它们已经不是当前对话的一部分了。
 */
export function turnStats(): TurnStats {
  const counts = db
    .prepare(`SELECT status, COUNT(*) AS c FROM turns WHERE superseded_at IS NULL GROUP BY status`)
    .all() as unknown as Array<{ status: string; c: number }>;
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of counts) {
    byStatus[row.status] = row.c;
    total += row.c;
  }

  const latency = db
    .prepare(
      `SELECT AVG(finished_at - created_at) AS avg_ms FROM turns
       WHERE status = 'done' AND finished_at IS NOT NULL AND superseded_at IS NULL`,
    )
    .get() as { avg_ms: number | null };
  const lastFail = db
    .prepare(`SELECT MAX(finished_at) AS t FROM turns WHERE status = 'failed' AND superseded_at IS NULL`)
    .get() as { t: number | null };

  return {
    total,
    done: byStatus.done ?? 0,
    failed: byStatus.failed ?? 0,
    inFlight: (byStatus.queued ?? 0) + (byStatus.running ?? 0),
    avgLatencyMs: latency.avg_ms === null ? null : Math.round(latency.avg_ms),
    lastFailedAt: lastFail.t ?? null,
  };
}

/**
 * 他上一次说话是什么时候——主动性闸门用它算"静默时长"。
 *
 * 必须排除失效消息：如果你把"我今天在忙"编辑成了别的话，
 * 那句被改掉的话不该继续影响"她该不该主动找你"的判断。
 */
export function lastUserMessageAt(contactId: string): number | null {
  const row = db
    .prepare(
      `SELECT created_at FROM messages WHERE contact_id = ? AND role = 'user' AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(contactId) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

/** token 粗估：中日韩字符按 1 字 1 token，其余按 4 字符 1 token。只用于占用展示，不做计费。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 一张图按 1000 token 估。服务商不给精确数，量级对就够判断占比了。 */
const IMAGE_TOKENS = 1000;

/**
 * 「输入上限」没填时的保守估算。往低了估是故意的：估低了只是少带几轮历史（她说话照样
 * 连贯），估高了会直接 400 发不出去。主流云端模型普遍 ≥128K，而且这类档一般会填上限，
 * 32K 不会误伤它们；真正需要被保护的是没填上限的本地小窗口模型。
 */
const FALLBACK_INPUT_LIMIT = 32_000;

/** 预算留 8% 余量：token 数是粗估（CJK 1:1、工具往返未计），别贴着上限发。 */
const BUDGET_HEADROOM = 0.92;

/** 一轮最多重放几张图。超出的图不进请求，占用估算也必须按同一个数算。 */
export const MAX_TURN_IMAGES = 3;

/**
 * 历史图片重放的字节天花板。
 *
 * 为什么按**字节**而不是按 token 或轮数：一张长边 1280 的图 base64 后 130-530KB，
 * 留在上下文里就是每轮整份重传（手机走隧道时是秒级上传）；而 token 侧实测只算 974，
 * 512K 窗口塞得下几百张。轮数用户本来就能调（RECENT_TURNS_IN_CONTEXT / 联系人
 * recent_turns，最多 30），但轮数管不住字节——6 轮 × 3 张最坏就是 9MB 一个请求。
 *
 * 所以分工是：轮数决定"哪些消息进上下文"，这个天花板决定"其中的图有几张还真给她看"，
 * 装不下的她就是看不见（由 IMAGE_MARK_* 如实告诉她）。1.5MB ≈ 5 张，覆盖"刚发完就追问"的场景。
 */
export const HISTORY_IMAGE_BYTE_BUDGET = 1.5 * 1024 * 1024;

/**
 * 挑出这次请求里以真图（base64）发出的图片；没挑中的由 imageProxiedHistory 换成一行文字说明。
 *
 * 他**这轮刚发**的图无条件重放——那是本轮要回答的东西，不给她看等于让她瞎着答。
 * **最新的那张历史图也无条件重放**：追问几乎总在紧接着的下一轮，而单张就可能超过整个
 * 天花板（上传上限 5MB → base64 6.7MB），不给这条保证"刚发完就追问"恰恰会瞎。
 * 再往老的从新到旧填剩余预算，第一张装不下就停——不按"跳过大的继续找小的"贪心填充，
 * 那会出现"老的小图看得见、新的大图看不见"这种反直觉结果。
 */
export function selectReplayImages(
  rows: Array<{ role: string; attachments: string | null }>,
  currentUrls: string[] = [],
  byteBudget: number = HISTORY_IMAGE_BYTE_BUDGET,
): Set<string> {
  const picked = new Set<string>();
  let used = 0;
  for (const url of currentUrls.slice(0, MAX_TURN_IMAGES)) {
    used += dataUrlBytes(url) ?? 0;
    picked.add(url);
  }
  let guaranteed = false; // 最新那张历史图是否已无条件带上
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.role !== "user") continue;
    for (const url of parseAttachments(row.attachments).slice(0, MAX_TURN_IMAGES).reverse()) {
      if (picked.has(url)) continue;
      const cost = dataUrlBytes(url);
      if (cost === null) continue; // 文件已不在，交给标记那侧如实说
      if (guaranteed && used + cost > byteBudget) return picked;
      used += cost;
      picked.add(url);
      guaranteed = true;
    }
  }
  return picked;
}

/** 这批行里有几张图是真发出去的。裁剪决策与圆环展示必须用同一个数。 */
export function countReplayedImages(
  rows: Array<{ role: string; attachments: string | null }>,
  replay: ReadonlySet<string>,
): number {
  let n = 0;
  for (const row of rows) {
    if (row.role !== "user") continue;
    for (const url of parseAttachments(row.attachments).slice(0, MAX_TURN_IMAGES)) {
      if (replay.has(url)) n += 1;
    }
  }
  return n;
}

/** 这次调用真正生效的输入预算；没填上限时返回保守值并标明"这是估的"，界面要说破。
 *  room 是扣掉余量后允许发出去的量——裁剪决策只看 room。 */
export function inputBudget(settings: { maxInputTokens: number }): {
  limit: number;
  isFallback: boolean;
  room: number;
} {
  const filled = settings.maxInputTokens > 0;
  const limit = filled ? settings.maxInputTokens : FALLBACK_INPUT_LIMIT;
  return { limit, isFallback: !filled, room: Math.floor(limit * BUDGET_HEADROOM) };
}

/** 一次对话请求会发出去的全部内容，各占多少 token。 */
export type ContextParts = { system: number; memory: number; tools: number; history: number; images: number };

/** 合并后的模型消息取回纯文本，供 token 估算——估算必须和真发出去的形状一致。 */
function textsOf(msgs: ChatMessage[]): Array<{ text: string }> {
  return msgs.map((m) => ({ text: typeof m.content === "string" ? m.content : "" }));
}

/**
 * 占用的唯一算法：圆环（展示）与发送前的裁剪（决策）共用它，两边不可能给出不同的数。
 * "圆环显示 40% 结果请求被拒"就是这类不一致攒出来的事故。
 */
export function contextParts(input: {
  /** 不含记忆段的系统提示词——用来把记忆开销单列出来。 */
  systemBare: string;
  /** 含记忆段的系统提示词。调用方手上只有成品时两次传同一个串即可，总额不变。 */
  systemFull: string;
  toolsJson: string;
  history: Array<{ text: string }>;
  imageCount: number;
}): ContextParts {
  let historyTokens = 0;
  for (const row of input.history) historyTokens += estimateTokens(row.text) + 2;
  const bareTokens = estimateTokens(input.systemBare);
  return {
    system: bareTokens,
    memory: Math.max(0, estimateTokens(input.systemFull) - bareTokens),
    tools: estimateTokens(input.toolsJson),
    history: historyTokens,
    images: input.imageCount * IMAGE_TOKENS,
  };
}

export function contextTotal(parts: ContextParts): number {
  return parts.system + parts.memory + parts.tools + parts.history + parts.images;
}

/**
 * 丢掉最旧的一轮（轮以 user 消息为边界，连同她随后的回复与工具往返）。
 * 返回 null = 只剩本轮，丢无可丢。
 * 切点一定落在 user 消息上，所以 assistant 的 tool_calls 与对应的 tool 结果不会被拆散。
 */
function dropOldestTurn<T extends { role: string }>(history: T[]): T[] | null {
  const first = history.findIndex((m) => m.role === "user");
  if (first < 0) return null;
  const second = history.findIndex((m, i) => i > first && m.role === "user");
  return second < 0 ? null : history.slice(second);
}

/**
 * 按预算从最旧一轮开始丢，直到装得下；本轮永不丢。
 * fits 由调用方给——只有它知道系统提示词和工具定义有多长。
 * 丢到只剩本轮仍装不下就停下：那已经不是"少带几轮"能解决的，
 * 让请求照发、由服务商的 context-length 400 给出人话错误，比在这里悄悄阉掉请求诚实。
 */
export function trimHistoryToBudget<T extends { role: string }>(
  history: T[],
  fits: (kept: T[]) => boolean,
): { kept: T[]; droppedTurns: number } {
  let kept = history;
  let droppedTurns = 0;
  while (!fits(kept)) {
    const next = dropOldestTurn(kept);
    if (next === null) break;
    kept = next;
    droppedTurns += 1;
  }
  return { kept, droppedTurns };
}

export type ContextUsage = {
  model: string;
  limit: number;
  /** limit 来自保守估算而非模型真实窗口——界面必须说破，否则用户以为那是天花板。 */
  limitIsFallback: boolean;
  used: number;
  /** 本次纳入上下文的历史轮数（一问一答算一轮）。 */
  turns: number;
  /** 这段关系一共聊了多少轮（活着的 user 消息数）。与 turns 不同：turns 是"这次带上了几轮"。 */
  totalTurns: number;
  /** 整段历史（不受回放窗口限制）的体量：资料页把「全部」这一档的代价摆出来用。 */
  fullHistory: { turns: number; tokens: number };
  /** 当前生效的「回放最近 N 轮」设置。 */
  recentTurnsSetting: number;
  /** 因「只回放最近 N 轮」而未纳入上下文的更早轮数——截断必须可见。 */
  overflowTurns: number;
  /** 因装不进窗口而被丢掉的历史轮数。成因与 overflowTurns 不同，提示要分开给。 */
  droppedByBudget: number;
  parts: Array<{ key: string; label: string; tokens: number }>;
};

/**
 * 下一次发消息时上下文里都会装什么、各占多少：
 * 人设系统提示词 / 记忆召回 / 工具定义 / 回放历史 / 重放图片。
 * 分母取该联系人生效模型填的「输入上限」，没填按 32K 保守估算——数字是估算，趋势是真的。
 * used 是**裁剪后**真正会发出去的量，被预算挡掉的轮数由 droppedByBudget 单独交代。
 */
export function contextUsage(contactId: string): ContextUsage {
  const cid = contactId === "" ? DEFAULT_CONTACT_ID : contactId;
  const history = recentMessages(cid);
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const card = contactCard(cid);
  const lastAt = lastUserMessageAt(cid);
  // 陪伴增强段两边同给：它们的开销进 system 项，不该被记到"记忆召回"头上。
  const companion = companionPromptExtras(getContact(cid), history[0]?.id);
  const bare = buildSystemPrompt([], { character: card, lastUserAt: lastAt, companion });
  // 观测路径用 recallExplained（不写 last_used_at）：圆环随消息轮询刷新，
  // 走真实 recall 会把「近 7 天被想起」统计刷成"用户打开了页面"，而不是"她想起过"。
  const full = buildSystemPrompt(lastUser ? recallExplained(cid, lastUser.text).events : [], { character: card, lastUserAt: lastAt, companion });
  // 量的是真会发出去的那份工具定义：可见性按联系人不同，不带 cid 会算错。
  const toolsJson = JSON.stringify(toolDefsForApi(cid));
  // 圆环量的是"下一次发消息会带什么"：那时他还没发新图，所以当前轮按 0 张算，
  // 只估历史图里有几张挤得进字节天花板。选图、标记、裁剪全部与 respondToTurn **同一套算法**，
  // 两边不可能给出不一致的数（这正是 contextParts 存在的理由）。
  const visionOn = !isAssistant(cid) && capabilityReady("imageVision");
  const replay = visionOn ? selectReplayImages(history, []) : new Set<string>();
  const proxied = imageProxiedHistory(history, replay, visionOn);
  const settings = contactModelSettings(cid) ?? modelConfig();
  const budget = inputBudget(settings);
  // 与 respondToTurn 同一套：历史占比上限也要在圆环这边生效，否则"设置里限了、圆环不认"。
  const histCap = historyTokenCapFor(cid, settings);
  // 与 respondToTurn 同一套：估算按合并气泡后的形状算，圆环才不会和真实请求对不上。
  const measureParts = (rows: typeof proxied) =>
    contextParts({ systemBare: bare, systemFull: full, toolsJson, history: textsOf(toChatMessages(rows)), imageCount: countReplayedImages(rows, replay) });
  const { kept, droppedTurns } = trimHistoryToBudget(proxied, (rows) => {
    const q = measureParts(rows);
    return contextTotal(q) <= budget.room && q.history <= histCap;
  });
  const p = contextParts({ systemBare: bare, systemFull: full, toolsJson, history: textsOf(toChatMessages(kept)), imageCount: countReplayedImages(kept, replay) });
  const parts = [
    { key: "system", label: "系统提示词", tokens: p.system },
    { key: "memory", label: "记忆召回", tokens: p.memory },
    { key: "tools", label: "工具定义", tokens: p.tools },
    { key: "history", label: "对话历史", tokens: p.history },
    { key: "images", label: "重放图片", tokens: p.images },
  ].filter((part) => part.tokens > 0);
  // 截断可见化（纪律 #3）：最近 N 轮之外的消息不会进上下文，用户必须看得见。
  // 轮数以 user 消息为边界；开头自发/主动消息不单独计轮。
  const liveTurns = (db
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND superseded_at IS NULL AND kind != 'tool' AND role = 'user'`)
    .get(cid) as { c: number }).c;
  const settingTurns = history.filter((m) => m.role === "user").length;
  // 「全部」这一档要能看见代价：整段历史（不受回放窗口限制）按同一套合并口径估的 token。
  // 只算文本，与圆环里的「对话历史」同一口径；图片另有一部分，不受此项影响。
  const fullHistoryTokens = textsOf(toChatMessages(recentMessages(cid, ALL_TURNS)))
    .reduce((a, m) => a + estimateTokens(m.text) + 2, 0);
  return {
    model: settings.name,
    limit: budget.limit,
    limitIsFallback: budget.isFallback,
    used: contextTotal(p),
    parts,
    turns: kept.filter((m) => m.role === "user").length,
    totalTurns: liveTurns,
    fullHistory: { turns: liveTurns, tokens: fullHistoryTokens },
    recentTurnsSetting: effectiveRecentTurnsFor(cid),
    overflowTurns: Math.max(0, liveTurns - settingTurns),
    droppedByBudget: droppedTurns,
  };
}

/**
 * 处理一轮对话。
 * 注意：调用方应当"先返回、后调用本函数"——它可能要跑十几秒，不能让 HTTP 请求等它。
 * isRetry=true 时不会重复写用户消息（重试的是同一轮），并会清掉上一次的失败回复。
 */
/**
 * agent 循环：带工具的多步生成。
 *
 * 流程：模型若请求工具 → 执行（结果 JSON 回传）→ 模型继续 → 最多 3 轮后强制收口。
 * 循环内的 tool 往返不进下次历史（recentMessages 已排除）；但每次工具执行会
 * 落一张 kind=tool 的**过程卡**——界面能看见她在查，过程不再是黑箱。
 * messages 表里她"说的话"仍然只有最终回复（思考过程依旧不回放）。
 *
 * 降级：端点不支持 function calling（第一次调用即 400/422）→ 整轮回退为无工具的单次
 * 生成，并记住降级状态（model.ts 内），后续轮次不再撞墙。echo 模式同理直接单次。
 *
 * 轮数不再是常量：它按「助手 > 联系人覆盖 > 全局」解析（见 settings.resolveToolRounds），
 * 因为联网这一档的活天然是多步流水，3 轮连一件事都做不完就被强制收口。
 */

/** 工具卡的一句摘要：按工具给用户能看懂的话，而不是甩 JSON。 */
export function toolSummary(name: string, result: unknown): string {
  if (name === "get_current_time") {
    const r = result as { iso?: string } | null;
    return r?.iso ? r.iso.slice(0, 16).replace("T", " ") : "查了当前时间";
  }
  if (name === "search_memory") {
    const r = result as { results?: unknown[] } | null;
    const n = Array.isArray(r?.results) ? r!.results!.length : 0;
    return n > 0 ? `想起了 ${n} 条相关的事` : "翻了翻，没找到相关的";
  }
  if (name === "schedule_reminder") {
    const r = result as { ok?: boolean; error?: string; due_at?: string; text?: string } | null;
    if (r?.ok === false) return `没立成：${r?.error ?? "原因不明"}`;
    return r?.due_at
      ? `记下了提醒「${(r.text ?? "").slice(0, 20)}」（${r.due_at.slice(0, 16).replace("T", " ")} 到点说）`
      : "记下了提醒";
  }
  if (name === "generate_image") {
    const r = result as { ok?: boolean; error?: string; seconds?: number; selfie?: boolean } | null;
    if (r?.ok === false) return `没画成：${r?.error ?? "原因不明"}`;
    const secs = r?.seconds ? `（${r.seconds} 秒）` : "";
    return r?.selfie ? `发了一张自拍${secs}` : `画了一张图${secs}`;
  }
  if (name === "app_status") return "读取了应用当前配置状态";
  if (name === "configure_model" || name === "activate_model") {
    const r = result as { ok?: boolean; label?: string; activated?: boolean; error?: string } | null;
    return r?.ok ? (name === "configure_model" ? `已${r.activated ? "保存并启用" : "保存"}模型「${r.label}」` : `已启用模型「${r.activated === false ? "" : (r.label ?? "")}」`) : `失败：${r?.error ?? "未知原因"}`;
  }
  if (name === "create_contact" || name === "update_contact" || name === "bind_contact_model") {
    const r = result as { ok?: boolean; name?: string; contact?: string; bound?: string | null; error?: string } | null;
    if (!r?.ok) return `失败：${r?.error ?? "未知原因"}`;
    if (name === "create_contact") return `已创建联系人「${r.name}」`;
    if (name === "bind_contact_model") return r.bound ? `已把「${r.contact}」绑定到模型` : `「${r.contact}」已回到跟随全局`;
    return "已更新联系人设定";
  }
  if (name === "set_contact_avatar") {
    const r = result as { ok?: boolean; error?: string } | null;
    return r?.ok ? "已更新头像" : `头像没设上：${r?.error ?? "未知原因"}`;
  }
  if (name === "web_search") {
    const r = result as { kind?: string; query?: string; count?: number } | null;
    const n = typeof r?.count === "number" ? r.count : 0;
    const what = r?.kind === "image" ? "图" : "结果";
    return n > 0 ? `搜了「${(r?.query ?? "").slice(0, 20)}」，找到 ${n} 条${what}` : `搜了「${(r?.query ?? "").slice(0, 20)}」，没找到${what}`;
  }
  if (name === "web_fetch") {
    const r = result as { title?: string; url?: string; chars?: number } | null;
    const host = (() => { try { return new URL(String(r?.url ?? "")).hostname; } catch { return ""; } })();
    const t = (r?.title ?? "").slice(0, 24);
    return t !== "" ? `读了「${t}」${host !== "" ? `（${host}）` : ""}` : (host !== "" ? `读了 ${host}` : "读了网页正文");
  }
  if (name === "load_skill") {
    const r = result as { name?: string; description?: string } | null;
    return r?.name ? `加载了技能「${r.name}」` : "加载了技能";
  }
  const text = JSON.stringify(result ?? "");
  return text.length > 60 ? text.slice(0, 60) + "…" : text || "执行完成";
}

/**
 * 工具卡「可展开详情」的正文：给人回看这次到底查到了什么，不是回灌给模型的载荷。
 * 每种工具渲染成人话，并对总长封顶（详情会落库、随聊天列表下发，绝不能塞整页网页）。
 * 返回空串表示这类工具没有值得展开的细节（调用方据此不写 tool_detail，卡片也就不可点）。
 */
const TOOL_DETAIL_MAX_CHARS = 1500;

export function toolDetail(name: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  let text = "";
  if (name === "web_search") {
    const hits = Array.isArray(r.hits) ? (r.hits as Array<Record<string, unknown>>) : [];
    // 带序号：界面上那排候选图按同一个顺序排，用户说「第 3 张」时回看详情才得对得上。
    const lines = hits.slice(0, 8).map((h, i) => `#${i + 1} ${String(h.title ?? "（无标题）")}\n  ${String(h.url ?? "")}`);
    text = [`搜索：${String(r.query ?? "")}`, ...(hits.length > 0 ? lines : ["（没有结果）"])].join("\n");
  } else if (name === "web_fetch") {
    const body = String(r.content ?? "").slice(0, 1200);
    text = [`标题：${String(r.title ?? "（无）")}`, `地址：${String(r.url ?? "")}`, "", body].join("\n");
  } else if (name === "load_skill") {
    const body = String(r.content ?? "").slice(0, 1200);
    text = [`技能：${String(r.name ?? "")}`, `说明：${String(r.description ?? "")}`, "", body].join("\n");
  } else if (name === "search_memory") {
    const hits = Array.isArray(r.results) ? (r.results as Array<Record<string, unknown>>) : [];
    text = hits.slice(0, 10).map((h) => `- ${String(h.content ?? "")}`).join("\n");
  } else {
    return ""; // 其余工具（时间/出图/配置类）摘要已够，不额外给详情
  }
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed.length > TOOL_DETAIL_MAX_CHARS ? trimmed.slice(0, TOOL_DETAIL_MAX_CHARS) + "…" : trimmed;
}

/**
 * 工具卡上要挂的图（目前只有「图片搜索」这一类）：搜到的候选图直接摆在卡片下面。
 *
 * 为什么挂在**工具卡**上而不是她这条回复的附件上：用户要的是「先看看这几张、再挑一张」。
 * 走附件那条路，8 张候选会变成"她一口气发了 8 张图"，语义完全变了，
 * 而且她真正设好头像那条回复反而看不出差别。
 *
 * 只认本地 /media：CSP 不放行远端图（见 server.ts），挂上去也只会是裂图。
 * 返回空数组表示这张卡没有可展示的图，调用方据此不写 attachments。
 */
export function toolAttachments(name: string, result: unknown): string[] {
  if (name !== "web_search") return [];
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.kind !== "image") return [];
  const hits = Array.isArray(r.hits) ? (r.hits as Array<Record<string, unknown>>) : [];
  return hits.map((h) => String(h.preview ?? "")).filter((url) => url.startsWith("/media/"));
}

/** 超长重试上限：预检已按预算裁过，走到这里说明估算偏乐观，纠两次足够。 */
const MAX_OVERFLOW_RETRIES = 2;

/**
 * 真值兜底：估算说装得下，服务商仍可能判超长（工具往返的 token 估算不计、分词器也不是它的）。
 * 这时丢掉最旧一轮历史重发——模型自己报的窗口比任何估算都可靠。
 * sent 就是这次真正发出去的那个数组：只动 system 之后的历史段，本轮（含它的工具往返）永不丢。
 */
async function guardOverflow<T>(sent: ChatMessage[], send: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await send();
    } catch (error) {
      const head = sent[0]?.role === "system" ? 1 : 0;
      const trimmed =
        error instanceof ModelError && error.code === "CONTEXT_OVERFLOW"
          ? dropOldestTurn(sent.slice(head))
          : null;
      if (trimmed === null || retry >= MAX_OVERFLOW_RETRIES) throw error;
      sent.splice(head, sent.length - head, ...trimmed);
      console.warn(`[agent] 服务商判定上下文超长，丢掉最旧一轮后重试（第 ${retry + 1} 次）`);
    }
  }
}

/**
 * 工具调用参数回传前脱敏：密钥类字段的值换成占位，JSON 形状保持合法。
 *
 * 为什么需要它：助手工具 `configure_model` 的 arguments 里带着用户刚贴的 apiKey。
 * 协议要求把 assistant 的 tool_calls 原样回传下一轮，于是那份密钥会跟着每一轮请求
 * 发给**当前生效的服务商**——而那家可能正是用户想替换掉的那家。
 * 密钥已经写进配置表，对话里不再需要它；模型也不会因为看不到值而不会用这个工具
 * （它要的参数在上一轮已经给出，这一轮只是协议回显）。
 *
 * 与 logs.ts 的 redactSecrets 是同一条规则的两个边界：那边管「别落库」，
 * 这边管「别出网」。改一处记得改另一处。
 */
function redactToolArguments(argsJson: string): string {
  const SECRET_KEY = /^[A-Za-z_]*(?:api[_-]?key|secret|password|authorization|token)[A-Za-z_]*$/i;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return argsJson; // 不是合法 JSON 就没法按字段脱敏，原样返回（executeTool 会报错给它看）
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return argsJson;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    redacted[key] = typeof value === "string" && SECRET_KEY.test(key) && value !== "" ? "<已省略>" : value;
  }
  return JSON.stringify(redacted);
}

/**
 * 工具结果进上下文前的体积上限。
 *
 * ⚠️ 为什么必须有：`trimHistoryToBudget()` 在循环**开始前**就跑完了，而工具结果是
 * 循环里一条条追加的——`load_skill` 最多回 24000 字、`web_fetch` 最多 20000 字，
 * 都发生在裁剪之后。于是一个小窗口模型（本地 8K、或输入上限 32K 的档）上，
 * 一道完全合规的配置就能让每一轮都超长：guardOverflow 只会去丢最旧的**历史轮**
 * （约两百 token），对着两万字的工具载荷杯水车薪，重试两次后本轮直接失败。
 * 更糟的是多轮累积：8 轮循环各带一份就是十几万字符，中间没有任何一道闸门。
 *
 * 截断时明确告诉她"还有但没给"，别让她以为看到的就是全部——否则她会基于半份资料下结论。
 */
const TOOL_RESULT_MAX_CHARS = 4_000;

function capToolResult(value: unknown, toolName: string): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const kept = text.slice(0, TOOL_RESULT_MAX_CHARS);
  return JSON.stringify({
    truncated: true,
    tool: toolName,
    note: `这个工具的返回太长了（原文 ${text.length} 字），这里只给前 ${TOOL_RESULT_MAX_CHARS} 字。就按这些判断，还想要更多就换个更具体的问法。`,
    partial: kept,
  });
}

async function runAgentLoop(
  turn: TurnRow,
  system: string,
  history: ChatMessage[],
  capability?: CapabilityName,
  signal?: AbortSignal,
  /** 思考内容出口（多轮工具调用可能各带一段）：只给界面折叠用，绝不回灌进对话。 */
  onReasoning?: (text: string, tokens: number) => void,
  /** 工具产出的文件（出图）出口：循环里每产一张就交出去，由调用方挂到这条回复的附件上。 */
  onFiles?: (urls: string[]) => void,
  /**
   * 流式草稿出口。**只有陪聊这一路会传**（抽取/主动性/整理都不传），
   * 于是也只有它们会向服务商要 `stream: true` —— 那些调用要的是结构不是过程，
   * 流式对它们是纯风险。传与不传就是这条功能的开关，界面上没有第二个开关。
   */
  onDraft?: (text: string) => void,
  /**
   * 让路检查：返回 true 表示这一轮已被取消（本进程 abort 或别的窗口在库里标了 cancelled），
   * 循环应当立刻收手。由 respondToTurn 传进来——它同时握着 controller 和 turn.id，
   * 而取消有两个来源（进程内 signal + 库侧标记），只有它判得全。
   */
  cancelIfAborted?: () => boolean,
): Promise<string> {
  const base: ChatMessage[] = [{ role: "system", content: system }, ...history];
  // 温度：联系人设过就用她的，没设（-1）就留给 model.ts 的全局默认（0.8）。
  const temp = getContact(turn.contact_id ?? DEFAULT_CONTACT_ID)?.features.temperature ?? -1;
  const options: CallOptions = {
    purpose: "chat" as const,
    // 故意不传 maxTokens：回复长度该由模型档上的「输出上限」决定，
    // 写死在这里等于让那个设置永远失效（见 model.ts 的 resolveMaxTokens）。
    turnId: turn.id,
    contactId: turn.contact_id ?? DEFAULT_CONTACT_ID,
    ...(temp >= 0 ? { temperature: temp } : {}),
    ...(capability ? { capability } : {}),
    ...(signal ? { signal } : {}),
    ...(onReasoning ? { onReasoning } : {}),
    ...(onDraft ? { onDelta: onDraft } : {}),
  };

  // 联系人维度就绪判定：全局是 echo 但本联系人绑了可用档时，也要走工具路径——
  // 否则「给某个角色单独配模型 + 开工具」会静默退化成无工具对话。
  const contactId = turn.contact_id ?? DEFAULT_CONTACT_ID;
  const effective = contactModelSettings(contactId) ?? modelConfig();
  if (!modelReadyNow(effective) || toolsUnsupportedFor(effective)) {
    return guardOverflow(base, () => callModel(base, options));
  }

  const context: ToolContext = { lastUserAt: lastUserMessageAt(contactId), contactId, turnId: turn.id };
  const messages: ChatMessage[] = [...base];
  // 让路检查：没传（抽取/主动性那些副通道）就退化成只看 signal。
  const shouldYield = cancelIfAborted ?? ((): boolean => signal?.aborted === true);
  // 助手放开、联系人可自己设、否则跟全局：见 settings.ts 里那段「为什么它不再是常量」。
  const maxRounds = resolveToolRounds(isAssistant(contactId), getContact(contactId)?.features.toolRounds ?? 0);

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      // 每轮开工前先让路：用户按了「停止」、或另一个窗口 barge-in 进来了，就停在这一轮开头。
      // 少了这个检查点，取消只会杀死在飞的那一次模型调用，而本轮剩下的工具调用照旧跑完——
      // 包括花钱的 generate_image（十几秒 + 一张配额）和会建真实任务的 schedule_reminder。
      // 跨进程取消只能靠库侧标记传达到这里，所以走 cancelIfAborted 而不是只看 signal。
      if (shouldYield()) return "";
      const response = await guardOverflow(messages, () => callModelWithTools(messages, toolDefsForApi(contactId), options));

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return response.content || (await guardOverflow(base, () => callModel(base, options)));
      }

      // 回传 assistant 的工具调用请求（协议要求），再逐个附上执行结果。
      // ⚠️ arguments 必须脱敏后再回传：configure_model 的参数里带着用户刚贴的 apiKey，
      // 原样回放等于每一轮都把这份密钥发给**当前生效的那家服务商**（可能是另一家），
      // 一个 8 轮循环发 8 次。密钥写进配置的那一刻起就不再需要出现在对话里了。
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: redactToolArguments(call.args) },
        })),
      });
      for (const call of response.toolCalls) {
        // 同一轮里还有多个工具调用时，逐个之前也让一次路：已经取消就别再执行剩下的
        // （出图那一发尤其贵——十几秒 + 一张每日配额）。附件那一行保留原样：
        // 图画都画了，中途被打断也别把那张图丢掉。
        if (shouldYield()) return "";
        const started = Date.now();
        const result = await executeTool(call.name, call.args, context);
        const elapsedMs = Date.now() - started;
        // 工具产物（出图）当场交出去挂到这条回复上。放在打断检查之前是故意的：
        // 图画都画了，中途被打断也别把那张图丢掉。
        if (result.ok && result.attachments && result.attachments.length > 0) onFiles?.(result.attachments);
        console.log(`[agent] 工具 ${call.name} → ${result.ok ? "ok" : `失败：${result.error}`}`);
        // 工具卡实时落库：界面能"看见她在查"，过程不再是黑箱。
        // kind=tool 的行不进上下文（recentMessages 已排除），只做过程展示。
        insertMessage({
          channel: turn.channel,
          role: "assistant",
          kind: "tool",
          turnId: turn.id,
          contactId,
          text: JSON.stringify({
            tool: call.name,
            ok: result.ok,
            summary: result.ok ? toolSummary(call.name, result.result) : String(result.error || "执行失败"),
            elapsedMs,
          }),
          toolDetail: result.ok ? (toolDetail(call.name, result.result) || null) : null,
          // 搜到的候选图挂在这张卡上（不是挂到她的回复上）：见 toolAttachments 的注释。
          attachments: result.ok ? toolAttachments(call.name, result.result) : [],
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: capToolResult(result.ok ? result.result : { error: result.error }, call.name),
        });
      }
    }

    // 轮数用尽仍没给最终回复：去掉工具消息强制它收口（本轮结论已在循环消息里，丢弃重生成太浪费）
    const compact = messages.filter((m) => m.role !== "tool" && m.tool_calls === undefined);
    const final = await guardOverflow(compact, () => callModel(compact, options));
    return final;
  } catch (error) {
    // 端点不支持 tools：回退为无工具单次生成（callModelWithTools 已置降级标记）。
    // 超长不算"不支持"——换成无工具请求照样超长，只会把一条能看懂的报错变成看不懂的。
    if (
      error instanceof ModelError
      && (error.status === 400 || error.status === 422)
      && error.code !== "CONTEXT_OVERFLOW"
    ) {
      console.warn("[agent] 端点不支持工具调用，本轮回退为无工具生成");
      return callModel(base, options);
    }
    throw error;
  }
}

/** 改她的一条回复文本（不重新生成、不动后续）。返回 false = 这条不存在或不是有效回复。 */
export function updateAssistantText(id: number, text: string): boolean {
  const res = db.prepare(
    `UPDATE messages SET text = ? WHERE id = ? AND role = 'assistant' AND kind = 'chat' AND superseded_at IS NULL`,
  ).run(text, id);
  return res.changes > 0;
}

/**
 * 只改这一句**用户消息**的文字：不作废任何后续、不重新生成。
 *
 * 与 editAndRegenerate 的差别就是「重放」那一步 —— 多数人改的是错字，
 * 不该因为改一个字就把后面整段对话抹掉重答。
 * 顺带把处理单上的 text 一起改掉：那一行才是她下次重答这一轮时喂给模型的原文，
 * 只改 messages 会让界面改对了、重答却按旧话回答。
 */
export function updateUserMessageText(id: number, text: string): boolean {
  const row = db.prepare(`SELECT turn_id FROM messages WHERE id = ? AND role = 'user' AND superseded_at IS NULL`)
    .get(id) as { turn_id: string | null } | undefined;
  if (!row) return false;
  db.prepare(`UPDATE messages SET text = ? WHERE id = ?`).run(text, id);
  if (row.turn_id) db.prepare(`UPDATE turns SET text = ? WHERE id = ?`).run(text, row.turn_id);
  return true;
}

/** turns.attachments 存的是 JSON 字符串；这里统一解析成数组。 */
function parseAttachments(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/** 图片理解能力没配好：她连他这轮刚发的图都看不见。别和"太久了"混为一谈——那是两句不同的实话。 */
const NO_VISION_REASON = "图片理解能力没配置，你看不到内容——直接告诉他你看不了，别猜也别编";
/** 配好了，但这张已滑出重放窗口：同样看不到。 */
const OUT_OF_WINDOW_REASON = "太久了，已滑出回放窗口，你看不到内容了——直说记不清，别猜也别编";

function imageMark(reason: string, count: number): string {
  return `[图片${count > 1 ? ` ×${count}` : ""}：${reason}]`;
}

/**
 * 看不见的图换成一行文字说明；replay 里的图以 base64 真图发出，一个字都不用附。
 *
 * 「别猜也别编」不是废话：实测给她一句图片摘要，她会**凭摘要推断出摘要里没有的细节**，
 * 还说成「从图上看」（问「水槽里有没有泡着的碗」，摘要没写，她答「似乎有，还有洗洁精的泡沫」）。
 * 三次收紧提示词都没压住；压住它的是把真图重放给她看。所以看不见的图必须明说看不见，
 * 给二手信息反而不如不给。
 *
 * 导出是为了冒烟能直接断言：这里曾经只处理纯图消息（text === ""），
 * "文字 + 图"的消息会把图**静默丢掉**，她既看不见图也不知道有图。
 */
export function imageProxiedHistory<T extends { text: string; attachments: string | null }>(
  rows: T[],
  replay: ReadonlySet<string>,
  visionOn: boolean,
): T[] {
  const reason = visionOn ? OUT_OF_WINDOW_REASON : NO_VISION_REASON;
  return rows.map((row) => {
    const hidden = parseAttachments(row.attachments).filter((url) => !replay.has(url));
    if (hidden.length === 0) return row;
    const mark = imageMark(reason, hidden.length);
    return { ...row, text: row.text === "" ? mark : `${row.text}\n${mark}` };
  });
}

/** 每联系人同一时刻只允许一轮在飞：新轮开始即打断旧轮（barge-in）。 */
const activeTurns = new Map<string, { turnId: string; controller: AbortController }>();

/**
 * 流式草稿的落点：把「她正在写的这一句」按节流写进 turns.reply，只在这一轮还活着的时候写。
 *
 * 为什么是 turns.reply 而不是 messages 行：`/api/messages` 的增量按 `id > since` 取
 * （server.ts:1101），**已经存在的行永远不会被重新下发**——半截话写进消息行界面根本看不见。
 * 而 `/api/turn/:id` 早就带 reply 字段，前端 watch 每 900ms 打它一次（ChatView 的 watch），
 * 草稿搭这趟车：不新增端点、不新增请求数。别的窗口靠 checkTurnState 接上同一轮也看得见，
 * 因为草稿在库里，不在某个进程的内存或某条连接上——这正是它比"浏览器直连 SSE"
 * 更合这套多窗口共库架构的地方（SSE 连接只能绑死在起跑那个进程上）。
 *
 * 交出去的是**本次调用的累计正文**，不是整轮累计：工具轮也常带正文，
 * 把它和最终回复拼成一句会变成她在改口。
 */
function draftWriter(turnId: string): (text: string) => void {
  let lastWrite = 0;
  return (text) => {
    const now = Date.now();
    // 流式一帧几十毫秒一片，逐片写库等于给 WAL 一道持续小洪峰；200ms 一次足够看出她在写。
    if (now - lastWrite < 200) return;
    lastWrite = now;
    // 条件写：状态一旦离开 running（取消、收尾、被别的进程判死），迟到的帧就写不进去，
    // 不会把草稿复活成"看起来像定稿"。
    db.prepare(`UPDATE turns SET reply = ? WHERE id = ? AND status = 'running'`).run(text, turnId);
  };
}

export async function respondToTurn(
  turn: TurnRow,
  opts: { isRetry?: boolean; collapseReply?: boolean } = {},
): Promise<string> {
  const contactId = turn.contact_id ?? DEFAULT_CONTACT_ID;
  const attachments = parseAttachments(turn.attachments);

  // 单飞（barge-in）：同一联系人来了新消息 = 还在跑的旧轮被打断。
  // abort 掉在飞的请求，旧轮在自己的 catch 里标 cancelled 收尾：不插任何 assistant 行、
  // 不跑记忆抽取、reply 一起抹掉。
  // 流式只喂草稿位（turns.reply），messages 里从来只有定稿，所以打断仍然没有"半截气泡"要解释——
  // 所以打断不需要"半截文本要不要保留"这套机制。
  const controller = new AbortController();
  const prior = activeTurns.get(contactId);
  // 按 controller 身份判断，不按 turnId：编辑/重试会让**同一个** turnId 再进来一次，
  // 那时旧执行体同样必须死——只比 turnId 会放它过去，两个执行体并发写同一轮。
  if (prior && prior.controller !== controller) {
    prior.controller.abort();
    console.log(`[agent] turn ${prior.turnId} 被打断（${prior.turnId === turn.id ? "同一轮重新起跑" : "新消息 barge-in"}）`);
  }
  // 起跑前三步（打断在飞的旧轮、跨进程取消、登记 activeTurns）必须整体受保护：
  // 其中跨进程取消是一句**写库**的 UPDATE，而 db.ts 开了 busy_timeout=5000——
  // 并发写冲突会在 5 秒后抛。从前它直接冒出 respondToTurn，被 channels/web.ts 的
  // `void (async () => …)()` 吞掉，于是这一轮**永远停在 queued**：
  // 前端轮询到天荒地老，界面上没有任何错误，只有重启（sweepStaleTurns）才清得掉。
  try {
    for (const row of db.prepare(
      `SELECT id FROM turns WHERE contact_id = ? AND id <> ? AND status IN ('queued','running')`,
    ).all(contactId, turn.id) as Array<{ id: string }>) {
      db.prepare(`UPDATE turns SET status = 'cancelled', error = '被新消息打断', reply = NULL, finished_at = ? WHERE id = ?`)
        .run(Date.now(), row.id);
      console.log(`[agent] turn ${row.id} 被别的进程打断（跨进程协作取消）`);
    }
  } catch (error) {
    const message = `启动失败：${error instanceof Error ? error.message : String(error)}`;
    try {
      db.prepare(`UPDATE turns SET status = 'failed', error = ?, reply = NULL, finished_at = ? WHERE id = ?`)
        .run(message, Date.now(), turn.id);
    } catch { /* 库本身连不上就没啥可做了，交给进程级兜底日志 */ }
    if (activeTurns.get(contactId)?.turnId === turn.id) activeTurns.delete(contactId);
    throw error;
  }
  activeTurns.set(contactId, { turnId: turn.id, controller });
  // 打断可能落在三个位置：模型请求在飞、分条落库的间隙、或刚回完还没落库。
  // 后两种 abort 杀不到任何东西，必须自己检查信号；取消时把已插的气泡清掉、草稿一起抹——
  // cancelled 的轮在对话里不留痕迹，界面上那半截草稿也跟着作废（条件写让它之后再也写不进去）。
  const cancelIfAborted = (): boolean => {
    // 库侧也要看：跨进程的打断只能靠这个标记传达到这里。
    // 起跑时上面已经把这一轮写成 running，所以这里读到 cancelled 只可能是别人要求我们停，
    // 不会是把一条历史 cancelled 轮误当成取消信号。
    if (!controller.signal.aborted) {
      const live = db.prepare(`SELECT status FROM turns WHERE id = ?`).get(turn.id) as { status: string } | undefined;
      if (live?.status !== "cancelled") return false;
    }
    deleteAssistantMessagesForTurn(turn.id);
    db.prepare(`UPDATE turns SET status = 'cancelled', error = '被新消息打断', reply = NULL, finished_at = ? WHERE id = ?`).run(
      Date.now(),
      turn.id,
    );
    console.log(`[agent] turn ${turn.id} 已取消（被新消息打断）`);
    return true;
  };

  try {
    // 状态翻转也放进 try：万一 UPDATE 抛错，还能走下面的失败落库而不是黑洞。
    db.prepare("UPDATE turns SET status = 'running', error = NULL WHERE id = ?").run(turn.id);
    /**
     * 重答一条**较早**的轮次时，新回复必须留在它原来位置上。
     * 消息表以自增 id 当时间轴（上下文窗口按 id 取、supersedeAfter 也按 id 比较），
     * 「删掉再插」会让这条回复排到整段对话末尾，后面那些轮次当场对不上。
     * 所以这里沿用它第一个气泡那一行的 id 把整条写回去、多余的分条气泡删掉。
     * 代价是这一种重答不分条——故意的重答旧消息，不需要打字节奏。
     */
    const collapseIntoId = opts.isRetry && opts.collapseReply
      ? ((db.prepare(`SELECT id FROM messages WHERE turn_id = ? AND role = 'assistant' ORDER BY id ASC LIMIT 1`)
        .get(turn.id) as { id: number } | undefined)?.id ?? null)
      : null;
    if (opts.isRetry) {
      if (collapseIntoId !== null) {
        db.prepare(`DELETE FROM messages WHERE turn_id = ? AND role = 'assistant' AND id <> ?`).run(turn.id, collapseIntoId);
      } else {
        deleteAssistantMessagesForTurn(turn.id);
      }
    }
    if (!turnHasUserMessage(turn.id)) {
      insertMessage({ channel: turn.channel, role: "user", text: turn.text, turnId: turn.id, contactId, attachments });
    }

    // 联系人隔离：人格、记忆、上下文全部按这个联系人取——
    // A 记得的事 B 不知道，这是「完全隔离」路线的落地。
    // 设置助手例外：不抽陪伴记忆，用实时的产品状态提示词 + 白名单配置工具。
    const assistant = isAssistant(contactId);
    if (assistant) pinAssistantToActiveProfile(); // 首次开口前把自己钉在当时的生效档上
    // 重答一轮时把上下文截到这一轮为止（见 recentMessages 的 upToMessageId）：
    // 不截就会把后面的对话当成"最新的话"，重答第 1 轮却回答第 3 轮的问题。
    // 这一步排在拼提示词之前：梗概要不要注入，取决于它覆盖的那段是否已在窗口里原文回放。
    const upToRow = opts.isRetry
      ? db.prepare(`SELECT id FROM messages WHERE turn_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`)
        .get(turn.id) as { id: number } | undefined
      : undefined;
    const rawRows = recentMessages(contactId, undefined, upToRow?.id ?? null);
    const memories = assistant ? [] : recall(contactId, turn.text);
    const system = assistant
      ? buildAssistantSystemPrompt()
      : buildSystemPrompt(memories, {
          character: contactCard(contactId),
          lastUserAt: lastUserMessageAt(contactId),
          companion: companionPromptExtras(getContact(contactId), rawRows[0]?.id),
        });
    // 预算裁剪（软防线）：装不下就从最旧一轮开始丢，本轮永不丢。
    // 估算有误差，所以真值兜底留在 runAgentLoop——服务商回 context-length 400 时再丢一轮重试。
    const visionOn = !assistant && capabilityReady("imageVision");
    // 他这轮刚发的图无条件重放；历史图按字节天花板从新到旧填，装不下的降级成文字摘要。
    // 视觉能力没配好就一张都不重放，全部走摘要——图不丢，但她看不到原图。
    const replay = visionOn ? selectReplayImages(rawRows, attachments) : new Set<string>();
    const historyRows = imageProxiedHistory(rawRows, replay, visionOn);
    const modelSettings = contactModelSettings(contactId) ?? modelConfig();
    const budget = inputBudget(modelSettings);
    // 历史占比上限（联系人级）：轮数管形状，这条管钱包，两条同时生效。
    const histCap = historyTokenCapFor(contactId, modelSettings);
    const toolsJson = JSON.stringify(toolDefsForApi(contactId));
    const { kept: keptRows } = trimHistoryToBudget(historyRows, (rows) => {
      const p = contextParts({
        systemBare: system, systemFull: system, toolsJson,
        // 估算按「合并气泡后」的形状算：真发出去的就是一轮一条 assistant，
        // 按拆开的行数算会虚高，圆环和裁剪就会和真实请求对不上。
        history: textsOf(toChatMessages(rows)),
        imageCount: countReplayedImages(rows, replay),
      });
      return contextTotal(p) <= budget.room && p.history <= histCap;
    });
    const history = toChatMessages(keptRows);

    // 重放的真图就地变成多模态 parts——不止当前这轮，预算内的历史图一样发原图。
    let visionCapability: CapabilityName | undefined;
    if (visionOn && replay.size > 0) {
      // keptRows 与 history 的 user 行同序（recentMessages 已排除 tool 行，角色只有 user/assistant），
      // 所以按「第 n 条 user 消息」配对，不依赖两个数组下标相等。
      const userRows = keptRows.filter((row) => row.role === "user");
      let nth = 0;
      let sentAny = false;
      let inlineBytes = 0;
      for (const msg of history) {
        if (msg.role !== "user") continue;
        const row = userRows[nth];
        nth += 1;
        if (!row) continue;
        const urls = parseAttachments(row.attachments).filter((url) => replay.has(url)).slice(0, MAX_TURN_IMAGES);
        if (urls.length === 0) continue;
        const parts: MessageContentPart[] = [];
        // row.text 已经含"看不见的图"的摘要行（imageProxiedHistory 写的），一起发正好：
        // 同一条消息里可以是「真图 + 另几张图的摘要」。
        if (row.text !== "") parts.push({ type: "text", text: row.text });
        for (const url of urls) {
          const dataUrl = mediaDataUrl(url);
          if (dataUrl) {
            parts.push({ type: "image_url", image_url: { url: dataUrl } });
            inlineBytes += dataUrl.length;
          }
        }
        if (parts.length > 0) {
          msg.content = parts;
          sentAny = true;
        }
      }
      // 请求体体积是图片这条路的真约束（token 侧才 974/张），所以内联了多少字节必须可见。
      console.log(`[agent] 重放真图 ${replay.size} 张，实际内联 ${(inlineBytes / 1024).toFixed(0)}KB`);
      // 一张都没真发出去（比如文件都没了）就别把纯文本请求绕到视觉模型上。
      if (sentAny) visionCapability = "imageVision";
    }

    // 禁用词：把约束追加到最后一条 user 消息尾部（口径与代价写在 banned-words.ts 顶上）。
    // 只改这份请求用的 history，不落库也不回灌——下一轮按当时的词表重新拼，改完立刻生效。
    // 排在预算裁剪之后：那句约束固定几十字节，超了有 runAgentLoop 的 context-length 兜底。
    const bannedNote = bannedWordsNote(parseBannedWords(getContact(contactId)?.features.bannedWords ?? ""));
    if (bannedNote !== "") {
      const appendToParts = (parts: MessageContentPart[]): MessageContentPart[] => {
        let last = -1;
        parts.forEach((p, i) => { if (p.type === "text") last = i; });
        if (last < 0) return [...parts, { type: "text", text: bannedNote.trimStart() }];
        return parts.map((p, i) => (i === last && p.type === "text" ? { ...p, text: p.text + bannedNote } : p));
      };
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const msg = history[i];
        if (!msg || msg.role !== "user") continue;
        const c = msg.content;
        history[i] = { ...msg, content: typeof c === "string" ? c + bannedNote : appendToParts(c) };
        break;
      }
    }
    // agent 循环：她可以在回答前调用工具（查时间、查记忆），最多 3 轮。
    // 上下文里已经注入了环境描述与被动召回的记忆，工具是「她主动去查」的补充——
    // 不确定几点、想确认记没记过某件事时，她自己决定查不查。
    // 思考内容：多轮工具调用可能各带一段，按顺序拼起来。它只属于"这一轮她想过什么"，
    // 所以只挂在**该轮第一个气泡**上（分条回复也只出现一次），并且绝不回灌进 history——
    // 否则下一轮她会把推理当成自己说过的话再读一遍，token 翻倍还污染记忆抽取。
    const reasoningParts: string[] = [];
    const producedFiles: string[] = [];
    const reply = await runAgentLoop(turn, system, history, visionCapability, controller.signal,
      (text) => { if (text.trim() !== "") reasoningParts.push(text.trim()); },
      (urls) => { producedFiles.push(...urls); },
      draftWriter(turn.id), cancelIfAborted);
    if (cancelIfAborted()) return "";
    const reasoning = reasoningParts.join("\n\n");
    // 一条回复最多挂一张图：工具描述里已经要求"同一轮最多画一张"，这里再兜一道，
    // 免得 3 轮循环各画一张、气泡上挂出一串画廊。
    // 名字避开外层那个"本轮入站附件"attachments——那是他发来的图，这是她发出去的。
    const outgoingImages = producedFiles.slice(0, 1);

    // 分条发送：按句子切成几个气泡，逐条延迟落库——像人打字，而不是一次性甩一大段。
    // Markdown 内容（列表/代码块）由分割器保证整条不拆。turn 在最后一条落库后才 done，
    // 前端的"正在输入"会持续到最后一条出现，节奏才对。
    // 联系人可以把这套节奏关掉（回复方式=单条整段）：整条一个气泡、不等待。
    const parts = getContact(contactId)?.features.splitReply === false ? [reply] : segmentReply(reply);
    if (collapseIntoId !== null) {
      // 整条写回原来那个气泡的位置（见上面 collapseIntoId 的说明），不分条、不延迟。
      // 附件跟着一起重写：重答画了新图就换上新图，没画就该清掉旧图，不能留着上一版的。
      db.prepare(`UPDATE messages SET text = ?, attachments = ?, reasoning = ? WHERE id = ?`)
        .run(reply, outgoingImages.length > 0 ? JSON.stringify(outgoingImages) : null, reasoning || null, collapseIntoId);
    } else {
      for (let i = 0; i < parts.length; i += 1) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 450 + Math.floor(Math.random() * 750)));
          // 延迟间隙是最容易漏的打断点：不检查的话旧轮会把剩下的气泡继续插进新对话里。
          if (cancelIfAborted()) return "";
        }
        insertMessage({
          channel: turn.channel, role: "assistant", text: parts[i] ?? "", turnId: turn.id, contactId,
          // 一轮只挂一处：第一条气泡带这段思考与这张图，后面的气泡不重复显示
          ...(i === 0 && reasoning !== "" ? { reasoning } : {}),
          ...(i === 0 && outgoingImages.length > 0 ? { attachments: outgoingImages } : {}),
        });
      }
    }
    trimReasoningWindow(contactId);
    trimToolDetailWindow(contactId);
    if (cancelIfAborted()) return "";
    db.prepare("UPDATE turns SET status = 'done', reply = ?, finished_at = ? WHERE id = ?").run(
      reply,
      Date.now(),
      turn.id,
    );

    // 微信镜像：绑定过微信的联系人，这一句（不分发起端）都要投到微信。
    // deliverToContact 自身不抛错、未绑定静默跳过；动态 import 防止模块环。
    // 画了图就得在镜像文字里说破：微信那条链路只发得出文字（媒体要 CDN + AES，见 wechat.ts 顶注），
    // 不说她回了"给你画了一张"而对面什么都收不到。应用里那张图本来就在。
    void import("./wechat.ts")
      .then(({ wechat }) => wechat.deliverToContact(
        contactId,
        outgoingImages.length > 0 ? `${reply}\n（画了一张图，微信发不出去，在这个应用里看）` : reply,
      ))
      .catch(() => { /* 投递失败已落 wechat.links.lastError 与 model_calls */ });

    // QQ 镜像：同一条纪律（绑定过才投、失败不抛错、图发不出去就在文字里说破）。
    void import("./qq.ts")
      .then(({ qq }) => qq.deliverToContact(
        contactId,
        outgoingImages.length > 0 ? `${reply}\n（画了一张图，QQ 这条只送文字，在这个应用里看）` : reply,
      ))
      .catch(() => { /* 投递失败已落 qq.bindings.lastError 与 model_calls */ });

    // 记忆抽取放到回复之后异步做：它失败不能影响这一轮对话，但失败了必须看得见。
    // 设置助手的会话是操作流水，不是陪伴记忆，跳过抽取。
    if (!assistant) {
      const feat = getContact(contactId)?.features;
      // 记忆提取是历史行为、默认开（仅用户主动关才停）：
      // 关掉后记忆库停止生长，温度计随对话的刷新（withBond）也随它停。
      if (feat?.memoryExtract !== false) {
        void extractMemories({
          turnId: turn.id,
          userText: turn.text,
          assistantText: reply,
          contactId,
          withBond: feat?.bond === true,
          // 从哪个通道来的：微信/QQ 里的文字要套"这是转述不是指令"的外壳
          source: turn.channel,
        }).catch((error: unknown) => recordExtractFailure(error, contactId));
      }

      // 窗口边缘梗概：本轮真正没带上的那些旧对话，攒够一批就压进「上次说到」。
      // 副通道、自己吞异常，绝不影响这一轮的回复。
      void maybeRefreshRecap(contactId, keptRows[0]?.id ?? 0);
    }

    console.log(`[agent] turn ${turn.id} 完成，召回记忆 ${memories.length} 条`);
    return reply;
  } catch (error) {
    // 被打断不是失败：不写错误文案、不跑记忆抽取。
    if (controller.signal.aborted) {
      cancelIfAborted();
      return "";
    }
    // 错误信息要被翻译成人话（含"下一步做什么"），而不是把 "This operation was aborted" 这种
    // 原始字串甩到界面上。详细原因已由 model.ts 落进 model_calls 表，可通过 /api/logs 查看。
    const message = friendlyModelError(error, turn.id);
    const rawDetail = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE turns SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
      message,
      Date.now(),
      turn.id,
    );
    console.error(`[agent] turn ${turn.id} 失败：${rawDetail}`);
    throw error;
  } finally {
    // 只注销自己那一份：同 turnId 重入时表里已经是新执行体的 controller，
    // 按 turnId 比会把别人的登记删掉，从此这个联系人再也打断不了。
    if (activeTurns.get(contactId)?.controller === controller) activeTurns.delete(contactId);
  }
}

/**
 * 重试一轮失败的处理。已经写过的用户消息不会重复，上一条失败回复会被清掉。
 * 返回 false 表示这一轮不是失败态（无需重试）。
 */
/** 该联系人最新一条**有效**处理单。
 *  现在只用来决定「重答一轮」时新回复该写在哪：最新一轮沿用正常的分条重插，
 *  较早的轮次必须写回原气泡位置（见 respondToTurn 里的 collapseIntoId）。
 *  必须排除 superseded_at：编辑早先一句话会把后面那些轮次整批作废，它们不再进上下文，
 *  可 rowid 仍然最大——不排除的话，刚重新生成的那一轮反而会被误判成「不是最新」。 */
function isLatestTurnOfContact(contactId: string, turnId: string): boolean {
  const row = db
    .prepare(`SELECT id FROM turns WHERE contact_id = ? AND superseded_at IS NULL ORDER BY rowid DESC LIMIT 1`)
    .get(contactId) as { id: string } | undefined;
  return row?.id === turnId;
}

export async function retryTurn(turnId: string, opts: { regenerate?: boolean } = {}): Promise<boolean> {
  const turn = getTurn(turnId);
  if (!turn) throw new Error("处理单不存在");
  // 被编辑作废的轮次一律不许重跑：它已经不在当前对话里了，
  // 重跑会插进一条没有对应提问、且逻辑上已被抹掉的"幽灵回复"，还进上下文。
  // regenerate 有 isLatestTurnOfContact 挡着，失败重试这条路此前没有等价防护。
  if (turn.superseded_at !== null && turn.superseded_at !== undefined) {
    throw new Error("这一轮已经被编辑取代了，不用重试");
  }
  if (turn.status === "running") throw new Error("这一轮还在处理中，先等它结束");
  if (opts.regenerate) {
    if (turn.status !== "done") throw new Error("这一轮还没有正常回复，请用失败重试");
    if (!turn.contact_id) throw new Error("这一轮没有归属联系人，重答不了");
  } else if (turn.status === "done") {
    throw new Error("这一轮已经成功了，不用重试");
  }
  // 任何一轮都能重答（不再限最新一轮）。区别只在写回哪里：
  // 最新一轮按正常路径分条重插；较早的那轮必须写回它原来的气泡位置，
  // 否则新回复会顺着自增 id 掉到整段对话末尾。
  const collapseReply = opts.regenerate === true
    && !!turn.contact_id
    && !isLatestTurnOfContact(turn.contact_id, turnId);

  // 先把处理单同步打回 queued，再点火。
  // 不这么做的话，`POST /regenerate` 返回 200 时库里这一轮**还是上一次的 done**：
  // 前端 watch 第一拍就读到 done，当场收工——「正在回复」闪一下就灭，
  // 而真正的回复要一秒后才落地（实测：46ms regenerate → 55ms 就重绘收尾）。
  // respondToTurn 里只按 id 排除自己，标成 queued 不会被它自己的打断逻辑误杀。
  db.prepare(`UPDATE turns SET status = 'queued', reply = NULL, error = NULL, finished_at = NULL WHERE id = ?`).run(turnId);
  turn.status = "queued";

  void respondToTurn(turn, { isRetry: true, collapseReply }).catch(() => {
    // 失败已写进 turns.error，这里不再重复处理。
  });
  return true;
}

/**
 * 用户主动终止这一轮：整轮抹掉，不留半截回复。
 *
 * 先在库里标 cancelled —— 跨进程时这是唯一的传达方式，跑着它的那个执行体会在
 * 下一个检查点让路（见 respondToTurn 里的 cancelIfAborted）；同进程再顺手 abort，
 * 把在飞的模型请求当场掐掉，不必等到检查点。
 * 两条路都汇到同一套取消收尾：删掉已插的气泡、不写回复、不跑记忆抽取。
 * 返回 false = 这一轮已经结束（done/failed/已取消），没什么可停的。
 */
export function cancelTurn(turnId: string): boolean {
  const turn = getTurn(turnId);
  if (!turn) return false;
  const changed = db.prepare(
    `UPDATE turns SET status = 'cancelled', error = '已手动停止', reply = NULL, finished_at = ? WHERE id = ? AND status IN ('queued','running')`,
  ).run(Date.now(), turnId);
  if (turn.contact_id) {
    const active = activeTurns.get(turn.contact_id);
    if (active && active.turnId === turnId) active.controller.abort();
  }
  return Number(changed.changes) > 0;
}

// ── 编辑已发送的消息 ──────────────────────────────────────────

function updateMessageText(id: number, text: string, attachmentsJson?: string | null): void {
  // attachmentsJson === undefined = 只改文字、附件原样不动；传值（含 null）= 覆盖。
  if (attachmentsJson === undefined) {
    db.prepare(`UPDATE messages SET text = ? WHERE id = ?`).run(text, id);
    return;
  }
  db.prepare(`UPDATE messages SET text = ?, attachments = ? WHERE id = ?`).run(text, attachmentsJson, id);
}

/** 把一条消息认领到某个处理单上（编辑没有 turn_id 的历史消息时才用得到）。 */
function attachMessageToTurn(messageId: number, turnId: string): void {
  db.prepare(`UPDATE messages SET turn_id = ? WHERE id = ?`).run(turnId, messageId);
}

/**
 * 把这一轮打回待处理，并同步它的文本。
 *
 * 为什么要同步 turns.text：它不只用于展示，`respondToTurn` 里 `recall(turn.text)`
 * 是拿它去召回记忆的。不同步的话，编辑之后会用**旧文本**去召回，召回来的东西不对题。
 *
 * 为什么顺手清 superseded_at：被编辑的这一轮是"当前正在跑的那一轮"，
 * 绝不能是失效状态——它一旦失效，状态页的"最近处理单"就查不到它了。
 */
function resetTurnForEdit(turnId: string, text: string, attachments: string[]): void {
  // 附件必须跟着一起改：respondToTurn 重放图片读的是 turns.attachments，
  // 只改消息不改处理单，会出现「气泡里图变了、她看见的还是旧图」。
  db.prepare(
    `UPDATE turns SET status = 'queued', reply = NULL, error = NULL, finished_at = NULL, superseded_at = NULL, text = ?, attachments = ? WHERE id = ?`,
  ).run(text, attachments.length > 0 ? JSON.stringify(attachments) : null, turnId);
}

/**
 * 把某条消息**之后**的一切从上下文里摘除。
 *
 * 这是「编辑后从这里重新开始对话」的核心动作。注意它**不删任何一行**，只打时间戳标记：
 * 于是历史还在（界面折叠可查、状态页可回溯），但 recentMessages() 不会再取到它们——
 * 模型从那一点开始，确实不知道后面发生过什么。
 *
 * @param exceptTurnId 不要动的处理单。传入被编辑的那一轮：它的 assistant 回复虽然
 *   在消息顺序上"在被改的那条之后"，但它正是要被重新生成的那一轮，不该被标记失效。
 *   （一开始没排除，结果那一轮既失效又在跑，状态页直接看不到它。）
 */
export function supersedeAfter(messageId: number, exceptTurnId?: string): { messages: number; turns: number } {
  return withTx(() => supersedeAfterInner(messageId, exceptTurnId));
}

function supersedeAfterInner(messageId: number, exceptTurnId?: string): { messages: number; turns: number } {
  const now = Date.now();

  // 必须按联系人收口：messages.id 是**全局**自增，不收口的话在 A 里保存一次编辑，
  // B / C 里所有更晚的消息都会被一起折叠成「被编辑取代」——
  // 「换了个联系人聊天，发现原联系人的消息被折叠了」就是这个 bug 的表现。
  const scope = db.prepare(`SELECT contact_id FROM messages WHERE id = ?`).get(messageId) as
    | { contact_id: string | null }
    | undefined;
  if (!scope) return { messages: 0, turns: 0 };
  const cid = scope.contact_id;

  // 先记下受影响的处理单：UPDATE 一旦跑过，就再也按 id 找不出它们属于哪些轮次了。
  const turnRows = db
    .prepare(`SELECT DISTINCT turn_id FROM messages WHERE id > ? AND contact_id IS ? AND turn_id IS NOT NULL`)
    .all(messageId, cid) as unknown as Array<{ turn_id: string }>;

  const messageResult = db
    .prepare(
      `UPDATE messages SET superseded_at = ?, superseded_kind = 'edit' WHERE id > ? AND contact_id IS ? AND superseded_at IS NULL`,
    )
    .run(now, messageId, cid);

  let turns = 0;
  const ids = turnRows.map((row) => row.turn_id).filter((id) => id !== exceptTurnId);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const turnResult = db
      .prepare(`UPDATE turns SET superseded_at = ? WHERE id IN (${placeholders}) AND superseded_at IS NULL`)
      .run(now, ...ids);
    turns = Number(turnResult.changes);
  }

  return { messages: Number(messageResult.changes), turns };
}

/**
 * 编辑一条自己发过的消息，并从这一点重新开始对话。
 *
 * 三步是一个动作，不能拆开做：
 *   1) 改写这条消息的文本
 *   2) 把它之后的一切标记为失效（不再进上下文）
 *   3) 重新生成这一轮的回复
 *
 * 为什么第 3 步不能省：只改文本不重新生成的话，上下文末尾留着的是"针对旧文本的回复"，
 * 模型下一轮看到的是一段自相矛盾的对话 —— 改了还不如不改。
 *
 * **记忆不回滚（有意如此）**：已经被抽取成记忆的事件保持原样。三条理由——
 *   a. 记忆是"当时真实发生过的关系事件"，你说过那句话，抽取没有错；
 *   b. 技术上要回滚就得回答"哪条记忆来自哪句话之后"，而 source_turn 只能追到轮次，强行做必然误删；
 *   c. 更要紧的是体验：用户以为自己在"改一句话"，结果连带删掉三条记忆，这是破坏性且不可预期的。
 * 想删记忆是记忆页"编辑/删除"该干的事，不该由改消息顺带完成。
 * 界面上必须把这一点说清楚，不能让用户以为改了就等于抹掉了。
 */
export function editAndRegenerate(input: { messageId: number; text: string; attachments?: string[] }): {
  turnId: string;
  superseded: { messages: number; turns: number };
} {
  const message = getMessage(input.messageId);
  if (!message) throw new Error("这条消息不存在");
  if (message.role !== "user") throw new Error("只能编辑自己说的话");
  if (message.superseded_at !== null) throw new Error("这条已经被之后的编辑取代了，改最后一条吧");

  const turnId = message.turn_id;
  const existing = turnId === null ? null : getTurn(turnId);
  // 还在生成的那一轮不许编辑：下面的 resetTurnForEdit 会把它打回 queued 再跑一遍，
  // 于是同一轮有两个执行体并发写回复（网页端 busyGuard 挡住了，第二个标签页/微信挡不住）。
  if (existing?.status === "running") {
    throw new Error("这一轮还在生成，先等它结束——或者直接发一句新的把它打断");
  }

  // 附件：不传 = 保持原样（老客户端只改文字）；传数组 = 覆盖——编辑框里删图/换图走这里。
  // getMessage 回来的 attachments 已是解析后的数组（withParsedAttachments），别再过一遍 parse。
  const oldUrls = message.attachments ?? [];
  const newUrls = input.attachments ?? oldUrls;
  const attachmentsJson = input.attachments === undefined
    ? undefined
    : (newUrls.length > 0 ? JSON.stringify(newUrls) : null);
  updateMessageText(input.messageId, input.text, attachmentsJson);

  // 顺序要紧：**先**清掉这一轮的旧回复，**再**标记失效。
  //   理由一：那条回复马上要被重新生成，它属于"被替换"而不是"被取代"，
  //   先删掉，superseded 的计数才反映真实发生的事（否则计数会虚高一条）。
  //   理由二：只清同一轮的产物，其它轮次一律不动——它们只是被标记失效，没有消失。
  if (turnId !== null && existing !== null) deleteAssistantMessagesForTurn(turnId);

  const superseded = supersedeAfter(input.messageId, turnId ?? undefined);

  let target = turnId;
  if (target === null || existing === null) {
    target = randomUUID();
    createTurn({ id: target, channel: "web", text: input.text, contactId: message.contact_id ?? DEFAULT_CONTACT_ID, attachments: newUrls });
    // 必须把这条消息认领到新处理单上。否则 respondToTurn 里的 turnHasUserMessage()
    // 会以为这一轮还没有用户消息，于是又插一条一模一样的进来 ——
    // 用户会看到自己刚改的那句话变成了两条。
    // （什么时候会遇到：编辑历史遗留的消息，比如导入的、或早期版本写下的，它们没有 turn_id。）
    attachMessageToTurn(input.messageId, target);
  } else {
    resetTurnForEdit(target, input.text, newUrls);
  }

  // 编辑里删掉的图：确认全库再无引用后落盘回收，与删消息共用同一套 GC。
  releaseMediaFiles(oldUrls.filter((u) => !newUrls.includes(u)));

  const turn = getTurn(target);
  if (turn) {
    // 故意不 await：重新生成要调模型，可能十几秒。接口要立刻把 turnId 还给前端。
    void respondToTurn(turn, { isRetry: true }).catch(() => {
      // 失败已写进 turns.error，前端轮询 /api/turn/:id 能看到。
    });
  }

  return { turnId: target, superseded };
}

/**
 * 撤回一条消息：从对话上下文里摘除，界面显示成「你撤回了一条消息」。
 *
 * 为什么只撤回**这一条**、不动她的回复：这是 IM 已有的心智——微信里对方撤回一条，
 * 你的回复照样留着。她那句回复确实是她当时说过的话，不该因为你收回了自己那句话而跟着消失。
 * （要"这一轮整个作废"那是「删除」，要"换个说法"那是「编辑」。）
 *
 * 与编辑共用 superseded 标记，区别只在 superseded_kind —— 界面按它决定
 * 是折起来（edit）还是显示成撤回提示（retract）。
 */
export function retractMessage(messageId: number): { messageId: number } {
  const message = getMessage(messageId);
  if (!message) throw new Error("这条消息不存在");
  if (message.superseded_at !== null) throw new Error("这条已经不在对话里了");

  db.prepare(`UPDATE messages SET superseded_at = ?, superseded_kind = 'retract' WHERE id = ?`).run(
    Date.now(),
    messageId,
  );

  console.log(`[agent] 撤回消息 ${messageId}`);
  return { messageId };
}

/**
 * 彻底删除一轮对话：选中那条 + 与它同处理单的其它消息，一起从库里删掉。
 *
 * 为什么按"轮"删而不是按"条"：单独删掉用户那句话、把她的回复留在那儿会得到一句悬空的回应；
 * 单独删掉她的回复，用户的话也失去了着落。一轮本就是一个完整的来回，要清就清干净。
 * 这也正是它与「撤回」的分工：
 *   撤回 = 我没说过这句（对话历史还在，可回溯）
 *   删除 = 这一轮不存在（真删行，不可恢复）
 *
 * 注意这里是**真删**，代价是失去可回溯性 —— 所以界面上必须二次确认，
 * 并且把"和撤回有什么区别"讲给用户听。
 */
export function deleteMessage(messageId: number): { messages: number; turns: number } {
  const urls = mediaUrlsOfDeletion(messageId);
  const out = withTx(() => deleteMessageInner(messageId));
  releaseMediaFiles(urls); // 事务提交后再回收，回滚时图片不会跟着丢
  return out;
}

/** 这一轮（或这条）消息引用的全部 /media 文件——删除前先记下来。 */
function mediaUrlsOfDeletion(messageId: number): string[] {
  const message = getMessage(messageId);
  const urls: string[] = [];
  const collect = (raw: unknown): void => {
    if (Array.isArray(raw)) { for (const u of raw) if (typeof u === "string") urls.push(u); return; }
    if (typeof raw !== "string" || raw === "") return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) for (const u of parsed) if (typeof u === "string") urls.push(u);
    } catch { /* 脏数据按无附件 */ }
  };
  if (message?.turn_id) {
    const rows = db.prepare(`SELECT attachments FROM messages WHERE turn_id = ?`).all(message.turn_id) as Array<{ attachments: unknown }>;
    for (const row of rows) collect(row.attachments);
  } else {
    collect(message?.attachments);
  }
  return urls;
}

function deleteMessageInner(messageId: number): { messages: number; turns: number } {
  const message = getMessage(messageId);
  if (!message) throw new Error("这条消息不存在");

  const turnId = message.turn_id;
  let messages = 0;
  let turns = 0;

  if (turnId !== null) {
    messages = Number(db.prepare(`DELETE FROM messages WHERE turn_id = ?`).run(turnId).changes);
    turns = Number(db.prepare(`DELETE FROM turns WHERE id = ?`).run(turnId).changes);
  } else {
    // 历史遗留消息没有 turn_id，只删它自己（和撤回一样只能作用于单条）。
    messages = Number(db.prepare(`DELETE FROM messages WHERE id = ?`).run(messageId).changes);
  }

  console.log(`[agent] 删除 ${messages} 条消息${turns > 0 ? `、${turns} 条处理单` : ""}`);
  return { messages, turns };
}
