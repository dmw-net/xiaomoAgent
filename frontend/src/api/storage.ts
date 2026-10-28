import { getJson, postJson } from "./client";
import type { StorageCleanupOp, StorageCleanupResult, StorageOverview } from "../types";

/** 数据占用总览：只读数据库、媒体、技能与导入前备份。 */
export function overview(): Promise<StorageOverview> {
  return getJson<StorageOverview>("/api/storage/overview");
}

/** 清理用户勾选的非核心项；后端会重新校验操作名并执行 VACUUM。 */
export function cleanup(ops: StorageCleanupOp[]): Promise<StorageCleanupResult> {
  return postJson<StorageCleanupResult>("/api/storage/cleanup", { ops }, 30_000);
}
