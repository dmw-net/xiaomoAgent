// 事件总线：服务端把「她那边发生了什么」推给前端，替代一部分空转轮询。
//
// 设计纪律：
// - 这是**提示通道**，不是数据通道。事件只说「哪类东西动了」，不搬数据本体
//   （消息全文、草稿增量都在库里有正式接口）。前端收到事件才去拉对应的一小段——
//   断线重连、事件丢失都不丢数据，最坏就是多一次轮询。
// - 推送必须**永不抛错**：订阅者满、连接半死、序列化失败都静默降级，
//   主流程（写库、回消息）绝不被这条辅助路拖住。
// - 每 25s 一拍心跳（SSE 注释行）：中间人/CSP 空闲断连时客户端靠它探活，
//   前端 EventSource 断了自动重连，重连后服务端重发一份全量 sync 帧对齐。

export type BusEvent =
  | { type: "sync"; at: number }
  | { type: "message"; contactId: string; conversationId: string; messageId: number; at: number }
  | { type: "turn"; contactId: string; conversationId: string; turnId: string; status: string; at: number }
  | { type: "activity"; contactId: string; at: number };

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
