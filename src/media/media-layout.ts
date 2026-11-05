// 媒体目录布局：文件名是身份，目录是分类，URL 永远是 /media/<文件名> 且永不因挪动而变。
//
// 为什么这样切：表情归属文件夹是用户会反复改的东西（导入、弹窗改归属、退回、甚至直接在
// 资源管理器里拖）。如果目录进 URL，每次改归属都要重写 messages/turns/contacts/artifacts/kv
// 里的字符串引用——那是二十个模块各自记得同步的灾难。身份锚在文件名上之后，
// 改归属=磁盘 rename + 本表一行 rel_path，别处一个字都不用动。
//
// 目录形状：
//   media/表情包/<文件夹>/<文件>   表情素材；文件夹层直接映射到磁盘，用户可以直接往里丢
//   media/图片|视频|语音|文件/     非表情的媒体，按类型分
//   media/<文件>                  迁移前的遗留位置，只读兼容，对账会把它归位
//   media/.trash/                 回收站（不参与扫描）
//
// 兜底规则（对账每次执行，全部可逆、永不静默删用户文件）：
//   库里没有、盘上有 → 按位置登记（表情包/ 下自动认领成表情并取目录名当文件夹）
//   库里有、rel_path 上找不到 → 按内容哈希全树找：找到=用户挪过，改地址；找不到=标失效
//   失效行再见同名/同哈希文件 → 复活
//   哈希撞上已有健康行 → 不登记、计入报告（重复文件）

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { config } from "../core/config.ts";
import { db } from "../core/db.ts";

export const MEDIA_DIR = config.mediaDir === ""
  ? resolve(dirname(resolve(config.dbPath)), "media")
  : resolve(config.mediaDir);

/** 表情根目录与各类型的落点。界面文案（「打开文件夹」）与后端同一组词，别再各处手写。 */
export const EMOTE_ROOT = "表情包";
export const KIND_DIR: Record<"image" | "video" | "audio" | "file", string> = {
  image: "图片", video: "视频", audio: "语音", file: "文件",
};
export const DEFAULT_FOLDER = "默认";

/** 文件夹名会直接成为磁盘目录名：挡掉 Windows 非法字符与穿越形状，空/被掏空的回默认。 */
export function sanitizeFolder(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/^\.+/, "").trim().slice(0, 40).trim();
  return cleaned === "" ? DEFAULT_FOLDER : cleaned;
}

/** relPath 一律用正斜杠存；上盘时再转成本机分隔符，并挡住跑出媒体目录的路径。 */
export function nativePath(relPath: string): string {
  const file = resolve(MEDIA_DIR, relPath.split("/").join(sep));
  return file === MEDIA_DIR || file.startsWith(MEDIA_DIR + sep) ? file : "";
}

/** 目录（相对 media）：表情在 表情包/<文件夹>，其余按类型。 */
export function dirFor(opts: { emote: boolean; folder?: string; kind: "image" | "video" | "audio" | "file" }): string {
  return opts.emote ? `${EMOTE_ROOT}/${sanitizeFolder(opts.folder ?? "")}` : KIND_DIR[opts.kind];
}

/** 保证目录存在并返回绝对路径。 */
export function ensureDir(relDir: string): string {
  const dir = nativePath(relDir);
  if (dir !== "" && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function nameOfUrl(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

/** 当前库里认得的落点；空 rel_path 的行先按遗留平铺位置看。 */
export function currentFileOf(url: string): { file: string; relPath: string } | null {
  const row = db.prepare("SELECT rel_path FROM assets WHERE url = ?").get(url) as { rel_path: string } | undefined;
  if (row === undefined) return null;
  const rel = row.rel_path !== "" ? row.rel_path : nameOfUrl(url);
  const file = nativePath(rel);
  return file !== "" && existsSync(file) ? { file, relPath: rel } : null;
}

/** 把文件挪到目标目录并记账。目标已存在、源不在盘上、改名失败都原样返回 false，不动数据。 */
export function relocate(url: string, targetRelDir: string): { ok: boolean; relPath: string } {
  const name = nameOfUrl(url);
  const target = targetRelDir === "" ? name : `${targetRelDir}/${name}`;
  const cur = currentFileOf(url);
  if (cur === null) return { ok: false, relPath: target };
  if (cur.relPath === target) return { ok: true, relPath: target };
  const to = nativePath(target);
  if (to === "" || existsSync(to)) return { ok: false, relPath: cur.relPath };
  ensureDir(targetRelDir);
  try {
    renameSync(cur.file, to);
  } catch {
    return { ok: false, relPath: cur.relPath };
  }
  db.prepare("UPDATE assets SET rel_path = ? WHERE url = ?").run(target, url);
  return { ok: true, relPath: target };
}

/** 表情归属变了就跟着搬；文件不在盘上（失效行）只改库不碰磁盘。 */
export function syncEmoteLocation(url: string, pack: string[], usable: boolean): void {
  if (!usable) return;
  relocate(url, `${EMOTE_ROOT}/${sanitizeFolder(pack[0] ?? "")}`);
}

export type WalkEntry = { relPath: string; name: string; dir: string; size: number };

const EXT_RE = /\.(png|jpg|jpeg|webp|gif|bmp|mp4|webm|mp3|wav|m4a|ogg|opus|weba)$/i;

/** 递归列媒体树。跳过 . 开头的目录（.trash）与不认识的扩展名；深度封顶，目录里不跟符号链接。 */
export function walkMediaTree(): WalkEntry[] {
  const out: WalkEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!ent.isFile() || !EXT_RE.test(ent.name)) continue;
      let st;
      try { st = statSync(abs); } catch { continue; }
      const relPath = abs.slice(MEDIA_DIR.length + 1).split(sep).join("/");
      out.push({ relPath, name: ent.name, dir: relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "", size: st.size });
    }
  };
  if (existsSync(MEDIA_DIR)) walk(MEDIA_DIR, 0);
  return out;
}

/** 表情包/<X>/ 下的文件 → 文件夹名 X；其它位置返回 null。 */
export function emoteFolderOfDir(relDir: string): string | null {
  const parts = relDir.split("/");
  const folder = parts[1];
  return parts.length === 2 && parts[0] === EMOTE_ROOT && folder !== undefined && folder !== "" ? folder : null;
}

export function hashFile(file: string): string {
  try {
    return createHash("md5").update(readFileSync(file)).digest("hex");
  } catch { return ""; }
}

/** 新文件入库前的 id：文件名去扩展名；形状不合（用户随手丢的怪名）就随机，避免主键撞库。 */
export function idForName(name: string): { id: string; ext: string } {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const id = /^[a-z0-9]{8,32}$/.test(base) ? base : randomBytes(8).toString("hex");
  return { id, ext };
}

const FLAG_KEY = "media.layout.v2";
const REPORT_KEY = "media.layout.report";

export function layoutMigrated(): boolean {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(FLAG_KEY) as { v: string } | undefined;
  return (row?.v ?? "") === "1";
}

export function lastLayoutReport(): string {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(REPORT_KEY) as { v: string } | undefined;
  return row?.v ?? "";
}

function setKv(k: string, v: string): void {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

/**
 * 一次性存量迁移：把平铺文件按规则搬进目录并记 rel_path。幂等（kv 标记 + 逐行按现状判断），
 * 迁移前先 VACUUM INTO 一份库备份。表情看 pack 列，派生形态跟父资产同目录，其余按类型。
 */
export function migrateMediaLayout(): { moved: number; skipped: number; backup: string } {
  if (layoutMigrated()) return { moved: 0, skipped: 0, backup: "" };
  const rows = db.prepare(
    "SELECT id, url, kind, rel_path, usable_as_emote, emote_pack, parent_id FROM assets ORDER BY parent_id IS NULL DESC, created_at ASC",
  ).all() as Array<{ id: string; url: string; kind: string; rel_path: string; usable_as_emote: number; emote_pack: string; parent_id: string | null }>;
  let backup = "";
  if (rows.length > 0) {
    backup = join(MEDIA_DIR, "..", `xiaomo.backup-prelayout-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    db.prepare("VACUUM INTO ?").run(backup);
  }
  const parentDir = new Map<string, string>();
  let moved = 0; let skipped = 0;
  for (const row of rows) {
    const name = nameOfUrl(row.url);
    const cur = row.rel_path !== "" ? row.rel_path : name;
    const file = nativePath(cur);
    if (file === "" || !existsSync(file)) { skipped += 1; continue; }
    let target: string;
    if (row.parent_id !== null) {
      const pd = parentDir.get(row.parent_id);
      target = `${pd ?? KIND_DIR[(row.kind in KIND_DIR ? row.kind : "image") as keyof typeof KIND_DIR]}/${name}`;
    } else if (Number(row.usable_as_emote) === 1) {
      let pack: string[] = [];
      try { pack = JSON.parse(row.emote_pack || "[]"); } catch { pack = []; }
      target = `${EMOTE_ROOT}/${sanitizeFolder(String(pack[0] ?? ""))}/${name}`;
    } else {
      const kind = (row.kind in KIND_DIR ? row.kind : "image") as keyof typeof KIND_DIR;
      target = `${KIND_DIR[kind]}/${name}`;
    }
    parentDir.set(row.id, target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "");
    if (cur === target) { skipped += 1; continue; }
    const to = nativePath(target);
    if (to === "" || existsSync(to)) { skipped += 1; continue; }
    ensureDir(target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "");
    try {
      renameSync(file, to);
      db.prepare("UPDATE assets SET rel_path = ? WHERE id = ?").run(target, row.id);
      moved += 1;
    } catch { skipped += 1; }
  }
  setKv(FLAG_KEY, "1");
  return { moved, skipped, backup };
}

/** 对账回执落盘（设置里的「媒体对账」读它）；每轮覆盖，带时间戳。 */
export function writeReconcileReport(counts: Record<string, number>): void {
  setKv(REPORT_KEY, JSON.stringify({ ...counts, at: Date.now() }));
}
