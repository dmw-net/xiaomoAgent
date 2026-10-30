// 记忆域：/api/memory（清单/搜索）、/api/memory/stats、/api/memory/events（分页）、
// /api/memory/recall（向量召回）、/api/memory/events/:id（PATCH 纠错 / DELETE 墓碑 /
// promote 提升 / restore 撤销删除）、/api/memory/from-message（显式收藏成记忆）、
// /api/search（跨联系人的消息+记忆全局搜索）。

import {
  deleteMemoryEvent,
  extractFailures,
  isMemoryKind,
  listMemoryEventsFiltered,
  memoryCount,
  memoryStats,
  promoteMemoryEvent,
  queryVector,
  recallExplained,
  rememberMessage,
  restoreMemoryEvent,
  searchMemoryEvents,
  updateMemoryEvent,
  type MemoryKind,
} from "../../memory.ts";
import { searchMessages } from "../../agent.ts";
import { clampInt, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, readJson, sendJson } from "../http.ts";
import { strictContactId } from "../context.ts";
import type { Route } from "../types.ts";

/** GET /api/memory：记忆清单或按搜索词召回（观测行为，不记成"她想起过"）。 */
const memoryRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const query = url.searchParams.get("q");
  const events = query ? recallExplained(contactId, query, 10).events : listMemoryEventsFiltered(contactId, { limit: 20 });
  sendJson(res, 200, {
    ok: true,
    contactId,
    total: memoryCount(contactId),
    extractFailures: extractFailures(contactId),
    query: query ?? null,
    events,
  });
  return true;
};

/** GET /api/memory/stats：记忆统计。 */
const memoryStatsRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory/stats")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  sendJson(res, 200, { ok: true, contactId, ...memoryStats(contactId) });
  return true;
};

/** GET /api/memory/events：按类型/分页取记忆事件。 */
const memoryEventsRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory/events")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const kind = url.searchParams.get("kind") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  sendJson(res, 200, {
    ok: true,
    contactId,
    kind: kind ?? null,
    offset,
    total: memoryCount(contactId, kind),
    events: listMemoryEventsFiltered(contactId, { limit, kind, offset }),
  });
  return true;
};

/** GET /api/memory/recall：向量召回（带解释）。 */
const memoryRecallRoute: Route = async ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory/recall")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const query = (url.searchParams.get("q") ?? "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 6, 1, 50);
  if (query === "") {
    sendJson(res, 400, { ok: false, error: "q 不能为空" });
    return true;
  }
  const result = recallExplained(contactId, query, limit, { vector: await queryVector(query) });
  sendJson(res, 200, { ok: true, contactId, ...result });
  return true;
};

/** PATCH /api/memory/events/:id：纠错通道（roadmap P0-2）。
 *  归属校验在 SQL 里（id + contact_id 同时匹配），拿别人的记忆 id 改不动。 */
const memoryEventPatchRoute: Route = async ({ req, res, url, path, method }) => {
  if (method !== "PATCH") return false;
  const memoryEventMatch = /^\/api\/memory\/events\/(\d+)$/.exec(path);
  if (!memoryEventMatch) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = Number(memoryEventMatch[1]);
  const body = await readJson<Record<string, unknown>>(req);
  const patch: { content?: string; kind?: MemoryKind; weight?: number } = {};
  if (typeof body.content === "string") {
    const content = body.content.trim();
    if (content === "" || content.length > 60) {
      sendJson(res, 400, { ok: false, error: "记忆内容要在 1~60 字之间" });
      return true;
    }
    patch.content = content;
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== "string" || !isMemoryKind(body.kind)) {
      sendJson(res, 400, { ok: false, error: "记忆类型不认识" });
      return true;
    }
    patch.kind = body.kind;
  }
  if (body.weight !== undefined) {
    const w = Number(body.weight);
    if (!Number.isFinite(w)) {
      sendJson(res, 400, { ok: false, error: "重要度得是数字" });
      return true;
    }
    patch.weight = Math.min(3, Math.max(0.5, w));
  }
  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { ok: false, error: "没有要改的字段" });
    return true;
  }
  if (!updateMemoryEvent(id, contactId, patch)) {
    sendJson(res, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆不存在或不属于当前联系人" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "记忆已更新，下次召回立即生效" });
  return true;
};

/** DELETE /api/memory/events/:id：墓碑删除。 */
const memoryEventDeleteRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "DELETE" && /^\/api\/memory\/events\/(\d+)$/.test(path))) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const id = Number(/^\/api\/memory\/events\/(\d+)$/.exec(path)![1]);
  if (!deleteMemoryEvent(id, contactId)) {
    sendJson(res, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆不存在或不属于当前联系人" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: `已删除，该联系人不会再想起这件事` });
  return true;
};

/** POST /api/memory/events/:id/promote：提升为全局记忆。 */
const memoryEventPromoteRoute: Route = ({ res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/memory\/events\/(\d+)\/promote$/) : null;
  if (!m) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  if (!promoteMemoryEvent(Number(m[1]), contactId)) {
    sendJson(res, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆不存在或不属于当前联系人" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "已提升为联系人全局记忆，其他会话也能召回" });
  return true;
};

/** POST /api/memory/events/:id/restore：撤销删除（墓碑擦掉即恢复）。 */
const memoryEventRestoreRoute: Route = ({ res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/memory\/events\/(\d+)\/restore$/) : null;
  if (!m) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  if (!restoreMemoryEvent(Number(m[1]), contactId)) {
    sendJson(res, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆没被删过，或不属于当前联系人" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "已撤销删除，这条记忆已经恢复" });
  return true;
};

/** POST /api/memory/from-message：把一条消息显式收藏成长期记忆（幂等）。 */
const memoryFromMessageRoute: Route = async ({ req, res, url, path, method }) => {
  if (!(method === "POST" && path === "/api/memory/from-message")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const body = await readJson<{ messageId?: unknown }>(req);
  const messageId = Math.trunc(Number(body.messageId));
  if (!Number.isInteger(messageId) || messageId <= 0) {
    sendJson(res, 400, { ok: false, error: "messageId 不合法" });
    return true;
  }
  const result = rememberMessage(messageId, contactId);
  if (!result) {
    sendJson(res, 404, { ok: false, error: "这条消息不存在、不属于当前联系人或没有文字" });
    return true;
  }
  sendJson(res, 200, {
    ok: true,
    id: result.id,
    duplicate: result.duplicate,
    note: result.duplicate ? "这条已经在记忆里了" : "已记到联系人的长期记忆",
  });
  return true;
};

/** GET /api/search：跨联系人的消息 + 记忆全局搜索。 */
const globalSearchRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/search")) return false;
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "" || q.length > 50) {
    sendJson(res, 400, { ok: false, error: "q 要在 1~50 个字之间" });
    return true;
  }
  sendJson(res, 200, { ok: true, q, messages: searchMessages(q, 50), memories: searchMemoryEvents(q, 50) });
  return true;
};

export const routes: Route[] = [
  memoryRoute,
  memoryStatsRoute,
  memoryEventsRoute,
  memoryRecallRoute,
  memoryEventPatchRoute,
  memoryEventDeleteRoute,
  memoryEventPromoteRoute,
  memoryEventRestoreRoute,
  memoryFromMessageRoute,
  globalSearchRoute,
];
