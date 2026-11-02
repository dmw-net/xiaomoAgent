import { deleteJson, getJson, postJson } from "./client";
import type { QQBindingView, QQConversationView, QQStatus } from "../types";
export type { QQConversationView } from "../types";

/**
 * QQ 通道接口：每位联系人对应一个独立 BotAccount。
 * 凭据与 openid 绑定按联系人隔离；QQ 私聊进主会话，群会话单独隔离。
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
export function beginQQCredentialQr(contactId: string): Promise<{ taskId: string; qrContent: string; expiresInMs: number }> {
  return postJson("/api/qq/qr?contactId=" + encodeURIComponent(contactId));
}

export function pollQQCredentialQr(contactId: string, taskId: string): Promise<{
  status: "waiting" | "created" | "expired" | "gone"; error: string; appId?: string;
}> {
  return getJson("/api/qq/qr/" + encodeURIComponent(taskId) + "?contactId=" + encodeURIComponent(contactId));
}

/**
 * 保存全局凭据。密钥那一栏留空或仍是掩码 = 不动原值（后端那条约定与模型密钥一致），
 * 所以"只改 AppID 不重填密钥"是支持的。返回的就是总览那份形状，不用回来再问一次。
 */
export function saveQQCredentials(contactId: string, patch: { appId?: string; clientSecret?: string; enabled?: boolean }): Promise<QQSummary> {
  return postJson("/api/qq/credentials?contactId=" + encodeURIComponent(contactId), { ...patch, contactId });
}

export function fetchQQBinding(contactId: string): Promise<{ binding: QQBindingView | null; configured: boolean; status: QQStatus; conversations: QQConversationView[] }> {
  return getJson(`/api/contacts/${encodeURIComponent(contactId)}/qq`);
}

/** 当前 QQ 后端选型（official/onebot）。资料页据此分流：官方走扫码/凭据，OneBot 走「填真实 QQ 号」。
 *  saved 是界面里选过、写在库里的渠道；与运行中的 backend 不同即「已切换待重启」。 */
export type QQBackendInfo = {
  backend: "official" | "onebot";
  saved: "official" | "onebot" | null;
  restartPending: boolean;
  onebotReady: boolean;
};
export function fetchQQBackend(): Promise<QQBackendInfo> {
  return getJson("/api/qq/backend");
}

/** 切换 QQ 接入渠道：后端当场热切（旧渠道收线、新渠道上线），返回 applied=true 即已生效。 */
export function setQQBackend(backend: "official" | "onebot"): Promise<{ ok: boolean; backend: "official" | "onebot"; applied: boolean }> {
  return postJson("/api/qq/backend", { backend });
}

/** 探测 OneBot 协议端并读出它当前登录的账号（绑定入口用：头像 + 昵称 + 一键绑定）。 */
export type OneBotLoginInfo = { reachable: boolean; userId: string; nickname: string; error: string };
export function fetchOneBotStatus(): Promise<OneBotLoginInfo> {
  return getJson("/api/qq/onebot/status");
}

/** 小茉托管的 NapCat 状态（一键安装/启动的轮询源）。 */
export type NapcatStatus = {
  installed: boolean; running: boolean; loggedIn: boolean;
  phase: string; qrUrl: string; uin: string; nickname: string; error: string;
};
export function fetchNapcatStatus(): Promise<NapcatStatus> {
  return getJson("/api/qq/napcat");
}
/** 安装（下载解压，较慢）/ 启动（拉起+配置+等登录，最长约 3 分钟）。
 *  这两个动作天然慢，必须放宽前端 10 秒默认超时，否则按钮永远"请求超时"。 */
export function napcatAction(action: "install" | "start"): Promise<{ ok: boolean; error: string; needsQr?: boolean }> {
  return postJson("/api/qq/napcat", { action }, 240_000);
}

/** 协议端连接设置：HTTP 出站地址 / forward WS / 令牌（令牌不回传，只有 hasToken）。 */
export type OneBotSettingsView = { httpBase: string; wsUrl: string; hasToken: boolean };
export function fetchOneBotSettings(): Promise<OneBotSettingsView> {
  return getJson("/api/qq/onebot/settings");
}
/** 保存协议端连接设置；OneBot 正在跑时后端会热重启收发通道，返回 applied=true 即已生效。 */
export function saveOneBotSettings(patch: { httpBase?: string; wsUrl?: string; token?: string }): Promise<OneBotSettingsView & { applied: boolean }> {
  return postJson("/api/qq/onebot/settings", patch);
}

/** OneBot 模式：把「真实 QQ 号」绑到这位联系人。协议端侧登录，这里只存映射。
 *  ownerQq 可选：主人的真实 QQ 号，群聊里据此把主人从群成员里认出来。 */
export function bindQQOneBot(
  contactId: string,
  patch: { qqNumber: string; ownerQq?: string; enabled?: boolean; proactive?: boolean },
): Promise<{ ok: boolean; binding: QQBindingView | null; configured: boolean; status: QQStatus; conversations: QQConversationView[] }> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/qq/onebot-bind`, patch);
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

export function setQQConversationEnabled(contactId: string, conversationId: string, enabled: boolean): Promise<unknown> {
  return postJson(`/api/conversations/${encodeURIComponent(conversationId)}/flags?contactId=${encodeURIComponent(contactId)}`, { enabled });
}

/** 切换某 QQ 群的「允许主动群消息」开关；需先确认 QQ 侧机器人已开启"主动在群内发言"权限。 */
export function setQQConversationGroupProactive(contactId: string, conversationId: string, groupProactive: boolean): Promise<unknown> {
  return postJson(`/api/conversations/${encodeURIComponent(conversationId)}/group-proactive?contactId=${encodeURIComponent(contactId)}`, { groupProactive });
}

/** 群消息响应方式（OneBot 渠道）：仅 @ / @或关键词 / 全部消息。 */
export function setQQConversationTrigger(
  contactId: string,
  conversationId: string,
  mode: "at" | "at_keyword" | "all",
  keywords: string,
): Promise<{ triggerMode: "at" | "at_keyword" | "all"; triggerKeywords: string }> {
  return postJson(`/api/conversations/${encodeURIComponent(conversationId)}/trigger?contactId=${encodeURIComponent(contactId)}`, { mode, keywords });
}

/** title=null 时恢复最近一次平台自动群名；自定义名不会被后续事件覆盖。 */
export function renameQQConversation(
  contactId: string,
  conversationId: string,
  title: string | null,
): Promise<{ conversation: Pick<QQConversationView, "id" | "title" | "titleSource"> }> {
  return postJson(`/api/conversations/${encodeURIComponent(conversationId)}/title?contactId=${encodeURIComponent(contactId)}`, { title });
}

export function clearQQConversationHistory(
  contactId: string,
  conversationId: string,
): Promise<{ messages: number; turns: number; memories: number; media: number }> {
  return deleteJson(`/api/conversations/${encodeURIComponent(conversationId)}/history?contactId=${encodeURIComponent(contactId)}`);
}

export function removeQQConversation(
  contactId: string,
  conversationId: string,
): Promise<{ removed: true; messages: number; turns: number; memories: number; media: number }> {
  return deleteJson(`/api/conversations/${encodeURIComponent(conversationId)}?contactId=${encodeURIComponent(contactId)}`);
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
