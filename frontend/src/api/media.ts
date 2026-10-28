import { getJson, postJson } from "./client";
import type { MediaMaintenanceSnapshot, MediaMutationResponse } from "../types";

/** 媒体总览：图片、视频、语音及其引用来源。 */
export function inspect(): Promise<MediaMaintenanceSnapshot> {
  return getJson<MediaMaintenanceSnapshot>("/api/media/maintenance");
}

/** 后端会重新校验引用与保护期，不信任这里选中的列表。 */
export function operate(op: "trash" | "restore" | "purge" | "delete-message", names: string[]): Promise<MediaMutationResponse> {
  return postJson<MediaMutationResponse>("/api/media/maintenance", { op, names });
}
