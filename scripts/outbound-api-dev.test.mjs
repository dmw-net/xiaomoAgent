#!/usr/bin/env node
/** 开发模式投递队列 API：额外暴露排障字段，并提供批量重试与终态清理。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "xiaomo-outbound-dev-api-"));
process.env.DB_PATH = join(root, "test.db");
process.env.MEDIA_DIR = join(root, "media");
process.env.DEV_MODE = "1";

const dbModule = await import("../src/db.ts");
const queue = await import("../src/dqueue.ts");
const { createHttpServer } = await import("../src/server.ts");

queue.enqueue("dead-dev", {
  contactId: "default",
  conversationId: "",
  channel: "qq",
  text: "开发模式排障消息",
  kind: "chat",
  tier: "interactive",
  maxAttempts: 1,
});
queue.markInFlight("dead-dev");
queue.markFailed("dead-dev", "原始错误：provider 502", Date.now() + 100, "interactive");

const server = createHttpServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

try {
  const list = await (await fetch(`${base}/api/outbound/deliveries?status=dead`)).json();
  assert.equal(list.ok, true);
  assert.equal(list.devMode, true, "开发模式应明确标记");
  assert.equal(list.rows[0].tier, "interactive", "开发模式应暴露内部档位");
  assert.equal(list.rows[0].lastError, "原始错误：provider 502", "开发模式应暴露原始错误");

  const bulk = await (await fetch(`${base}/api/outbound/retry-all`, { method: "POST" })).json();
  assert.equal(bulk.ok, true, "开发模式应允许批量重试");
  assert.equal(bulk.queued, 1);

  const purge = await (await fetch(`${base}/api/outbound/purge`, { method: "POST" })).json();
  assert.equal(purge.ok, true, "开发模式应允许终态清理");

  console.log("开发模式投递队列 API 回归：全部通过");
} finally {
  await new Promise((resolve) => server.close(resolve));
  dbModule.db.close();
  rmSync(root, { recursive: true, force: true });
}
