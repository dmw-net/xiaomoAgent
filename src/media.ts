// 媒体文件落盘：聊天图片（以及将来可能的语音附件）存数据库同级的 media 目录，
// 库里只记相对路径——保持「备份 db 文件所在目录 = 备份全部数据」的习惯。
//
// 这个「库同级的 media 目录」在 dev/CLI 与桌面端**都**成立：MEDIA_DIR 留空时
// config.mediaDir 是空串（不过 resolveDbPath，见那儿注释），由下面这段落到
// <库目录>/media。别把 resolveDbPath 加回去——它对空串返回 dataDir 本身。
//
// 为什么不走 kv 表：图片动辄几 MB，塞进 SQLite 的 TEXT 列会让每次全量读消息
// 都拖着大体积数据，也会把「一个文件就是全部设置」的 kv 表撑成杂物间。

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { contentHash, getAssetByUrl, registerAsset, syncAssetRefs, type AssetKind, type AssetRef } from "./assets.ts";
import { db } from "./db.ts";
import {
  DEFAULT_FOLDER, EMOTE_ROOT, KIND_DIR, MEDIA_DIR, currentFileOf, dirFor, emoteFolderOfDir, ensureDir,
  hashFile, idForName, layoutMigrated, nameOfUrl, nativePath, relocate, walkMediaTree, writeReconcileReport,
} from "./media-layout.ts";
import type { MessageAttachmentMeta } from "../shared/api.ts";

export { MEDIA_DIR };

/** 图片上传上限：5MB 足够手机直出的 JPEG/HEIC 转码结果，再大就该客户端先压缩。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 视频壁纸上限：几秒到一两分钟的循环短片 100MB 很宽裕；再大就该用户自己先剪。 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** 语音消息上限：60 秒录音在常见编码下远小于此，留足 Safari/移动端容器开销。 */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const VIDEO_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const AUDIO_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "weba",
};

/**
 * 按魔数判断图片类型，认不出来返回空串。
 * 图床和服务商声明的 Content-Type 经常是假的（实测 image/jpeg 里装着 HTML），
 * 落盘和下发都以字节为准；这里集中一份，别再多处各写一套。
 */
export function sniffImageMime(body: Buffer): string {
  if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body.length > 8 && body[0] === 0x89 && body[1] === 0x50) return "image/png";
  if (body.length > 12 && body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (body.length > 6 && body.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (body.length > 4 && body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) return "image/x-icon";
  const head = body.subarray(0, 512).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return "";
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/opus",
  weba: "audio/webm",
};

/**
 * /media 站内地址的形状：/media/<文件名>。文件名是身份、目录是分类——URL 里永远不带目录，
 * 所以挪文件夹不用动任何历史引用（解析时经 assets.rel_path 找真身）。
 */
const MEDIA_URL_RE = /^\/media\/([A-Za-z0-9\u3400-\u9fff._-]{3,120})$/;

/**
 * 文本里的 /media 引用。名字段放宽到「非引号非空白」——用户直接丢进表情包目录的文件
 * 名字五花八门（老板英明.gif），只认 16 位哈希会把它们的引用扫漏，扫漏=清理时敢删还在用的图。
 */
const MEDIA_REF_RE = /\/media\/([A-Za-z0-9\u3400-\u9fff._-]{3,120})/g;

/** 应用自己生成的文件名形状（回收站等用户动作只认这个形状，别的东西不碰）。 */
const MEDIA_FILE_RE = /^[a-z0-9]{16,18}\.(png|jpg|webp|gif|mp4|webm|mp3|wav|m4a|ogg|opus|weba)$/;

/** 刚上传但还没发出去的文件先留 24 小时，避免把用户正拿在手里的图清掉。 */
const MEDIA_ORPHAN_GRACE_MS = 24 * 3_600_000;
export const MEDIA_ORPHAN_GRACE_HOURS = 24;
export const MEDIA_TRASH_RETENTION_DAYS = 7;
const MEDIA_TRASH_RETENTION_MS = MEDIA_TRASH_RETENTION_DAYS * 24 * 3_600_000;

/** 当前媒体目录（默认库同级 media/）。改数据位置时照着它搬（data-dir.ts）。 */
export function mediaDir(): string {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

/** 壁纸身份就是 wp 前缀（引用存在设备 localStorage、不在库里，所以靠形状自证）。 */
function isWallpaperUrl(url: string): boolean {
  return /^\/media\/wp[a-z0-9]{16}\.[a-z]+$/.test(url);
}

/**
 * 站内地址 → 盘上真身：先按库里的 rel_path，再兜遗留平铺位置；都不在返回 null。
 * 所有读文件的入口（服务、发送、dataURL、存在性）都从这里过，别处不再自己拼路径。
 */
function resolveMediaFile(url: string): { file: string; relPath: string } | null {
  if (!MEDIA_URL_RE.test(url)) return null;
  return currentFileOf(url);
}

/**
 * 落盘即登记：四个 save 函数都走这里，所以「文件在盘上但库里没记录」这个状态从构造上不存在。
 * 2026-09-28 那两张已经画成的自拍就是这么丢的——画成功和消息落地是两个时刻，中间断一次，
 * 文件就成了没人认领的东西，下一轮清理直接删。artifacts 表当时补的是那条路，这里是总闸。
 * source 一律先记 unclaimed：调用方才知道它是什么，由 claimAsset 与对账再补，
 * 但**存在性已经保证了**，认领漏掉的代价只是元数据缺口，不再是数据丢失。
 */
function registerMedia(id: string, ext: string, kind: AssetKind, mime: string, buffer: Buffer, relPath: string, source: "unclaimed" | "wallpaper" = "unclaimed"): void {
  registerAsset({
    id,
    url: `/media/${id}.${ext}`,
    kind,
    mime,
    bytes: buffer.length,
    hash: contentHash(buffer),
    relPath,
    source,
  });
}

/** 存一张图，返回可直接回给前端的 /media URL。mime 不在白名单时抛错。
 *  dir 给「表情包/<文件夹>」就落进表情目录（导入/打标链路），默认落 图片/。
 *  maxBytes 默认是全局那道 5MB 闸；只有「用户主动导入本地文件夹」这条会传更高的值——
 *  同一份字节还要去内联喂视觉模型、随聊天入站自动抓取，那些路径不该跟着一起放宽。 */
export function saveImage(buffer: Buffer, mime: string, dir?: string, maxBytes = MAX_IMAGE_BYTES): { url: string; id: string } {
  const ext = IMAGE_EXT[mime];
  if (!ext) throw new Error("图片格式不支持（仅 png / jpg / webp / gif）");
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new Error(`图片大小需在 ${Math.round(maxBytes / (1024 * 1024))}MB 以内`);
  }
  const id = randomBytes(8).toString("hex");
  const relDir = dir ?? KIND_DIR.image;
  const relPath = `${relDir}/${id}.${ext}`;
  writeFileSync(join(ensureDir(relDir), `${id}.${ext}`), buffer);
  registerMedia(id, ext, "image", mime, buffer, relPath);
  return { url: `/media/${id}.${ext}`, id };
}

/** 按魔数判断视频类型，认不出来返回空串。声明头照样可能是假的，与 sniffImageMime 同一纪律。 */
export function sniffVideoMime(body: Buffer): string {
  if (body.length > 12 && body.subarray(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  if (body.length > 4 && body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3) return "video/webm";
  return "";
}

/** 按魔数判断语音容器；扩展名只由识别结果决定，绝不信任浏览器声明的 Content-Type。 */
export function sniffAudioMime(body: Buffer): string {
  if (body.length > 12 && body.subarray(4, 8).toString("latin1") === "ftyp") return "audio/mp4";
  if (body.length > 4 && body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3) return "audio/webm";
  if (body.length > 4 && body.subarray(0, 4).toString() === "OggS") return "audio/ogg";
  if (body.length > 12 && body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WAVE") return "audio/wav";
  if (body.length > 3 && body.subarray(0, 3).toString() === "ID3") return "audio/mpeg";
  if (body.length > 2 && body[0] === 0xff && (body[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return "";
}

/** 存一条语音消息的原始音频；保留浏览器录音容器，不做有损转码。 */
export function saveAudio(buffer: Buffer): { url: string; id: string; mime: string } {
  if (buffer.length === 0 || buffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`语音大小需在 ${MAX_AUDIO_BYTES / (1024 * 1024)}MB 以内`);
  }
  const mime = sniffAudioMime(buffer);
  const ext = AUDIO_EXT[mime];
  if (!ext) throw new Error("语音格式不支持（仅 mp3 / wav / m4a / ogg / opus / webm）");
  const id = randomBytes(8).toString("hex");
  const relDir = KIND_DIR.audio;
  writeFileSync(join(ensureDir(relDir), `${id}.${ext}`), buffer);
  registerMedia(id, ext, "audio", mime, buffer, `${relDir}/${id}.${ext}`);
  return { url: `/media/${id}.${ext}`, id, mime };
}

/**
 * 估一段音频的时长（毫秒）：WAV 按 RIFF 块走精确算；MP3 跳过 ID3 后解析首帧头按 CBR 估
 * （VBR 会有偏差，够气泡展示用）。认不出的容器（m4a/ogg/webm）返回 undefined，
 * 前端气泡有自己的兜底展示，不要为它编一个假时长。
 */
export function audioDurationMs(body: Buffer, mime: string): number | undefined {
  try {
    if (mime === "audio/wav") return wavDurationMs(body);
    if (mime === "audio/mpeg") return mp3DurationMs(body);
  } catch { /* 头解析失败就当不知道 */ }
  return undefined;
}

/** RIFF 块链：找到 fmt 拿 byteRate，找到 data 拿数据量，时长 = 数据量 / 每秒字节。 */
function wavDurationMs(body: Buffer): number | undefined {
  if (body.length < 44 || body.subarray(0, 4).toString() !== "RIFF" || body.subarray(8, 12).toString() !== "WAVE") return undefined;
  let byteRate = 0;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= body.length) {
    const id = body.subarray(offset, offset + 4).toString();
    const size = body.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      if (offset + 8 + 16 > body.length) return undefined;
      byteRate = body.readUInt32LE(offset + 16);
    } else if (id === "data") {
      dataBytes = Math.min(size, body.length - offset - 8);
    }
    offset += 8 + size + (size % 2);
    if (byteRate > 0 && dataBytes > 0) break;
  }
  if (byteRate <= 0 || dataBytes <= 0) return undefined;
  return Math.round((dataBytes / byteRate) * 1000);
}

const MP3_V1_L3_BITRATE_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_V2_L3_BITRATE_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLE_RATE_HZ: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 跳过 ID3v2 与填充，定位首个帧头，按帧头比特率做 CBR 估算。 */
function mp3DurationMs(body: Buffer): number | undefined {
  let offset = 0;
  if (body.subarray(0, 3).toString() === "ID3") {
    // ID3v2 大小是 4 字节 syncsafe（每字节只用低 7 位）。
    const size = ((body[6]! & 0x7f) << 21) | ((body[7]! & 0x7f) << 14) | ((body[8]! & 0x7f) << 7) | (body[9]! & 0x7f);
    offset = 10 + size;
  }
  while (offset < body.length - 4 && (body[offset] !== 0xff || (body[offset + 1]! & 0xe0) !== 0xe0)) offset += 1;
  if (offset >= body.length - 4) return undefined;
  const versionBits = (body[offset + 1]! >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (body[offset + 1]! >> 1) & 0x03; // 1=Layer III
  const bitrateIdx = body[offset + 2]! >> 4;
  const sampleIdx = (body[offset + 2]! >> 2) & 0x03;
  if (layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) return undefined;
  const rates = MP3_SAMPLE_RATE_HZ[versionBits];
  if (rates === undefined) return undefined;
  const bitrateBps = (versionBits === 3 ? MP3_V1_L3_BITRATE_KBPS[bitrateIdx] : MP3_V2_L3_BITRATE_KBPS[bitrateIdx])! * 1000;
  if (bitrateBps <= 0) return undefined;
  return Math.round(((body.length - offset) * 8 * 1000) / bitrateBps);
}

/** 存一段视频（入站/出站共用）；只认 mp4 与 webm，超出 100MB 直接拒。 */
export function saveVideo(buffer: Buffer): { url: string; id: string; mime: string } {
  if (buffer.length === 0 || buffer.length > MAX_VIDEO_BYTES) {
    throw new Error(`视频大小需在 ${MAX_VIDEO_BYTES / (1024 * 1024)}MB 以内`);
  }
  const imageMime = sniffImageMime(buffer);
  if (imageMime !== "") throw new Error("声明是视频但魔数是图片，已拒绝");
  const mime = sniffVideoMime(buffer);
  const ext = VIDEO_EXT[mime];
  if (!ext) throw new Error("视频格式不支持（仅 mp4 / webm）");
  const id = randomBytes(8).toString("hex");
  const relDir = KIND_DIR.video;
  writeFileSync(join(ensureDir(relDir), `${id}.${ext}`), buffer);
  registerMedia(id, ext, "video", mime, buffer, `${relDir}/${id}.${ext}`);
  return { url: `/media/${id}.${ext}`, id, mime };
}

/** 文件类型由扩展名决定；壁纸的文件仍是 image/video，来源另由 MediaSource 表示。 */
export function mediaTypeOfUrl(url: string): "image" | "video" | "audio" | "file" {
  const ext = (url.split(".").pop() ?? "").toLowerCase();
  if (IMAGE_EXT[EXT_MIME[ext] ?? ""]) return "image";
  if (ext === "mp4" || ext === "webm") return "video";
  if (AUDIO_EXT[EXT_MIME[ext] ?? ""]) return "audio";
  return "file";
}

/**
 * 存一张壁纸：文件名带 wp 前缀（见 WALLPAPER_URL_RE），内容可以是图片或视频。
 * 与 saveImage 不同，这里按魔数复检——浏览器报的 content-type 不可信，落盘以字节为准。
 */
export function saveWallpaper(buffer: Buffer, mime: string): { url: string; id: string } {
  const imageMime = sniffImageMime(buffer);
  const videoMime = sniffVideoMime(buffer);
  const kind = IMAGE_EXT[imageMime] ? "image" : VIDEO_EXT[videoMime] ? "video" : "";
  if (kind === "image") {
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`图片大小需在 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB 以内`);
    }
  } else if (kind === "video") {
    if (buffer.length > MAX_VIDEO_BYTES) {
      throw new Error(`视频大小需在 ${MAX_VIDEO_BYTES / (1024 * 1024)}MB 以内`);
    }
  } else {
    throw new Error("壁纸格式不支持（图片 png / jpg / webp / gif，视频 mp4 / webm）");
  }
  const id = `wp${randomBytes(8).toString("hex")}`;
  const ext = (kind === "image" ? IMAGE_EXT[imageMime] : VIDEO_EXT[videoMime]) as string;
  const relDir = kind === "image" ? KIND_DIR.image : KIND_DIR.video;
  writeFileSync(join(ensureDir(relDir), `${id}.${ext}`), buffer);
  // 壁纸的来源不用等对账：wp 前缀本身就说明了它是干什么的。
  registerMedia(id, ext, kind as AssetKind, kind === "image" ? imageMime : videoMime, buffer, `${relDir}/${id}.${ext}`, "wallpaper");
  return { url: `/media/${id}.${ext}`, id };
}

/** 删一个壁纸文件：形状必须是 wp 前缀（普通聊天图片有自己的回收通道，别走到这）。 */
export function deleteWallpaper(url: string): void {
  if (!isWallpaperUrl(url)) return;
  const file = resolveMediaFile(url);
  if (file === null) return;
  try {
    rmSync(file.file, { force: true });
  } catch { /* 删不掉就算了，留给出厂重置 */ }
}

/** 媒体文件元信息：/media/ 路由给视频与语音做 Range 流式播放，不把整个文件读进内存。 */
export function mediaFileInfo(url: string): { file: string; mime: string; size: number } | null {
  const found = resolveMediaFile(url);
  if (found === null) return null;
  const ext = found.file.slice(found.file.lastIndexOf(".") + 1);
  return { file: found.file, mime: EXT_MIME[ext] ?? "application/octet-stream", size: statSync(found.file).size };
}

/** 媒体目录里的全部 /media 地址（出厂重置用：库清空后这些文件都没人认领了）。递归整棵树。 */
export function listMediaUrls(): string[] {
  return walkMediaTree().map((entry) => "/media/" + entry.name);
}

/** 按 /media URL 读回文件内容；不存在或形状不对返回 null。 */
export function readMedia(url: string): { buffer: Buffer; mime: string } | null {
  const found = resolveMediaFile(url);
  if (found === null) return null;
  const ext = found.file.slice(found.file.lastIndexOf(".") + 1);
  return { buffer: readFileSync(found.file), mime: EXT_MIME[ext] ?? "application/octet-stream" };
}

/**
 * 站内 /media 路径 → 本机绝对路径（文件不在盘上返回 null）。
 * 给「让外部进程自己去读这个文件」的场合用：OneBot 协议端的 `file` 字段只认
 * 绝对路径 / file:/// / http URL / base64，站内相对路径它解不出来。
 */
export function mediaAbsPath(url: string): string | null {
  return resolveMediaFile(url)?.file ?? null;
}

export function mediaUrlExists(url: string): boolean {
  // 只判断存在，不把整张图读进内存（readMedia 是给真要内容的人用的）
  return resolveMediaFile(url) !== null;
}

/**
 * 回收图片文件：确认库里再无引用才落盘删除。引用检查用 LIKE '%<16位随机hex>%'——误命中概率为零。
 *
 * 认哪几处引用由**这一处**说了算，调用方不必各自想起来加判断：
 * messages / turns 的附件、联系人的头像、自拍参考图、画作台账、工具详情与 kv 里的持久路径。
 * 之前只查前两处，于是「换参考图」「换头像」「这张图同时是画廊里的一张画」
 * 都得靠调用点自己补一条 `!isArtifactUrl(...)`，漏一个就删掉别人还在引用的文件。
 * 头像改成 /media 形态之后更需要这一收口：同一张图被两位联系人指着是可能的
 * （助手搜到同一张候选给了两位），按引用计数删才安全。
 */
export function releaseMediaFiles(urls: string[]): void {
  if (urls.length === 0) return;
  // 七个 EXISTS 而不是 UNION ALL：SQLite 不接受 `… LIMIT 1 UNION ALL …`
  // （LIMIT 必须在 UNION ALL 之后），那条写法每次调用都抛 SQL logic error——
  // 而调用点 deleteMessage 没有兜异常，于是「删掉一条带图消息」会在事务提交后
  // 报 500：消息其实删了，图片却永久留在磁盘上。
  const probe = db.prepare(
    `SELECT EXISTS(SELECT 1 FROM messages  WHERE attachments LIKE ?) AS in_messages,
            EXISTS(SELECT 1 FROM turns     WHERE attachments LIKE ?) AS in_turns,
            EXISTS(SELECT 1 FROM contacts  WHERE avatar     LIKE ?)  AS in_avatar,
            EXISTS(SELECT 1 FROM contacts  WHERE face_ref   LIKE ?)  AS in_face_ref,
            EXISTS(SELECT 1 FROM artifacts  WHERE url        LIKE ?) AS in_artifact,
            EXISTS(SELECT 1 FROM messages   WHERE tool_detail LIKE ?) AS in_tool_detail,
            EXISTS(SELECT 1 FROM kv         WHERE v          LIKE ?) AS in_kv`,
  );
  for (const url of urls) {
    const found = resolveMediaFile(url);
    if (found === null) continue;
    const like = `%${nameOfUrl(url)}%`;
    const ref = probe.get(like, like, like, like, like, like, like) as
      { in_messages: number; in_turns: number; in_avatar: number; in_face_ref: number; in_artifact: number; in_tool_detail: number; in_kv: number };
    if (ref.in_messages || ref.in_turns || ref.in_avatar || ref.in_face_ref || ref.in_artifact || ref.in_tool_detail || ref.in_kv) continue;
    try {
      rmSync(found.file, { force: true });
    } catch { /* 删不掉就算了，留给下次 */ }
  }
}

/** 给模型用的 dataURL（OpenAI 兼容接口普遍接受 base64 内联图）。取不到返回 null。 */
export function mediaDataUrl(url: string): string | null {
  const file = readMedia(url);
  if (!file) return null;
  return `data:${file.mime};base64,${file.buffer.toString("base64")}`;
}

/**
 * 这张图内联成 dataURL 后在请求体里占多少字节。
 * 只用于诊断和体积展示，不参与“能不能看这张图”的选图决策——聊天已改为按张数封顶。
 * 40 是 `data:image/jpeg;base64,` 头加 JSON 的引号与键名的余量。
 */
export function dataUrlBytes(url: string): number | null {
  const found = resolveMediaFile(url);
  if (found === null) return null;
  return Math.ceil(statSync(found.file).size / 3) * 4 + 40;
}

export type MediaSourceKind = "avatar" | "face_ref" | "chat" | "voice" | "turn" | "artifact" | "tool" | "setting" | "emote" | "favorite" | "wallpaper" | "none" | "trash";

export type MediaSource = {
  kind: MediaSourceKind;
  label: string;
  detail?: string;
  /** 引用方的归属联系人 id。资产注册表靠它把「这张图是谁的」落进表里——detail 是给人看的名字，不能拿来筛。 */
  contactId?: string;
  /** 只有聊天消息来源带；媒体页可直接发起“删除这条语音消息”。 */
  messageId?: number;
  durationMs?: number;
  transcript?: string;
};

export type MediaMaintenanceItem = {
  name: string;
  url: string;
  size: number;
  modifiedAt: number;
  /** 文件本质：图片/视频/语音；wallpaper 用于兼容旧界面，实际类型看 mediaType。 */
  mediaKind: "image" | "video" | "audio" | "wallpaper";
  mediaType: "image" | "video" | "audio" | "file";
  mime: string;
  durationMs?: number;
  transcript?: string;
  referenced: boolean;
  cleanable: boolean;
  sources: MediaSource[];
};

export type MediaTrashItem = MediaMaintenanceItem & {
  trashedAt: number;
  expiresAt: number;
};

export type MediaMaintenanceSnapshot = {
  files: number;
  referenced: number;
  pending: number;
  cleanable: number;
  items: MediaMaintenanceItem[];
  all: MediaMaintenanceItem[];
  trash: MediaTrashItem[];
  totalBytes: number;
  allBytes: number;
  trashBytes: number;
  byType: Record<MediaTypeKey, { files: number; bytes: number }>;
  orphanGraceHours: number;
  trashRetentionDays: number;
  checkedAt: number;
};

export type MediaMutationResult = {
  changed: number;
  skipped: number;
  bytes: number;
};

export type MediaTypeKey = "image" | "video" | "audio" | "file";

const SOURCE_ORDER: MediaSourceKind[] = ["avatar", "face_ref", "chat", "voice", "turn", "artifact", "tool", "setting", "wallpaper", "none", "trash"];

/**
 * 媒体文件的引用来源必须在这里统一认全。少认一处，界面上的“未引用”就可能是误报，
 * 点一下清理就会把用户还在用的图移走。返回的是来源清单，不只是 yes/no：
 * 用户需要知道这张图为什么还在、又为什么不能删。
 */
function collectMediaSources(): Map<string, MediaSource[]> {
  const sources = new Map<string, MediaSource[]>();
  const contactNames = new Map(
    (db.prepare("SELECT id, name FROM contacts").all() as Array<{ id: string; name: string }>)
      .map((row) => [row.id, row.name] as const),
  );
  const addName = (name: string, source: MediaSource): void => {
    const list = sources.get(name) ?? [];
    if (!list.some((item) => item.kind === source.kind && item.detail === source.detail && item.messageId === source.messageId)) list.push(source);
    sources.set(name, list);
  };
  const add = (raw: unknown, source: MediaSource): void => {
    for (const match of String(raw).matchAll(MEDIA_REF_RE)) {
      const name = match[1];
      if (name) addName(name, source);
    }
  };
  const contactDetail = (contactId: unknown): string => contactNames.get(String(contactId ?? "")) ?? "";
  const voiceUrls = (rawMeta: unknown): Map<string, MessageAttachmentMeta> => {
    const out = new Map<string, MessageAttachmentMeta>();
    if (typeof rawMeta !== "string" || rawMeta === "") return out;
    try {
      const parsed: unknown = JSON.parse(rawMeta);
      if (!Array.isArray(parsed)) return out;
      for (const item of parsed) {
        if (item === null || typeof item !== "object") continue;
        const v = item as Partial<MessageAttachmentMeta>;
        if (typeof v.url === "string" && v.kind === "audio") out.set(v.url, v as MessageAttachmentMeta);
      }
    } catch { /* 坏元信息按普通附件处理 */ }
    return out;
  };

  for (const row of db.prepare(
    "SELECT id, contact_id, attachments, attachment_meta FROM messages WHERE attachments LIKE '%/media/%'",
  ).all() as Array<{ id: number; contact_id: string | null; attachments: string; attachment_meta: string | null }>) {
    const meta = voiceUrls(row.attachment_meta);
    for (const match of row.attachments.matchAll(MEDIA_REF_RE)) {
      const name = match[1];
      if (!name) continue;
      const url = "/media/" + name;
      const voice = meta.get(url);
      if (voice) {
        const seconds = typeof voice.durationMs === "number" ? Math.max(0, Math.round(voice.durationMs / 1000)) : 0;
        addName(name, {
          kind: "voice", label: "语音消息",
          detail: [contactDetail(row.contact_id), seconds > 0 ? seconds + " 秒" : ""].filter(Boolean).join(" · "),
          contactId: String(row.contact_id ?? ""),
          messageId: row.id,
          durationMs: typeof voice.durationMs === "number" ? voice.durationMs : undefined,
          transcript: typeof voice.transcript === "string" ? voice.transcript : undefined,
        });
      } else {
        addName(name, { kind: "chat", label: "聊天", detail: contactDetail(row.contact_id) || undefined, contactId: String(row.contact_id ?? ""), messageId: row.id });
      }
    }
  }
  for (const row of db.prepare(
    "SELECT contact_id, tool_detail FROM messages WHERE tool_detail LIKE '%/media/%'",
  ).all() as Array<{ contact_id: string | null; tool_detail: string }>) {
    add(row.tool_detail, { kind: "tool", label: "工具记录", detail: contactDetail(row.contact_id) || undefined, contactId: String(row.contact_id ?? "") });
  }
  for (const row of db.prepare(
    "SELECT contact_id, attachments, attachment_meta FROM turns WHERE attachments LIKE '%/media/%'",
  ).all() as Array<{ contact_id: string | null; attachments: string; attachment_meta: string | null }>) {
    const meta = voiceUrls(row.attachment_meta);
    for (const match of row.attachments.matchAll(MEDIA_REF_RE)) {
      const name = match[1];
      if (!name) continue;
      const voice = meta.get("/media/" + name);
      const contactId = String(row.contact_id ?? "");
      addName(name, voice
        ? { kind: "voice", label: "语音消息", detail: contactDetail(row.contact_id) || undefined, contactId }
        : { kind: "turn", label: "回复任务", detail: contactDetail(row.contact_id) || undefined, contactId });
    }
  }
  for (const row of db.prepare(
    "SELECT id, name, avatar, face_ref FROM contacts WHERE avatar LIKE '%/media/%' OR face_ref LIKE '%/media/%'",
  ).all() as Array<{ id: string; name: string; avatar: string; face_ref: string }>) {
    add(row.avatar, { kind: "avatar", label: "头像", detail: row.name, contactId: row.id });
    add(row.face_ref, { kind: "face_ref", label: "长相参考", detail: row.name, contactId: row.id });
  }
  for (const row of db.prepare(
    "SELECT contact_id, url FROM artifacts WHERE url LIKE '%/media/%'",
  ).all() as Array<{ contact_id: string; url: string }>) {
    add(row.url, { kind: "artifact", label: "作品", detail: contactDetail(row.contact_id) || undefined, contactId: row.contact_id });
  }
  // 用户明确认领过的资产（表情包素材、收藏）本身就是引用。
  // 少了这一条，「只被表情库认领、没进过任何对话」的梗图会被判成未引用而被清理掉——
  // 表情标记从前住在 kv 的 blob 里、由下面的 kv 扫描顺带认到；搬进 assets 表后那条扫描就看不见它了。
  for (const row of db.prepare(
    "SELECT url, usable_as_emote, starred FROM assets WHERE usable_as_emote = 1 OR starred = 1",
  ).all() as Array<{ url: string; usable_as_emote: number; starred: number }>) {
    if (row.usable_as_emote === 1) add(row.url, { kind: "emote", label: "表情包素材" });
    if (row.starred === 1) add(row.url, { kind: "favorite", label: "收藏" });
  }
  for (const row of db.prepare("SELECT v FROM kv WHERE v LIKE '%/media/%'").all() as Array<{ v: string }>) {
    add(row.v, { kind: "setting", label: "本地设置" });
  }
  for (const [name, list] of sources) {
    // 正常聊天图片会同时出现在 messages.attachments 与 turns.attachments。
    // 对用户来说它们不是两个来源；有聊天来源时不再重复显示“回复任务”。
    const chatDetails = new Set(list.filter((item) => item.kind === "chat").map((item) => item.detail ?? ""));
    const hasVoiceMessage = list.some((item) => item.kind === "voice" && typeof item.messageId === "number");
    const pruned = list.filter((item) => {
      if (item.kind === "turn") return !chatDetails.has(item.detail ?? "");
      // 语音同时落在 messages 与 turns：有消息来源时，处理单那条只是内部副本。
      if (item.kind === "voice" && item.messageId === undefined && hasVoiceMessage) return false;
      return true;
    });
    pruned.sort((a, b) => SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind));
    sources.set(name, pruned);
  }
  return sources;
}

type MediaScan = {
  files: number;
  referenced: number;
  pending: number;
  items: MediaMaintenanceItem[];
  all: MediaMaintenanceItem[];
};

/**
 * 资产对账 v2：盘和库互为镜像的收敛点，也是「用户在资源管理器里自己动手」的兜底。
 *
 *   盘上有库里没有 → 按位置登记；躺在 表情包/<X>/ 下的直接认领成表情、文件夹=X
 *   库里有但 rel_path 上没文件 → 按名字/哈希全树找：找到=用户挪过或改名，改地址；找不到=标失效
 *   失效行再见文件 → 复活；表情行**永远不静默删**（消息还引用着它，行在历史就在）
 *   哈希撞上已有行 → 不登记，计入报告（重复文件，用户拷贝出来的）
 *
 * 回执落 kv（设置里的媒体对账读它）。正常路径 save* 在落盘那刻就登记了，这里只兜外部动作。
 * 大文件（>20MB）不回补内容哈希：哈希是去重与渠道凭证的优化键，为它把 100MB 视频读进内存不值得。
 */
export function reconcileAssets(): {
  registered: number; pruned: number; updated: number;
  moved: number; adopted: number; markedMissing: number; revived: number; dupIgnored: number;
} {
  const entries = walkMediaTree();
  const rowUrl = (name: string): string => "/media/" + name;
  const rows = db.prepare(
    "SELECT id, url, kind, hash, rel_path, usable_as_emote, emote_pack, missing FROM assets",
  ).all() as Array<{ id: string; url: string; kind: string; hash: string; rel_path: string; usable_as_emote: number; emote_pack: string; missing: number }>;
  const inTrash = db.prepare("SELECT 1 AS hit FROM media_trash WHERE name = ?");
  const rowByName = new Map(rows.map((r) => [nameOfUrl(r.url), r]));
  const knownHashes = new Set(rows.map((r) => r.hash).filter((h) => h !== ""));
  // 同名多份（用户拷贝/撞名）：第一份按身份认领，其余计入重复，绝不互相打架。
  const seenNames = new Set<string>();
  const freeEntries: typeof entries = [];
  for (const e of entries) {
    if (seenNames.has(e.name)) { continue; }
    seenNames.add(e.name);
    freeEntries.push(e);
  }

  let registered = 0, moved = 0, adopted = 0, dupIgnored = 0;
  // 哈希撞上已有行而名字对不上的文件：多半是用户改了名。留着当「改地址」的候选，
  // 而不是登记成第二张重复表情。
  const renameRescue = new Map<string, (typeof entries)[number]>();
  for (const e of freeEntries) {
    const row = rowByName.get(e.name);
    // 散放在 表情包/ 根下的图＝默认文件夹：先挪进 表情包/默认/，再按文件夹规则认领。
    // 根目录不是某个文件夹，但它显然是用户想当表情放的东西——兜到默认是唯一说得通的读法。
    if (e.dir === EMOTE_ROOT) {
      const to = `${EMOTE_ROOT}/${DEFAULT_FOLDER}`;
      ensureDir(to);
      const target = nativePath(`${to}/${e.name}`);
      const src = nativePath(e.relPath);
      if (target !== "" && !existsSync(target)) {
        try {
          renameSync(src, target);
          e.relPath = `${to}/${e.name}`;
          e.dir = to;
        } catch { /* 挪不动就按原位处理 */ }
      } else if (existsSync(target)) {
        dupIgnored += 1;
        continue;
      }
    }
    if (row === undefined) {
      const file = nativePath(e.relPath);
      const hash = e.size > 20 * 1024 * 1024 ? "" : hashFile(file);
      if (hash !== "" && knownHashes.has(hash)) { dupIgnored += 1; renameRescue.set(hash, e); continue; }
      const { id, ext } = idForName(e.name);
      const folder = emoteFolderOfDir(e.dir);
      registerAsset({
        id, url: rowUrl(e.name), kind: mediaTypeOfUrl(rowUrl(e.name)),
        mime: EXT_MIME[ext === "jpeg" ? "jpg" : ext] ?? "application/octet-stream",
        bytes: e.size, hash, relPath: e.relPath,
        // wp 前缀就是壁纸的身份证明（引用在设备 localStorage、不在库里），不用等认领。
        source: /^wp[a-z0-9]{16}\./.test(e.name) ? "wallpaper" : "unclaimed",
        usableAsEmote: folder !== null, emotePack: folder !== null ? [folder] : undefined,
      });
      registered += 1;
      if (folder !== null) adopted += 1;
      continue;
    }
    if (row.rel_path !== "" && row.rel_path !== e.relPath) {
      db.prepare("UPDATE assets SET rel_path = ?, missing = 0 WHERE url = ?").run(e.relPath, row.url);
      row.rel_path = e.relPath;
      moved += 1;
    }
    const folder = emoteFolderOfDir(e.dir);
    if (folder !== null) {
      const pack = parsePack(row.emote_pack);
      if (Number(row.usable_as_emote) !== 1) {
        db.prepare("UPDATE assets SET usable_as_emote = 1, missing = 0, emote_pack = ?, updated_at = ? WHERE url = ?")
          .run(JSON.stringify([folder]), Date.now(), row.url);
        adopted += 1;
      } else if (pack[0] !== folder) {
        // 目录和库归属不一致：用户在盘上动了手，盘是最新动作，库跟盘。
        db.prepare("UPDATE assets SET emote_pack = ? WHERE url = ?").run(JSON.stringify([folder]), row.url);
        moved += 1;
      }
    }
  }
  // 同名但位置对不上的条目（用户挪动过、或遗留平铺行已归位）：按哈希确认身份后当改地址候选。
  const hashRescue = new Map<string, (typeof entries)[number]>();
  for (const e of freeEntries) {
    const row = rowByName.get(e.name);
    if (row === undefined || row.hash === "") continue;
    const file = nativePath(e.relPath);
    if (!existsSync(file)) continue;
    if (row.rel_path === e.relPath && Number(row.missing) === 0) continue;
    const hash = hashFile(file);
    if (hash !== "" && hash === row.hash) hashRescue.set(row.hash, e);
  }

  let pruned = 0, markedMissing = 0, revived = 0;
  const drop = db.prepare("DELETE FROM assets WHERE id = ?");
  for (const row of rows) {
    const cur = nativePath(row.rel_path !== "" ? row.rel_path : nameOfUrl(row.url));
    if (cur !== "" && existsSync(cur)) {
      if (Number(row.missing) === 1) {
        db.prepare("UPDATE assets SET missing = 0 WHERE id = ?").run(row.id);
        revived += 1;
      }
      continue;
    }
    // 记的位置没有文件 → 按哈希找真身：同名候选（挪动）优先，改名候选其次。
    const rescue = row.hash !== "" ? (hashRescue.get(row.hash) ?? renameRescue.get(row.hash)) : undefined;
    if (rescue !== undefined) {
      db.prepare("UPDATE assets SET rel_path = ?, missing = 0 WHERE id = ?").run(rescue.relPath, row.id);
      hashRescue.delete(row.hash); renameRescue.delete(row.hash);
      row.rel_path = rescue.relPath;
      moved += 1; revived += 1;
      continue;
    }
    if (Number(row.usable_as_emote) === 1) {
      if (Number(row.missing) !== 1) {
        db.prepare("UPDATE assets SET missing = 1 WHERE id = ?").run(row.id);
        markedMissing += 1;
      }
      continue;
    }
    // 普通资产进了回收站时不能销账：恢复必须复活原身份，不能指望按哈希重新认领
    // （同内容不同文件很常见，重新认领会被去重挡掉，/media 地址就失效了）。
    if (inTrash.get(nameOfUrl(row.url)) !== undefined) {
      if (Number(row.missing) !== 1) {
        db.prepare("UPDATE assets SET missing = 1 WHERE id = ?").run(row.id);
        markedMissing += 1;
      }
      continue;
    }
    // 非表情行且盘上确实没有：和旧行为一致，销账。回收站里的文件不在扫描树内，正是靠这条路收掉行。
    drop.run(row.id);
    pruned += 1;
  }
  // 父资产没了，它的派生形态（动图静帧这类）就是垃圾文件：连文件带行一起收掉。
  const orphans = db.prepare(
    "SELECT id, url FROM assets WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM assets)",
  ).all() as Array<{ id: string; url: string }>;
  for (const child of orphans) {
    const file = resolveMediaFile(child.url);
    if (file !== null) { try { rmSync(file.file, { force: true }); } catch { /* 删不掉留给下一轮 */ } }
    drop.run(child.id);
    pruned += 1;
  }

  const counts = { registered, pruned, moved, adopted, markedMissing, revived, dupIgnored };
  writeReconcileReport(counts);
  const refs = new Map<string, AssetRef[]>();
  for (const [name, sources] of collectMediaSources()) {
    refs.set("/media/" + name, sources.map((s) => ({
      kind: s.kind, contactId: s.contactId, durationMs: s.durationMs, messageId: s.messageId,
    })));
  }
  return { ...counts, ...syncAssetRefs(refs) };
}

function parsePack(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch { return []; }
}

/** 递归扫描媒体树中的全部文件；items 只包含已经可以安全清理的那部分。 */
export function scanOrphanMedia(minAgeMs = MEDIA_ORPHAN_GRACE_MS): MediaScan {
  const entries = walkMediaTree();
  const sourceMap = collectMediaSources();
  const now = Date.now();
  let files = 0;
  let referenced = 0;
  let pending = 0;
  const items: MediaMaintenanceItem[] = [];
  const all: MediaMaintenanceItem[] = [];
  for (const entry of entries) {
    const url = `/media/${entry.name}`;
    const wallpaper = /^wp[a-z0-9]{16}\./.test(entry.name);
    const file = nativePath(entry.relPath);
    if (file === "" || !existsSync(file)) continue;
    try {
      const stat = statSync(file);
      files += 1;
      const mediaType = mediaTypeOfUrl(url);
      const ext = entry.name.slice(entry.name.lastIndexOf(".") + 1);
      const base = {
        name: entry.name,
        url,
        size: stat.size,
        modifiedAt: Math.round(stat.mtimeMs),
        mediaType,
        mime: EXT_MIME[ext] ?? "application/octet-stream",
        ...(mediaType === "audio" ? (() => {
          const voice = sourceMap.get(entry.name)?.find((source) => source.kind === "voice");
          return voice ? { durationMs: voice.durationMs, transcript: voice.transcript } : {};
        })() : {}),
      };
      if (wallpaper) {
        all.push({
          ...base,
          mediaKind: "wallpaper",
          referenced: false,
          cleanable: false,
          sources: [{ kind: "wallpaper", label: "壁纸", detail: "引用保存在设备本地" }],
        });
        continue;
      }
      const mediaKind = mediaType === "file" ? "image" : mediaType;
      const knownSources = sourceMap.get(entry.name) ?? [];
      if (knownSources.length > 0) {
        referenced += 1;
        all.push({ ...base, mediaKind, referenced: true, cleanable: false, sources: knownSources });
        continue;
      }
      // 未来时间按“刚写入”处理：部分机器上 mtime 会比 Date.now() 早/晚几毫秒。
      if (Math.max(0, now - stat.mtimeMs) < minAgeMs) {
        pending += 1;
        all.push({
          ...base,
          mediaKind,
          referenced: false,
          cleanable: false,
          sources: [{ kind: "none", label: "未引用", detail: `保护期内，满 ${Math.round(minAgeMs / 3_600_000)} 小时后可清理` }],
        });
        continue;
      }
      const item: MediaMaintenanceItem = {
        ...base,
        mediaKind,
        referenced: false,
        cleanable: true,
        sources: [{ kind: "none", label: "未引用" }],
      };
      items.push(item);
      all.push(item);
    } catch { /* 扫描期间被别的进程移走就跳过 */ }
  }
  items.sort((a, b) => b.modifiedAt - a.modifiedAt);
  all.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { files, referenced, pending, items, all };
}

function trashDir(): string {
  const dir = join(mediaDir(), ".trash");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function trashPath(name: string): string {
  return join(trashDir(), name);
}

/** 清掉回收站中超过 7 天的文件。只删用户已经明确移入回收站的文件。 */
export function purgeExpiredMediaTrash(now = Date.now()): { removed: number; bytes: number } {
  const cutoff = now - MEDIA_TRASH_RETENTION_MS;
  const rows = db.prepare("SELECT name, size FROM media_trash WHERE trashed_at <= ?").all(cutoff) as Array<{ name: string; size: number }>;
  let removed = 0;
  let bytes = 0;
  for (const row of rows) {
    try {
      rmSync(trashPath(row.name), { force: true });
      db.prepare("DELETE FROM media_trash WHERE name = ?").run(row.name);
      removed += 1;
      bytes += row.size;
    } catch { /* 权限或占用问题留给下一次维护 */ }
  }
  return { removed, bytes };
}

function listMediaTrash(): MediaTrashItem[] {
  purgeExpiredMediaTrash();
  const rows = db.prepare(
    "SELECT name, size, original_mtime, trashed_at FROM media_trash ORDER BY trashed_at DESC",
  ).all() as Array<{ name: string; size: number; original_mtime: number; trashed_at: number }>;
  const items: MediaTrashItem[] = [];
  for (const row of rows) {
    if (!existsSync(trashPath(row.name))) {
      db.prepare("DELETE FROM media_trash WHERE name = ?").run(row.name);
      continue;
    }
    const url = `/media/${row.name}`;
    const mediaType = mediaTypeOfUrl(url);
    const ext = row.name.slice(row.name.lastIndexOf(".") + 1);
    items.push({
      name: row.name,
      url,
      size: row.size,
      modifiedAt: row.original_mtime,
      mediaKind: mediaType === "file" ? "image" : mediaType,
      mediaType,
      mime: EXT_MIME[ext] ?? "application/octet-stream",
      referenced: false,
      cleanable: false,
      sources: [{ kind: "trash", label: "回收站" }],
      trashedAt: row.trashed_at,
      expiresAt: row.trashed_at + MEDIA_TRASH_RETENTION_MS,
    });
  }
  return items;
}

/** 给运行检查和媒体管理共用的完整快照。 */
export function mediaMaintenanceSnapshot(): MediaMaintenanceSnapshot {
  // 巡检前先把资产表与盘面对齐：用户在界面上看到的「几个文件、哪些没人引用」必须是真的。
  reconcileAssets();
  const scan = scanOrphanMedia();
  const trash = listMediaTrash();
  const byType: MediaMaintenanceSnapshot["byType"] = {
    image: { files: 0, bytes: 0 },
    video: { files: 0, bytes: 0 },
    audio: { files: 0, bytes: 0 },
    file: { files: 0, bytes: 0 },
  };
  for (const item of scan.all) {
    byType[item.mediaType].files += 1;
    byType[item.mediaType].bytes += item.size;
  }
  return {
    ...scan,
    cleanable: scan.items.length,
    trash,
    totalBytes: scan.items.reduce((sum, item) => sum + item.size, 0),
    allBytes: scan.all.reduce((sum, item) => sum + item.size, 0),
    trashBytes: trash.reduce((sum, item) => sum + item.size, 0),
    byType,
    orphanGraceHours: MEDIA_ORPHAN_GRACE_HOURS,
    trashRetentionDays: MEDIA_TRASH_RETENTION_DAYS,
    checkedAt: Date.now(),
  };
}

/**
 * 把确认可清理的文件移到回收站。前端传来的名字不可信：这里重新扫描一次引用和
 * 保护期，只处理这一秒仍然满足条件的文件。移入后保留 7 天，可恢复。
 */
/** 语音文件对应的消息 id。媒体页删除语音时必须回到聊天语义，而不是绕过消息删文件。 */
export function voiceMessageIdsForFile(name: string): number[] {
  if (!/^[a-z0-9]{16}\.(mp3|wav|m4a|ogg|opus|weba)$/.test(name)) return [];
  if (mediaTypeOfUrl("/media/" + name) !== "audio") return [];
  const rows = db.prepare(
    "SELECT id, attachments, attachment_meta FROM messages WHERE attachments LIKE ?",
  ).all(`%${name}%`) as Array<{ id: number; attachments: string; attachment_meta: string | null }>;
  const ids: number[] = [];
  for (const row of rows) {
    let urls: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) urls = parsed.filter((u): u is string => typeof u === "string");
    } catch { continue; }
    if (!urls.includes("/media/" + name)) continue;
    let voice = false;
    try {
      const parsed: unknown = row.attachment_meta ? JSON.parse(row.attachment_meta) : [];
      if (Array.isArray(parsed)) {
        voice = parsed.some((item) => item !== null && typeof item === "object"
          && (item as { url?: unknown; kind?: unknown }).url === "/media/" + name
          && (item as { kind?: unknown }).kind === "audio");
      }
    } catch { voice = true; }
    if (voice || row.attachment_meta === null) ids.push(row.id);
  }
  return [...new Set(ids)];
}

export function trashMediaFiles(names: string[]): MediaMutationResult {
  const wanted = new Set(names.filter((name) => MEDIA_FILE_RE.test(name)));
  if (wanted.size === 0 || !existsSync(MEDIA_DIR)) return { changed: 0, skipped: names.length, bytes: 0 };
  const eligible = new Map(scanOrphanMedia().items.map((item) => [item.name, item]));
  let changed = 0;
  let skipped = 0;
  let bytes = 0;
  const trashedAt = Date.now();
  for (const name of wanted) {
    const item = eligible.get(name);
    if (!item) {
      skipped += 1;
      continue;
    }
    const found = resolveMediaFile(item.url);
    const from = found?.file ?? "";
    const originalRelPath = found?.relPath ?? name;
    const to = trashPath(name);
    if (from === "" || !existsSync(from) || existsSync(to)) {
      skipped += 1;
      continue;
    }
    try {
      db.prepare(
        "INSERT INTO media_trash (name, url, size, original_mtime, trashed_at, original_rel_path) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(name, item.url, item.size, item.modifiedAt, trashedAt, originalRelPath);
      try {
        renameSync(from, to);
      } catch (error) {
        db.prepare("DELETE FROM media_trash WHERE name = ?").run(name);
        throw error;
      }
      changed += 1;
      bytes += item.size;
    } catch {
      skipped += 1;
    }
  }
  return { changed, skipped, bytes };
}

export function restoreMediaFiles(names: string[]): MediaMutationResult {
  const wanted = new Set(names.filter((name) => MEDIA_FILE_RE.test(name)));
  let changed = 0;
  let skipped = 0;
  let bytes = 0;
  for (const name of wanted) {
    const trashed = db.prepare("SELECT size, original_rel_path FROM media_trash WHERE name = ?")
      .get(name) as { size: number; original_rel_path: string } | undefined;
    if (!trashed) {
      skipped += 1;
      continue;
    }
    const from = trashPath(name);
    // 原始相对路径必须在移入回收站时留档：快照对账会清掉“盘上暂时没有”的普通资产行，
    // 恢复时再靠 assets 表就会丢目录，只能回到根目录并失去 /media 身份。
    const assetRow = db.prepare("SELECT rel_path FROM assets WHERE url = ?").get(`/media/${name}`) as { rel_path: string } | undefined;
    const originalRelPath = trashed.original_rel_path !== "" ? trashed.original_rel_path : assetRow?.rel_path ?? "";
    const to = originalRelPath !== "" ? nativePath(originalRelPath) : join(MEDIA_DIR, name);
    if (to === "" || !existsSync(from) || existsSync(to)) {
      skipped += 1;
      continue;
    }
    try {
      if (originalRelPath.includes("/")) ensureDir(originalRelPath.slice(0, originalRelPath.lastIndexOf("/")));
      renameSync(from, to);
      db.prepare("UPDATE assets SET rel_path = ?, missing = 0 WHERE url = ?").run(originalRelPath || name, `/media/${name}`);
      db.prepare("DELETE FROM media_trash WHERE name = ?").run(name);
      changed += 1;
      bytes += trashed.size;
    } catch {
      skipped += 1;
    }
  }
  return { changed, skipped, bytes };
}

/** 永久删除回收站条目；这是唯一会绕过恢复期的用户动作。 */
export function purgeMediaFiles(names: string[]): MediaMutationResult {
  const wanted = new Set(names.filter((name) => MEDIA_FILE_RE.test(name)));
  let changed = 0;
  let skipped = 0;
  let bytes = 0;
  for (const name of wanted) {
    const row = db.prepare("SELECT size FROM media_trash WHERE name = ?").get(name) as { size: number } | undefined;
    if (!row) {
      skipped += 1;
      continue;
    }
    try {
      rmSync(trashPath(name), { force: true });
      db.prepare("DELETE FROM assets WHERE url = ? AND usable_as_emote = 0").run(`/media/${name}`);
      db.prepare("DELETE FROM media_trash WHERE name = ?").run(name);
      changed += 1;
      bytes += row.size;
    } catch {
      skipped += 1;
    }
  }
  return { changed, skipped, bytes };
}

/** 恢复出厂设置时连回收站一起清空。 */
export function emptyMediaTrash(): { removed: number; bytes: number } {
  const rows = db.prepare("SELECT name, size FROM media_trash").all() as Array<{ name: string; size: number }>;
  let removed = 0;
  let bytes = 0;
  for (const row of rows) {
    try {
      rmSync(trashPath(row.name), { force: true });
      removed += 1;
      bytes += row.size;
    } catch { /* 删不掉也把台账清掉，避免下次又冒出来 */ }
  }
  db.prepare("DELETE FROM media_trash").run();
  return { removed, bytes };
}

/**
 * 全量对账：把库里再没人引用的图片文件永久删掉。
 * 用户界面走 trashMediaFiles；这个函数只保留给显式维护/测试，不能在后台静默调用。
 */
export function sweepOrphanMedia(minAgeMs = MEDIA_ORPHAN_GRACE_MS): { removed: number; bytes: number } {
  const scan = scanOrphanMedia(minAgeMs);
  let removed = 0;
  let bytes = 0;
  for (const item of scan.items) {
    const found = resolveMediaFile(item.url);
    if (found === null) continue;
    try {
      rmSync(found.file, { force: true });
      removed += 1;
      bytes += item.size;
    } catch { /* 读不到/删不掉就跳过，下次再试 */ }
  }
  return { removed, bytes };
}
