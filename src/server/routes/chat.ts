// 对话核心：/api/say（收消息立即 202）、/api/turn/*（处理单查询与重试/重答/停止）、
// /api/turns/recent、/api/messages*（增量/全量/搜索/命中窗口）、/api/message/*（编辑/改文本/撤回/删除）。

import {
  allMessages,
  cancelTurn,
  CHAT_EARLIER_PAGE,
  CHAT_FIRST_PAGE,
  countMessagesBefore,
  countMessagesFor,
  deleteMessage,
  editAndRegenerate,
  getMessage,
  getTurn,
  draftSeqOf,
  messagesForTurn,
  messagesSince,
  messagesBefore,
  messagesAround,
  recentTurns,
  retractMessage,
  retryTurn,
  searchMessagesForContact,
  setTurnVariant,
  turnStats,
  updateAssistantText,
  updateUserMessageText,
} from "../../chat/agent.ts";
import {
  DEFAULT_CONTACT_ID,
  getContact,
} from "../../chat/contacts.ts";
import {
  autoTitleThread,
  isAssistantThreadContactId,
} from "../../mind/assistant.ts";
import { ensureLocalConversation, getConversation } from "../../chat/conversations.ts";
import { mediaUrlExists } from "../../media/media.ts";
import { getChannel } from "../../channels/types.ts";
import {
  clampInt,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  readJson,
  sendJson,
} from "../http.ts";
import { currentContactId, normalizeAttachmentMeta, strictContactId, strictConversationId } from "../context.ts";
import { contactModelSettings } from "../../settings/model.ts";
import { modelConfig, modelReadyNow, onboardingDone } from "../../settings/settings.ts";
import { defaultPersonaIsDefault } from "../../chat/contacts.ts";
import type { Route } from "../types.ts";
import { MAX_CHAT_IMAGES } from "../../../shared/limits.ts";

/** 消息四道写入口（/edit、PUT /text、/retract、DELETE）共用的户主校验。
 *  为什么必须有：这些路由原来只认数字 id，而消息 id 是自增整数——看着 A 的界面
 *  就能改/撤/删 B 的消息，DELETE 还会真删行并回收图片，不可恢复。
 *  返回 false 表示响应已发完，调用方直接 return。 */
function ownMessageOrReject(url: URL, response: import("node:http").ServerResponse, id: number): boolean {
  const contactId = currentContactId(url);
  const row = getMessage(id);
  if (row === null) {
    sendJson(response, 404, { ok: false, error: "这条消息不存在，可能已被删除" });
    return false;
  }
  const owner = row.contact_id ?? DEFAULT_CONTACT_ID;
  if (owner !== contactId) {
    sendJson(response, 403, { ok: false, error: "这条消息不属于这个联系人" });
    return false;
  }
  return true;
}

/** /api/say：收到消息立刻 202，不等模型。 */
const sayRoute: Route = async ({ req, res, url, path, method }) => {
  if (!(method === "POST" && path === "/api/say")) return false;
  const body = await readJson<{ text?: unknown; contactId?: unknown; conversationId?: unknown; attachments?: unknown; attachmentMeta?: unknown; clientId?: unknown }>(req);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  // 图片先传 /api/media 落盘，这里只带 URL 引用；逐个校验文件真实存在
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  const attachments: string[] = [];
  for (const item of rawAttachments.slice(0, MAX_CHAT_IMAGES)) {
    if (typeof item === "string" && item.startsWith("/media/") && mediaUrlExists(item)) attachments.push(item);
  }
  const attachmentMeta = normalizeAttachmentMeta(body.attachmentMeta, attachments);
  const hasVoice = attachmentMeta.some((item) => item.kind === "audio");
  if (text === "" && attachments.length === 0) {
    sendJson(res, 400, { ok: false, error: "text 与 attachments 至少给一个" });
    return true;
  }
  const modelText = text === "" && hasVoice ? "（用户发来一条语音消息）" : text;
  // 前端统一用 ?contactId= 携带（cq 助手），body 里的写法保留兼容其它客户端
  const requested = typeof body.contactId === "string" ? body.contactId : url.searchParams.get("contactId");
  if (requested && !getContact(requested) && !isAssistantThreadContactId(requested)) {
    sendJson(res, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
    return true;
  }
  const contactId = requested ? requested : DEFAULT_CONTACT_ID;
  const requestedConversation = typeof body.conversationId === "string" ? body.conversationId : url.searchParams.get("conversationId") ?? "";
  const conversationId = requestedConversation || ensureLocalConversation(contactId).id;
  const conversation = getConversation(conversationId);
  if (conversation === null || conversation.contact_id !== contactId) {
    sendJson(res, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "会话不存在或不属于当前联系人" });
    return true;
  }
  if (conversation.channel !== "web" || conversation.kind !== "private") {
    sendJson(res, 400, { ok: false, code: "READ_ONLY_CONVERSATION", error: "平台会话只能查看；请在 QQ 里直接对机器人说话" });
    return true;
  }
  // 助手工作区：新工作区的第一条消息用它的内容自动命名
  autoTitleThread(contactId, text);
  const channel = getChannel("web");
  if (!channel) {
    sendJson(res, 503, { ok: false, error: "没有可用通道" });
    return true;
  }
  // 关键：这里立刻返回，不等模型。处理可能要十几秒，平台回调不能等这么久。
  const clientId = typeof body.clientId === "string" ? body.clientId.trim().slice(0, 80) : "";
  const { turnId } = channel.receive(modelText.slice(0, 4000), contactId, attachments, undefined, clientId || undefined, { conversationId, attachmentMeta });
  sendJson(res, 202, { ok: true, turnId, ...(clientId ? { clientId } : {}) });
  return true;
};

/**
 * GET /api/turn/<id>：查处理单状态。
 *
 * ?lean=1：在飞轮瘦身——草稿正文此刻正以 draft/thought 流式帧推给客户端，
 * 轮询拍的职责只剩状态监视与断档对齐，没必要每 900ms 重拉一遍不断变长的全量
 * 正文（回复越长越肥，穿透链路上是持续上行占用）。lean 响应剥掉 reply/reasoning
 * 两个正文字段、带回 draftSeq/reasoningSeq（客户端对齐增量帧的续接点）；
 * 断档回源、收尾那一拍照旧走不带 lean 的请求拿全量。
 */
const turnGetRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path.startsWith("/api/turn/"))) return false;
  const id = decodeURIComponent(path.slice("/api/turn/".length));
  const turn = getTurn(id);
  if (!turn) {
    sendJson(res, 404, { ok: false, error: "处理单不存在" });
    return true;
  }
  // 归属校验：聊天页每个请求都带 ?contactId=，turnId 虽是 UUID，但不校验的话
  // 串号标签页仍能读到别的联系人的回复正文与报错。
  const asked = url.searchParams.get("contactId");
  if (asked && turn.contact_id && turn.contact_id !== asked) {
    sendJson(res, 404, { ok: false, error: "处理单不存在" });
    return true;
  }
  const running = turn.status === "running";
  const lean = url.searchParams.get("lean") === "1" && running;
  const seqs = running ? draftSeqOf(id) : null;
  sendJson(res, 200, {
    ok: true,
    id: turn.id,
    status: turn.status,
    ...(lean ? {} : { reply: turn.reply, reasoning: turn.reasoning_draft ?? null }),
    error: turn.error,
    createdAt: turn.created_at,
    finishedAt: turn.finished_at,
    ...(seqs ? { draftSeq: seqs.reply, reasoningSeq: seqs.reasoning } : {}),
  });
  return true;
};

const turnRetryRoute: Route = async ({ res, path, method }) => {
  if (!(method === "POST" && path.startsWith("/api/turn/") && path.endsWith("/retry"))) return false;
  const id = decodeURIComponent(path.slice("/api/turn/".length, -"/retry".length));
  try {
    await retryTurn(id);
    sendJson(res, 202, { ok: true, turnId: id, note: "已重新提交，用户消息不会重复" });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

const turnRegenerateRoute: Route = async ({ res, path, method }) => {
  // 重新生成：只对最新一轮的已完成回复开放，整轮气泡作废重答（与失败重试同一条流水线）。
  if (!(method === "POST" && path.startsWith("/api/turn/") && path.endsWith("/regenerate"))) return false;
  const id = decodeURIComponent(path.slice("/api/turn/".length, -"/regenerate".length));
  try {
    await retryTurn(id, { regenerate: true });
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: (error as Error).message });
  }
  return true;
};

const turnCancelRoute: Route = ({ res, path, method }) => {
  if (!(method === "POST" && path.startsWith("/api/turn/") && path.endsWith("/cancel"))) return false;
  const id = decodeURIComponent(path.slice("/api/turn/".length, -"/cancel".length));
  // 只停还在飞的轮次。已经回完的停不了——别让用户以为点一下能收回那句回答。
  if (!cancelTurn(id)) {
    sendJson(res, 400, {
      ok: false,
      error: getTurn(id) ? "这一轮已经结束了，没有可停止的处理" : "找不到这一轮，可能已经被删掉了",
    });
    return true;
  }
  sendJson(res, 200, { ok: true });
  return true;
};

const turnVariantRoute: Route = async ({ req, res, url, path, method }) => {
  /** 切换这一轮回复的版本（swipe）：把选中版本写回气泡行，前端按轮窄取重绘。
   *  归属校验与 turnGetRoute 同一套：turnId 虽是 UUID，不校验的话串号标签页能切到别人的回复。 */
  if (!(method === "POST" && path.startsWith("/api/turn/") && path.endsWith("/variant"))) return false;
  const id = decodeURIComponent(path.slice("/api/turn/".length, -"/variant".length));
  const body = await readJson<{ index?: unknown }>(req);
  const index = typeof body.index === "number" ? body.index : Number(body.index);
  if (!Number.isInteger(index) || index < 0) {
    sendJson(res, 400, { ok: false, error: "版本序号不合法" });
    return true;
  }
  const turn = getTurn(id);
  if (!turn) {
    sendJson(res, 404, { ok: false, error: "处理单不存在" });
    return true;
  }
  const asked = url.searchParams.get("contactId");
  if (asked && turn.contact_id && turn.contact_id !== asked) {
    sendJson(res, 404, { ok: false, error: "处理单不存在" });
    return true;
  }
  try {
    const result = setTurnVariant(id, index);
    // 把切换后的行随响应带回：前端不必再打一发 /api/messages?turn=，
    // 切换从「两趟往返」变「一趟」——这正是 Kelivo 式即插即用的关键一截。
    const messages = messagesForTurn(id, turn.contact_id ?? undefined);
    sendJson(res, 200, { ok: true, applied: result.applied, index, messages });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

const turnsRecentRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/turns/recent")) return false;
  const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  // 不带 contactId = 全局总览（状态页要的就是这个口径）；带了就只看那一个联系人的轮次。
  let contactId: string | undefined;
  let conversationId: string | undefined;
  if (url.searchParams.get("contactId")) {
    const strict = strictContactId(url, res);
    if (strict === null) return true;
    contactId = strict;
    const conv = strictConversationId(url, res, strict);
    if (conv === null) return true;
    conversationId = conv;
  }
  // status=active：只留在飞（queued/running）的处理单。聊天页切走再切回（或刷新页面）时
  // 靠它接管重答中的**较早**轮次——那种轮的 created_at 很老，「最新一条」里看不到。
  const activeOnly = url.searchParams.get("status") === "active";
  const turns = recentTurns(limit, offset, contactId, conversationId, { activeOnly });
  // 在飞的那一轮随同一响应带回：聊天页两路合一，省一次往返。
  // 只在按联系人查询时才算（状态页的总览用不到它）；status=active 查询本身就是要它。
  const active = contactId !== undefined && !activeOnly
    ? (recentTurns(1, 0, contactId, conversationId, { activeOnly: true })[0] ?? null)
    : undefined;
  sendJson(res, 200, {
    ok: true,
    turns,
    ...(active !== undefined ? { active } : {}),
    stats: turnStats(),
  });
  return true;
};

const messagesSearchRoute: Route = ({ res, url, path, method }) => {
  // 会话内搜索 / 命中后取窗口：都是当前联系人的只读查询。
  if (!(method === "GET" && path === "/api/messages/search")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "" || q.length > 50) {
    sendJson(res, 400, { ok: false, error: "搜索词要在 1~50 个字之间" });
    return true;
  }
  const conversationId = strictConversationId(url, res, contactId);
  if (conversationId === null) return true;
  const limit = clampInt(url.searchParams.get("limit"), 200, 1, 500);
  sendJson(res, 200, { ok: true, q, messages: searchMessagesForContact(contactId, q, limit, conversationId) });
  return true;
};

const messagesAroundRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/messages/around")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const conversationId = strictConversationId(url, res, contactId);
  if (conversationId === null) return true;
  const id = clampInt(url.searchParams.get("id"), 0, 1, Number.MAX_SAFE_INTEGER);
  const messages = messagesAround(contactId, id, 160, conversationId);
  if (!messages) {
    sendJson(res, 404, { ok: false, error: "这条消息不存在或不属于当前联系人" });
    return true;
  }
  const oldest = messages[0]?.id ?? 0;
  sendJson(res, 200, {
    ok: true,
    contactId,
    messages,
    conversationId,
    total: countMessagesFor(contactId, conversationId),
    olderRemaining: countMessagesBefore(contactId, oldest, conversationId),
  });
  return true;
};

const messagesListRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/messages")) return false;
  const since = clampInt(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
  // all=1 走全量。编辑消息后必须用这个模式：失效是打在**已经渲染过的**消息上的，
  // 增量模式（id > since）永远不会把它们重新下发，界面上就看不到任何变化。
  const all = url.searchParams.get("all") === "1";
  // before=<消息id> + all=1：往回再取一页（「载入更早」）
  const before = clampInt(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER);
  // turn=<处理单id>：只重取那一轮。
  const turn = url.searchParams.get("turn");
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const conversationId = strictConversationId(url, res, contactId);
  if (conversationId === null) return true;
  const messages = turn
    ? messagesForTurn(turn, contactId)
    : all
      ? before > 0 ? messagesBefore(contactId, before, CHAT_EARLIER_PAGE, conversationId) : allMessages(contactId, CHAT_FIRST_PAGE, conversationId)
      : messagesSince(contactId, since, 100, conversationId);
  // 就绪位按**这位联系人真正会走的那份配置**判。
  const ready = modelReadyNow(contactModelSettings(contactId) ?? modelConfig());
  // 更早还剩多少条：界面自己数行数会与服务端页大小脱钩，所以由这里报。
  const oldest = messages[0]?.id ?? 0;
  sendJson(res, 200, {
    ok: true,
    modelReady: ready,
    onboardingDone: onboardingDone(),
    personaIsDefault: defaultPersonaIsDefault(),
    contactId,
    conversationId,
    ...(all && !turn
      ? { total: countMessagesFor(contactId, conversationId), olderRemaining: countMessagesBefore(contactId, oldest, conversationId) }
      : {}),
    messages,
  });
  return true;
};

const messageEditRoute: Route = async ({ req, res, url, path, method }) => {
  /** 编辑一条自己发过的消息，并重新回答这一轮（旧回答进版本条，后续对话保留）。
   *  立刻返回（重新生成要调模型，可能十几秒），前端拿 turnId 去轮询 /api/turn/:id。
   *  已有记忆不回滚——界面上也必须把这一点告诉用户。 */
  if (!(method === "POST" && path.startsWith("/api/message/") && path.endsWith("/edit"))) return false;
  const raw = decodeURIComponent(path.slice("/api/message/".length, -"/edit".length));
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    sendJson(res, 400, { ok: false, error: "消息 id 不合法" });
    return true;
  }
  const body = await readJson<{ text?: unknown; attachments?: unknown }>(req);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  // 附件与 /api/say 同一套校验：只认 /media/ 前缀且文件真实存在。
  // 不传 = 不动附件（老客户端只改文字）；传数组（含空数组）= 覆盖。
  let attachments: string[] | undefined;
  if (body.attachments !== undefined) {
    attachments = [];
    const rawArr = Array.isArray(body.attachments) ? body.attachments : [];
    for (const item of rawArr.slice(0, MAX_CHAT_IMAGES)) {
      if (typeof item === "string" && item.startsWith("/media/") && mediaUrlExists(item)) attachments.push(item);
    }
  }
  if (text === "" && (attachments === undefined || attachments.length === 0)) {
    sendJson(res, 400, { ok: false, error: "内容不能为空。想撤回的话，直接说一句新的就行。" });
    return true;
  }
  if (!ownMessageOrReject(url, res, id)) return true;
  try {
    const result = editAndRegenerate({ messageId: id, text: text.slice(0, 4000), attachments });
    sendJson(res, 200, {
      ok: true,
      turnId: result.turnId,
      note: "旧回答已存成版本，可左右切换；后面的对话保留（已经记住的事不会回滚）",
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

const messageTextRoute: Route = async ({ req, res, url, path, method }) => {
  /** 修改联系人的一条回复文本：只改这一句，不重新生成、不动后续消息。 */
  if (!(method === "PUT" && path.startsWith("/api/message/") && path.endsWith("/text"))) return false;
  const raw = decodeURIComponent(path.slice("/api/message/".length, -"/text".length));
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    sendJson(res, 400, { ok: false, error: "消息 id 不合法" });
    return true;
  }
  const body = await readJson<{ text?: unknown }>(req);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") {
    sendJson(res, 400, { ok: false, error: "内容不能为空" });
    return true;
  }
  if (!ownMessageOrReject(url, res, id)) return true;
  // 两个角色共用这一条「只改文本」通道：各自的 UPDATE 都按 role + superseded_at 收窄，互斥。
  const changed = updateAssistantText(id, text.slice(0, 4000)) || updateUserMessageText(id, text.slice(0, 4000));
  if (!changed) {
    sendJson(res, 400, { ok: false, error: "这条消息改不了（可能已被删除或撤回）" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "文本已更新" });
  return true;
};

const messageRetractRoute: Route = ({ res, url, path, method }) => {
  /** 撤回：只把这一条从上下文摘除，界面显示成「已撤回」。联系人的回复**保留**。 */
  if (!(method === "POST" && path.startsWith("/api/message/") && path.endsWith("/retract"))) return false;
  const raw = decodeURIComponent(path.slice("/api/message/".length, -"/retract".length));
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    sendJson(res, 400, { ok: false, error: "消息 id 不合法" });
    return true;
  }
  if (!ownMessageOrReject(url, res, id)) return true;
  try {
    const result = retractMessage(id);
    sendJson(res, 200, { ok: true, ...result, note: "已撤回，该联系人不会再看到这句（对话历史仍可回溯）" });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

const messageDeleteRoute: Route = ({ res, url, path, method }) => {
  /** 彻底删除一轮：选中那条 + 与它同处理单的消息一起真删。不可恢复。 */
  if (!(method === "DELETE" && path.startsWith("/api/message/"))) return false;
  const raw = decodeURIComponent(path.slice("/api/message/".length));
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    sendJson(res, 400, { ok: false, error: "消息 id 不合法" });
    return true;
  }
  if (!ownMessageOrReject(url, res, id)) return true;
  try {
    const result = deleteMessage(id);
    sendJson(res, 200, { ok: true, ...result, note: "已删除，不可恢复" });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

export const routes: Route[] = [
  sayRoute,
  turnGetRoute,
  turnRetryRoute,
  turnRegenerateRoute,
  turnCancelRoute,
  turnVariantRoute,
  turnsRecentRoute,
  messagesSearchRoute,
  messagesAroundRoute,
  messagesListRoute,
  messageEditRoute,
  messageTextRoute,
  messageRetractRoute,
  messageDeleteRoute,
];
