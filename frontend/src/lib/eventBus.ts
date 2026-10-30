/**
 * 前端事件总线：一条 SSE 长连接（/api/events）把「她那边发生了什么」推下来，
 * 替代一部分空转轮询。
 *
 * 纪律（与后端 events.ts 同源）：
 * - 这是**提示通道**，不是数据通道。事件只报 id/status，正文照旧走 /api/messages?since=、
 *   /api/contacts。断线、丢帧都不丢数据——EventSource 自带重连，重连后首帧 sync 会
 *   提示订阅方补一次增量；轮询降级成这条连接不可用时的兜底。
 * - 永不向调用方抛错：解析失败、连接抖动都只是「这一帧没到」，下一拍/下一轮轮询照旧。
 *
 * 单例：全站只开一条连接（App 外壳启一次），各消费方（contactsStore / ChatView）
 * 通过 onBusEvent 订阅。
 */

export type BusEvent =
  | { type: "sync"; at: number }
  | { type: "message"; contactId: string; conversationId: string; messageId: number; at: number }
  | { type: "turn"; contactId: string; conversationId: string; turnId: string; status: string; at: number }
  | { type: "activity"; contactId: string; at: number };

type Handler = (event: BusEvent) => void;

let started = false;
/** 连接是否活着：消费方据此决定「信推送」还是「退回轮询兜底」。 */
let connected = false;

const handlers = new Set<Handler>();

export function isBusConnected(): boolean {
  return connected;
}

export function onBusEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

function dispatch(event: BusEvent): void {
  for (const handler of handlers) {
    try { handler(event); } catch { /* 单个订阅者炸了不连累别人 */ }
  }
}

export function startEventBus(): void {
  if (started || typeof EventSource === "undefined") return;
  started = true;
  connect();
}

function connect(): void {
  // 不带 contactId 过滤 = 服务端推所有联系人的事件（单连接覆盖全应用）；
  // 订阅方自己按当前联系人筛。切换联系人不用重连这条连接。
  const es = new EventSource("/api/events", { withCredentials: false });
  es.onopen = () => {
    connected = true;
    // 连上的那一刻先对齐一次：重连会落到新的 sync 帧，订阅方据此补增量。
    dispatch({ type: "sync", at: Date.now() });
  };
  es.onmessage = (message) => {
    let event: BusEvent;
    try {
      event = JSON.parse(String(message.data)) as BusEvent;
    } catch {
      return; // 半帧/畸形：丢弃，不影响连接
    }
    if (event && typeof event === "object" && typeof event.type === "string") dispatch(event);
  };
  es.onerror = () => {
    // EventSource 会在 error 后自动重连；这里只更新「连接活着」的事实供轮询兜底判断。
    connected = false;
  };
}
