/** 数据占用与用户主动清理项（与 /api/storage/* 对齐）。 */

export type StorageCleanupOp = "diagnosticBodies" | "modelCalls" | "importBackups" | "compact";

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
  ok: true;
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
  note: string;
};
