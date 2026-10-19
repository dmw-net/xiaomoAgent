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
