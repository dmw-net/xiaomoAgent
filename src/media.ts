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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";

const MEDIA_DIR = config.mediaDir === ""
  ? resolve(dirname(resolve(config.dbPath)), "media")
  : resolve(config.mediaDir);

/** 图片上传上限：5MB 足够手机直出的 JPEG/HEIC 转码结果，再大就该客户端先压缩。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
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
};

/** /media/<id>.<ext> 的合法形状；路径穿越在解析文件名这一步就被挡掉。 */
const MEDIA_URL_RE = /^\/media\/([a-z0-9]{16}\.(png|jpg|webp|gif))$/;

/** 当前媒体目录（默认库同级 media/）。改数据位置时照着它搬（data-dir.ts）。 */
export function mediaDir(): string {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
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

/** 媒体目录里的全部 /media 路径（出厂重置用：库清空后这些文件都没人认领了）。
 *  只认 MEDIA_URL_RE 那个形状——目录里若有别人放的文件，不去动它。 */
export function listMediaUrls(): string[] {
  if (!existsSync(MEDIA_DIR)) return [];
  return readdirSync(MEDIA_DIR)
    .filter((name) => MEDIA_URL_RE.test("/media/" + name))
    .map((name) => "/media/" + name);
}

/** 按 /media URL 读回文件内容；不存在或形状不对返回 null。 */
export function readMedia(url: string): { buffer: Buffer; mime: string } | null {
  const match = MEDIA_URL_RE.exec(url);
  const name = match?.[1];
  if (!name) return null;
  const file = resolve(mediaDir(), name);
  if (!file.startsWith(MEDIA_DIR)) return null;
  if (!existsSync(file)) return null;
  const ext = file.slice(file.lastIndexOf(".") + 1);
  return { buffer: readFileSync(file), mime: EXT_MIME[ext] ?? "application/octet-stream" };
}

export function mediaUrlExists(url: string): boolean {
  // 只判断存在，不把整张图读进内存（readMedia 是给真要内容的人用的）
  const name = mediaFileName(url);
  return name !== null && existsSync(join(MEDIA_DIR, name));
}

function mediaFileName(url: string): string | null {
  const name = MEDIA_URL_RE.exec(url)?.[1];
  if (!name) return null;
  const file = resolve(MEDIA_DIR, name);
  return file.startsWith(MEDIA_DIR) ? name : null;
}

/**
 * 回收图片文件：确认库里再无引用才落盘删除。引用检查用 LIKE '%<16位随机hex>%'——误命中概率为零。
 *
 * 认哪几处引用由**这一处**说了算，调用方不必各自想起来加判断：
 * messages / turns 的附件、联系人的头像、长相参考图、画作台账。
 * 之前只查前两处，于是「换参考图」「换头像」「这张图同时是画廊里的一张画」
 * 都得靠调用点自己补一条 `!isArtifactUrl(...)`，漏一个就删掉别人还在引用的文件。
 * 头像改成 /media 形态之后更需要这一收口：同一张图被两位联系人指着是可能的
 * （助手搜到同一张候选给了两位），按引用计数删才安全。
 */
export function releaseMediaFiles(urls: string[]): void {
  if (urls.length === 0) return;
  // 五个 EXISTS 而不是 UNION ALL：SQLite 不接受 `… LIMIT 1 UNION ALL …`
  // （LIMIT 必须在 UNION ALL 之后），那条写法每次调用都抛 SQL logic error——
  // 而调用点 deleteMessage 没有兜异常，于是「删掉一条带图消息」会在事务提交后
  // 报 500：消息其实删了，图片却永久留在磁盘上。
  const probe = db.prepare(
    `SELECT EXISTS(SELECT 1 FROM messages  WHERE attachments LIKE ?) AS in_messages,
            EXISTS(SELECT 1 FROM turns     WHERE attachments LIKE ?) AS in_turns,
            EXISTS(SELECT 1 FROM contacts  WHERE avatar     LIKE ?)  AS in_avatar,
            EXISTS(SELECT 1 FROM contacts  WHERE face_ref   LIKE ?)  AS in_face_ref,
            EXISTS(SELECT 1 FROM artifacts  WHERE url        LIKE ?) AS in_artifact`,
  );
  for (const url of urls) {
    const name = mediaFileName(url);
    if (!name) continue;
    const like = `%${name}%`;
    const ref = probe.get(like, like, like, like, like) as
      { in_messages: number; in_turns: number; in_avatar: number; in_face_ref: number; in_artifact: number };
    if (ref.in_messages || ref.in_turns || ref.in_avatar || ref.in_face_ref || ref.in_artifact) continue;
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

/** 落盘文件名的合法形状：清扫时只认这个，目录里别的东西一律不碰。 */
const MEDIA_FILE_RE = /^[a-z0-9]{16}\.(png|jpg|webp|gif)$/;
const MEDIA_REF_RE = /\/media\/([a-z0-9]{16}\.(?:png|jpg|webp|gif))/g;

/**
 * 全量对账：把库里再没人引用的图片文件删掉。
 *
 * 落盘的触发点只有「删消息 / 编辑换图 / 删联系人」三处，所以传了图没发出去的那些、
 * 以及早期坏 SQL 漏掉的那些会永远留在磁盘上（实测正式库 109 个文件里 103 个没人引用）。
 *
 * 只动 mtime 超过 minAgeMs 的文件——刚上传还没发出去的那张正在用户手里，删不得。
 */
export function sweepOrphanMedia(minAgeMs = 24 * 3_600_000): { removed: number; bytes: number } {
  if (!existsSync(MEDIA_DIR)) return { removed: 0, bytes: 0 };
  const referenced = new Set<string>();
  for (const table of ["messages", "turns"] as const) {
    const rows = db.prepare(`SELECT attachments FROM ${table} WHERE attachments IS NOT NULL`).all() as Array<{ attachments: string }>;
    for (const row of rows) {
      for (const match of String(row.attachments).matchAll(MEDIA_REF_RE)) {
        const name = match[1];
        if (name) referenced.add(name);
      }
    }
  }
  // 联系人身上有两列存的是 /media 路径、从不进任何消息的 attachments：
  // 长相参考图（face_ref）与头像（avatar）。漏了它们，用户的参考图会在下一次维护清理
  // （>24h）被当孤儿删掉，之后每次自拍只得到一句"参考图的文件不在了"；
  // 头像是同一类事故——它一旦改成路径形态，不认它就等于**每 24 小时把人像删一遍**。
  for (const row of db
    .prepare("SELECT avatar, face_ref FROM contacts WHERE avatar <> '' OR face_ref <> ''")
    .all() as Array<{ avatar: string; face_ref: string }>) {
    for (const cell of [row.avatar, row.face_ref]) {
      for (const match of String(cell).matchAll(MEDIA_REF_RE)) {
        const name = match[1];
        if (name) referenced.add(name);
      }
    }
  }
  // 生成产物台账：画成功那一刻就有记录，所以"消息没落地"的图也受保护。
  // 反过来，只有删掉 artifact 行才真正释放文件（删消息不删画）。
  // 这里直接查表而不 import artifacts.ts——那个模块反过来依赖本文件的 releaseMediaFiles。
  for (const row of db.prepare("SELECT url FROM artifacts WHERE url <> ''").all() as Array<{ url: string }>) {
    for (const match of String(row.url).matchAll(MEDIA_REF_RE)) {
      const name = match[1];
      if (name) referenced.add(name);
    }
  }
  let removed = 0;
  let bytes = 0;
  for (const name of readdirSync(MEDIA_DIR)) {
    if (!MEDIA_FILE_RE.test(name) || referenced.has(name)) continue;
    const file = join(MEDIA_DIR, name);
    try {
      const stat = statSync(file);
      // 用 max(0,…) 而不是直接比：这台机器实测「刚写完的文件 mtime 比 Date.now() 晚」
      // 占 186/200 次（最多提前 1.6ms），于是 minAgeMs=0 的全量对账会把它当"未到龄"跳过。
      if (Math.max(0, Date.now() - stat.mtimeMs) < minAgeMs) continue;
      rmSync(file, { force: true });
      removed += 1;
      bytes += stat.size;
    } catch { /* 读不到/删不掉就跳过，下次再试 */ }
  }
  return { removed, bytes };
}
