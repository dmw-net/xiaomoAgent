import { getJson, postJson } from "./client";

/**
 * 手机与远程访问（局域网 / 固定端口 / 内网穿透）。
 *
 * 这些设置**只能在运行小茉的这台电脑上改**：服务端按「来源 + Host」判断，
 * 来自局域网或隧道（哪怕隧道程序在本机跑）的写请求一律 403——
 * 把它们交给外部，等于把门锁一起交出去。
 */
export type LanState = {
  ok: boolean;
  /** 局域网访问开关。 */
  enabled: boolean;
  /** 六位访问码，形如 123-456；局域网或隧道要用时一定存在。 */
  code: string;
  /** 服务端此刻是否真的绑在非回环地址上（刚点完开关时可能还在换绑）。 */
  bound: boolean;
  /** 手机可以打开的地址（按网卡现取，DHCP 换地址不用重启）。 */
  urls: string[];
  /** 上一次换绑失败的原因；空串 = 没出过错。 */
  bindError: string;
  /** 当前实际监听的端口（桌面端默认是系统随机分配的）。 */
  port: number;
  /** 用户设的固定端口；0 = 自动分配。 */
  portSetting: number;
  /** 下次启动会用哪个端口（0 = 仍自动）。与 port 不同时提示「重启生效」。 */
  portNext: number;
  /** 允许作为 Host 进来的隧道域名（配置文件里那份 TRUSTED_HOSTS 也仍然有效）。 */
  tunnelHosts: string[];
  pending?: boolean;
};

export function fetchLan(): Promise<LanState> {
  return getJson<LanState>("/api/lan");
}

export function setLan(enabled: boolean): Promise<LanState> {
  return postJson<LanState>("/api/lan", { enabled });
}

/** 固定端口（0 = 自动分配）。改完要重启应用：WebView 已经指在旧端口上了。 */
export function setLanPort(port: number): Promise<LanState> {
  return postJson<LanState>("/api/lan/port", { port });
}

/** 隧道域名白名单（内网穿透）。有域名时会自动确保存在一个访问码。 */
export function saveTunnelHosts(hosts: string[]): Promise<LanState> {
  return postJson<LanState>("/api/lan/tunnel", { hosts });
}

/** 换一把访问码：已经连上的手机会在下次请求被挡回登录页。 */
export function rotateLanCode(): Promise<LanState> {
  return postJson<LanState>("/api/lan/rotate");
}

/** 自定义访问码（6–12 位数字）。已连设备会用 token 失效的方式被要求重输。 */
export function setLanCode(code: string): Promise<LanState> {
  return postJson<LanState>("/api/lan/code", { code });
}
