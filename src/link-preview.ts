// 轻量链接预览：只把网页的标题、描述、站点名和 favicon 取回来，不抓正文、不存页面快照。
//
// 为什么放在后端：界面 CSP 是 connect-src 'self'，前端不能直接请求外部网页；
// 而且所有出网请求必须复用 web.ts 的 SSRF 门、重定向校验和大小上限。
// 预览只服务界面展示，失败时前端安静地退回普通链接，不阻塞聊天。

import { fetchDocument, fetchRaw, htmlToText, parseHttpUrl } from "./web.ts";
import { sniffImageMime } from "./media.ts";
import type { LinkPreview } from "../shared/api.ts";

export type { LinkPreview };

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 120;
const ICON_MAX_BYTES = 96 * 1024;
/**
 * 一次预览的总预算。必须小于前端 getJson 的 10 秒超时，否则页面稍慢就会
 * 前端先放弃、服务端还在空跑。favicon 只占其中一小段，不能让它把卡片拖满整个预算。
 */
const PREVIEW_TOTAL_MS = 8_000;
const PREVIEW_ICON_MS = 2_500;
/** 同时最多抓几个外站：快速滚动历史时可能瞬间出现几十条链接。 */
const PREVIEW_MAX_INFLIGHT = 4;
const cache = new Map<string, { at: number; value: LinkPreview }>();
const inflight = new Map<string, Promise<LinkPreview>>();
let activeLoads = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeLoads < PREVIEW_MAX_INFLIGHT) {
    activeLoads += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      activeLoads += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeLoads = Math.max(0, activeLoads - 1);
  waiters.shift()?.();
}

/** 缓存命中时把条目挪到末尾，让超出上限时先淘汰真正最久没用的。 */
function cacheHit(url: string, now: number): LinkPreview | null {
  const hit = cache.get(url);
  if (hit === undefined) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  cache.delete(url);
  cache.set(url, hit);
  return hit.value;
}

function cachePut(url: string, value: LinkPreview): void {
  cache.delete(url);
  cache.set(url, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cleanText(raw: string, max: number): string {
  return htmlToText(raw).replace(/\s+/g, " ").trim().slice(0, max);
}

/** 解析一个开始标签里的属性；只处理 attribute="value" 这类常见写法。 */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag)) !== null) {
    const key = (match[1] ?? "").toLowerCase();
    if (key === "") continue;
    out[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return out;
}

export type ParsedLinkPreview = Omit<LinkPreview, "icon" | "url"> & { iconUrl: string };

/** 纯解析函数：不联网，便于用固定 HTML 钉住标题/描述/favicon 的优先级。 */
export function parseLinkPreviewHtml(html: string, finalUrl: string): ParsedLinkPreview {
  const meta = new Map<string, string>();
  // 标签边界要跳过引号里的 `>`：`content="1 > 0"` 会把 `[^>]*` 从引号中间截断，
  // 结果 OG 标题读不到、描述为空。下面 attributes() 本身能处理带引号的值。
  for (const tag of html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    const content = attrs.content ?? "";
    if (key !== "" && content !== "" && !meta.has(key)) meta.set(key, content);
  }

  const titleText = meta.get("og:title") ?? meta.get("twitter:title") ?? meta.get("title") ?? "";
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const description = meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? "";
  const siteName = meta.get("og:site_name") ?? meta.get("application-name") ?? "";

  let iconHref = "";
  for (const tag of html.match(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const attrs = attributes(tag);
    const rel = (attrs.rel ?? "").toLowerCase();
    if (!rel.includes("icon")) continue;
    if (attrs.href) {
      iconHref = attrs.href;
      // apple-touch-icon 通常比 favicon.ico 清楚得多，但只在没有普通 icon 时回退。
      if (rel.split(/\s+/).includes("icon") && !rel.includes("apple-touch-icon")) break;
    }
  }

  let origin = "";
  try {
    const parsed = new URL(finalUrl);
    origin = parsed.origin;
  } catch {
    // fetchDocument 给的 finalUrl 已是合法地址；这里只是纯解析函数的兜底。
  }
  let iconUrl = "";
  try {
    iconUrl = new URL(iconHref || "/favicon.ico", finalUrl).toString();
    if (!/^https?:/i.test(iconUrl)) iconUrl = "";
  } catch {
    iconUrl = "";
  }

  let domain = "";
  try {
    domain = new URL(finalUrl).hostname.replace(/^www\./i, "");
  } catch {
    domain = origin.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  }
  const title = cleanText(titleText || titleTag, 180) || domain || "链接";

  return {
    finalUrl,
    domain,
    title,
    description: cleanText(description, 300),
    siteName: cleanText(siteName, 80) || domain,
    iconUrl: iconUrl, // new URL(..., finalUrl) 已经处理了相对路径与缺省 /favicon.ico
  };
}

async function faviconDataUrl(iconUrl: string, pageUrl: string, timeoutMs: number): Promise<string> {
  if (iconUrl === "" || timeoutMs <= 0) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // favicon 很小，没必要落盘：data URL 跟着这次响应走，也不会被孤儿媒体清理扫掉。
    const raw = await fetchRaw(iconUrl, ICON_MAX_BYTES, controller.signal, { referer: pageUrl });
    const declared = (raw.contentType.split(";")[0] ?? "").trim().toLowerCase();
    const mime = declared.startsWith("image/") ? declared : sniffImageMime(raw.body);
    if (!mime.startsWith("image/")) return "";
    return `data:${mime};base64,${raw.body.toString("base64")}`;
  } catch {
    // 图标是锦上添花：抓不到就空着，绝不能让一张 404 的 favicon 拖垮整张卡。
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function load(rawUrl: string): Promise<LinkPreview> {
  const controller = new AbortController();
  const deadline = Date.now() + PREVIEW_TOTAL_MS;
  const timer = setTimeout(() => controller.abort(), PREVIEW_TOTAL_MS);
  try {
    const doc = await fetchDocument(rawUrl, undefined, controller.signal);
    const parsed = parseLinkPreviewHtml(doc.body, doc.finalUrl);
    // 预算已经在页面抓取上用掉一部分，图标只能拿剩下的，并且最多 2.5 秒。
    const remaining = Math.min(PREVIEW_ICON_MS, deadline - Date.now());
    const icon = await faviconDataUrl(parsed.iconUrl, doc.finalUrl, remaining);
    return {
      url: rawUrl,
      finalUrl: parsed.finalUrl,
      domain: parsed.domain,
      title: parsed.title,
      description: parsed.description,
      siteName: parsed.siteName,
      icon,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取一条链接预览。30 分钟内同一个 URL 直接命中内存缓存；同一 URL 并发请求共用一次抓取。
 * 全部抓取共享并发上限，避免一段带几十条链接的历史把出网连接打满。
 * 失败直接抛给调用方，由路由转成可读错误；前端可以把失败当成“没有卡片”，不阻塞消息渲染。
 */
export async function linkPreviewFor(rawUrl: string): Promise<LinkPreview> {
  const parsed = parseHttpUrl(rawUrl);
  parsed.hash = "";
  const url = parsed.toString();
  const hit = cacheHit(url, Date.now());
  if (hit !== null) return hit;

  const existing = inflight.get(url);
  if (existing) return existing;

  const pending = (async () => {
    await acquireSlot();
    try {
      return await load(url);
    } finally {
      releaseSlot();
    }
  })()
    .then((value) => {
      cachePut(url, value);
      return value;
    })
    .finally(() => { inflight.delete(url); });
  inflight.set(url, pending);
  return pending;
}
