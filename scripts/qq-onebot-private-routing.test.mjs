/**
 * OneBot 私聊路由回归：机器人号（self_id / qqNumber）不能当作主人号（ownerQq）。
 *
 * 覆盖两条曾经坏掉的链路：
 *   1. 入站：self_id 找机器人，user_id 必须等于 ownerQq；机器人自己的回声必须丢弃。
 *   2. 出站：send_private_msg 的 user_id 必须是 ownerQq，而不是协议端登录号。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "xiaomo-onebot-private-"));
process.env.DB_PATH = join(tempRoot, "test.db");
process.env.MEDIA_DIR = join(tempRoot, "media");
process.env.QQ_BACKEND = "onebot";

const onebot = await import("../src/channels/qq-onebot.ts");
const dbModule = await import("../src/core/db.ts");

const BOT_QQ = "10001";
const OWNER_QQ = "20002";
const accounts = [{ contactId: "owner-contact", qqNumber: BOT_QQ, ownerQq: OWNER_QQ }];
const requests = [];
let server;
let service;

try {
  assert.deepEqual(
    onebot.obPrivateRoute({ self_id: BOT_QQ, user_id: OWNER_QQ }, accounts),
    { account: accounts[0], senderQq: OWNER_QQ },
    "主人私聊应路由到绑定机器人对应的联系人",
  );
  assert.equal(
    onebot.obPrivateRoute({ self_id: BOT_QQ, user_id: BOT_QQ }, accounts),
    null,
    "机器人自己发出的私聊回声必须丢弃",
  );
  assert.equal(
    onebot.obPrivateRoute({ self_id: BOT_QQ, user_id: "30003" }, accounts),
    null,
    "非主人私聊不应进入联系人会话",
  );
  assert.equal(
    onebot.obPrivateRoute({ self_id: BOT_QQ, user_id: OWNER_QQ, ownerQq: OWNER_QQ }, []),
    null,
    "没有绑定账号时不应猜测归属",
  );

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url !== "/send_private_msg") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "failed", retcode: 404, msg: "unexpected action" }));
        return;
      }
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  onebot.applyOnebotSettings({ httpBase: `http://127.0.0.1:${port}`, wsUrl: "", token: "" });
  onebot.upsertOneBotAccount("owner-contact", BOT_QQ, { ownerQq: OWNER_QQ });
  service = onebot.createQQOneBotService();

  await service.deliverToContact("owner-contact", "只发给主人");
  assert.equal(requests.length, 1, "应发出一条私聊");
  assert.equal(requests[0].user_id, OWNER_QQ, "私聊 user_id 必须是 ownerQq");
  assert.notEqual(requests[0].user_id, BOT_QQ, "不能把机器人登录号当作私聊目标");
  assert.deepEqual(requests[0].message, [{ type: "text", data: { text: "只发给主人" } }], "消息段保持原样");

  assert.equal(service.setFlagsByContact("owner-contact", { enabled: false }), true, "可以暂停连接");
  await service.deliverToContact("owner-contact", "暂停后不应发出");
  assert.equal(requests.length, 1, "暂停连接后停止私聊投递");
  assert.equal(service.snapshotFor("owner-contact").binding?.enabled, false, "暂停状态已落库");
  assert.equal(service.setFlagsByContact("owner-contact", { enabled: true }), true, "可以恢复连接");

  console.log("OneBot 私聊路由回归：全部通过");
} finally {
  if (service) service.dispose();
  if (server) await new Promise((resolve) => server.close(resolve));
  dbModule.db.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
