// 数据占用与用户可选的清理项。
//
// 这里只处理“丢了也不影响聊天关系”的数据：
// - 模型调用的请求/响应全文：仅开发模式保存，是排障证据，不是用户内容；
// - 调用记录本身：用量统计会跟着清空，但联系人、消息、记忆都不动；
// - 导入前自动留下的旧库/旧媒体备份：有当前数据后通常不再需要。
//
// 聊天正文、长期记忆、联系人、API Key、媒体引用都不在这个模块的删除范围里。

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { config } from "./config.ts";
import { compactDb, db } from "./db.ts";
import { clearModelCallBodies, clearModelCallHistory, modelCallBodyStats } from "./logs.ts";
import { mediaDir } from "../media/media.ts";
import { skillsDir } from "../mind/skills.ts";

export const STORAGE_CLEANUP_OPS = ["diagnosticBodies", "modelCalls", "importBackups", "compact"] as const;
export type StorageCleanupOp = (typeof STORAGE_CLEANUP_OPS)[number];

export type StorageOverview = {
  dataDir: string;
  devMode: boolean;
  totalBytes: number;
  databaseBytes: number;
  walBytes: number;
  mediaBytes: number;
  skillsBytes: number;
  diagnostics: { calls: number; withBodies: number; reqChars: number; resChars: number; reqBytes: number; resBytes: number };
  modelCalls: { count: number; oldestAt: number | null; newestAt: number | null };
  importBackups: { count: number; bytes: number };
};

export type StorageCleanupResult = {
  ops: StorageCleanupOp[];
  diagnosticBodiesCleared: number;
  diagnosticCharsCleared: number;
  diagnosticBytesCleared: number;
  modelCallsDeleted: number;
  importBackupsDeleted: number;
  importBackupBytesDeleted: number;
  compacted: boolean;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
};

function bytesOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function treeBytes(path: string): number {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
  } catch {
    return 0;
  }
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else total += bytesOf(full);
    }
  }
  return total;
}

/** 数据库所在目录。桌面端由 DATA_DIR 指定；开发/CLI 默认就是 ./data。 */
function currentDataDir(): string {
  return config.dataDir.trim() === ""
    ? dirname(resolve(config.dbPath))
    : resolve(config.dataDir);
}

function importBackupEntries(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.name.includes(".pre-import-"))
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

/** 只允许删除当前数据目录下的直接子项；路径一旦逃出根目录就拒绝。 */
function removeInsideDataDir(root: string, target: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const rel = relative(absoluteRoot, absoluteTarget);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    rmSync(absoluteTarget, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function storageOverview(): StorageOverview {
  const root = currentDataDir();
  const dbPath = resolve(config.dbPath);
  const backups = importBackupEntries(root);
  const callStats = db.prepare(`
    SELECT COUNT(*) AS count,
           MIN(created_at) AS oldestAt,
           MAX(created_at) AS newestAt
    FROM model_calls
  `).get() as { count: number; oldestAt: number | null; newestAt: number | null };
  return {
    dataDir: root,
    devMode: config.devMode,
    totalBytes: treeBytes(root),
    databaseBytes: bytesOf(dbPath),
    walBytes: bytesOf(dbPath + "-wal") + bytesOf(dbPath + "-shm"),
    mediaBytes: treeBytes(mediaDir()),
    skillsBytes: treeBytes(skillsDir()),
    diagnostics: modelCallBodyStats(),
    modelCalls: callStats,
    importBackups: {
      count: backups.length,
      bytes: backups.reduce((sum, entry) => sum + treeBytes(entry), 0),
    },
  };
}

export function isStorageCleanupOp(value: string): value is StorageCleanupOp {
  return (STORAGE_CLEANUP_OPS as readonly string[]).includes(value);
}

export function cleanupStorage(ops: StorageCleanupOp[]): StorageCleanupResult {
  const root = currentDataDir();
  const before = storageOverview();
  let diagnosticBodiesCleared = 0;
  let diagnosticCharsCleared = 0;
  let diagnosticBytesCleared = 0;
  let modelCallsDeleted = 0;
  let importBackupsDeleted = 0;
  let importBackupBytesDeleted = 0;

  if (ops.includes("diagnosticBodies")) {
    const cleared = clearModelCallBodies();
    diagnosticBodiesCleared = cleared.cleared;
    diagnosticCharsCleared = cleared.chars;
    diagnosticBytesCleared = cleared.bytes;
  }
  if (ops.includes("modelCalls")) modelCallsDeleted = clearModelCallHistory();
  if (ops.includes("importBackups")) {
    for (const entry of importBackupEntries(root)) {
      const size = treeBytes(entry);
      if (removeInsideDataDir(root, entry)) {
        importBackupsDeleted += 1;
        importBackupBytesDeleted += size;
      }
    }
  }

  const dbChanged = ops.includes("compact") || diagnosticBodiesCleared > 0 || modelCallsDeleted > 0;
  const compacted = dbChanged ? compactDb() : true;
  const after = storageOverview();
  return {
    ops,
    diagnosticBodiesCleared,
    diagnosticCharsCleared,
    diagnosticBytesCleared,
    modelCallsDeleted,
    importBackupsDeleted,
    importBackupBytesDeleted,
    compacted,
    beforeBytes: before.totalBytes,
    afterBytes: after.totalBytes,
    reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes),
  };
}
