// 派生形态：一份原图 + 按渠道能力准备好的替代形态。
//
// 为什么不是「发送时躲开动图」：那样用户库里的动图永远甩不出去，用户只能看着，
// 而挑选逻辑还得替每个渠道记一遍「这个格式对端收不收」。
// 成熟做法都是入库时派生、发送时按能力挑形态——WhatsApp 把贴纸重编码成 512×512 WebP，
// Telegram 强制一边 512px，微信表情平台要 240×240。问题在派生期暴露，
// 而不是在联系人甩表情那一刻变成一条 850019。
//
// 目前只派生一种：动图的静帧。官方 Bot 的富媒体只收 png/jpg，GIF 会被回
// 850019「富媒体文件格式不支持」，而静帧是它一定收的形态。

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { db } from "./db.ts";
import { mediaAbsPath } from "./media.ts";
import { currentFileOf, ensureDir, nativePath } from "./media-layout.ts";
import { registerAsset } from "./assets.ts";

/**
 * sharp 只在真要派生时才加载。
 *
 * 两个原因：一是它带原生二进制（libvips），桌面端打包目前还没把它 staged 进 sidecar 资源，
 * 顶层 import 会让整个后端在打包产物里起不来；二是派生不出来并不致命——
 * 调用方拿 null 就按原图发，行为退回「官方渠道发不了 GIF 会如实失败」，不会连带别的功能。
 * 打包侧的收尾（把 sharp 的 node_modules 与平台二进制 stage 进 resources）见项目记录。
 */
type SharpPipe = {
  png: () => SharpPipe;
  extract: (region: { left: number; top: number; width: number; height: number }) => SharpPipe;
  resize: (opts: { width?: number; height?: number; withoutEnlargement?: boolean }) => SharpPipe;
  metadata: () => Promise<{ width?: number; height?: number; pages?: number }>;
  toBuffer: () => Promise<Buffer>;
};
type SharpFn = (input: Buffer, options?: Record<string, unknown>) => SharpPipe;
let sharpLoader: Promise<SharpFn | null> | null = null;
async function loadSharp(): Promise<SharpFn | null> {
  if (sharpLoader === null) {
    sharpLoader = import("sharp").then((m) => (m.default ?? m) as unknown as SharpFn).catch(() => null);
  }
  const fn = await sharpLoader;
  return typeof fn === "function" ? fn : null;
}

/** sharp 现在到底能不能用（界面据此决定「智能识别」这颗按钮要不要提示动图限制）。 */
export async function sharpAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null;
}

/** 这份父资产已经派生过、且派生文件还在盘上吗？在就给它的 url。 */
function existingVariant(parentId: string): string | null {
  const rows = db.prepare("SELECT url FROM assets WHERE parent_id = ? ORDER BY created_at ASC")
    .all(parentId) as Array<{ url: string }>;
  for (const row of rows) {
    if (mediaAbsPath(row.url) !== null) return row.url;
  }
  return null;
}

/**
 * 取动图的第一帧，落成一张 png 并挂在父资产下。
 * 返回 null 表示派生不出来（文件不在盘上、或解码失败）——调用方按原样发，
 * 让平台的错误如实浮出来，比我们假装成功好。
 */
export async function staticFrameOf(url: string): Promise<string | null> {
  const parent = db.prepare("SELECT id FROM assets WHERE url = ?").get(url) as { id: string } | undefined;
  if (parent === undefined) return null;
  const done = existingVariant(parent.id);
  if (done !== null) return done;
  const abs = mediaAbsPath(url);
  if (abs === null) return null;
  const sharp = await loadSharp();
  if (sharp === null) return null;
  const buffer = readFileSync(abs);
  let png: Buffer;
  try {
    // 不加 { animated: true }：那样 libvips 会把 GIF 读成「所有帧竖排的一张长图」
    // （实测 8 帧 512×512 的图出来是 512×4096），发出去就是一张叠起来的怪图。
    // 默认读法拿到的就是首帧。派生完再自检一次帧数，防止哪天又退成长图。
    png = await sharp(buffer).png().toBuffer();
    const meta = await sharp(png).metadata();
    if ((meta.pages ?? 1) > 1) return null;
  } catch { return null; }
  const id = randomBytes(8).toString("hex");
  // 派生形态跟父资产同目录：表情包文件夹里「原图+静帧」成对，用户开目录看到的就是成对。
  const parentCur = currentFileOf(url);
  const parentRel = parentCur?.relPath ?? "";
  const relDir = parentRel.includes("/") ? parentRel.slice(0, parentRel.lastIndexOf("/")) : "";
  if (relDir !== "") ensureDir(relDir);
  const relPath = `${relDir === "" ? "" : relDir + "/"}${id}.png`;
  writeFileSync(nativePath(relPath), png);
  registerAsset({
    id, url: `/media/${id}.png`, kind: "image", mime: "image/png",
    bytes: png.length, parentId: parent.id, relPath, source: "derived",
  });
  return `/media/${id}.png`;
}

/** 这个扩展名是不是「某些渠道不收、但能派生出可发形态」的那种。 */
export function needsStaticVariant(url: string): boolean {
  return (url.split(".").pop() ?? "").toLowerCase() === "gif";
}

/**
 * 动图采样：均匀取最多 maxFrames 帧，每帧一张完整 png。静图就一帧；取不到返回空数组。
 *
 * 为什么要专门采帧而不是直接喂原图：认图作业要写的是「这段动作在演什么」，
 * 只看首帧会把「磕头」描述成「跪着」、把「甩尾巴转身」描述成「站着」。
 * 而 base64 内联一张动图，多数视觉接口收到的也只是它的第一帧——所以必须在这里拆开。
 *
 * ⚠️ 读法陷阱（和上面 staticFrameOf 那条是同一个坑的两面）：
 * `{ animated: true }` 会把 GIF 读成**所有帧竖排的一张长图**（实测 8 帧 512×512 → 512×4096）。
 * 派生静帧时那是 bug。采帧**不能**靠在 animated 输入上 extract 长图：sharp 0.35.5 实测
 * extract 的坐标系是按单页算的，top>0 一律 `extract_area: bad extract area`（40 帧 GIF 只有第 0
 * 帧裁得出来，还静默退回首帧）。所以逐帧读取必须用输入选项 `{ page: n }`，一帧一次解码。
 */
export async function sampleFrames(url: string, maxFrames = 4): Promise<Buffer[]> {
  const abs = mediaAbsPath(url);
  if (abs === null) return [];
  const sharp = await loadSharp();
  if (sharp === null) return [];
  const buffer = readFileSync(abs);
  try {
    const meta = await sharp(buffer, { animated: true }).metadata();
    const pages = Math.max(1, Math.floor(meta.pages ?? 1));
    if (pages === 1) return [await sharp(buffer).png().toBuffer()];
    const count = Math.min(Math.max(1, maxFrames), pages);
    const indexes: number[] = [];
    for (let i = 0; i < count; i += 1) {
      // 首尾都要有：起点和结果是「这段动作发生了什么」的主要证据，中间帧解释怎么变的。
      const frame = count === 1 ? 0 : Math.round((i * (pages - 1)) / (count - 1));
      if (!indexes.includes(frame)) indexes.push(frame);
    }
    const frames: Buffer[] = [];
    for (const frame of indexes) {
      frames.push(await sharp(buffer, { page: frame }).png().toBuffer());
    }
    return frames;
  } catch {
    // 裁不出来（帧高不匀、解码失败）就退回首帧：看得到一个画面总比整张跳过强。
    try { return [await sharp(buffer).png().toBuffer()]; } catch { return []; }
  }
}
