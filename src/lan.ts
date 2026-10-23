// ── 局域网访问（手机 / 平板用浏览器打开这台电脑）────────────────
//
// 默认只绑回环地址是对的：模型密钥与全部聊天记录都在这台机器上。
// 但"手机躺着也能聊"是这个应用的常见用法，而让普通用户去改 .env 再重启，不是给普通用户走的路。
// 所以这里把「绑到哪」和「谁能进」收在同一处：打开开关 = 绑非回环地址 + 必须输访问码。
//
// 三条必须一起成立，缺一条就等于把聊天记录和模型密钥摆在同网段里：
//   1. **默认关闭**：只有用户显式打开才绑非回环地址；
//   2. **访问码 + cookie**：非本机请求除登录页/登录接口外一律 401。
//      —— `/api/settings` 会把模型密钥原文回给调用方（本机应用的有意设计，冒烟有断言钉着），
//      所以「同网段可达」必须同时意味着「同网段不可读」；
//   3. **Host 守卫照旧**（server.ts 的 isLocalMachineHost）挡 DNS rebinding —— 局域网模式下
//      它是唯一挡这条的东西，别绕过。
//
// 访问码存在 KV（不写 .env）：开关要能被应用内改，且改完要能立刻生效。

import { createHash, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { config } from "./config.ts";
import { kvGet, kvSet } from "./db.ts";

const KV_LAN = "settings.lan";
const KV_PORT = "settings.port";
const KV_TUNNEL = "settings.tunnelHosts";
/** 手机登录后拿到的 cookie 名。 */
export const LAN_COOKIE = "xiaomo_lan";
/** 不带 cookie 也能访问的路径：登录页与登录接口本身。 */
export const LAN_LOGIN_PATH = "/__lan";
/** 回环地址集合：与 server.ts 的判定同一口径。 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

type Stored = { enabled: boolean; code: string };

function read(): Stored {
  const raw = kvGet(KV_LAN);
  if (raw === null || raw === "") return { enabled: false, code: "" };
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown; code?: unknown };
    return {
      enabled: parsed.enabled === true,
      code: typeof parsed.code === "string" ? parsed.code : "",
    };
  } catch {
    return { enabled: false, code: "" };
  }
}

function write(state: Stored): void {
  kvSet(KV_LAN, JSON.stringify(state));
}

/** 六位数字码：人念得出来、在手机上输得进去。 */
function freshCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** 面板上显示的形态：123-456。 */
export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/** 去掉分隔符与空格，只留数字：用户怎么输都能对上。 */
export function normalizeCode(input: string): string {
  return input.replace(/[^0-9]/g, "");
}

export function lanEnabled(): boolean {
  return read().enabled;
}

export function lanCode(): string {
  return read().code;
}

/** 打开时若还没有码就现生成；关掉保留原码（下次打开还是它，手机不用重新输）。 */
export function setLanEnabled(enabled: boolean): { enabled: boolean; code: string } {
  const current = read();
  const next: Stored = { enabled, code: current.code };
  if (enabled && next.code === "") next.code = freshCode();
  write(next);
  return { enabled: next.enabled, code: next.code };
}

/** 换一把码：已经连上的手机会在下次请求被挡回登录页。 */
export function rotateLanCode(): { enabled: boolean; code: string } {
  const current = read();
  const next: Stored = { enabled: current.enabled, code: freshCode() };
  write(next);
  return { enabled: next.enabled, code: next.code };
}

/** 最近一次绑定失败的原因（端口被占 / 防火墙拦了）。绑不上时界面要能说出为什么。 */
let lastBindError = "";
export function setBindError(message: string): void { lastBindError = message; }
export function clearBindError(): void { lastBindError = ""; }
export function bindError(): string { return lastBindError; }

// ── 固定端口 ────────────────────────────────────────────────
// 桌面外壳是用 PORT=0 起的（让系统挑一个空闲端口，躲开被占的白屏），代价是每次启动端口都变，
// 隧道程序没法指向它。所以给用户一个「固定端口」：只有外壳给的 PORT 是 0 时它才生效，
// 命令行显式给了 PORT 就以环境变量为准——那是开发者明确的意图。

/** 用户设的端口；0 = 自动分配。 */
export function portSetting(): number {
  const raw = kvGet(KV_PORT);
  if (raw === null || raw === "") return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 0;
}

/** 下次启动会用的端口（0 = 仍然自动分配）。改它要重启应用：WebView 已经指在旧端口上了。 */
export function effectivePort(): number {
  const wanted = portSetting();
  return config.port === 0 && wanted > 0 ? wanted : config.port;
}

export function setPort(value: number): { ok: boolean; error: string } {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    return { ok: false, error: "端口得是 0–65535 的整数" };
  }
  if (value !== 0 && value < 1024) {
    return { ok: false, error: "1024 以下要管理员权限，换个 1024–65535 的端口" };
  }
  kvSet(KV_PORT, String(value));
  return { ok: true, error: "" };
}

// ── 隧道域名（内网穿透）─────────────────────────────────────
// 为什么需要它：穿透程序在本机跑，请求进来时 Host 是它给的公网域名。
// 而 Host 守卫只认「本机地址」，于是隧道域名会被 403 挡掉——所以要让用户把自己那个域名填进来。
// 只在白名单里的域名才放行，是防 DNS rebinding 的那道门，不能改成「全都放行」。

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * 用户常从地址栏直接粘 `host:port`。Host 头在比较前已经剥掉端口（hostnameOfHostHeader），
 * 所以存下来的也必须是裸主机名；这里统一剥掉端口再校验/去重。
 * （旧正则写成 `(:d{1,5})?`，字面量 `:d`，带端口的域名会被拒，是另一个坑。）
 */
function normalizeHost(raw: string): string {
  return String(raw).trim().toLowerCase().replace(/:\d{1,5}$/, "");
}

export function tunnelHosts(): string[] {
  const raw = kvGet(KV_TUNNEL);
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalizeHost(String(item))).filter((item) => item !== "");
  } catch {
    return [];
  }
}

export function setTunnelHosts(input: string[]): { ok: boolean; error: string; hosts: string[] } {
  const hosts = [...new Set(input.map((item) => normalizeHost(String(item))).filter((item) => item !== ""))];
  for (const host of hosts) {
    if (!HOST_RE.test(host)) return { ok: false, error: `这个域名看着不对：${host}`, hosts: tunnelHosts() };
  }
  kvSet(KV_TUNNEL, JSON.stringify(hosts));
  // 隧道是公网可达的：只要有域名，就必须存在一道访问码（没有就现生成一个）。
  if (hosts.length > 0) ensureCode();
  return { ok: true, error: "", hosts };
}

/** 显式信任的域名：配置文件里那份（TRUSTED_HOSTS）仍然有效，两边取并集。 */
export function isTrustedHost(host: string): boolean {
  if (host === "") return false;
  // 环境变量里的白名单也按同一口径归一化，允许写成 `xiaomo.example.com:443`。
  return config.trustedHosts.some((item) => normalizeHost(item) === host) || tunnelHosts().includes(host);
}

/** 需要一个访问码（局域网或隧道要用）时调用：没有就现生成一个返回。 */
export function ensureCode(): string {
  const current = read();
  if (current.code !== "") return current.code;
  const code = freshCode();
  write({ enabled: current.enabled, code });
  return code;
}

/** 实际监听的地址：开关打开就绑所有网卡，否则听 .env 里那个（默认回环）。 */

export function bindHost(): string {
  return lanEnabled() ? "0.0.0.0" : config.host;
}

/** 现在是不是"只绑本机"。server.ts 的守卫、index.ts 的监听都按它算，别再各自读 config.host。 */
export function isLoopbackBind(): boolean {
  return LOOPBACK.has(bindHost());
}

/**
 * cookie 里放的值：由访问码派生，重启后手机不用重新输。
 * 刻意不直接放访问码——cookie 会长期留在手机浏览器里，
 * 拿到 cookie 的人不该等于"知道了访问码"（否则他也念得出来给别人）。
 */
export function tokenForCode(code: string): string {
  return createHash("sha256").update(`xiaomo-lan:${code}`).digest("hex");
}

export function currentToken(): string {
  const code = lanCode();
  return code === "" ? "" : tokenForCode(code);
}

/** 请求是不是从这台机器自己发起的。 */
export function fromLoopback(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? "";
  // IPv4 映射形态（::ffff:127.0.0.1）也是本机，别漏。
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

/** 非本机请求有没有带上正确的 cookie。 */
export function hasAccessCookie(request: IncomingMessage): boolean {
  const expected = currentToken();
  if (expected === "") return false;
  const header = request.headers.cookie;
  if (typeof header !== "string" || header === "") return false;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LAN_COOKIE) continue;
    if (part.slice(eq + 1).trim() === expected) return true;
  }
  return false;
}

/** 这台机器上手机能打开的地址（按网卡现取，DHCP 换地址不用重启）。 */
export function lanUrls(port: number): string[] {
  const out: string[] = [];
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      out.push(`http://${info.address}:${port}`);
    }
  }
  return out;
}
