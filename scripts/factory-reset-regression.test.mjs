/**
 * 恢复出厂设置回归测试。
 *
 * 复现的真实问题：factoryReset 的表清单落后于建表清单——proactive_state、
 * outbound_deliveries、assets 三张表不在 DELETE 列表里。「全部清空」之后：
 *   - 新种出来的 default 联系人继承了旧联系人的主动节拍与 focus（同 id 主键冲突语义）；
 *   - 出盒箱里指向已删除联系人的 pending 投递还挂着，附件文件却已被回收；
 *   - 表情素材库登记全变成死链。
 * 新表进库时要么加进清除清单、要么在这里登记为「有意不清」的例外，二选一。
 *
 * 运行：node --experimental-sqlite scripts/factory-reset-regression.test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "xiaomo-factory-reset-test-"));
process.env.DB_PATH = join(root, "xiaomo.db");
process.env.MEDIA_DIR = join(root, "media");
process.env.SKILLS_DIR = join(root, "skills");
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.MODEL_MODE = "echo";
process.env.PROACTIVE_ENABLED = "false";
delete process.env.DATA_DIR;

const { createHttpServer } = await import("../src/server.ts");
const { db } = await import("../src/core/db.ts");

const server = createHttpServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object", "测试服务器没有拿到端口");
const base = `http://127.0.0.1:${address.port}`;

try {
  // 种下三张容易被漏清的表 + 一条核心业务数据，然后全部清空。
  const now = Date.now();
  db.prepare("INSERT INTO proactive_state (contact_id, next_check_at, focus, updated_at) VALUES (?, ?, ?, ?)")
    .run("default", now + 60_000, "旧节拍不该被新小茉继承", now);
  db.prepare(
    "INSERT INTO outbound_deliveries (id, contact_id, conversation_id, channel, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("dlv-1", "default", "conv-1", "web", "清空前的待投递", "pending", now);
  db.prepare(
    "INSERT INTO assets (id, url, kind, usable_as_emote, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ast-1", "/media/deadbeef00000000.png", "image", 1, now);
  db.prepare("INSERT INTO messages (contact_id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("default", "conv-1", "user", "清空前的消息", now);

  // media 文件按现在的目录化布局放：两个子目录 + 遗留平铺各一张，回收站一份。
  // 回归口径：releaseMediaFiles 若按 assets.rel_path 解析路径，而 assets 在同一事务里被清空，
  // 子目录文件会解析不出来被静默跳过——整棵媒体树只有平铺文件删得掉。
  const mediaDir = join(root, "media");
  for (const rel of ["图片/aabbccdd11223344.png", "表情包/梗图/ccee0011223344ff.gif", "legacy00ab00cd00ef0011.jpg"]) {
    const file = join(mediaDir, ...rel.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "to be wiped");
  }
  const trashDir = join(mediaDir, ".trash");
  mkdirSync(trashDir, { recursive: true });
  writeFileSync(join(trashDir, "trashed00ab00cd00ef.png"), "trashed");

  const res = await fetch(`${base}/api/settings/factory-reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "FACTORY" }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `全部清空接口应成功：${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
  assert.ok(body.note.includes("已回到初始状态"), `note 应报告回到初始状态：${body.note}`);

  // 清除清单里的每一张表都必须见底——包括容易被漏清的那三张。
  // conversations 例外：路由在清空后会为新联系人重种主会话，所以只断言旧行没了。
  const wipedTables = [
    "messages", "turns", "memory_events", "proactive_tasks", "proactive_state",
    "model_calls", "artifacts", "image_descriptions",
    "assets", "outbound_deliveries",
  ];
  for (const table of wipedTables) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
    assert.equal(row.c, 0, `「全部清空」后 ${table} 必须为空（清空前的种子行还在 ${row.c} 条）`);
  }
  const oldConv = db.prepare("SELECT COUNT(*) AS c FROM conversations WHERE id = ?").get("conv-1");
  assert.equal(oldConv.c, 0, "清空前的旧会话不能留下来");

  // media 树必须真被删空（.trash 由 emptyMediaTrash 单独收，同样不能留）。
  const leftFiles = [];
  const scan = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) { scan(join(dir, ent.name)); continue; }
      leftFiles.push(ent.name);
    }
  };
  scan(mediaDir);
  assert.deepEqual(leftFiles, [], `media 目录应被清空，还剩：${leftFiles.join(", ")}`);

  // 重新种子要有：内置联系人回来了，schema 版本没被误伤。
  const seeded = db.prepare("SELECT COUNT(*) AS c FROM contacts").get();
  assert.ok(seeded.c >= 1, "清空后应重新种出内置联系人");
  const schema = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get();
  assert.ok(schema, "schema_version 必须保留，否则下次启动会误判迁移");

  console.log("  ✓ 全部清空后 proactive_state / outbound_deliveries / assets 与全部业务表都见底");
  console.log("  ✓ 内置联系人重新种出，schema_version 保留");
} finally {
  await new Promise((resolve) => server.close(resolve));
  // Windows 上不先关掉数据库句柄，rmSync 删临时目录会 EPERM。
  try { (await import("../src/core/db.ts")).db.close(); } catch { /* 可能已关闭 */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
