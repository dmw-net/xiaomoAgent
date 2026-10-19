import { cq, deleteJson, getJson, patchJson, postJson } from "./client";
import type { MemoryStats, MemoryEvent, RecallResult } from "../types";

/** cid 省略时跟随全局当前联系人；联系人资料页内嵌面板显式传入。 */

export function fetchMemoryStats(cid?: string): Promise<MemoryStats> {
  return getJson(cq("/api/memory/stats", cid));
}

/** 每页条数由调用方给（走「界面 → 列表每页」那一档）：从前这里写死 200，
 *  与后端默认 100、上限 500 是三套口径。 */
export function fetchMemoryEvents(kind: string, offset = 0, limit = 25, cid?: string): Promise<{ events: MemoryEvent[]; total: number }> {
  const url = cq("/api/memory/events?limit=" + limit + "&offset=" + offset + (kind ? "&kind=" + encodeURIComponent(kind) : ""), cid);
  return getJson(url);
}

/** 召回可解释：结果 + 相关度 + 命中关键词。 */
export function recall(q: string, limit = 6, cid?: string): Promise<RecallResult> {
  return getJson(cq("/api/memory/recall?q=" + encodeURIComponent(q.trim()) + "&limit=" + limit, cid));
}

/** 纠正一条记忆（P0-2）：改内容/类型/重要度。 */
export function editMemoryEvent(id: number, patch: { content?: string; kind?: string; weight?: number }, cid?: string): Promise<{ note: string }> {
  return patchJson(cq("/api/memory/events/" + id, cid), patch);
}

/** 删一条记忆：墓碑标记，她不会再想起。 */
export function deleteMemoryEvent(id: number, cid?: string): Promise<{ note: string }> {
  return deleteJson(cq("/api/memory/events/" + id, cid));
}

/** 用户主动把一条消息记成长期记忆；按 message id 幂等。 */
export function rememberMessage(messageId: number, cid?: string): Promise<{ id: number; duplicate: boolean; note: string }> {
  return postJson(cq("/api/memory/from-message", cid), { messageId });
}

/** 撤销删除：墓碑擦掉就回来（删记忆本来就是软删）。 */
export function restoreMemoryEvent(id: number, cid?: string): Promise<{ note: string }> {
  return postJson(cq("/api/memory/events/" + id + "/restore", cid));
}
