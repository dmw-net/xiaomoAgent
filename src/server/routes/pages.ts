// 页面与静态资源：React 产物、头像白名单、链接预览、QQ 头像抓取、聊天媒体（含 Range/ETag）、
// 历史路径 302。
//
// 顺序敏感：/api/link-preview 与 /api/avatar/qq 必须排在 /media 之前吗？不需要——路径不重叠。
// 但 /media/* 整块排在 / 与 /assets/ 之后，保持与原 handle() 一致（先页面后数据）。

import { createReadStream, existsSync } from "node:fs";
import { join as joinPath, resolve } from "node:path";
import { kvGet, kvSet } from "../../core/db.ts";
import { mediaFileInfo, mediaUrlExists, readMedia, releaseMediaFiles } from "../../media/media.ts";
import {
  claimAsset,
  findAssetByHash,
  findAssetByOriginRef,
  getAssetByUrl,
  releaseAssetOriginRef,
} from "../../media/assets.ts";
import { describeWebFailure, downloadImageToMedia } from "../../mind/search.ts";
import { linkPreviewFor } from "../../mind/link-preview.ts";
import {
  IMMUTABLE,
  NO_CACHE,
  SHORT_CACHE,
  sendFile,
  sendHtml,
  sendJson,
  sendRedirect,
  serveDistFile,
  readJson,
} from "../http.ts";
import type { Route } from "../types.ts";

/** React 前端构建产物目录（frontend/dist），页面与静态资源都从这里发。 */
const reactDist = resolve(import.meta.dirname ?? ".", "../../../frontend/dist");
const reactEntry = existsSync(joinPath(reactDist, "index.html"));
/** dist 根下逐条白名单发出的固定静态图：应用图标 + 两张内置头像。文件名不带 hash，只给短缓存。 */
const ROOT_IMAGE_ASSETS = new Set(["/icon.png", "/xiaomo.png", "/assistant.png"]);

/**
 * 手机第一次打开时看到的登录页。刻意**不依赖任何站点资源**：那时请求还没有 cookie，
 * 前端包也取不到，所以样式全内联。
 */
// （sendLanLogin 的 HTML 本体在 ./lan-login-page.ts，避免本模块背整页字符串。）

/** dist 未构建时的提示页：白屏最难排查，所以直接说清楚缺什么、怎么补。 */
function missingDistHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>前端未构建</title></head>
<body style="font-family:system-ui,sans-serif;max-width:34em;margin:15vh auto;line-height:1.7">
<h1>前端还没构建</h1>
<p>没找到 <code>frontend/dist/index.html</code>。在项目根目录执行：</p>
<pre style="background:#f2f0ed;padding:0.8em 1em;border-radius:8px">npm run fe:build</pre>
<p>构建完成后刷新本页面即可。</p>
</body>
</html>`;
}

/** 「这个号没有头像」：与网络/解析失败区分开，前者是 404（用户改号就行），后者是 502。 */
class QqAvatarUnavailable extends Error {}

/** 来源凭据：QQ 号落到 assets.origin_ref，同一个号不管取多少次都指向同一个文件。 */
function avatarOrigin(qq: string): string {
  return `qq:${qq}`;
}

/** 同号码的请求合并成一个。资料页挂载时“协议端账号”和“我的 QQ”会同时取同一个号。 */
const avatarInFlight = new Map<string, Promise<string>>();

/**
 * 本地这份头像多久要跟 QQ 那边对一次账。
 *
 * 这是「按号复用」的代价：用户可能在 QQ 端换了头像，而按号复用意味着我们不再去看。
 * 所以给它一个保质期：期内完全不走网络（这是止血的那一刀——过去每次进资料页 55KB）；
 * 过期了真的重新下一遍，内容一样就只把对账时间擦新（盘上一个字节不多）。
 * 12 小时的选择：这是张头像，不是消息；界面上的「换头像」按钮随时能强制刷新。
 */
const AVATAR_RECHECK_MS = 12 * 60 * 60 * 1000;

/**
 * 上次跟 QQ 对过账的时刻。
 * 只存一个数字：kv 的值会被引用检查当成路径来扫（`v LIKE '%<文件名>%'`），
 * 真要存 URL 的话，那张旧头像从此就算「还有人引用」，永远清不掉。
 */
function avatarCheckedKey(qq: string): string {
  return `avatar.qq.checked.${qq}`;
}

function avatarCheckedAt(qq: string): number {
  const raw = kvGet(avatarCheckedKey(qq));
  const at = raw === null ? 0 : Number(raw);
  return Number.isFinite(at) ? at : 0;
}

/** 本地这份还新鲜吗。没有记录（0）永远算过期——第一次一定要真去取。 */
function avatarFresh(qq: string): boolean {
  return Date.now() - avatarCheckedAt(qq) < AVATAR_RECHECK_MS;
}

/**
 * 取一个 QQ 号的头像并落成本地 /media 文件，返回可直接显示的路径。
 *
 * 四道闸，少一道盘上就会长副本（2026-11-06 在真库里查到同一张头像存了 36 份）：
 *   ① 号码级：`assets.origin_ref = qq:<号>` 命中、文件还在、且还在保质期内 → 直接复用，连网络都不走；
 *   ② 并发级：同号码的 in-flight 合并，并发的两个请求不会各下一遍；
 *   ③ 内容级：下回来先算内容指纹，命中已有资产就复用它、把刚落的这份释放掉
 *      ——同一个人两个号、或者历史遗留的副本，都能靠指纹收敛回一个文件；
 *   ④ 来源唯一：内容真的变了（QQ 那边换了头像）才让旧的交出 `origin_ref`、新的顶上。
 *      少了这一道，库里会有两行都写着同一个号，刷新过也白搭。
 *
 * refresh=true 只跳过①的保质期：用户明确说“我刚换了头像”，那就得真的重新下一遍；
 * 但③④ 仍然生效，头像没变时还是指向同一个文件（不会因为刷新就多一份）。
 */
async function qqAvatarFor(qq: string, refresh = false): Promise<string> {
  const origin = avatarOrigin(qq);
  const cached = (): string => {
    const row = findAssetByOriginRef(origin);
    return row !== null && mediaUrlExists(row.url) ? row.url : "";
  };
  if (!refresh) {
    const known = cached();
    if (known !== "" && avatarFresh(qq)) return known;
  }
  const key = refresh ? `r:${qq}` : qq;
  const running = avatarInFlight.get(key);
  if (running !== undefined) return running;

  const task = (async (): Promise<string> => {
    try {
      // 排到队尾时前一个请求可能刚刚把同一个号落定：再看一眼，别白下一遍。
      const again = cached();
      if (!refresh && again !== "" && avatarFresh(qq)) return again;

      let fresh: string;
      try {
        fresh = await downloadImageToMedia(`https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`);
      } catch (error) {
        // 对账时网络抽风不能把资料页打成 502：本地那份还能显就先用它，下回再对。
        // 但 refresh 是用户明确要的“重新取一份”，取不到就得报错——不能静默回一张旧的。
        if (again !== "" && !refresh) return again;
        throw error;
      }

      // 没有头像的号拿到的是 QQ 那张占位图：实测两个不存在号回来的**字节完全一致**
      // （971B 的 PNG），而真有头像的在 s=640 下都是几十 KB。判据特意写得窄
      // （PNG 且 < 4KB），宁可漏判也不误伤一张真头像。
      const file = readMedia(fresh);
      if (file !== null && file.mime === "image/png" && file.buffer.length < 4096) {
        releaseMediaFiles([fresh]);
        // 对账时才发现号上没头像（对方把头像撤了）：旧的那份先接着显，别让界面裂图。
        // 不擦对账时间——下一轮还会再试，真的改了号也会及时报错。
        if (again !== "" && !refresh) return again;
        throw new QqAvatarUnavailable("这个 QQ 号取不到头像（QQ 回的是默认占位图）——号码可能不对，也可能这个号没设过头像");
      }

      // 这一趟对账算完成了：不管变没变，保质期从此刻起。
      kvSet(avatarCheckedKey(qq), String(Date.now()));

      const raw = getAssetByUrl(fresh);
      const same = raw === null || raw.hash === "" ? null : findAssetByHash(raw.hash, fresh);
      if (same !== null && mediaUrlExists(same.url)) {
        // 内容没变——或者这张图早就以别的身份在库里（同一张头像被两个号用）。
        // 让刚下的这份退场，同时把凭据从旧的那一行递给留下的这一行。
        releaseAssetOriginRef(origin, same.url);
        claimAsset(same.url, { source: "avatar", originRef: origin });
        releaseMediaFiles([fresh]);
        return same.url;
      }
      // 内容真的变了：旧的先交出凭据，否则下一次查到的还是它。旧文件不删——
      // 可能还有联系人拿它当头像，该不该清交给引用检查。
      releaseAssetOriginRef(origin, fresh);
      claimAsset(fresh, { source: "avatar", originRef: origin });
      return fresh;
    } finally {
      avatarInFlight.delete(key);
    }
  })();
  avatarInFlight.set(key, task);
  return task;
}

const staticRoute: Route = async ({ req, res, url, path, method }) => {
  // ── 页面 ────────────────────────────────────────────────
  // 前端只有 React 一轨：/ 与全部静态资源都来自 frontend/dist 构建产物。
  // dist 缺失只可能是没跑 `npm run fe:build`，给一句人话提示，而不是白屏。
  if (method === "GET" && (path === "/" || path === "/index.html")) {
    if (reactEntry) {
      // no-cache 而不是 no-store：浏览器可以存，但每次刷新都要拿 ETag 回来验——
      // 同一次构建内直接 304 零字节（穿透下省掉整个 HTML 正文的往返），发新版又不会 stale。
      sendFile(req, res, joinPath(reactDist, "index.html"), "text/html; charset=utf-8", NO_CACHE);
    } else {
      sendHtml(res, missingDistHtml());
    }
    return true;
  }
  if (method === "GET" && path.startsWith("/assets/")) {
    // Vite 产物在 dist/assets/ 下；URL 的 /assets/ 对应 dist 内的 assets/ 目录。
    // 文件名带内容 hash：内容一变 URL 就变，所以可以永久缓存——此前一律 no-store，
    // 每次刷新都要重下 320KB 的 js/css（穿透访问时是好几秒）。
    serveDistFile(reactDist, "assets/" + path.slice("/assets/".length), req, res, IMMUTABLE);
    return true;
  }
  if (method === "GET" && ROOT_IMAGE_ASSETS.has(path)) {
    // 应用图标（标签页 + 关于界面）与两张内置默认头像：都在 frontend/public 下，Vite 原样拷进 dist 根。
    // 文件名不带 hash 不能永久缓存，但 no-store 意味着每次开页面都要穿一次隧道；
    // 一小时短缓存折中：内容变了最多 stale 一小时，日常刷新少一次回源。
    serveDistFile(reactDist, path.slice(1), req, res, SHORT_CACHE);
    return true;
  }

  /**
   * 链接预览：只返回标题/描述/domain/小图标，不把网页正文带进聊天。
   * 页面抓取和 favicon 下载都走 web.ts 的同一扇门，重定向仍逐跳校验。
   */
  if (method === "GET" && path === "/api/link-preview") {
    // 这是一个**有副作用**的 GET（服务端会去抓外站）。跨站 <img> 请求不带 Origin，
    // 本机守卫会放行；所以再看一眼 Sec-Fetch-Site：只接受同源页面或直接导航。
    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
      sendJson(res, 403, { ok: false, error: "不允许跨站请求链接预览" });
      return true;
    }
    const target = (url.searchParams.get("url") ?? "").trim();
    if (target === "") {
      sendJson(res, 400, { ok: false, error: "url 不能为空" });
      return true;
    }
    try {
      const preview = await linkPreviewFor(target);
      sendJson(res, 200, { ok: true, preview });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: describeWebFailure(error) });
    }
    return true;
  }

  /**
   * 用 QQ 号取头像：把 qlogo 那张抓成本地 /media 文件再回路径。
   *
   * 为什么必须过服务端：界面那条 CSP 是 `connect-src 'self'`，前端直接 fetch 外站会被浏览器
   * 拦掉；而且全项目只有 web.ts 一扇出网门（地址校验 / 字节上限 / MIME 白名单都在那儿）。
   * 为什么落成本地文件而不是把外站直链给联系人：QQ 换头像、哪天换域名，直链就是一张裂图；
   * /media 的那份跟着数据目录走，也才有东西可备份。
   *
   * 但「落盘」不等于「每次都落新的」：去重全在 qqAvatarFor 里，见那段注释。
   */
  if (method === "POST" && path === "/api/avatar/qq") {
    const body = await readJson<{ qq?: unknown; refresh?: unknown }>(req);
    const qq = String(body.qq ?? "").trim();
    const refresh = body.refresh === true;
    if (!/^[1-9]\d{4,10}$/.test(qq)) {
      sendJson(res, 400, { ok: false, error: "QQ 号看着不对：应当是 5~11 位数字" });
      return true;
    }
    try {
      const mediaUrl = await qqAvatarFor(qq, refresh);
      sendJson(res, 200, { ok: true, url: mediaUrl });
      return true;
    } catch (error) {
      if (error instanceof QqAvatarUnavailable) {
        sendJson(res, 404, { ok: false, error: error.message });
        return true;
      }
      sendJson(res, 502, { ok: false, error: describeWebFailure(error) });
      return true;
    }
  }

  if (method === "GET" && path.startsWith("/media/")) {
    // 聊天图片：文件名形状校验在 media.ts 里做（含防穿越），内容是随机 id，可永久缓存
    const url0 = decodeURIComponent(path);
    // 视频壁纸走流式：文件可达上百 MB，整读进内存再下发既慢又占内存，
    // 而且 <video> 拖动进度条依赖 Range/206（WebView 会先发 HEAD 类探测请求）。
    const info = mediaFileInfo(url0);
    if (info !== null) {
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match && (match[1] !== "" || match[2] !== "")) {
          let start: number;
          let end: number;
          if (match[1] === "") {
            // 后缀形式 bytes=-N：取末尾 N 字节
            const suffix = Math.min(Number(match[2]), info.size);
            start = info.size - suffix;
            end = info.size - 1;
          } else {
            start = Number(match[1]);
            end = match[2] === "" ? info.size - 1 : Math.min(Number(match[2]), info.size - 1);
          }
          if (start <= end && start < info.size) {
            res.writeHead(206, {
              "content-type": info.mime,
              "content-length": end - start + 1,
              "content-range": `bytes ${start}-${end}/${info.size}`,
              "accept-ranges": "bytes",
              "cache-control": IMMUTABLE,
              "x-content-type-options": "nosniff",
            });
            createReadStream(info.file, { start, end }).pipe(res);
            return true;
          }
          res.writeHead(416, { "content-range": `bytes */${info.size}` });
          res.end();
          return true;
        }
      }
      res.writeHead(200, {
        "content-type": info.mime,
        "content-length": info.size,
        "accept-ranges": "bytes",
        "cache-control": IMMUTABLE,
        "x-content-type-options": "nosniff",
      });
      createReadStream(info.file).pipe(res);
      return true;
    }
    const file = readMedia(url0);
    if (!file) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return true;
    }
    res.writeHead(200, {
      "content-type": file.mime,
      "cache-control": IMMUTABLE,
      "x-content-type-options": "nosniff",
    });
    res.end(file.buffer);
    return true;
  }

  // 历史入口：旧链接 /memory 等 302 到 React 的 hash 路由
  if (method === "GET" && (path === "/memory" || path === "/memory/")) {
    sendRedirect(res, "/#/memory");
    return true;
  }
  if (method === "GET" && (path === "/status" || path === "/status/")) {
    sendRedirect(res, "/#/status");
    return true;
  }
  if (method === "GET" && (path === "/settings" || path === "/settings/")) {
    sendRedirect(res, "/#/settings");
    return true;
  }
  return false;
};

export const routes: Route[] = [staticRoute];
