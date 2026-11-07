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
import { db, reopenDb } from "./db.ts";
import { mediaDir } from "../media/media.ts";
import { skillsDir } from "../mind/skills.ts";

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

// 导入产生的 `.pre-import-*` / `.importing-*` 名字必须是**进程内唯一**的：
// stamp() 只有秒级精度，同一秒内连续两次导入会得到同一个名字——Windows 上
// rename 到已存在的目录直接 EPERM（文件能替换、目录不行），第二次导入整包失败。
// 序号保证不撞名；前缀保持原样供 recoverInterruptedImport 识别。
let importSeq = 0;
function importToken(): string {
  return `${stamp()}-${(++importSeq).toString(36)}`;
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
  // 必须按 UTF-8 写：USTAR 头里的路径是字节字段，ascii 编码会把非 ASCII 字符
  // 截断到低 8 位（「图片」→ 0xFE 0x47），导入侧按 UTF-8 读回来就是乱码目录，
  // 媒体引用会整体断掉。数字字段仍走 writeOctal 的 ascii，不受影响。
  buf.write(value, offset, len, "utf8");
  buf.fill(0, offset + Buffer.byteLength(value, "utf8"), offset + len);
}

function splitUstarName(name: string): { prefix: string; name: string } {
  // USTAR 的 100/155 上限是**字节**不是字符：中文路径按 UTF-8 每字 3 字节，
  // 用字符串长度判断会写出超长头。从最右侧的 '/' 起往左找——最右斜杠给出
  // 最短尾部，若它都超 100 字节则任何切分都装不下。
  if (Buffer.byteLength(name, "utf8") <= 100) return { prefix: "", name };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const tail = name.slice(i + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(tail, "utf8") <= 100) {
      return { prefix, name: tail };
    }
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

function safeArchivePath(raw: string, isDir = false): string {
  if (raw.includes("\\") || raw.includes("\0")) throw new Error("备份含非法路径");
  // 标准 `tar czf` 会给路径加 `./` 前缀；用户在解包目录里重新打包时很常见。
  const path = raw.replace(/^\/+/, "").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  // `tar czf ... .` 会在最前面写一个 `./` 根目录条目。目录可以落在解包根上；
  // 文件不行（那意味着一个没有名字的文件），所以只对 type=5 放行。
  if ((path === "" || path === ".") && isDir) return "";
  if (path === "" || path === "." || path === ".." || path.split("/").includes("..")) {
    throw new Error("备份含非法路径");
  }
  const normalized = path.split("/").filter(Boolean).join("/");
  const allowed = normalized === "manifest.json" || normalized === DB_ENTRY
    || normalized.startsWith("media/") || normalized.startsWith("skills/")
    // 标准 tar 会写目录条目（type=5）：顶层 `media/`、`skills/` 归一化后没有斜杠，
    // 以前会被文件白名单拒掉，导致“重新打包过的合法备份”整包导入失败。
    || (isDir && (normalized === "media" || normalized === "skills"));
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
      const path = safeArchivePath(name, type === "5");
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 异步版 rename：Windows 上杀毒/索引服务会短暂握住刚写完或刚读过的文件句柄，目录改名可能瞬时报 EPERM/EBUSY。 */
async function renameIfExists(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt >= 5) throw error;
      // 必须异步让出事件循环：句柄可能是导出管道刚结束、还没跑完的流关闭
      // finalizer 持有的——同步阻塞反而让它永远没机会释放。
      await sleep(200 * (attempt + 1));
    }
  }
}

function rollbackRename(backupPath: string, livePath: string): void {
  try {
    rmSync(livePath, { force: true, recursive: true });
    if (existsSync(backupPath)) renameSync(backupPath, livePath);
  } catch { /* 保留 .pre-import 备份，错误提示里会引导用户 */ }
}

async function replaceWithStaged(stage: string): Promise<void> {
  const activeDb = resolve(config.dbPath);
  const root = dirname(activeDb);
  mkdirSync(root, { recursive: true });
  const oldSuffix = `.pre-import-${importToken()}`;
  const dbBackup = `${activeDb}${oldSuffix}`;
  const stagedDb = join(stage, DB_ENTRY);

  // 让 SQLite 把 WAL 收进主库；随后这一轮不再允许业务写入。
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // 原子化导入：先把新库拷到临时名，再 rename 到正式名。
  // 这样即使在拷贝过程中断电/崩溃，正式库要么是旧的、要么是新的，不会中间态。
  const tempDb = `${activeDb}.importing-${importToken()}`;
  try {
    // 第一步：把新库拷到临时文件（如果这里失败，旧库还在）
    cpSync(stagedDb, tempDb);
    // 第二步：把旧库改名备份（如果这里失败，清理临时文件）
    try {
      await renameIfExists(activeDb, dbBackup);
    } catch (e) {
      rmSync(tempDb, { force: true });
      throw e;
    }
    // 第三步：把临时文件 rename 为正式库（原子操作）
    try {
      renameSync(tempDb, activeDb);
    } catch (e) {
      // rename 失败：尝试把旧库恢复回去
      rollbackRename(dbBackup, activeDb);
      rmSync(tempDb, { force: true });
      throw e;
    }

    // 导入是“用备份覆盖本机”，不是“按备份补齐本机”：即使归档里没有
    // media/ 或 skills/（用户从未上传过图片、也没装过技能，导出端不会造空目录），
    // 也必须把本机旧目录移走；否则恢复后旧图片/旧技能会残留。
    const trees: Array<[string, string]> = [
      [join(stage, "media"), mediaDir()],
      [join(stage, "skills"), skillsDir()],
    ];
    const moved: Array<[string, string]> = [];
    for (const [from, toRaw] of trees) {
      const to = resolve(toRaw);
      mkdirSync(dirname(to), { recursive: true });
      const old = `${to}${oldSuffix}`;
      await renameIfExists(to, old);
      moved.push([old, to]);
      try {
        if (existsSync(from)) cpSync(from, to, { recursive: true });
      } catch (e) {
        for (const [oldPath, livePath] of moved.reverse()) rollbackRename(oldPath, livePath);
        rollbackRename(dbBackup, activeDb);
        throw e;
      }
    }

    rmSync(`${activeDb}-wal`, { force: true });
    rmSync(`${activeDb}-shm`, { force: true });

    // 成功路径同样必须重开连接：db.close() 之后进程还要继续服务，
    // 不重开的话，用户重启前每个碰库的接口（包括再次导出）都是 "database is not open"。
    reopenDb();
  } catch (error) {
    // 上面的 db.close() 已经执行；无论文件回滚是否成功，都必须把连接重新打开。
    // 否则进程带着 closed 句柄继续服务，之后每个接口都是 "database is not open"，
    // 而这里只回一句“旧数据保留”，用户根本不知道要重启。
    try {
      reopenDb();
    } catch (reopenError) {
      console.error("[import] 回滚后重新打开数据库失败：", reopenError instanceof Error ? reopenError.message : String(reopenError));
    }
    throw new Error(`导入替换失败：${error instanceof Error ? error.message : String(error)}。旧数据保留在 *${oldSuffix} 文件/目录旁`);
  }
}

/**
 * 启动时检测上次导入是否留下残局：.pre-import-* 备份存在但 .importing-* 临时文件也在，
 * 说明上次导入在 rename 后、清理前崩溃了。此时正式库已经是新库，备份可以安全清理；
 * 如果只有 .importing-* 文件（没有对应的 .pre-import-*），说明崩溃在拷贝阶段，
 * 正式库还是旧的，清理临时文件即可。
 */
export function recoverInterruptedImport(): { cleaned: string[]; note: string } {
  const activeDb = resolve(config.dbPath);
  const root = dirname(activeDb);
  if (!existsSync(root)) return { cleaned: [], note: "" };
  const files = readdirSync(root);
  const cleaned: string[] = [];
  for (const name of files) {
    // 清理残留的 .importing-* 临时文件（拷贝中断的产物）
    if (name.includes(".importing-")) {
      try {
        rmSync(join(root, name), { force: true });
        cleaned.push(name);
      } catch { /* 忽略清理失败 */ }
    }
  }
  // 如果存在 .pre-import-* 备份且正式库存在，说明上次导入成功了，备份可以清理
  // （用户可能已经重启并确认数据正常，备份只是占空间）
  // 注意：这里不自动清理 .pre-import-*，因为用户可能需要它恢复数据。
  // 只在日志里提示。
  const preImportBackups = files.filter((n) => n.includes(".pre-import-"));
  if (preImportBackups.length > 0 && existsSync(activeDb)) {
    console.warn(`[import-recovery] 检测到 ${preImportBackups.length} 个 .pre-import-* 备份，正式库已存在。如果数据正常，可手动清理这些备份。`);
  }
  return { cleaned, note: cleaned.length > 0 ? `已清理 ${cleaned.length} 个残留临时文件` : "" };
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
    await replaceWithStaged(stage);
    return {
      ...stats,
      note: `已导入 ${stats.files} 个文件（图片 ${stats.media}、技能 ${stats.skills}）。重启后生效；旧数据已在数据目录中保留为 .pre-import 备份。`,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}




