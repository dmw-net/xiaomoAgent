#!/usr/bin/env node
/** 用户版投递队列 API：可见、可单条重试/忽略，但不暴露开发字段与批量运维接口。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "xiaomo-outbound-api-"));
process.env.DB_PATH = join(root, "test.db");
process.env.MEDIA_DIR = join(root, "media");
process.env.DEV_MODE = "0";

const dbModule = await import("../src/core/db.ts");
const queue = await import("../src/core/dqueue.ts");
const { createHttpServer } = await import("../src/server.ts");

queue.enqueue("dead-1", {
  contactId: "default",
  conversationId: "",
  channel: "qq",
  text: "没有送达的消息",
  kind: "chat",
  tier: "interactive",
  maxAttempts: 1,
});
queue.markInFlight("dead-1");
queue.markFailed("dead-1", "服务商鉴权失败 401", Date.now() + 100, "interactive");

const server = createHttpServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

try {
  const list = await (await fetch(`${base}/api/outbound/deliveries?status=dead`)).json();
  assert.equal(list.ok, true, "队列列表接口应可用");
  assert.equal(list.devMode, false, "用户版不应标记为开发模式");
  assert.equal(list.summary.dead, 1, "死信统计应正确");
  assert.equal(list.rows.length, 1, "应能列出死信记录");
  assert.equal(list.rows[0].lastError, undefined, "用户版不应暴露原始错误字段");
  assert.equal(list.rows[0].tier, undefined, "用户版不应暴露内部档位");
  assert.equal(typeof list.rows[0].reason, "string", "用户版应返回可读失败原因");

  const status = await (await fetch(`${base}/api/status?contactId=default`)).json();
  assert.equal(status.ok, true, "状态接口应可用");
  assert.equal(status.outbound?.dead, 1, "运行概览应拿到投递队列概况");

  const retry = await (await fetch(`${base}/api/outbound/deliveries/dead-1/retry`, { method: "POST" })).json();
  assert.equal(retry.ok, true, "用户版应允许单条重试");
  assert.equal(retry.queued, true);

  const bulk = await fetch(`${base}/api/outbound/retry-all`, { method: "POST" });
  assert.equal(bulk.status, 404, "批量重试只允许开发模式");

  const purge = await fetch(`${base}/api/outbound/purge`, { method: "POST" });
  assert.equal(purge.status, 404, "终态清理只允许开发模式");

  console.log("用户版投递队列 API 回归：全部通过");
} finally {
  await new Promise((resolve) => server.close(resolve));
  dbModule.db.close();
  rmSync(root, { recursive: true, force: true });
}
