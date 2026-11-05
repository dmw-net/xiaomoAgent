// 事件总线（SSE）：把「联系人那边发生了什么」推给在线客户端，替代空转轮询。
// 提示通道不是数据通道：帧里只有 id/status，正文照旧走 /api/messages?since=。

import { subscribe, type BusEvent } from "../../core/events.ts";
import { HTML_SECURITY_HEADERS } from "../http.ts";
import type { Route } from "../types.ts";

const eventsRoute: Route = ({ req, res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/events")) return false;
  const contactParam = url.searchParams.get("contactId");
  const contactFilter = typeof contactParam === "string" && contactParam !== "" ? contactParam : null;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    ...HTML_SECURITY_HEADERS,
  });
  // 首帧 sync：客户端（重）连接先对齐一次——它据此拉 since= 增量补齐推送前漏掉的东西。
  res.write(`data: ${JSON.stringify({ type: "sync", at: Date.now() } satisfies BusEvent)}\n\n`);
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (unsubscribe !== null) unsubscribe();
    if (heartbeat !== null) clearInterval(heartbeat);
    try { res.end(); } catch { /* 连接已死 */ }
  };
  unsubscribe = subscribe(contactFilter, (event) => {
    if (closed) return;
    // 写失败 = 客户端已半死：静默退订，下一帧自然补不上了，兜底轮询会拉齐。
    if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) {
      res.once("drain", close);
    }
  });
  // 心跳（SSE 注释行）：中间空闲断连的探活，25s 一拍，浏览器 EventSource 靠它保活。
  heartbeat = setInterval(() => {
    if (closed) return;
    if (!res.write(": ping\n\n")) close();
  }, 25_000);
  req.once("close", close);
  return true;
};

export const routes: Route[] = [eventsRoute];
