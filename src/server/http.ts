// 路由的传输层原语：响应发送、静态文件（ETag/304 + gzip）、请求体解析、分页口径。
//
// 拆路由模块时这些工具被六个以上领域共用（sendJson 全表 300+ 处），收在这一处：
// 改协议（加头、换缓存策略）只动这一个文件，路由模块各自再也不会漂出第二套。
//
// 一个纪律（延续 server.ts 原文）：所有 /api/* 都返回 JSON 且**永远**带 ok 字段，
// 前端只靠 ok 判断成败，不去猜状态码含义。

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
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

// ── gzip ──────────────────────────────────────────────
// 穿透访问下首屏最大的一块成本是 320KB 的产物原文（gzip 后 92KB）；轮询接口同理
// （/api/contacts 每 10 秒 15KB 原文）。node:zlib 是内置的，不引依赖。
// 客户端接不接受 gzip 在请求入口记一次在 response 上，sendJson / sendFile 共用这
// 一个事实来源——否则要给六十多个 sendJson 调用点都加一个 request 参数。
const GZIP_OK = Symbol("accepts-gzip");
type GzipAware = ServerResponse & { [GZIP_OK]?: boolean };

export function markGzip(request: IncomingMessage, response: ServerResponse): void {
  const ae = request.headers["accept-encoding"];
  (response as GzipAware)[GZIP_OK] = typeof ae === "string" && ae.includes("gzip");
}

/** 小于这个体积压了也省不下一个 MTU，白付 CPU。 */
const GZIP_MIN_BYTES = 1024;

function gzipHeaders(encoding: string | null): Record<string, string> {
  // Vary 必须带：穿透那层的 CDN 若按 URL 缓存，不带 Vary 会把 gzip 版发给不接受 gzip 的客户端。
  return encoding === null ? {} : { "content-encoding": encoding, vary: "accept-encoding" };
}

/** 静态文件不常变，gzip 结果按 size+mtime 记一份，别每次请求都压一遍。 */
const gzipCache = new Map<string, { key: string; buf: Buffer | null }>();

function gzipOfFile(file: string, body: Buffer): Buffer | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = gzipCache.get(file);
  if (hit !== undefined && hit.key === key) return hit.buf;
  const gz = gzipSync(body);
  const buf = gz.length < body.length ? gz : null;
  gzipCache.set(file, { key, buf });
  if (gzipCache.size > 128) gzipCache.delete(gzipCache.keys().next().value as string);
  return buf;
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const raw = Buffer.from(JSON.stringify(body));
  let buf = raw;
  let encoding: string | null = null;
  if ((response as GzipAware)[GZIP_OK] === true && raw.length >= GZIP_MIN_BYTES) {
    const gz = gzipSync(raw);
    if (gz.length < raw.length) { buf = gz; encoding = "gzip"; }
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...gzipHeaders(encoding),
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
/** 其余一律不缓存：index.html 缓存住就等于新版本发不出去。 */
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

/** 按文件的 size+mtime 生成弱 ETag：内容没变（重建前）就命中 304。 */
function staticETag(file: string, size: number): string {
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return ""; }
  return `W/"${size}-${Math.floor(mtimeMs)}"`;
}

export function sendFile(request: IncomingMessage, response: ServerResponse, file: string, mime: string, cacheControl = NO_STORE): void {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }
  const etag = staticETag(file, body.length);
  // 条件请求放在最前：没变直接 304 零字节，连 gzip 都省掉（桌面重开/移动刷新都命中）。
  const inm = request.headers["if-none-match"];
  if (etag !== "" && typeof inm === "string" && inm !== "" && (inm === etag || inm.includes(etag))) {
    // 304 不带 body、也不带 content-encoding（没有正文可解压）；只回校验与缓存语义。
    response.writeHead(304, {
      "cache-control": cacheControl,
      etag,
    });
    response.end();
    return;
  }
  let buf = body;
  let encoding: string | null = null;
  // 图片等已压缩的内容 gzip 压不动，gzipOfFile 里「压不赢就返回 null」兜住。
  if ((response as GzipAware)[GZIP_OK] === true && body.length >= GZIP_MIN_BYTES) {
    const gz = gzipOfFile(file, body);
    if (gz !== null) { buf = gz; encoding = "gzip"; }
  }
  response.writeHead(200, {
    "content-type": mime,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    etag,
    ...(mime.startsWith("text/html") ? HTML_SECURITY_HEADERS : {}),
    ...gzipHeaders(encoding),
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
