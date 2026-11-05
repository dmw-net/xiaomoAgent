#!/usr/bin/env node
/**
 * QQ 通道提示的生命周期回归：一次发送失败不该永远挂在状态页。
 *
 *   1. 老库里只有 lastError、没有时间戳的历史残留（例如 850019）不再报警；
 *   2. 带时间戳的新错误会报出来，且带上发生时间，资料页也能看到；
 *   3. 超过 24 小时自动失效，不需要手工清；
 *   4. /api/qq/clear-errors 可清除，支持按联系人清，不删账号与历史记录；
 *   5. 不存在的联系人返回 404，不会误清别人的提示。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "xiaomo-qq-error-life-"));
process.env.DB_PATH = join(root, "test.db");
process.env.MEDIA_DIR = join(root, "media");
process.env.QQ_BACKEND = "official";
process.env.DEV_MODE = "0";

const dbModule = await import("../src/core/db.ts");
const { kvGet, kvSet } = dbModule;
const contacts = await import("../src/chat/contacts.ts");
const { createQQService } = await import("../src/channels/qq.ts");
const { createHttpServer } = await import("../src/server.ts");

const a = contacts.createContact({ name: "大肥鱼" });
const b = contacts.createContact({ name: "二肥鱼" });
const KV = "qq.accounts.v2";
const OLD_ERROR = "QQ 接口错误 850019：富媒体文件格式不支持";

const account = (contactId, lastError, lastErrorAt) => ({
  id: `acc-${contactId}`, contactId, appId: "app", clientSecret: "secret", enabled: true,
  proactive: false, userOpenId: "openid", recentMessageIds: [], replyMessageId: "", replyMessageAt: 0,
  lastError, ...(lastErrorAt === undefined ? {} : { lastErrorAt }),
  lastReceivedAt: "", lastSentAt: "", createdAt: new Date().toISOString(),
});
const write = (accounts) => kvSet(KV, JSON.stringify({ version: 2, accounts }));
const stored = () => JSON.parse(kvGet(KV)).accounts;
const errorsOf = (service) => service.summary().trouble.filter((t) => t.lastError !== "");

let server;
try {
  // 1) 历史残留：旧库没有 lastErrorAt，不能当成当前故障常驻状态页。
  write([account(a.id, OLD_ERROR)]);
  const legacy = createQQService();
  assert.deepEqual(errorsOf(legacy), [], "无时间戳的历史错误不该再进状态页 trouble");
  assert.equal(legacy.summary().lastError, "", "无时间戳的历史错误不该进总览 lastError");
  assert.equal(legacy.snapshotFor(a.id).binding.lastError, "", "资料页也不该显示过期错误");

  // 2) 新失败：带时间戳，状态页报出来且带上发生时间。
  const now = Date.now();
  write([account(a.id, OLD_ERROR, now)]);
  const fresh = createQQService();
  const freshErrors = errorsOf(fresh);
  assert.equal(freshErrors.length, 1, "刚刚发生的失败应当可见");
  assert.equal(freshErrors[0].lastError, OLD_ERROR);
  assert.equal(freshErrors[0].at, now, "trouble 应带上时间戳供界面显示「多久之前」");
  assert.equal(fresh.summary().lastError, OLD_ERROR, "总览应带上这条错误");
  assert.equal(fresh.snapshotFor(a.id).binding.lastError, OLD_ERROR, "资料页应能看到当前错误");
  assert.equal(fresh.snapshotFor(a.id).binding.lastErrorAt, now);

  // 3) 超过 24 小时自动失效。
  write([account(a.id, OLD_ERROR, Date.now() - 25 * 60 * 60 * 1000)]);
  assert.deepEqual(errorsOf(createQQService()), [], "超过 24 小时的失败自动不再报警");

  // 4) 清除接口：两个绑定各有一条新错误，先只清其中一位。
  const at = Date.now();
  write([account(a.id, OLD_ERROR, at), account(b.id, "QQ 接口错误 40093002：配额不足", at)]);
  server = createHttpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const one = await (await fetch(`${base}/api/qq/clear-errors`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contactId: a.id }),
  })).json();
  assert.equal(one.ok, true, "清除接口应可用");
  assert.equal(one.cleared, 1, "按联系人清时只清掉这一位");
  assert.equal(stored().find((x) => x.contactId === a.id).lastError, "", "被清的账号错误已抹掉");
  assert.equal(stored().find((x) => x.contactId === a.id).lastErrorAt, 0, "时间戳一并归零");
  assert.equal(stored().find((x) => x.contactId === b.id).lastError, "QQ 接口错误 40093002：配额不足", "另一位不受影响");
  assert.equal(stored().length, 2, "清除提示不删账号");

  const statusOne = await (await fetch(`${base}/api/status?contactId=${encodeURIComponent(a.id)}`)).json();
  assert.equal(statusOne.qq.trouble.filter((t) => t.lastError !== "").length, 1, "状态页只剩另一位还没清的提示");

  const all = await (await fetch(`${base}/api/qq/clear-errors`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).json();
  assert.equal(all.cleared, 1, "不带 contactId 时清掉其余全部");
  const statusAll = await (await fetch(`${base}/api/status?contactId=${encodeURIComponent(a.id)}`)).json();
  assert.deepEqual(statusAll.qq.trouble.filter((t) => t.lastError !== ""), [], "清完后状态页不再有红字");

  // 5) 不存在的联系人：拒绝，不误清。
  const bad = await fetch(`${base}/api/qq/clear-errors`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contactId: "no-such-contact" }),
  });
  assert.equal(bad.status, 404, "不存在的联系人应返回 404");

  console.log("QQ 通道提示生命周期回归：全部通过");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  dbModule.db.close();
  rmSync(root, { recursive: true, force: true });
}
