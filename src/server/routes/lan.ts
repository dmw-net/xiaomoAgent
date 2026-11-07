// 局域网 / 隧道访问管理：__lan 登录页与登录接口、/api/lan* 开关、端口、隧道域名、访问码。
//
// 安全语义（延续原 server.ts 注释，拆包不能改）：
// - 这些设置只能在「本机 + 本机地址」上改。光看 socket 来源不够：隧道也是从本机出去的，
//   那样远程访客就能读到访问码、关掉开关、改端口。
// - 绑监听地址要先让这次响应写完，再动 socket（否则 closeAllConnections 会把这条响应一起掐掉）。

import * as lan from "../../core/lan.ts";
import { config } from "../../core/config.ts";
import { lanSummary, probePort, isLocalMachineHost } from "../guard.ts";
import { sendJson, readJson } from "../http.ts";
import { sendLanLogin } from "../lan-login-page.ts";
import type { Route } from "../types.ts";

/** 手机访问（局域网开关）：登录接口 + 登录页。 */
const lanLoginRoute: Route = async ({ res, path, method, req, isLocalOperator }) => {
  // 免码的唯一情形：**从本机发起、且访问的就是本机地址**（本机浏览器 / 桌面窗口）。
  //   · 局域网手机：来源不是本机 → 要码；
  //   · 隧道：穿透程序在本机跑，socket 来源是 127.0.0.1，但 Host 是公网域名 → 也要码。
  // 最后那条是关键：只看来源的话，隧道等于一个没有门禁的公网入口。
  // 为什么必须要有门：/api/settings 会把模型密钥原文回给调用方（本机应用的有意设计），
  // 所以「可达」绝不能等于「可读」。
  if (!isLocalOperator && path !== lan.LAN_LOGIN_PATH && !lan.hasAccessCookie(req)) {
    if (path === "/" || path === "/index.html") {
      sendLanLogin(res);
      return true;
    }
    sendJson(res, 401, {
      ok: false,
      code: "LAN_AUTH",
      error: "需要访问码：在小茉「设置 → 系统与数据」查看",
    });
    return true;
  }

  if (path === lan.LAN_LOGIN_PATH) {
    if (method === "GET") {
      sendLanLogin(res);
      return true;
    }
    if (method === "POST") {
      // 前置限流检查：连续失败 5 次后锁定 30 秒
      const clientKey = lan.loginClientKey(req);
      const lockCheck = lan.isLoginLocked(clientKey);
      if (lockCheck.locked) {
        const seconds = Math.ceil(lockCheck.remainingMs / 1000);
        sendJson(res, 429, { ok: false, error: `尝试过多，请 ${seconds} 秒后再试` });
        return true;
      }
      const body = await readJson<{ code?: unknown }>(req);
      const want = typeof body.code === "string" ? lan.normalizeCode(body.code) : "";
      const expect = lan.lanCode();
      if (expect === "" || want !== expect) {
        lan.recordLoginAttempt(clientKey);
        sendJson(res, 401, { ok: false, error: "访问码不对" });
        return true;
      }
      lan.clearLoginAttempts(clientKey);
      // 隧道场景下走 HTTPS，cookie 必须加 Secure；本机 HTTP 场景下 Secure cookie 会被浏览器拒绝，
      // 所以按协议判断：有 X-Forwarded-Proto=https 或请求本身是 TLS 时加 Secure。
      // encrypted 只在 TLS 连接上才有（TLSSocket），IncomingMessage.socket 的静态类型是 Socket。
      const tlsSocket = req.socket as typeof req.socket & { encrypted?: boolean };
      const isSecure = req.headers["x-forwarded-proto"] === "https" || tlsSocket.encrypted === true;
      const secureFlag = isSecure ? "; Secure" : "";
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": `${lan.LAN_COOKIE}=${lan.currentToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secureFlag}`,
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  }
  return false;
};

/** /api/lan* 开关族：只能本机操作（含「换绑监听」的 rebind）。 */
const lanSettingsRoute: Route = async ({ req, res, path, method, rebind, isLocalOperator }) => {
  const isLanPath = path === "/api/lan" || path === "/api/lan/rotate" || path === "/api/lan/port" || path === "/api/lan/tunnel" || path === "/api/lan/code";
  if (!isLanPath) return false;
  // 这些设置只能在「本机 + 本机地址」上改。
  if (!isLocalOperator) {
    sendJson(res, 403, { ok: false, error: "只能在小茉运行的那台电脑上改这个开关" });
    return true;
  }
  if (path === "/api/lan" && method === "GET") {
    sendJson(res, 200, { ok: true, ...lanSummary(req) });
    return true;
  }
  if (path === "/api/lan" && method === "POST") {
    const body = await readJson<{ enabled?: unknown }>(req);
    lan.setLanEnabled(body.enabled === true);
    lan.clearBindError();
    // 绑监听地址要先让这次响应写完，再动 socket（否则 closeAllConnections 会把这条响应一起掐掉）。
    // 界面拿到 pending 后会再拉一次状态确认，绑不上时那边会看到 enabled 已经退回 false。
    const summary = lanSummary(req);
    sendJson(res, 200, { ok: true, ...summary, pending: true });
    setTimeout(() => { void rebind?.(); }, 80);
    return true;
  }
  if (path === "/api/lan/port" && method === "POST") {
    const body = await readJson<{ port?: unknown }>(req);
    const raw = body.port;
    const value = raw === "" || raw === null || raw === undefined ? 0 : Number(raw);
    const previousPort = lan.portSetting();
    const check = lan.setPort(value);
    if (!check.ok) {
      sendJson(res, 400, { ok: false, error: check.error });
      return true;
    }
    // 端口被占现在就说，别等用户重启完发现应用起不来。
    // 例外：目标端口就是**当前正在监听的那个**。那必定是小茉自己（桌面端 PORT=0，
    // 固定端口由 settings.port 决定），probe 必然 EADDRINUSE；用户只是把已经生效的端口
    // 又点了一次「应用」，不该看到「已被别的程序占用」。
    const listeningPort = req.socket.localPort ?? config.port;
    if (value !== 0 && value !== listeningPort) {
      const probe = await probePort(value);
      if (!probe.ok) {
        lan.setPort(previousPort);
        sendJson(res, 400, { ok: false, error: probe.error });
        return true;
      }
    }
    sendJson(res, 200, { ok: true, ...lanSummary(req) });
    return true;
  }
  if (path === "/api/lan/tunnel" && method === "POST") {
    const body = await readJson<{ hosts?: unknown }>(req);
    const list = Array.isArray(body.hosts)
      ? body.hosts.map((item) => String(item))
      : String(body.hosts ?? "").split(/[,\s]+/);
    const result = lan.setTunnelHosts(list);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true, ...lanSummary(req) });
    return true;
  }
  if (path === "/api/lan/rotate" && method === "POST") {
    lan.rotateLanCode();
    sendJson(res, 200, { ok: true, ...lanSummary(req) });
    return true;
  }
  if (path === "/api/lan/code" && method === "POST") {
    const body = await readJson<{ code?: unknown }>(req);
    const result = lan.setLanCode(typeof body.code === "string" ? body.code : "");
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true, ...lanSummary(req) });
    return true;
  }
  // 子分支都没接住（例如 GET /api/lan/rotate）：落空继续，与原顺序 if 链一致。
  return false;
};

export const routes: Route[] = [lanLoginRoute, lanSettingsRoute];
