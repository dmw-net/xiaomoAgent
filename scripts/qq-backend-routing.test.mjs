/**
 * QQ 后端按联系人路由回归。
 *
 * 关键不变量：
 *   1. 全局默认 official 时，单个联系人可以单独切到 onebot；
 *   2. 路由后的私聊投递走 OneBot 的 send_private_msg，且目标仍是 ownerQq；
 *   3. 另一位联系人仍走 official，不受影响；
 *   4. 表情能力按联系人/会话所属渠道判断，而不是全局一刀切。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "xiaomo-qq-routing-"));
process.env.DB_PATH = join(tempRoot, "test.db");
process.env.MEDIA_DIR = join(tempRoot, "media");
process.env.QQ_BACKEND = "official";

const dbModule = await import("../src/core/db.ts");
const contacts = await import("../src/chat/contacts.ts");
const conversations = await import("../src/chat/conversations.ts");
const onebot = await import("../src/channels/qq-onebot.ts");
const qqModule = await import("../src/channels/qq.ts");
const emotes = await import("../src/emote/qq-emote.ts");

const contactA = contacts.createContact({ name: "OneBot 联系人" });
const contactB = contacts.createContact({ name: "官方联系人" });
const convA = conversations.ensureLocalConversation(contactA.id);
const BOT_QQ = "10001";
const OWNER_QQ = "20002";
const requests = [];
let server;
let service;

try {
  assert.equal(qqModule.qqBackendFor(contactA.id), "official", "先继承全局默认渠道");
  qqModule.saveQQBackendForContact(contactA.id, "onebot");
  assert.equal(qqModule.qqBackendFor(contactA.id), "onebot", "单个联系人可切到 OneBot");
  assert.equal(qqModule.qqBackendFor(contactB.id), "official", "另一位联系人不受影响");
  assert.equal(qqModule.qqBackendForConversation(convA.id), "onebot", "会话跟随所属联系人");
  assert.equal(emotes.emoteCapabilities(qqModule.qqBackendFor(contactA.id)).face, true, "OneBot 联系人有原生表情");
  assert.equal(emotes.emoteCapabilities(qqModule.qqBackendFor(contactB.id)).face, false, "官方联系人仍走降级能力");

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
  onebot.applyOnebotSettings({ httpBase: `http://127.0.0.1:${server.address().port}`, wsUrl: "", token: "" });
  onebot.upsertOneBotAccount(contactA.id, BOT_QQ, { ownerQq: OWNER_QQ });
  service = qqModule.qq;

  await service.deliverToContact(contactA.id, "按联系人走 OneBot");
  assert.equal(requests.length, 1, "OneBot 联系人应走协议端");
  assert.equal(requests[0].user_id, OWNER_QQ, "私聊目标仍是 ownerQq");

  const snapA = service.snapshotFor(contactA.id);
  const snapB = service.snapshotFor(contactB.id);
  assert.equal(snapA.binding?.qqNumber, BOT_QQ, "OneBot 快照命中对应联系人");
  assert.equal(snapB.binding, null, "官方联系人没有串到 OneBot 绑定");

  console.log("QQ 按联系人后端路由回归：全部通过");
} finally {
  if (service) service.stopAll();
  if (server) await new Promise((resolve) => server.close(resolve));
  dbModule.db.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
