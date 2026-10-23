// 外网抓取底座：所有「让她从网上拿东西」的能力都走这一扇门。
//
// 为什么不用内置 fetch 而是手搓 node:https——fetch 没法注入 DNS 解析回调，
// 于是 SSRF 防护只能校验「URL 里写的主机名」，而攻击面恰恰在解析之后：
// 一个域名先解析成公网 IP 通过检查、下一次解析成 127.0.0.1，就叫 DNS rebinding。
// 这里的校验发生在**拿到的就是即将连接的那个 IP** 的时刻（options.lookup），
// 所以这条防线是真的，不是注释里的（同类产品大多只校验协议）。
//
// 三条纪律：
// 1. **上限一律按解压后的字节算**，否则一个 1KB 的 gzip 炸弹就能撑爆内存；
// 2. **失败返回结构化错误**，让模型知道「这个站没抓到」并继续说话，而不是整轮炸掉；
// 3. **抓回来的内容永远标记成资料**，不当指令（见 web_fetch 工具那侧的包装）。

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { promises as dnsPromises, type LookupAddress } from "node:dns";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { Readable } from "node:stream";
import { isIP, type LookupFunction } from "node:net";

export type WebErrorCode = "bad_url" | "blocked_host" | "timeout" | "http_status" | "too_large" | "bad_body" | "unsupported_type" | "too_many_redirects";

export class WebError extends Error {
  code: WebErrorCode;
  detail: string;
  constructor(code: WebErrorCode, message: string, detail = "") {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 抓取上限。文本 600KB（够一整页百科正文，又不至于把一轮上下文吃穿）、
 * 图片 8MB（与媒体层现有闸门同量级），总时长 20 秒（含解压与所有重定向）。
 */
export const WEB_LIMITS = { textBytes: 600_000, imageBytes: 8_000_000, timeoutMs: 20_000, maxRedirects: 5 };

/**
 * 用浏览器 UA：站点普遍对 `node` 直接回 403，而我们要读的本来就是给人看的公开页面。
 * 但**不靠伪造 UA 去突破站点的拦截**——桌面版给 403 时改用该站为机器/移动准备的入口
 * （见 search.ts 里百科源走 wapbaike），这是两回事。
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** IPv6 全球单播就是 2000::/3；其余（回环、链路本地、ULA、文档段、隧道包装）一律按不可达处理。
 *  这里用**默认拒绝**而不是逐条黑名单——逐条列举必然漏（`0:0:0:0:0:0:0:1` 就不是 `::1` 的字面形式）。
 *  注意判的是首段的**数值范围**而不是字符串前缀：百度实测的 2408:… 是合法全球单播，
 *  写成 `^2[0-3]:` 会把整个 2400–3fff 段误杀成内网（第一版就这么栽过一次）。
 *  导出它只为了冒烟能**离线**钉住这条门——门如果只能靠联网测，网络一抖就变成假绿。 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)?.[1];
    if (mapped !== undefined) return isPrivateAddress(mapped);
    if (v.startsWith("2002:") || v.startsWith("2001:db8:")) return true; // 6to4 与文档段
    const head = Number.parseInt((v.split(":")[0] ?? "") === "" ? "0" : (v.split(":")[0] ?? ""), 16);
    if (Number.isNaN(head)) return true;
    return head < 0x2000 || head > 0x3fff;
  }
  const parts = v.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT，云元数据常藏在这儿
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // 组播与保留段
  return false;
}

function assertPublicHost(hostname: string): void {
  // url.hostname 对 IPv6 带方括号（[::1]），isIP 不认那个形式，先剥掉再判字面量。
  const literal = decodeURIComponent(hostname).replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0 && isPrivateAddress(literal)) {
    throw new WebError("blocked_host", `这个地址不能访问（${literal} 是本机或内网地址）`);
  }
}

/**
 * 注入给连接层的 lookup：解析一次 → 校验**全部**地址 → 按 Node 期望的形状回传。
 * 校验的对象就是即将被连接的那个 IP，所以 DNS rebinding 在这里没有窗口。
 *
 * 三条都是踩过的坑，别再"简化"：
 * - **回传形状必须跟着调用方传进来的 `options.all`**，不能自己定。擅自把 all:false 的结果
 *   回传给按数组解析的 Node，会得到 `Invalid IP address: undefined`；反过来传错形状则是
 *   **静默挂死到总超时**（不报错），最难查的那一类。
 * - **`options` 可能是 undefined**（Node 的某些调用路径不带它），所以 `options ?? {}`。
 * - **只解析一次**而不是按 all 走两条分支：两条分支里校验的可能是不同批次的答案。
 *   这里固定用 all:true 拿全量列表，既保证「每个地址都过门」，又让返回类型只有一种。
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const wantsAll = options?.all === true;
  dnsPromises.lookup(hostname, { all: true, hints: options?.hints ?? 0, verbatim: options?.verbatim ?? true }).then(
    (list) => {
      const blocked = list.find((item) => isPrivateAddress(item.address));
      if (blocked !== undefined) {
        callback(new WebError("blocked_host", `这个站点的地址不能访问（解析到 ${blocked.address}）`) as NodeJS.ErrnoException, "", 4);
        return;
      }
      const first = list[0];
      if (first === undefined) {
        callback(new WebError("bad_url", `域名解析没有结果：${hostname}`) as NodeJS.ErrnoException, "", 4);
        return;
      }
      if (wantsAll) {
        (callback as unknown as (err: Error | null, addresses: LookupAddress[]) => void)(null, list);
        return;
      }
      callback(null, first.address, first.family === 6 ? 6 : 4);
    },
    (error: unknown) => { callback(asLookupError(error, hostname) as NodeJS.ErrnoException, "", 4); },
  );
};

/** 上限要说人话：20KB 的上限按 MB 显示会变成「0.0 MB」，等于没说。 */
function humanBytes(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 解析失败要报得清是哪一步：ENOTFOUND（域名不存在）和 EAI_AGAIN（DNS 暂时抽风）对用户的下一步不一样。 */
function asLookupError(error: unknown, hostname: string): Error {
  const code = (error as { code?: string } | null)?.code ?? "";
  if (code === "ENOTFOUND") return new WebError("bad_url", `域名不存在：${hostname}`);
  if (code === "EAI_AGAIN") return new WebError("timeout", `DNS 暂时没响应（${hostname}），稍后再试`);
  return error instanceof Error ? error : new WebError("bad_url", `域名解析失败：${hostname}`);
}

/**
 * 请求头值先洗一遍：外部数据（搜索结果里的原图页地址）常带转义与控制字符，
 * 而 Node 对脏头是直接抛 `Invalid character in header content`——那报错长得像我们的 bug，
 * 实际是数据问题，洗掉就变成一次正常的降级请求。
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 2000);
    if (clean !== "") out[name] = clean;
  }
  return out;
}

type RawResponse = { status: number; body: Buffer; contentType: string; finalUrl: string };

function readOne(url: URL, maxBytes: number, deadline: NodeJS.Timeout, signal: AbortSignal, extraHeaders: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const req = transport(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "zh-CN,zh;q=0.9",
          ...extraHeaders,
        },
        lookup: guardedLookup,
        signal,
        // 证书校验保持默认开启——降级到不校验就等于把「拿到的是谁的内容」交给网络。
        timeout: 0,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string") {
          // 必须把这条连接整个销毁：只 resume 的话它会带着"半读"状态回到连接池，
          // 下一跳复用同一个 agent 时就被排在这条坏连接上，表现为**请求挂死到总超时**
          // （而不是报错）——排查时最容易误判成站点慢或 lookup 坏了。
          res.resume();
          req.destroy();
          reject(Object.assign(new Error("redirect"), { redirect_to: location, final_url: url.toString() }));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          req.destroy();
          reject(new WebError("http_status", `对方回了 ${status}`, url.toString()));
          return;
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const decompressor = encoding.includes("gzip") ? createGunzip()
          : encoding.includes("br") ? createBrotliDecompress()
            : encoding.includes("deflate") ? createInflate() : null;
        // 有编码时累计的是**解压后**的流——上限必须按这个数算，否则一个 1KB 的
        // gzip 炸弹就能把内存撑穿；没编码时接 inflate 反而当场报错，所以不接。
        let stream: Readable = res;
        if (decompressor !== null) {
          stream = decompressor;
          res.pipe(decompressor);
          res.on("error", (error: Error) => {
            clearTimeout(deadline);
            reject(new WebError("bad_body", `传输读坏了（${error.message}）`, url.toString()));
          });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            stream.destroy();
            req.destroy();
            clearTimeout(deadline);
            reject(new WebError("too_large", `内容超过上限 ${humanBytes(maxBytes)}，没抓完`, url.toString()));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", (error: Error) => {
          clearTimeout(deadline);
          reject(new WebError("bad_body", `响应读坏了（${error.message}）`, url.toString()));
        });
        stream.on("end", () => {
          clearTimeout(deadline);
          resolve({
            status,
            body: Buffer.concat(chunks),
            contentType: String(res.headers["content-type"] ?? ""),
            finalUrl: url.toString(),
          });
        });
      },
    );
    req.on("error", (error: Error) => {
      clearTimeout(deadline);
      if (error instanceof WebError) reject(error);
      // abort 的 reason 到不了这里——`req.on("error")` 收到的是 Node 自己的
      // "The operation was aborted"。所以超时/取消要靠 signal 反推，
      // 否则用户看到的是「连不上或连接中断（The operation was aborted）」而不是「抓取超时」。
      else if (signal.aborted) {
        const reason = signal.reason;
        reject(reason instanceof WebError ? reason : new WebError("timeout", `抓取超时（${WEB_LIMITS.timeoutMs / 1000} 秒）`, url.toString()));
      } else reject(new WebError("timeout", `连不上或连接中断（${error.message}）`, url.toString()));
    });
    // request() 不会自己发出去——少了这一行，连接和 TLS 都建好了，请求却永远不发送，
    // 表现成「站点没响应」直到总超时（用 get() 写对照实验时根本看不出问题）。
    req.end();
  });
}

/**
 * 抓一个 URL 的原始字节。重定向**逐跳重新走完整套校验**——
 * 一次性校验入口 URL 的话，一个 302 就把我们送到内网去了。
 *
 * 额外请求头先清洗再交给 Node：头值里只要有一个控制字符，Node 会直接抛
 * `Invalid character in header content`（实测拿搜索结果的原图页当 referer 就炸过一次），
 * 那类报错长得像代码 bug，其实是外部数据把请求头弄脏了。
 */
export async function fetchRaw(url: string, maxBytes: number, abortSignal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<RawResponse> {
  const headers = sanitizeHeaders(extraHeaders);
  const controller = new AbortController();
  // deadline 是**整次抓取**的总预算，跨重定向跳共享（不是每跳 20 秒）。
  const deadline = setTimeout(() => controller.abort(new WebError("timeout", `抓取超时（${WEB_LIMITS.timeoutMs / 1000} 秒）`)), WEB_LIMITS.timeoutMs);
  const onOuterAbort = (): void => controller.abort(new WebError("timeout", "这一轮被取消了，抓取已停"));
  if (abortSignal) abortSignal.addEventListener("abort", onOuterAbort);
  try {
    let current = parseHttpUrl(url);
    const firstOrigin = current.origin;
    for (let hop = 0; hop <= WEB_LIMITS.maxRedirects; hop += 1) {
      // 每一跳都重新校验：一次性校验入口 URL 的话，一个 302 就把我们送到内网去了。
      assertPublicHost(current.hostname);
      try {
        // 调用方给的额外头（search.ts 传的 referer）只在**同源**时带上。
        // 跨域还带着它，就等于把"这个链接是从哪个页面点出来的"告诉第三方——
        // 尤其是 CDN 那一跳，referer 是我们自己页面之外的用户浏览轨迹。
        const hopHeaders = current.origin === firstOrigin ? headers : {};
        return await readOne(current, maxBytes, deadline, controller.signal, hopHeaders);
      } catch (error) {
        const redirect = (error as Error & { redirect_to?: string }).redirect_to;
        if (typeof redirect !== "string") throw error;
        if (hop === WEB_LIMITS.maxRedirects) throw new WebError("too_many_redirects", "这个地址一直在跳转，没跟下去");
        current = parseHttpUrl(new URL(redirect, current.toString()).toString());
      }
    }
    throw new WebError("too_many_redirects", "重定向次数太多");
  } finally {
    // ⚠️ deadline 必须在 finally 清：从前只在 readOne 的 end/error/too_large 里清，
    // 于是 4xx/5xx、重定向、地址被拒、坏网址全部漏掉——每次失败的抓取都把一个
    // 20 秒定时器连同一个闭包钉在进程里，自然退出的脚本（冒烟、一次性 CLI）
    // 每次失败多挂 20 秒。外层监听同理，否则取消之后它还挂在调用方的 signal 上。
    clearTimeout(deadline);
    if (abortSignal) abortSignal.removeEventListener("abort", onOuterAbort);
  }
}

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebError("bad_url", "这不是一个合法的网址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError("bad_url", `只支持 http/https，收到的是 ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebError("bad_url", "网址里不能带账号密码");
  }
  if (url.hostname === "") throw new WebError("bad_url", "网址没有主机名");
  return url;
}

/**
 * 取「原文」而不抽取：搜索适配器要按标签切结果块，图片接口要读 JSON——
 * 这两个都不能先把页面压成正文，否则结构就没了。
 * 走的是同一扇门（同一套地址校验、上限、超时、字符集），所以不存在"绕过闸门的第二条路"。
 */
/**
 * 这个 content-type 能不能当网页/文本读。
 *
 * ⚠️ 空值必须判 false，不能"没有就当它是文本"放过去：否则一个 hostile 主机
 * （或任何一个会丢这个头的 CDN）只要什么都不回，就能把任意二进制按 UTF-8 解成
 * U+FFFD 乱码、最多 20000 字喂进模型上下文——白名单成了一道"遵守才有效"的门。
 * 正确口径：认不出来的类型一律不收。
 */
export function isFetchableMime(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.toLowerCase().trim() ?? "";
  if (mime === "") return false;
  return /^text\/|^application\/(json|xml|xhtml)|html/.test(mime);
}

export async function fetchDocument(url: string, maxBytes = WEB_LIMITS.textBytes, abortSignal?: AbortSignal): Promise<{ body: string; contentType: string; finalUrl: string }> {
  const raw = await fetchRaw(url, maxBytes, abortSignal);
  if (raw.body.length === 0) throw new WebError("bad_body", "对方给了一个空响应");
  if (!isFetchableMime(raw.contentType)) {
    const mime = raw.contentType.split(";")[0]?.toLowerCase().trim() ?? "";
    throw new WebError("unsupported_type", mime === "" ? "对方没给内容类型，不敢当网页读" : `这不是网页或文本（${mime}）`);
  }
  const mime = raw.contentType.split(";")[0]?.toLowerCase().trim() ?? "";
  return { body: decodeWebBody(raw.body, raw.contentType), contentType: mime, finalUrl: raw.finalUrl };
}

/** 抓网页文本：MIME 白名单 + 字符集处理 + HTML 抽正文。 */
export async function fetchText(url: string, abortSignal?: AbortSignal): Promise<{ text: string; contentType: string; title: string; finalUrl: string }> {
  const doc = await fetchDocument(url, WEB_LIMITS.textBytes, abortSignal);
  const looksHtml = doc.contentType.includes("html") || /^<(!doctype|html)/i.test(doc.body.trim());
  return {
    text: looksHtml ? htmlToText(doc.body) : doc.body.trim(),
    contentType: doc.contentType,
    title: extractTitle(doc.body),
    finalUrl: doc.finalUrl,
  };
}

/**
 * 从文档头部的 <meta> 里嗅探字符集。很多中文站只在 HTML 里写 `charset=gbk`，
 * HTTP 头不带 charset；不补这一步就会按 UTF-8 硬解成乱码。
 * 规范要求 meta charset 出现在文档前部，只扫前 2KB 足够，也避免把正文里的字样当声明。
 */
function sniffMetaCharset(body: Buffer): string {
  const head = body.subarray(0, 2048).toString("latin1");
  for (const tag of head.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const found = /charset\s*=\s*["']?([\w-]+)/i.exec(tag)?.[1];
    if (found !== undefined && found !== "") return found.toLowerCase();
  }
  return "";
}

/**
 * 网页正文解码：HTTP 头优先，缺失时从 meta 嗅探。
 * 容许 `charset="gbk"` 这种带引号的写法——旧正则只认裸值，带引号会被当成没声明。
 */
export function decodeWebBody(body: Buffer, contentType: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "";
  const mime = contentType.split(";")[0]?.toLowerCase().trim() ?? "";
  const fromMeta = fromHeader === "" && /html|xml/.test(mime) ? sniffMetaCharset(body) : "";
  return decodeBody(body, fromHeader || fromMeta);
}

/** 按字符集解码。精简 ICU 的 Node 没有 gb18030——那种情况退回 utf-8，
 *  代价是那一类站读成乱码，而不是整次抓取失败。
 *  big5 必须交给 big5：写成 gb18030 不是“兼容”，是另一种乱码（实测同字节 A4A4
 *  Big5 是「中」、GB18030 是「い」）。 */
function decodeBody(body: Buffer, charset: string): string {
  const want = charset.startsWith("gb")
    ? "gb18030"
    : charset === "big5" || charset === "big5-hkscs"
      ? "big5"
      : charset === "shift_jis" || charset === "sjis"
        ? "shift_jis"
        : charset === "euc-jp"
          ? "euc-jp"
          : charset === "euc-kr"
            ? "euc-kr"
            : "utf-8";
  try {
    return new TextDecoder(want, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

function extractTitle(html: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return decodeEntities(t.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * HTML → 正文。零依赖，所以只处理真正影响可读性的部分：
 * 剥掉不承载内容的容器、把块级边界还原成换行（否则整页会黏成一行）、解实体。
 * 不追求排版还原——那需要 CSS，而她读的是内容不是版式。
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // 块级闭合标签补换行，让段落和列表项不会黏在一起。
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|table|section|article|header|footer|blockquote|dd|dt|ul|ol)>/gi, "\n");
  s = s.replace(/<br\b[^>]*>/gi, "\n").replace(/<hr\b[^>]*>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  // 单元格之间要留一个分隔，否则两列数字会黏成一个。
  s = s.replace(/<\/(td|th)>/gi, " ");
  // 其余标签**整个吃掉而不是换成空格**：搜索结果里的关键词是被 <strong>/<em> 包着的，
  // 换成空格就把「玛奇玛」切成「玛 奇玛」，任何按整词做的相关性判定都会因此丢光真结果。
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", hellip: "…", mdash: "—", ndash: "–",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  yen: "¥", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", cent: "¢",
  times: "×", divide: "÷", deg: "°", plusmn: "±", micro: "µ", para: "¶", sect: "§",
  laquo: "«", raquo: "»", bull: "•",
  // 常见的 Latin-1 命名实体；网页标题/描述里出现频率不低，漏掉就会把整段字符删空。
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  ntilde: "ñ", oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", szlig: "ß",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => fromCodePoint(Number(dec)))
    // 不认识的命名实体原样保留，绝不能删成空串：以前 `&trade;` 这类会让「Rock & Roll™」
    // 变成「Rock & Roll」，标题和正文都缺字，而且没有任何报错。
    .replace(/&([a-z][a-z0-9]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all);
}

/** 越界或代理区码点会让 fromCodePoint 抛 RangeError——网页里的实体数字经常是坏的，
 *  不能让它掀掉整次抓取，所以坏码点直接丢空。 */
function fromCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10fffe || (value >= 0xd800 && value <= 0xdfff)) return "";
  return String.fromCodePoint(value);
}
