/**
 * 资产注册表回归测试。
 *
 * 覆盖的是那张表的四条不变量，它们是整个「一个页面、三个视角」的地基：
 *   1. 落盘即登记：任何 save* 之后库里立刻有行，调用方没有忘记登记的余地；
 *   2. 对账补溯源：source / contact_id / ref_count / duration_ms 由引用扫描落进表里，
 *      且只往上认领、不覆盖已经明确的信息；
 *   3. 盘上消失即销账：文件没了（清理、删作品、换壁纸）行也跟着没，不需要每条路径各自记得；
 *   4. 统一读视图：视角是参数不是功能，联系人是筛选不是身份，计数不受当前筛选影响。
 *
 * 运行：node --experimental-sqlite scripts/assets-regression.test.mjs
 * （独立 DB 与媒体目录，见 package.json 的 test:assets）
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 自带隔离：不靠调用方传 env（裸跑时会写进开发库），也不留上一次的库——
// 下面的计数断言（「表情包」正好两张）只有在干净库上才成立。
process.env.DB_PATH ??= "./data/assets-regression.db";
process.env.MEDIA_DIR ??= "./data/assets-regression-media";
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/assets-regression.db${suffix}`, { force: true });
rmSync("data/assets-regression-media", { recursive: true, force: true });

const TINY_PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489" +
  "0000000D49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);
/** 一段合法的 RIFF/WAVE 头 + 一点数据，够 sniffAudioMime 认出来、wavDurationMs 算出时长。 */
function tinyWav(ms) {
  const byteRate = 8000;
  const dataBytes = Math.round((ms / 1000) * byteRate);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + dataBytes, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(byteRate, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write("data", 36);
  head.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([head, Buffer.alloc(dataBytes, 0x40)]);
}

const { db } = await import("../src/db.ts");
// 引用扫描会读 artifacts 表，而那张表是 artifacts.ts 被 import 时才建的（应用里由路由链带到，
// 测试里没有）——不 import 它，对账会直接报「no such table」。
await import("../src/artifacts.ts");
const media = await import("../src/media.ts");
const assets = await import("../src/assets.ts");
const { createContact } = await import("../src/contacts.ts");

// ── 1) 落盘即登记 ──────────────────────────────────────────────────────
const saved = media.saveImage(TINY_PNG, "image/png");
const row = assets.getAssetByUrl(saved.url);
assert.ok(row !== null, "saveImage 之后库里就有这一行（不需要调用方登记）");
assert.strictEqual(row.kind, "image", "类型由落盘函数给");
assert.strictEqual(row.mime, "image/png", "mime 记下来了");
assert.strictEqual(row.bytes, TINY_PNG.length, "字节数记下来了");
assert.strictEqual(row.hash.length, 32, "内容哈希是 md5 的形状");
assert.strictEqual(row.source, "unclaimed", "来源先留空，等认领或对账——但存在性已经保证了");

const wp = media.saveWallpaper(TINY_PNG, "image/png");
assert.strictEqual(assets.getAssetByUrl(wp.url)?.source, "wallpaper", "壁纸的 wp 前缀就是它的身份，不用等认领");

// 音频：时长还没有（它来自消息元信息，不是文件本身），对账之后才该有。
const wav = media.saveAudio(tinyWav(3000));
assert.strictEqual(assets.getAssetByUrl(wav.url)?.kind, "audio", "语音登记成 audio");
assert.strictEqual(assets.getAssetByUrl(wav.url)?.durationMs, undefined, "落盘时不该有时长");

// ── 2) 对账补溯源 ──────────────────────────────────────────────────────
const contact = createContact({ name: "对账测试" });
const msg = db.prepare(
  "INSERT INTO messages (channel, role, text, kind, created_at, contact_id, attachments, attachment_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
).run(
  "web", "assistant", "给你听一段", "chat", Date.now(), contact.id,
  JSON.stringify([wav.url]),
  JSON.stringify([{ url: wav.url, kind: "audio", durationMs: 3000, transcript: "晚上好呀", waveform: [1, 2, 3] }]),
);
const messageId = Number(msg.lastInsertRowid);
const first = media.reconcileAssets();
assert.ok(first.registered >= 0, "对账跑得下来");
const afterSync = assets.getAssetByUrl(wav.url);
assert.strictEqual(afterSync?.source, "chat", "被消息引用之后，来源认领成 chat");
assert.strictEqual(afterSync?.contactId, contact.id, "归属联系人是 id，不是给人看的名字");
assert.ok((afterSync?.refCount ?? 0) >= 1, "引用计数落进表里，界面不用每次扫库");
assert.strictEqual(afterSync?.durationMs, 3000, "语音时长由对账补齐");

// 只往上认领，不覆盖已经确定的事实：壁纸不该因为出现在 kv 里就被改写成「本地设置」。
const wpBefore = assets.getAssetByUrl(wp.url)?.source;
db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("asset.probe", "无关字符串");
media.reconcileAssets();
assert.strictEqual(assets.getAssetByUrl(wp.url)?.source, wpBefore, "已确定的来源不被事后推断冲掉");

// ── 3) 盘上消失即销账 ──────────────────────────────────────────────────
const gone = media.saveImage(TINY_PNG, "image/png");
const goneRow = assets.getAssetByUrl(gone.url);
assert.ok(goneRow !== null, "先确认登记上了");
assert.ok(goneRow.relPath.startsWith("图片/"), "新落盘的图按类型进 图片/ 目录（文件名仍是身份，URL 不带目录）");
rmSync(join(media.mediaDir(), goneRow.relPath), { force: true });
const third = media.reconcileAssets();
assert.ok(third.pruned >= 1, "文件从盘上没了，对账把行也销掉");
assert.strictEqual(assets.getAssetByUrl(gone.url), null, "销账之后查不到这条资产");

// ── 4) 统一读视图 ──────────────────────────────────────────────────────
// 用真实落盘的图：对账会把「盘上已经没有」的行销掉，捏出来的 url 撑不起后面的断言。
const emote1 = media.saveImage(TINY_PNG, "image/png").url;
const emote2 = media.saveImage(TINY_PNG, "image/gif").url;
assets.markEmote(emote1, { label: "大笑", tags: ["哈", "笑死"] });
assets.markEmote(emote2, { label: "哭" });
// 新门反证：语义字段写成老调用形状（字符串当 patch）必须**响亮地炸**，不能静默写空。
// 不挡的话库里那一行照样存在、标记照样打上，只是名字标签全没了——测试一片绿，检索再也找不到它。
assert.throws(() => assets.markEmote(emote1, "大笑", ["哈"]), TypeError, "老调用形状要报 TypeError");
assert.throws(() => assets.applyEmoteSemantics(emote1, ["哈"]), TypeError, "数组也不是 patch");
assert.strictEqual(assets.getAssetByUrl(emote1)?.emoteLabel, "大笑", "被拒的那次写什么都没改掉（先判后写）");
const row1 = assets.getAssetByUrl(emote1);
const row2 = assets.getAssetByUrl(emote2);
assert.ok(row1 !== null && row2 !== null, "两张素材都在库里");
assets.setStarred(row1.id, true);

const all = assets.listAssets({ limit: 50, offset: 0 });
assert.ok(all.counts.all >= 4, "全部视角看得见所有资产");
assert.strictEqual(all.counts.emote, 2, "「表情包」正好两张");
assert.strictEqual(all.counts.starred, 1, "收藏一张");
assert.ok(all.counts.all === assets.listAssets({ view: "emote", limit: 50, offset: 0 }).counts.all, "计数不受当前视角影响");

const gif = assets.listAssets({ kind: "gif", limit: 50, offset: 0 });
assert.strictEqual(gif.items.length, 0, "没有 gif 这种类型（是 image + 扩展名）");
const images = assets.listAssets({ kind: "image", limit: 50, offset: 0 });
assert.ok(images.items.every((a) => a.kind === "image"), "类型筛选干净");
assert.ok(images.total === images.items.length, "total 与结果集口径一致");

const byWord = assets.listAssets({ q: "笑死", limit: 50, offset: 0 });
assert.strictEqual(byWord.items.length, 1, "按标签能搜到那一张");
assert.strictEqual(byWord.items[0].url, emote1, "搜到的就是它");
const byNothing = assets.listAssets({ q: "根本没有这个词", limit: 50, offset: 0 });
assert.strictEqual(byNothing.total, 0, "搜不到就是 0，不返回全量");

const scoped = assets.listAssets({ contactId: contact.id, limit: 50, offset: 0 });
assert.ok(scoped.items.every((a) => a.contactId === contact.id), "联系人视角只看他的");
assert.ok(!scoped.items.some((a) => a.url === emote1), "全局导入的素材不混进联系人视角");

// ── 5) 表情标记就是资产上的一个属性 ────────────────────────────────────
const marked = assets.listAssets({ view: "emote", limit: 50, offset: 0 });
assert.ok(marked.items.some((a) => a.url === emote1 && a.emoteLabel === "大笑"), "标记带着名字与标签存在同一行");
assert.deepEqual(marked.items.find((a) => a.url === emote1)?.emoteTags, ["哈", "笑死"], "标签原样存回来");
assets.unmarkEmote(emote2);
assert.strictEqual(assets.listAssets({ view: "emote", limit: 50, offset: 0 }).counts.emote, 1, "摘掉标记少一张");
assert.ok(assets.getAssetByUrl(emote2) !== null, "摘标记不删资产——文件还在，别人可能还在用");

// ── 6) 展示字段联表现取，不复制进资产表 ────────────────────────────────
const page = assets.listAssets({ contactId: contact.id, limit: 50, offset: 0 });
const voice = page.items.find((a) => a.url === wav.url);
assert.ok(voice !== undefined, "语音出现在它所属联系人的视角里");
assert.strictEqual(voice.originMessageId, messageId, "出处消息 id 由对账记下来");
assert.strictEqual(voice.detail.transcript, "晚上好呀", "转写从消息联表现取");
assert.deepEqual(voice.detail.waveform, [1, 2, 3], "波形同上");
assert.strictEqual(voice.detail.originText, "给你听一段", "出处消息的文字带着，界面能显示上下文");

db.prepare(
  "INSERT INTO artifacts (id, contact_id, url, prompt, shape, with_reference, starred, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
).run("art-1", contact.id, emote1, "雨夜窗边的猫", "1024x1024", 1, 0, Date.now());
media.reconcileAssets();
const withArt = assets.listAssets({ limit: 50, offset: 0 }).items.find((a) => a.url === emote1);
assert.strictEqual(withArt?.detail.prompt, "雨夜窗边的猫", "作品提示词联表带出来");
assert.strictEqual(withArt?.detail.artifactId, "art-1", "作品 id 带着，界面才能走作品动作");
assert.strictEqual(withArt?.detail.withReference, true, "带参考标记如实传");
assert.strictEqual(withArt?.detail.shape, "1024x1024", "形状来自作品台账");
// 反证：资产表里不该多出这些列——它们只存在于各自的原表。
const columns = db.prepare("PRAGMA table_info(assets)").all().map((c) => String(c.name));
assert.ok(!columns.includes("prompt") && !columns.includes("transcript"), "展示字段没有被抄一份进资产表");

// ── 7) 表情标记与收藏本身就是引用：只被表情库认领的梗图绝不能被清理 ─────────
// 表情标记从前住在 kv 的 blob 里，由引用扫描的 kv 那一路顺带认到；搬进 assets 表之后
// 那一路就看不见它了——不补这一条，「导入但还没在对话里用过」的表情会被判成未引用删掉。
const sticker = media.saveImage(TINY_PNG, "image/png").url;
assets.markEmote(sticker, { label: "接梗", tags: ["梗"] });
media.reconcileAssets();
const stickerItem = media.scanOrphanMedia(0).all.find((m) => m.url === sticker);
assert.ok(stickerItem !== undefined, "扫描看得见这张图");
assert.strictEqual(stickerItem.referenced, true, "表情标记本身就是引用");
assert.strictEqual(stickerItem.cleanable, false, "只被表情库认领的梗图不可清理");
assets.unmarkEmote(sticker);
media.reconcileAssets();
const unmarked = media.scanOrphanMedia(0).all.find((m) => m.url === sticker);
assert.strictEqual(unmarked?.referenced, false, "摘掉标记且无人引用，这才算未引用");
assert.strictEqual(unmarked?.cleanable, true, "到这一步清理通道才该把它提出来");

const fav = media.saveImage(TINY_PNG, "image/png").url;
const favRow = assets.getAssetByUrl(fav);
assets.setStarred(favRow.id, true);
media.reconcileAssets();
assert.strictEqual(media.scanOrphanMedia(0).all.find((m) => m.url === fav)?.cleanable, false, "收藏过的同样不该被清掉");

// ── 8) 派生形态：静帧挂在父资产下、不进媒体库、父没了跟着清 ───────────────
const rend = await import("../src/renditions.ts");
assert.strictEqual(rend.needsStaticVariant("/media/x.gif"), true, "gif 要派生静帧");
for (const u of ["/media/x.png", "/media/x.jpg", "/media/x.webp", "/media/x.mp4"]) {
  assert.strictEqual(rend.needsStaticVariant(u), false, `这种格式不用派生：${u}`);
}
// 夹具是一张真正的 GIF87a（43 字节，sharp 认得）。别拿 png 的字节配 .gif 的文件名——
// sharp 按扩展名选解码器，那样读出来是 libpng read error，测的就不是这条路径了。
const TINY_GIF = Buffer.from("47494638376101000100800000FFFFFF00000021F90401000000002C00000000010001000002024401003B", "hex");
const gifName = "00000000000000ab.gif";
writeFileSync(join(media.mediaDir(), gifName), TINY_GIF);
const gifUrl = "/media/" + gifName;
assets.registerAsset({ id: gifName.replace(".gif", ""), url: gifUrl, kind: "image", mime: "image/gif", bytes: TINY_GIF.length, source: "imported" });
const totalBefore = assets.assetStats().total;
const bytesBefore = assets.assetStats().bytes;
const still = await rend.staticFrameOf(gifUrl);
assert.ok(still !== null && still.endsWith(".png"), "派生出一张 png");
const child = assets.getAssetByUrl(still);
assert.strictEqual(child?.parentId, gifName.replace(".gif", ""), "静帧挂在动图下");
assert.strictEqual(child?.mime, "image/png", "派生文件自己也记了元数据");
assert.strictEqual(assets.assetStats().total, totalBefore, "派生形态不增加用户资产条数");
assert.ok(assets.assetStats().bytes > bytesBefore, "但它占的盘要算进存储");
assert.ok(!assets.listAssets({ limit: 100, offset: 0 }).items.some((a) => a.url === still), "派生形态不出现在媒体库里");
assert.strictEqual(await rend.staticFrameOf(gifUrl), still, "同一份动图只派生一次");
// 自检：派生出来必须是单帧。曾经 { animated: true } 会交出整条竖排长图，发出去就是坏图。
const stillMeta = await (await import("sharp")).default(
  (await import("node:fs")).readFileSync(join(media.mediaDir(), still.slice("/media/".length))),
).metadata();
assert.ok((stillMeta.pages ?? 1) === 1, "派生出来的静帧必须是单帧");
rmSync(join(media.mediaDir(), gifName), { force: true });
media.reconcileAssets();
assert.strictEqual(assets.getAssetByUrl(still), null, "父资产没了，静帧的行跟着销账");
assert.strictEqual(media.mediaAbsPath(still), null, "静帧文件本身也从盘上收掉");

console.log("资产注册表回归：全部通过");
