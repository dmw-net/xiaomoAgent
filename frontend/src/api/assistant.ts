import { getJson, postJson } from "./client";

export type AssistantThread = {
  id: string; title: string; created_at: number; builtin: boolean;
  /** 这个工作区现有多少条消息、其中几张图——清空确认弹窗按它说人话。 */
  messages: number; images: number;
};

/** 工作区 → 会话联系人 id：内置「通用」就是裸 assistant，其余派生 assistant:<id>。 */
export function threadContactId(id: string): string {
  return id === "" ? "assistant" : "assistant:" + id;
}

export function listThreads(): Promise<{ threads: AssistantThread[] }> {
  return getJson("/api/assistant/threads");
}

export function createThread(title: string): Promise<{ thread: AssistantThread }> {
  return postJson("/api/assistant/threads", { title });
}

export function renameThread(id: string, title: string): Promise<unknown> {
  return postJson("/api/assistant/threads/rename", { id, title });
}

export function deleteThread(id: string): Promise<unknown> {
  return postJson("/api/assistant/threads/delete", { id });
}

/** 清空工作区里的消息（工作区保留）；id 空串 = 内置「通用」。 */
export function clearThread(id: string): Promise<{ messages: number; turns: number; media: number }> {
  return postJson("/api/assistant/threads/clear", { id });
}

// ── 权限档位与确认卡片 ──

/** readonly 断手 / confirm 危险动作要用户点击 / auto 全放。 */
export type AssistantPermission = "readonly" | "confirm" | "auto";

/** 一张待处理的确认卡片（后端 kv 待确认动作原样下发）。 */
export type AssistantPendingAction = {
  id: string;
  tool: string;
  title: string;
  detail: string;
  contactId: string;
  createdAt: number;
};

export function getPermission(): Promise<{ permission: AssistantPermission }> {
  return getJson("/api/assistant/permission");
}

export function setPermission(permission: AssistantPermission): Promise<{ permission: AssistantPermission }> {
  return postJson("/api/assistant/permission", { permission });
}

export function fetchPending(contactId: string): Promise<{ pending: AssistantPendingAction[] }> {
  return getJson(`/api/assistant/pending?contactId=${encodeURIComponent(contactId)}`);
}

/** 同意后后端执行动作并自动发一条续跑消息，后续轮次由现有消息轮询接管。 */
export function confirmPending(id: string): Promise<{ executed: boolean; turnId: string }> {
  return postJson(`/api/assistant/pending/${id}/confirm`, {});
}

export function declinePending(id: string): Promise<{ executed: boolean; turnId: string }> {
  return postJson(`/api/assistant/pending/${id}/decline`, {});
}
