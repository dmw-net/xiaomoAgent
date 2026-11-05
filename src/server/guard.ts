// 路由前的安全门与局域网辅助：本机守卫（防 DNS rebinding / 外来网页伪造请求）、
// 端口探测、局域网状态汇总。
//
// 这些不是路由（它们不响应用户请求，而是决定「这个请求能不能进」），
// 但路由模块（lan.ts）要读它们的结论，所以单独收一层，避免路由之间互相引。

import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import * as lan from "../core/lan.ts";
import { config } from "../core/config.ts";

/**
 * 从 Host 头里取主机名。
 *
 * ⚠️ 不能 `split(":")[0]`：IPv6 字面量写成 `[::1]:8787`，按冒号切得到的是 `"["`，
 * 剥掉括号后变空串——于是 `loopbackBinds` 永远匹配不上，绑 `::1` 时**每个请求都 403**
 * （而 `::1` 是 `loopbackBinds` 明确支持的配置）。必须先整体匹配方括号形态。
 */
export function hostnameOfHostHeader(raw: string): string {
  const value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return (bracketed[1] ?? "").toLowerCase();
  const plain = /^([^:]+)(?::\d+)?$/.exec(value);
  return (plain?.[1] ?? "").toLowerCase();
}

/** 隧道域名（见 config.trustedHosts）是否被显式信任。空串永不匹配。 */
export function isTrustedExternalHost(host: string): boolean {
  return lan.isTrustedHost(host);
}

/** 从 Origin 里取主机名，IPv6 字面量要去掉方括号（`new URL` 的 hostname 带括号）。 */
function hostnameOfOrigin(origin: string): string {
  let host = "?";
  try {
    host = new URL(origin).hostname;
  } catch { /* 畸形 Origin 按外来处理 */ }
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * 本机守卫：默认回环监听时，Host 必须指向本机、Origin 必须是本机页面（防 DNS rebinding
 * 与外来网页伪造请求）；桌面壳的 tauri.localhost 在白名单里。
 * 显式 HOST=0.0.0.0（局域网模式）时收得更紧：Host 必须是这台机器自己的地址。
 *
 * 两处**故意只比主机名、不比端口**——这是取舍而不是疏漏：同一台机器上的 dev server /
 * Electron / WebView 都跑在 127.0.0.1 的某个随机端口上，收了端口就等于把本机其它开发工具
 * 全判成外来。真正的读边界是「不发 CORS 响应头」（跨域读不到响应）；写请求能打进来这一点
 * 由下面的白名单 + 单机自用定位共同承担，README「安全须知」里也写明了。
 *
 * 但**回环模式放行任何本机端口**和**局域网模式被 DNS rebinding 按构造满足**是两件不同的事：
 * 后者必须堵。做法是要求 Host 落在"这台机器自己的地址"集合里（本机网卡地址 + 回环 +
 * 显式配置的那个 host）。attacker.com 解析到受害者局域网 IP 时，浏览器发出的
 * `Host: attacker.com:8787` 不在这个集合里，于是被拒——而正常用 `http://192.168.1.20:8787`
 * 访问的人不受影响。
 *
 * 隧道是这套规则唯一的例外：穿透程序把公网域名原样转发进来，它不是本机地址。
 * 因此加了 config.trustedHosts（环境变量 TRUSTED_HOSTS）——只有显式列进去的域名才放行，
 * 且强制 Origin 与 Host 同源。没配就完全没有这个开口，与从前一致。
 */
export function passesLocalGuard(request: IncomingMessage, hostHeader: string): boolean {
  const loopbackBinds = new Set(["127.0.0.1", "localhost", "::1"]);
  const isLoopbackBind = lan.isLoopbackBind();
  // 显式信任的隧道域名（config.trustedHosts）：公网穿透唯一的开口。Host 不是本机地址也
  // 放行，但下面的 Origin 校验会收紧到「必须与 Host 同源」，别的网页借不走这个域名。
  const isTrusted = isTrustedExternalHost(hostHeader);
  const hostAllowed = isTrusted
    ? true
    : isLoopbackBind
      ? loopbackBinds.has(hostHeader)
      : isLocalMachineHost(hostHeader);
  if (!hostAllowed) return false;
  const originHeader = request.headers.origin;
  if (typeof originHeader !== "string" || originHeader === "") return true;
  const originHost = hostnameOfOrigin(originHeader);
  if (isTrusted) return originHost === hostHeader;
  const allowed = new Set(["127.0.0.1", "localhost", "::1", "tauri.localhost", "app.tauri.localhost"]);
  return isLoopbackBind ? allowed.has(originHost) : originHost === hostHeader;
}

/** 这台机器自己的地址集合（局域网模式用）：本机网卡 + 回环 + 显式配置的 host。
 *  os.networkInterfaces() 每次现取—— DHCP 换了地址不该要重启才认。
 *  导出来给冒烟钉住：这道门是 LAN 模式下唯一挡 DNS rebinding 的东西。 */
export function isLocalMachineHost(host: string): boolean {
  // 空 Host 不放行：HTTP/1.1 强制要求这个头，空着只可能是畸形请求。
  // 从前这里把 "" 和 localhost 并列放过，于是 LAN 模式下少了一道本该拦住的输入。
  if (host === "") return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const bound = lan.bindHost();
  if (bound !== "" && bound !== "0.0.0.0" && bound === host) return true;
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.address.toLowerCase() === host) return true;
    }
  }
  return false;
}

/**
 * 试绑一下这个端口。被占的话现在就说清楚——等用户重启完发现白屏，是最难排查的那种失败。
 */
export async function probePort(port: number): Promise<{ ok: boolean; error: string }> {
  const { createServer } = await import("node:net");
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        error: error.code === "EADDRINUSE"
          ? `端口 ${port} 已被占用（别的程序，或另一个小茉实例），换一个`
          : `端口 ${port} 用不了：${error.message}`,
      });
    });
    probe.once("listening", () => probe.close(() => resolve({ ok: true, error: "" })));
    probe.listen(port, "127.0.0.1");
  });
}

/** 给界面看的局域网状态。端口取当前连接的本地端口——PORT=0 自动分配时也是对的。 */
export function lanSummary(request: IncomingMessage): {
  enabled: boolean;
  code: string;
  bound: boolean;
  urls: string[];
  bindError: string;
  /** 当前实际监听的端口（桌面端默认是系统随机分配的）。 */
  port: number;
  /** 用户设的固定端口；0 = 自动分配。 */
  portSetting: number;
  /** 下次启动会用的端口（0 = 仍自动）；与 port 不同时界面提示「重启生效」。 */
  portNext: number;
  /** 允许作为 Host 进来的隧道域名。 */
  tunnelHosts: string[];
} {
  const port = request.socket.localPort ?? config.port;
  return {
    enabled: lan.lanEnabled(),
    code: lan.formatCode(lan.lanCode()),
    bound: !lan.isLoopbackBind(),
    urls: lan.lanUrls(port),
    bindError: lan.bindError(),
    // 当前实际监听的端口（桌面端默认是系统随机分配的）
    port,
    // 用户设的固定端口；0 = 自动分配
    portSetting: lan.portSetting(),
    // 下次启动会用的端口（0 = 仍自动）。不等于 port 时界面提示「重启生效」
    portNext: lan.effectivePort(),
    // 允许作为 Host 进来的隧道域名（配置里那份 TRUSTED_HOSTS 也仍然有效）
    tunnelHosts: lan.tunnelHosts(),
  };
}
