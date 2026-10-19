/** QQ 官方机器人通道的界面类型（后端 qq.ts 的 publicBinding/summary 镜像）。 */

/** 徽标集合：多一个值界面就会显示成空白，所以与后端保持同一份。 */
export type QQStatus = "connected" | "connecting" | "disabled" | "attention" | "not-configured";

export type QQBindingView = {
  id: string;
  contactId: string;
  /** openid 已脱敏：界面只要认得出"是哪一个"。 */
  userOpenId: string;
  enabled: boolean;
  proactive: boolean;
  status: QQStatus;
  /** 还在被动回复窗口内：这几句能直接送出；过了窗口就依赖平台侧的「主动消息」权限。 */
  hasReplyWindow: boolean;
  lastError: string;
  lastReceivedAt: string;
  lastSentAt: string;
  createdAt: string;
};
