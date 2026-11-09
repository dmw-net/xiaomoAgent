// 路由的传输层原语：响应发送、静态文件（ETag/304 + gzip）、请求体解析、分页口径。
//
// 拆路由模块时这些工具被六个以上领域共用（sendJson 全表 300+ 处），收在这一处：
// 改协议（加头、换缓存策略）只动这一个文件，路由模块各自再也不会漂出第二套。
//
// 一个纪律（延续 server.ts 原文）：所有 /api/* 都返回 JSON 且**永远**带 ok 字段，
// 前端只靠 ok 判断成败，不去猜状态码含义。

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { extname, resolve, sep } from "node:path";

export class SettingsBodyError extends Error {}

export const MAX_BODY_BYTES = 32 * 1024;
/** 录音 dataURL（base64 会膨胀 1/3）与语音合成响应都要比 32KB 宽得多，单独放宽给音频接口。 */
export const MAX_AUDIO_BODY_BYTES = 8 * 1024 * 1024;
/**
 * 带头像/人设正文的写接口单独放宽。
 *
 * ⚠️ 从前这些路由吃 32KB 的通用上限，而同一批处理函数宣称的字段上限是 150KB
 * （owner.avatar，见 settings.ts 的 sanitizeOwner）和人设三段合计 30000 字。
 * 于是一张细节多的图（128×128 q0.85 的 base64 很容易越过 24KB→32KB）会在**字段校验之前**
 * 就被「请求体过大」挡掉，而那句提示说的是另一个数字——用户照着 150KB 去压图，压了还是被拒。
 * 放宽到 512KB：仍挡得住无界 body，又容得下"内联 dataURL + 三段合计 30000 字"这个合法组合
 * （30000 个汉字 UTF-8 约 90KB，加上 150KB 头像仍在 512KB 内）。
 */
export const MAX_CARD_BODY_BYTES = 512 * 1024;

// ── 内容编码（gzip / brotli）─────────────────────────
// 穿透访问下首屏最大的一块成本是 320KB 的产物原文（gzip 后 92KB）；轮询接口同理
// （/api/contacts 每 10 秒 15KB 原文）。node:zlib 是内置的，不引依赖。
// 客户端接受哪些编码在请求入口记一次在 response 上，sendJson / sendFile 共用这
// 一个事实来源——否则要给六十多个 sendJson 调用点都加一个 request 参数。
// 为什么还要 brotli：穿透的住宅上行是硬瓶颈，同一份产物 brotli 比 gzip 再省 15~20%，
// 在拥塞链路上就是按秒计的差别。静态产物用 q11（按文件压一次记下来），动态 JSON 用
// q4（毫秒级，不值得缓存）；更大的图片/音频压不赢原始编码，自然落到 gzip 的 null 分支。
const ENC_OK = Symbol("accepts-encoding");
type EncAware = ServerResponse & { [ENC_OK]?: { gzip: boolean; br: boolean } };

export function markGzip(request: IncomingMessage, response: ServerResponse): void {
  const ae = request.headers["accept-encoding"];
  const list = typeof ae === "string" ? ae.toLowerCase() : "";
  (response as EncAware)[ENC_OK] = { gzip: list.includes("gzip"), br: list.includes("br") };
}

function acceptsEncoding(response: ServerResponse): { gzip: boolean; br: boolean } {
  return (response as EncAware)[ENC_OK] ?? { gzip: false, br: false };
}

/** 小于这个体积压了也省不下一个 MTU，白付 CPU。 */
const GZIP_MIN_BYTES = 1024;
/**
 * 动态 JSON 换 brotli 的门槛：小响应上 q4 brotli 可能比 gzip 还大（实测 1.2KB 的
 * /api/status 反增 19B），大响应才稳赢（中文正文 -60% 级、15KB 的 contacts -3%）。
 */
const BROTLI_JSON_MIN_BYTES = 4096;
/** brotli q11 在大文件上要几百毫秒：懒压缩只做小文件，更大的退回 gzip（图片类压不赢，null 兜住）。 */
const BROTLI_MAX_BYTES = 1024 * 1024;

function encodingHeaders(encoding: string | null): Record<string, string> {
  // Vary 必须带：穿透那层的 CDN 若按 URL 缓存，不带 Vary 会把压缩版发给不接受的客户端。
  return encoding === null ? {} : { "content-encoding": encoding, vary: "accept-encoding" };
}

/**
 * 静态文件的压缩结果按 size+mtime 记一份（brotli、gzip 各一份），别每次请求都压一遍。
 * 原文不进内存：本地磁盘读有页缓存兜着，实测 2ms 级，不值得为大图占常驻内存。
 */
type CompEntry = { key: string; br?: Buffer | null; gz?: Buffer | null };
const compCache = new Map<string, CompEntry>();

function compEntryOf(file: string, statSize: number, statMtimeMs: number): CompEntry {
  const key = `${statSize}:${statMtimeMs}`;
  const hit = compCache.get(file);
  if (hit !== undefined && hit.key === key) {
    // LRU：命中就挪到表尾，淘汰最老的。
    compCache.delete(file);
    compCache.set(file, hit);
    return hit;
  }
  const entry: CompEntry = { key };
  compCache.set(file, entry);
  if (compCache.size > 128) {
    const oldest = compCache.keys().next().value as string;
    if (oldest !== file) compCache.delete(oldest);
  }
  return entry;
}

function brotliOf(entry: CompEntry, raw: Buffer): Buffer | null {
  if (entry.br === undefined) {
    const b = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    entry.br = b.length < raw.length ? b : null;
  }
  return entry.br;
}

function gzipOf(entry: CompEntry, raw: Buffer): Buffer | null {
  if (entry.gz === undefined) {
    const g = gzipSync(raw);
    entry.gz = g.length < raw.length ? g : null;
  }
  return entry.gz;
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const raw = Buffer.from(JSON.stringify(body));
  let buf = raw;
  let encoding: string | null = null;
  if (raw.length >= GZIP_MIN_BYTES) {
    const enc = acceptsEncoding(response);
    // 动态正文每个响应都不同，不做缓存。q4 对 JSON 压缩比略胜 gzip 且 CPU 毫秒级，
    // 但只在大响应上换 brotli：小响应可能不升反降（见 BROTLI_JSON_MIN_BYTES 注释）。
    if (enc.br && raw.length >= BROTLI_JSON_MIN_BYTES) {
      const b = brotliCompressSync(raw, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
      });
      if (b.length < raw.length) { buf = b; encoding = "br"; }
    } else if (enc.gzip) {
      const g = gzipSync(raw);
      if (g.length < raw.length) { buf = g; encoding = "gzip"; }
    }
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...encodingHeaders(encoding),
  });
  response.end(buf);
}

const DIST_MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** 内容寻址的资源（文件名带 hash 的构建产物、随机 id 的聊天图片）可以永久缓存。 */
export const IMMUTABLE = "public, max-age=31536000, immutable";
/** index.html：允许浏览器存，但每次都要带 ETag 回来验（变了立刻 200，没变 304 省掉正文）。 */
export const NO_CACHE = "no-cache";
/** 文件名不带 hash 的固定小图（应用图标、内置头像）：短缓存折中——不每次回源，也不会 stale 太久。 */
export const SHORT_CACHE = "public, max-age=3600";
/** 其余一律不缓存：缓存住就等于新版本发不出去。 */
export const NO_STORE = "no-store";

/**
 * HTML 响应的安全头。为什么必须由后端发：桌面壳启动后 `window.navigate` 到
 * http://127.0.0.1:随机端口，那已经是**远程 origin**——tauri.conf.json 里那条 CSP
 * 只贴得到 tauri 协议下的启动页，界面本身从来没收到过（实测响应头只有 content-type/cache-control）。
 * 声明和实态对不上比没声明更危险：审计的人会照着它判断边界。
 *
 * - `frame-ancestors 'none'` + `X-Frame-Options: DENY`：挡「把整个应用嵌进攻击者页面」。
 *   本服务只校验 Origin 头，而**顶层导航请求根本不带 Origin**，嵌进来就等于拿到了同源身份。
 * - `script-src 'self' 'unsafe-inline'`：'unsafe-inline' 是被迫的——index.html 里那段主题引导
 *   脚本必须在首帧前跑（防闪白，见 frontend/index.html 的注释）。想收掉它得把脚本外置成
 *   带 hash 的单独文件，那是前端构建的活，不在这里偷偷改。
 * - `img-src`/`media-src` 带 data: 和 blob:：语音播放（ChatView 的 dataUrl）与头像等走 data:，图片放大走本地 blob。
 * - 不放 https:：界面里所有图都是 /media 或 data:（头像也早已落盘到 /media）。
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

export function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...HTML_SECURITY_HEADERS,
  });
  response.end(html);
}

/** 历史路径（/memory 等）→ React hash 路由的重定向。 */
export function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

export function serveDistFile(distRoot: string, name: string, request: IncomingMessage, response: ServerResponse, cacheControl = NO_STORE): void {
  // 防路径穿越：resolve 后必须仍在 dist 目录内
  const file = resolve(distRoot, name);
  if (!file.startsWith(resolve(distRoot) + sep)) {
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return;
  }
  sendFile(request, response, file, DIST_MIME[extname(file)] ?? "application/octet-stream", cacheControl);
}

/** 从 HTML 里抠出 /assets/ 引用生成 Link: preload 头：浏览器收到响应头就能并行去拉资产，
 *  不用等 12KB 的 HTML 下载完再解析；CF 开了 Early Hints 后还会升级成 103 边缘预加载。 */
function linkPreloadHeader(html: Buffer): Record<string, string> {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const m of html.toString("utf8").matchAll(/(?:href|src)="(\/assets\/[A-Za-z0-9._/-]+?\.(?:js|css|woff2))"/g)) {
    const url = m[1];
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const as = url.endsWith(".js") ? "script" : url.endsWith(".css") ? "style" : "font";
    // module 脚本按 CORS 模式加载，preload 必须带 crossorigin 才能命中二次请求
    links.push(`<${url}>; rel=preload; as=${as}${as !== "style" ? "; crossorigin" : ""}`);
    if (links.length >= 8) break;
  }
  return links.length > 0 ? { link: links.join(", ") } : {};
}

export function sendFile(request: IncomingMessage, response: ServerResponse, file: string, mime: string, cacheControl = NO_STORE): void {
  let statSize = 0;
  let statMtimeMs = 0;
  try {
    const st = statSync(file);
    statSize = st.size;
    statMtimeMs = st.mtimeMs;
  } catch {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }
  const etag = `W/"${statSize}-${Math.floor(statMtimeMs)}"`;
  // 条件请求放在最前：没变直接 304 零字节，连压缩都省掉（桌面重开/移动刷新都命中）。
  const inm = request.headers["if-none-match"];
  if (inm !== undefined && inm !== "" && (inm === etag || inm.includes(etag))) {
    // 304 不带 body、也不带 content-encoding（没有正文可解压）；只回校验与缓存语义。
    response.writeHead(304, {
      "cache-control": cacheControl,
      etag,
    });
    response.end();
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }
  let buf = body;
  let encoding: string | null = null;
  // 编码优先级：brotli > gzip > 原文。图片等已压缩的内容压不赢就发原文（xxxOf 里「null 兜底」）。
  if (body.length >= GZIP_MIN_BYTES) {
    const enc = acceptsEncoding(response);
    const entry = compEntryOf(file, statSize, statMtimeMs);
    if (enc.br && body.length <= BROTLI_MAX_BYTES) {
      const br = brotliOf(entry, body);
      if (br !== null) { buf = br; encoding = "br"; }
    }
    if (encoding === null && enc.gzip) {
      const gz = gzipOf(entry, body);
      if (gz !== null) { buf = gz; encoding = "gzip"; }
    }
  }
  response.writeHead(200, {
    "content-type": mime,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    etag,
    ...(mime.startsWith("text/html") ? { ...HTML_SECURITY_HEADERS, ...linkPreloadHeader(body) } : {}),
    ...encodingHeaders(encoding),
  });
  response.end(buf);
}

export async function readJson<T>(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new SettingsBodyError("请求体过大");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {} as T;
  // 非法 JSON 是用户/前端输入问题 → 400（SettingsBodyError），不该冒 500。
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new SettingsBodyError("请求体不是合法的 JSON");
  }
}

export async function readBinary(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new SettingsBodyError(`文件过大（上限 ${Math.round(maxBytes / (1024 * 1024))}MB）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * 列表分页的统一口径。前端「界面 → 列表每页」给的是 25/50/100 三档，
 * 这里只兜一个上限：所有管理面列表都从这两个数取，不再一个接口一个默认值
 * （从前是 25/200、15/100、100/500、20/100 四套，记忆页前端还写死 200）。
 */
export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 100;

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
