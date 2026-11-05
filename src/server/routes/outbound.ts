// 出站队列与死信队列：用户可查看、重试、忽略；开发模式额外提供批量重试与清理。

import { config } from "../../core/config.ts";
import { clampInt, LIST_LIMIT_MAX, sendJson } from "../http.ts";
import type { Route } from "../types.ts";
import {
  channelOf, ignore, list, outboundSummary, retryAndDeliver,
} from "../../channels/outbound.ts";
import { listDeliveries, purgeTerminal } from "../../core/dqueue.ts";

const STATUSES = new Set(["open", "dead", "all", "pending", "in_flight", "failed", "delivered", "dead_letter", "expired", "ignored"]);

function userReason(reason: string | undefined): string {
  if (!reason) return "投递失败";
  if (/权限|主动|窗口|msg_id/i.test(reason)) return "主动消息权限或回复窗口已失效";
  if (/密钥|鉴权|401|403|token/i.test(reason)) return "通道凭证失效";
  if (/未绑定|未配置|停用/i.test(reason)) return "通道未绑定或已停用";
  if (/网络|连接|timeout|超时|fetch|ECONN/i.test(reason)) return "连接通道失败";
  return "投递失败，可稍后重试";
}

function safeRow(row: ReturnType<typeof listDeliveries>["rows"][number]): Record<string, unknown> {
  return {
    id: row.id,
    contactName: row.contactName ?? row.contactId,
    channel: row.channel,
    kind: row.kind,
    status: row.status,
    text: row.text.slice(0, 200),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
    scheduledAt: row.scheduledAt,
    failedAt: row.failedAt,
    reason: row.reason ? userReason(row.reason) : undefined,
  };
}

function devRow(row: ReturnType<typeof listDeliveries>["rows"][number]): Record<string, unknown> {
  return { ...row };
}

const listRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && (path === "/api/outbound/deliveries" || path === "/api/outbound/summary"))) return false;
  const devMode = config.devMode;
  if (path === "/api/outbound/summary") {
    sendJson(res, 200, { ok: true, devMode, summary: outboundSummary() });
    return true;
  }
  const rawStatus = url.searchParams.get("status") ?? "open";
  const status = STATUSES.has(rawStatus) ? rawStatus : "open";
  const filter = {
    status: status as "open" | "dead" | "all" | "pending" | "in_flight" | "failed" | "delivered" | "dead_letter" | "expired" | "ignored",
    channel: channelOf(url.searchParams.get("channel")),
    contactId: url.searchParams.get("contactId") || undefined,
    query: url.searchParams.get("q") || undefined,
    limit: clampInt(url.searchParams.get("limit"), 25, 1, LIST_LIMIT_MAX),
    offset: clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
  };
  const data = list(filter);
  sendJson(res, 200, {
    ok: true,
    devMode,
    summary: outboundSummary(),
    filter,
    total: data.total,
    rows: devMode ? data.rows.map(devRow) : data.rows.map(safeRow),
  });
  return true;
};

const actionRoute: Route = async ({ res, path, method }) => {
  if (method !== "POST") return false;
  const retryMatch = path.match(/^\/api\/outbound\/deliveries\/([^/]+)\/retry$/);
  if (retryMatch) {
    const id = decodeURIComponent(retryMatch[1] ?? "");
    const ok = retryAndDeliver(id);
    sendJson(res, ok ? 200 : 409, ok
      ? { ok: true, id, queued: true, message: "已重新放入投递队列" }
      : { ok: false, error: "这条记录当前不能重试（可能已在发送、已送达或不存在）" });
    return true;
  }
  const ignoreMatch = path.match(/^\/api\/outbound\/deliveries\/([^/]+)\/ignore$/);
  if (ignoreMatch) {
    const id = decodeURIComponent(ignoreMatch[1] ?? "");
    const ok = ignore(id);
    sendJson(res, ok ? 200 : 409, ok
      ? { ok: true, id, message: "已忽略这条投递" }
      : { ok: false, error: "只有失败、死信或已过期的记录可以忽略" });
    return true;
  }
  if (path === "/api/outbound/retry-all" && config.devMode) {
    const rows = listDeliveries({ status: "dead", limit: 100 }).rows;
    let queued = 0;
    for (const row of rows) if (retryAndDeliver(row.id)) queued += 1;
    sendJson(res, 200, { ok: true, queued, message: `已重新排队 ${queued} 条` });
    return true;
  }
  if (path === "/api/outbound/purge" && config.devMode) {
    const before = Date.now() - 7 * 24 * 3_600_000;
    const removed = purgeTerminal(before);
    sendJson(res, 200, { ok: true, removed, message: `已清理 ${removed} 条超过 7 天的终态记录` });
    return true;
  }
  return false;
};

export const outboundRoutes: Route[] = [listRoute, actionRoute];
