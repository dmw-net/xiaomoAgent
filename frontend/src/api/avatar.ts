import { postJson } from "./client";

/**
 * 用 QQ 号取头像：后端把 qlogo 那张抓成本地 /media 文件，回来的是一条 /media 路径。
 *
 * 为什么不让前端直接抓：界面那条 CSP 是 `connect-src 'self'`，跨站请求会被浏览器拦掉；
 * 出网也只有 web.ts 那一扇门（地址校验、字节上限、MIME 白名单）。
 * 取到的是**本地文件**而不是 QQ 的直链——直链会在对方换头像或换域名的那天变成裂图。
 */
export function fetchQqAvatar(qq: string): Promise<{ url: string }> {
  return postJson("/api/avatar/qq", { qq });
}