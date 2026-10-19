import { getJson, postJson } from "./client";
import type { QQBindingView, QQStatus } from "../types";

/**
 * QQ 通道接口。
 * 凭据（AppID/AppSecret）是**全局一份**——官方机器人是"一个机器人服务很多用户"，
 * 所以它挂在 /api/qq/credentials，不属于任何联系人；
 * 每联系人一条的只是 openid 绑定，挂在 /api/contacts/:id/qq。
 */

export type QQSummary = {
  ok: boolean;
  configured: boolean;
  /** 已脱敏的 AppID（只为认出"配过哪一台"）。 */
  appId: string;
  status: QQStatus;
  lastError: string;
  bindings: number;
  max: number;
  active: number;
  proactive: number;
  trouble: Array<{ contactId: string; name: string; lastError: string }>;
};

/**
 * 开始扫码建机器人：返回的 qrContent 是一个 https 链接（不是图片），
 * 界面渲成二维码给手机 QQ 扫。taskId 只用来轮询，密钥那一步全在服务端做。
 */
export function beginQQCredentialQr(): Promise<{ taskId: string; qrContent: string; expiresInMs: number }> {
  return postJson("/api/qq/qr");
}

export function pollQQCredentialQr(taskId: string): Promise<{
  status: "waiting" | "created" | "expired" | "gone"; error: string; appId?: string;
}> {
  return getJson("/api/qq/qr/" + encodeURIComponent(taskId));
}

/**
 * 保存全局凭据。密钥那一栏留空或仍是掩码 = 不动原值（后端那条约定与模型密钥一致），
 * 所以"只改 AppID 不重填密钥"是支持的。返回的就是总览那份形状，不用回来再问一次。
 */
export function saveQQCredentials(patch: { appId?: string; clientSecret?: string; enabled?: boolean }): Promise<QQSummary> {
  return postJson("/api/qq/credentials", patch);
}

export function fetchQQBinding(contactId: string): Promise<{ binding: QQBindingView | null; configured: boolean; status: QQStatus }> {
  return getJson(`/api/contacts/${encodeURIComponent(contactId)}/qq`);
}

/** 开一个认领窗口：对方在 QQ 里发回那两个关键字，网关推回来时我们就认出这位联系人。 */
export function beginQQBind(contactId: string): Promise<{ attemptId: string; keyword: string; expiresInMs: number }> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/qq/bind`);
}

export function pollQQBind(contactId: string, attemptId: string): Promise<{
  status: "waiting" | "bound" | "gone"; error: string; binding?: QQBindingView;
}> {
  return getJson(`/api/contacts/${encodeURIComponent(contactId)}/qq/bind/${encodeURIComponent(attemptId)}`);
}

export function setQQFlags(contactId: string, patch: { enabled?: boolean; proactive?: boolean }): Promise<{ binding: QQBindingView }> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/qq/flags`, patch);
}

export function disconnectQQ(contactId: string): Promise<unknown> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/qq/disconnect`);
}

/** 徽标文案：资料页那张卡与状态页总览共用一份，不各写一遍。 */
export const QQ_STATUS_LABEL: Record<QQStatus, string> = {
  connected: "已连接",
  connecting: "连接中",
  disabled: "已停用",
  attention: "需要处理",
  "not-configured": "未配置",
};
