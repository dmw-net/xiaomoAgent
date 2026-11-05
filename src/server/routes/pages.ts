// 页面与静态资源：React 产物、头像白名单、链接预览、QQ 头像抓取、聊天媒体（含 Range/ETag）、
// 历史路径 302。
//
// 顺序敏感：/api/link-preview 与 /api/avatar/qq 必须排在 /media 之前吗？不需要——路径不重叠。
// 但 /media/* 整块排在 / 与 /assets/ 之后，保持与原 handle() 一致（先页面后数据）。

import { createReadStream, existsSync } from "node:fs";
import { join as joinPath, resolve } from "node:path";
import { mediaFileInfo, readMedia, releaseMediaFiles } from "../../media/media.ts";
import { describeWebFailure, downloadImageToMedia } from "../../mind/search.ts";
import { linkPreviewFor } from "../../mind/link-preview.ts";
import {
  IMMUTABLE,
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
/** dist 根下逐条白名单发出的固定静态图（文件名不带 hash，故沿用 no-store）：应用图标 + 两张内置头像。 */
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

const staticRoute: Route = async ({ req, res, url, path, method }) => {
  // ── 页面 ────────────────────────────────────────────────
  // 前端只有 React 一轨：/ 与全部静态资源都来自 frontend/dist 构建产物。
  // dist 缺失只可能是没跑 `npm run fe:build`，给一句人话提示，而不是白屏。
  if (method === "GET" && (path === "/" || path === "/index.html")) {
    if (reactEntry) {
      sendFile(req, res, joinPath(reactDist, "index.html"), "text/html; charset=utf-8");
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
    // 应用图标（标签页 + 关于界面）与两张内置默认头像：都在 frontend/public 下，Vite 原样拷进 dist 根
    serveDistFile(reactDist, path.slice(1), req, res);
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
   */
  if (method === "POST" && path === "/api/avatar/qq") {
    const body = await readJson<{ qq?: unknown }>(req);
    const qq = String(body.qq ?? "").trim();
    if (!/^[1-9]\d{4,10}$/.test(qq)) {
      sendJson(res, 400, { ok: false, error: "QQ 号看着不对：应当是 5~11 位数字" });
      return true;
    }
    try {
      const mediaUrl = await downloadImageToMedia(`https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`);
      // 没有头像的号拿到的是 QQ 那张占位图：实测两个不存在的号回来的**字节完全一致**
      // （971B 的 PNG），而真有头像的在 s=640 下都是几十 KB。判据特意写得窄
      // （PNG 且 < 4KB），宁可漏判也不误伤一张真头像。
      const file = readMedia(mediaUrl);
      if (file !== null && file.mime === "image/png" && file.buffer.length < 4096) {
        releaseMediaFiles([mediaUrl]);
        sendJson(res, 404, { ok: false, error: "这个 QQ 号取不到头像（QQ 回的是默认占位图）——号码可能不对，也可能这个号没设过头像" });
        return true;
      }
      sendJson(res, 200, { ok: true, url: mediaUrl });
      return true;
    } catch (error) {
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
