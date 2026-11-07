/**
 * 表情渠道分流回归：应用端（web/local 频道）会话里 send_emote 的三条行为。
 *
 * ① image 意图 + /media 路径  → 挂成回复气泡附件（files），跟 generate_image 同一条路；
 * ② face 意图                → 降级成 emoji 提示（应用端没有原生 QQ 表情渲染通道）；
 * ③ image 意图 + http 外链    → 拒掉（气泡只能挂本机 /media，外链渲染不出来）。
 *
 * 单进程、隔离 DB/MEDIA_DIR，跑完清临时库。运行：node --experimental-sqlite scripts/web-emote-regression.test.mjs
 */
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";

const PHASE = process.env.WEB_EMOTE_SUB;

if (PHASE === "1") {
  const run = async () => {
    // 先设隔离再 import（config 在 import 时锁 env）。
    const { createContact } = await import("../src/chat/contacts.ts");
    const { ensureLocalConversation, getConversation } = await import("../src/chat/conversations.ts");
    const { executeTool } = await import("../src/mind/tools.ts");

    // 表情现在是全局唯一开关（出厂 normal 即开），不再按联系人开；建真实联系人只为拿到会话与 ctx。
    createContact({ id: "web-emote-test", name: "表情渠道测试" });
    const conv = ensureLocalConversation("web-emote-test");
    assert.strictEqual(getConversation(conv.id)?.channel, "web", "测试会话是 web 频道");

    // ① image + /media → 挂附件。
    const r1 = await executeTool(
      "send_emote",
      JSON.stringify({ url: "/media/abc123.gif", label: "摸鱼" }),
      { contactId: "web-emote-test", conversationId: conv.id, turnId: null },
    );
    assert.strictEqual(r1.ok, true, "image 意图不拒");
    assert.ok(
      Array.isArray(r1.attachments) && r1.attachments.includes("/media/abc123.gif"),
      "应用端 image 挂成气泡附件：" + JSON.stringify(r1),
    );
    // 应用端表情也要带 label：工具卡摘要据此显示名字（不再和标签重复成两遍「发了张表情」），
    // 历史标记靠 meta.label 记住这轮甩的是哪张图。
    assert.strictEqual(r1.result.label, "摸鱼", "应用端表情回执带上名字：" + JSON.stringify(r1.result));
    assert.strictEqual(r1.attachmentMeta?.[0]?.label, "摸鱼", "附件元数据带上表情名：" + JSON.stringify(r1));

    // ② face → 降级 emoji 提示（ok，非 files，payload 拍平在 result 里）。
    const r2 = await executeTool(
      "send_emote",
      JSON.stringify({ face_id: 4, label: "大笑" }),
      { contactId: "web-emote-test", conversationId: conv.id, turnId: null },
    );
    assert.strictEqual(r2.ok, true, "face 意图不崩");
    const p2 = r2.result;
    assert.strictEqual(p2.via, "app-emoji-fallback", "face 走 emoji 降级分支：" + JSON.stringify(r2));
    assert.match(String(p2.note), /应用端/, "提示里点明是应用端");

    // ③ http 外链 → 拒掉（应用端气泡挂不了外链）。
    const r3 = await executeTool(
      "send_emote",
      JSON.stringify({ url: "https://example.com/a.gif" }),
      { contactId: "web-emote-test", conversationId: conv.id, turnId: null },
    );
    // 工具契约统一后，业务软失败也归一化成外层 ok:false（卡片不再打绿勾）；
    // result 仍是完整载荷，模型照旧拿得到 {ok:false,error} 去改给 /media。
    assert.strictEqual(r3.ok, false, "http 外链在应用端应被拒，外层也判失败：" + JSON.stringify(r3));
    assert.strictEqual(r3.result.ok, false, "载荷保留业务失败形状");
    assert.match(String(r3.result.error), /(应用端|\/media)/, "拒因点明换成 /media");
    assert.match(String(r3.error), /(应用端|\/media)/, "卡片拿到同一句人话错误");

    console.log("表情渠道分流（应用端 web）：全部通过");
  };
  run().catch((error) => {
    console.error("表情渠道分流（应用端 web）失败：", error);
    process.exit(1);
  });
} else {
  const base = { ...process.env, WEB_EMOTE_SUB: "1", DB_PATH: "./data/web-emote-regression.db", MEDIA_DIR: "./data/web-emote-media" };
  const child = spawn(process.execPath, ["--experimental-sqlite", "scripts/web-emote-regression.test.mjs"], { env: base, stdio: "inherit" });
  child.on("close", async (code) => {
    for (const f of ["web-emote-regression.db", "web-emote-media"]) {
      for (const s of ["", "-wal", "-shm"]) if (existsSync(`./data/${f}${s}`)) rmSync(`./data/${f}${s}`, { force: true });
    }
    if (code === 0) console.log("表情渠道分流回归（official + onebot 各跑一遍）：全部通过");
    else { console.error(`表情渠道分流回归：子进程退出码 ${code}`); process.exit(1); }
  });
}
