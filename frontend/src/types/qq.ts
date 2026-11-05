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
  /** 群消息响应方式（OneBot 渠道生效）：at=仅 @；at_keyword=@ 或关键词；all=全部消息。 */
  triggerMode: "at" | "at_keyword" | "all";
  /** triggerMode=at_keyword 时的关键词表（逗号分隔）。 */
  triggerKeywords: string;
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
  /** 凭据已配但还没认领到 openid（false 时界面要给出「去绑定」入口）。 */
  hasUserOpenId: boolean;
  enabled: boolean;
  proactive: boolean;
  status: QQStatus;
  /** 还在被动回复窗口内：这几句能直接送出；过了窗口就依赖平台侧的「主动消息」权限。 */
  hasReplyWindow: boolean;
  lastError: string;
  /** 这条提示发生的时间戳（毫秒）；旧后端没有这个字段。 */
  lastErrorAt?: number;
  lastReceivedAt: string;
  lastSentAt: string;
  createdAt: string;
  /** 这位机器人名下的 QQ 群会话；QQ 私聊已并入联系人主私聊。 */
  conversations: QQConversationView[];
  /** 主人的真实 QQ 号（仅 OneBot 渠道回传；私聊投递目标，群聊里据此把主人从群成员里认出来）。官方渠道靠 userOpenId 对比，无此字段。 */
  ownerQq?: string;
  /** OneBot 渠道专属：完整绑定的真实 QQ 号（userOpenId 在视图里是脱敏的，编辑表单需要原值回填）。 */
  qqNumber?: string;
};
