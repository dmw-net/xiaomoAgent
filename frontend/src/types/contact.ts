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
  lastAt: number;
  pending: number;
  pendingFocus: string;
  /** 未读助手消息数（红点）。 */
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
