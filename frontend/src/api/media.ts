import { getJson, postJson } from "./client";
import type { MediaMaintenanceSnapshot, MediaMutationResponse } from "../types";

/** 媒体清理视图：普通聊天图中超过保护期、且没有任何引用来源的文件。 */
export function inspect(): Promise<MediaMaintenanceSnapshot> {
  return getJson<MediaMaintenanceSnapshot>("/api/media/maintenance");
}

/** 后端会重新校验引用与保护期，不信任这里选中的列表。 */
export function operate(op: "trash" | "restore" | "purge", names: string[]): Promise<MediaMutationResponse> {
  return postJson<MediaMutationResponse>("/api/media/maintenance", { op, names });
}
