// 事件总线：服务端把「联系人那边发生了什么」推给前端，替代一部分空转轮询。
//
// 设计纪律：
// - 大体是**提示通道**：message/turn/activity 只说「哪类东西动了」，不搬数据本体，
//   前端收到事件才去拉对应的一小段——断线重连、事件丢失都不丢数据。
// - **唯一例外是 draft/thought 流式帧**：草稿这类高频小更新走增量帧（delta）或对齐用快照
//   （text）——全量轮询的载荷随回复长度平方增长（O(n²)），穿透链路每次更新还摊着整秒级 RTT。
//   正文仍以库里的 turns.reply / reasoning_draft 为真源：帧丢了客户端靠 seq 断档检测回源对齐，
//   轮询兜底照旧。通道只加速，不承载正确性。
// - 推送必须**永不抛错**：订阅者满、连接半死、序列化失败都静默降级，
//   主流程（写库、回消息）绝不被这条辅助路拖住。
// - 每 25s 一拍心跳（SSE 注释行）：中间人/CSP 空闲断连时客户端靠它探活，
//   前端 EventSource 断了自动重连，重连后服务端重发一份全量 sync 帧对齐。

export type BusEvent =
  | { type: "sync"; at: number }
  | { type: "message"; contactId: string; conversationId: string; messageId: number; at: number }
  | { type: "turn"; contactId: string; conversationId: string; turnId: string; status: string; at: number }
  | { type: "activity"; contactId: string; at: number }
  /**
   * 流式草稿帧（正文）：delta = 追加到已收文本之后；text = 全量快照（首帧、
   * 工具轮改口、任何非前缀续写时发，客户端收到就整段替换）。seq 每轮每字段独立
   * 从 1 递增，客户端发现 seq 跳号就回源 /api/turn 对齐。
   */
  | { type: "draft"; contactId: string; conversationId: string; turnId: string; seq: number; delta?: string; text?: string }
  /** 流式草稿帧（思考）：协议与 draft 完全一致，字段独立计数。 */
  | { type: "thought"; contactId: string; conversationId: string; turnId: string; seq: number; delta?: string; text?: string };

type Subscriber = { contactId: string | null; push: (event: BusEvent) => void };

const MAX_SUBSCRIBERS = 256;
const subscribers = new Set<Subscriber>();

/** 订阅指定联系人（null = 全部）的事件流。返回退订函数。 */
export function subscribe(contactId: string | null, push: (event: BusEvent) => void): () => void {
  const sub: Subscriber = { contactId, push };
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    // 顶到上限说明订阅泄漏（前端没退订）：拒绝新订阅而不是挤掉老订阅——
    // 老订阅是活着的桌面/手机会话，挤掉它等于给真用户断推送。
    return () => {};
  }
  subscribers.add(sub);
  return () => { subscribers.delete(sub); };
}

/** 发一条事件给所有匹配的订阅者。永远不抛错、永不阻塞调用方。
 *  过滤按可选的 contactId 匹配：sync 帧没有作用域，推给全部订阅者。 */
export function emit(event: BusEvent): void {
  if (subscribers.size === 0) return;
  const scope = "contactId" in event ? event.contactId : null;
  for (const sub of subscribers) {
    if (sub.contactId !== null && sub.contactId !== scope) continue;
    try {
      sub.push(event);
    } catch { /* 推送失败（连接已半死）不影响其它订阅者与主流程 */ }
  }
}

/** 新消息落库（kind=chat/proactive 的行）：界面增量拉取 / 未读数变化的信号。 */
export function emitMessage(contactId: string, conversationId: string, messageId: number): void {
  emit({ type: "message", contactId, conversationId, messageId, at: Date.now() });
}

/** 处理单状态翻转（queued→running→done/failed/cancelled）：watch 可以立刻收尾。 */
export function emitTurn(contactId: string, conversationId: string, turnId: string, status: string): void {
  emit({ type: "turn", contactId, conversationId, turnId, status, at: Date.now() });
}

/** 该联系人的会话活跃了（新消息 / 读光标前移）：侧栏未读数变化，不用等 10s 轮询。 */
export function emitActivity(contactId: string): void {
  emit({ type: "activity", contactId, at: Date.now() });
}
