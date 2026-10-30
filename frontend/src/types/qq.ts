/** QQ 官方机器人通道的界面类型（后端 qq.ts 的 publicBinding/summary 镜像）。 */

/** 徽标集合：多一个值界面就会显示成空白，所以与后端保持同一份。 */
export type QQStatus = "connected" | "connecting" | "disabled" | "attention" | "not-configured";

export type QQConversationView = {
  id: string;
  kind: "private" | "group";
  title: string;
  /** auto = 平台群名；custom = 用户手动命名，平台事件不会覆盖。 */
  titleSource: "auto" | "custom";
  externalId: string;
  enabled: boolean;
  /** 群级主动消息开关：开启后主动消息会投递到该群（需 QQ 侧已开启"机器人主动在群内发言"）。 */
  groupProactive: boolean;
  /** 机器人被移出群或群解散的时间；非 null 时只能查看历史，不能重新开启收件。 */
  leftAt: number | null;
  /** 当前群会话里的消息条数；清除历史的确认文案与空状态按它显示。 */
  messageCount: number;
  lastMessageAt: string;
};

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
  /** 这位机器人名下的 QQ 群会话；QQ 私聊已并入联系人主私聊。 */
  conversations: QQConversationView[];
};
