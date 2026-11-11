import { cq, deleteJson, getJson, patchJson, postJson } from "./client";
import type { MemorySpaceInventory, MemorySpaceSelection, MemoryStats, MemoryEvent, RecallResult } from "../types";

/** cid 省略时跟随全局当前联系人；联系人资料页内嵌面板显式传入。 */

/** 空间筛选拼进查询串：后端按 scope / conversationId 两个参数解析。 */
function spaceQuery(space?: MemorySpaceSelection): string {
  if (!space || space.kind === "all") return "";
  if (space.kind === "global") return "&scope=global";
  return "&scope=conversation&conversationId=" + encodeURIComponent(space.conversationId);
}

export function fetchMemorySpaces(cid?: string): Promise<MemorySpaceInventory> {
  return getJson(cq("/api/memory/spaces", cid));
}

export function fetchMemoryStats(cid?: string): Promise<MemoryStats> {
  return getJson(cq("/api/memory/stats", cid));
}

/** 每页条数由调用方给（走「界面 → 列表每页」那一档）。 */
export function fetchMemoryEvents(kind: string, offset = 0, limit = 25, cid?: string, space?: MemorySpaceSelection): Promise<{ events: MemoryEvent[]; total: number }> {
  const url = cq("/api/memory/events?limit=" + limit + "&offset=" + offset + (kind ? "&kind=" + encodeURIComponent(kind) : "") + spaceQuery(space), cid);
  return getJson(url);
}

/** 召回可解释：结果 + 相关度 + 命中关键词。带空间时只在那个空间能看见的记忆里查。 */
export function recall(q: string, limit = 6, cid?: string, space?: MemorySpaceSelection): Promise<RecallResult> {
  return getJson(cq("/api/memory/recall?q=" + encodeURIComponent(q.trim()) + "&limit=" + limit + spaceQuery(space), cid));
}

/** 纠正一条记忆（P0-2）：改内容/类型/重要度，也可以只转移归属空间。 */
export function editMemoryEvent(id: number, patch: {
  content?: string;
  kind?: string;
  weight?: number;
  space?: MemorySpaceSelection;
}, cid?: string): Promise<{ note: string; event?: MemoryEvent | null }> {
  return patchJson(cq("/api/memory/events/" + id, cid), patch);
}

/** 删一条记忆：墓碑标记，联系人不会再想起。 */
export function deleteMemoryEvent(id: number, cid?: string): Promise<{ note: string }> {
  return deleteJson(cq("/api/memory/events/" + id, cid));
}

/** 用户主动把一条消息记成长期记忆；按 message id 幂等。 */
export function rememberMessage(messageId: number, cid?: string): Promise<{ id: number; duplicate: boolean; note: string }> {
  return postJson(cq("/api/memory/from-message", cid), { messageId });
}

/** 手动把群/成员记忆提升为联系人全局记忆。 */
export function promoteMemoryEvent(id: number, cid?: string): Promise<{ note: string }> {
  return postJson(cq("/api/memory/events/" + id + "/promote", cid));
}

/** 撤销删除：墓碑擦掉就回来（删记忆本来就是软删）。 */
export function restoreMemoryEvent(id: number, cid?: string): Promise<{ note: string }> {
  return postJson(cq("/api/memory/events/" + id + "/restore", cid));
}
