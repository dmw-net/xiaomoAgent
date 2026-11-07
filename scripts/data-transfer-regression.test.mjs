/**
 * 备份恢复回归测试。
 *
 * 复现的真实问题：导出空媒体/技能备份后，在导入前本机新增了文件；
 * 导入成功却把新文件留在原处。导入的语义是“备份内容替换本机数据”，
 * 归档里没有 media/ 或 skills/ 时必须恢复为空，而不是保留旧目录。
 *
 * 运行：node --experimental-sqlite scripts/data-transfer-regression.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const root = mkdtempSync(join(tmpdir(), "xiaomo-data-transfer-test-"));
process.env.DB_PATH = join(root, "xiaomo.db");
process.env.MEDIA_DIR = join(root, "media");
process.env.SKILLS_DIR = join(root, "skills");
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.MODEL_MODE = "echo";
process.env.PROACTIVE_ENABLED = "false";
delete process.env.DATA_DIR;

const { createHttpServer } = await import("../src/server.ts");
const server = createHttpServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object", "测试服务器没有拿到端口");
const base = `http://127.0.0.1:${address.port}`;

try {
  const exported = await fetch(`${base}/api/settings/data-export`);
  assert.equal(exported.status, 200, "导出接口应成功");
  const archive = Buffer.from(await exported.arrayBuffer());

  const localMedia = join(root, "media", "local-only.txt");
  const localSkill = join(root, "skills", "local-skill", "SKILL.md");
  mkdirSync(join(root, "media"), { recursive: true });
  mkdirSync(join(root, "skills", "local-skill"), { recursive: true });
  writeFileSync(localMedia, "local media must be replaced");
  writeFileSync(localSkill, "local skill must be replaced");

  const imported = await fetch(`${base}/api/settings/data-import`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: archive,
  });
  const result = await imported.json();
  assert.equal(imported.status, 200, `导入接口应成功：${JSON.stringify(result)}`);
  assert.equal(result.ok, true);
  assert.equal(existsSync(localMedia), false, "备份中没有媒体时，本机旧媒体必须被清空");
  assert.equal(existsSync(localSkill), false, "备份中没有技能时，本机旧技能必须被清空");
  console.log("  ✓ 空媒体/技能备份导入后，本机旧目录被清空");

  // 非 ASCII 路径回归：tar 头曾按 ascii 编码写文件名，中文路径（media/图片/…）
  // 被截成 0xFE 0x47 乱码——文件内容完好，但导入侧按 UTF-8 读回后媒体引用整体断裂。
  // 头必须按 UTF-8 写，且导入后按原路径恢复。
  const cjkMedia = join(root, "media", "图片", "测试动画.gif");
  mkdirSync(join(root, "media", "图片"), { recursive: true });
  writeFileSync(cjkMedia, "cjk media payload");
  const exportedCjk = await fetch(`${base}/api/settings/data-export`);
  assert.equal(exportedCjk.status, 200, "中文路径导出接口应成功");
  const cjkArchive = Buffer.from(await exportedCjk.arrayBuffer());
  const tarBytes = gunzipSync(cjkArchive);
  assert.ok(
    tarBytes.includes(Buffer.from("media/图片/测试动画.gif", "utf8")),
    "tar 头必须按 UTF-8 保存非 ASCII 路径",
  );
  const importedCjk = await fetch(`${base}/api/settings/data-import`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: cjkArchive,
  });
  const cjkResult = await importedCjk.json();
  assert.equal(importedCjk.status, 200, `中文路径导入接口应成功：${JSON.stringify(cjkResult)}`);
  assert.equal(cjkResult.ok, true);
  assert.equal(existsSync(cjkMedia), true, "中文路径媒体必须按原路径恢复");
  assert.equal(readFileSync(cjkMedia, "utf8"), "cjk media payload");
  console.log("  ✓ 中文媒体路径按 UTF-8 进 tar 头，导入后原路径恢复");

  // 桌面 WebView 不走 XHR：attachment 响应只能交给 Tauri 原生下载。
  const transferApi = readFileSync("frontend/src/api/dataTransfer.ts", "utf8");
  const appearance = readFileSync("frontend/src/features/settings/AppearanceSection.tsx", "utf8");
  const shell = readFileSync("src-tauri/src/lib.rs", "utf8");
  assert.match(transferApi, /isDesktopRuntime\(\)/);
  assert.match(transferApi, /xiaomo-backup-download/);
  assert.match(appearance, /startNativeBackupDownload\(\)/);
  assert.match(appearance, /listenBackupDownload\(/);
  assert.match(shell, /\.on_download\(/);
  assert.match(shell, /"xiaomo-backup-download"/);
  console.log("  ✓ 桌面端导出走原生下载并回报完成状态");
} finally {
  await new Promise((resolve) => server.close(resolve));
  // 导入成功后服务端会重开数据库连接（这正是本次修复的行为）；
  // Windows 上不先关掉句柄，rmSync 删临时目录会 EPERM。
  try { (await import("../src/core/db.ts")).db.close(); } catch { /* 可能已关闭 */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
