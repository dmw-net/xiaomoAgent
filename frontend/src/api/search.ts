import { getJson } from "./client";
import type { MessageHit, MemoryHit } from "../types/search";

/** 全局搜索：消息 + 记忆，跨联系人。 */
export function globalSearch(q: string): Promise<{ q: string; messages: MessageHit[]; memories: MemoryHit[] }> {
  return getJson("/api/search?q=" + encodeURIComponent(q.trim()));
}
