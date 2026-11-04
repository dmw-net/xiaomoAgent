#!/usr/bin/env node
/** 持久出盒箱状态机回归：失败重试、死信、手动重试、忽略与统计。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "xiaomo-outbound-"));
process.env.DB_PATH = join(root, "test.db");

const dbModule = await import("../src/db.ts");
const queue = await import("../src/dqueue.ts");

try {
  queue.enqueue("d1", {
    contactId: "default",
    conversationId: "",
    channel: "qq",
    text: "第一条",
    segments: ["第一条"],
    kind: "chat",
    tier: "interactive",
    maxAttempts: 2,
  });

  let stats = queue.summary();
  assert.equal(stats.open, 1, "新记录应计入待处理");
  assert.equal(stats.counts.pending, 1, "新记录状态应为 pending");

  assert.equal(queue.markInFlight("d1"), true, "pending 记录应可认领");
  const failedAt = Date.now();
  queue.markFailed("d1", "模拟网络失败", failedAt + 100, "interactive");
  let row = queue.getById("d1");
  assert.equal(row?.status, "failed", "第一次失败应等待重试");
  assert.equal(row?.attempts, 1, "第一次失败后 attempts=1");

  const due = queue.getPending(Date.now() + 200, 10);
  assert.deepEqual(due, ["d1"], "到期失败记录应重新进入调度");

  assert.equal(queue.markInFlight("d1"), true, "failed 记录应可再次认领");
  queue.markFailed("d1", "第二次失败", Date.now() + 1_000, "interactive");
  row = queue.getById("d1");
  assert.equal(row?.status, "dead_letter", "达到最大尝试次数后应进入死信");
  assert.equal(row?.attempts, 2, "死信记录保留最终尝试次数");

  stats = queue.summary();
  assert.equal(stats.dead, 1, "死信应单独统计");
  assert.equal(stats.open, 0, "死信不再计入待处理");

  const dead = queue.listDeliveries({ status: "dead", limit: 25, offset: 0 });
  assert.equal(dead.total, 1, "死信列表应能查到记录");
  assert.equal(dead.rows[0]?.text, "第一条", "死信列表应保留原文");

  assert.equal(queue.retryDelivery("d1"), true, "死信应允许手动重试");
  row = queue.getById("d1");
  assert.equal(row?.status, "pending", "手动重试应回到 pending");
  assert.equal(row?.attempts, 0, "手动重试应重置尝试次数");

  queue.markInFlight("d1");
  queue.markFailed("d1", "再次失败", Date.now() + 1_000, "interactive");
  assert.equal(queue.ignoreDelivery("d1"), true, "死信应允许忽略");
  assert.equal(queue.getById("d1")?.status, "ignored", "忽略后应进入 ignored");

  console.log("持久出盒箱 / 死信队列回归：全部通过");
} finally {
  dbModule.db.close();
  rmSync(root, { recursive: true, force: true });
}
