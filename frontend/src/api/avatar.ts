import { postJson } from "./client";

/**
 * 用 QQ 号取头像：后端把 qlogo 那张抓成本地 /media 文件，回来的是一条 /media 路径。
 *
 * 为什么不让前端直接抓：界面那条 CSP 是 `connect-src 'self'`，跨站请求会被浏览器拦掉；
 * 出网也只有 web.ts 那一扇门（地址校验、字节上限、MIME 白名单）。
 * 取到的是**本地文件**而不是 QQ 的直链——直链会在对方换头像或换域名的那天变成裂图。
 *
 * 缓存只是省掉重复的本地往返，**不是**头像的真理来源：落盘、按号复用、跟 QQ 对账全在服务端
 * （见 pages.ts 的 qqAvatarFor）。所以这里的有效期很短——服务端认定「该对账了」的时候，
 * 前端不能拿自己那份旧结果把这次对账挡掉。真要立刻刷新（用户刚换了 QQ 头像）传 fresh。
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; task: Promise<{ url: string }> }>();

export function fetchQqAvatar(qq: string, options: { fresh?: boolean } = {}): Promise<{ url: string }> {
  if (options.fresh === true) cache.delete(qq);
  const hit = cache.get(qq);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.task;
  // 失败不进缓存：号码打错、网络抽风都得让下一次点击真的重试，而不是回放同一个错误。
  const task = postJson<{ url: string }>("/api/avatar/qq", { qq, refresh: options.fresh === true }).catch((error: unknown) => {
    cache.delete(qq);
    throw error;
  });
  cache.set(qq, { at: Date.now(), task });
  return task;
}
