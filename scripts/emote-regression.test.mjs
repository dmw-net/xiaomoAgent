/**
 * 表情系统（QQ 表情包）回归测试。
 *
 * 覆盖：
 *   1. 素材库 CRUD：登记 / 列表 / 关键词命中 / 删除 / 统计；
 *   2. 目录导入：真实 PNG 文件入库 + 按内容 md5 去重（重导不重复）；
 *   3. 自动采集：默认关（他发来的图不入库），开启后入库；
 *   4. 渠道渲染：official 把 face/mface 降级成文字/emoji、image 原生走富媒体；
 *      onebot 则 face/mface/image 全原生（OneBot 消息段）；
 *   5. OneBot 文件引用形态：必须是协议端解得开的绝对 file:///（站内相对路径会被解到当前盘根）；
 *   6. 机器名治理：哈希文件名不当 label / 不进 tags（否则筛选条一屏哈希，且 includes 匹配有误命中面）；
 *   7. 存量清洗：老库里的哈希 label/标签洗掉，只清名字不删素材，且幂等；
 *   8. 富媒体凭证有效期 + 缓存本体：命中 / 到期 / 作废 / 跨场景不串号 / 上限淘汰。
 *
 * 5b 用假 QQ API（createQQService 支持注入 fetch）跑真实投递链，所以「第二次不再上传」
 * 与「凭证失效自愈」是被端到端断言过的，不是只测了缓存容器。
 *
 * official 与 onebot 的渲染分支由启动时的 config.qq.backend 定死，所以这里起两个
 * 子进程各跑一遍（--experimental-sqlite，独立 DB/MEDIA_DIR 隔离），父进程等它俩都绿。
 * 运行：node --experimental-sqlite scripts/emote-regression.test.mjs
 */
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 一张合法的 1x1 透明 PNG（魔数 89 50 4E 47），sniffImageMime 认得出，saveImage 落得下。
const TINY_PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489" +
  "0000000D49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

const PHASE = process.env.EMOTE_SUB;

if (PHASE === "1") {
  // ── 子进程：跑公共断言 + 对应渠道的渲染断言 ─────────────────────
  const run = async () => {
    const emote = await import("../src/qq-emote.ts");
    const backend = process.env.QQ_BACKEND === "onebot" ? "onebot" : "official";

    // 1) 素材库 CRUD。
    assert.strictEqual(emote.listEmoteAssets().length, 0, "空库起步");
    assert.strictEqual(emote.registerEmoteAsset("/media/aaa1.png", "大笑", ["哈", "笑死"]), true, "登记一张");
    assert.strictEqual(emote.registerEmoteAsset("/media/bbb2.png", "伤心", []), true, "再登记一张");
    assert.strictEqual(emote.listEmoteAssets().length, 2, "两进两出");
    assert.strictEqual(emote.emoteStats().total, 2, "统计对齐");
    // 关键词命中：命中多张应返回其中之一（url 落在已登记集合里）。
    const picked = emote.pickEmoteByKeyword("大笑");
    assert.ok(picked !== null, "关键词「大笑」命中");
    assert.ok(["/media/aaa1.png", "/media/bbb2.png"].includes(picked?.url ?? ""), "命中落在已登记素材内");
    assert.strictEqual(emote.removeEmoteAsset("/media/aaa1.png"), true, "删一张");
    assert.strictEqual(emote.removeEmoteAsset("/media/不存在的.png"), false, "删不存在的返回 false");
    assert.strictEqual(emote.listEmoteAssets().length, 1, "删后剩一");

    // 2) 目录导入（真实 PNG）+ md5 去重。
    const srcDir = mkdtempSync(join(tmpdir(), `emote-src-${backend}-`));
    writeFileSync(join(srcDir, "happy.png"), TINY_PNG);
    writeFileSync(join(srcDir, "sad.png"), TINY_PNG); // 内容相同，应被 md5 去重为 1 张新图
    const first = emote.importEmoteDir(srcDir, { tag: "梗" });
    assert.ok(!("error" in first), "导入无报错");
    assert.strictEqual(first.added, 1, "同批两张同内容，md5 去重只进 1 张");
    assert.strictEqual(first.skipped, 1, "同批第二张被 md5 跳过");
    const second = emote.importEmoteDir(srcDir);
    assert.strictEqual(second.added, 0, "重导不再新增");
    assert.strictEqual(second.skipped, 2, "重导按 manifest 跳过两张");

    // 3) 自动采集：默认关（不入），开启后入库。
    assert.strictEqual(emote.emoteAutoCapture(), false, "默认关");
    assert.strictEqual(emote.captureInboundEmote("/media/inbound1.png", "他发的"), false, "关时 no-op");
    assert.ok(!emote.listEmoteAssets().some((a) => a.url === "/media/inbound1.png"), "关时没入");
    emote.setEmoteAutoCapture(true);
    assert.strictEqual(emote.emoteAutoCapture(), true, "开了");
    assert.strictEqual(emote.captureInboundEmote("/media/inbound2.png"), true, "开后入库");
    assert.ok(emote.listEmoteAssets().some((a) => a.url === "/media/inbound2.png"), "开了入得去");

    // 4) 渠道渲染分支。
    const face = emote.renderEmote({ kind: "face", id: 4, label: "大笑" });
    const image = emote.renderEmote({ kind: "image", url: "/media/aaa1.png" });
    const mface = emote.renderEmote({ kind: "mface", emojiId: "m_1" });
    const caps = emote.emoteCapabilities();
    assert.strictEqual(caps.backend, backend, "能力探测报出当前渠道");
    if (backend === "official") {
      assert.strictEqual(caps.face, false, "官方发不了原生 face");
      assert.strictEqual(face.native, false, "官方 face 降级");
      assert.ok(face.fallbackText !== "", "官方 face 有 emoji 兜底文案");
      assert.strictEqual(face.segments.length, 0, "官方不产 face 段");
      assert.strictEqual(image.native, true, "官方 image 原生");
      assert.strictEqual(image.mediaRefs.length, 1, "官方 image 走富媒体引用");
      assert.strictEqual(mface.native, false, "官方 mface 降级");

      // 5b) 端到端：同一张图发两次只上传一次；缓存凭证被平台判失效时作废重传而不是直接失败。
      //     假 QQ API 只认这条链路会用到的端点，按调用次数记账。
      const { createQQService } = await import("../src/qq.ts");
      const { createContact } = await import("../src/contacts.ts");
      let filesCalls = 0;
      let sendCalls = 0;
      let failNextSend = false;
      const fakeFetch = async (rawUrl) => {
        const path = String(rawUrl).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
        if (path.endsWith("/getAppAccessToken")) return json({ access_token: "tk", expires_in: 7200 });
        if (path.endsWith("/upload_prepare")) {
          return json({ upload_id: "up1", block_size: 5_242_880, parts: [{ index: 0, block_size: TINY_PNG.length, presigned_url: "http://127.0.0.1:1/put" }] });
        }
        if (path.endsWith("/files")) { filesCalls += 1; return json({ file_name: "f.png", file_info: "fi-" + filesCalls, ttl: 3600 }); }
        if (path.endsWith("/messages")) {
          sendCalls += 1;
          if (failNextSend) { failNextSend = false; return json({ code: 50, message: "invalid file_info" }); }
          return json({ id: "m" + sendCalls });
        }
        return json({}); // 分片 PUT 到预签名地址 / part_finish，内容都不重要
      };
      const svc = createQQService({
        fetchImpl: fakeFetch,
        now: () => Date.now(),
        socketFactory: () => new Proxy({}, { get: () => () => undefined }),
      });
      const contact = createContact({ name: "表情回归测试" });
      svc.setCredentials(contact.id, { appId: "10001", clientSecret: "sekret", enabled: true });
      const savedOfficial = (await import("../src/media.ts")).saveImage(TINY_PNG, "image/png");
      const ref = [{ url: savedOfficial.url }];
      const first = await svc.deliverMediaToContact(contact.id, "", ref);
      const second = await svc.deliverMediaToContact(contact.id, "", ref);
      assert.strictEqual(first.sent, 1, "第一次投递成功");
      assert.strictEqual(second.sent, 1, "第二次投递成功");
      assert.strictEqual(filesCalls, 1, "同一张图发两次只上传一次（file_info 被复用）");
      assert.strictEqual(sendCalls, 2, "两次都真的发了消息");
      // 缓存里的凭证被平台判失效：作废 → 重传 → 重发，对用户仍然是一次成功投递。
      failNextSend = true;
      const third = await svc.deliverMediaToContact(contact.id, "", ref);
      assert.strictEqual(third.sent, 1, "凭证失效后自愈，不该报成「这张图发不出去」");
      assert.strictEqual(third.failed, 0, "自愈过程不留下失败计数");
      assert.strictEqual(filesCalls, 2, "作废后重传了一次");
      assert.strictEqual(sendCalls, 4, "失败那次 + 重试那次都在");
      svc.dispose();
    } else {
      assert.strictEqual(caps.face, true, "OneBot 能发原生 face");
      assert.strictEqual(face.native, true, "OneBot face 原生");
      assert.strictEqual(face.segments[0]?.type, "face", "OneBot 产 face 段");
      assert.strictEqual(image.native, true, "OneBot image 原生");
      assert.strictEqual(image.segments[0]?.type, "image", "OneBot 产 image 段");
      assert.strictEqual(mface.native, true, "OneBot mface 原生");
      assert.strictEqual(mface.segments[0]?.type, "mface", "OneBot 产 mface 段");

      // 5) OneBot 的文件引用形态。协议端只认「已收到的文件名 / file:/// 绝对路径 / http URL /
      //    base64://」，站内相对路径 `/media/x.png` 会被它当本地路径解到当前盘根上去。
      const media = await import("../src/media.ts");
      const saved = media.saveImage(TINY_PNG, "image/png");
      const real = emote.renderEmote({ kind: "image", url: saved.url });
      const fileValue = String(real.segments[0]?.data?.file ?? "");
      assert.ok(fileValue.startsWith("file:///"), `image 段要带绝对 file:/// 引用：${fileValue}`);
      assert.ok(fileValue.endsWith(saved.url.split("/").pop()), "引用指向的就是那张落盘文件");
      assert.strictEqual(media.mediaAbsPath("/media/zzzzzzzzzzzzzzzz.png"), null, "没落盘的文件不该有绝对路径");
      // 文件不在盘上时保持原样传出去——让协议端如实报错，比我们编一个假绝对路径静默失败好。
      assert.strictEqual(image.segments[0]?.data?.file, "/media/aaa1.png", "读不到的文件不伪造路径");
    }

    // 6) 机器名治理：哈希文件名不该变成 label / 标签（否则界面上一屏 `bb35665c…`，
    //    而 label/tags 走 includes 匹配，纯 hex 串里可能藏着 face / dead 这类词）。
    assert.strictEqual(emote.isMachineName("bb35665cd031d632d2b454d3d412c251"), true, "md5");
    assert.strictEqual(emote.isMachineName("31637313df4bfa88f487d87383da95c8_0"), true, "md5 带 _0 后缀（旧守卫的漏网形态）");
    assert.strictEqual(emote.isMachineName("be7dab78-c232-45be-9127-835ad7683e76"), true, "uuid");
    assert.strictEqual(emote.isMachineName("3ee4d90053d078956c9a4856be2f937212464df8"), true, "sha1");
    for (const human of ["he", "hug", "blue-maid", "token-2", "image007", "鲸鱼娘", "beefcafe", "dead", "face", "a-b-c-d-e-f"]) {
      assert.strictEqual(emote.isMachineName(human), false, `人类起的名字不该被误杀：${human}`);
    }
    emote.registerEmoteAsset("/media/hash1.png", "251e25bc0f2ea3faffd707181bda7b36", ["31637313df4bfa88f487d87383da95c8_0", "梗", "梗"]);
    const gated = emote.listEmoteAssets().find((a) => a.url === "/media/hash1.png");
    assert.strictEqual(gated?.label, "", "写入侧挡掉机器名 label");
    assert.deepEqual(gated?.tags, ["梗"], "机器名标签被剔除，真标签保留且去重");
    // 关键词匹配也不该看见机器名：拿哈希串当关键词去搜，素材库里那张图不该因 label 命中。
    assert.strictEqual(emote.pickEmoteByKeyword("251e25bc0f2ea3faffd707181bda7b36")?.url === "/media/hash1.png", false, "机器名不再参与关键词命中");

    // 7) 存量清洗：老库里已经写进去的脏数据要能洗掉，且幂等（干净之后不再写库）。
    const { kvGet, kvSet } = await import("../src/db.ts");
    kvSet("qq.emote.v1", JSON.stringify({
      version: 1,
      assets: [{ url: "/media/legacy1.png", label: "bd1ef1ec6a7062118ecca54af69e52a4", tags: ["bd1ef1ec6a7062118ecca54af69e52a4", "旧批次"] }],
    }));
    assert.strictEqual(emote.migrateEmoteStore(), true, "脏库需要清洗");
    const legacy = emote.listEmoteAssets().find((a) => a.url === "/media/legacy1.png");
    assert.strictEqual(legacy?.label, "", "存量机器名 label 已洗掉");
    assert.deepEqual(legacy?.tags, ["旧批次"], "存量机器名标签已洗掉，真标签保留");
    assert.ok(String(kvGet("qq.emote.v1")).includes("旧批次"), "清洗结果落回 KV");
    assert.strictEqual(emote.migrateEmoteStore(), false, "第二次不再写库");
    assert.strictEqual(emote.listEmoteAssets().length, 1, "清洗只清名字，不删素材");

    // 8) 富媒体凭证有效期：照平台回的 ttl 算，并留出提前作废的余量。
    const qq = await import("../src/qq.ts");
    assert.strictEqual(qq.fileInfoLifetimeMs(7200), 7_200_000 - 60_000, "ttl 秒数换算 + 留余量");
    assert.ok(qq.fileInfoLifetimeMs(0) >= 3_600_000, "ttl=0（可长期使用）仍是有界有效期");
    assert.ok(qq.fileInfoLifetimeMs(-1) >= 3_600_000, "平台没回 ttl 走保守值，而不是当永久");
    assert.ok(Number.isFinite(qq.fileInfoLifetimeMs(NaN)), "非法 ttl 不产生永久缓存");
    assert.strictEqual(qq.fileInfoLifetimeMs(30), 0, "短于余量的 ttl 直接不缓存");

    // 9) 凭证缓存本体（file_info 复用的底层件）：命中 / 到期 / 作废 / 跨场景不串号 / 上限淘汰。
    const { CredentialCache } = await import("../src/channels/delivery.ts");
    let now = 1_000;
    const cache = new CredentialCache(3, () => now);
    cache.set("a|private|openid-1|md5A", "fi-A", 500);
    assert.strictEqual(cache.get("a|private|openid-1|md5A"), "fi-A", "有效期内命中，不再重传");
    assert.strictEqual(cache.get("a|private|openid-2|md5A"), undefined, "换个目标号就是另一条凭证");
    assert.strictEqual(cache.get("a|group|g-1|md5A"), undefined, "私聊凭证与群凭证不串用");
    now = 1_501;
    assert.strictEqual(cache.get("a|private|openid-1|md5A"), undefined, "到期即失效，不是永久复用");
    cache.set("zero", "v", 0);
    assert.strictEqual(cache.get("zero"), undefined, "有效期 0 的干脆不占位");
    cache.set("k2", "v2", 100);
    cache.invalidate("k2");
    assert.strictEqual(cache.get("k2"), undefined, "发送失败后主动作废，下次重取");
    for (const key of ["x1", "x2", "x3", "x4"]) cache.set(key, key, 1000);
    assert.strictEqual(cache.size, 3, "有界：超上限从最旧的开始丢");
    assert.strictEqual(cache.get("x1"), undefined, "最旧那条被淘汰");
    assert.strictEqual(cache.get("x4"), "x4", "最新那条还在");

    // 内置表情词表可解析。
    const faceDef = emote.resolveFace("大笑");
    assert.ok(faceDef !== null && faceDef.id === 4, "关键词「大笑」→ face id 4");
    assert.ok(emote.faceEmoji(4) !== "", "face id 4 有降级 emoji");

    rmSync(srcDir, { recursive: true, force: true });
    console.log(`表情回归（${backend}）：全部通过`);
  };
  run().catch((error) => {
    console.error(`表情回归（${process.env.QQ_BACKEND ?? "official"}）失败：`, error);
    process.exit(1);
  });
} else {
  // ── 父进程：起 official / onebot 两个子进程，都绿才算过 ─────────
  const base = process.env;
  const children = [
    spawn(process.execPath, ["--experimental-sqlite", "scripts/emote-regression.test.mjs"], {
      env: { ...base, EMOTE_SUB: "1", QQ_BACKEND: "official", DB_PATH: "./data/emote-regression-official.db", MEDIA_DIR: "./data/emote-media-official" },
      stdio: "inherit",
    }),
    spawn(process.execPath, ["--experimental-sqlite", "scripts/emote-regression.test.mjs"], {
      env: { ...base, EMOTE_SUB: "1", QQ_BACKEND: "onebot", DB_PATH: "./data/emote-regression-onebot.db", MEDIA_DIR: "./data/emote-media-onebot" },
      stdio: "inherit",
    }),
  ];
  const codes = await Promise.all(children.map((child) => new Promise((res) => child.on("close", (code) => res(code ?? 0)))));
  for (const file of ["emote-regression-official.db", "emote-regression-onebot.db"]) {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`./data/${file}${suffix}`)) rmSync(`./data/${file}${suffix}`, { force: true });
  }
  const failed = codes.filter((c) => c !== 0).length;
  if (failed > 0) {
    console.error(`表情回归：${failed} 个渠道进程失败（official/onebot 各跑一遍）`);
    process.exit(1);
  }
  console.log("表情回归（official + onebot）：全部通过");
}
