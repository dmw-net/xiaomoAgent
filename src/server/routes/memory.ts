// 记忆域：/api/memory（清单/搜索）、/api/memory/stats、/api/memory/events（分页）、
// /api/memory/recall（向量召回）、/api/memory/events/:id（PATCH 纠错 / DELETE 墓碑 /
// promote 提升 / restore 撤销删除）、/api/memory/from-message（显式收藏成记忆）、
// /api/search（跨联系人的消息+记忆全局搜索）。

import {
  countMemoryEvents,
  deleteMemoryEvent,
  extractFailures,
  getMemoryEvent,
  isMemoryKind,
  listMemoryEventsFiltered,
  listMemorySpaces,
  memoryCount,
  memoryStats,
  promoteMemoryEvent,
  queryVector,
  recallExplained,
  rememberMessage,
  restoreMemoryEvent,
  searchMemoryEvents,
  setMemorySpace,
  updateMemoryEvent,
  type MemoryKind,
  type MemorySpaceFilter,
} from "../../memory.ts";
import { getConversation } from "../../conversations.ts";
import { searchMessages } from "../../agent.ts";
import { clampInt, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, readJson, sendJson } from "../http.ts";
import { strictContactId } from "../context.ts";
import type { Route } from "../types.ts";

/**
 * 记忆空间筛选参数：scope=all|global|conversation，配 conversationId。
 *
 * 会话 id 必须属于这个联系人——否则拿别人的 conversationId 就能把对方群里的记忆翻出来。
 * 参数不合法（缺 id、会话不属于这位）一律当「没筛」处理，不报错：记忆页的默认视图本来就是全部。
 */
function parseSpace(url: URL, contactId: string): MemorySpaceFilter {
  const kind = url.searchParams.get("scope") ?? "all";
  if (kind !== "global" && kind !== "conversation") return { kind: "all" };
  if (kind === "global") return { kind: "global" };
  const conversationId = url.searchParams.get("conversationId") ?? "";
  return conversationId !== "" && getConversation(conversationId)?.contact_id === contactId
    ? { kind: "conversation", conversationId }
    : { kind: "all" };
}

/** GET /api/memory/spaces：这位联系人的记忆按空间盘点（全局 / 主私聊 / 每个群各多少条）。 */
const memorySpacesRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory/spaces")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  sendJson(res, 200, { ok: true, contactId, ...listMemorySpaces(contactId) });
  return true;
};

/** GET /api/memory：记忆清单或按搜索词召回（观测行为，不记成"她想起过"）。 */
const memoryRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const query = url.searchParams.get("q");
  const space = parseSpace(url, contactId);
  const events = query
    ? recallExplained(contactId, query, 10, { scope: spaceToScope(space) }).events
    : listMemoryEventsFiltered(contactId, { limit: 20, space });
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

/** 空间筛选 → 召回可见性口径。conversation 收窄到那个会话；global 与 all 不收窄。 */
function spaceToScope(space: MemorySpaceFilter): { conversationId?: string } | undefined {
  return space.kind === "conversation" ? { conversationId: space.conversationId } : undefined;
}

/** GET /api/memory/stats：记忆统计。 */
const memoryStatsRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory/stats")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  sendJson(res, 200, { ok: true, contactId, ...memoryStats(contactId) });
  return true;
};

/** GET /api/memory/events：按类型/空间/分页取记忆事件。 */
const memoryEventsRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/memory/events")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const kind = url.searchParams.get("kind") ?? undefined;
  const space = parseSpace(url, contactId);
  const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  sendJson(res, 200, {
    ok: true,
    contactId,
    kind: kind ?? null,
    offset,
    total: countMemoryEvents(contactId, { kind, space }),
    events: listMemoryEventsFiltered(contactId, { limit, kind, offset, space }),
  });
  return true;
};

/** GET /api/memory/recall：向量召回（带解释）。可按记忆空间收窄，与真实会话的可见范围对齐。 */
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
  const space = parseSpace(url, contactId);
  const result = recallExplained(contactId, query, limit, { vector: await queryVector(query), scope: spaceToScope(space) });
  sendJson(res, 200, { ok: true, contactId, ...result });
  return true;
};

/** PATCH /api/memory/events/:id：纠错通道（roadmap P0-2）+ 转移空间。
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
  // 转移空间：目标会话必须属于这位联系人（主私聊和群都是合法空间），不接受前端自己造的 id。
  let space: MemorySpaceFilter | undefined;
  if (body.space !== undefined) {
    const raw = (body.space ?? {}) as Record<string, unknown>;
    const kind = String(raw.kind ?? "");
    if (kind === "global") {
      space = { kind: "global" };
    } else if (kind === "conversation") {
      const conversationId = String(raw.conversationId ?? "");
      const conv = conversationId === "" ? null : getConversation(conversationId);
      if (conv === null || conv.contact_id !== contactId) {
        sendJson(res, 400, { ok: false, error: "目标会话不存在，或不属于这位联系人" });
        return true;
      }
      space = { kind: "conversation", conversationId };
    } else {
      sendJson(res, 400, { ok: false, error: "不认识的目标空间" });
      return true;
    }
  }
  if (Object.keys(patch).length === 0 && space === undefined) {
    sendJson(res, 400, { ok: false, error: "没有要改的字段" });
    return true;
  }
  if (Object.keys(patch).length > 0 && !updateMemoryEvent(id, contactId, patch)) {
    sendJson(res, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆不存在或不属于当前联系人" });
    return true;
  }
  if (space !== undefined && !setMemorySpace(id, contactId, space)) {
    sendJson(res, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆不存在或不属于当前联系人" });
    return true;
  }
  // 把转移后的归属回给前端：成员昵称是服务端从名册取的，界面不该自己拼一份。
  const after = space === undefined ? null : getMemoryEvent(id, contactId);
  sendJson(res, 200, {
    ok: true,
    note: space === undefined ? "记忆已更新，下次召回立即生效" : "归属已转移，只影响哪些对话能想起它",
    event: after,
  });
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
  memorySpacesRoute,
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
