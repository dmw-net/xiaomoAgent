/**
 * 诊断原文的写入、保留窗口与用户清理回归。
 *
 * 这条测试必须跑 DEV_MODE=1，因为普通模式已经在 smoke 里验证“原文完全不落库”。
 * 重点覆盖：环形窗口只留最近 10 次、清理不回伤消息、导入前备份可删、VACUUM 后尺寸下降。
 *
 * 运行：node --experimental-sqlite scripts/storage-cleanup-regression.test.mjs
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";

const dbFile = "./data/storage-cleanup-regression.db";
for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
process.env.DB_PATH = dbFile;
process.env.DEV_MODE = "1";
process.env.MEDIA_DIR = "./data/media-storage-regression";
process.env.SKILLS_DIR = "./data/skills-storage-regression";

const { db } = await import("../src/db.ts");
const { logModelCall, recentModelCalls } = await import("../src/logs.ts");
const { cleanupStorage, storageOverview } = await import("../src/storage.ts");

const backup = "./data/storage-cleanup-regression.db.pre-import-test";
writeFileSync(backup, "old backup".repeat(100_000));
db.prepare("INSERT INTO messages (channel, role, text, created_at) VALUES ('web', 'user', ?, ?)")
  .run("这条聊天不能被诊断清理带走", Date.now());

for (let i = 0; i < 12; i += 1) {
  logModelCall({
    purpose: "chat",
    ok: true,
    elapsedMs: 1,
    message: `留存 ${i}`,
    detail: `摘要 ${i}`,
    resFull: "响应".repeat(40_000),
    requestBody: { model: "m", messages: [{ role: "user", content: "请求".repeat(40_000) }] },
  });
}

const rows = recentModelCalls(20);
const withBody = rows.filter((row) => row.req_full !== null || row.res_full !== null);
if (withBody.length !== 10) throw new Error(`开发模式应只保留最近 10 次原文，实际 ${withBody.length}`);
if (rows.slice(0, 10).some((row) => row.req_full === null || row.res_full === null)) {
  throw new Error("最近 10 次调用都应保有请求和响应原文");
}
if (rows.slice(10).some((row) => row.req_full !== null || row.res_full !== null)) {
  throw new Error("第 11 次以前的原文没有被环形窗口清掉");
}

const before = storageOverview();
if (before.diagnostics.withBodies !== 10 || before.importBackups.count !== 1) {
  throw new Error(`清理前统计不对：${JSON.stringify(before)}`);
}
const result = cleanupStorage(["diagnosticBodies", "importBackups"]);
const after = storageOverview();
if (after.diagnostics.withBodies !== 0) throw new Error("诊断原文没有被清空");
if (existsSync(backup)) throw new Error("导入前备份没有被删除");
if (db.prepare("SELECT COUNT(*) AS n FROM messages").get().n !== 1) throw new Error("清理诊断数据误删了聊天消息");
if (result.diagnosticBodiesCleared !== 10) throw new Error(`清理条数不对：${result.diagnosticBodiesCleared}`);
if (result.importBackupsDeleted !== 1) throw new Error(`备份清理条数不对：${result.importBackupsDeleted}`);
if (result.reclaimedBytes <= 0 || after.totalBytes >= before.totalBytes) {
  throw new Error(`清理后占用没有下降：${before.totalBytes} -> ${after.totalBytes}`);
}

console.log(`✓ 诊断原文只留最近 10 次；清理后释放 ${(result.reclaimedBytes / 1024 / 1024).toFixed(2)} MB，聊天消息保留`);
db.close();
for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
