/**
 * 服务端持久出盒箱 + 死信队列。
 *
 * 状态机：
 *   pending -> in_flight -> delivered
 *                       \-> failed -> pending ... -> dead_letter
 *   pending/failed -> expired（超过该档位的时效窗口）
 *   failed/dead_letter/expired -> pending（用户手动重试）
 *   failed/dead_letter/expired -> ignored（用户手动忽略）
 *
 * 这里只负责持久化与查询；真正的发送与调度在 outbound.ts。
 */

import { q } from "./db.ts";
import { deliveryExpiry, type Tier } from "./reliability.ts";

export type OutboundChannel = "qq" | "wechat" | "web";
export type OutboundStatus = "pending" | "in_flight" | "delivered" | "failed" | "dead_letter" | "expired" | "ignored";
export type OutboundKind = "chat" | "proactive";

export interface OutboundDelivery {
  id: string;
  contactId: string;
  contactName?: string;
  conversationId: string;
  channel: OutboundChannel;
  text: string;
  segments?: string[];
  attachments?: string[];
  attachmentMeta?: unknown;
  kind: OutboundKind;
  status: OutboundStatus;
  attempts: number;
  maxAttempts: number;
  tier: Tier;
  freshnessAt?: number;
  lastError?: string;
  reason?: string;
  sourceMessageId?: string;
  createdAt: number;
  scheduledAt?: number;
  deliveredAt?: number;
  failedAt?: number;
  ignoredAt?: number;
}

const TABLE = "outbound_deliveries";

function jsonArray(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  } catch { return undefined; }
}

function jsonValue(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

function rowToDelivery(row: Record<string, unknown>): OutboundDelivery {
  const segments = jsonArray(row.segments);
  const attachments = jsonArray(row.attachments);
  const attachmentMeta = jsonValue(row.attachment_meta);
  return {
    id: String(row.id ?? ""),
    contactId: String(row.contact_id ?? ""),
    ...(typeof row.contact_name === "string" && row.contact_name !== "" ? { contactName: row.contact_name } : {}),
    conversationId: String(row.conversation_id ?? ""),
    channel: String(row.channel ?? "qq") as OutboundChannel,
    text: String(row.text ?? ""),
    ...(segments ? { segments } : {}),
    ...(attachments ? { attachments } : {}),
    ...(attachmentMeta !== undefined ? { attachmentMeta } : {}),
    kind: String(row.kind ?? "chat") as OutboundKind,
    status: String(row.status ?? "pending") as OutboundStatus,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 6),
    tier: String(row.tier ?? "interactive") as Tier,
    ...(row.freshness_at === null || row.freshness_at === undefined ? {} : { freshnessAt: Number(row.freshness_at) }),
    ...(typeof row.last_error === "string" && row.last_error !== "" ? { lastError: row.last_error } : {}),
    ...(typeof row.reason === "string" && row.reason !== "" ? { reason: row.reason } : {}),
    ...(typeof row.source_message_id === "string" && row.source_message_id !== "" ? { sourceMessageId: row.source_message_id } : {}),
    createdAt: Number(row.created_at ?? 0),
    ...(row.scheduled_at === null || row.scheduled_at === undefined ? {} : { scheduledAt: Number(row.scheduled_at) }),
    ...(row.delivered_at === null || row.delivered_at === undefined ? {} : { deliveredAt: Number(row.delivered_at) }),
    ...(row.failed_at === null || row.failed_at === undefined ? {} : { failedAt: Number(row.failed_at) }),
    ...(row.ignored_at === null || row.ignored_at === undefined ? {} : { ignoredAt: Number(row.ignored_at) }),
  };
}

const SELECT_JOIN = `
  SELECT d.*, c.name AS contact_name
  FROM ${TABLE} d
  LEFT JOIN contacts c ON c.id = d.contact_id`;

export function enqueue(id: string, opts: {
  contactId: string;
  conversationId?: string;
  channel: OutboundChannel;
  text: string;
  segments?: string[];
  attachments?: string[];
  attachmentMeta?: unknown;
  kind?: OutboundKind;
  tier: Tier;
  maxAttempts?: number;
  sourceMessageId?: string;
}): void {
  const now = Date.now();
  const freshnessAt = deliveryExpiry(now, opts.tier) ?? null;
  const text = opts.text.trim() !== "" ? opts.text : (opts.segments ?? []).join("\n\n");
  q(`INSERT INTO ${TABLE}
       (id, contact_id, conversation_id, channel, text, segments, attachments, attachment_meta, kind, status,
        attempts, max_attempts, tier, freshness_at, source_message_id, created_at, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, COALESCE(?, 6), ?, ?, ?, ?, ?)`).run(
    id,
    opts.contactId,
    opts.conversationId ?? "",
    opts.channel,
    text,
    opts.segments && opts.segments.length > 0 ? JSON.stringify(opts.segments) : null,
    opts.attachments && opts.attachments.length > 0 ? JSON.stringify(opts.attachments) : null,
    opts.attachmentMeta === undefined ? null : JSON.stringify(opts.attachmentMeta),
    opts.kind ?? "chat",
    opts.maxAttempts ?? 6,
    opts.tier,
    freshnessAt,
    opts.sourceMessageId ?? null,
    now,
    now,
  );
}

export function getPending(now: number, limit = 10): string[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return (q(`SELECT id FROM ${TABLE}
      WHERE status IN ('pending', 'failed') AND scheduled_at <= ?
        AND max_attempts > attempts
      ORDER BY scheduled_at ASC, created_at ASC LIMIT ?`).all(now, safeLimit) as Array<{ id: string }>)
    .map((row) => row.id);
}

export function markInFlight(id: string): boolean {
  return Number(q(`UPDATE ${TABLE} SET status = 'in_flight' WHERE id = ? AND status IN ('pending', 'failed')`).run(id).changes) === 1;
}

export function markDelivered(id: string, deliveredAt = Date.now()): void {
  q(`UPDATE ${TABLE} SET status = 'delivered', delivered_at = ?, last_error = NULL, reason = NULL WHERE id = ?`)
    .run(deliveredAt, id);
}

export function markExpired(id: string, now = Date.now()): void {
  q(`UPDATE ${TABLE} SET status = 'expired', failed_at = ?, scheduled_at = NULL, reason = COALESCE(reason, '已超过时效窗口') WHERE id = ?`)
    .run(now, id);
}

export function markFailed(id: string, error: Error | string, scheduleAt: number, tier: Tier, freshAt?: number): void {
  const current = getById(id);
  if (current === null || current.status === "delivered" || current.status === "ignored") return;
  const message = (error instanceof Error ? error.message : error).slice(0, 500);
  const nextAttempts = current.attempts + 1;
  const expiresAt = freshAt ?? deliveryExpiry(current.createdAt, tier);
  const expired = expiresAt !== undefined && scheduleAt >= expiresAt;
  const dead = expired || nextAttempts >= current.maxAttempts;
  q(`UPDATE ${TABLE} SET
       status = ?,
       attempts = ?,
       last_error = ?,
       reason = ?,
       scheduled_at = ?,
       failed_at = ?
     WHERE id = ?`).run(
    expired ? "expired" : dead ? "dead_letter" : "failed",
    nextAttempts,
    message,
    message,
    dead ? null : scheduleAt,
    dead ? scheduleAt : null,
    id,
  );
}

export function retryDelivery(id: string, now = Date.now()): boolean {
  const current = getById(id);
  if (current === null || current.status === "pending" || current.status === "in_flight" || current.status === "delivered") return false;
  const result = q(`UPDATE ${TABLE} SET
      status = 'pending', attempts = 0, last_error = NULL, reason = NULL,
      scheduled_at = ?, failed_at = NULL, ignored_at = NULL
    WHERE id = ?`).run(now, id);
  return Number(result.changes) === 1;
}

export function ignoreDelivery(id: string, now = Date.now()): boolean {
  const result = q(`UPDATE ${TABLE} SET status = 'ignored', ignored_at = ?, scheduled_at = NULL
    WHERE id = ? AND status IN ('failed', 'dead_letter', 'expired')`).run(now, id);
  return Number(result.changes) === 1;
}

export function recoverInFlight(now = Date.now()): number {
  const result = q(`UPDATE ${TABLE} SET status = 'pending', scheduled_at = ? WHERE status = 'in_flight'`).run(now);
  return Number(result.changes);
}

export function getById(id: string): OutboundDelivery | null {
  const row = q(`${SELECT_JOIN} WHERE d.id = ?`).get(id) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToDelivery(row);
}

export function purgeExpired(now = Date.now()): number {
  const result = q(`DELETE FROM ${TABLE} WHERE status = 'expired' AND failed_at IS NOT NULL AND failed_at < ?`).run(now);
  return Number(result.changes);
}

export function purgeTerminal(now = Date.now(), ids?: string[]): number {
  if (ids !== undefined && ids.length > 0) {
    let changed = 0;
    for (const id of ids.slice(0, 100)) {
      const result = q(`DELETE FROM ${TABLE} WHERE id = ? AND status IN ('dead_letter', 'expired', 'ignored')`).run(id);
      changed += Number(result.changes);
    }
    return changed;
  }
  const result = q(`DELETE FROM ${TABLE} WHERE status IN ('dead_letter', 'expired', 'ignored') AND created_at < ? AND (failed_at IS NULL OR failed_at < ?) AND (ignored_at IS NULL OR ignored_at < ?)`).run(now, now, now);
  return Number(result.changes);
}

export function countPending(): number {
  const row = q(`SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE status IN ('pending', 'failed')`).get() as
    | { cnt: number | bigint }
    | undefined;
  return Number(row?.cnt ?? 0);
}

export type DeliveryFilter = {
  status?: OutboundStatus | "open" | "dead" | "all";
  channel?: OutboundChannel;
  contactId?: string;
  query?: string;
  limit?: number;
  offset?: number;
};

function whereOf(filter: DeliveryFilter): { sql: string; args: Array<string | number> } {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  if (filter.status === "open") clauses.push("d.status IN ('pending', 'in_flight', 'failed')");
  else if (filter.status === "dead") clauses.push("d.status IN ('dead_letter', 'expired')");
  else if (filter.status && filter.status !== "all") { clauses.push("d.status = ?"); args.push(filter.status); }
  if (filter.channel) { clauses.push("d.channel = ?"); args.push(filter.channel); }
  if (filter.contactId) { clauses.push("d.contact_id = ?"); args.push(filter.contactId); }
  if (filter.query && filter.query.trim() !== "") {
    clauses.push("(d.text LIKE ? OR d.last_error LIKE ?)");
    const like = `%${filter.query.trim()}%`;
    args.push(like, like);
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", args };
}

export function listDeliveries(filter: DeliveryFilter = {}): { rows: OutboundDelivery[]; total: number } {
  const where = whereOf(filter);
  const limit = Math.max(1, Math.min(100, Math.trunc(filter.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
  const rows = q(`${SELECT_JOIN}${where.sql} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`)
    .all(...where.args, limit, offset) as Record<string, unknown>[];
  const count = q(`SELECT COUNT(*) AS c FROM ${TABLE} d${where.sql}`).get(...where.args) as { c: number | bigint };
  return { rows: rows.map(rowToDelivery), total: Number(count.c) };
}

export type OutboundSummary = {
  counts: Record<OutboundStatus, number>;
  open: number;
  dead: number;
  total: number;
  oldestOpenAt: number | null;
  oldestDeadAt: number | null;
};

export function summary(_now = Date.now()): OutboundSummary {
  const counts: Record<OutboundStatus, number> = {
    pending: 0, in_flight: 0, delivered: 0, failed: 0, dead_letter: 0, expired: 0, ignored: 0,
  };
  for (const row of q(`SELECT status, COUNT(*) AS n FROM ${TABLE} GROUP BY status`).all() as Array<{ status: OutboundStatus; n: number | bigint }>) {
    counts[row.status] = Number(row.n);
  }
  const openRow = q(`SELECT MIN(created_at) AS at FROM ${TABLE} WHERE status IN ('pending', 'in_flight', 'failed')`).get() as
    | { at: number | null }
    | undefined;
  const deadRow = q(`SELECT MIN(created_at) AS at FROM ${TABLE} WHERE status IN ('dead_letter', 'expired')`).get() as
    | { at: number | null }
    | undefined;
  return {
    counts,
    open: counts.pending + counts.in_flight + counts.failed,
    dead: counts.dead_letter + counts.expired,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    oldestOpenAt: openRow?.at === null || openRow?.at === undefined ? null : Number(openRow.at),
    oldestDeadAt: deadRow?.at === null || deadRow?.at === undefined ? null : Number(deadRow.at),
  };
}

export function nextSchedule(tier: Tier, attempt: number, rateLimitMs?: number): number {
  const now = Date.now();
  const baseMs = tier === "interactive" ? 1000 : tier === "proactive" ? 2000 : 3000;
  const delay = Math.min(baseMs * 2 ** Math.max(0, attempt), 45_000);
  const effectiveDelay = rateLimitMs !== undefined ? Math.max(delay, rateLimitMs) : delay;
  return now + effectiveDelay;
}
