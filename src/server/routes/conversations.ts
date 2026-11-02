// 会话列表：联系人名下的主私聊 + 各 QQ 群；QQ 群的开关/改名/清历史/移除。
// 群会话只读（channel !== "web"），回复走平台侧。

import {
  clearQQGroupHistory,
  getConversation,
  listConversations,
  MAX_CONVERSATION_TITLE_LENGTH,
  normalizeConversationTitle,
  normalizeQQGroupTriggerKeywords,
  removeQQGroupConversation,
  renameQQGroupConversation,
  setConversationEnabled,
  setConversationGroupProactive,
  setConversationTrigger,
} from "../../conversations.ts";
import { countMessagesFor } from "../../agent.ts";
import { readJson, sendJson } from "../http.ts";
import { strictContactId } from "../context.ts";
import type { Route } from "../types.ts";

/** 会话列表（该联系人）。 */
const conversationsListRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/conversations")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const conversations = listConversations(contactId).map((conv) => ({
    id: conv.id,
    contactId: conv.contact_id,
    channel: conv.channel,
    kind: conv.kind,
    title: conv.title,
    enabled: conv.enabled,
    groupProactive: conv.group_proactive,
    leftAt: conv.left_at,
    summary: conv.summary,
    lastMessageAt: conv.last_message_at,
    count: countMessagesFor(contactId, conv.id),
    readOnly: conv.channel !== "web",
  }));
  sendJson(res, 200, { ok: true, conversations });
  return true;
};

/** QQ 群开关（/flags 的 enabled 半边，单独路径）。 */
const conversationFlagsRoute: Route = async ({ req, res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/conversations\/([^/]+)\/flags$/) : null;
  if (m === null) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = decodeURIComponent(m[1] ?? "");
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") {
    sendJson(res, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "QQ 群会话不存在或不属于当前联系人" });
    return true;
  }
  const body = await readJson<{ enabled?: unknown }>(req);
  if (typeof body.enabled !== "boolean") {
    sendJson(res, 400, { ok: false, error: "enabled 必须是布尔值" });
    return true;
  }
  if (body.enabled && conv.left_at !== null) {
    sendJson(res, 409, { ok: false, error: "机器人已不在该群，历史仍保留，但不能重新开启收件" });
    return true;
  }
  setConversationEnabled(id, body.enabled);
  sendJson(res, 200, { ok: true, conversation: { ...getConversation(id) } });
  return true;
};

/** QQ 群改名：null = 恢复最近一次平台群名，字符串 = 用户自定义名称。 */
const conversationTitleRoute: Route = async ({ req, res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/conversations\/([^/]+)\/title$/) : null;
  if (m === null) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = decodeURIComponent(m[1] ?? "");
  const body = await readJson<{ title?: unknown }>(req);
  if (body.title !== null && typeof body.title !== "string") {
    sendJson(res, 400, { ok: false, error: "title 必须是字符串或 null" });
    return true;
  }
  if (typeof body.title === "string") {
    const normalized = normalizeConversationTitle(body.title);
    if (normalized === "" || normalized.length > MAX_CONVERSATION_TITLE_LENGTH) {
      sendJson(res, 400, { ok: false, error: `群名要在 1~${MAX_CONVERSATION_TITLE_LENGTH} 个字之间` });
      return true;
    }
  }
  const renamed = renameQQGroupConversation(id, contactId, body.title);
  if (renamed === null) {
    sendJson(res, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "QQ 群会话不存在或不属于当前联系人" });
    return true;
  }
  sendJson(res, 200, { ok: true, conversation: { id: renamed.id, title: renamed.title, titleSource: renamed.title_source } });
  return true;
};

/** 已离群 QQ 群：手动清除历史。会话外壳保留，只有明确进入离群状态的群允许操作。 */
const conversationHistoryRoute: Route = ({ res, url, path, method }) => {
  const m = method === "DELETE" ? path.match(/^\/api\/conversations\/([^/]+)\/history$/) : null;
  if (m === null) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = decodeURIComponent(m[1] ?? "");
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") {
    sendJson(res, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "QQ 群会话不存在或不属于当前联系人" });
    return true;
  }
  const cleared = clearQQGroupHistory(id, contactId);
  if (cleared === null) {
    sendJson(res, 404, { ok: false, error: "QQ 群会话不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true, ...cleared });
  return true;
};

/** 已离群 QQ 群：从列表彻底移除。移除即清掉剩余历史，之后重新入群是新会话。 */
const conversationRemoveRoute: Route = ({ res, url, path, method }) => {
  const m = method === "DELETE" ? path.match(/^\/api\/conversations\/([^/]+)$/) : null;
  if (m === null) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = decodeURIComponent(m[1] ?? "");
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") {
    sendJson(res, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "QQ 群会话不存在或不属于当前联系人" });
    return true;
  }
  // 在收的群不许删（防手滑）；官方离群与 OneBot 已停用的群都可以彻底移除。
  if (conv.left_at === null && conv.enabled) {
    sendJson(res, 409, { ok: false, error: "群仍在收件中，不能从列表移除；请先在群列表里停用后再操作" });
    return true;
  }
  const cleared = removeQQGroupConversation(id, contactId);
  if (cleared === null) {
    sendJson(res, 404, { ok: false, error: "QQ 群会话不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true, removed: true, ...cleared });
  return true;
};

/** QQ 群「允许主动群消息」开关（对应 QQ 侧"机器人主动在群内发言"权限在应用侧的映射）。
 *  仅在 kind="group" 且 channel="qq" 的会话上有效；已离群的群不开启。 */
const conversationGroupProactiveRoute: Route = async ({ req, res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/conversations\/([^/]+)\/group-proactive$/) : null;
  if (m === null) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = decodeURIComponent(m[1] ?? "");
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") {
    sendJson(res, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "QQ 群会话不存在或不属于当前联系人" });
    return true;
  }
  if (conv.left_at !== null) {
    sendJson(res, 409, { ok: false, error: "机器人已不在该群，无法开启群主动消息" });
    return true;
  }
  const body = await readJson<{ groupProactive?: unknown }>(req);
  if (typeof body.groupProactive !== "boolean") {
    sendJson(res, 400, { ok: false, error: "groupProactive 必须是布尔值" });
    return true;
  }
  setConversationGroupProactive(id, body.groupProactive);
  sendJson(res, 200, { ok: true, conversation: { ...getConversation(id)! } });
  return true;
};

/** QQ 群消息响应方式（OneBot 后端）：仅 @ / @或关键词 / 全部消息。官方后端平台只推 @ 事件，
 *  这里仍允许写库，但界面只在 OneBot 渠道暴露入口。 */
const conversationTriggerRoute: Route = async ({ req, res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/conversations\/([^/]+)\/trigger$/) : null;
  if (m === null) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = decodeURIComponent(m[1] ?? "");
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") {
    sendJson(res, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "QQ 群会话不存在或不属于当前联系人" });
    return true;
  }
  if (conv.left_at !== null) {
    sendJson(res, 409, { ok: false, error: "机器人已不在该群，无法修改响应方式" });
    return true;
  }
  const body = await readJson<{ mode?: unknown; keywords?: unknown }>(req);
  if (body.mode !== "at" && body.mode !== "at_keyword" && body.mode !== "all") {
    sendJson(res, 400, { ok: false, error: "mode 只能是 at、at_keyword 或 all" });
    return true;
  }
  if (body.keywords !== undefined && typeof body.keywords !== "string") {
    sendJson(res, 400, { ok: false, error: "keywords 必须是字符串" });
    return true;
  }
  const keywords = normalizeQQGroupTriggerKeywords(body.keywords ?? "");
  if (body.mode === "at_keyword" && keywords === "") {
    sendJson(res, 400, { ok: false, error: "选了「@ 或关键词」就得填至少一个关键词" });
    return true;
  }
  setConversationTrigger(id, body.mode, keywords);
  sendJson(res, 200, { ok: true, triggerMode: body.mode, triggerKeywords: keywords });
  return true;
};

export const routes: Route[] = [
  conversationsListRoute,
  conversationFlagsRoute,
  conversationTitleRoute,
  conversationHistoryRoute,
  conversationRemoveRoute,
  conversationGroupProactiveRoute,
  conversationTriggerRoute,
];
