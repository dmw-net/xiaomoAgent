// 轻量链接预览：只把网页的标题、描述、站点名和 favicon 取回来，不抓正文、不存页面快照。
//
// 为什么放在后端：界面 CSP 是 connect-src 'self'，前端不能直接请求外部网页；
// 而且所有出网请求必须复用 web.ts 的 SSRF 门、重定向校验和大小上限。
// 预览只服务界面展示，失败时前端安静地退回普通链接，不阻塞聊天。

import { fetchDocument, fetchRaw, htmlToText, parseHttpUrl } from "./web.ts";

export type LinkPreview = {
  /** 用户点的那条地址（去掉 #hash，避免同一页被当成多个缓存项）。 */
  url: string;
  /** 跟随重定向后的最终地址。 */
  finalUrl: string;
  domain: string;
  title: string;
  description: string;
  siteName: string;
  /** 已内联成 data URL 的小图标；取不到时为空串，由前端显示域名首字母。 */
  icon: string;
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 120;
const ICON_MAX_BYTES = 96 * 1024;
const cache = new Map<string, { at: number; value: LinkPreview }>();
const inflight = new Map<string, Promise<LinkPreview>>();

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
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
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
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
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
    iconUrl: iconUrl || (origin ? origin + "/favicon.ico" : ""),
  };
}

function sniffImageMime(body: Buffer): string {
  if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body.length > 8 && body[0] === 0x89 && body[1] === 0x50) return "image/png";
  if (body.length > 12 && body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (body.length > 6 && body.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (body.length > 4 && body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) return "image/x-icon";
  const head = body.subarray(0, 512).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return "";
}

async function faviconDataUrl(iconUrl: string, pageUrl: string): Promise<string> {
  if (iconUrl === "") return "";
  try {
    // favicon 很小，没必要落盘：data URL 跟着这次响应走，也不会被孤儿媒体清理扫掉。
    const raw = await fetchRaw(iconUrl, ICON_MAX_BYTES, undefined, { referer: pageUrl });
    const declared = (raw.contentType.split(";")[0] ?? "").trim().toLowerCase();
    const mime = declared.startsWith("image/") ? declared : sniffImageMime(raw.body);
    if (!mime.startsWith("image/")) return "";
    return `data:${mime};base64,${raw.body.toString("base64")}`;
  } catch {
    return "";
  }
}

async function load(rawUrl: string): Promise<LinkPreview> {
  const doc = await fetchDocument(rawUrl);
  const parsed = parseLinkPreviewHtml(doc.body, doc.finalUrl);
  const icon = await faviconDataUrl(parsed.iconUrl, doc.finalUrl);
  return {
    url: rawUrl,
    finalUrl: parsed.finalUrl,
    domain: parsed.domain,
    title: parsed.title,
    description: parsed.description,
    siteName: parsed.siteName,
    icon,
  };
}

/**
 * 取一条链接预览。30 分钟内同一个 URL 直接命中内存缓存；同一 URL 并发请求共用一次抓取。
 * 失败直接抛给调用方，由路由转成可读错误；前端可以把失败当成“没有卡片”，不阻塞消息渲染。
 */
export async function linkPreviewFor(rawUrl: string): Promise<LinkPreview> {
  const parsed = parseHttpUrl(rawUrl);
  parsed.hash = "";
  const url = parsed.toString();
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const existing = inflight.get(url);
  if (existing) return existing;

  const pending = load(url)
    .then((value) => {
      cache.delete(url);
      cache.set(url, { at: Date.now(), value });
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return value;
    })
    .finally(() => { inflight.delete(url); });
  inflight.set(url, pending);
  return pending;
}
