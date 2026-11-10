// Agent 层：一次「收消息 → 回消息」的完整处理。
//
// 关键设计：这是"薄循环"。它只做四件事——召回记忆、拼上下文、调模型、落库。

import { randomUUID } from "node:crypto";
import { q, withTx } from "../core/db.ts";
import { config } from "../core/config.ts";
import { extractMemories, likePattern, recallExplained, recallSmart, recordExtractFailure } from "../mind/memory.ts";
import { buildSystemPrompt, toChatMessages } from "../mind/persona.ts";
import { loadToolExchanges, planToolReplay, trimToolStore } from "./tool-history.ts";
import { activeProfileId, effectiveRecentTurnsSpec, listProfiles, modelConfig, modelReadyNow, resolveToolLoopTurns } from "../settings/settings.ts";
import { callModel, callModelWithTools, callSettings, contactModelSettings, friendlyModelError, ModelError, toolCapsSettings, toolsUnsupportedFor, type CallOptions, type ChatMessage, type MessageContentPart } from "../settings/model.ts";
import { appendImageDescriptions, describeChatImages, visionHandlingFor } from "../mind/image-understanding.ts";
import { executeTool, visibleTools, toolDefsForApi, type ToolContext, type ToolResult } from "../mind/tools.ts";
import { DEFAULT_TOOL_RESULT_BUDGET } from "../mind/tool-contract.ts";
import { redactToolArguments } from "../core/secrets.ts";
import { trimDraftBeforeToolCall } from "../core/text-tool-calls.ts";
import { bannedWordsNote, parseBannedWords } from "../core/banned-words.ts";
import { ALL_TURNS, companionPromptExtras, contactCard, contactModelProfile, DEFAULT_CONTACT_ID, emoteFrequencyForContact, getContact } from "./contacts.ts";
import { assistantPermission, buildAssistantSystemPrompt, isAssistant, pinAssistantToActiveProfile, type AssistantPermission } from "../mind/assistant.ts";
import { maybeRefreshConversationSummary, maybeRefreshRecap } from "./recap.ts";
import { segmentReply } from "../core/reply-segmentation.ts";
import { mediaDataUrl, mediaTypeOfUrl, releaseMediaFiles } from "../media/media.ts";
import { emit, emitMessage, emitTurn, emitActivity } from "../core/events.ts";
import type { MessageAttachmentMeta } from "../../shared/api.ts";
import { getConversation, localConversationId, touchConversation, type Conversation } from "./conversations.ts";
import { MAX_CHAT_IMAGES } from "../../shared/limits.ts";
import { enqueueAndDeliver } from "../channels/outbound.ts";
import { getTurn, getTurnByClientId, type TurnRow } from "./turn-store.ts";
// 轮次查询已下沉：通道层只读状态，不该反过来认识整个 Agent 层。保留原导出面。
export { getTurn, getTurnByClientId } from "./turn-store.ts";
export type { TurnRow } from "./turn-store.ts";

export function createTurn(input: {
  id: string;
  channel: string;
  text: string;
  contactId: string;
  conversationId?: string;
  attachments?: string[];
  attachmentMeta?: MessageAttachmentMeta[];
  /** 平台消息 id：QQ 群/私聊的被动回复窗口与去重都靠它。 */
  triggerMessageId?: string | null;
  triggerIds?: string[];
  contextStartId?: number | null;
  /** 离线发件箱幂等键；同一联系人 + 同一键只会建出一条处理单。 */
  clientId?: string;
}): void {
  const conversationId = input.conversationId || localConversationId(input.contactId);
  q(
    `INSERT INTO turns
       (id, channel, text, contact_id, conversation_id, trigger_message_id, trigger_ids, context_start_id,
        attachments, attachment_meta, client_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    input.id,
    input.channel,
    input.text,
    input.contactId,
    conversationId,
    input.triggerMessageId ?? null,
    input.triggerIds && input.triggerIds.length > 0 ? JSON.stringify(input.triggerIds) : null,
    input.contextStartId ?? null,
    input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
    input.attachmentMeta && input.attachmentMeta.length > 0 ? JSON.stringify(input.attachmentMeta) : null,
    input.clientId || null,
    Date.now(),
  );
}

export function insertMessage(input: {
  channel: string;
  role: "user" | "assistant";
  text: string;
  kind?: "chat" | "proactive" | "tool";
  turnId?: string | null;
  contactId: string;
  /** 缺省落到联系人的本地会话，历史调用无需逐处改签名。 */
  conversationId?: string;
  senderId?: string | null;
  senderName?: string | null;
  sourceMessageId?: string | null;
  replyToMessageId?: string | null;
  atBot?: boolean;
  sourceMeta?: string | null;
  attachments?: string[];
  attachmentMeta?: MessageAttachmentMeta[];
  /** 模型这一轮的思考原文（仅用于界面折叠回看；不进上下文、不进记忆抽取）。 */
  reasoning?: string | null;
  /** 工具卡的可展开详情（仅 kind=tool 用；不进上下文回放，滚出窗口即 NULL）。 */
  toolDetail?: string | null;
  /** 工具往返的结构化存档（仅 kind=tool 用）：历史按协议回放要的就是这三样。 */
  toolCallId?: string | null;
  toolName?: string | null;
  toolArgs?: string | null;
  toolResult?: string | null;
  /** 这一版回复的生成速度（token/秒）：只挂轮内第一条气泡，界面显示用。 */
  tokensPerSec?: number | null;
}): number {
  const conversationId = input.conversationId || localConversationId(input.contactId);
  const now = Date.now();
  const result = q(
      `INSERT INTO messages
         (channel, role, text, kind, turn_id, contact_id, conversation_id, sender_id, sender_name,
          source_message_id, reply_to_message_id, at_bot, source_meta, attachments, attachment_meta, reasoning,
          tool_detail, tool_call_id, tool_name, tool_args, tool_result, tokens_per_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.channel,
      input.role,
      input.text,
      input.kind ?? "chat",
      input.turnId ?? null,
      input.contactId,
      conversationId,
      input.senderId ?? null,
      input.senderName ?? null,
      input.sourceMessageId ?? null,
      input.replyToMessageId ?? null,
      input.atBot === true ? 1 : 0,
      input.sourceMeta ?? null,
      input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
      input.attachmentMeta && input.attachmentMeta.length > 0 ? JSON.stringify(input.attachmentMeta) : null,
      input.reasoning ?? null,
      input.toolDetail ?? null,
      input.toolCallId ?? null,
      input.toolName ?? null,
      input.toolArgs ?? null,
      input.toolResult ?? null,
      input.tokensPerSec ?? null,
      now,
    );
  touchConversation(conversationId, now);
  // 事件总线：新行落库（气泡 / 工具卡）立刻推给在线订阅者，前端不必等轮询。
  // 提示通道：事件只说「有行落了」，正文由前端走 /api/messages?since= 取。
  emitMessage(input.contactId, conversationId, Number(result.lastInsertRowid));
  // 会话有新动静（供侧栏未读 / 10s 轮询退避到活跃档），与 message 成对发出。
  emitActivity(input.contactId);
  return Number(result.lastInsertRowid);
}

/**
 * 思考原文的滚动窗口：每个联系人只留最近 REASONING_WINDOW 条，其余置 NULL。
 * 抄的是调用记录全文那套（logs.ts 的 FULL_TEXT_WINDOW）——**丢的是原文，不是记录**：
 * 气泡本身永远在，滚出窗口后只是折叠条不再出现。
 * 按联系人算而不是全局：切到小猫想看联系人刚才想过什么，不该被阿米的二十轮挤掉。
 */
export const REASONING_WINDOW = 20;

export function trimReasoningWindow(contactId: string): void {
  q(
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
  q(
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
  const row = q(`SELECT COUNT(*) AS c FROM messages WHERE turn_id = ? AND role = 'user'`)
    .get(turnId) as { c: number };
  return row.c > 0;
}

/** 删掉某轮助手的回复（重试前清理，避免界面上出现两次回复）。 */
export function deleteAssistantMessagesForTurn(turnId: string): number {
  const result = q(`DELETE FROM messages WHERE turn_id = ? AND role = 'assistant'`)
    .run(turnId);
  return Number(result.changes);
}

// ── 回复多版本（swipe）─────────────────────────────────────────
// 重答一轮时旧回复不再消失：它被序列化进 turns.variants 留档，新回复追加为下一个版本，
// 用户可以在气泡下方左右切换。活跃版本的正文始终写回 messages.text ——
// 上下文回放（recentMessages）只认那一列，所以「模型看到哪个版本」与「用户选中哪个版本」天然一致。

/** 每轮最多保留的版本数：超了裁最旧的（连最初的版本一起裁，用户选过的口径）。 */
export const TURN_VARIANT_CAP = 5;

/** turns.variants 里一个版本的存档形状。texts 是落库时的分条气泡序列。 */
export type TurnVariant = {
  texts: string[];
  /** 第一颗气泡上的附件与元信息（JSON 字符串原样存档，格式与 messages 同）。 */
  attachments: string | null;
  attachment_meta: string | null;
  /** 这一版生成时的思考原文。 */
  reasoning: string | null;
  /** 这一版的生成速度（token/秒）；老存档没有这一项，按 null 处理。 */
  tokens_per_sec?: number | null;
  created_at: number;
};

/** turns.variants 是 JSON 字符串；解析失败或形状不对按「没有版本」处理，绝不抛进聊天主流程。 */
function parseTurnVariants(raw: string | null | undefined): TurnVariant[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TurnVariant => {
      if (item === null || typeof item !== "object") return false;
      return Array.isArray((item as Partial<TurnVariant>).texts);
    });
  } catch {
    return [];
  }
}

/**
 * 重答前把这一轮现有的回复气泡初始化为 variants[0]（只在没有存档时做一次）。
 * 已经有存档的轮次，库里的气泡就是 variants[variant_index] 本身，不重复存。
 * 这一轮没有回复（失败重试）时什么都不做。
 * 导出面：retryTurn 是业务入口，这个函数直接导出只为回归测试能驱动存档路径。
 */
export function ensureTurnVariants(turnId: string): void {
  const turn = getTurn(turnId);
  if (!turn || (turn.variants !== null && turn.variants !== undefined && turn.variants !== "")) return;
  const rows = q(
    `SELECT text, attachments, attachment_meta, reasoning, tokens_per_sec, created_at FROM messages
     WHERE turn_id = ? AND role = 'assistant' AND kind = 'chat' ORDER BY id ASC`,
  ).all(turnId) as Array<{ text: string; attachments: string | null; attachment_meta: string | null; reasoning: string | null; tokens_per_sec: number | null; created_at: number }>;
  if (rows.length === 0) return;
  // 附件/元信息/思考/生成速度只挂在第一颗气泡上（与落库时同一纪律），存档按同样的形状收。
  const record: TurnVariant = {
    texts: rows.map((row) => row.text),
    attachments: rows[0]?.attachments ?? null,
    attachment_meta: rows[0]?.attachment_meta ?? null,
    reasoning: rows[0]?.reasoning ?? null,
    tokens_per_sec: rows[0]?.tokens_per_sec ?? null,
    created_at: rows[0]?.created_at ?? Date.now(),
  };
  q(`UPDATE turns SET variants = ?, variant_index = 0 WHERE id = ?`)
    .run(JSON.stringify([record]), turnId);
}

/**
 * 新回复落库后把它追加为下一个版本，并把活跃指针指过去；超过封顶数裁最旧的。
 * texts 传分条后的气泡序列（重答旧轮时是整段一条）；附件/元信息/思考/生成速度只挂第一颗。
 * 导出面：同 ensureTurnVariants —— 仅为回归测试。
 */
export function appendTurnVariant(
  turnId: string,
  texts: string[],
  attachments: string | null,
  attachmentMeta: string | null,
  reasoning: string | null,
  tokensPerSec: number | null = null,
): void {
  const turn = getTurn(turnId);
  if (!turn) return;
  const list = parseTurnVariants(turn.variants);
  if (list.length === 0) return; // 不是版本化重答（普通首答/失败重试），不留档
  list.push({
    texts,
    attachments: attachments && attachments !== "" ? attachments : null,
    attachment_meta: attachmentMeta && attachmentMeta !== "" ? attachmentMeta : null,
    reasoning: reasoning || null,
    tokens_per_sec: tokensPerSec,
    created_at: Date.now(),
  });
  while (list.length > TURN_VARIANT_CAP) list.shift();
  const index = list.length - 1;
  q(`UPDATE turns SET variants = ?, variant_index = ? WHERE id = ?`).run(JSON.stringify(list), index, turnId);
  syncVariantMeta(turnId);
}

/**
 * 把版本元信息写到这一轮第一条 assistant 气泡上：前端的切换条只渲染在那里。
 * 没有存档的回复也算「1/1」——每条回复天生是自己的第 1 版，右位的生成入口常驻。
 */
export function syncVariantMeta(turnId: string): void {
  const turn = getTurn(turnId);
  const list = parseTurnVariants(turn?.variants);
  const count = Math.max(1, list.length);
  const index = list.length > 0 ? Math.min(Math.max(turn?.variant_index ?? 0, 0), count - 1) : 0;
  q(
    `UPDATE messages SET variant_index = ?, variant_count = ?
     WHERE id = (SELECT MIN(id) FROM messages WHERE turn_id = ? AND role = 'assistant' AND kind = 'chat')`,
  ).run(index, count, turnId);
}

/**
 * 切换这一轮回复的版本（swipe）：把选中版本写回气泡行。
 *
 * 与重答旧轮同一套「写回原位」纪律：切换绝不能「删掉再插」——消息表以自增 id 当时间轴，
 * 重插会让这条回复掉到整段对话末尾，后面那些轮次当场对不上。所以第一颗气泡行原地 UPDATE，
 * 多余的分条气泡删掉；只有这一轮仍是该联系人最新一轮时，多气泡版本才补插到末尾（那里本来就是末尾）。
 * 工具卡与其它 assistant 行一并清掉：它们属于被换下的那次生成，与旧版本成对。
 */
export function setTurnVariant(turnId: string, index: number): { applied: boolean } {
  // 整个切换包进单事务：里面是 DELETE + 两条 UPDATE + 补插若干气泡，散着提交
  // 就是四五次 WAL fsync——弱盘/杀毒机器上一次几十毫秒，乘起来就是用户说的
  // 「切换要加载好一会」。一并入闸：中途抛错整体回滚，不会切一半留半截。
  return withTx(() => {
    const turn = getTurn(turnId);
    if (!turn) throw new Error("处理单不存在");
    if (turn.status === "running") throw new Error("这一轮还在生成中，先等它结束");
    if (turn.superseded_at !== null && turn.superseded_at !== undefined) {
      throw new Error("这一轮已被编辑取代，切换不了版本");
    }
    const list = parseTurnVariants(turn.variants);
    if (list.length === 0) throw new Error("这一轮没有可切换的历史版本");
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
      throw new Error("版本序号超出范围");
    }
    if (index === (turn.variant_index ?? 0)) return { applied: false };

    const contactId = turn.contact_id ?? DEFAULT_CONTACT_ID;
    const conversationId = turn.conversation_id || localConversationId(contactId);
    const variant = list[index];
    if (variant === undefined) throw new Error("版本序号超出范围");
    const first = q(
      `SELECT id FROM messages WHERE turn_id = ? AND role = 'assistant' AND kind = 'chat' ORDER BY id ASC LIMIT 1`,
    ).get(turnId) as { id: number } | undefined;
    if (!first) throw new Error("这一轮的回复已经不在了，切换不了版本");
  // 分条气泡合回整段：历史标记/上下文回放看到的就是这一版完整的话。
  const joined = variant.texts.length === 1 ? variant.texts[0] ?? "" : variant.texts.join("\n\n");
  // 仍是最新一轮时补插分条气泡（跟随原版本的打字节奏形状），首行只写第一段；
  // 较早的轮次保持整段一条（与重答旧轮同一套写回原位纪律），写合并后的整段。
  const resplit = variant.texts.length > 1 && isLatestTurnOfContact(contactId, turnId);
  q(`DELETE FROM messages WHERE turn_id = ? AND role = 'assistant' AND id <> ?`).run(turnId, first.id);
  q(
    `UPDATE messages SET text = ?, attachments = ?, attachment_meta = ?, reasoning = ?, tokens_per_sec = ?, variant_index = ?, variant_count = ? WHERE id = ?`,
  ).run(
    resplit ? variant.texts[0] ?? "" : joined,
    variant.attachments, variant.attachment_meta, variant.reasoning, variant.tokens_per_sec ?? null, index, list.length, first.id,
  );
  if (resplit) {
    for (let i = 1; i < variant.texts.length; i += 1) {
      insertMessage({
        channel: turn.channel, role: "assistant", text: variant.texts[i] ?? "", turnId, contactId, conversationId,
      });
    }
  }
  q(`UPDATE turns SET reply = ?, variant_index = ? WHERE id = ?`).run(joined, index, turnId);
  emitMessage(contactId, conversationId, first.id);
  return { applied: true };
  });
}

/**
 * 最近若干【轮】消息，用来拼上下文（一问一答算一轮，轮以 user 消息为边界）。
 *
 * ⚠️ 这里的 `superseded_at IS NULL` 是「编辑后从这里重新开始对话」的**真正实现**。
 * 如果编辑只改文本、不在这里过滤，界面看着是改了，模型却照样看得见被改掉的那段话——
 * 那就是自欺欺人。上下文过滤必须发生在这一个地方，而不是在界面上做样子。
 */
/** 这段会话聊了多少轮（活着的 user 消息数）：按会话比例回放时要拿它当分母。 */
export function countLiveTurns(contactId: string, conversationId = localConversationId(contactId)): number {
  return (q(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND conversation_id = ? AND superseded_at IS NULL AND kind != 'tool' AND role = 'user'`)
    .get(contactId, conversationId) as { c: number }).c;
}

/** 生效回放轮数：联系人覆盖 > 全局应用内覆盖 > .env > 默认（与模型绑定同一套分层）。
 *  返回 ALL_TURNS(-1) 表示这位要带全部历史。
 *  features.turnPct > 0 时它优先：带「这段会话总轮数 × 百分比」的最近轮 ——
 *  轮数是固定形状，比例会随这段关系聊了多久自己伸缩。
 *  联系人没覆盖时走全局 spec（比例/全部/轮数三态，判序与联系人级同构）。 */
export function effectiveRecentTurnsFor(contactId: string, conversationId = localConversationId(contactId)): number {
  const c = getContact(contactId);
  const pct = c?.features.turnPct ?? 0;
  if (pct > 0) return Math.max(1, Math.ceil(countLiveTurns(contactId, conversationId) * pct / 100));
  const t = c?.recent_turns ?? 0;
  if (t === ALL_TURNS) return ALL_TURNS;
  if (t > 0) return t;
  const spec = effectiveRecentTurnsSpec();
  if (spec.kind === "all") return ALL_TURNS;
  if (spec.kind === "pct") return Math.max(1, Math.ceil(countLiveTurns(contactId, conversationId) * spec.pct / 100));
  return spec.turns;
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
  limitTurns?: number,
  /** 只取到这条消息为止（含），重答较早一轮时用它截断窗口。 */
  upToMessageId?: number | null,
  conversationId = localConversationId(contactId),
): Array<{
  id: number; role: string; text: string; attachments: string | null; attachment_meta?: string | null; turn_id: string | null;
  sender_id?: string | null; sender_name?: string | null; at_bot?: number;
}> {
  const turns = limitTurns ?? effectiveRecentTurnsFor(contactId, conversationId);
  const live = `contact_id = ? AND conversation_id = ? AND superseded_at IS NULL AND kind != 'tool'`;
  const cap = upToMessageId === undefined || upToMessageId === null ? "" : " AND id <= ?";
  const capArgs: number[] = cap === "" ? [] : [upToMessageId as number];
  // attachment_meta 随行：联系人自己的图不回放原图，meta.label 是历史标记里"发过哪张"的唯一线索。
  const cols = `id, role, text, attachments, attachment_meta, turn_id, sender_id, sender_name, at_bot`;
  const boundary = turns === ALL_TURNS ? undefined : q(`SELECT id FROM messages WHERE ${live}${cap} AND role = 'user' ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(contactId, conversationId, ...capArgs, Math.max(1, turns) - 1) as { id: number } | undefined;
  return (boundary
    ? q(`SELECT ${cols} FROM messages WHERE ${live}${cap} AND id >= ? ORDER BY id ASC`).all(contactId, conversationId, ...capArgs, boundary.id)
    : q(`SELECT ${cols} FROM messages WHERE ${live}${cap} ORDER BY id ASC`).all(contactId, conversationId, ...capArgs)
  ) as unknown as Array<{
    id: number; role: string; text: string; attachments: string | null; attachment_meta?: string | null; turn_id: string | null;
    sender_id?: string | null; sender_name?: string | null; at_bot?: number;
  }>;
}

// 消息行的形状是前后端契约，唯一真源在 shared/api.ts。
import type { MessageRow } from "../../shared/api.ts";

export type { MessageRow };

const MESSAGE_COLUMNS = "id, role, text, kind, created_at, superseded_at, superseded_kind, contact_id, conversation_id, sender_id, sender_name, source_message_id, reply_to_message_id, at_bot, attachments, attachment_meta, turn_id, reasoning, tool_detail, variant_index, variant_count, tokens_per_sec";

/** attachments / attachment_meta 存的是 JSON 字符串；下发前解析，脏数据按无附件处理。 */
function withParsedAttachments(row: MessageRow & { attachments: unknown; attachment_meta?: unknown }): MessageRow {
  let list: string[] | null = null;
  let meta: MessageAttachmentMeta[] | null = null;
  if (typeof row.attachments === "string" && row.attachments !== "") {
    try {
      const parsed: unknown = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) list = parsed.filter((u): u is string => typeof u === "string" && u.startsWith("/media/"));
    } catch { /* 存坏了就当没附件 */ }
  }
  if (typeof row.attachment_meta === "string" && row.attachment_meta !== "") {
    try {
      const parsed: unknown = JSON.parse(row.attachment_meta);
      if (Array.isArray(parsed)) {
        meta = parsed.filter((item): item is MessageAttachmentMeta => {
          if (item === null || typeof item !== "object") return false;
          const v = item as Partial<MessageAttachmentMeta>;
          return typeof v.url === "string" && v.url.startsWith("/media/")
            && (v.kind === "image" || v.kind === "video" || v.kind === "audio" || v.kind === "file");
        });
      }
    } catch { /* 老数据或损坏数据按无元信息处理 */ }
  }
  return { ...row, attachments: list, attachment_meta: meta };
}

/** turns.attachment_meta 与 messages 同格式；缺少/损坏时返回 undefined。 */
function parseStoredAttachmentMeta(raw: unknown): MessageAttachmentMeta[] | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const list = parsed.filter((item): item is MessageAttachmentMeta => {
      if (item === null || typeof item !== "object") return false;
      const v = item as Partial<MessageAttachmentMeta>;
      return typeof v.url === "string" && v.url.startsWith("/media/")
        && (v.kind === "image" || v.kind === "video" || v.kind === "audio" || v.kind === "file");
    });
    return list.length > 0 ? list : undefined;
  } catch { return undefined; }
}

/**
 * 聊天窗口的两档大小：首屏 500 条、每点一次「载入更早」再回 200 条。
 * 只有这一处定义——从前界面用 `返回行数 >= 200` 反推「还有没有下一页」，
 * 那个 200 在前后端各写一遍，改一边就悄悄失效（改成 300 后前端会以为到底了）。
 * 现在由服务端直接下发还剩多少条更早的没进界面。
 */
export const CHAT_FIRST_PAGE = 500;
export const CHAT_EARLIER_PAGE = 200;

export function messagesSince(contactId: string, sinceId: number, limit = 100, conversationId = localConversationId(contactId)): MessageRow[] {
  const rows = q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .all(contactId, conversationId, sinceId, limit) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments);
}

/** 这一位库里总共有多少条消息（含已失效的）——界面上那句「共 N 条」。 */
export function countMessagesFor(contactId: string, conversationId = localConversationId(contactId)): number {
  const row = q(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND conversation_id = ?`)
    .get(contactId, conversationId) as { c: number };
  return row.c;
}

/** 比 beforeId 更早的还有多少条——决定「载入更早」要不要继续显示、上面报什么数。 */
export function countMessagesBefore(contactId: string, beforeId: number, conversationId = localConversationId(contactId)): number {
  const row = q(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND conversation_id = ? AND id < ?`)
    .get(contactId, conversationId, beforeId) as { c: number };
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
    ? q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE turn_id = ? ORDER BY id ASC`)
        .all(turnId) as unknown as Array<MessageRow & { attachments: unknown }>
    : q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE turn_id = ? AND contact_id = ? ORDER BY id ASC`)
        .all(turnId, contactId) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments);
}

/**
 * 从某条消息往回取一页——「载入更早的消息」入口。
 *
 * 为什么需要全量模式（all=1）：编辑会让**已经渲染过的**消息变成失效态，而增量拉取
 * （id > since）看不到旧消息的状态变化，所以编辑之后必须整体重绘一次。
 */
export function messagesBefore(contactId: string, beforeId: number, limit = CHAT_EARLIER_PAGE, conversationId = localConversationId(contactId)): MessageRow[] {
  const rows = q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(contactId, conversationId, beforeId, limit) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments).reverse();
}

export type MessageHit = { id: number; contact_id: string; role: string; text: string; created_at: number };

/** 全历史搜索（微信式「我上周说的那句话在哪」）：只搜仍在对话里的活跃消息。 */
export function searchMessages(text: string, limit = 50): MessageHit[] {
  return q(
      `SELECT id, contact_id, role, text, created_at FROM messages
       WHERE superseded_at IS NULL AND kind != 'tool' AND text LIKE ? ESCAPE '\\'
         AND contact_id IN (SELECT id FROM contacts WHERE archived_at IS NULL)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(likePattern(text), limit) as unknown as MessageHit[];
}

export function allMessages(contactId: string, limit = CHAT_FIRST_PAGE, conversationId = localConversationId(contactId)): MessageRow[] {
  const rows = q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT ?`)
    .all(contactId, conversationId, Math.min(1000, Math.max(1, limit))) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments).reverse();
}

/** 会话内搜索：只在当前联系人、仍有效且不是工具卡的正文里找。 */
export function searchMessagesForContact(contactId: string, text: string, limit = 200, conversationId = localConversationId(contactId)): MessageRow[] {
  const rows = q(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE contact_id = ? AND conversation_id = ? AND superseded_at IS NULL AND kind != 'tool' AND text LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(contactId, conversationId, likePattern(text), Math.min(500, Math.max(1, limit))) as unknown as Array<MessageRow & { attachments: unknown }>;
  return rows.map(withParsedAttachments);
}

/** 搜索命中不在当前窗口时，取命中消息前后各半页，直接把它带进视口。 */
export function messagesAround(contactId: string, messageId: number, limit = 160, conversationId = localConversationId(contactId)): MessageRow[] | null {
  const anchor = q("SELECT id FROM messages WHERE id = ? AND contact_id = ? AND conversation_id = ?")
    .get(messageId, contactId, conversationId) as { id: number } | undefined;
  if (!anchor) return null;
  const cap = Math.min(300, Math.max(40, limit));
  const beforeLimit = Math.floor(cap / 2) + 1;
  const before = q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND conversation_id = ? AND id <= ? ORDER BY id DESC LIMIT ?`)
    .all(contactId, conversationId, messageId, beforeLimit) as unknown as Array<MessageRow & { attachments: unknown }>;
  const after = q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE contact_id = ? AND conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .all(contactId, conversationId, messageId, cap - before.length) as unknown as Array<MessageRow & { attachments: unknown }>;
  return [...before.reverse(), ...after].map(withParsedAttachments);
}

export function getMessage(id: number): (MessageRow & { turn_id: string | null }) | null {
  const row = q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`)
    .get(id) as (MessageRow & { turn_id: string | null; attachments: unknown }) | undefined;
  return row === undefined ? null : (withParsedAttachments(row) as MessageRow & { turn_id: string | null });
}

/**
 * 启动清扫：进程崩溃/重启时留在 queued|running 的 turn 永远不会有人认领，
 * 且 retryTurn 拒绝 running——不扫就等于永久卡死。统一标 failed（可重试）。
 * 返回受影响条数。
 */
export function sweepStaleTurns(): number {
  const result = q(`UPDATE turns SET status = 'failed', error = '服务重启时这一轮没有跑完，可重试', finished_at = ? WHERE status IN ('queued', 'running')`)
    .run(Date.now());
  return Number(result.changes);
}

/** 状态页用的：最近若干条处理单，用于发现"卡住的处理"和"失败的处理"。offset 供翻页。 */
/** 某条消息属于哪个联系人。找不到返回 null。 */
export function contactOfMessage(messageId: number): string | null {
  const row = q("SELECT contact_id FROM messages WHERE id = ?").get(messageId) as { contact_id: string | null } | undefined;
  return row?.contact_id ?? null;
}

/**
 * 最近的处理单。contactId 省略 = 全局（状态页要的就是跨联系人的总览）；
 * 传了 = 只看这一个联系人的轮次——聊天页的失败横幅靠它，
 * 不过滤就会把别人的失败轮当成"本会话上一条回复失败了"，重试还会重跑别人的轮。
 */
export function recentTurns(
  limit = 15,
  offset = 0,
  contactId?: string,
  conversationId?: string,
  opts: { activeOnly?: boolean } = {},
): TurnRow[] {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const safeOffset = Math.max(0, offset);
  // 条件按需拼：contactId / conversationId 逐级收窄，activeOnly 只留在飞（queued/running）的轮。
  // activeOnly 是聊天页接管在飞处理单用的：重答**较早**轮次时，那一轮的 created_at 还是它
  // 当初的时间，按 created_at DESC 取“最新一条”永远看不到它——只能按状态查。
  const conds = ["superseded_at IS NULL"];
  const params: Array<string | number> = [];
  if (contactId !== undefined) { conds.push("contact_id = ?"); params.push(contactId); }
  if (conversationId !== undefined) { conds.push("conversation_id = ?"); params.push(conversationId); }
  if (opts.activeOnly) conds.push("status IN ('queued','running')");
  return q(
      `SELECT id, channel, text, status, reply, error, created_at, finished_at, contact_id, conversation_id
       FROM turns WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, safeLimit, safeOffset) as unknown as TurnRow[];
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
  const counts = q(`SELECT status, COUNT(*) AS c FROM turns WHERE superseded_at IS NULL GROUP BY status`)
    .all() as unknown as Array<{ status: string; c: number }>;
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of counts) {
    byStatus[row.status] = row.c;
    total += row.c;
  }

  const latency = q(
      `SELECT AVG(finished_at - created_at) AS avg_ms FROM turns
       WHERE status = 'done' AND finished_at IS NOT NULL AND superseded_at IS NULL`,
    )
    .get() as { avg_ms: number | null };
  const lastFail = q(`SELECT MAX(finished_at) AS t FROM turns WHERE status = 'failed' AND superseded_at IS NULL`)
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
 * 用户上一次说话是什么时候——主动性闸门用它算"静默时长"。
 *
 * 必须排除失效消息：如果你把"我今天在忙"编辑成了别的话，
 * 那句被改掉的话不该继续影响"联系人该不该主动找你"的判断。
 */
export function lastUserMessageAt(contactId: string, conversationId = localConversationId(contactId)): number | null {
  const row = q(
      `SELECT created_at FROM messages WHERE contact_id = ? AND conversation_id = ? AND role = 'user' AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(contactId, conversationId) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

/**
 * 跨会话口径的「用户上次说话是什么时候」。
 * 「该不该主动开口」判断的是这个人，不是某段会话：用户在 QQ 私聊里一分钟前刚说过话，
 * 静默时长就不该按本机会话算成"三天没聊"——那个数会直接进主动判断的提示词。
 * 「说什么」仍按目标会话取（见 recentMessages 的 conversationId），两层口径各管各的。
 */
export function lastUserMessageAtAnyConversation(contactId: string): number | null {
  const row = q(
      `SELECT MAX(created_at) AS at FROM messages WHERE contact_id = ? AND role = 'user' AND superseded_at IS NULL`,
    )
    .get(contactId) as { at: number | null } | undefined;
  return row?.at ?? null;
}

/** token 粗估：中日韩字符按 1 字 1 token，其余按 4 字符 1 token。只用于占用展示，不做计费。
 *  系统提示词、工具定义、整段历史在裁剪循环里会被反复重估（trimHistoryToBudget 每丢一轮
 *  全量再算一遍），结果按文本内容缓存：同一段文字永远是同一个数，重估就是 Map 命中。 */
const TOKEN_CACHE_MAX = 2048;
const tokenCache = new Map<string, number>();

export function estimateTokens(text: string): number {
  const hit = tokenCache.get(text);
  if (hit !== undefined) {
    tokenCache.delete(text);
    tokenCache.set(text, hit);
    return hit;
  }
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
  const value = cjk + Math.ceil(other / 4);
  // 超长文本（几千字的整包 prompt）缓存收益低、占位大，超过 4096 字不存。
  if (text.length <= 4096) {
    tokenCache.set(text, value);
    if (tokenCache.size > TOKEN_CACHE_MAX) {
      const oldest = tokenCache.keys().next().value as string | undefined;
      if (oldest !== undefined) tokenCache.delete(oldest);
    }
  }
  return value;
}

/** 一张图按 1000 token 估。服务商不给精确数，量级对就够判断占比了。 */
const IMAGE_TOKENS = 1000;
/** 视觉卡兜底时每张图最多注入 700 字描述，按 700 token 保守估算。 */
const DESCRIPTION_TOKENS = 700;

/**
 * 「输入上限」没填时的保守估算。往低了估是故意的：估低了只是少带几轮历史（联系人说话照样
 * 连贯），估高了会直接 400 发不出去。主流云端模型普遍 ≥128K，而且这类档一般会填上限，
 * 32K 不会误伤它们；真正需要被保护的是没填上限的本地小窗口模型。
 */
const FALLBACK_INPUT_LIMIT = 32_000;

/** 预算留 8% 余量：token 数是粗估（CJK 1:1、工具往返未计），别贴着上限发。 */
const BUDGET_HEADROOM = 0.92;

/**
 * 一次聊天请求最多直接内联 6 张用户原图。
 *
 * 不按字节限制：图片体积只作为请求体大小的事实记录，不再决定“能看几张”。
 * 选择顺序固定为：本轮新图 → 最新历史图 → 更老的历史图，填满 6 张即停；
 * 其余图片不丢弃，由 `describeChatImages` 生成 alt 描述后注入。
 */
export function selectReplayImages(
  rows: Array<{ role: string; attachments: string | null }>,
  currentUrls: string[] = [],
  maxImages: number = MAX_CHAT_IMAGES,
): Set<string> {
  const picked = new Set<string>();
  const limit = Math.max(0, Math.trunc(maxImages));
  const add = (url: string): boolean => {
    if (picked.size >= limit) return false;
    picked.add(url);
    return true;
  };
  for (const url of currentUrls) {
    if (!add(url)) return picked;
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.role !== "user") continue;
    // 同一条消息里后发的图更新，倒序处理，保证新的先占名额。
    for (const url of parseImageAttachments(row.attachments).reverse()) {
      if (picked.has(url)) continue;
      if (!add(url)) return picked;
    }
  }
  return picked;
}

/** 这批行里出现的所有用户图片（去重，保持从新到旧的语义由调用方决定）。 */
export function userImageUrls(rows: Array<{ role: string; attachments: string | null }>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.role !== "user") continue;
    for (const url of parseImageAttachments(row.attachments)) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** 这批行里有几张图会进入模型上下文。裁剪决策与圆环展示必须用同一个数。 */
export function countReplayedImages(
  rows: Array<{ role: string; attachments: string | null }>,
  replay: ReadonlySet<string>,
): number {
  let n = 0;
  for (const row of rows) {
    if (row.role !== "user") continue;
    for (const url of parseImageAttachments(row.attachments)) {
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

/** 合并后的模型消息取回纯文本，供 token 估算——估算必须和真发出去的形状一致。
 *  工具往返的 arguments 也算进去：参数（尤其是 web_fetch 的 url、generate_image 的 prompt）
 *  同样是发出去的字，漏算会让圆环比真实请求小一截。 */
function textsOf(msgs: ChatMessage[]): Array<{ text: string }> {
  return msgs.map((m) => ({
    text: (typeof m.content === "string" ? m.content : "")
      + (m.tool_calls === undefined ? "" : m.tool_calls.map((call) => call.function.arguments).join("")),
  }));
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
  visionMode?: "inline" | "describe" | "none";
  /** 显式总图片 token；给定时优先于 imageCount × 单张估算。 */
  imageTokens?: number;
}): ContextParts {
  let historyTokens = 0;
  for (const row of input.history) historyTokens += estimateTokens(row.text) + 2;
  const bareTokens = estimateTokens(input.systemBare);
  return {
    system: bareTokens,
    memory: Math.max(0, estimateTokens(input.systemFull) - bareTokens),
    tools: estimateTokens(input.toolsJson),
    history: historyTokens,
    images: input.imageTokens ?? input.imageCount * (input.visionMode === "describe" ? DESCRIPTION_TOKENS : IMAGE_TOKENS),
  };
}

export function contextTotal(parts: ContextParts): number {
  return parts.system + parts.memory + parts.tools + parts.history + parts.images;
}

/**
 * 丢掉最旧的一轮（轮以 user 消息为边界，连同联系人随后的回复与工具往返）。
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
  /** 图片处理方式：主模型内联 / 视觉卡识别注入 / 完全看不到。 */
  visionMode: "inline" | "describe" | "none";
  /** 本次纳入上下文的用户图片张数。 */
  imageCount: number;
  limit: number;
  /** limit 来自保守估算而非模型真实窗口——界面必须说破，否则用户以为那是天花板。 */
  limitIsFallback: boolean;
  /**
   * 这些数字是按哪一份模型档算的（绑定档 > 当前生效档；解析不到时为 null）。
   * 界面靠 id 让「去设置」直接落到这一档——同名的档很多（hy3 / 本地中转 · agent2api/hy3），
   * 只说「去设置填输入上限」会把人送到全局在用的那一档，改完了圆环照样是 32K。
   */
  profile: { id: string; label: string } | null;
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
export function contextUsage(contactId: string, conversationId?: string): ContextUsage {
  const cid = contactId === "" ? DEFAULT_CONTACT_ID : contactId;
  const convId = conversationId || localConversationId(cid);
  const history = recentMessages(cid, undefined, null, convId);
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const card = contactCard(cid);
  const lastAt = lastUserMessageAt(cid, convId);
  // 陪伴增强段两边同给：它们的开销进 system 项，不该被记到"记忆召回"头上。
  // includeNow 与 respondToTurn 同源：圆环量的是"下一次发消息会带什么"。
  const conv = getConversation(convId);
  const companion = {
    ...companionPromptExtras(getContact(cid), history[0]?.id),
    ...(conv?.summary ? { conversationSummary: conv.summary } : {}),
  };
  const includeNow = getContact(cid)?.features?.clock !== false;
  const bare = buildSystemPrompt([], { character: card, lastUserAt: lastAt, companion, includeNow });
  // 观测路径用 recallExplained（不写 last_used_at）：圆环随消息轮询刷新，
  // 走真实 recall 会把「近 7 天被想起」统计刷成"用户打开了页面"，而不是"联系人想起过"。
  // 必须带空间：不带 scope 时 memory.ts 完全不过滤，圆环会把别的群、别的成员的记忆
  // 也算进"联系人下次会想起"，量出来的记忆项比真实的多一截。
  // 群里的下一句由谁说还不知道，所以只收到会话这一层（global + 本群），不猜成员。
  const full = buildSystemPrompt(
    lastUser ? recallExplained(cid, lastUser.text, undefined, { scope: { conversationId: convId } }).events : [],
    { character: card, lastUserAt: lastAt, companion, includeNow },
  );
  // 量的是真会发出去的那份工具定义：可见性按联系人不同，不带 cid 会算错。
  // 图片处理分两档：主模型能看图时最多 6 张原图内联；其余图片统一生成 alt 描述注入。
  // 主模型不能看图时，所有图片都走视觉卡 alt；两者都没有才放“看不到”标记。
  const settings = contactModelSettings(cid) ?? modelConfig();
  const visionMode = visionHandlingFor(cid);
  const directReplay = visionMode === "inline" ? selectReplayImages(history, []) : new Set<string>();
  const allImages = userImageUrls(history);
  const described = visionMode === "none"
    ? new Set<string>()
    : new Set(allImages.filter((url) => !directReplay.has(url)));
  // 聊天轮永远走聊天档，带不带图都不再改变工具门控。
  const toolsOn = settings.caps.tools === true;
  const toolsJson = toolsOn ? JSON.stringify(toolDefsForApi(cid)) : "[]";
  // 与 respondToTurn 同一口径：圆环量的是「下一次真会发出去的东西」，私聊同样不加昵称前缀。
  const replaySource = <T extends { sender_name?: string | null }>(rows: T[]): T[] =>
    conv?.kind === "group" ? rows : rows.map((row) => ({ ...row, sender_name: null }));
  const proxied = imageProxiedHistory(replaySource(history), directReplay, visionMode !== "none");
  const budget = inputBudget(settings);
  // 与 settings/model.ts 的 attribution 同一口径：联系人绑了档就是它，没绑才是全局当前生效档。
  const profileId = contactModelProfile(cid) || (activeProfileId() ?? "");
  const profileRow = profileId === "" ? null : listProfiles().find((p) => p.id === profileId) ?? null;
  // 与 respondToTurn 同一套：历史占比上限也要在圆环这边生效，否则"设置里限了、圆环不认"。
  const histCap = historyTokenCapFor(cid, settings);
  // 与 respondToTurn 同一套：估算按合并气泡后的形状算，圆环才不会和真实请求对不上。
  const imageTokensOf = (rows: typeof proxied): number =>
    countReplayedImages(rows, directReplay) * IMAGE_TOKENS
    + countReplayedImages(rows, described) * DESCRIPTION_TOKENS;
  // 工具往返也进历史：圆环量的是"下一次真会发出去的东西"，少算这一段
  // 就会出现「圆环显示 40%、请求却被判超长」那种对不上的事故。
  // 端点不支持 tools 时与 respondToTurn 同一口径：只给备注，不给原生往返。
  const toolExchanges = loadToolExchanges(cid, convId, history.map((row) => row.turn_id));
  const toolReplayOf = (rows: typeof proxied) =>
    planToolReplay(rows, toolExchanges, {
      nativeTurns: toolsOn && !toolsUnsupportedFor(settings) ? config.toolHistoryTurns : 0,
    });
  const measureParts = (rows: typeof proxied) =>
    contextParts({ systemBare: bare, systemFull: full, toolsJson, history: textsOf(toChatMessages(rows, toolReplayOf(rows))), imageCount: countReplayedImages(rows, directReplay), visionMode, imageTokens: imageTokensOf(rows) });
  const { kept, droppedTurns } = trimHistoryToBudget(proxied, (rows) => {
    const q = measureParts(rows);
    return contextTotal(q) <= budget.room && q.history <= histCap;
  });
  const p = contextParts({ systemBare: bare, systemFull: full, toolsJson, history: textsOf(toChatMessages(kept, toolReplayOf(kept))), imageCount: countReplayedImages(kept, directReplay), visionMode, imageTokens: imageTokensOf(kept) });
  const parts = [
    { key: "system", label: "系统提示词", tokens: p.system },
    { key: "memory", label: "记忆召回", tokens: p.memory },
    { key: "tools", label: "工具定义", tokens: p.tools },
    { key: "history", label: "对话历史", tokens: p.history },
    { key: "images", label: "图片处理", tokens: p.images },
  ].filter((part) => part.tokens > 0);
  // 截断可见化（纪律 #3）：最近 N 轮之外的消息不会进上下文，用户必须看得见。
  // 轮数以 user 消息为边界；开头自发/主动消息不单独计轮。
  const liveTurns = (q(`SELECT COUNT(*) AS c FROM messages WHERE contact_id = ? AND superseded_at IS NULL AND kind != 'tool' AND role = 'user'`)
    .get(cid) as { c: number }).c;
  const settingTurns = history.filter((m) => m.role === "user").length;
  // 「全部」这一档要能看见代价：整段历史（不受回放窗口限制）按同一套合并口径估的 token。
  // 只算文本，与圆环里的「对话历史」同一口径；图片另有一部分，不受此项影响。
  // 工具往返这里只取窗口内的那几轮：更早的轮次在上下文里只剩一行备注（几十字），
  // 为它们把整段历史的工具行全捞一遍，等于每刷一次圆环就扫一次全表。
  const allRows = replaySource(recentMessages(cid, ALL_TURNS, null, convId));
  const replayTurns = toolsOn && !toolsUnsupportedFor(settings) ? config.toolHistoryTurns : 0;
  const tailTurnIds = [...new Set(allRows.map((row) => row.turn_id))]
    .slice(-Math.max(1, replayTurns))
    .filter((id): id is string => typeof id === "string");
  const fullHistoryTokens = textsOf(toChatMessages(allRows, planToolReplay(
    allRows,
    loadToolExchanges(cid, convId, tailTurnIds),
    { nativeTurns: replayTurns },
  ))).reduce((a, m) => a + estimateTokens(m.text) + 2, 0);
  return {
    model: settings.name,
    limit: budget.limit,
    limitIsFallback: budget.isFallback,
    profile: profileRow ? { id: profileRow.id, label: profileRow.label } : null,
    used: contextTotal(p),
    parts,
    visionMode,
    imageCount: countReplayedImages(kept, directReplay) + countReplayedImages(kept, described),
    turns: kept.filter((m) => m.role === "user").length,
    totalTurns: liveTurns,
    fullHistory: { turns: liveTurns, tokens: fullHistoryTokens },
    recentTurnsSetting: effectiveRecentTurnsFor(cid, convId),
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
 * 落一张 kind=tool 的**过程卡**——界面能看见联系人在查，过程不再是黑箱。
 * messages 表里联系人"说的话"仍然只有最终回复（思考过程依旧不回放）。
 *
 * 降级：端点不支持 function calling（第一次调用即 400/422）→ 整轮回退为无工具的单次
 * 生成，并记住降级状态（model.ts 内），后续轮次不再撞墙。echo 模式同理直接单次。
 *
 * 轮数不再是常量：助手固定 8 轮，普通联系人走全局设置（见 settings.resolveToolLoopTurns）。
 * 这里的“轮”是一次带工具定义的模型请求，不是一次工具调用；同一请求可发起多个工具。
 * 因为联网这一档的活天然是多步流水，3 轮连一件事都做不完就被强制收口。
 */

/** 工具卡的一句摘要：按工具给用户能看懂的话，而不是甩 JSON。 */
export function toolSummary(name: string, result: unknown): string {
  if (name === "get_current_time") {
    // 工具返回的是 text（完整的一句「日期 周几 时分；现在是…」），没有 iso 字段。
    const r = result as { text?: string } | null;
    const clock = typeof r?.text === "string" ? r.text.split("；")[0]?.trim() ?? "" : "";
    return clock !== "" ? clock : "查了当前时间";
  }
  if (name === "search_memory") {
    // 记忆检索返回的是 events（不是 results），以前读错字段导致永远显示「没找到」。
    const r = result as { events?: unknown[] } | null;
    const n = Array.isArray(r?.events) ? r!.events!.length : 0;
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
  if (name === "send_voice") {
    // 结果形状 { via, native, note }；说了什么要从卡片本身的 args 拿不到，摘要只报「发了」。
    return "发了一条语音";
  }
  if (name === "emote_search") {
    const r = result as { candidates?: unknown[] } | null;
    const n = Array.isArray(r?.candidates) ? r!.candidates!.length : 0;
    return n > 0 ? `翻了翻表情库，挑出 ${n} 张候选` : "翻了翻表情库，没找到贴切的";
  }
  if (name === "send_emote") {
    // executeTool 会把带 files 的返回值拆开，这里拿到的是内层 { via, native, note }；
    // 没拆的分支（业务失败 / 只回候选）也一起认，别把任何一种甩成 JSON。
    const r = result as {
      ok?: boolean; error?: string; sent?: boolean; candidates?: unknown[];
      via?: string; native?: boolean; note?: string; label?: string;
    } | null;
    if (r?.ok === false) return `表情没发出去：${r.error ?? "原因不明"}`;
    // keyword 不够确定时工具没有发图，只列候选让模型挑——不算失败，但别说成「发了」。
    if (r?.sent === false) {
      const n = Array.isArray(r.candidates) ? r.candidates.length : 0;
      return n > 0 ? `挑了 ${n} 张候选，没替你定` : "没找到合适的表情，没发";
    }
    if (r?.via === "native" || r?.via === "media") return "把表情发到 QQ 了";
    // 官方渠道 face/mface 降级成文字/emoji（via=text）与应用端 face 降级（app-emoji-fallback）
    // 都不是「发了张表情」，别让卡片说成发了。
    if (r?.via === "app-emoji-fallback" || r?.via === "text") return "用 emoji 回了个表情";
    // 卡片标签本来就写着「发了张表情」，摘要再说一遍就成了「发了张表情 · 发了张表情」。
    // 有名字时把名字摆出来，用户/模型都能记住这轮到底甩了哪张。
    if (typeof r?.label === "string" && r.label.trim() !== "") return `「${r.label.trim().slice(0, 20)}」`;
    return "发了张表情";
  }
  if (name === "app_status") return "读取了应用当前配置状态";
  if (name === "configure_capability" || name === "set_preference") {
    const r = (result ?? {}) as {
      ok?: boolean; error?: string; label?: string; profile?: string;
      emoteFrequency?: string; toolLoopTurns?: number;
    };
    if (r.ok === false) return `没做成：${r.error ?? "原因不明"}`;
    if (name === "configure_capability") return `配好了「${r.label ?? ""}」的端点档「${r.profile ?? ""}」`;
    const bits: string[] = [];
    if (typeof r.emoteFrequency === "string") bits.push(`表情频率 ${r.emoteFrequency}`);
    if (typeof r.toolLoopTurns === "number") bits.push(`工具轮次 ${r.toolLoopTurns}`);
    return `改了全局偏好：${bits.join("、")}`;
  }
  if (name === "configure_model" || name === "activate_model") {
    // configure_model 回 {label, activated:boolean}；activate_model 回 {activated:"档名"}——
    // 两个工具的形状不同，以前按同一套字段读，切模型那张卡会显示「已启用模型「」」。
    const r = result as { ok?: boolean; label?: string; activated?: boolean | string; error?: string } | null;
    if (!r?.ok) return `失败：${r?.error ?? "未知原因"}`;
    const label = r.label ?? (typeof r.activated === "string" ? r.activated : "");
    return name === "configure_model"
      ? `已${r.activated === true ? "保存并启用" : "保存"}模型「${label}」`
      : `已启用模型「${label}」`;
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
    const r = result as { kind?: string; query?: string; count?: number; preview_count?: number } | null;
    const n = typeof r?.count === "number" ? r.count : 0;
    const shown = typeof r?.preview_count === "number" ? r.preview_count : n;
    const what = r?.kind === "image" ? "图" : "结果";
    if (n === 0) return `搜了「${(r?.query ?? "").slice(0, 20)}」，没找到${what}`;
    // 搜索条数与真正能看见的预览数是两件事；有图床失败时必须说清，别让 8 条变成"8 张都已显示"。
    if (r?.kind === "image" && shown < n) {
      return `搜了「${(r?.query ?? "").slice(0, 20)}」，找到 ${n} 条图，${shown} 张预览可用`;
    }
    return `搜了「${(r?.query ?? "").slice(0, 20)}」，找到 ${n} 条${what}`;
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
  if (name === "manage_extensions" || name === "import_extension" || name === "edit_extension_tool" || name === "set_script_gate") {
    const r = (result ?? {}) as {
      ok?: boolean; error?: string; needsConfirmation?: { title?: string };
      id?: string; created?: boolean; allowScripts?: boolean; deleted?: string;
      extensions?: unknown; diagnostics?: unknown; action?: string; tools?: unknown[];
    };
    // confirm 档下这不是失败：凭证在用户手里，卡片该说「等你点」，而不是一片红字。
    if (r.needsConfirmation !== undefined) return `已发出确认卡片：${r.needsConfirmation.title ?? "等用户点了再继续"}`;
    if (r.ok === false) return `没做成：${r.error ?? "原因不明"}`;
    if (name === "import_extension") return `${r.created === true ? "导入" : "更新"}了扩展「${r.id ?? ""}」`;
    if (name === "set_script_gate") return r.allowScripts ? "已开启 JS 工具执行许可" : "已关闭 JS 工具执行许可";
    if (name === "manage_extensions") {
      if (typeof r.deleted === "string") return `删除了扩展「${r.deleted}」`;
      if (Array.isArray(r.extensions)) return "查看了扩展清单与诊断";
      if (Array.isArray(r.diagnostics)) return `重连了扩展「${r.id ?? ""}」`;
      return `调整了扩展「${r.id ?? ""}」的开关`;
    }
    return r.action === "delete" ? "删除了一个扩展工具" : "保存了扩展工具";
  }
  // 兜底绝不回灌原始 JSON：以前 send_emote 没登记时，工具卡上直接显示
  // 「做了点事 · {"via":"native","native":true,"note":"…"}」——那是给模型的载荷，不是给用户的话。
  // 未登记的工具（尤其是动态扩展）至少报出名字，别用一句「执行完成」盖住它做了什么；
  // 静态工具漏登记由 toolPoolDiagnostics() 在启动时提醒。
  const r = (result ?? {}) as { ok?: unknown; error?: unknown };
  if (r.ok === false || typeof r.error === "string") return `没做成：${String(r.error ?? "原因不明")}`;
  return `「${name}」执行完成`;
}

/**
 * 「软失败」的识别已上移到 executeTool → normalizeToolOutcome：工具自报
 * {ok:false,error} 与扩展的 {error:"…"} 都在统一入口判成 ok:false，卡片直接用
 * result.ok / result.error。从前这里的一层补丁只会漏掉不带 ok 字段的错误形状。
 */

/** 工具卡只有一行：失败原因若是一整段给模型的操作指引，只留第一句，别把卡片撑成一面墙。 */
function cardFailureSummary(text: string): string {
  const first = text.split(/[。；\n]/)[0]?.trim() ?? "";
  const one = first !== "" ? first : text.trim();
  return one.length > 60 ? one.slice(0, 60) + "…" : (one || "执行失败");
}

/**
 * 工具卡「可展开详情」的正文：给人回看这次到底查到了什么，不是回灌给模型的载荷。
 * 每种工具渲染成人话，并对总长封顶（详情会落库、随聊天列表下发，绝不能塞整页网页）。
 * 返回空串表示这类工具没有值得展开的细节（调用方据此不写 tool_detail，卡片也就不可点）。
 */
const TOOL_DETAIL_MAX_CHARS = 1500;
/**
 * 一条回复最多挂几张图。以前是 1，导致「QQ 里收到 N 条表情、应用气泡只显示第一张」。
 * 3 是业内反复出现的阈值（微信 3 张起折叠、Discord sticker ≤3、Telegram album 2–10）。
 * 真正的「整轮门控」在 tools.ts:executeTool，这里只负责展示侧不再硬砍到一张。
 */
export const MAX_REPLY_IMAGES = 3;

/**
 * 三种「工具带回来的图」要分开算，混在一起就会丢表情：
 * - produced：generate_image / send_voice 自己产出的媒体，工具描述约定一轮一张，投递也只带一张；
 * - appEmote：应用端 send_emote 挂的气泡附件（via=app-attachment），整轮门控已限 3 张，
 *   这里不该再被「一轮一张」砍一刀；它们没进 QQ，镜像投递时要带上；
 * - channelDelivered：QQ 会话里 send_emote 已原生发出，只挂气泡，绝不重发。
 *
 * 2026-11-05 翻车现场：一轮发了 3 张表情，工具卡 3 次「发了张表情」，气泡却只有 1 张图——
 * 因为 app-attachment 走的是 produced 队列，被 slice(0, 1) 砍掉了后两张。
 * 返回值：bubbleImages 是展示侧附件，deliveryImages 是要镜像发进渠道的那批。
 */
export function replyAttachmentBuckets(input: {
  producedFiles: string[];
  appEmoteFiles: string[];
  channelDeliveredFiles: string[];
}): { bubbleImages: string[]; deliveryImages: string[] } {
  const outgoingImages = input.producedFiles.slice(0, 1);
  const appEmoteImages = input.appEmoteFiles.slice(0, MAX_REPLY_IMAGES);
  return {
    bubbleImages: [...outgoingImages, ...appEmoteImages, ...input.channelDeliveredFiles].slice(0, MAX_REPLY_IMAGES),
    deliveryImages: [...outgoingImages, ...appEmoteImages].slice(0, MAX_REPLY_IMAGES),
  };
}

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
    // 与 toolSummary 同一处坑：记忆检索的结果字段叫 events。
    const hits = Array.isArray(r.events) ? (r.events as Array<Record<string, unknown>>) : [];
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
 * 为什么挂在**工具卡**上而不是联系人这条回复的附件上：用户要的是「先看看这几张、再挑一张」。
 * 走附件那条路，8 张候选会变成"联系人一口气发了 8 张图"，语义完全变了，
 * 而且联系人真正设好头像那条回复反而看不出差别。
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
 * 工具参数回传前脱敏已下沉到 core/secrets.ts：与 logs.ts 共用同一条字段规则，
 * 且改成**递归**（从前只遍历顶层，嵌在 manifest.mcp.headers 里的密钥会漏）。
 *
 * 为什么必须脱敏：助手工具 `configure_model` 的 arguments 里带着用户刚贴的 apiKey，
 * 协议要求把 assistant.tool_calls 原样回传下一轮，那份密钥会跟着每一轮请求发给
 * 当前生效的服务商——而那家可能正是用户想替换掉的那家。
 */

/**
 * 工具结果进上下文前的体积上限。
 *
 * ⚠️ 为什么必须有：`trimHistoryToBudget()` 在循环**开始前**就跑完了，而工具结果是
 * 循环里一条条追加的——`load_skill` 允许 24000 字正文、`web_fetch` 最多回 10000 字，
 * 都发生在裁剪之后。于是一个小窗口模型（本地 8K、或输入上限 32K 的档）上，
 * 一道完全合规的配置就能让每一轮都超长：guardOverflow 只会去丢最旧的**历史轮**
 * （约两百 token），对着两万字的工具载荷杯水车薪，重试两次后本轮直接失败。
 * 更糟的是多轮累积：8 轮循环各带一份就是十几万字符，中间没有任何一道闸门。
 *
 * 截断时明确告诉联系人"还有但没给"，别让联系人以为看到的就是全部——否则联系人会基于半份资料下结论。
 *
 * 预算按工具可配（ToolDef.resultBudget）：默认 4000 字，读网页/加载技能这类
 * 天生大载荷的工具单独放宽。**工具的 description 里承诺的上限必须与这里一致**——
 * 从前 web_fetch 说最多 20000 字、实际一律砍到 4000，模型按一份不存在的资料作答。
 */
function capToolResult(value: unknown, toolName: string, budget: number = DEFAULT_TOOL_RESULT_BUDGET): string {
  const limit = Math.max(200, Math.min(100_000, Math.round(budget)));
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return JSON.stringify({
    truncated: true,
    tool: toolName,
    note: `这个工具的返回太长了（原文 ${text.length} 字），这里只给前 ${limit} 字。就按这些判断，还想要更多就换个更具体的问法。`,
    partial: kept,
  });
}

async function runAgentLoop(
  turn: TurnRow,
  system: string,
  history: ChatMessage[],
  signal?: AbortSignal,
  /** 思考内容终态出口（多轮工具调用可能各带一段）：只给界面折叠用，绝不回灌进对话。 */
  onReasoning?: (text: string, tokens: number) => void,
  /** 思考流式出口：本次调用累计推理，和已完成轮次的推理拼成整轮实时草稿。 */
  onReasoningDraft?: (text: string) => void,
  /** 工具产出的文件（出图/语音）出口：循环里每产一件就交出去，由调用方挂到这条回复的附件上。 */
  onFiles?: (urls: string[], metas?: MessageAttachmentMeta[]) => void,
  /** 工具已自行发进渠道的文件出口（send_emote 原生表情）：挂气泡用，但通道投递要跳过，防同一张图发两遍。 */
  onChannelDeliveredFiles?: (urls: string[], metas?: MessageAttachmentMeta[]) => void,
  /**
   * 应用端表情附件出口（send_emote via=app-attachment）。工具已经把图挂到这条回复上，
   * 但它不是「出图」：整轮最多 3 张由 tools.ts 的门控负责，这里不能再用出图的一轮一张裁剪。
   * 与 onChannelDeliveredFiles 的区别：应用端图没进 QQ，镜像投递时仍要带走它们。
   */
  onAppEmoteFiles?: (urls: string[], metas?: MessageAttachmentMeta[]) => void,
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
  /** 发起这一轮时定下的助手权限；后续轮内切档不影响本轮。 */
  assistantPermissionSnapshot?: AssistantPermission,
): Promise<string> {
  const base: ChatMessage[] = [{ role: "system", content: system }, ...history];
  // 温度：联系人设过就用联系人的，没设（-1）就留给 model.ts 的全局默认（0.8）。
  const temp = getContact(turn.contact_id ?? DEFAULT_CONTACT_ID)?.features.temperature ?? -1;
  // 多轮工具调用各自会产出一段推理。已完成轮次固定下来，当前轮跟着流式增量更新，
  // UI 始终拿到「这轮到目前为止」的完整思考，而不是等最终落库才突然出现。
  const completedReasoning: string[] = [];
  let currentReasoning = "";
  const publishReasoningDraft = (): void => {
    const parts = [...completedReasoning];
    const live = currentReasoning.trim();
    if (live !== "") parts.push(live);
    onReasoningDraft?.(parts.join("\n\n"));
  };
  const options: CallOptions = {
    purpose: "chat" as const,
    // 故意不传 maxTokens：回复长度该由模型档上的「输出上限」决定，
    // 写死在这里等于让那个设置永远失效（见 model.ts 的 resolveMaxTokens）。
    turnId: turn.id,
    contactId: turn.contact_id ?? DEFAULT_CONTACT_ID,
    ...(temp >= 0 ? { temperature: temp } : {}),
    ...(signal ? { signal } : {}),
    ...(onReasoning || onReasoningDraft ? {
      onReasoning: (text: string, tokens: number): void => {
        const part = text.trim();
        if (part !== "") completedReasoning.push(part);
        currentReasoning = "";
        onReasoning?.(text, tokens);
        publishReasoningDraft();
      },
      onReasoningDelta: (accumulated: string): void => {
        currentReasoning = accumulated;
        publishReasoningDraft();
      },
    } : {}),
    ...(onDraft ? { onDelta: onDraft } : {}),
  };

  // 就绪判定必须用这次请求真正会走的配置：联系人绑定档、能力专用档都可能
  // 覆盖全局模型。门控三道闸：模型档 caps.tools（硬闸）、端点协议探测、
  // 这一位**实际声明出来的工具清单**（联系人总开关 features.tools 与逐个工具开关
  // 都在 toolDefsForApi 里收口）——清单为空就不走工具路径，别给端点发空 tools 数组
  // （部分服务商对 tools: [] 直接 400）。
  const contactId = turn.contact_id ?? DEFAULT_CONTACT_ID;
  // 权限和工具清单在同一点快照：一轮开始后即使界面切档，本轮仍按启动时的规则跑完。
  const permissionSnapshot = isAssistant(contactId)
    ? (assistantPermissionSnapshot ?? assistantPermission())
    : undefined;
  const effective = callSettings(options);
  // 门控读哪份 caps 由 toolCapsSettings 统一裁决：能力显式绑档=空 caps（不带）、
  // 能力隐式回落主模型端点=按联系人聊天档意图、普通调用=请求落到的配置本身。
  // 本轮工具池只算一次：声明与逐个执行共用同一份快照。既省掉每次 executeTool 现扫
  // 技能目录/读 kv 的开销，也保证一轮里工具池被改动时前后调用看到同一个世界。
  const turnTools = visibleTools(contactId, permissionSnapshot);
  const declaredTools = toolDefsForApi(contactId, permissionSnapshot, turnTools);
  // 模型没就绪（演示模式/密钥缺失）就别进循环：callModel 自己会回那句"先接模型"的提示。
  if (!modelReadyNow(effective)) {
    return guardOverflow(base, () => callModel(base, options));
  }
  /* 其余三种情况——没有可声明的工具、模型档没开工具调用、端点被探测为不支持 tools——
     从前直接短路成一次 `callModel`，**连工具循环都不进**。可这恰恰是最需要兼容解析的一条路：
     端点没收到 tools 声明，Hermes / Qwen 模板的模型仍会把调用写进正文（见 text-tool-calls.ts），
     真实表现就是"联系人说已经搜到 6 张图了"，而工具一次没跑、界面上一张图都没有。
     现在照常进循环，只是把空清单传下去：callModelWithTools 见到空 tools 会走无工具分支，
     但那一条分支同样会认正文形式的调用。别给端点发 tools: []——部分服务商直接 400。 */

  const conversationId = turn.conversation_id || localConversationId(contactId);
  const context: ToolContext = {
    lastUserAt: lastUserMessageAt(contactId, conversationId),
    contactId,
    conversationId,
    turnId: turn.id,
    assistantPermission: permissionSnapshot,
  };
  const messages: ChatMessage[] = [...base];
  // 让路检查：没传（抽取/主动性那些副通道）就退化成只看 signal。
  const shouldYield = cancelIfAborted ?? ((): boolean => signal?.aborted === true);
  // 助手固定 8 轮，普通联系人统一跟全局：见 settings.ts 里「为什么它不再是常量」。
  // “轮”统计的是带工具定义的模型请求；同一请求里的多个工具调用只算一轮。
  const maxToolLoopTurns = resolveToolLoopTurns(isAssistant(contactId));

  try {
    for (let toolLoopTurn = 0; toolLoopTurn < maxToolLoopTurns; toolLoopTurn += 1) {
      // 每轮开工前先让路：用户按了「停止」、或另一个窗口 barge-in 进来了，就停在这一轮开头。
      // 少了这个检查点，取消只会杀死在飞的那一次模型调用，而本轮剩下的工具调用照旧跑完——
      // 包括花钱的 generate_image（十几秒 + 一张配额）和会建真实任务的 schedule_reminder。
      // 跨进程取消只能靠库侧标记传达到这里，所以走 cancelIfAborted 而不是只看 signal。
      if (shouldYield()) return "";
      const response = await guardOverflow(messages, () => callModelWithTools(messages, declaredTools, options));

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
      // ── 同轮工具调用的执行策略 ──
      // 独立工具（搜记忆 / 查时间 / 联网 / 技能 / 扩展）互不依赖：原来逐个 await，
      // 整轮延迟 = 各工具延迟**之和**（搜索 3s + 出图 15s = 18s 起步）；现在并批跑，
      // 整轮延迟 = 最慢那一个。
      // 出图单列串行轨：十几秒一发 + 每日配额闸门（imagesToday/IMAGE_DAILY_LIMIT），
      // 两张并行等于一次烧掉两份额度——昂贵独占操作不做「省事」的并行。
      // 让路检查保留三处：批前（已取消就整批不发）、批后（在飞的不追回，已画出的图不丢）、
      // 出图串行轨的逐个之间（原语义）。
      type ToolCallItem = { id: string; name: string; args: string };
      const calls = response.toolCalls as ToolCallItem[];
      const EXPENSIVE_TOOL_NAMES = new Set(["generate_image"]);
      const slots: Array<{ call: ToolCallItem; started: number; result: ToolResult | null; elapsedMs: number }> =
        calls.map((call) => ({ call, started: 0, result: null, elapsedMs: 0 }));
      const runSlot = async (slot: (typeof slots)[number]): Promise<void> => {
        slot.started = Date.now();
        slot.result = await executeTool(slot.call.name, slot.call.args, context, turnTools);
        slot.elapsedMs = Date.now() - slot.started;
      };
      if (shouldYield()) return "";
      // 独立批：并发上限 4。不设限的话 8 轮里一次带 8 个扩展工具 / 多条 web_fetch，
      // 出网门（web.ts）与本地读盘会被同时打满，收益（再省几秒）远小于风险。
      const parallelSlots = slots.filter((slot) => !EXPENSIVE_TOOL_NAMES.has(slot.call.name));
      {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(4, parallelSlots.length) }, async () => {
          for (;;) {
            const next = parallelSlots[cursor];
            cursor += 1;
            if (next === undefined) return;
            await runSlot(next);
          }
        });
        await Promise.all(workers);
      }
      // 昂贵轨：串行 + 逐个让路（原语义）。
      for (const slot of slots.filter((s) => EXPENSIVE_TOOL_NAMES.has(s.call.name))) {
        if (shouldYield()) return "";
        await runSlot(slot);
      }
      // 按模型**声明顺序**消费：tool_call_id 一对一，界面工具卡的先后要跟着调用顺序走，
      // 不能跟着完成顺序走（搜索 3s 先回、出图 15s 后回，界面上却要是「先出图后搜索」）。
      const interrupted = shouldYield();
      for (const slot of slots) {
        const call = slot.call;
        const result = slot.result as ToolResult;
        // 工具产物（出图）当场交出去挂到这条回复上。已画出的图即使在飞中被取消也不丢。
        // 三条队列各走各的（见 replyAttachmentBuckets）：QQ 原生已发的不重发；应用端表情
        // 单独一队，别混进出图队列被「一轮一张」砍掉；其余才是出图/语音。
        if (result.ok && result.attachments && result.attachments.length > 0) {
          if (result.deliveredToChannel === true) onChannelDeliveredFiles?.(result.attachments, result.attachmentMeta);
          else if (call.name === "send_emote") onAppEmoteFiles?.(result.attachments, result.attachmentMeta);
          else onFiles?.(result.attachments, result.attachmentMeta);
        }
        console.log(`[agent] 工具 ${call.name} → ${result.ok ? "ok" : `失败：${result.error}`}`);
        // 回传模型的那份结果与存档的那份必须是**同一个字符串**：历史回放时逐字复现，
        // 两次各自截断一次就会出现「上一轮看到 4000 字、下一轮回放成 8000 字」的错位。
        // executeTool 已把四种历史返回形状归一成 ToolResult：result 永远是完整载荷
        //（失败时仍带 hint / candidates），ok 只是卡片与日志的判别位。
        const toolResultText = capToolResult(
          result.result,
          call.name,
          turnTools.find((t) => t.name === call.name)?.resultBudget,
        );
        // 工具卡实时落库：界面能"看见联系人在查"，过程不再是黑箱。
        // kind=tool 的行不进 recentMessages（正文回放用它），但工具往返靠这几列单独取——
        // 历史里要让模型看见真正的 assistant.tool_calls + tool 结果，而不是一句正文占位符。
        insertMessage({
          channel: turn.channel,
          role: "assistant",
          kind: "tool",
          turnId: turn.id,
          contactId,
          // 必须跟着这一轮的会话：群轮次的过程卡要留在群里。缺省会落进联系人的主私聊
          // （见 insertMessage 的 `|| localConversationId`），于是群里看不到联系人查了什么，
          // 私聊反倒被外来的卡占满。
          conversationId,
          text: JSON.stringify({
            tool: call.name,
            ok: result.ok,
            summary: result.ok ? toolSummary(call.name, result.result) : cardFailureSummary(result.error ?? "执行失败"),
            elapsedMs: slot.elapsedMs,
          }),
          toolDetail: result.ok ? (toolDetail(call.name, result.result) || null) : null,
          // 搜到的候选图挂在这张卡上（不是挂到联系人的回复上）：见 toolAttachments 的注释。
          attachments: result.ok ? toolAttachments(call.name, result.result) : [],
          // 结构化往返：调用 id / 名字 / 脱敏后的参数 / 结果。
          // 参数必须脱敏后再落库——它和回传服务商用的是同一条规则（见 redactToolArguments）。
          toolCallId: call.id,
          toolName: call.name,
          toolArgs: redactToolArguments(call.args),
          toolResult: toolResultText,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResultText,
        });
      }
      // 批后让路：已执行的工具产物已挂上（上面的循环），不再进入下一轮模型调用。
      if (interrupted) return "";
    }

    // 轮数用尽仍没给最终回复：保留全部工具消息，只追加一句收口指令。
    // 以前这里把 role='tool' 和带 tool_calls 的 assistant 消息一起过滤掉，剩下的就是 base——
    // 等于让联系人把刚查到的资料全忘掉、重新回答原问题，多轮搜索白做。
    // 不再传 tools（callModel 本来就不带），所以保留工具历史也不会触发新一轮调用。
    messages.push({
      role: "user",
      content: "（本轮可用于工具调用的模型轮次已经用完。请直接根据上面已经拿到的结果回答我，不要再调用工具，也不要说自己没查到。）",
    });
    return await guardOverflow(messages, () => callModel(messages, options));
  } catch (error) {
    // 端点不支持 tools：回退为无工具单次生成（callModelWithTools 已置降级标记）。
    // 超长不算"不支持"——换成无工具请求照样超长，只会把一条能看懂的报错变成看不懂的。
    if (
      error instanceof ModelError
      && (error.status === 400 || error.status === 422)
      && error.code !== "CONTEXT_OVERFLOW"
    ) {
      console.warn("[agent] 端点不支持工具调用，本轮回退为无工具生成");
      // 历史里可能带着上一轮回放的原生往返（assistant.tool_calls + tool 消息）。
      // 对不认 tools 的端点，那些消息正是 400 的来源，必须一起剥掉再发一次，
      // 否则"回退"会在同一个地方再撞一次墙。
      return callModel(stripToolReplay(base), options);
    }
    throw error;
  }
}

/** 把历史里的工具往返剥成纯文本：给不认 tools 的端点兜底用（备注与正文都保留）。 */
function stripToolReplay(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") continue;
    if (msg.tool_calls === undefined) {
      out.push(msg);
      continue;
    }
    const text = typeof msg.content === "string" ? msg.content : "";
    // 只有调用请求、没有正文的那条直接丢掉；有正文的保留正文、去掉 tool_calls。
    if (text.trim() === "") continue;
    out.push({ role: msg.role, content: text });
  }
  return out;
}

/** 改联系人的一条回复文本（不重新生成、不动后续）。返回 false = 这条不存在或不是有效回复。 */
export function updateAssistantText(id: number, text: string): boolean {
  const res = q(
    `UPDATE messages SET text = ? WHERE id = ? AND role = 'assistant' AND kind = 'chat' AND superseded_at IS NULL`,
  ).run(text, id);
  if (res.changes === 0) return false;
  // 手改的文字同步回版本存档里活跃的那份：不然用户改完一切正常，左右一切版本，手改就丢了。
  const row = q(`SELECT turn_id FROM messages WHERE id = ?`).get(id) as { turn_id: string | null } | undefined;
  if (row?.turn_id) {
    const turn = getTurn(row.turn_id);
    const list = parseTurnVariants(turn?.variants);
    const idx = turn?.variant_index ?? 0;
    if (list.length > 0 && list[idx] !== undefined) {
      list[idx] = { ...list[idx], texts: [text] };
      q(`UPDATE turns SET variants = ? WHERE id = ?`).run(JSON.stringify(list), row.turn_id);
    }
  }
  return true;
}

/**
 * 只改这一句**用户消息**的文字：不作废任何后续、不重新生成。
 *
 * 与 editAndRegenerate 的差别就是「重放」那一步 —— 多数人改的是错字，
 * 不该因为改一个字就把后面整段对话抹掉重答。
 * 顺带把处理单上的 text 一起改掉：那一行才是联系人下次重答这一轮时喂给模型的原文，
 * 只改 messages 会让界面改对了、重答却按旧话回答。
 */
export function updateUserMessageText(id: number, text: string): boolean {
  const row = q(`SELECT turn_id FROM messages WHERE id = ? AND role = 'user' AND superseded_at IS NULL`)
    .get(id) as { turn_id: string | null } | undefined;
  if (!row) return false;
  q(`UPDATE messages SET text = ? WHERE id = ?`).run(text, id);
  if (row.turn_id) q(`UPDATE turns SET text = ? WHERE id = ?`).run(text, row.turn_id);
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

/** 只有图片走视觉重放；语音/视频绝不能被当成图片打上“看不见”的标记。 */
function parseImageAttachments(raw: string | null | undefined): string[] {
  return parseAttachments(raw).filter((url) => /\.(png|jpe?g|webp|gif|avif)$/i.test(url));
}

/** 图片理解能力没配好：联系人连用户这轮刚发的图都看不见。别和"太久了"混为一谈——那是两句不同的实话。 */
const NO_VISION_REASON = "图片理解能力没配置，你看不到内容——直接向用户说明你看不了，别猜也别编";

function imageMark(reason: string, count: number): string {
  return `[图片${count > 1 ? ` ×${count}` : ""}：${reason}]`;
}

/**
 * 看不见的**用户**图换成一行文字说明；replay 里的图以 base64 真图发出，一个字都不用附。
 *
 * 联系人自己发的图**不往正文里塞说明**。从前这里拼一行
 * 「[图片：这是你自己发出的图，原图不回放给你——记住你当时发了什么就行，别装作看得见图里细节]」，
 * 那是给系统看的备注，却以 assistant 台词的形态出现在历史里；模型下一轮会照着抄，
 * 实测回复里原样冒出整段提示词。发过什么由工具往返/备注告诉模型就够了。
 * 只有纯图消息（正文为空）留一个极短的锚点，免得回放里出现一条空 assistant 消息。
 *
 * 「别猜也别编」不是废话：实测给联系人一句图片摘要，联系人会**凭摘要推断出摘要里没有的细节**，
 * 还说成「从图上看」（问「水槽里有没有泡着的碗」，摘要没写，联系人答「似乎有，还有洗洁精的泡沫」）。
 * 三次收紧提示词都没压住；压住它的是把真图重放给联系人看。所以看不见的图必须明说看不见，
 * 给二手信息反而不如不给。
 *
 * 导出是为了冒烟能直接断言：这里曾经只处理纯图消息（text === ""），
 * "文字 + 图"的消息会把图**静默丢掉**，联系人既看不见图也不知道有图。
 */
export function imageProxiedHistory<T extends { role?: string; text: string; attachments: string | null; attachment_meta?: string | null }>(
  rows: T[],
  replay: ReadonlySet<string>,
  visionOn: boolean,
): T[] {
  return rows.map((row) => {
    const hidden = parseImageAttachments(row.attachments).filter((url) => !replay.has(url));
    if (hidden.length === 0) return row;
    // 自己发的图：有正文就完全不动（别给模型一段可复述的占位符台词）；
    // 纯图消息留一个极短的锚点，避免回放里出现 content 为空的 assistant 消息。
    if (row.role === "assistant") {
      if (row.text !== "") return row;
      const labels = ownImageLabels(row.attachment_meta, hidden);
      return { ...row, text: labels !== "" ? `（发过${labels}）` : "（发过一张图）" };
    }
    if (visionOn) return row;
    const mark = imageMark(NO_VISION_REASON, hidden.length);
    return { ...row, text: row.text === "" ? mark : `${row.text}\n${mark}` };
  });
}

/** 从 attachment_meta 里抠出这些 url 的 label（表情包的词/文件名），拼成「『在看』『摸鱼』」样式。 */
function ownImageLabels(metaRaw: string | null | undefined, urls: string[]): string {
  if (metaRaw === null || metaRaw === undefined || metaRaw === "") return "";
  let list: Array<{ url?: unknown; label?: unknown }> = [];
  try { const parsed: unknown = JSON.parse(metaRaw); if (Array.isArray(parsed)) list = parsed as Array<{ url?: unknown; label?: unknown }>; } catch { return ""; }
  const labels = urls
    .map((url) => list.find((m) => m.url === url)?.label)
    .filter((l): l is string => typeof l === "string" && l.trim() !== "")
    .map((l) => `「${l.trim()}」`);
  return labels.join("");
}

/** 每联系人同一时刻只允许一轮在飞：新轮开始即打断旧轮（barge-in）。 */
const activeTurns = new Map<string, { turnId: string; controller: AbortController }>();

/**
 * 流式草稿的落点：把「联系人正在写的这一句」按节流写进 turns.reply，只在这一轮还活着的时候写。
 *
 * 为什么是 turns.reply 而不是 messages 行：`/api/messages` 的增量按 `id > since` 取
 * （server.ts:1101），**已经存在的行永远不会被重新下发**——半截话写进消息行界面根本看不见。
 * 而 `/api/turn/:id` 早就带 reply 字段，前端 watch 每 900ms 打它一次（ChatView 的 watch），
 * 草稿搭这趟车：不新增端点、不新增请求数。别的窗口靠 checkTurnState 接上同一轮也看得见，
 * 因为草稿在库里，不在某个进程的内存或某条连接上——这正是它比"浏览器直连 SSE"
 * 更合这套多窗口共库架构的地方（SSE 连接只能绑死在起跑那个进程上）。
 *
 * 交出去的是**本次调用的累计正文**，不是整轮累计：工具轮也常带正文，
 * 把它和最终回复拼成一句会变成联系人在改口。
 */
function draftWriter(turnId: string, contactId: string, conversationId: string): (text: string) => void {
  let lastWrite = 0;
  // 已随 SSE 发出的累计正文：增量帧的基准。与库里那份独立——库是断线重连后的
  // 对齐真源，帧是给活着的观众省 RTT 的。
  let sent = "";
  return (text) => {
    const now = Date.now();
    // 流式一帧几十毫秒一片，逐片写库等于给 WAL 一道持续小洪峰；200ms 一次足够看出联系人在写。
    if (now - lastWrite < 200) return;
    lastWrite = now;
    // 正文形式的工具调用（见 text-tool-calls.ts）在实时打字时会闪出一整段 XML。
    // 草稿只留到 <tool_call> 之前：调用块是写给机器的，不该出现在"联系人正在写"的那口气里。
    const draft = trimDraftBeforeToolCall(text);
    // 条件写：状态一旦离开 running（取消、收尾、被别的进程判死），迟到的帧就写不进去，
    // 不会把草稿复活成"看起来像定稿"。
    q(`UPDATE turns SET reply = ? WHERE id = ? AND status = 'running'`).run(draft, turnId);
    // 同一节流点顺路发流式帧：库与帧同源同步，断档回源对齐不会有缝。
    // 前缀续写发 delta（总量 O(n)）；改口/截断发全量快照，客户端整段替换。
    // emit 内部永不抛错也永不阻塞，主流程不受这条辅路影响。
    if (draft !== sent) {
      const seq = bumpDraftSeq(turnId, "reply");
      if (sent !== "" && draft.startsWith(sent)) {
        emit({ type: "draft", contactId, conversationId, turnId, seq, delta: draft.slice(sent.length) });
      } else {
        emit({ type: "draft", contactId, conversationId, turnId, seq, text: draft });
      }
      sent = draft;
    }
  };
}

/**
 * 流式帧的轮内序号登记表：/api/turn 的响应要带回「当前发到第几帧」，
 * 客户端轮询对齐后才能无缝续接增量。键是 turnId；每轮每字段独立从 1 递增。
 * 结束后的残留条目无害（路由只在 status=running 时才读它），封顶 128 条 LRU 淘汰，
 * 重答复用同一 turnId 时序号从当前值继续——客户端按「seq 必须恰好 +1」续帧，
 * 对不上就回源全量，所以不依赖归零。
 */
const draftSeqs = new Map<string, { reply: number; reasoning: number }>();

function bumpDraftSeq(turnId: string, field: "reply" | "reasoning"): number {
  const cur = draftSeqs.get(turnId) ?? { reply: 0, reasoning: 0 };
  cur[field] += 1;
  draftSeqs.set(turnId, cur);
  if (draftSeqs.size > 128) draftSeqs.delete(draftSeqs.keys().next().value as string);
  return cur[field];
}

/** 查一轮当前的流式帧序号（/api/turn 响应带回；不在跑或没登记过返回 null）。 */
export function draftSeqOf(turnId: string): { reply: number; reasoning: number } | null {
  return draftSeqs.get(turnId) ?? null;
}

/**
 * 思考草稿的落点：和 draftWriter 同一套节流、同一套条件写，但走单独的 reasoning_draft 列。
 * 思考常常在正文之前就先流出来；共用 reply 会把正文写成半截推理，等正文到了还会互相覆盖。
 */
function reasoningDraftWriter(turnId: string, contactId: string, conversationId: string): (text: string) => void {
  let lastWrite = 0;
  let sent = "";
  return (text) => {
    const now = Date.now();
    if (now - lastWrite < 180) return;
    lastWrite = now;
    q(`UPDATE turns SET reasoning_draft = ? WHERE id = ? AND status = 'running'`).run(text, turnId);
    // 与正文帧同一套协议（thought 类型，seq 独立计数）：多轮工具的推理是
    // 「已完成段 + 当前段」拼接，天然前缀续写走 delta；新一轮开头重算时发快照。
    if (text !== sent) {
      const seq = bumpDraftSeq(turnId, "reasoning");
      if (sent !== "" && text.startsWith(sent)) {
        emit({ type: "thought", contactId, conversationId, turnId, seq, delta: text.slice(sent.length) });
      } else {
        emit({ type: "thought", contactId, conversationId, turnId, seq, text });
      }
      sent = text;
    }
  };
}

/**
 * 这一轮回复的生成速度（token/秒），挂在第一颗气泡上给界面显示。
 *
 * 数据源是 model_calls：agent 循环里**最后一次成功的 chat 调用**就是产出最终回复的那一次
 * （前面的轮次都是工具调用轮），它的 completion_tokens / elapsed_ms 即速度——
 * elapsed 含首字等待与思考生成时间，所以这是"整体出字速度"，与主流聊天 UI 的口径一致。
 * 服务商没回 usage（部分网关流式不带）时退回 estimateTokens 估算：数字是估的，量级是真的。
 * echo（演示模式）不落 model_calls，返回 null，界面自然不显示。
 */
export function tokensPerSecForTurn(turnId: string, reply: string): number | null {
  const row = q(
    `SELECT elapsed_ms, completion_tokens FROM model_calls
     WHERE turn_id = ? AND purpose = 'chat' AND ok = 1 ORDER BY id DESC LIMIT 1`,
  ).get(turnId) as { elapsed_ms: number; completion_tokens: number | null } | undefined;
  if (!row || !(row.elapsed_ms > 0)) return null;
  const tokens = Number(row.completion_tokens) > 0 ? Number(row.completion_tokens) : estimateTokens(reply);
  if (!(tokens > 0)) return null;
  const value = tokens / (row.elapsed_ms / 1000);
  if (!Number.isFinite(value) || value <= 0) return null;
  // 一位小数够用：误差主要来自计时粒度与分词器口径，不是多留几位能救的。
  return Math.round(value * 10) / 10;
}

export async function respondToTurn(
  turn: TurnRow,
  opts: { isRetry?: boolean; collapseReply?: boolean; variants?: boolean } = {},
): Promise<string> {
  const contactId = turn.contact_id ?? DEFAULT_CONTACT_ID;
  const conversationId = turn.conversation_id || localConversationId(contactId);
  const conversation = getConversation(conversationId);
  const attachments = parseAttachments(turn.attachments);
  const imageAttachments = parseImageAttachments(turn.attachments);

  // 单飞（barge-in）：同一联系人来了新消息 = 还在跑的旧轮被打断。
  // abort 掉在飞的请求，旧轮在自己的 catch 里标 cancelled 收尾：不插任何 assistant 行、
  // 不跑记忆抽取、reply 一起抹掉。
  // 流式只喂草稿位（turns.reply），messages 里从来只有定稿，所以打断仍然没有"半截气泡"要解释——
  // 所以打断不需要"半截文本要不要保留"这套机制。
  const controller = new AbortController();
  const prior = activeTurns.get(conversationId);
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
    for (const row of q(
      `SELECT id FROM turns WHERE contact_id = ? AND conversation_id = ? AND id <> ? AND status IN ('queued','running')`,
    ).all(contactId, conversationId, turn.id) as Array<{ id: string }>) {
      q(`UPDATE turns SET status = 'cancelled', error = '被新消息打断', reply = NULL, reasoning_draft = NULL, finished_at = ? WHERE id = ?`)
        .run(Date.now(), row.id);
      emitTurn(contactId, conversationId, row.id, "cancelled");
      console.log(`[agent] turn ${row.id} 被别的进程打断（跨进程协作取消）`);
    }
  } catch (error) {
    const message = `启动失败：${error instanceof Error ? error.message : String(error)}`;
    try {
      q(`UPDATE turns SET status = 'failed', error = ?, reply = NULL, reasoning_draft = NULL, finished_at = ? WHERE id = ?`)
        .run(message, Date.now(), turn.id);
    } catch { /* 库本身连不上就没啥可做了，交给进程级兜底日志 */ }
    if (activeTurns.get(conversationId)?.turnId === turn.id) activeTurns.delete(conversationId);
    throw error;
  }
  activeTurns.set(conversationId, { turnId: turn.id, controller });
  // 打断可能落在三个位置：模型请求在飞、分条落库的间隙、或刚回完还没落库。
  // 后两种 abort 杀不到任何东西，必须自己检查信号；取消时把已插的气泡清掉、草稿一起抹——
  // cancelled 的轮在对话里不留痕迹，界面上那半截草稿也跟着作废（条件写让它之后再也写不进去）。
  const cancelIfAborted = (): boolean => {
    // 库侧也要看：跨进程的打断只能靠这个标记传达到这里。
    // 起跑时上面已经把这一轮写成 running，所以这里读到 cancelled 只可能是别人要求我们停，
    // 不会是把一条历史 cancelled 轮误当成取消信号。
    if (!controller.signal.aborted) {
      const live = q(`SELECT status FROM turns WHERE id = ?`).get(turn.id) as { status: string } | undefined;
      if (live?.status !== "cancelled") return false;
    }
    // 收尾只属于仍持有这一轮的执行体：同 turnId 重入（重试/重答）时登记表里已换成
    // 新执行体，被打断的旧执行体迟到的收尾不得删新执行体刚插的气泡、把它的状态
    // 覆写成 cancelled——否则重答的轮次会以「被新消息打断」收场、一句回复都不剩。
    // 注意只认「同一轮被重入」：普通 barge-in 登记的是**另一轮**，旧执行体仍要
    // 清掉自己那轮的半截气泡，不能因为登记换了人就把自己的尾巴留下。
    const incumbent = activeTurns.get(conversationId);
    const reentered = incumbent !== undefined && incumbent.controller !== controller && incumbent.turnId === turn.id;
    if (!reentered) {
      deleteAssistantMessagesForTurn(turn.id);
      q(`UPDATE turns SET status = 'cancelled', error = '被新消息打断', reply = NULL, reasoning_draft = NULL, finished_at = ? WHERE id = ?`).run(
        Date.now(),
        turn.id,
      );
      emitTurn(contactId, conversationId, turn.id, "cancelled");
      console.log(`[agent] turn ${turn.id} 已取消（被新消息打断）`);
    }
    return true;
  };

  try {
    // 状态翻转也放进 try：万一 UPDATE 抛错，还能走下面的失败落库而不是黑洞。
    q("UPDATE turns SET status = 'running', error = NULL, reply = NULL, reasoning_draft = NULL WHERE id = ?").run(turn.id);
    emitTurn(contactId, conversationId, turn.id, "running");
    /**
     * 重答一条**较早**的轮次时，新回复必须留在它原来位置上。
     * 消息表以自增 id 当时间轴（上下文窗口按 id 取、版本切换的写回也按 id 定位），
     * 「删掉再插」会让这条回复排到整段对话末尾，后面那些轮次当场对不上。
     * 所以这里沿用它第一个气泡那一行的 id 把整条写回去、多余的分条气泡删掉。
     * 代价是这一种重答不分条——故意的重答旧消息，不需要打字节奏。
     */
    /**
     * 只找真正的对话气泡，不能把工具卡算进来：同一轮的工具卡也是 role='assistant'，
     * 而且先于最终回复落库。以前这里只看 role，于是重答「用过工具的旧轮」会把回复
     * UPDATE 进第一张工具卡（kind 仍是 tool），真正的对话行反而被删掉——
     * 界面看到一张坏掉的工具卡，上下文里也找不到这条回复。
     */
    const collapseIntoId = opts.isRetry && opts.collapseReply
      ? ((q(`SELECT id FROM messages WHERE turn_id = ? AND role = 'assistant' AND kind = 'chat' ORDER BY id ASC LIMIT 1`)
        .get(turn.id) as { id: number } | undefined)?.id ?? null)
      : null;
    if (opts.isRetry) {
      // 版本化重答先把旧回复存进 turns.variants：必须赶在删除之前，晚了就没有可存的了。
      if (opts.variants) ensureTurnVariants(turn.id);
      if (collapseIntoId !== null) {
        q(`DELETE FROM messages WHERE turn_id = ? AND role = 'assistant' AND id <> ?`).run(turn.id, collapseIntoId);
      } else {
        deleteAssistantMessagesForTurn(turn.id);
      }
    }
    if (!turnHasUserMessage(turn.id)) {
      insertMessage({ channel: turn.channel, role: "user", text: turn.text, turnId: turn.id, contactId, conversationId, attachments, attachmentMeta: parseStoredAttachmentMeta(turn.attachment_meta) });
    }

    // 联系人隔离：人格、记忆、上下文全部按这个联系人取——
    // A 记得的事 B 不知道，这是「完全隔离」路线的落地。
    // 设置助手例外：不抽陪伴记忆，用实时的产品状态提示词 + 白名单配置工具。
    const assistant = isAssistant(contactId);
    // 这一轮从头到尾使用同一份权限；界面切换只影响之后启动的消息。
    const assistantPermissionSnapshot = assistant ? assistantPermission() : undefined;
    if (assistant) pinAssistantToActiveProfile(); // 首次开口前把自己钉在当时的生效档上
    // 重答一轮时把上下文截到这一轮为止（见 recentMessages 的 upToMessageId）：
    // 不截就会把后面的对话当成"最新的话"，重答第 1 轮却回答第 3 轮的问题。
    // 这一步排在拼提示词之前：梗概要不要注入，取决于它覆盖的那段是否已在窗口里原文回放。
    const upToRow = opts.isRetry
      ? q(`SELECT id FROM messages WHERE turn_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`)
        .get(turn.id) as { id: number } | undefined
      : undefined;
    const rawRows = recentMessages(contactId, undefined, upToRow?.id ?? null, conversationId);
    // 混合召回：查询句先向量化（embedding 能力没配/失败时自动退纯词面）。
    // 群聊只召回 global + 本群两类：群里说出来的话对全群本就公开。
    // 这里仍要取发言人昵称——不是给归属用，是给记忆抽取标「这句是谁说的」。
    const triggerSender = conversation?.kind === "group" && turn.trigger_message_id
      ? q(`SELECT sender_name FROM messages WHERE conversation_id = ? AND source_message_id = ? LIMIT 1`)
          .get(conversationId, turn.trigger_message_id) as { sender_name?: string | null } | undefined
      : undefined;
    const memoryScope = { conversationId };
    const memories = assistant ? [] : await recallSmart(contactId, turn.text, undefined, memoryScope);
    const system = assistant
      ? buildAssistantSystemPrompt(assistantPermissionSnapshot)
      : buildSystemPrompt(memories, {
          character: contactCard(contactId),
          lastUserAt: lastUserMessageAt(contactId, conversationId),
          companion: {
            ...companionPromptExtras(getContact(contactId), rawRows[0]?.id),
            ...(conversation?.summary ? { conversationSummary: conversation.summary } : {}),
          },
          // [现在] 的硬拼时间行跟「看时间」能力同一开关（工具门控在 tools.visibleTools）
          emoteFrequency: emoteFrequencyForContact(contactId),
          includeNow: getContact(contactId)?.features?.clock !== false,
        });
    // 预算裁剪（软防线）：装不下就从最旧一轮开始丢，本轮永不丢。
    // 估算有误差，所以真值兜底留在 runAgentLoop——服务商回 context-length 400 时再丢一轮重试。
    // 图片分流：主聊天档永远负责对话。主模型能看图时最多 6 张原图内联；
    // 超过 6 张的图片，以及主模型不能看图时的全部图片，都生成 alt 描述注入。
    const visionMode = visionHandlingFor(contactId);
    const directReplay = visionMode === "inline" ? selectReplayImages(rawRows, imageAttachments) : new Set<string>();
    const allImages = userImageUrls(rawRows);
    const described = visionMode === "none"
      ? new Set<string>()
      : new Set(allImages.filter((url) => !directReplay.has(url)));
    if (directReplay.size > 0 || described.size > 0) {
      console.log(`[agent] 图片模式=${visionMode}，原图内联 ${directReplay.size} 张，alt ${described.size} 张`);
    }
    // 私聊是 1v1：历史里不该给每条 user 消息挂「[某某]」前缀，那会让模型以为
    // 现场还有第三个人。发言人昵称只属于群聊（谁说的很重要）。
    // 只清喂给模型的这份副本，库里的 sender_name 不动——记忆抽取、群归属还要用。
    const replaySource = conversation?.kind === "group"
      ? rawRows
      : rawRows.map((row) => ({ ...row, sender_name: null }));
    const historyRows = imageProxiedHistory(replaySource, directReplay, visionMode !== "none");
    const modelSettings = contactModelSettings(contactId) ?? modelConfig();
    const budget = inputBudget(modelSettings);
    // 历史占比上限（联系人级）：轮数管形状，这条管钱包，两条同时生效。
    const histCap = historyTokenCapFor(contactId, modelSettings);
    // 聊天轮永远走聊天档，图片通过内联或文字注入，不再改变工具门控。
    const toolsOn = modelSettings.caps.tools === true;
    const toolsJson = toolsOn ? JSON.stringify(toolDefsForApi(contactId, assistantPermissionSnapshot)) : "[]";
    const imageTokensOf = (rows: typeof historyRows): number =>
      countReplayedImages(rows, directReplay) * IMAGE_TOKENS
      + countReplayedImages(rows, described) * DESCRIPTION_TOKENS;
    // 工具往返：最近若干轮按协议原样回放（assistant.tool_calls → tool 结果），更早的折成一行备注。
    // 端点被探测为不支持 tools 时只给备注——把 tool_calls 塞给一个不认它的端点，换来的是一句 400。
    // 一次性取整个窗口的往返，再按候选行算「哪些轮还留在窗口里」：
    // 裁剪是个反复试的过程，每试一次都去查库既慢又没必要。
    const toolExchanges = loadToolExchanges(contactId, conversationId, historyRows.map((row) => row.turn_id));
    const nativeToolTurns = toolsOn && !toolsUnsupportedFor(modelSettings) ? config.toolHistoryTurns : 0;
    const toolReplayOf = (rows: typeof historyRows) => planToolReplay(rows, toolExchanges, { nativeTurns: nativeToolTurns });
    const { kept: keptRows } = trimHistoryToBudget(historyRows, (rows) => {
      const p = contextParts({
        systemBare: system, systemFull: system, toolsJson,
        history: textsOf(toChatMessages(rows, toolReplayOf(rows))),
        imageCount: countReplayedImages(rows, directReplay),
        visionMode,
        imageTokens: imageTokensOf(rows),
      });
      return contextTotal(p) <= budget.room && p.history <= histCap;
    });

    // 所有未被原图内联的图片都生成 alt；主模型自带视觉时由主模型生成，否则由显式视觉卡生成。
    let requestRows = keptRows;
    const describedUrls = [...new Set(keptRows.flatMap((row) =>
      row.role === "user"
        ? parseImageAttachments(row.attachments).filter((url) => described.has(url))
        : [],
    ))];
    if (describedUrls.length > 0) {
      if (cancelIfAborted()) return "";
      const descriptions = await describeChatImages(describedUrls, {
        turnId: turn.id,
        contactId,
        signal: controller.signal,
        source: visionMode === "describe" ? "imageVision" : "chat",
      });
      if (cancelIfAborted()) return "";
      requestRows = appendImageDescriptions(keptRows, described, descriptions);
      console.log(`[agent] alt 描述已注入 ${describedUrls.length} 张图片`);
    }
    const history = toChatMessages(requestRows, toolReplayOf(requestRows));

    // 主模型自身支持视觉：最多 6 张预算内的图就地变成多模态 parts。
    if (visionMode === "inline" && directReplay.size > 0) {
      const userRows = requestRows.filter((row) => row.role === "user");
      let nth = 0;
      let inlineCount = 0;
      let inlineBytes = 0;
      for (const msg of history) {
        if (msg.role !== "user") continue;
        const row = userRows[nth];
        nth += 1;
        if (!row) continue;
        const urls = parseImageAttachments(row.attachments).filter((url) => directReplay.has(url)).slice(0, MAX_CHAT_IMAGES);
        if (urls.length === 0) continue;
        const text = typeof msg.content === "string" ? msg.content : "";
        const parts: MessageContentPart[] = text === "" ? [] : [{ type: "text", text }];
        let missing = 0;
        for (const url of urls) {
          const dataUrl = mediaDataUrl(url);
          if (dataUrl) {
            parts.push({ type: "image_url", image_url: { url: dataUrl } });
            inlineBytes += dataUrl.length;
            inlineCount += 1;
          } else {
            missing += 1;
          }
        }
        if (missing > 0) {
          const mark = `[图片${missing > 1 ? ` ×${missing}` : ""}：文件已不在媒体目录里，你看不到内容，别猜也别编]`;
          parts.push({ type: "text", text: mark });
        }
        if (parts.length > 0) msg.content = parts;
      }
      console.log(`[agent] 主模型内联真图 ${inlineCount} 张，${(inlineBytes / 1024).toFixed(0)}KB`);
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
    // agent 循环：联系人可以在回答前调用工具（查时间、查记忆），最多 3 轮。
    // 上下文里已经注入了环境描述与被动召回的记忆，工具是「联系人主动去查」的补充——
    // 不确定几点、想确认记没记过某件事时，联系人自己决定查不查。
    // 思考内容：多轮工具调用可能各带一段，按顺序拼起来。它只属于"这一轮联系人想过什么"，
    // 所以只挂在**该轮第一个气泡**上（分条回复也只出现一次），并且绝不回灌进 history——
    // 否则下一轮联系人会把推理当成自己说过的话再读一遍，token 翻倍还污染记忆抽取。
    const reasoningParts: string[] = [];
    const producedFiles: string[] = [];
    const producedMeta: MessageAttachmentMeta[] = [];
    const channelDeliveredFiles: string[] = [];
    const channelDeliveredMeta: MessageAttachmentMeta[] = [];
    const appEmoteFiles: string[] = [];
    const appEmoteMeta: MessageAttachmentMeta[] = [];
    const reply = await runAgentLoop(turn, system, history, controller.signal,
      (text) => { if (text.trim() !== "") reasoningParts.push(text.trim()); },
      reasoningDraftWriter(turn.id, contactId, conversationId),
      (urls, metas) => {
        producedFiles.push(...urls);
        if (metas !== undefined) producedMeta.push(...metas);
      },
      // 已由工具发进渠道的表情图：只挂气泡（带 label 元数据），绝不进 deliveryImages（否则 QQ 会再收一遍）。
      (urls, metas) => {
        channelDeliveredFiles.push(...urls);
        if (metas !== undefined) channelDeliveredMeta.push(...metas);
      },
      // 应用端 send_emote 挂上来的表情：不受出图的「一轮一张」限制，一轮最多 3 张。
      (urls, metas) => {
        appEmoteFiles.push(...urls);
        if (metas !== undefined) appEmoteMeta.push(...metas);
      },
      draftWriter(turn.id, contactId, conversationId), cancelIfAborted, assistantPermissionSnapshot);
    if (cancelIfAborted()) return "";
    const reasoning = reasoningParts.join("\n\n");
    // 生成速度（token/秒）：只取产出最终回复的那次调用，算一次挂到第一颗气泡上。
    const tokensPerSec = tokensPerSecForTurn(turn.id, reply);
    // 收尾补最后一拍：节流器可能吃掉最后一段，定稿前必须让草稿与最终 reasoning 完全一致。
    q(`UPDATE turns SET reasoning_draft = ? WHERE id = ? AND status = 'running'`).run(reasoning || null, turn.id);
    // 出图/语音仍按「一轮一张」投递：工具描述就是这么约定的，放宽会让一轮甩 3 张图到 QQ。
    // 应用端表情是第三类（见 replyAttachmentBuckets）：不是出图，一轮 3 张由门控管，
    // 展示和镜像投递都得带上；QQ 会话里已原生发出的那批则只挂气泡、绝不重发。
    const { bubbleImages, deliveryImages } = replyAttachmentBuckets({
      producedFiles, appEmoteFiles, channelDeliveredFiles,
    });

    // 分条发送：按句子切成几个气泡，逐条延迟落库——像人打字，而不是一次性甩一大段。
    // Markdown 内容（列表/代码块）由分割器保证整条不拆。turn 在最后一条落库后才 done，
    // 前端的"正在输入"会持续到最后一条出现，节奏才对。
    // 联系人可以把这套节奏关掉（回复方式=单条整段）：整条一个气泡、不等待。
    // 这一组气泡同时就是**通道出站的消息序列**：本地几颗气泡，微信/QQ 里就几条消息；
    // 重答旧轮是整条写回原来那颗气泡，那种情况仍按一条算。
    // 气泡是纯展示层：出图 ∪ 应用端表情 ∪ 已进渠道的表情都挂上，最多 MAX_REPLY_IMAGES 张。
    // 气泡附件的元数据（表情的 label / 语音的时长与转写）：三条来源都算，
    // 按挂上气泡的 URL 过滤，别把没挂的带下去。
    const bubbleMeta = [...channelDeliveredMeta, ...appEmoteMeta, ...producedMeta].filter((m) => bubbleImages.includes(m.url));
    const parts = collapseIntoId !== null || getContact(contactId)?.features.splitReply === false
      ? [reply]
      : segmentReply(reply);
    if (collapseIntoId !== null) {
      // 整条写回原来那个气泡的位置（见上面 collapseIntoId 的说明），不分条、不延迟。
      // 附件跟着一起重写：重答画了新图就换上新图，没画就该清掉旧图，不能留着上一版的。
      // 元数据（表情 label / 语音时长转写）同理，跟着附件一起换。
      q(`UPDATE messages SET text = ?, attachments = ?, attachment_meta = ?, reasoning = ?, tokens_per_sec = ? WHERE id = ?`)
        .run(
          reply,
          bubbleImages.length > 0 ? JSON.stringify(bubbleImages) : null,
          bubbleImages.length > 0 && bubbleMeta.length > 0 ? JSON.stringify(bubbleMeta) : null,
          reasoning || null,
          tokensPerSec,
          collapseIntoId,
        );
    } else {
      for (let i = 0; i < parts.length; i += 1) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 450 + Math.floor(Math.random() * 750)));
          // 延迟间隙是最容易漏的打断点：不检查的话旧轮会把剩下的气泡继续插进新对话里。
          if (cancelIfAborted()) return "";
        }
        insertMessage({
          channel: turn.channel, role: "assistant", text: parts[i] ?? "", turnId: turn.id, contactId, conversationId,
          // 一轮只挂一处：第一条气泡带这段思考、这张图与生成速度，后面的气泡不重复显示
          ...(i === 0 && reasoning !== "" ? { reasoning } : {}),
          ...(i === 0 && bubbleImages.length > 0 ? { attachments: bubbleImages } : {}),
          // 表情图带 label、语音带时长与转写：气泡标注 + 历史标记（联系人下一轮靠它记得发过哪张/说过哪句）都靠它。
          ...(i === 0 && bubbleImages.length > 0 && bubbleMeta.length > 0 ? { attachmentMeta: bubbleMeta } : {}),
          ...(i === 0 && tokensPerSec !== null ? { tokensPerSec } : {}),
        });
      }
    }
    trimReasoningWindow(contactId);
    trimToolDetailWindow(contactId);
    // 工具往返的载荷同样按轮滚动清理：回放窗口只有几轮，几十轮前的 web_fetch 正文
    // 留在库里既不会被回放，又会让备份一天天变大（卡片行与工具名仍保留）。
    trimToolStore(contactId);
    if (cancelIfAborted()) return "";
    // 版本化重答收尾：把刚写完的这版追加进 turns.variants（被换下的那版已在起跑前存档）。
    // 附件/元信息只挂第一颗气泡，与落库同一形状；重答旧轮时 parts 本就是整段一条。
    // 非版本化回复也要落版本元信息：常驻的「1/1 + 生成入口」靠它渲染。
    if (opts.variants) {
      appendTurnVariant(
        turn.id,
        parts,
        bubbleImages.length > 0 ? JSON.stringify(bubbleImages) : null,
        bubbleImages.length > 0 && bubbleMeta.length > 0 ? JSON.stringify(bubbleMeta) : null,
        reasoning || null,
        tokensPerSec,
      );
    } else {
      syncVariantMeta(turn.id);
    }
    q("UPDATE turns SET status = 'done', reply = ?, finished_at = ? WHERE id = ?").run(
      reply,
      Date.now(),
      turn.id,
    );
    emitTurn(contactId, conversationId, turn.id, "done");
    emitActivity(contactId);

    // 附注跟在最后一颗气泡后面：分条时不能每颗都挂一遍。
    const noted = (note: string): string[] =>
      deliveryImages.length === 0
        ? parts
        : parts.map((part, i) => (i === parts.length - 1 ? `${part}\n${note}` : part));
    // 通道投递：QQ 群按群回复，绝不把群回复镜像到联系人私聊；
    // 主私聊里的应用/微信/QQ 消息仍镜像到微信 + QQ 私聊。
    // 投递的是分好的 parts（气泡序列）而不是整段 reply——"本地几颗气泡，QQ 里几条消息"
    // 从前只是注释里的愿望：传整段出去，官方按 4000 字硬切、OneBot 更是整条一坨。
    if (conversation?.channel === "qq") {
      void enqueueAndDeliver({
        channel: "qq",
        contactId,
        conversationId,
        segments: parts,
        kind: "chat",
        sourceMessageId: turn.trigger_message_id ?? undefined,
      })
        .then(async () => {
          // 图单独发一条（群图片不必引用原消息），文字先进入持久队列。
          if (deliveryImages.length > 0) {
            const { qq } = await import("../channels/qq.ts");
            await qq.deliverMediaToGroup(contactId, conversationId, "", deliveryImages.map((url) => ({ url })));
          }
        })
        .catch(() => { /* 文字失败已落死信队列；媒体失败已落 qq lastError 与 model_calls */ });
    } else {
      // 应用端表情不是「画了张图」，别再拿出图那句附注糊过去。
      const wechatNote = appEmoteFiles.length > 0 && producedFiles.length === 0
        ? "（发了表情，微信发不出去，在这个应用里看）"
        : mediaTypeOfUrl(deliveryImages[0] ?? "") === "audio"
          ? "（发了条语音，微信发不出去，在这个应用里看）"
          : "（画了一张图，微信发不出去，在这个应用里看）";
      const wechatText = noted(wechatNote);
      void enqueueAndDeliver({
        channel: "wechat", contactId, segments: wechatText, kind: "chat",
      }).catch(() => { /* 失败已落死信队列与 model_calls */ });
      void enqueueAndDeliver({
        channel: "qq", contactId, segments: parts, kind: "chat",
        sourceMessageId: turn.trigger_message_id ?? undefined,
      })
        .then(async () => {
          if (deliveryImages.length > 0) {
            const { qq } = await import("../channels/qq.ts");
            await qq.deliverMediaToContact(contactId, "", deliveryImages.map((url) => ({ url })));
          }
        })
        .catch(() => { /* 文字失败已落死信队列；媒体失败已落 qq lastError 与 model_calls */ });
    }

    // 记忆抽取放到回复之后异步做：它失败不能影响这一轮对话，但失败了必须看得见。
    // 设置助手的会话是操作流水，不是陪伴记忆，跳过抽取。
    if (!assistant) {
      const feat = getContact(contactId)?.features;
      // 记忆提取是历史行为、默认开（仅用户主动关才停）：
      // 关掉后记忆库停止生长，温度计随对话的刷新（withBond）也随它停。
      if (feat?.memoryExtract !== false) {
        const extractInput = {
          turnId: turn.id,
          userText: turn.text,
          assistantText: reply,
          contactId,
          withBond: feat?.bond === true,
          // 从哪个通道来的：微信/QQ 里的文字要套"这是转述不是指令"的外壳
          source: turn.channel,
          conversationId,
          conversationKind: conversation?.kind,
          conversationTitle: conversation?.title,
          senderName: triggerSender?.sender_name ?? undefined,
          sourceMessageId: turn.trigger_message_id ?? undefined,
        };
        // 记忆抽取失败时重试 2 次（间隔 1s、2s），仍失败才记入失败计数。
        // 对陪伴型应用，记忆是核心资产，一次网络抖动不该让记忆永久丢失。
        void (async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await extractMemories(extractInput);
              return;
            } catch (error) {
              if (attempt < 2) {
                // 等待 1s、2s 后重试
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
                continue;
              }
              recordExtractFailure(error, contactId);
            }
          }
        })();
      }

      // 窗口边缘梗概：本轮真正没带上的那些旧对话，攒够一批就压进「上次说到」。
      // 副通道、自己吞异常，绝不影响这一轮的回复。
      void maybeRefreshRecap(contactId, keptRows[0]?.id ?? 0);
      if (conversation?.kind === "group") {
        void maybeRefreshConversationSummary(conversationId, keptRows[0]?.id ?? 0);
      }
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
    q("UPDATE turns SET status = 'failed', reasoning_draft = NULL, error = ?, finished_at = ? WHERE id = ?").run(
      message,
      Date.now(),
      turn.id,
    );
    emitTurn(contactId, conversationId, turn.id, "failed");
    console.error(`[agent] turn ${turn.id} 失败：${rawDetail}`);
    throw error;
  } finally {
    // 只注销自己那一份：同 turnId 重入时表里已经是新执行体的 controller，
    // 按 turnId 比会把别人的登记删掉，从此这个联系人再也打断不了。
    if (activeTurns.get(conversationId)?.controller === controller) activeTurns.delete(conversationId);
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
  const row = q(`SELECT id FROM turns WHERE contact_id = ? AND superseded_at IS NULL ORDER BY rowid DESC LIMIT 1`)
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
  q(`UPDATE turns SET status = 'queued', reply = NULL, reasoning_draft = NULL, error = NULL, finished_at = NULL WHERE id = ?`).run(turnId);
  turn.status = "queued";

  // regenerate = 版本化重答：旧回复先存档、新回复追加为下一个版本（见 ensureTurnVariants /
  // appendTurnVariant）。失败重试与编辑重答不是版本化重答：前者无话可存，后者上下文已变、
  // 旧版本不再与这一轮对得上（editAndRegenerate 里清档）。
  void respondToTurn(turn, { isRetry: true, collapseReply, variants: opts.regenerate === true }).catch(() => {
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
  const changed = q(
    `UPDATE turns SET status = 'cancelled', error = '已手动停止', reply = NULL, reasoning_draft = NULL, finished_at = ? WHERE id = ? AND status IN ('queued','running')`,
  ).run(Date.now(), turnId);
  const contactId = turn.contact_id;
  if (contactId) {
    const conversationId = turn.conversation_id || localConversationId(contactId);
    const active = activeTurns.get(conversationId);
    if (active && active.turnId === turnId) active.controller.abort();
  }
  if (contactId && Number(changed.changes) > 0) {
    emitTurn(contactId, turn.conversation_id || localConversationId(contactId), turnId, "cancelled");
  }
  return Number(changed.changes) > 0;
}

// ── 编辑已发送的消息 ──────────────────────────────────────────

function updateMessageText(id: number, text: string, attachmentsJson?: string | null): void {
  // attachmentsJson === undefined = 只改文字、附件原样不动；传值（含 null）= 覆盖。
  if (attachmentsJson === undefined) {
    q(`UPDATE messages SET text = ? WHERE id = ?`).run(text, id);
    return;
  }
  q(`UPDATE messages SET text = ?, attachments = ? WHERE id = ?`).run(text, attachmentsJson, id);
}

/** 把一条消息认领到某个处理单上（编辑没有 turn_id 的历史消息时才用得到）。 */
function attachMessageToTurn(messageId: number, turnId: string): void {
  q(`UPDATE messages SET turn_id = ? WHERE id = ?`).run(turnId, messageId);
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
  // 只改消息不改处理单，会出现「气泡里图变了、联系人看见的还是旧图」。
  q(
    `UPDATE turns SET status = 'queued', reply = NULL, reasoning_draft = NULL, error = NULL, finished_at = NULL, superseded_at = NULL, text = ?, attachments = ? WHERE id = ?`,
  ).run(text, attachments.length > 0 ? JSON.stringify(attachments) : null, turnId);
}

/**
 * 编辑一条自己发过的消息，并重新回答这一轮。
 *
 * 语义与「重新生成」对齐（版本式，不是作废式）：
 *   1) 改写这条消息的文本
 *   2) 旧回复进 turn 级版本存档（可左右切换，见 ensureTurnVariants / appendTurnVariant）
 *   3) 重新生成这一轮的回复；**编辑点之后的对话原样保留**——不再整体作废折叠，
 *      上下文回放继续包含后面的轮次（2026-11-07 起，「已被编辑取代」不再产生，
 *      只有历史库里遗留的 superseded_kind='edit' 行还会折叠显示）。
 *
 * 为什么第 3 步不能省：只改文本不重新生成的话，上下文末尾留着的是"针对旧文本的回复"，
 * 模型下一轮看到的是一段自相矛盾的对话 —— 改了还不如不改。
 *
 * 已知取舍：旧回复对应的旧提问文字会被覆盖（回复版本只存回答不存提问），
 * 切回旧版本回答时，问题显示的是新文字。
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

  // 旧回复不在这里删：respondToTurn 的 isRetry 块会先把它存进版本存档再删除——
  // 与重新生成同一套时序，提前删就没有可存的了。下游轮次一行都不动。
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
    // collapseReply 与 retryTurn 同判：较早的轮次写回原气泡位置（下游保留所以必须原位），
    // variants=true 让旧回复进版本存档、新回复成为下一个可切换的版本。
    const contactId = turn.contact_id ?? DEFAULT_CONTACT_ID;
    const collapseReply = !!turn.contact_id && !isLatestTurnOfContact(contactId, target);
    void respondToTurn(turn, { isRetry: true, collapseReply, variants: true }).catch(() => {
      // 失败已写进 turns.error，前端轮询 /api/turn/:id 能看到。
    });
  }

  return { turnId: target };
}

/**
 * 撤回一条消息：从对话上下文里摘除，界面显示成「你撤回了一条消息」。
 *
 * 为什么只撤回**这一条**、不动联系人的回复：这是 IM 已有的心智——微信里对方撤回一条，
 * 你的回复照样留着。联系人那句回复确实是联系人当时说过的话，不该因为你收回了自己那句话而跟着消失。
 * （要"这一轮整个作废"那是「删除」，要"换个说法"那是「编辑」。）
 *
 * 与编辑共用 superseded 标记，区别只在 superseded_kind —— 界面按它决定
 * 是折起来（edit）还是显示成撤回提示（retract）。
 */
export function retractMessage(messageId: number): { messageId: number } {
  const message = getMessage(messageId);
  if (!message) throw new Error("这条消息不存在");
  if (message.superseded_at !== null) throw new Error("这条已经不在对话里了");

  q(`UPDATE messages SET superseded_at = ?, superseded_kind = 'retract' WHERE id = ?`).run(
    Date.now(),
    messageId,
  );

  console.log(`[agent] 撤回消息 ${messageId}`);
  return { messageId };
}

/**
 * 彻底删除一轮对话：选中那条 + 与它同处理单的其它消息，一起从库里删掉。
 *
 * 为什么按"轮"删而不是按"条"：单独删掉用户那句话、把联系人的回复留在那儿会得到一句悬空的回应；
 * 单独删掉联系人的回复，用户的话也失去了着落。一轮本就是一个完整的来回，要清就清干净。
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
    const rows = q(`SELECT attachments FROM messages WHERE turn_id = ?`).all(message.turn_id) as Array<{ attachments: unknown }>;
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
    messages = Number(q(`DELETE FROM messages WHERE turn_id = ?`).run(turnId).changes);
    turns = Number(q(`DELETE FROM turns WHERE id = ?`).run(turnId).changes);
  } else {
    // 历史遗留消息没有 turn_id，只删它自己（和撤回一样只能作用于单条）。
    messages = Number(q(`DELETE FROM messages WHERE id = ?`).run(messageId).changes);
  }

  console.log(`[agent] 删除 ${messages} 条消息${turns > 0 ? `、${turns} 条处理单` : ""}`);
  return { messages, turns };
}
