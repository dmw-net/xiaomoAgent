/** 联系人下的一个独立会话入口。 */
export type ContactConversationItem = {
  id: string;
  channel: string;
  kind: "private" | "group" | string;
  title: string;
  enabled: boolean;
  /** QQ 群：机器人已离群/群已解散的时间；历史仍可查看。 */
  leftAt: number | null;
  readOnly: boolean;
  preview: string;
  lastAt: number;
  unread: number;
};

/** 侧栏联系人列表项（/api/contacts 下发，含预览与未读打算）。 */
export type ContactItem = {
  id: string;
  name: string;
  type: "single" | "group" | string;
  /**
   * 头像：内联 dataURL（用户在界面上手动传的那一种）或已落盘的 /media 路径。
   * 显示层直接把整串塞进 <img src>，两种都能渲染，所以这里不需要区分。
   */
  avatar: string;
  createdAt: number;
  preview: string;
  /** 最近一条消息从哪个入口来（web / wechat / qq）；私聊已合流，标签只表示来源。 */
  previewChannel?: string;
  /** 这条预览来自哪个 Conversation；点击联系人时直接打开它。 */
  conversationId?: string | null;
  conversationTitle?: string;
  conversationReadOnly?: boolean;
  /** 该联系人下可独立进入的会话（现在只剩需要隔离上下文的 QQ 群）。 */
  conversations?: ContactConversationItem[];
  lastAt: number;
  /** 临近窗口内或已到期的主动性任务（0/1）；远期计划不在列表上标“有话想聊”。 */
  pendingSoon: number;
  pendingFocus: string;
  /** care = 陪伴主动开口；reminder = 用户立下的到点提醒。 */
  pendingKind: "care" | "reminder" | "";
  /** 该联系人名下所有会话的未读助手消息合计（侧栏只显示这一枚红点）。 */
  unread: number;
  /** 角色性别：female/male/other，驱动界面代词（她/他/TA）。 */
  gender?: string;
  /** 回放轮数覆盖；0/缺省 = 跟随全局。 */
  recentTurns?: number;
  /** 图像生成：开了才在输入区露出「画一张」（还要 设置→能力 真配好模型）。 */
  imageGen?: boolean;
  /** 聊天框显示开关（缺省按开处理）：思考过程折叠条 / 工具调用过程卡片。 */
  showThinking?: boolean;
  showTools?: boolean;
  /** 流式渲染：逐字追字显示回复。缺省按关处理（非流式=正在输入后整条弹出）。 */
  streamReveal?: boolean;
  /** 仅归档列表返回。 */
  archivedAt?: number;
};
