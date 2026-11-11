/**
 * 表情系统（QQ 表情包）回归测试。
 *
 * 覆盖：
 *   1. 素材库 CRUD：登记 / 列表 / 关键词命中 / 删除 / 统计；
 *   2. 目录导入：真实 PNG 文件入库 + 按内容 md5 去重（重导不重复）、源文件名整串留档进别名、
 *    流水号前缀不混进中文名、超上限的文件在回执里报出文件名与原因；
 *   3. 自动采集：默认关（他发来的图不入库），开启后入库；
 *   4. 渠道渲染：official 把 face/mface 降级成文字/emoji、image 原生走富媒体；
 *      onebot 则 face/mface/image 全原生（OneBot 消息段）；
 *   5. OneBot 文件引用形态：必须是协议端解得开的绝对 file:///（站内相对路径会被解到当前盘根）；
 *   6. 机器名治理：哈希文件名不当 label / 不进 tags（否则筛选条一屏哈希，且 includes 匹配有误命中面）；
 *   7. 存量清洗：老库里的哈希 label/标签洗掉，只清名字不删素材，且幂等；
 *   8. 富媒体凭证有效期 + 缓存本体：命中 / 到期 / 作废 / 跨场景不串号 / 上限淘汰；
 *   9. 接收闭环：OneBot 入站媒体落盘（path/url/get_image 三路）、face/mface 占位、
 *      采集按内容去重、语音段归 audio。
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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 一张合法的 1x1 透明 PNG（魔数 89 50 4E 47），sniffImageMime 认得出，saveImage 落得下。
const TINY_PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489" +
  "0000000D49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);
// 一张真正的 GIF87a（43 字节）。不能用 png 的字节配 .gif 的文件名——sharp 按扩展名选解码器。
const TINY_GIF = Buffer.from(
  "47494638376101000100800000FFFFFF00000021F90401000000002C00000000010001000002024401003B",
  "hex",
);

const PHASE = process.env.EMOTE_SUB;

if (PHASE === "1") {
  // ── 子进程：跑公共断言 + 对应渠道的渲染断言 ─────────────────────
  const run = async () => {
    const emote = await import("../src/emote/qq-emote.ts");
    const media = await import("../src/media/media.ts");
    const assetsMod = await import("../src/media/assets.ts");
    const search = await import("../src/emote/emote-search.ts");
    // listAssets 读时要 LEFT JOIN artifacts（作品的提示词不复制进资产表，联表现取）。
    // 那张表是 artifacts.ts 的 import 副作用，不先 import 一下就会「no such table」。
    await import("../src/media/artifacts.ts");
    const { createContact } = await import("../src/chat/contacts.ts");
    const backend = process.env.QQ_BACKEND === "onebot" ? "onebot" : "official";

    /** 落一张真图，返回它的 /media 路径。素材登记现在要求文件真的在盘上，测试也得给真的。 */
    const savePng = () => media.saveImage(TINY_PNG, "image/png").url;

    // 1) 素材库 CRUD。
    assert.strictEqual(assetsMod.listEmoteAssets().length, 0, "空库起步");
    const aaa = savePng();
    const bbb = savePng();
    assert.strictEqual(emote.registerEmoteAsset(aaa, { label: "大笑", tags: ["哈", "笑死"] }), true, "登记一张");
    assert.strictEqual(emote.registerEmoteAsset(bbb, { label: "伤心" }), true, "再登记一张");
    assert.strictEqual(assetsMod.listEmoteAssets().length, 2, "两进两出");
    assert.strictEqual(emote.emoteStats().total, 2, "统计对齐");
    // 指向不在盘上的文件不许登记：老代码能存下 /media/aaa1.png 这种空气条目，
    // 到了发送那一刻只会变成「本地媒体文件读不到」——「她说发出去了但什么都没有」就是这么来的。
    assert.strictEqual(emote.registerEmoteAsset("/media/deadbeef00000001.png", { label: "空气" }), false, "文件不在盘上拒登记");
    assert.strictEqual(assetsMod.listEmoteAssets().length, 2, "空气条目没进来");
    // 关键词命中：中文名字现在直接是检索字段，不再需要一张源码里的同义词表当桥。
    const picked = search.pickEmoteByKeyword("大笑");
    assert.ok(picked !== null, "关键词「大笑」命中");
    assert.ok([aaa, bbb].includes(picked?.asset.url ?? ""), "命中落在已登记素材内");
    assert.strictEqual(emote.removeEmoteAsset(aaa), true, "删一张");
    assert.strictEqual(emote.removeEmoteAsset("/media/不存在的.png"), false, "删不存在的返回 false");
    assert.strictEqual(assetsMod.listEmoteAssets().length, 1, "删后剩一");

    // 2) 目录导入（真实 PNG）+ md5 去重 + 归属文件夹＝源文件夹名（没有第二个名字来源）。
    const srcDir = mkdtempSync(join(tmpdir(), `emote-src-${backend}-`));
    writeFileSync(join(srcDir, "happy.png"), TINY_PNG);
    writeFileSync(join(srcDir, "sad.png"), TINY_PNG); // 内容相同，应被 md5 去重为 1 张新图
    const first = emote.importEmoteDir(srcDir);
    assert.ok(!("error" in first), "导入无报错");
    assert.strictEqual(first.added, 1, "同批两张同内容，md5 去重只进 1 张");
    assert.strictEqual(first.skipped, 1, "同批第二张被 md5 跳过");
    const second = emote.importEmoteDir(srcDir);
    assert.strictEqual(second.added, 0, "重导不再新增");
    assert.strictEqual(second.skipped, 2, "重导按 manifest 跳过两张");
    const srcBase = srcDir.split(/[\\/]/).filter(Boolean).pop();
    assert.strictEqual(emote.folderNameOf("D:\\a\\b\\c\\"), "c", "folderNameOf 取路径最后一段");
    assert.strictEqual(emote.folderNameOf("/tmp/pics/"), "pics", " posix 路径同口径");
    {
      const packed = assetsMod.listEmoteAssets().filter((a) => a.emotePack.includes(srcBase));
      assert.strictEqual(packed.length, 1, "导入那一张带上了源文件夹名");
      const imported = packed[0];
      assert.deepEqual(imported.emotePack, [srcBase], "归属文件夹＝源文件夹名，不接受手填别名");
      assert.deepEqual(imported.emoteTags, [], "文件夹名没有混进语义标签（那是「搜一个词命中全库」的病根）");
      // 文件名 happy 是英文句柄：进别名当兜底叫法，但不占中文名——中文名要等认图或她自己在界面上写。
      assert.deepEqual(imported.emoteAlias, ["happy"], "英文文件名进别名");
      assert.strictEqual(imported.emoteLabel, "", "英文文件名不叫「名字」");
      assert.strictEqual(imported.emoteNamedAt, 0, "没认过图，界面上要显「未命名」");
    }

    // 3) 自动采集：默认关（不入），开启后入库；同内容按哈希去重——表情包被反复转发是日常，
    //    按 URL 挡不住（每次落盘都是新文件名），只有内容指纹认得出「这还是那张」。
    const CAP_BYTES = Buffer.concat([TINY_PNG, Buffer.from([9, 8, 7, 6])]); // 与前面所有 png（TINY_PNG 同内容）无关的新内容
    const inbound1 = savePng(); // 与 bbb 同内容：开着开关也该被去重挡掉
    const inbound2 = media.saveImage(CAP_BYTES, "image/png").url;
    assert.strictEqual(emote.emoteAutoCapture(), false, "默认关");
    assert.strictEqual(emote.captureInboundEmote(inbound2), false, "关时 no-op");
    assert.ok(!assetsMod.listEmoteAssets().some((a) => a.url === inbound2), "关时没入");
    emote.setEmoteAutoCapture(true);
    assert.strictEqual(emote.emoteAutoCapture(), true, "开了");
    assert.strictEqual(emote.captureInboundEmote(inbound1), false, "库里已有同内容表情 → 哈希去重挡住");
    assert.strictEqual(emote.captureInboundEmote(inbound2), true, "开后新内容入库");
    const capCount = assetsMod.listEmoteAssets().length;
    const inbound3 = media.saveImage(CAP_BYTES, "image/png").url;
    assert.strictEqual(emote.captureInboundEmote(inbound3), false, "同一张图再发来一次不进第二遍");
    assert.strictEqual(assetsMod.listEmoteAssets().length, capCount, "去重没让库变脏");
    {
      // 采集成功会自动排一次延时补名（防抖 60s）；测试里撤掉，别让它烧到后面的断言上。
      const namingEarly = await import("../src/emote/emote-naming.ts");
      assert.strictEqual(namingEarly.namingJobStatus().running, false, "采集不立刻起作业（防抖）");
      namingEarly.cancelCaptureNaming();
    }

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
      const { createQQService } = await import("../src/channels/qq.ts");
      let filesCalls = 0;
      let sendCalls = 0;
      let failNextSend = false;
      const preparedNames = [];
      const fakeFetch = async (rawUrl, init = {}) => {
        const path = String(rawUrl).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
        if (path.endsWith("/getAppAccessToken")) return json({ access_token: "tk", expires_in: 7200 });
        if (path.endsWith("/upload_prepare")) {
          try { preparedNames.push(String(JSON.parse(String(init.body ?? "{}")).file_name ?? "")); } catch { /* 记不到名字不影响下面的断言口径 */ }
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
      const savedOfficial = (await import("../src/media/media.ts")).saveImage(TINY_PNG, "image/png");
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
      // 5c) 动图：官方富媒体只认 png/jpg，GIF 会吃 850019。
      //     这里断言发出去的是派生的静帧，而不是原图——不是「库里全是动图就甩不出去」。
      const gifName = "00000000000000cd.gif";
      writeFileSync(join(media.mediaDir(), gifName), TINY_GIF);
      assetsMod.registerAsset({
        id: gifName.replace(".gif", ""), url: "/media/" + gifName,
        kind: "image", mime: "image/gif", bytes: TINY_GIF.length, source: "imported",
      });
      const gifSend = await svc.deliverMediaToContact(contact.id, "", [{ url: "/media/" + gifName }]);
      assert.strictEqual(gifSend.sent, 1, "动图也发得出去：" + (gifSend.lastError || "ok"));
      assert.ok(preparedNames.at(-1).endsWith(".png"), "这一次上传的是派生静帧：" + preparedNames.at(-1));
      assert.ok(!preparedNames.some((n) => n.endsWith(".gif")), "整场测试里动图本体从没被直接上传给官方富媒体");
      svc.dispose();

      // 5d) 图片表情富媒体投递失败：不能报成功。图片才是表情本体，降级文字只是补救
      //     （与 send_voice 的 MediaOutcome 同口径：sent=0 就是失败）；降级文字本身
      //     也要看回执——文字也没发出去时，收不到任何东西就是彻底的失败。
      const { kvSet } = await import("../src/core/db.ts");
      const { ensureConversation } = await import("../src/chat/conversations.ts");
      let failUpload = false;
      let failText = false;
      const fakeFetchFail = async (rawUrl, init = {}) => {
        const path = String(rawUrl).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
        if (path.endsWith("/getAppAccessToken")) return json({ access_token: "tk", expires_in: 7200 });
        if (path.endsWith("/upload_prepare")) {
          if (failUpload) return json({ code: 40093002, message: "mock upload rejected" });
          return json({ upload_id: "up1", block_size: 5_242_880, parts: [{ index: 0, block_size: TINY_PNG.length, presigned_url: "http://127.0.0.1:1/put" }] });
        }
        if (path.endsWith("/files")) return json({ file_name: "f.png", file_info: "fi-fail", ttl: 3600 });
        if (path.endsWith("/messages")) {
          if (failText) return json({ code: 50, message: "mock text rejected" });
          return json({ id: "m" });
        }
        return json({});
      };
      const failContact = createContact({ name: "表情失败回归" });
      const failConv = ensureConversation({
        contactId: failContact.id, channel: "qq", kind: "private", externalId: "openid-fail",
      });
      // 先撒好带 openid 的账号，文字降级才走得到消息端点（sendPrivate 没有 openid 会直接抛）。
      kvSet("qq.accounts.v2", JSON.stringify({
        version: 2,
        accounts: [{
          id: "acc-emote-fail", contactId: failContact.id, appId: "10001", clientSecret: "sekret",
          enabled: true, userOpenId: "openid-fail", recentMessageIds: [], replyMessageId: "",
          replyMessageAt: 0, lastError: "", lastErrorAt: 0, lastReceivedAt: "", lastSentAt: "",
          createdAt: new Date().toISOString(),
        }],
      }));
      const failSvc = createQQService({
        fetchImpl: fakeFetchFail,
        now: () => Date.now(),
        socketFactory: () => new Proxy({}, { get: () => () => undefined }),
      });
      failSvc.setCredentials(failContact.id, { appId: "10001", clientSecret: "sekret", enabled: true });
      const failImage = media.saveImage(TINY_PNG, "image/png");
      failUpload = true; failText = false;
      const degraded = await failSvc.deliverEmote(failConv.id, { kind: "image", url: failImage.url, label: "摸鱼" });
      assert.strictEqual(degraded.ok, false, "图片没发出去不能报成功：" + JSON.stringify(degraded));
      assert.strictEqual(degraded.via, "text", "降级成文字");
      assert.ok(String(degraded.detail).includes("已改发文字"), "回执要说明降级文字已补发：" + degraded.detail);
      failText = true;
      const bothFailed = await failSvc.deliverEmote(failConv.id, { kind: "image", url: failImage.url, label: "摸鱼" });
      assert.strictEqual(bothFailed.ok, false, "图片和降级文字都没发出去");
      assert.ok(String(bothFailed.detail).includes("降级文字也没发出去"), "回执要说明文字也没发出去：" + bothFailed.detail);
      // face 在官方渠道没有原生通道，降级成文字/emoji 是正常能力，不算失败。
      failText = false;
      const faceDowngrade = await failSvc.deliverEmote(failConv.id, { kind: "face", id: 4, label: "大笑" });
      assert.strictEqual(faceDowngrade.ok, true, "官方 face 降级成文字是正常能力：" + JSON.stringify(faceDowngrade));
      assert.strictEqual(faceDowngrade.via, "text", "face 走文字降级");
      failSvc.dispose();
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
      const saved = media.saveImage(TINY_PNG, "image/png");
      const real = emote.renderEmote({ kind: "image", url: saved.url });
      const fileValue = String(real.segments[0]?.data?.file ?? "");
      assert.ok(fileValue.startsWith("file:///"), `image 段要带绝对 file:/// 引用：${fileValue}`);
      assert.ok(fileValue.endsWith(saved.url.split("/").pop()), "引用指向的就是那张落盘文件");
      assert.strictEqual(media.mediaAbsPath("/media/zzzzzzzzzzzzzzzz.png"), null, "没落盘的文件不该有绝对路径");
      // 文件不在盘上时保持原样传出去——让协议端如实报错，比我们编一个假绝对路径静默失败好。
      assert.strictEqual(image.segments[0]?.data?.file, "/media/aaa1.png", "读不到的文件不伪造路径");
    }

    // 6) 机器名治理：哈希文件名不该变成名字 / 标签（否则界面上一屏 `bb35665c…`，
    //    而纯 hex 串里可能藏着 face / dead 这类词，检索会误命中）。
    assert.strictEqual(emote.isMachineName("bb35665cd031d632d2b454d3d412c251"), true, "md5");
    assert.strictEqual(emote.isMachineName("31637313df4bfa88f487d87383da95c8_0"), true, "md5 带 _0 后缀（旧守卫的漏网形态）");
    assert.strictEqual(emote.isMachineName("be7dab78-c232-45be-9127-835ad7683e76"), true, "uuid");
    assert.strictEqual(emote.isMachineName("3ee4d90053d078956c9a4856be2f937212464df8"), true, "sha1");
    for (const human of ["he", "hug", "blue-maid", "token-2", "image007", "鲸鱼娘", "beefcafe", "dead", "face", "a-b-c-d-e-f"]) {
      assert.strictEqual(emote.isMachineName(human), false, `人类起的名字不该被误杀：${human}`);
    }
    const hashUrl = savePng();
    emote.registerEmoteAsset(hashUrl, {
      label: "251e25bc0f2ea3faffd707181bda7b36",
      tags: ["31637313df4bfa88f487d87383da95c8_0", "梗", "梗"],
    });
    const gated = assetsMod.listEmoteAssets().find((a) => a.url === hashUrl);
    assert.strictEqual(gated?.emoteLabel, "", "写入侧挡掉机器名 label");
    assert.deepEqual(gated?.emoteTags, ["梗"], "机器名标签被剔除，真标签保留且去重");
    // 拿哈希串当关键词去搜，不该因为库里存过它而命中。
    assert.strictEqual(search.pickEmoteByKeyword("251e25bc0f2ea3faffd707181bda7b36")?.asset.url === hashUrl, false, "机器名不参与关键词命中");
    // 引号要挡：批次名按 JSON 整词筛（emote_pack LIKE '%"名"'），名字里带引号会把筛选条件破掉。
    // 名字故意取「嘿嘿笑」而不是「开心」——下面第 10 节要断「开心」的唯一命中，同名会把它变成抽奖。
    const quoteUrl = savePng();
    emote.registerEmoteAsset(quoteUrl, { label: "嘿嘿笑", pack: ['带"引号"的包'] });
    const quoted = assetsMod.listEmoteAssets().find((a) => a.url === quoteUrl);
    assert.deepEqual(quoted?.emotePack, ["带引号的包"], "批次名里的引号被去掉，筛选条件不会被破");
    assert.strictEqual(assetsMod.listAssets({ view: "emote", limit: 50, offset: 0, pack: "带引号的包" }).items.length, 1,
      "按这个批次名筛得到那一张");

    // 7) 存量迁移：老格式（kv 里一整块 JSON）搬进 assets 表，机器名照样洗掉；搬完不留第二份真相。
    const { kvGet, kvSet } = await import("../src/core/db.ts");
    const legacyUrl = savePng();
    kvSet("qq.emote.v1", JSON.stringify({
      version: 1,
      assets: [{ url: legacyUrl, label: "bd1ef1ec6a7062118ecca54af69e52a4", tags: ["bd1ef1ec6a7062118ecca54af69e52a4", "旧批次"] }],
    }));
    assert.strictEqual(emote.migrateEmoteStore(), true, "老 blob 被搬走");
    const legacy = assetsMod.listEmoteAssets().find((a) => a.url === legacyUrl);
    assert.strictEqual(legacy?.emoteLabel, "", "存量机器名 label 已洗掉");
    assert.deepEqual(legacy?.emoteTags, ["旧批次"], "存量机器名标签已洗掉，真标签保留");
    assert.strictEqual(emote.migrateEmoteStore(), false, "第二次是 no-op（blob 已清空，表是唯一出处）");
    assert.ok(String(kvGet("qq.emote.v1") ?? "").length < 4, "老 blob 没有留着当第二份数据");
    assert.ok(assetsMod.listEmoteAssets().some((a) => a.url === hashUrl), "迁移不会把已有的素材挤掉");

    // 8) 富媒体凭证有效期：照平台回的 ttl 算，并留出提前作废的余量。
    const qq = await import("../src/channels/qq.ts");
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

    // 10) 语义拆分迁移：英文句柄从 tags/label 里拆进别名。文件夹是登记时写的来源事实，迁移不猜。
    {
      const u0 = savePng(); const u1 = savePng(); const u2 = savePng(); const u3 = savePng();
      emote.registerEmoteAsset(u0, { label: "heart-hands", tags: ["heart-hands", "比心"], pack: ["鲸鱼娘·静态"] });
      emote.registerEmoteAsset(u1, { label: "lie-flat", tags: ["lie-flat"], pack: ["鲸鱼娘·静态"] });
      emote.registerEmoteAsset(u2, { label: "开心", tags: ["大笑"], pack: ["鲸鱼娘·静态"] });
      emote.registerEmoteAsset(u3, { label: "我躺平了", tags: ["躺"], pack: ["鲸鱼娘·静态"] });
      const split = assetsMod.migrateEmoteSemantics();
      assert.ok(split.split >= 2, "英文句柄被拆进别名了：" + split.split);
      const byUrl = (url) => assetsMod.listEmoteAssets().find((a) => a.url === url);
      const r0 = byUrl(u0); const r2 = byUrl(u2); const r3 = byUrl(u3);
      assert.deepEqual(r0.emotePack, ["鲸鱼娘·静态"], "文件夹是导入时写的来源，迁移原样保留");
      assert.deepEqual(r0.emoteTags, ["比心"], "只属于这一张的标签留在语义标签里");
      assert.deepEqual(r0.emoteAlias, ["heart-hands"], "英文文件名进别名");
      assert.strictEqual(r0.emoteLabel, "", "英文文件名不占中文名——它不是「这张在说什么」");
      assert.strictEqual(r2.emoteLabel, "开心", "中文名就是名字，不搬走");
      assert.strictEqual(r3.emoteLabel, "我躺平了", "中文文件名直接当名字");
      assert.deepEqual(r3.emoteTags, ["躺"], "手写的语义标签一张没丢");
      const again = assetsMod.migrateEmoteSemantics();
      assert.strictEqual(again.split, 0, "第二次运行是 no-op（不靠标记位判断，靠「没有可搬的了」）");

      // 11) 分层打分：文件夹名撑不起一次自动发。
      assert.strictEqual(search.pickEmoteByKeyword("鲸鱼娘·静态"), null,
        "只命中文件夹名不算够贴——旧实现在这里会从 89 张里随机甩一张不相干的");
      const bucket = search.searchEmotes("鲸鱼娘·静态", 20);
      assert.ok(bucket.length >= 4 && bucket.every((h) => h.matchedOn === "pack"),
        "文件夹名仍作为宽泛候选返回，并标明命中的是文件夹而不是内容");
      assert.strictEqual(search.pickEmoteByKeyword("开心")?.asset.emoteLabel, "开心", "中文名精确命中");
      assert.strictEqual(search.pickEmoteByKeyword("也太开心了吧")?.asset.emoteLabel, "开心",
        "查询比名字长也撞得上（中文自做 bi-gram，旧实现只有 field.includes(query) 这一个方向）");
      assert.strictEqual(search.pickEmoteByKeyword("heart-hands")?.asset.url, u0, "按文件原名仍找得到");
      assert.strictEqual(search.pickEmoteByKeyword("heart")?.asset.url, u0, "句柄的前半截也算");
      assert.strictEqual(search.pickEmoteByKeyword("qwq 库里绝对没有的词"), null, "没有就是没有，不硬凑");
      assert.strictEqual(search.queryTerms("也太开心了吧").includes("开心"), true, "bi-gram 展开本身");
      assert.strictEqual(search.queryTerms("heart-hands").includes("heart"), true, "英文按 - 拆开");
      assert.deepEqual(search.queryTerms(""), [], "空查询不产生任何词");
      // 使用计数只做轻微上浮，不许把新图永远压死。
      assetsMod.bumpEmoteUse(r0.id);
      const boosted = assetsMod.listEmoteAssets().find((a) => a.url === u0);
      assert.strictEqual(boosted.emoteUseCount, 1, "发过一次记一笔");
      assert.ok(search.scoreEmote(r0, ["qwq 库里绝对没有的词"]).score === 0, "用量不能凭空造出命中");

      // 使用次数只能影响候选排序，不能把弱命中推过自动发送线。
      const weakUrl = savePng();
      emote.registerEmoteAsset(weakUrl, { caption: "只有这里会出现的夸爆字样" });
      const { db: rankDb } = await import("../src/core/db.ts");
      rankDb.prepare("UPDATE assets SET emote_use_count = 500 WHERE url = ?").run(weakUrl);
      const weakRanked = search.searchEmotes("夸爆", 3).find((h) => h.asset.url === weakUrl);
      assert.ok(weakRanked !== undefined, "弱命中仍可作为候选供模型判断");
      assert.strictEqual(weakRanked.semanticScore, 2, "caption 命中只有纯语义分 2");
      assert.ok(weakRanked.score > weakRanked.semanticScore, "使用次数仍会抬高排序分");
      const weakDecision = search.autoPickEmote("夸爆");
      assert.strictEqual(weakDecision.kind, "choose", "高使用次数不能把弱命中变成高置信自动发");
      assert.ok(weakDecision.reason.includes("不够高"), "回执说明纯语义分没到线");

      // 语义同分时，使用次数不能制造出“第一名明显领先”的假象（决策只看纯语义）；
      // 但整词命中名字的同分桶不算不确定——查「热度同分测试」，两张名字一模一样，
      // 随机甩一张正是人干的事，交回候选只会多烧一轮还诱发连锁失败。
      const hotUrl = savePng();
      const coldUrl = savePng();
      emote.registerEmoteAsset(hotUrl, { label: "热度同分测试" });
      emote.registerEmoteAsset(coldUrl, { label: "热度同分测试" });
      rankDb.prepare("UPDATE assets SET emote_use_count = 500 WHERE url = ?").run(hotUrl);
      const tieHits = search.searchEmotes("热度同分测试", 3);
      assert.strictEqual(tieHits[0]?.asset.url, hotUrl, "常用图仍可排在候选第一位");
      assert.strictEqual(tieHits[0]?.semanticScore, tieHits[1]?.semanticScore, "两张的纯语义分相同");
      const tieDecision = search.autoPickEmote("热度同分测试");
      assert.strictEqual(tieDecision.kind, "send", "整词命中名字的同分桶直接发，不交回候选多烧一轮");

      // 12) 智能识别：真调用链（视觉能力 → 多模态请求 → JSON → 写库），假服务商回 canned 结果。
      const naming = await import("../src/emote/emote-naming.ts");
      assert.strictEqual(naming.startNamingJob().started, false, "图片理解没配时起作业要如实拒绝，不是空跑");
      const { updateModel } = await import("../src/settings/settings.ts");
      // mode 要显式给 openai：出厂是 echo（离线回声档），不改 mode 的话 capabilityReady 永远 false，
      // 这条断言就跑在同一条「没配好就不许起作业」的规则上——那正是上面那条断言要覆盖的形态。
      updateModel({
        mode: "openai",
        baseUrl: "http://127.0.0.1:9/v1", apiKey: "probe-key", name: "vision-probe",
        caps: { tools: false, vision: true, thinking: false, thinkingOnly: false, customProtocol: false },
      });
      assert.strictEqual((await import("../src/settings/settings.ts")).capabilityReady("imageVision"), true,
        "视觉能力就绪（下面整段认图测试的前提）");
      const captured = [];
      let respondBad = false;
      let rateLimitTimes = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        captured.push(body);
        if (rateLimitTimes > 0) {
          rateLimitTimes -= 1;
          return {
            ok: false, status: 429,
            headers: { get: () => "application/json" },
            text: async () => JSON.stringify({ error: { message: "rate limit exceeded" } }),
          };
        }
        const content = respondBad
          ? "这不是 JSON"
          : JSON.stringify({
            name: "被吓到", meaning: "他说了句出人意料的话时甩", tags: ["惊讶", "替自己表达", "嘴巴张大"],
            confidence: 0.7,
          });
        return {
          ok: true, status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: {} }),
          json: async () => ({ choices: [{ message: { content } }] }),
        };
      };
      try {
        // 一张故意让它失败：模型回的不是 JSON。
        const badUrl = savePng();
        emote.registerEmoteAsset(badUrl, { pack: ["认图测试"] });
        respondBad = true;
        const bad = await naming.captionEmote(assetsMod.getAssetByUrl(badUrl), { attempts: 1 });
        respondBad = false;
        assert.strictEqual(naming.captionFailed(bad), true, "模型没回合法 JSON 时算失败，不编一个名字");
        assert.ok(/JSON/.test(bad.error), "失败要带人话原因（界面拿它说话）：" + bad.error);
        assert.strictEqual(bad.retryable, false, "没回 JSON 不是限流，重试只是白烧额度");
        assert.strictEqual(assetsMod.getAssetByUrl(badUrl).emoteLabel, "", "失败的那张名字还是空的");
        // 解析器的反证：真机上失败的那几张不是模型没答，是它给了带尾逗号的对象。
        assert.deepEqual(naming.parseCaptionJson('{"name":"比心","tags":["撒娇","感谢"]}')?.name, "比心", "合法对象");
        assert.deepEqual(naming.parseCaptionJson('{"tags":["划水","摸鱼","调侃",],"name":"我划水了"}')?.name, "我划水了",
          "尾逗号要救回来（真机实测这种形态占了失败的一大半）");
        assert.deepEqual(naming.parseCaptionJson('```json\n{"name":"好耶"}\n```')?.name, "好耶", "代码围栏要剥掉");
        assert.deepEqual(naming.parseCaptionJson('好的，我看看：{"name":"来啦"} 以上。')?.name, "来啦", "对象前后的寒暄要忽略");
        assert.strictEqual(naming.parseCaptionJson("这不是 JSON"), null, "真不是 JSON 就报 null，不硬凑一个名字");
        assert.strictEqual(naming.parseCaptionJson("[1,2,3]"), null, "数组不是我们要的对象");
        // 新门反证：限流必须**退避后重试**（真机上第 7 张就撞 429，不重试等于半库判死）。
        // 喂 4 张假 429：callModel 内部还有一层 withRetry 快重试，两次 429 才把 ModelError
        // 抛到命名层——命名层要退避两次（8000、20000）就得喂两对。
        rateLimitTimes = 4;
        const waits = [];
        const retried = await naming.captionEmote(assetsMod.getAssetByUrl(badUrl), {
          attempts: 3, wait: async (ms) => { waits.push(ms); },
        });
        assert.strictEqual(naming.captionFailed(retried), false, "两次限流之后第三次要成功");
        assert.deepEqual(waits, [8000, 20000], "退避是越等越久（429 的窗口按分钟算，1.5s 等于白等）");
        rateLimitTimes = 99;
        const doomed = await naming.captionEmote(assetsMod.getAssetByUrl(badUrl), {
          attempts: 2, wait: async () => { /* 测试里不真等 */ },
        });
        rateLimitTimes = 0;
        assert.strictEqual(naming.captionFailed(doomed), true, "一直限流最终要如实失败");
        assert.strictEqual(doomed.retryable, true, "并且标明这是可重试的那一类");

        const before = assetsMod.emoteNamingStats();
        assert.ok(before.total > before.named && before.named === 0, "起步时全库都没认过名");
        const started = naming.startNamingJob({ limit: 3 });
        assert.strictEqual(started.started, true, "作业起来了");
        for (let i = 0; i < 200 && naming.namingJobStatus().running; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const job = naming.namingJobStatus();
        assert.strictEqual(job.running, false, "作业会结束");
        assert.strictEqual(job.total, 3, "limit 生效");
        assert.strictEqual(job.done, 3, "三张都跑过");
        assert.strictEqual(job.named, 3, "三张都认出来了");
        const named = assetsMod.listEmoteAssets().filter((a) => a.emoteNamedAt > 0);
        assert.strictEqual(named.length, 3, "库里落下三张已认名");
        assert.strictEqual(named[0].emoteLabel, "被吓到", "中文名来自模型");
        assert.ok(named[0].emoteTags.includes("惊讶"), "语义标签一起写回");
        assert.ok(named[0].emoteCaption !== "", "一句用法说明");
        const imageParts = captured[0].messages[0].content.filter((p) => p.type === "image_url").length;
        assert.ok(imageParts >= 1, "请求里带的是真图，不是纯文本：" + imageParts);
        assert.ok(JSON.stringify(captured[0]).includes("作为一句聊天回复"),
          "提示词问的是「这张当回复时在说什么」，不是「图里有什么」");
        // 断点续跑：认过的不再花一次调用；没认完的接着认。
        const firstNamed = named[0];
        const callsAfterFirst = captured.length;
        const second = naming.startNamingJob({ limit: 3 });
        assert.strictEqual(second.started, true, "库里还有没认过的，作业就该继续起");
        for (let i = 0; i < 200 && naming.namingJobStatus().running; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.strictEqual(assetsMod.emoteNamingStats().named, 6, "第二批又认了三张");
        assert.strictEqual(assetsMod.getAssetById(firstNamed.id).emoteNamedAt, firstNamed.emoteNamedAt,
          "已经认过的那张没有被重认（续跑不重复烧调用）");
        assert.strictEqual(captured.length, callsAfterFirst + 3, "第二批只发了三张的调用");
        // 把整库认完，再点一次就是 no-op——界面那颗按钮因此可以放心反复按。
        naming.startNamingJob();
        for (let i = 0; i < 400 && naming.namingJobStatus().running; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const all = assetsMod.emoteNamingStats();
        assert.strictEqual(all.named, all.total, "整库都认过了：" + all.named + "/" + all.total);
        const callsBefore = captured.length;
        const rerun = naming.startNamingJob();
        assert.strictEqual(rerun.started, false, "都认过了就不再起作业");
        assert.strictEqual(captured.length, callsBefore, "重跑一次视觉调用都没发");
        // 单张识别（弹窗里那颗「智能识别」）：排进当前队列，轮询到这一行出现就回填。不另起一条作业，所
        // 以整库跑着时它排在后面；关闭弹窗也不影响后台继续跑。
        const startedRerun = naming.startNamingJob({ only: [named[0].id], force: true });
        assert.strictEqual(startedRerun.started, true, "排进当前作业");
        for (let i = 0 && naming.namingJobStatus().running; i < 200; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const renamed = assetsMod.getAssetById(named[0].id);
        assert.ok(renamed.emoteLabel !== "", "重认写回了中文名");
        assert.ok(captured.length > callsBefore, "确实发了一次调用");
        // 导入文件名是用户给的线索，不能只停在分类里：重认时要给模型看，但提示词明确要求以画面为准。
        // 线索的真源是 alias——落盘名是内容哈希，label 会被识别覆盖，只有 alias 记得这张图原本叫什么。
        const fileHintAsset = { ...assetsMod.getAssetById(named[0].id), emoteAlias: ["10N01_猫猫搓手"] };
        const hintCall = captured.length;
        const hinted = await naming.captionEmote(fileHintAsset, { attempts: 1 });
        assert.strictEqual(naming.captionFailed(hinted), false, "带文件名的单张重认要成功");
        assert.ok(JSON.stringify(captured[hintCall]).includes("文件名是「10N01_猫猫搓手」"),
          "导入文件名要作为视觉识别的参考线索传进提示词（读 alias，不读会被识别覆盖的 label）");
        assert.ok(JSON.stringify(captured[hintCall]).includes("不要机械照抄"),
          "参考名只能校正，不能替代看图和用法判断");
        // 反证：模型自己起过的名字不喂回去——喂回去只会强化原有偏差。
        const noAliasAsset = { ...assetsMod.getAssetById(named[0].id), emoteAlias: [], emoteLabel: "被吓到", emoteNameSource: "auto" };
        const noAliasCall = captured.length;
        await naming.captionEmote(noAliasAsset, { attempts: 1 });
        assert.ok(!JSON.stringify(captured[noAliasCall]).includes("参考线索"),
          "没留档文件名的那张不该拿到参考线索");
        // 重认只该重写语义，不该顺手改掉她填的批次归属。
        const kept = assetsMod.getAssetById(named[0].id);
        assetsMod.applyEmoteSemantics(kept.url, { pack: ["认图测试"], alias: ["heart-hands"] });
        await naming.captionEmote(kept, { attempts: 1 });
        const afterRename = assetsMod.getAssetById(named[0].id);
        assert.deepEqual(afterRename.emotePack, ["认图测试"], "重认不覆盖用户填的批次名");
        assert.deepEqual(afterRename.emoteAlias, ["heart-hands"], "重认不覆盖别名");
        // 新门反证：作业级的自适应节流。真机实测 20 张里 8 张即使单张退避 3 次仍然失败——
        // 只救单张不降整库的速，等于下半库白烧调用。撞过一次限流，下一张就该慢点打。
        const gaps = [];
        // 喂一对 429：callModel 内部的 withRetry 快重试会先消化一张，命名层要看到一对才退避。
        rateLimitTimes = 2;
        const throttled = naming.startNamingJob({ force: true, limit: 2, wait: async (ms) => { gaps.push(ms); } });
        assert.strictEqual(throttled.started, true, "force 模式可以重认已经认过的");
        // 队列追加：作业还在跑第一张时往里排一张（同 id 去重、force 升级），total 跟着涨。
        // startNamingJob 返回后作业不可能同步跑完（worker 第一件事就是 await 网络调用），
        // 所以这里同步追加一定落在 running 状态里。
        const extraUrl = savePng();
        emote.registerEmoteAsset(extraUrl, { pack: ["追加队列"] });
        const extraId = assetsMod.listEmoteAssets().find((a) => a.url === extraUrl).id;
        const appended = naming.startNamingJob({ only: [extraId], force: true });
        assert.strictEqual(appended.started, true, "整库跑着时仍可排进当前任务");
        assert.strictEqual(naming.namingJobStatus().total, 3, "总张数跟着加 1（2 → 3）");
        for (let i = 0; i < 600 && naming.namingJobStatus().running; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        rateLimitTimes = 0;
        const tjob = naming.namingJobStatus();
        assert.strictEqual(tjob.failed, 0, "退避后救回来的那张不该算失败");
        assert.strictEqual(tjob.named, 3, "三张都认回来了");
        assert.ok(gaps.includes(8000), "单张退避等过 8s：" + JSON.stringify(gaps));
        assert.ok(gaps.includes(3000), "下一张确实按抬起来的间隔排队：" + JSON.stringify(gaps));
        assert.ok(tjob.throttleMs > 0, "节流状态对界面可见：" + tjob.throttleMs);
        const extraDone = assetsMod.getAssetById(extraId);
        assert.ok(extraDone.emoteLabel !== "", "追加进来的那张也认完了");
        assert.ok(tjob.results.find((r) => r.id === extraId)?.name !== "", "结果行里有它");
        // 笑脸是开关不是重新登记：取消再勾回来，认好的名字必须还在（一次误点不该洗掉名字）。
        const toggleRow = assetsMod.getAssetById(named[0].id);
        assert.ok(toggleRow.emoteLabel !== "", "这张已经有名字");
        assetsMod.setEmoteMark(toggleRow.url, false);
        assert.strictEqual(assetsMod.getAssetById(toggleRow.id).usableAsEmote, false, "摘掉标记");
        assetsMod.setEmoteMark(toggleRow.url, true);
        const back = assetsMod.getAssetById(toggleRow.id);
        assert.strictEqual(back.usableAsEmote, true, "再勾回来");
        assert.strictEqual(back.emoteLabel, toggleRow.emoteLabel, "开关式勾选不洗名字");
        assert.ok(back.emoteNamedAt > 0, "认图状态也还在");
      } finally {
        globalThis.fetch = realFetch;
      }

      // 12b) 批量包的「流水号_中文名」：整句柄留档进 alias，名字只收剥掉前缀的部分；
      //      没进来的文件要在回执里报出文件名和原因——只给一个数字，用户只能猜少了哪两张。
      assert.strictEqual(emote.stripIndexPrefix("10N01_猫猫搓手"), "猫猫搓手", "剥掉批量包的流水号前缀");
      assert.strictEqual(emote.stripIndexPrefix("N06_略略略"), "略略略", "纯字母编号前缀同样剥");
      assert.strictEqual(emote.stripIndexPrefix("heart-hands"), "heart-hands", "英文句柄不切（hands 不是名字）");
      assert.strictEqual(emote.stripIndexPrefix("HE万岁"), "HE万岁", "没有分隔符就不动");
      {
        const packDir = mkdtempSync(join(tmpdir(), `emote-pack-${backend}-`));
        writeFileSync(join(packDir, "10N01_猫猫搓手.png"), TINY_PNG);
        // 6MB 这张要进得来：导入这一条的上限是 20MB（MAX_IMPORT_IMAGE_BYTES），
        // 因为它收的是用户主动交上来的本地文件；全局那道 5MB 闸管的是自动抓来的字节，不跟着抬。
        const six = Buffer.concat([TINY_PNG, Buffer.alloc(6 * 1024 * 1024, 7)]);
        writeFileSync(join(packDir, "N06_略略略.png"), six);
        writeFileSync(join(packDir, "N07_太大只.png"), Buffer.concat([TINY_PNG, Buffer.alloc(21 * 1024 * 1024, 9)]));
        writeFileSync(join(packDir, "readme.txt"), Buffer.from("not an image"));
        const r = emote.importEmoteDir(packDir);
        assert.ok(!("error" in r), "带前缀的批量包导入无报错");
        assert.strictEqual(r.added, 2, "6MB 那张进得来，21MB 那张被导入上限挡住");
        assert.strictEqual(r.skipped, 1, "超限计入 skipped；非图片扩展名不算少图");
        assert.strictEqual(r.skippedFiles.length, 1, "跳过的文件有明细");
        assert.strictEqual(r.skippedFiles[0].name, "N07_太大只.png", "明细给的是文件名");
        assert.match(r.skippedFiles[0].reason, /20MB/, "回执报的是导入这一条的上限，不是全局那道：" + r.skippedFiles[0].reason);
        // 两条闸要分得开：同一份 6MB 字节走全局那条（聊天入站、网页找图）仍然被拒。
        assert.throws(() => media.saveImage(six, "image/png"), /5MB/, "全局那道 5MB 闸没被导入放宽带跑");
        const packBase = packDir.split(/[\\/]/).filter(Boolean).pop();
        const inPack = assetsMod.listEmoteAssets().filter((a) => a.emotePack.includes(packBase));
        assert.strictEqual(inPack.length, 2, "两张都登记进来了");
        const row = inPack.find((a) => a.emoteAlias.includes("10N01_猫猫搓手"));
        assert.deepEqual(row.emoteAlias, ["10N01_猫猫搓手"], "源文件名整串留档进别名（落盘名是哈希，不留档就再也对不回源包）");
        assert.strictEqual(row.emoteLabel, "猫猫搓手", "名字只收剥掉前缀的部分，不是一整串");
        assert.strictEqual(row.emoteNameSource, "file", "文件名给的名字标成 file，识别可以覆盖它");
        assert.ok(row.emoteNamedAt > 0, "文件名已经给出名字，算认过（不白烧一次视觉调用）");
        assert.ok(!inPack.some((a) => a.emoteLabel === "10N01_猫猫搓手"), "整串句柄不当名字");
      }

      // 13) 工具闭环：先查后发、按 id 发、越界拒绝；同一轮换词可重试，同一 query 不重复跑。
      // u2 的名字在这里显式写一次：上面那批作业先认哪三张由 created_at 顺序决定，
      // 这一节要测的是「按中文名找得到并发出去」，不是「作业挑了谁」。
      assetsMod.applyEmoteSemantics(u2, { label: "开心", caption: "他被夸了又不好意思承认", namedAt: Date.now() });
      const { executeTool } = await import("../src/mind/tools.ts");
      const { updateContact } = await import("../src/chat/contacts.ts");
      const { ensureLocalConversation } = await import("../src/chat/conversations.ts");
      const contact = createContact({ name: "表情闭环测试" });
      // 表情是全局唯一开关（出厂 normal 就是开的），没有按联系人的开关。
      const conv = ensureLocalConversation(contact.id);
      const ctx = { contactId: contact.id, conversationId: conv.id, turnId: "turn-" + Date.now(), lastUserAt: null };

      // 一步式快路：唯一高置信命中直接发；整词命中名字的同分桶也直接发（随机甩一张）；
      // 标签级的中低分段同分仍只回候选、不替模型赌。
      const uniqueUrl = savePng();
      emote.registerEmoteAsset(uniqueUrl, { label: "独一档" });
      const twinA = savePng();
      const twinB = savePng();
      emote.registerEmoteAsset(twinA, { label: "双胞胎表情" });
      emote.registerEmoteAsset(twinB, { label: "双胞胎表情" });
      assert.strictEqual(search.autoPickEmote("独一档").kind, "send", "唯一高置信候选可自动发");
      assert.strictEqual(search.autoPickEmote("双胞胎表情").kind, "send", "整词命中名字的同分桶也直接发，随机选桶内一张");
      const autoSent = await executeTool("send_emote", JSON.stringify({ keyword: "独一档" }), ctx);
      assert.strictEqual(autoSent.attachments?.[0], assetsMod.listEmoteAssets().find((a) => a.url === uniqueUrl).url,
        "keyword 快路一步发出正确素材");
      const twinSent = await executeTool("send_emote", JSON.stringify({ keyword: "双胞胎表情" }), ctx);
      assert.strictEqual(twinSent.ok, true, "同义同分桶走快路直接发出");
      assert.ok([twinA, twinB].includes(twinSent.attachments?.[0]), "发出去的是桶里的其中一张");
      // 标签级命中只有 4.9 分：同分拿不准，交回候选让模型选。
      const tagTieA = savePng();
      const tagTieB = savePng();
      emote.registerEmoteAsset(tagTieA, { tags: ["半斤八两"] });
      emote.registerEmoteAsset(tagTieB, { tags: ["半斤八两"] });
      assert.strictEqual(search.autoPickEmote("半斤八两").kind, "choose", "标签级同分仍交回模型选择");
      const ambiguous = await executeTool("send_emote", JSON.stringify({ keyword: "半斤八两" }), ctx);
      assert.strictEqual(ambiguous.result.sent, false, "中低分段同分不自动发");
      assert.ok(ambiguous.result.candidates.length >= 2, "把接近的候选交回模型选择");
      const found = await executeTool("emote_search", JSON.stringify({ query: "开心" }), ctx);
      assert.strictEqual(found.ok, true, "检索工具可调用");
      const candidates = found.result.candidates;
      assert.ok(candidates.length > 0, "查得到候选");
      assert.ok(candidates[0].emote_id !== undefined && candidates[0].name !== undefined, "候选带 id 与名字");
      const missed = await executeTool("emote_search", JSON.stringify({ query: "绝对没有" }), ctx);
      assert.strictEqual(missed.result.candidates.length, 0, "第一次没查到");
      const retried = await executeTool("emote_search", JSON.stringify({ query: "真开心" }), ctx);
      assert.ok(retried.result.candidates.length > 0, "换个词后同一轮能重试并查到候选");
      const repeated = await executeTool("emote_search", JSON.stringify({ query: "真开心" }), ctx);
      assert.ok(String(repeated.result.note).includes("这条查询本轮已经查过"), "同一 query 不重复跑");
      const picked = candidates[0];
      const sent = await executeTool("send_emote", JSON.stringify({ emote_id: picked.emote_id }), ctx);
      assert.strictEqual(sent.ok, true, "按 id 发得出去（应用端挂气泡）");
      assert.strictEqual(sent.attachments?.[0], assetsMod.getAssetById(picked.emote_id).url, "发出去的就是那张候选");
      assert.ok(assetsMod.getAssetById(picked.emote_id).emoteUseCount >= 1, "发成功后使用计数加了一笔");
      // executeTool 外层永远 ok:true，工具自己的失败在 result.ok=false 那一层——断言要读那一边。
      const failOf = (r) => (r.result !== null && typeof r.result === "object" && r.result.ok === false
        ? String(r.result.error) : null);
      // 失败回执各自在独立的一轮里断言：门控按轮计状态，共用一轮会互相污染
      //（连续两次查询失败就封轮，后面的回执就变成门控话术了）。
      const freshCtx = () => ({
        contactId: contact.id, conversationId: conv.id,
        turnId: "turn-" + Math.random().toString(36).slice(2), lastUserAt: null,
      });
      // 越界：没标成表情的资产不能被当表情发——模型只能从 emote_search 给的候选里挑。
      const plain = assetsMod.listAssets({ view: "all", limit: 50, offset: 0 }).items.find((a) => !a.usableAsEmote);
      assert.ok(plain !== undefined, "库里有一张不是表情的普通图片（这条断言的前提）");
      const cross = await executeTool("send_emote", JSON.stringify({ emote_id: plain.id }), freshCtx());
      assert.ok(failOf(cross) !== null, "非表情资产按 id 发要被拒掉：" + JSON.stringify(cross.result));
      assert.ok(failOf(cross).includes("不是表情包素材"), "拒因要说得清：" + failOf(cross));
      const bogus = await executeTool("send_emote", JSON.stringify({ emote_id: "不存在的 id" }), freshCtx());
      assert.ok(failOf(bogus) !== null, "编不出来的 id 会被拒");
      assert.ok(failOf(bogus).includes("emote_search"), "拒绝的话要指出下一步怎么走");
      const miss = await executeTool("send_emote", JSON.stringify({ keyword: "qwq 库里绝对没有的词" }), freshCtx());
      assert.ok(failOf(miss) !== null, "keyword 没打中要如实失败");
      // error 是给工具卡的一句人话；库的真实规模在 hint 里（拆开是为了软失败卡不刷红字）。
      const missHint = String(miss.result?.hint ?? "");
      assert.ok(/张/.test(missHint), "失败回执的 hint 报的是库的真实规模，不是「换个词」：" + missHint);
      // 门控容错：候选交回 → 模型换词撞墙 → 同一轮按候选 id 补发，
      // 这一步不许被「别再重试」拦死——查询失败不等于投递失败。
      const recovery = freshCtx();
      const missThenId = await executeTool("send_emote", JSON.stringify({ keyword: "qwq 库里绝对没有的词" }), recovery);
      assert.ok(failOf(missThenId) !== null, "第一次查询失败，如实回执");
      const afterMiss = await executeTool("send_emote", JSON.stringify({ emote_id: picked.emote_id }), recovery);
      assert.strictEqual(afterMiss.ok, true, "查询没命中不影响按 id 补发（旧版一次失败封死整轮）");
      // 连续两次查询失败才封轮：防的是换词刷屏，不是断模型的活路。
      const twiceMiss = freshCtx();
      await executeTool("send_emote", JSON.stringify({ keyword: "qwq 库里绝对没有的词" }), twiceMiss);
      await executeTool("send_emote", JSON.stringify({ keyword: "qwq 库里绝对没有的词" }), twiceMiss);
      const sealed = await executeTool("send_emote", JSON.stringify({ emote_id: picked.emote_id }), twiceMiss);
      const sealedMsg = sealed.ok === false ? String(sealed.error) : String(failOf(sealed) ?? "");
      assert.ok(sealedMsg.includes("别再重试"), "连续两次查询失败后整轮封死，不再补发：" + sealedMsg);
      // 表情是全局唯一开关：档位设成「关闭」时工具与提示词段一起下线，开回来时一起回来。
      // 不存在「全局倾向 + 联系人开关」两档——工具声明与提示词段必须同源，
      // 不会一边有一边没有（开关看着开着、底下全断的那种断链）。
      const { setGlobalEmoteFrequency } = await import("../src/settings/settings.ts");
      const { emoteFrequencyForContact } = await import("../src/chat/contacts.ts");
      const promptOf = async (id) => (await import("../src/mind/persona.ts"))
        .buildSystemPrompt([], { emoteFrequency: emoteFrequencyForContact(id) });
      setGlobalEmoteFrequency("off");
      const declaredOff = (await import("../src/mind/tools.ts")).toolDefsForApi(contact.id).map((t) => t.function.name);
      assert.ok(!declaredOff.includes("send_emote") && !declaredOff.includes("emote_search"), "全局档「关闭」时两个表情工具都不声明");
      assert.ok(!(await promptOf(contact.id)).includes("[表情]"), "全局档「关闭」时提示词里没有表情段");
      setGlobalEmoteFrequency("often");
      const declaredOn = (await import("../src/mind/tools.ts")).toolDefsForApi(contact.id).map((t) => t.function.name);
      assert.ok(declaredOn.includes("send_emote") && declaredOn.includes("emote_search"), "开回「主动」后两个工具一起回来");
      assert.ok((await promptOf(contact.id)).includes("[表情]"), "开回后表情段一起回来（提示词与工具同源，不会一边有一边没有）");
      // 反证：这位的「工具总开关」关掉时，表情提示也不该留着——没有手却被告知能发表情，就是下一句「我发了」的编造现场。
      updateContact(contact.id, { features: { tools: false } });
      assert.strictEqual(emoteFrequencyForContact(contact.id), null, "工具总开关关掉时这位收不到表情提示");
      updateContact(contact.id, { features: { tools: true } });
      // 主动那条路没有工具，表情靠 decide 契约里的 emote_keyword 表达（模型给反应词、代码查库落地）。
      // 全局档关着就不该向模型声明这个字段——声明了就是许一张发不出来的表情。
      const { buildDecideSystem } = await import("../src/mind/proactive.ts");
      assert.ok(buildDecideSystem("他", false, undefined, true).includes("emote_keyword"), "表情开着时主动判断要能给出反应词字段");
      assert.ok(!buildDecideSystem("他", false, undefined, false).includes("emote_keyword"), "表情关闭时不向模型声明这个字段");
      assert.ok(buildDecideSystem("他", false, undefined, true).includes("挑不出贴的就只发文字"),
        "字段说明写的是「够贴才带」，不是每条主动消息都配表情");
      // 埋点自证：这一轮向模型声明了哪些工具、模型实际调了哪些，必须能在 model_calls 里查到。
      // tools_declared / tools_called 要无条件落库（不能只在 DEV_MODE 落），
      // 否则「给了手却没人用」这种问题连分母都凑不出来，只能靠肉眼复现。
      {
        const { callModelWithTools } = await import("../src/settings/model.ts");
        const { db: dbMod } = await import("../src/core/db.ts");
        setGlobalEmoteFrequency("often");
        updateModel({ caps: { tools: true, vision: true, thinking: false, thinkingOnly: false, customProtocol: false } });
        const realFetchTools = globalThis.fetch;
        globalThis.fetch = async () => ({
          ok: true, status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({
            choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "emote_search", arguments: '{"query":"开心"}' } }] } }],
            usage: {},
          }),
          json: async () => ({}),
        });
        try {
          await callModelWithTools([{ role: "user", content: "甩个开心表情" }], [
            { type: "function", function: { name: "emote_search", description: "查候选", parameters: {} } },
            { type: "function", function: { name: "send_emote", description: "发一张", parameters: {} } },
          ], { purpose: "chat", contactId: contact.id });
        } finally {
          globalThis.fetch = realFetchTools;
        }
        const logged = dbMod.prepare("SELECT tools_declared, tools_called FROM model_calls ORDER BY id DESC LIMIT 1").get();
        assert.strictEqual(logged.tools_declared, "emote_search,send_emote", "声明给模型的工具名要落库");
        assert.strictEqual(logged.tools_called, "emote_search", "模型实际调用的工具名要落库（没调就是空串，和「没声明」要能区分）");
        updateModel({ caps: { tools: false, vision: true, thinking: false, thinkingOnly: false, customProtocol: false } });
      }
      // 14) 迁移不啃已识别的行，也不存在词频猜文件夹的路径：文件夹层只认来源事实，
      //     共享语义词留在 tags 里，文件夹只认登记时写的那个（pack 刻意不参与检索匹配）。
      {
        const namedUrls = [savePng(), savePng()];
        const controlUrls = [savePng(), savePng(), savePng()];
        for (const u of [...namedUrls, ...controlUrls]) {
          emote.registerEmoteAsset(u, { label: "", tags: ["可爱", "卖萌"] });
        }
        for (const u of namedUrls) assetsMod.applyEmoteSemantics(u, { namedAt: Date.now(), namedBy: "auto" });
        assetsMod.migrateEmoteSemantics();
        const kept = assetsMod.listEmoteAssets().filter((r) => namedUrls.includes(r.url));
        assert.strictEqual(kept.length, 2, "两张已识别的对照组都在库里");
        assert.ok(kept.every((r) => r.emoteTags.includes("可爱")), "已识别的行：共享语义标签必须留在 tags 里");
        assert.ok(kept.every((r) => !r.emotePack.includes("可爱")), "已识别的行不许被塞进文件夹");
        const control = assetsMod.listEmoteAssets().find((r) => r.url === controlUrls[0]);
        assert.ok(control.emoteTags.includes("可爱") && control.emoteTags.includes("卖萌"),
          "没识别过的行：共享语义词也不再被猜成文件夹——词频推断整个退役了");
        assert.deepEqual(control.emotePack, ["默认"], "没有导入来源的图归默认文件夹");

        // 改归属只有一条路——弹窗单选（applyEmoteSemantics 带 pack），并带着磁盘一起搬；
        // 不存在整批「退回」的入口。
        assetsMod.applyEmoteSemantics(namedUrls[0], { pack: ["可爱"] });
        const movedRow = assetsMod.getAssetByUrl(namedUrls[0]);
        assert.deepEqual(movedRow.emotePack, ["可爱"], "改归属走弹窗那条写路径");
        assert.ok(movedRow.relPath.startsWith("表情包/可爱/"), "改归属把文件一起搬进新目录");
        assetsMod.applyEmoteSemantics(namedUrls[0], { pack: [""] });
        assert.deepEqual(assetsMod.getAssetByUrl(namedUrls[0]).emotePack, ["默认"],
          "清空归属落回默认，不留无归属的表情");
        assert.ok(!("moveEmoteWord" in assetsMod), "moveEmoteWord 已删除——UI 没有入口的口子不留着当暗道");
      }

      // 14b) 文件夹层不变量：单一归属、默认兜底、存量收敛幂等且不碰时间线。
      {
        assert.strictEqual(assetsMod.DEFAULT_EMOTE_FOLDER, "默认", "默认文件夹名与界面文案同值");
        assert.deepEqual(assetsMod.oneFolder(undefined), ["默认"], "没给归属→默认");
        assert.deepEqual(assetsMod.oneFolder([]), ["默认"], "空归属→默认");
        assert.deepEqual(assetsMod.oneFolder(["", "  ", "甲", "乙"]), ["甲"], "跳过空白取第一个");
        assert.deepEqual(assetsMod.oneFolder(["甲", "乙"]), ["甲"], "多归属收敛到单一父级");
        // 聊天里随手标的图（没有导入来源）勾成表情时进默认文件夹。
        const plainUrl = savePng();
        assetsMod.setEmoteMark(plainUrl, true);
        assert.deepEqual(assetsMod.getAssetByUrl(plainUrl).emotePack, ["默认"], "随手标记进默认文件夹");
        assetsMod.setEmoteMark(plainUrl, false);
        assert.deepEqual(assetsMod.getAssetByUrl(plainUrl).emotePack, ["默认"], "取消标记不动文件夹");
        // 存量形态（老库直接写在列里的空数组/多归属）启动时收敛。
        const { db: folderDb } = await import("../src/core/db.ts");
        const legacyEmpty = savePng(); const legacyMulti = savePng();
        emote.registerEmoteAsset(legacyEmpty, {});
        emote.registerEmoteAsset(legacyMulti, {});
        folderDb.prepare("UPDATE assets SET emote_pack = '[]' WHERE url = ?").run(legacyEmpty);
        folderDb.prepare("UPDATE assets SET emote_pack = ? WHERE url = ?").run(JSON.stringify(["甲", "乙"]), legacyMulti);
        const tsOf = (url) => folderDb.prepare("SELECT updated_at FROM assets WHERE url = ?").get(url).updated_at;
        const tsEmpty = tsOf(legacyEmpty); const tsMulti = tsOf(legacyMulti);
        const converged = assetsMod.backfillEmoteFolder();
        assert.ok(converged >= 2, "空归属与多归属都被收敛：" + converged);
        assert.deepEqual(assetsMod.getAssetByUrl(legacyEmpty).emotePack, ["默认"], "空归属回填成默认");
        assert.deepEqual(assetsMod.getAssetByUrl(legacyMulti).emotePack, ["甲"], "多归属取第一个");
        assert.strictEqual(tsOf(legacyEmpty), tsEmpty, "归一不碰 updated_at（不打乱时间线顺序）");
        assert.strictEqual(tsOf(legacyMulti), tsMulti, "多归属收敛同样不碰 updated_at");
        assert.strictEqual(assetsMod.backfillEmoteFolder(), 0, "第二次是 no-op");
        assert.ok(assetsMod.listEmoteAssets().every((r) => r.emotePack.length === 1 && r.emotePack[0].trim() !== ""),
          "全库不变量：每张表情恰好属于一个非空文件夹");
        assert.ok(assetsMod.listEmotePacks().some((p) => p.pack === "默认"), "文件夹清单里有默认这一档");
      }

      // 15) 详情要能回答「哪些识别好了、结果是什么、哪几张要重试」。
      {
        const st = naming.namingJobStatus();
        assert.strictEqual(st.results.length, 3, "上一轮逐张结果都在（limit=2 加上排进来的追加那张）");
        assert.ok(st.results.every((r) => r.name !== "" || r.error !== ""), "每条结果要么有名字要么有原因");
        assert.ok(st.results.every((r) => r.file.endsWith(".png") || r.file.endsWith(".gif")), "结果带文件名");
        const auto = assetsMod.listAssets({ view: "emote", named: "auto", limit: 500, offset: 0 });
        const stats = assetsMod.emoteNamingStats();
        assert.strictEqual(auto.total, stats.auto, "「智能命名」筛选的张数与概览条同源（counts 是范围计数，不受筛选项影响）");
        const packRows = assetsMod.listEmotePacks();
        assert.ok(packRows.every((p) => p.file + p.auto + p.manual + p.unnamed === p.total),
          "每个文件夹的命名四档加起来就是它的张数——界面选中文件夹时 chips 读的就是这组数");
        assert.strictEqual(packRows.reduce((s, p) => s + p.auto, 0), stats.auto, "文件夹 auto 汇总与概览条同源");
        assert.strictEqual(packRows.reduce((s, p) => s + p.file, 0), stats.file, "文件夹 file 汇总与概览条同源");
        assert.strictEqual(packRows.reduce((s, p) => s + p.unnamed, 0), stats.total - stats.named, "文件夹 unnamed 汇总与概览条同源");
        assert.ok(auto.items.every((r) => r.emoteNameSource === "auto"), "筛出来的每一张都真是机器起的");
        assert.ok(assetsMod.listAssets({ view: "emote", named: "manual", limit: 500, offset: 0 }).items
          .every((r) => r.emoteNameSource === "manual"), "手动维护筛出来的每一张都真是手写的");
        assert.ok(assetsMod.listAssets({ view: "emote", named: "unnamed", limit: 500, offset: 0 }).items
          .every((r) => r.emoteNamedAt === 0), "未命名筛出来的确实还没名字");
        // 来源字段曾漏写在导入路径上：真库 523 张里 278 张有名字但 source 为空，
        // chips 只报 245，用户会以为数据丢了。没有来源的老行也不能冒充手动维护，
        // 统计与筛选都要把它落到「文件命名」，四档必须永远能加回总数。
        const legacyRow = assetsMod.listEmoteAssets().find((r) => r.emoteNamedAt > 0);
        const { db: rawDb } = await import("../src/core/db.ts");
        rawDb.prepare("UPDATE assets SET emote_name_source = '', source = 'unclaimed' WHERE id = ?").run(legacyRow.id);
        const patched = assetsMod.getAssetById(legacyRow.id);
        assert.strictEqual(patched.emoteNameSource, "", "先造一个「有名字没来源」的存量形态");
        const fallbackStats = assetsMod.emoteNamingStats();
        assert.strictEqual(fallbackStats.file + fallbackStats.auto + fallbackStats.manual + (fallbackStats.total - fallbackStats.named), fallbackStats.total,
          "来源为空时四档计数仍要加回总数");
        const fallbackFile = assetsMod.listAssets({ view: "emote", named: "file", limit: 500, offset: 0 });
        assert.ok(fallbackFile.items.some((r) => r.id === legacyRow.id),
          "有名字但没记来源的旧行要能被「文件命名」筛到，不能在界面里消失");
        const filled = assetsMod.backfillEmoteNameSource();
        assert.ok(filled >= 1, "回填命中了这些行");
        assert.strictEqual(assetsMod.getAssetById(legacyRow.id).emoteNameSource, "auto", "回填后算机器命名");
        assert.strictEqual(assetsMod.backfillEmoteNameSource(), 0, "第二次是 no-op");
        const stats2 = assetsMod.emoteNamingStats();
        assert.strictEqual(stats2.file + stats2.auto + stats2.manual + (stats2.total - stats2.named), stats2.total,
          "概览条四档必须能加回总数");
        // 失效项不能只留在概览条里：必须有独立筛选，点一下就能在网格里看到并清理。
        const victim = assetsMod.listEmoteAssets().find((r) => !r.missing);
        rawDb.prepare("UPDATE assets SET missing = 1 WHERE id = ?").run(victim.id);
        const brokenOnly = assetsMod.listAssets({ view: "emote", missing: true, limit: 500, offset: 0 });
        assert.ok(brokenOnly.total >= 1 && brokenOnly.items.every((r) => r.missing), "失效筛选只列 missing 行");
        rawDb.prepare("UPDATE assets SET missing = 0 WHERE id = ?").run(victim.id);
      }
      // 16) 日志脱敏不许把一次成功的识别弄失败。真机上那张 5.2MB 的 PNG 就是这么被判死的：
      //     DEV_MODE 下 logModelCall 会对 6.9MB 的请求体跑一条 {512,} 贪婪正则，V8 吃栈溢出。
      {
        const logs = await import("../src/core/logs.ts");
        const big = "data:image/png;base64," + "A".repeat(7_000_000);
        const body = JSON.stringify({ messages: [{ content: [{ type: "image_url", image_url: { url: big } }] }] });
        // 反证：旧写法在这个输入上确实会炸——这条门抓的就是它，不是自证。
        assert.throws(
          () => body.replace(/data:(?:image|audio)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/g, () => ""),
          /call stack/i, "旧正则在 7MB base64 上确实栈溢出",
        );
        const stripped = logs.stripInlineDataUrls(body);
        assert.ok(stripped.includes("字符已省略"), "超长 base64 被换成占位");
        assert.ok(stripped.length < 1000, "占位后不再驻留几 MB 原文");
        assert.ok(!/A{512,}/.test(stripped), "base64 本体没留下");
        const small = logs.stripInlineDataUrls('{"u":"data:image/png;base64,' + "A".repeat(100) + '"}');
        assert.ok(small.includes("A".repeat(100)), "短 base64 不该被误伤");
        const plain = logs.stripInlineDataUrls('{"text":"data: 这个词单独出现不该被动"}');
        assert.ok(plain.includes("data: 这个词"), "非内联形态原样保留");
      }
      // 17) 真目录布局：文件名是身份、目录是分类；用户在资源管理器里动手都有兜底。
      {
        const layout = await import("../src/media/media-layout.ts");
        const mediaMod = await import("../src/media/media.ts");
        const { join: pjoin } = await import("node:path");
        assert.strictEqual(layout.EMOTE_ROOT, "表情包", "表情根目录名与界面同词");
        // 新落盘的图进 图片/，URL 仍是 /media/<名字>——身份不带目录，挪动不用改任何引用。
        const img = media.saveImage(TINY_PNG, "image/png");
        const imgRow = assetsMod.getAssetByUrl(img.url);
        assert.ok(imgRow.relPath.startsWith("图片/"), "非表情图片落 图片/");
        assert.ok(existsSync(pjoin(mediaMod.mediaDir(), imgRow.relPath)), "rel_path 指的就是盘上真身");
        // 打标 = 文件跟着归属走。
        assetsMod.markEmote(img.url, { label: "搬家测试" });
        const marked = assetsMod.getAssetByUrl(img.url);
        assert.ok(marked.relPath.startsWith("表情包/默认/"), "勾成表情就搬进 表情包/默认/");
        assert.ok(existsSync(pjoin(mediaMod.mediaDir(), marked.relPath)), "搬完 rel_path 跟着记");
        assert.strictEqual(marked.url, img.url, "URL 不因搬家而变");
        assert.ok(mediaMod.readMedia(img.url) !== null, "旧地址照常读得到文件");
        // 改归属 → 磁盘目录跟着改。
        assetsMod.applyEmoteSemantics(img.url, { pack: ["搬家测试"] });
        assert.ok(assetsMod.getAssetByUrl(img.url).relPath === "表情包/搬家测试/" + img.url.slice(7),
          "弹窗改文件夹＝文件挪进新目录");
        // 摘掉标记 → 搬出 表情包/（那个目录里只有表情）。
        assetsMod.setEmoteMark(img.url, false);
        assert.ok(assetsMod.getAssetByUrl(img.url).relPath.startsWith("图片/"), "摘掉标记搬回 图片/");
        // 导入直接落进 表情包/<源文件夹名>/。
        const imp = assetsMod.listEmoteAssets().find((a) => a.emotePack[0] === srcBase);
        assert.ok(imp !== undefined && imp.relPath.startsWith("表情包/" + srcBase + "/"),
          "导入的文件就在以源文件夹命名的目录里");
        // 用户往 表情包/ 丢新文件 → 对账按位置认领成表情、文件夹=目录名。
        const dropDir = pjoin(mediaMod.mediaDir(), "表情包", "语录新");
        mkdirSync(dropDir, { recursive: true });
        const dropBuf = Buffer.from("47494638376101000100800000FFFFFF00000021F90401000000002C00000000010001000002024401003B", "hex");
        writeFileSync(pjoin(dropDir, "老板英明.gif"), dropBuf);
        mediaMod.reconcileAssets();
        const adopted = assetsMod.getAssetByUrl("/media/老板英明.gif");
        assert.ok(adopted !== null && adopted.usableAsEmote && adopted.emotePack[0] === "语录新",
          "丢进 表情包/<X>/ 的文件自动认领成表情、文件夹=X");
        // 用户把文件挪去别的文件夹 → 库跟盘：改地址、归属跟着目录走。
        {
          const to2 = pjoin(mediaMod.mediaDir(), "表情包", "语录新2");
          mkdirSync(to2, { recursive: true });
          renameSync(pjoin(dropDir, "老板英明.gif"), pjoin(to2, "老板英明.gif"));
          mediaMod.reconcileAssets();
          const movedRow = assetsMod.getAssetByUrl("/media/老板英明.gif");
          assert.strictEqual(movedRow.relPath, "表情包/语录新2/老板英明.gif", "挪动被认成搬家，地址改过来");
          assert.strictEqual(movedRow.emotePack[0], "语录新2", "盘是最新动作：文件夹跟着目录走");
        }
        // 用户改名 → 按哈希救回身份：行还活着，不标失效、也不登记成第二张重复表情。
        {
          const to2 = pjoin(mediaMod.mediaDir(), "表情包", "语录新2");
          renameSync(pjoin(to2, "老板英明.gif"), pjoin(to2, "改名了.gif"));
          mediaMod.reconcileAssets();
          const renamed = assetsMod.getAssetByUrl("/media/老板英明.gif");
          assert.ok(renamed !== null && !renamed.missing, "改名后行还活着（哈希救回身份）");
          assert.strictEqual(renamed.relPath, "表情包/语录新2/改名了.gif", "地址指到改名后的真身");
          assert.strictEqual(assetsMod.getAssetByUrl("/media/改名了.gif"), null, "不会又登记出一张重复表情");
        }
        // 删除 → 失效三件套：行保留、检索排除、发送拒因说人话；放回即复活。
        {
          rmSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新2", "改名了.gif"), { force: true });
          mediaMod.reconcileAssets();
          const goneRow = assetsMod.getAssetByUrl("/media/老板英明.gif");
          assert.ok(goneRow !== null && goneRow.missing, "表情行不静默删，标「已失效」");
          assert.ok(assetsMod.assetStats().broken >= 1, "失效数进统计");
          assert.ok(!search.searchEmotes("老板英明", 10).some((h) => h.asset.url === "/media/老板英明.gif"),
            "失效行退出检索");
          const failSend = await executeTool("send_emote", JSON.stringify({ emote_id: goneRow.id }), freshCtx());
          assert.ok(String(failSend.result?.error ?? "").includes("已失效"), "按 id 硬发要报「已失效」：" + JSON.stringify(failSend));
          writeFileSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新2", "改名了.gif"), dropBuf);
          mediaMod.reconcileAssets();
          assert.ok(!assetsMod.getAssetByUrl("/media/老板英明.gif").missing, "文件放回即复活，什么都不用点");
          // 清理失效项：用户在磁盘删了之后能手动收掉死账；文件还在的行删不动。
          {
            const aliveRow = assetsMod.getAssetByUrl("/media/老板英明.gif");
            assert.strictEqual(assetsMod.dropMissingAsset(aliveRow.id), false, "非失效行删不动——删除走回收站那条线");
            // 就地验真：文件在盘上返回 false 不动数据；文件没了返回 true 并当场标失效。
            assert.strictEqual(assetsMod.markMissingIfGone(aliveRow.id), false, "文件还在盘上，验真不该动它");
            assert.strictEqual(assetsMod.getAssetById(aliveRow.id).missing, false, "验真失败不该顺手标失效");
            rmSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新2", "改名了.gif"), { force: true });
            assert.strictEqual(assetsMod.markMissingIfGone(aliveRow.id), true, "文件没了，验真当场认定失效");
            assert.strictEqual(assetsMod.getAssetById(aliveRow.id).missing, true, "不用等对账，标记已经写上");
            assert.strictEqual(assetsMod.dropMissingAsset(aliveRow.id), true, "失效行可清理");
            assert.strictEqual(assetsMod.getAssetByUrl("/media/老板英明.gif"), null, "清理后行没了");
            writeFileSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新2", "改名了.gif"), dropBuf);
            mediaMod.reconcileAssets();
            assert.ok(assetsMod.getAssetByUrl("/media/改名了.gif") !== null, "放回的文件会被重新登记（当成新图认领）");
          }
        }
        // 重复拷贝 → 不登记成第二张，计入对账报告的 dupIgnored。
        // 用**另一个文件名**拷：同名文件会被 seenNames 当身份碰撞处理，测的就不是哈希去重了。
        {
          const before = assetsMod.listAssets({ view: "all", limit: 2000, offset: 0 }).total;
          mkdirSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新3"), { recursive: true });
          copyFileSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新2", "改名了.gif"),
            pjoin(mediaMod.mediaDir(), "表情包", "语录新3", "另一份.gif"));
          const rep = mediaMod.reconcileAssets();
          assert.ok(rep.dupIgnored >= 1, "哈希撞上已有行的文件被忽略并计数");
          assert.strictEqual(assetsMod.listAssets({ view: "all", limit: 2000, offset: 0 }).total, before,
            "重复文件不会多登记一行");
          assert.strictEqual(assetsMod.getAssetByUrl("/media/另一份.gif"), null, "重复的那份没有入账");
          rmSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新3"), { recursive: true, force: true });
        }
        // 散放在 表情包/ 根下的图＝默认文件夹：自动挪进 表情包/默认/ 并认领成表情。
        {
          const rootBuf = Buffer.from("47494638376101000100800000FFFFFF00000021F90401000000002C0000000001000100000202" + "4501003B", "hex");
          writeFileSync(pjoin(mediaMod.mediaDir(), "表情包", "根下散图.gif"), rootBuf);
          mediaMod.reconcileAssets();
          const loose = assetsMod.getAssetByUrl("/media/根下散图.gif");
          assert.ok(loose !== null && loose.usableAsEmote && loose.emotePack[0] === "默认",
            "根下散图被认领成表情并归入默认文件夹");
          assert.strictEqual(loose.relPath, "表情包/默认/根下散图.gif", "文件也被挪进了 表情包/默认/");
          assert.ok(existsSync(pjoin(mediaMod.mediaDir(), "表情包", "默认", "根下散图.gif"))
            && !existsSync(pjoin(mediaMod.mediaDir(), "表情包", "根下散图.gif")), "盘上位置与库一致");
          rmSync(pjoin(mediaMod.mediaDir(), "表情包", "默认", "根下散图.gif"), { force: true });
        }
        // 一次性迁移：遗留平铺行归位，幂等，先备份。
        {
          const legacyName = "aaaaaaaaaaaaaaaa.png";
          writeFileSync(pjoin(mediaMod.mediaDir(), legacyName), TINY_PNG);
          assetsMod.registerAsset({ id: "aaaaaaaaaaaaaaaa", url: "/media/" + legacyName, kind: "image", mime: "image/png", bytes: TINY_PNG.length });
          assert.strictEqual(assetsMod.getAssetByUrl("/media/" + legacyName).relPath, "", "遗留行没有位置记录");
          const mig = layout.migrateMediaLayout();
          assert.ok(mig.moved >= 1 && existsSync(pjoin(mediaMod.mediaDir(), "图片", legacyName)), "遗留平铺文件被迁进类型目录");
          assert.ok(mig.backup !== "" && existsSync(mig.backup), "迁移前先落一份库备份");
          assert.strictEqual(layout.migrateMediaLayout().moved, 0, "第二次是 no-op（kv 标记）");
          assert.ok(assetsMod.getAssetByUrl("/media/" + legacyName).relPath === "图片/" + legacyName, "迁移把 rel_path 记好");
        }
        // 全库不变量：表情都在 表情包/ 下，非表情都在类型目录或遗留平铺。
        for (const r of assetsMod.listEmoteAssets()) {
          assert.ok(r.relPath.startsWith("表情包/"), "表情文件必在 表情包/ 下：" + r.relPath);
        }
        rmSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新"), { recursive: true, force: true });
        rmSync(pjoin(mediaMod.mediaDir(), "表情包", "语录新2"), { recursive: true, force: true });
      }
      // 18) 接收闭环：OneBot 收进来的表情必须当场落盘（CSP 只认 'self'，协议端的 CDN 签名地址
      //     在前端渲染不出来），表情段解析成具体表情、认不出才留「[表情]」占位（纯表情消息
      //     不再在空正文闸门处蒸发），裸文件名走 get_image 换字节，采集按内容去重。
      {
        const onebot = await import("../src/channels/qq-onebot.ts");
        const httpMod = await import("node:http");
        const OB_ALT = Buffer.concat([TINY_PNG, Buffer.from([1, 2, 3, 4])]); // 与前面所有素材内容都不重
        // 假协议端：/get_image 两种兑现形态（base64:// 与 url），/real.png 直接给图。
        const server = httpMod.createServer((req, res) => {
          let raw = "";
          req.on("data", (c) => { raw += c; });
          req.on("end", () => {
            const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
            if (req.url === "/get_image") {
              let id = "";
              try { id = String(JSON.parse(raw || "{}").file_id ?? ""); } catch { /* 坏报文按未知处理 */ }
              if (id === "b64.png") return json({ status: "ok", retcode: 0, data: { base64: "base64://" + OB_ALT.toString("base64") } });
              if (id === "net.png") return json({ status: "ok", retcode: 0, data: { url: `http://127.0.0.1:${server.address().port}/real.png` } });
              return json({ status: "failed", retcode: 14001001, msg: "failed to fetch image" });
            }
            if (req.url === "/real.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(OB_ALT); return; }
            res.writeHead(404); res.end();
          });
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const obPort = server.address().port;
        onebot.applyOnebotSettings({ httpBase: `http://127.0.0.1:${obPort}`, wsUrl: "", token: "" });
        const sameDir = mkdtempSync(join(tmpdir(), `ob-in-${backend}-`));
        // 表情库基线（块 3 之后采集开关一直开着，后面每条图片路径都可能触到采集，用基线差值断言）。
        const obEmoteBase = assetsMod.listEmoteAssets().length;
        try {
          writeFileSync(join(sameDir, "同机图.png"), OB_ALT);
          // a) 入站表情要**解析**，不是一律压成「[表情]」：按 id 查表、取 summary，
          //    认不出来才留占位——纯表情消息不许被「text 为空就 return」的闸丢掉。
          assert.strictEqual(onebot.obInboundText([{ type: "face", data: { id: "14" } }]), "[微笑]🙂", "face 段按 QFace 全量表解析成表情名+emoji");
          assert.strictEqual(onebot.obInboundText([{ type: "text", data: { text: "早" } }, { type: "mface", data: { summary: "[微笑]" } }]), "早[微笑]", "文字后面的 mface 取 summary");
          assert.strictEqual(onebot.obInboundText("[CQ:face,id=14]好"), "[微笑]🙂好", "字符串消息的 CQ 码同样解析");
          assert.strictEqual(onebot.obInboundText("[CQ:mface,summary=&#91;微笑&#93;]"), "[微笑]", "CQ 码里被转义的方括号要还原");
          assert.strictEqual(onebot.obInboundText([{ type: "image", data: { summary: "[搓手]", url: "https://gxh.vip.qq.com/a.gif" } }]), "[搓手]", "image 段的表情名补进正文");
          assert.strictEqual(onebot.obInboundText([{ type: "image", data: { summary: "[图片]" } }]), "", "通用「[图片]」占位不进正文");
          assert.strictEqual(onebot.obInboundText([{ type: "face", data: { id: "9999" } }]), "[表情]", "认不出的 face id 仍留占位，不蒸发");
          assert.strictEqual(onebot.obInboundText([{ type: "mface", data: { emoji_id: "x" } }]), "[表情]", "mface 没给 summary 也留占位");
          // b) 段归型：裸文件名 / 完整 URL / 同机路径各归各字段，at 段不算媒体。
          const parsed = onebot.obInboundSegments([
            { type: "image", data: { file: "abcd.png", url: "https://cdn.qq.com/abcd.png?sign=1" } },
            { type: "record", data: { file: "https://cdn.qq.com/a.wav" } },
            { type: "image", data: { path: "C:\\napcat\\images\\x.png" } },
            { type: "mface", data: { summary: "动图", origin_url: "https://cdn.qq.com/m.gif" } },
            { type: "at", data: { qq: "123" } },
          ]);
          assert.strictEqual(parsed.length, 4, "at 段不进媒体列表");
          assert.strictEqual(parsed[0].url, "https://cdn.qq.com/abcd.png?sign=1", "给了 url 就用 url");
          assert.strictEqual(parsed[1].url, "https://cdn.qq.com/a.wav", "file 字段里的裸 URL 归进 url");
          assert.strictEqual(parsed[2].path, "C:\\napcat\\images\\x.png", "同机路径单列");
          assert.strictEqual(parsed[3].kind, "image", "有原图地址的 mface 按图片收");
          // c) 落盘四路：同机 path → http url 直取 → get_image 回 base64 → get_image 回 URL。
          const m1 = await onebot.obMaterializeMedia([{ type: "image", data: { file: "同机图.png", path: join(sameDir, "同机图.png") } }]);
          assert.strictEqual(m1.urls.length, 1, "同机路径直读落盘");
          assert.ok(m1.urls[0].startsWith("/media/"), "落盘后是本地地址：" + m1.urls[0]);
          assert.strictEqual(m1.meta[0].kind, "image", "类型归图片");
          const m2 = await onebot.obMaterializeMedia([{ type: "image", data: { url: `http://127.0.0.1:${obPort}/real.png` } }]);
          assert.strictEqual(m2.urls.length, 1, "http 地址直取落盘");
          const m3 = await onebot.obMaterializeMedia([{ type: "image", data: { file: "b64.png" } }]);
          assert.strictEqual(m3.urls.length, 1, "裸文件名经 get_image 拿回字节");
          const m4 = await onebot.obMaterializeMedia([{ type: "image", data: { file: "net.png" } }]);
          assert.strictEqual(m4.urls.length, 1, "get_image 换回 URL 也照样取");
          // 语音段落盘后归 audio——标成 image 的话，语音条在前端渲染成裂图。
          const wav = Buffer.alloc(44);
          wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVE", 8);
          wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
          wav.write("data", 36); wav.writeUInt32LE(2, 40);
          const wavFile = join(sameDir, "一条语音.wav");
          writeFileSync(wavFile, Buffer.concat([wav, Buffer.from([0, 0])]));
          const m5 = await onebot.obMaterializeMedia([{ type: "record", data: { path: wavFile } }]);
          assert.strictEqual(m5.meta[0]?.kind, "audio", "record 段归 audio：" + JSON.stringify(m5.meta));
          // d) 采集去重贯穿到落盘链：六条同内容路径只让表情库 +1（开关在块 3 已开）。
          const m6 = await onebot.obMaterializeMedia([
            { type: "file", data: { file: "同事发来的同名图.png", path: join(sameDir, "同机图.png") } },
            { type: "image", data: { file: "b64.png" } },
          ]);
          assert.strictEqual(m6.urls.length, 2, "展示用各存一份（消息里两张都在）");
          assert.strictEqual(m6.meta[0].kind, "image", "file 段装着图片按图片归");
          assert.strictEqual(assetsMod.listEmoteAssets().length, obEmoteBase + 1, "同内容进表情库只进一次（m1 那次）");
          // e) 坏引用只跳自己：取不到字节不抛错、不吞整条消息。
          const m7 = await onebot.obMaterializeMedia([
            { type: "image", data: { file: "unknown.png" } },
            { type: "image", data: { path: "Z:\\nowhere\\nothing.png" } },
          ]);
          assert.strictEqual(m7.urls.length, 0, "换不到地址的跳过，落得下的照常");
          assert.strictEqual(m7.meta.length, 0, "跳过的不产生半条元信息");
          // f) 延时补名排了队但不立刻跑（防抖），撤掉后无事发生。
          const namingLate = await import("../src/emote/emote-naming.ts");
          assert.strictEqual(namingLate.namingJobStatus().running, false, "采集只排期，不抢跑");
          namingLate.cancelCaptureNaming();
        } finally {
          server.close();
          rmSync(sameDir, { recursive: true, force: true });
        }
      }
      rmSync(srcDir, { recursive: true, force: true });
    }
    console.log(`表情回归（${backend}）：全部通过`);
  };
  run().catch((error) => {
    console.error(`表情回归（${process.env.QQ_BACKEND ?? "official"}）失败：`, error);
    process.exit(1);
  });
} else {
  // ── 父进程：起 official / onebot 两个子进程，都绿才算过 ─────────
  const base = process.env;
  // 媒体目录和库一起清，且必须在 spawn **之前**清：上一轮父进程若中途崩掉，
  // 子进程会变成孤儿继续写库写盘——只在收尾清理的话，下一轮读到的就是上一轮的尸体
  // （实测「空库起步」读到 3 张残留表情）。Windows 上句柄释放有延迟，rm -rf 撞 ENOTEMPTY 要重试。
  const rmdirRetry = (dir) => {
    for (let i = 0; i < 8; i += 1) {
      try { rmSync(dir, { recursive: true, force: true }); return; }
      catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); }
    }
  };
  const cleanRunState = () => {
    for (const file of ["emote-regression-official.db", "emote-regression-onebot.db"]) {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`./data/${file}${suffix}`)) rmSync(`./data/${file}${suffix}`, { force: true });
    }
    for (const dir of ["./data/emote-media-official", "./data/emote-media-onebot"]) rmdirRetry(dir);
  };
  cleanRunState();
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
  cleanRunState();
  const failed = codes.filter((c) => c !== 0).length;
  if (failed > 0) {
    console.error(`表情回归：${failed} 个渠道进程失败（official/onebot 各跑一遍）`);
    process.exit(1);
  }
  console.log("表情回归（official + onebot）：全部通过");
}
