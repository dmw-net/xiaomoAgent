// 上下文用量：下一次发消息时系统提示词/记忆/工具/历史各占多少（估算值，供界面浮层展示）。

import { contextUsage } from "../../chat/agent.ts";
import { sendJson } from "../http.ts";
import { strictContactId, strictConversationId } from "../context.ts";
import type { Route } from "../types.ts";

const contextUsageRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/context/usage")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const conversationId = strictConversationId(url, res, contactId);
  if (conversationId === null) return true;
  sendJson(res, 200, { ok: true, ...contextUsage(contactId, conversationId) });
  return true;
};

export const routes: Route[] = [contextUsageRoute];
