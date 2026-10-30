// HTTP 入口。只用 Node 内置 http，零依赖。
//
// 结构：本文件只做三件事——
//   1. 入口守卫（百分号转义 400、本机守卫 403）；
//   2. 访问码门（lan.LAN_LOGIN_PATH 登录页/接口 + /api/lan* 设置）；
//   3. 按 router.ts 的有序总表分发（各域路由见 src/server/routes/）。
//
// 路由分域（各模块顶部有各自的顺序说明）：
//   【页面】 /（React 产物）、/assets/*、/media/*、/memory|/status|/settings 旧路径 302
//   【对话】 /api/say → /api/turn/* → /api/turns/recent → /api/messages* → /api/message/*
//   【设置】 /api/settings、/api/model/ping、配置档/供应商/能力档、提示词预览、思考开关
//   【平台】 QQ/微信连接（凭据按联系人隔离）、助手工作区、主动性任务
//   【自省】 /healthz、/api/status、/api/diagnostics、媒体维护、存储、用量、调用记录
//
// 一个纪律：所有 /api/* 都返回 JSON，且**永远**带 ok 字段。
// 前端只靠 ok 判断成败，不用去猜状态码的含义。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ensureDefaultContact,
} from "./contacts.ts";
import {
  ensureDefaultConversations,
} from "./conversations.ts";
import {
  ensureAssistantContact,
} from "./assistant.ts";
import {
  SettingsBodyError,
  markGzip,
  sendJson,
} from "./server/http.ts";
import {
  hostnameOfHostHeader,
  passesLocalGuard,
  isLocalMachineHost,
  isTrustedExternalHost,
} from "./server/guard.ts";
import * as lan from "./lan.ts";
import { dispatch } from "./server/router.ts";

export { SettingsBodyError };
// 冒烟钉住的两个守卫函数（src/scripts/smoke.ts 直接 import）：
export { isLocalMachineHost, isTrustedExternalHost };

export function createHttpServer(options: { rebind?: () => Promise<{ ok: boolean; error: string }> } = {}) {
  const rebind = options.rebind;
  // 存量迁移：首次遇到多联系人结构时，把旧的全局角色卡与数据归入默认联系人。
  ensureDefaultContact();
  ensureDefaultConversations();
  // 内置设置助手：保留联系人，一句话配模型/建联系人（工具白名单见 assistant.ts）。
  ensureAssistantContact();
  return createServer((request, response) => {
    handle(request, response, rebind).catch((error) => {
      const payload = error instanceof SettingsBodyError
        ? { status: 400 as const, body: { ok: false, error: error.message } }
        // 兜底：任何未捕获异常都要变成一次明确的 500，而不是静默断连。
        : { status: 500 as const, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      // 兜底自身绝不能崩进程：响应已销毁时 sendJson 会再抛，落在 .catch 里
      // 就是 unhandled rejection（Node 15+ 直接崩）。先查状态、再包一层 try。
      if (response.destroyed || response.writableEnded) return;
      try {
        sendJson(response, payload.status, payload.body);
      } catch { /* 连接已断，写不进去就算了 */ }
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  rebind?: () => Promise<{ ok: boolean; error: string }>,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = request.method ?? "GET";
  markGzip(request, response);

  // ── 本机守卫（防 DNS rebinding / 外来网页伪造请求）──
  // 规则与取舍见 server/guard.ts passesLocalGuard 的注释。
  const hostHeader = hostnameOfHostHeader(request.headers.host ?? "");
  // 畸形百分号转义（/media/%zz）会让后面任何一处 decodeURIComponent 抛 URIError，
  // 被最外层兜底 catch 变成 500。那是请求本身不合法，不是服务端出错，统一在这里按 400 挡掉。
  // 光看"百分号后是否两位 hex"不够：%E0%A4 每段都合法，拼起来却不是合法 UTF-8，
  // 一样会抛——所以直接试解码，失败即 400。
  if (path.includes("%")) {
    try {
      decodeURIComponent(path);
    } catch {
      sendJson(response, 400, { ok: false, error: "URL 里有不合法的百分号转义" });
      return;
    }
  }
  if (!passesLocalGuard(request, hostHeader)) {
    // 分清是 Host 不过还是 Origin 不过：两者该改的地方完全不同（前者是监听地址/访问方式，
    // 后者是哪个网页在调），合成一句"不允许"会让人两头查。
    const loopbackBinds = new Set(["127.0.0.1", "localhost", "::1"]);
    const hostBad = lan.isLoopbackBind() && !loopbackBinds.has(hostHeader);
    sendJson(response, 403, {
      ok: false,
      code: hostBad ? "HOST_FORBIDDEN" : "ORIGIN_FORBIDDEN",
      error: hostBad ? "这个服务只接受指向本机的访问（Host 校验失败）" : "不允许外来网页调用本机接口",
    });
    return;
  }

  // 访问码门 + 路由分发都在 router 表里（lan 域最先，见 router.ts 的注释）。
  const isLocalOperator = lan.fromLoopback(request) && isLocalMachineHost(hostHeader);
  await dispatch({ req: request, res: response, url, path, method, rebind, isLocalOperator });
}
