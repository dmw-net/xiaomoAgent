// 跨客户端数据迁移：导出/导入一份自描述 tar.gz 归档。
//
// 归档内只放三类用户数据：
//   xiaomo.db  对话、记忆、联系人、模型设置/密钥等 SQLite 数据
//   media/     聊天图片等库外二进制
//   skills/    用户自定义技能
// 不放 desktop.json / runtime.json：它们是本机外壳、端口和数据目录指针，
// 原样带到另一台电脑反而可能把新客户端指到一个不存在的路径。
//
// 为什么手写最小 USTAR tar + 内置 zlib：项目坚持 Node 内置能力、零原生依赖；
// 用户也不需要手工解压，.tar.gz 只是一个稳妥的单文件容器。

import { backup, DatabaseSync } from "node:sqlite";
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, type Gzip } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { mediaDir } from "./media.ts";
import { skillsDir } from "./skills.ts";

const ARCHIVE_APP = "xiaomo-ai";
const ARCHIVE_FORMAT = "data-archive";
const ARCHIVE_VERSION = 1;
const DB_ENTRY = "xiaomo.db";
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 20_000;
const BLOCK = 512;

type ExportStats = { files: number; media: number; skills: number; bytes: number };
export type ImportResult = { files: number; media: number; skills: number; bytes: number; note: string };

type TarFile = {
  path: string;
  size: number;
  mtime: number;
  createReadStream?: () => Readable;
  buffer?: Buffer;
};

function stamp(): string {
  const d = new Date();
  const p = (n: number, len = 2): string => String(n).padStart(len, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}


function listTree(root: string, prefix: string, stats: { files: number; bytes: number }): TarFile[] {
  if (!existsSync(root)) return [];
  const out: TarFile[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split(sep).join("/");
      const name = prefix.endsWith("/") ? prefix + rel : `${prefix}/${rel}`;
      // 显式拒绝符号链接/硬链接等非常规文件：备份文件不该在恢复时绕到数据目录外。
      const st = lstatSync(abs);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.isFile() && st.isFile()) {
        out.push({ path: name, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), createReadStream: () => createReadStream(abs) });
        stats.files += 1;
        stats.bytes += st.size;
      }
    }
  };
  walk(root);
  return out;
}


function collectExportFiles(dbBackup: string): { files: TarFile[]; stats: ExportStats } {
  const now = Math.floor(Date.now() / 1000);
  const stats = { files: 0, media: 0, skills: 0, bytes: 0 };
  const manifest = Buffer.from(JSON.stringify({
    app: ARCHIVE_APP,
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    db: DB_ENTRY,
    roots: ["media/", "skills/"],
  }, null, 2));

  const beforeMedia = stats.files;
  const mediaFiles = listTree(mediaDir(), "media", stats);
  stats.media = stats.files - beforeMedia;
  const beforeSkills = stats.files;
  const skillFiles = listTree(skillsDir(), "skills", stats);
  stats.skills = stats.files - beforeSkills;

  const dbStat = lstatSync(dbBackup);
  const dbFile: TarFile = { path: DB_ENTRY, size: dbStat.size, mtime: Math.floor(dbStat.mtimeMs / 1000), createReadStream: () => createReadStream(dbBackup) };
  stats.files += 1;
  stats.bytes += dbStat.size + manifest.length;

  return {
    files: [
      { path: "manifest.json", size: manifest.length, mtime: now, buffer: manifest },
      dbFile,
      ...mediaFiles,
      ...skillFiles,
    ],
    stats,
  };
}

function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  buf.write(value.toString(8).padStart(len - 1, "0").slice(-(len - 1)) + "\0", offset, len, "ascii");
}

function writeString(buf: Buffer, offset: number, len: number, value: string): void {
  buf.write(value, offset, len, "ascii");
  buf.fill(0, offset + Buffer.byteLength(value, "ascii"), offset + len);
}

function splitUstarName(name: string): { prefix: string; name: string } {
  if (name.length <= 100) return { prefix: "", name };
  for (let i = 100; i > 0; i--) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const tail = name.slice(i + 1);
    if (prefix.length <= 155 && tail.length <= 100) return { prefix, name: tail };
  }
  throw new Error("归档内路径过长");
}

function tarHeader(file: TarFile): Buffer {
  const block = Buffer.alloc(BLOCK);
  const parts = splitUstarName(file.path);
  writeString(block, 0, 100, parts.name);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, file.size);
  writeOctal(block, 136, 12, file.mtime);
  // checksum 先放空格，再按 ustar 惯例写六位八进制 + NUL + space。
  block.write("        ", 148, 8, "ascii");
  block.write("0", 156, 1, "ascii"); // regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  if (parts.prefix) writeString(block, 345, 155, parts.prefix);
  let sum = 0;
  for (const b of block) sum += b;
  block.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  block.write("\0 ", 154, 2, "ascii");
  return block;
}

async function* tarEntries(files: TarFile[]): AsyncGenerator<Buffer> {
  for (const file of files) {
    yield tarHeader(file);
    if (file.buffer) {
      yield file.buffer;
    } else if (file.createReadStream) {
      for await (const chunk of file.createReadStream()) yield chunk as Buffer;
    }
    const pad = (BLOCK - (file.size % BLOCK)) % BLOCK;
    if (pad > 0) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** 一键导出：直接把 gzip tar 流写给响应，不把整份备份缓冲在内存里。 */
export async function writeDataExport(response: ServerResponse): Promise<ExportStats> {
  const tmp = join(tmpdir(), `xiaomo-export-${process.pid}-${Date.now()}.db`);
  await backup(db as DatabaseSync, tmp);
  try {
    const { files, stats } = collectExportFiles(tmp);
    const fileName = `xiaomo-backup-${stamp()}.tar.gz`;
    response.writeHead(200, {
      "content-type": "application/gzip",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    await pipeline(Readable.from(tarEntries(files)), createGzip({ level: 6 }), response);
    return { files: stats.files, media: stats.media, skills: stats.skills, bytes: stats.bytes };
  } finally {
    rmSync(tmp, { force: true });
  }
}

class AsyncChunkReader {
  #iterator: AsyncIterator<Buffer>;
  #leftover: Buffer[] = [];
  #leftoverSize = 0;
  #done = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #pull(): Promise<boolean> {
    if (this.#done) return false;
    const r = await this.#iterator.next();
    if (r.done) {
      this.#done = true;
      return false;
    }
    const buf = r.value;
    if (buf.length > 0) {
      this.#leftover.push(buf);
      this.#leftoverSize += buf.length;
    }
    return true;
  }

  async exact(size: number, onChunk?: (buf: Buffer) => Promise<void> | void): Promise<Buffer | null> {
    if (size === 0) return Buffer.alloc(0);
    const out: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      while (this.#leftoverSize === 0 && !(await this.#pull())) {
        if (remaining === size && out.length === 0) return null;
        throw new Error("备份文件不完整：提前结束了");
      }
      const part = this.#leftover.shift();
      if (!part) continue;
      this.#leftoverSize -= part.length;
      const take = part.subarray(0, Math.min(part.length, remaining));
      remaining -= take.length;
      if (onChunk) await onChunk(take);
      else out.push(Buffer.from(take));
      if (take.length < part.length) {
        const rest = part.subarray(take.length);
        this.#leftover.unshift(rest);
        this.#leftoverSize += rest.length;
      }
    }
    return onChunk ? Buffer.alloc(0) : Buffer.concat(out);
  }
}

function octalString(buf: Buffer, offset: number, len: number): number {
  const raw = buf.toString("ascii", offset, offset + len).replace(/[\0\s]/g, "");
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error("备份文件不是合法 tar：数字字段损坏");
  return parseInt(raw, 8);
}

function safeArchivePath(raw: string): string {
  if (raw.includes("\\") || raw.includes("\0")) throw new Error("备份含非法路径");
  const path = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path === "" || path === "." || path === ".." || path.split("/").includes("..")) {
    throw new Error("备份含非法路径");
  }
  const normalized = path.split("/").filter(Boolean).join("/");
  const allowed = normalized === "manifest.json" || normalized === DB_ENTRY
    || normalized.startsWith("media/") || normalized.startsWith("skills/");
  if (!allowed) throw new Error(`备份含不在允许范围内的文件：${normalized}`);
  return normalized;
}

function ensureInside(base: string, target: string): void {
  const root = resolve(base) + sep;
  if (!(resolve(target) + sep).startsWith(root) && resolve(target) !== resolve(base)) {
    throw new Error("备份解包路径逃逸，已拒绝");
  }
}

async function extractTarGzip(request: IncomingMessage, stage: string): Promise<ExportStats> {
  let compressed = 0;
  let uncompressed = 0;
  let files = 0;
  let media = 0;
  let skills = 0;

  request.on("data", (chunk: Buffer) => {
    compressed += chunk.length;
    if (compressed > MAX_COMPRESSED_BYTES) request.destroy(new Error("备份压缩后体积超过 4GB 上限"));
  });

  const gunzip: Gzip = createGunzip();
  const pipeDone = pipeline(request, gunzip).catch((error) => error);
  const reader = new AsyncChunkReader(gunzip as unknown as AsyncIterable<Buffer>);

  try {
    while (true) {
      const header = await reader.exact(BLOCK);
      if (header === null) break;
      if (header.every((b) => b === 0)) {
        // tar 末尾是两个零块；读到第一个即可，剩余 padding 不再需要。
        break;
      }
      const type = header.toString("ascii", 156, 157);
      if (type !== "0" && type !== "\0" && type !== "5") {
        throw new Error("备份含符号链接、硬链接或其它不受支持的 tar 条目");
      }
      let name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
      const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/s, "");
      if (prefix) name = `${prefix}/${name}`;
      const path = safeArchivePath(name);
      const size = octalString(header, 124, 12);
      uncompressed += BLOCK + size;
      if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("备份解压后体积超过 8GB 上限");

      if (type === "5") {
        const dir = join(stage, ...path.split("/"));
        ensureInside(stage, dir);
        mkdirSync(dir, { recursive: true });
        const padding = (BLOCK - (size % BLOCK)) % BLOCK;
        await reader.exact(size + padding);
        continue;
      }

      files += 1;
      if (files > MAX_ARCHIVE_FILES) throw new Error("备份文件数量超过 20,000 个上限");
      if (path.startsWith("media/")) media += 1;
      if (path.startsWith("skills/")) skills += 1;

      const target = join(stage, ...path.split("/"));
      ensureInside(stage, target);
      mkdirSync(dirname(target), { recursive: true });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const out = createWriteStream(target);
        let written = 0;
        out.on("error", rejectPromise);
        void reader.exact(size, async (buf) => {
          written += buf.length;
          if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
        }).then(() => {
          if (written !== size) rejectPromise(new Error("备份文件内容长度不一致"));
          else out.end(() => resolvePromise());
        }).catch(rejectPromise);
      });
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      await reader.exact(padding);
    }
  } finally {
    gunzip.destroy();
    const pipeError = await pipeDone;
    if (pipeError instanceof Error && pipeError.name !== "ERR_STREAM_PREMATURE_CLOSE") throw pipeError;
  }

  if (!existsSync(join(stage, "manifest.json"))) throw new Error("缺少 manifest.json，不是小茉数据备份");
  if (!existsSync(join(stage, DB_ENTRY))) throw new Error("缺少 xiaomo.db，备份不完整");
  return { files, media, skills, bytes: uncompressed };
}

function validateStagedDatabase(file: string): void {
  let check: DatabaseSync | null = null;
  try {
    check = new DatabaseSync(file, { readOnly: true }) as DatabaseSync;
    const row = check.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== "ok") throw new Error("备份数据库完整性检查没通过");
  } finally {
    try { check?.close(); } catch { /* 忽略关闭错误，原始校验错误优先 */ }
  }
}

function renameIfExists(from: string, to: string): void {
  if (existsSync(from)) renameSync(from, to);
}

function rollbackRename(backupPath: string, livePath: string): void {
  try {
    rmSync(livePath, { force: true, recursive: true });
    if (existsSync(backupPath)) renameSync(backupPath, livePath);
  } catch { /* 保留 .pre-import 备份，错误提示里会引导用户 */ }
}

function replaceWithStaged(stage: string): void {
  const activeDb = resolve(config.dbPath);
  const root = dirname(activeDb);
  mkdirSync(root, { recursive: true });
  const oldSuffix = `.pre-import-${stamp()}`;
  const dbBackup = `${activeDb}${oldSuffix}`;
  const stagedDb = join(stage, DB_ENTRY);

  // 让 SQLite 把 WAL 收进主库；随后这一轮不再允许业务写入。
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  try {
    renameIfExists(activeDb, dbBackup);
    try {
      cpSync(stagedDb, activeDb);
    } catch (e) {
      rollbackRename(dbBackup, activeDb);
      throw e;
    }

    const trees: Array<[string, string]> = [
      [join(stage, "media"), mediaDir()],
      [join(stage, "skills"), skillsDir()],
    ];
    const moved: Array<[string, string]> = [];
    for (const [from, toRaw] of trees) {
      if (!existsSync(from)) continue;
      const to = resolve(toRaw);
      mkdirSync(dirname(to), { recursive: true });
      const old = `${to}${oldSuffix}`;
      renameIfExists(to, old);
      moved.push([old, to]);
      try {
        cpSync(from, to, { recursive: true });
      } catch (e) {
        for (const [oldPath, livePath] of moved.reverse()) rollbackRename(oldPath, livePath);
        rollbackRename(dbBackup, activeDb);
        throw e;
      }
    }

    rmSync(`${activeDb}-wal`, { force: true });
    rmSync(`${activeDb}-shm`, { force: true });
  } catch (error) {
    throw new Error(`导入替换失败：${error instanceof Error ? error.message : String(error)}。旧数据保留在 *${oldSuffix} 文件/目录旁`);
  }
}

/** 一键导入：先流式解到临时目录并校验，再替换库与媒体/技能目录。完成后必须重启。 */
export async function importDataArchive(request: IncomingMessage): Promise<ImportResult> {
  const stage = mkdtempSync(join(tmpdir(), "xiaomo-import-"));
  try {
    const stats = await extractTarGzip(request, stage);
    const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as {
      app?: unknown; format?: unknown; version?: unknown;
    };
    if (manifest.app !== ARCHIVE_APP || manifest.format !== ARCHIVE_FORMAT) {
      throw new Error("manifest 不匹配：这不是小茉导出的数据备份");
    }
    if (manifest.version !== ARCHIVE_VERSION) throw new Error("备份版本不受支持");
    validateStagedDatabase(join(stage, DB_ENTRY));
    replaceWithStaged(stage);
    return {
      ...stats,
      note: `已导入 ${stats.files} 个文件（图片 ${stats.media}、技能 ${stats.skills}）。重启后生效；旧数据已在数据目录中保留为 .pre-import 备份。`,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}




