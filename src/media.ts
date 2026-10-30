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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { MessageAttachmentMeta } from "../shared/api.ts";

const MEDIA_DIR = config.mediaDir === ""
  ? resolve(dirname(resolve(config.dbPath)), "media")
  : resolve(config.mediaDir);

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

/** /media/<id>.<ext> 的合法形状；路径穿越在解析文件名这一步就被挡掉。 */
const MEDIA_URL_RE = /^\/media\/([a-z0-9]{16}\.(png|jpg|webp|gif|mp4|webm|mp3|wav|m4a|ogg|opus|weba))$/;

/**
 * 壁纸文件的形状：wp 前缀 + 16 位随机 id。前缀就是它的「引用在 localStorage、不在库里」
 * 的身份证明——sweepOrphanMedia 只认无前缀形状，壁纸因此天然免于被当孤儿清掉；
 * 释放改由「换壁纸时删旧文件」与出厂重置负责。
 */
const WALLPAPER_URL_RE = /^\/media\/(wp[a-z0-9]{16}\.(png|jpg|webp|gif|mp4|webm))$/;

/** 落盘文件名的合法形状；回收/清理时只认这个，目录里别的东西一律不碰。 */
const MEDIA_FILE_RE = /^[a-z0-9]{16}\.(png|jpg|webp|gif|mp4|webm|mp3|wav|m4a|ogg|opus|weba)$/;
const MEDIA_REF_RE = /\/media\/([a-z0-9]{16}\.(?:png|jpg|webp|gif|mp4|webm|mp3|wav|m4a|ogg|opus|weba))/g;

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

/** 壁纸文件也用 /media/ 前缀下发：读取与存在性判断认两种形状。 */
function anyMediaFileName(url: string): string | null {
  const name = MEDIA_URL_RE.exec(url)?.[1] ?? WALLPAPER_URL_RE.exec(url)?.[1];
  if (!name) return null;
  const file = resolve(MEDIA_DIR, name);
  return file.startsWith(MEDIA_DIR) ? name : null;
}

/** 存一张图，返回可直接回给前端的 /media URL。mime 不在白名单时抛错。 */
export function saveImage(buffer: Buffer, mime: string): { url: string; id: string } {
  const ext = IMAGE_EXT[mime];
  if (!ext) throw new Error("图片格式不支持（仅 png / jpg / webp / gif）");
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片大小需在 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB 以内`);
  }
  const id = randomBytes(8).toString("hex");
  writeFileSync(join(mediaDir(), `${id}.${ext}`), buffer);
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
  writeFileSync(join(mediaDir(), `${id}.${ext}`), buffer);
  return { url: `/media/${id}.${ext}`, id, mime };
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
  writeFileSync(join(mediaDir(), `${id}.${ext}`), buffer);
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
  writeFileSync(join(mediaDir(), `${id}.${ext}`), buffer);
  return { url: `/media/${id}.${ext}`, id };
}

/** 删一个壁纸文件：形状必须是 wp 前缀（普通聊天图片有自己的回收通道，别走到这）。 */
export function deleteWallpaper(url: string): void {
  const match = WALLPAPER_URL_RE.exec(url);
  const name = match?.[1];
  if (!name) return;
  const file = resolve(MEDIA_DIR, name);
  if (!file.startsWith(MEDIA_DIR)) return;
  try {
    rmSync(file, { force: true });
  } catch { /* 删不掉就算了，留给出厂重置 */ }
}

/** 媒体文件元信息：/media/ 路由给视频与语音做 Range 流式播放，不把整个文件读进内存。 */
export function mediaFileInfo(url: string): { file: string; mime: string; size: number } | null {
  const name = anyMediaFileName(url);
  if (!name) return null;
  const file = resolve(MEDIA_DIR, name);
  if (!file.startsWith(MEDIA_DIR) || !existsSync(file)) return null;
  const ext = file.slice(file.lastIndexOf(".") + 1);
  return { file, mime: EXT_MIME[ext] ?? "application/octet-stream", size: statSync(file).size };
}

/** 媒体目录里的全部 /media 路径（出厂重置用：库清空后这些文件都没人认领了）。
 *  只认两个 URL 形状（聊天图片 / 壁纸）——目录里若有别人放的文件，不去动它。 */
export function listMediaUrls(): string[] {
  if (!existsSync(MEDIA_DIR)) return [];
  return readdirSync(MEDIA_DIR)
    .filter((name) => MEDIA_URL_RE.test("/media/" + name) || WALLPAPER_URL_RE.test("/media/" + name))
    .map((name) => "/media/" + name);
}

/** 按 /media URL 读回文件内容；不存在或形状不对返回 null。 */
export function readMedia(url: string): { buffer: Buffer; mime: string } | null {
  const name = anyMediaFileName(url);
  if (!name) return null;
  const file = resolve(mediaDir(), name);
  if (!existsSync(file)) return null;
  const ext = file.slice(file.lastIndexOf(".") + 1);
  return { buffer: readFileSync(file), mime: EXT_MIME[ext] ?? "application/octet-stream" };
}

export function mediaUrlExists(url: string): boolean {
  // 只判断存在，不把整张图读进内存（readMedia 是给真要内容的人用的）
  const name = anyMediaFileName(url);
  return name !== null && existsSync(join(MEDIA_DIR, name));
}

function mediaFileName(url: string): string | null {
  return anyMediaFileName(url);
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
    const name = mediaFileName(url);
    if (!name) continue;
    const like = `%${name}%`;
    const ref = probe.get(like, like, like, like, like, like, like) as
      { in_messages: number; in_turns: number; in_avatar: number; in_face_ref: number; in_artifact: number; in_tool_detail: number; in_kv: number };
    if (ref.in_messages || ref.in_turns || ref.in_avatar || ref.in_face_ref || ref.in_artifact || ref.in_tool_detail || ref.in_kv) continue;
    try {
      rmSync(join(MEDIA_DIR, name), { force: true });
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
 * 图片的真约束是**字节不是 token**（实测 1280x960 只算 974 token，却要重传 130-530KB），
 * 所以重放预算按这个数算。只 stat 不读内容——量体积不该把图整个拉进内存。
 * 40 是 `data:image/jpeg;base64,` 头加 JSON 的引号与键名的余量。
 */
export function dataUrlBytes(url: string): number | null {
  const name = mediaFileName(url);
  if (!name) return null;
  const file = join(MEDIA_DIR, name);
  if (!existsSync(file)) return null;
  return Math.ceil(statSync(file).size / 3) * 4 + 40;
}

export type MediaSourceKind = "avatar" | "face_ref" | "chat" | "voice" | "turn" | "artifact" | "tool" | "setting" | "wallpaper" | "none" | "trash";

export type MediaSource = {
  kind: MediaSourceKind;
  label: string;
  detail?: string;
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
          messageId: row.id,
          durationMs: typeof voice.durationMs === "number" ? voice.durationMs : undefined,
          transcript: typeof voice.transcript === "string" ? voice.transcript : undefined,
        });
      } else {
        addName(name, { kind: "chat", label: "聊天", detail: contactDetail(row.contact_id) || undefined, messageId: row.id });
      }
    }
  }
  for (const row of db.prepare(
    "SELECT contact_id, tool_detail FROM messages WHERE tool_detail LIKE '%/media/%'",
  ).all() as Array<{ contact_id: string | null; tool_detail: string }>) {
    add(row.tool_detail, { kind: "tool", label: "工具记录", detail: contactDetail(row.contact_id) || undefined });
  }
  for (const row of db.prepare(
    "SELECT contact_id, attachments, attachment_meta FROM turns WHERE attachments LIKE '%/media/%'",
  ).all() as Array<{ contact_id: string | null; attachments: string; attachment_meta: string | null }>) {
    const meta = voiceUrls(row.attachment_meta);
    for (const match of row.attachments.matchAll(MEDIA_REF_RE)) {
      const name = match[1];
      if (!name) continue;
      const voice = meta.get("/media/" + name);
      addName(name, voice
        ? { kind: "voice", label: "语音消息", detail: contactDetail(row.contact_id) || undefined }
        : { kind: "turn", label: "回复任务", detail: contactDetail(row.contact_id) || undefined });
    }
  }
  for (const row of db.prepare(
    "SELECT id, name, avatar, face_ref FROM contacts WHERE avatar LIKE '%/media/%' OR face_ref LIKE '%/media/%'",
  ).all() as Array<{ id: string; name: string; avatar: string; face_ref: string }>) {
    add(row.avatar, { kind: "avatar", label: "头像", detail: row.name });
    add(row.face_ref, { kind: "face_ref", label: "长相参考", detail: row.name });
  }
  for (const row of db.prepare(
    "SELECT contact_id, url FROM artifacts WHERE url LIKE '%/media/%'",
  ).all() as Array<{ contact_id: string; url: string }>) {
    add(row.url, { kind: "artifact", label: "作品", detail: contactDetail(row.contact_id) || undefined });
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

/** 扫描媒体目录中的全部文件；items 只包含已经可以安全清理的那部分。 */
export function scanOrphanMedia(minAgeMs = MEDIA_ORPHAN_GRACE_MS): MediaScan {
  if (!existsSync(MEDIA_DIR)) return { files: 0, referenced: 0, pending: 0, items: [], all: [] };
  const sourceMap = collectMediaSources();
  const now = Date.now();
  let files = 0;
  let referenced = 0;
  let pending = 0;
  const items: MediaMaintenanceItem[] = [];
  const all: MediaMaintenanceItem[] = [];
  for (const entry of readdirSync(MEDIA_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const url = `/media/${entry.name}`;
    const wallpaper = WALLPAPER_URL_RE.test(url);
    if (!wallpaper && !MEDIA_FILE_RE.test(entry.name)) continue;
    const file = join(MEDIA_DIR, entry.name);
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
    const from = join(MEDIA_DIR, name);
    const to = trashPath(name);
    if (!existsSync(from) || existsSync(to)) {
      skipped += 1;
      continue;
    }
    try {
      db.prepare(
        "INSERT INTO media_trash (name, url, size, original_mtime, trashed_at) VALUES (?, ?, ?, ?, ?)",
      ).run(name, item.url, item.size, item.modifiedAt, trashedAt);
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
    const row = db.prepare("SELECT size FROM media_trash WHERE name = ?").get(name) as { size: number } | undefined;
    if (!row) {
      skipped += 1;
      continue;
    }
    const from = trashPath(name);
    const to = join(MEDIA_DIR, name);
    if (!existsSync(from) || existsSync(to)) {
      skipped += 1;
      continue;
    }
    try {
      renameSync(from, to);
      db.prepare("DELETE FROM media_trash WHERE name = ?").run(name);
      changed += 1;
      bytes += row.size;
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
    try {
      rmSync(join(MEDIA_DIR, item.name), { force: true });
      removed += 1;
      bytes += item.size;
    } catch { /* 读不到/删不掉就跳过，下次再试 */ }
  }
  return { removed, bytes };
}
