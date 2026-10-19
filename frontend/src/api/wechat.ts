import { getJson, postJson } from "./client";

/** 后端 publicLink 的镜像（账号 id 已脱敏）。 */
export type WeChatLink = {
  id: string;
  contactId: string;
  accountId: string;
  linkedUserId: string;
  enabled: boolean;
  proactive: boolean;
  status: "connected" | "disabled" | "attention" | "paused";
  hasContext: boolean;
  lastError: string;
  lastReceivedAt: string;
  lastSentAt: string;
  createdAt: string;
};

export function fetchWeChatLink(contactId: string): Promise<{ link: WeChatLink | null }> {
  return getJson(`/api/contacts/${encodeURIComponent(contactId)}/wechat`);
}

/** 状态徽标文案：资料页的微信卡与状态页总览共用一份，不各写一遍。 */
export const WECHAT_STATUS_LABEL: Record<WeChatLink["status"], string> = {
  connected: "已连接",
  disabled: "已停用",
  attention: "需要处理",
  paused: "已暂停",
};

/** 发起扫码绑定：qrContent 是待渲染成二维码的内容串。 */
export function beginWeChatBind(contactId: string): Promise<{ attemptId: string; qrContent: string; status: string }> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/wechat/bind`);
}

export function pollWeChatBind(
  contactId: string,
  attemptId: string,
): Promise<{ status: string; error: string; link?: WeChatLink }> {
  return getJson(`/api/contacts/${encodeURIComponent(contactId)}/wechat/bind/${encodeURIComponent(attemptId)}`);
}

export function setWeChatFlags(
  contactId: string,
  patch: { enabled?: boolean; proactive?: boolean },
): Promise<{ link: WeChatLink }> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/wechat/flags`, patch);
}

export function disconnectWeChat(contactId: string): Promise<unknown> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/wechat/disconnect`);
}
