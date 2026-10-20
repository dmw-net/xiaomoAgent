// HTTP 入口。只用 Node 内置 http，零依赖。
//
// 路由分四组：
//   【页面】 /            React 前端（frontend/dist 构建产物）
//          /assets/*     Vite 产物静态资源
//          /memory|/status|/settings  旧路径 302 到 React hash 路由
//   【对话】 /api/say 收到消息立刻 202，不等模型
//          /api/turn/:id 查处理单状态
//          /api/turn/:id/retry 重试失败的一轮
//          /api/turn/:id/regenerate 重答这一轮（任何一轮都行；较早的轮次写回它原来的气泡位置）
//          /api/turn/:id/cancel 终止还在飞的一轮（整轮抹掉不留痕）
//          /api/messages 拉消息（since= 增量；all=1 全量，编辑后重绘用）
//          /api/message/:id/edit 改一条自己说的话，并从那里重新开始对话
//          /api/message/:id/text 只改这一句文本（她的回复或自己的话），不重生成、不作废后续
//          /api/message/:id/retract 撤回单条（软：摘出上下文，界面显示「已撤回」）
//          DELETE /api/message/:id 删除整轮（硬：真删行，不可恢复）
//   【设置】 /api/settings 读写（GET 回完整密钥、POST 落库即生效）
//          /api/model/ping 用"还没保存的参数"试连通(want=chat)或试拉模型列表(want=list)
//          /api/settings/preview 预览模型实际收到的系统提示词
//   【自省】 /healthz /api/status /api/logs /api/memory* /api/turns/* /api/model/ping
//
// 一个纪律：所有 /api/* 都返回 JSON，且**永远**带 ok 字段。
// 前端只靠 ok 判断成败，不用去猜状态码的含义。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { extname, join as joinPath, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { config } from "./config.ts";
import * as lan from "./lan.ts";
import {
  activateCapabilityProfile,
  activateProfile,
  CAPABILITY_LABELS,
  CAPABILITY_NAMES,
  capabilityActiveId,
  capabilityConfig,
  capabilityReady,
  capabilitiesStatus,
  deleteCapabilityProfile,
  saveCapabilityProfile,
  activeProfileId,
  currentCharacterName,
  deleteProfile,
  contactsBoundToProfile,
  listProfiles,
  modelConfig,
  modelReadyNow,
  onboardingDone,
  personaConfig,
  providerLabel,
  renameProvider,
  resetAll,
  sanitizeModelCaps,
  sanitizeThinkingMode,
  sanitizeThinkingParam,
  saveProfile,
  setOnboardingDone,
  settingsSnapshot,
  syncProviderConnection,
  THINKING_LEVELS,
  updateModel,
  updatePersona,
  validateCapabilityProfile,
  defaultPersona,
  validateModel,
  validatePersona,
  type CapabilityName,
  type CharacterCard,
  type ModelSettings,
  type OwnerProfile,
} from "./settings.ts";
import {
  allMessages,
  CHAT_EARLIER_PAGE,
  CHAT_FIRST_PAGE,
  countMessagesBefore,
  countMessagesFor,
  messagesForTurn,
  messagesBefore,
  messagesAround,
  searchMessages,
  searchMessagesForContact,
  contextUsage,
  deleteMessage,
  editAndRegenerate,
  getMessage,
  getTurn,
  imageProxiedHistory,
  lastUserMessageAt,
  messagesSince,
  recentMessages,
  cancelTurn,
  recentTurns,
  retractMessage,
  retryTurn,
  selectReplayImages,
  turnStats,
  updateAssistantText,
  updateUserMessageText,
} from "./agent.ts";
import {
  deleteMemoryEvent,
  restoreMemoryEvent,
  extractFailures,
  extractFailuresWorst,
  isMemoryKind,
  lastRecallAt,
  listMemoryEventsFiltered,
  searchMemoryEvents,
  memoryCount,
  memoryStats,
  recallExplained,
  rememberMessage,
  resetExtractFailures,
  updateMemoryEvent,
  type MemoryKind,
} from "./memory.ts";
import { lastModelCall, listInflightCalls, logModelCall, modelCallWindow, modelFailureCount, countModelCalls, modelCallById, recentModelCallSummaries, usageStats, failureWatermark, resetFailureCounters, type CallFilter } from "./logs.ts";
import { friendlyModelError, isChatModelId, listModels, pingChat, resetToolsUnsupported, synthesizeSpeech, transcribeAudio } from "./model.ts";
import { MAX_IMAGE_BYTES, mediaUrlExists, readMedia, releaseMediaFiles, saveImage } from "./media.ts";
import { describeWebFailure, downloadImageToMedia } from "./search.ts";
import { deleteArtifact, getArtifact, listArtifacts, setArtifactStarred } from "./artifacts.ts";
import { listContent, type ContentFilter } from "./content.ts";
import { getChannel, listChannels } from "./channels/types.ts";
import { cancelProactiveTask, countProactiveTasks, createProactiveTask, inspectGates, listProactiveTasks, pendingProactiveTask, restoreProactiveTask, runProactiveCheck } from "./proactive.ts";
/** React 前端构建产物目录（frontend/dist），页面与静态资源都从这里发。 */
const reactDist = resolve(import.meta.dirname ?? ".", "../frontend/dist");
const reactEntry = existsSync(joinPath(reactDist, "index.html"));
/** dist 根下逐条白名单发出的固定静态图（文件名不带 hash，故沿用 no-store）：应用图标 + 两张内置头像。 */
const ROOT_IMAGE_ASSETS = new Set(["/icon.png", "/xiaomo.png", "/assistant.png"]);

import { ALL_TURNS, archiveContact, ASSISTANT_CONTACT_ID, companionPromptExtras, contactCard, contactExists, createContact, DEFAULT_CONTACT_ID, defaultPersonaIsDefault, deleteContact, ensureDefaultContact, factoryReset, getContact, lastMessagePreview, listContacts, markContactRead, MAX_TURNS, restoreDefaultCard, sanitizeAvatar, sanitizeFaceRef, unreadCount, unarchiveContact, updateContact, type BondState, type CompanionFeatures, type ContactGender } from "./contacts.ts";
import { consolidateContact } from "./consolidate.ts";
import { autoTitleThread, clearAssistantThread, createAssistantThread, deleteAssistantThread, ensureAssistantContact, isAssistantThreadContactId, listAssistantThreads, renameAssistantThread } from "./assistant.ts";
import { deleteSkill, listSkills, MAX_SKILL_FILE_BYTES, readSkill, saveSkill, setSkillEnabled, skillsDir } from "./skills.ts";
import { migrateDataDir } from "./data-dir.ts";
import { importDataArchive, writeDataExport } from "./data-transfer.ts";
import { setDesktopPrefs } from "./desktop-prefs.ts";
import { wechat } from "./wechat.ts";
import { qq } from "./qq.ts";
import { previewSystemPrompt } from "./persona.ts";
import { leaseIsFreeOrOurs } from "./instance.ts";

const MAX_BODY_BYTES = 32 * 1024;
/** 录音 dataURL（base64 会膨胀 1/3）与语音合成响应都要比 32KB 宽得多，单独放宽给音频接口。 */
const MAX_AUDIO_BODY_BYTES = 8 * 1024 * 1024;
/**
 * 带头像/人设正文的写接口单独放宽。
 *
 * ⚠️ 从前这些路由吃 32KB 的通用上限，而同一批处理函数宣称的字段上限是 150KB
 * （owner.avatar，见 settings.ts 的 sanitizeOwner）和人设三段合计 30000 字。
 * 于是一张细节多的图（128×128 q0.85 的 base64 很容易越过 24KB→32KB）会在**字段校验之前**
 * 就被「请求体过大」挡掉，而那句提示说的是另一个数字——用户照着 150KB 去压图，压了还是被拒。
 * 放宽到 512KB：仍挡得住无界 body，又容得下"内联 dataURL + 三段合计 30000 字"这个合法组合
 * （30000 个汉字 UTF-8 约 90KB，加上 150KB 头像仍在 512KB 内）。
 */
const MAX_CARD_BODY_BYTES = 512 * 1024;

export function createHttpServer(options: { rebind?: () => Promise<{ ok: boolean; error: string }> } = {}) {
  const rebind = options.rebind;
  // 存量迁移：首次遇到多联系人结构时，把旧的全局角色卡与数据归入默认联系人。
  ensureDefaultContact();
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
  // 规则与取舍见文件末尾 passesLocalGuard 的注释。
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

  // ── 访问码门（局域网 + 隧道共用）───────────────────────────
  // 免码的唯一情形：**从本机发起、且访问的就是本机地址**（本机浏览器 / 桌面窗口）。
  //   · 局域网手机：来源不是本机 → 要码；
  //   · 隧道：穿透程序在本机跑，socket 来源是 127.0.0.1，但 Host 是公网域名 → 也要码。
  // 最后那条是关键：只看来源的话，隧道等于一个没有门禁的公网入口。
  // 为什么必须要有门：/api/settings 会把模型密钥原文回给调用方（本机应用的有意设计），
  // 所以「可达」绝不能等于「可读」。
  const isLocalOperator = lan.fromLoopback(request) && isLocalMachineHost(hostHeader);
  if (!isLocalOperator && path !== lan.LAN_LOGIN_PATH && !lan.hasAccessCookie(request)) {
    if (path === "/" || path === "/index.html") {
      sendLanLogin(response);
      return;
    }
    sendJson(response, 401, {
      ok: false,
      code: "LAN_AUTH",
      error: "需要访问码：请在这台电脑的小茉里打开「设置 → 系统与数据 → 远程访问」查看",
    });
    return;
  }

  // ── 手机访问（局域网开关）：登录接口 + 状态读写 ────────────
  if (path === lan.LAN_LOGIN_PATH) {
    if (method === "GET") {
      sendLanLogin(response);
      return;
    }
    if (method === "POST") {
      const body = await readJson<{ code?: unknown }>(request);
      const want = typeof body.code === "string" ? lan.normalizeCode(body.code) : "";
      const expect = lan.lanCode();
      if (expect === "" || want !== expect) {
        sendJson(response, 401, { ok: false, error: "访问码不对" });
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": `${lan.LAN_COOKIE}=${lan.currentToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  if (path === "/api/lan" || path === "/api/lan/rotate" || path === "/api/lan/port" || path === "/api/lan/tunnel") {
    // 这些设置只能在「本机 + 本机地址」上改。
    // 光看 socket 来源不够：隧道也是从本机出去的，那样远程访客就能读到访问码、关掉开关、改端口。
    if (!isLocalOperator) {
      sendJson(response, 403, { ok: false, error: "只能在小茉运行的那台电脑上改这个开关" });
      return;
    }
    if (path === "/api/lan" && method === "GET") {
      sendJson(response, 200, { ok: true, ...lanSummary(request) });
      return;
    }
    if (path === "/api/lan" && method === "POST") {
      const body = await readJson<{ enabled?: unknown }>(request);
      lan.setLanEnabled(body.enabled === true);
      lan.clearBindError();
      // 绑监听地址要先让这次响应写完，再动 socket（否则 closeAllConnections 会把这条响应一起掐掉）。
      // 界面拿到 pending 后会再拉一次状态确认，绑不上时那边会看到 enabled 已经退回 false。
      const summary = lanSummary(request);
      sendJson(response, 200, { ok: true, ...summary, pending: true });
      setTimeout(() => { void rebind?.(); }, 80);
      return;
    }
    if (path === "/api/lan/port" && method === "POST") {
      const body = await readJson<{ port?: unknown }>(request);
      const raw = body.port;
      const value = raw === "" || raw === null || raw === undefined ? 0 : Number(raw);
      const previousPort = lan.portSetting();
      const check = lan.setPort(value);
      if (!check.ok) {
        sendJson(response, 400, { ok: false, error: check.error });
        return;
      }
      // 端口被占现在就说，别等用户重启完发现应用起不来。
      if (value !== 0) {
        const probe = await probePort(value);
        if (!probe.ok) {
          lan.setPort(previousPort);
          sendJson(response, 400, { ok: false, error: probe.error });
          return;
        }
      }
      sendJson(response, 200, { ok: true, ...lanSummary(request) });
      return;
    }
    if (path === "/api/lan/tunnel" && method === "POST") {
      const body = await readJson<{ hosts?: unknown }>(request);
      const list = Array.isArray(body.hosts)
        ? body.hosts.map((item) => String(item))
        : String(body.hosts ?? "").split(/[,\s]+/);
      const result = lan.setTunnelHosts(list);
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: result.error });
        return;
      }
      sendJson(response, 200, { ok: true, ...lanSummary(request) });
      return;
    }
    if (path === "/api/lan/rotate" && method === "POST") {
      lan.rotateLanCode();
      sendJson(response, 200, { ok: true, ...lanSummary(request) });
      return;
    }
  }

  // ── 页面 ────────────────────────────────────────────────

  // 前端只有 React 一轨：/ 与全部静态资源都来自 frontend/dist 构建产物。
  // dist 缺失只可能是没跑 `npm run fe:build`，给一句人话提示，而不是白屏。
  if (method === "GET" && (path === "/" || path === "/index.html")) {
    if (reactEntry) {
      sendFile(response, joinPath(reactDist, "index.html"), "text/html; charset=utf-8");
    } else {
      sendHtml(response, missingDistHtml());
    }
    return;
  }
  if (method === "GET" && path.startsWith("/assets/")) {
    // Vite 产物在 dist/assets/ 下；URL 的 /assets/ 对应 dist 内的 assets/ 目录。
    // 文件名带内容 hash：内容一变 URL 就变，所以可以永久缓存——此前一律 no-store，
    // 每次刷新都要重下 320KB 的 js/css（穿透访问时是好几秒）。
    serveDistFile("assets/" + path.slice("/assets/".length), response, IMMUTABLE);
    return;
  }
  if (method === "GET" && ROOT_IMAGE_ASSETS.has(path)) {
    // 应用图标（标签页 + 关于界面）与两张内置默认头像：都在 frontend/public 下，Vite 原样拷进 dist 根
    serveDistFile(path.slice(1), response);
    return;
  }
  /**
   * 用 QQ 号取头像：把 qlogo 那张抓成本地 /media 文件再回路径。
   *
   * 为什么必须过服务端：界面那条 CSP 是 `connect-src 'self'`，前端直接 fetch 外站会被浏览器
   * 拦掉；而且全项目只有 web.ts 一扇出网门（地址校验 / 字节上限 / MIME 白名单都在那儿）。
   * 为什么落成本地文件而不是把外站直链给她：QQ 换头像、哪天换域名，直链就是一张裂图；
   * /media 那份跟着数据目录走，也才有东西可备份。
   */
  if (method === "POST" && path === "/api/avatar/qq") {
    const body = await readJson<{ qq?: unknown }>(request);
    const qq = String(body.qq ?? "").trim();
    if (!/^[1-9]\d{4,10}$/.test(qq)) {
      sendJson(response, 400, { ok: false, error: "QQ 号看着不对：应当是 5~11 位数字" });
      return;
    }
    try {
      const mediaUrl = await downloadImageToMedia(`https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`);
      // 没有头像的号拿到的是 QQ 那张占位图：实测两个不存在的号回来的**字节完全一致**
      // （971B 的 PNG），而真有头像的在 s=640 下都是几十 KB。判据特意写得窄
      // （PNG 且 < 4KB），宁可漏判也不误伤一张真头像。
      const file = readMedia(mediaUrl);
      if (file !== null && file.mime === "image/png" && file.buffer.length < 4096) {
        releaseMediaFiles([mediaUrl]);
        sendJson(response, 404, { ok: false, error: "这个 QQ 号取不到头像（QQ 回的是默认占位图）——号码可能不对，也可能这个号没设过头像" });
        return;
      }
      sendJson(response, 200, { ok: true, url: mediaUrl });
      return;
    } catch (error) {
      sendJson(response, 502, { ok: false, error: describeWebFailure(error) });
      return;
    }
  }

  if (method === "GET" && path.startsWith("/media/")) {
    // 聊天图片：文件名形状校验在 media.ts 里做（含防穿越），内容是随机 id，可永久缓存
    const file = readMedia(decodeURIComponent(path));
    if (!file) {
      sendJson(response, 404, { ok: false, error: "not found" });
      return;
    }
    response.writeHead(200, {
      "content-type": file.mime,
      "cache-control": IMMUTABLE,
      "x-content-type-options": "nosniff",
    });
    response.end(file.buffer);
    return;
  }
  // 历史入口：旧链接 /memory 等 302 到 React 的 hash 路由
  if (method === "GET" && (path === "/memory" || path === "/memory/")) {
    sendRedirect(response, "/#/memory");
    return;
  }
  if (method === "GET" && (path === "/status" || path === "/status/")) {
    sendRedirect(response, "/#/status");
    return;
  }
  if (method === "GET" && (path === "/settings" || path === "/settings/")) {
    sendRedirect(response, "/#/settings");
    return;
  }

  // ── 健康与自省 ──────────────────────────────────────────
  if (method === "GET" && path === "/healthz") {
    const lastCall = lastModelCall();
    // 「最近失败」也过一遍水印：点过重新计数之后，那条旧失败不该继续标红
    const lastFailure = lastCall && lastCall.ok === 0 && lastCall.created_at >= failureWatermark() ? lastCall : null;
    const healthModel = modelConfig();
    const healthReady = modelReadyNow(healthModel);
    sendJson(response, 200, {
      ok: true,
      character: currentCharacterName(),
      modelMode: healthModel.mode,
      modelReady: healthReady,
      model: healthReady ? healthModel.name : null,
      memoryEvents: memoryCount(DEFAULT_CONTACT_ID),
      // 全局体检问的是"有没有哪条通道正在坏"，所以取各联系人里的最大值，
      // 而不是某个共享计数器——失败的计数本来就按联系人各记一份。
      memoryExtractFailures: extractFailuresWorst(),
      lastRecallAt: lastRecallAt(DEFAULT_CONTACT_ID),
      modelFailures: modelFailureCount(),
      lastModelError: lastFailure
        ? {
            at: new Date(lastFailure.created_at).toISOString(),
            code: lastFailure.code,
            purpose: lastFailure.purpose,
            message: lastFailure.message,
          }
        : null,
      turns: turnStats(),
      channels: listChannels(),
      time: new Date().toISOString(),
    });
    return;
  }

  // 状态页一次性拿到体检需要的全部信息
  if (method === "GET" && path === "/api/status") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const lastCall = lastModelCall();
    // 「最近失败」也过一遍水印：点过重新计数之后，那条旧失败不该继续标红
    const lastFailure = lastCall && lastCall.ok === 0 && lastCall.created_at >= failureWatermark() ? lastCall : null;
    const model = modelConfig();
    const ready = modelReadyNow(model);
    sendJson(response, 200, {
      ok: true,
      character: currentCharacterName(),
      modelMode: model.mode,
      modelReady: ready,
      model: ready ? model.name : null,
      baseUrl: model.baseUrl,
      /** 这一家叫什么（供应商层的显示名；没起过就退回它第一份档的名字/主机名）。 */
      provider: providerLabel(model.baseUrl),
      /** 后端是否跑在开发模式（DEV_MODE=1，即 npm run dev）：前端据此自动露出排障 tab。 */
      devMode: config.devMode,
      dbPath: config.dbPath,
      memoryEvents: memoryCount(contactId),
      memoryExtractFailures: extractFailures(contactId),
      lastRecallAt: lastRecallAt(contactId),
      modelFailures: modelFailureCount(),
      /** 近 24 小时的调用/失败数：健康信号要时间窗，累计值会把多年前的失败一直挂着。 */
      recent: modelCallWindow(24),
      lastModelError: lastFailure
        ? {
            at: new Date(lastFailure.created_at).toISOString(),
            code: lastFailure.code,
            purpose: lastFailure.purpose,
            message: lastFailure.message,
          }
        : null,
      proactive: { ...inspectGates(contactId), enabled: config.proactive.enabled, intervalMinutes: config.proactive.intervalMinutes },
      turns: turnStats(),
      channels: listChannels(),
      /** 通道是全局资产（一个联系人一条链接），总览按整体报，不按当前会话那位报。 */
      wechat: wechat.summary(),
      qq: qq.summary(),
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
    return;
  }

  // 「重新计数」：把失败读数的起点挪到现在，红点清零。model_calls 一条不删，
  // 调用记录页照旧能翻到全部历史；记忆提取那边只清连续失败计数器。
  if (method === "POST" && path === "/api/status/reset-counters") {
    const at = resetFailureCounters();
    resetExtractFailures();
    sendJson(response, 200, {
      ok: true,
      watermarkAt: new Date(at).toISOString(),
      note: "红点已清零：从现在起重新数（调用记录一条没删，「调用记录」里还能翻到全部历史）",
    });
    return;
  }

  if (method === "GET" && path === "/api/usage/stats") {
    sendJson(response, 200, { ok: true, ...usageStats() });
    return;
  }

  if (method === "GET" && path === "/api/logs") {
    // 列表一律只发摘要行（原文换成字数）：limit=0 是给「在飞」轮询用的，它只要 inflight 列表。
    const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 0, LIST_LIMIT_MAX);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    // scope 三档：不给 = 全都要（老口径，留给 curl / 冒烟 / doctor 这类内部读者）；
    // model = 只模型调用；channel = 只通道投递（qq/wechat，见 CHANNEL_PURPOSES）。
    // 界面默认走 model——调用记录首先是模型调用，通道投递另有一档。
    const scope = url.searchParams.get("scope");
    const filter: CallFilter = {
      onlyFailed: url.searchParams.get("failed") === "1",
      purpose: url.searchParams.get("purpose") || undefined,
      turnId: url.searchParams.get("turnId") || undefined,
      modelOnly: scope === "model",
      channelOnly: scope === "channel",
    };
    sendJson(response, 200, {
      ok: true,
      failures: modelFailureCount(),
      total: countModelCalls(filter),
      devMode: config.devMode,
      filter,
      // 在飞的调用只存在于内存：模型没返回前 model_calls 根本没有行，
      // 界面上就分不清「没在跑」和「正在跑」。
      inflight: listInflightCalls(),
      calls: limit === 0 ? [] : recentModelCallSummaries(limit, offset, filter),
    });
    return;
  }

  // 单行原文：列表页不发全文，点开某一行的「查看原文」才取这一条。
  // 出口分两档，**与列表的口径不同**（列表两个全文列都不给，这里给一个）：
  //   res_full（模型/服务商返回的原文）恒发——它是排障的主证据，成功是回复正文、失败是错误 JSON；
  //   req_full（完整请求体，含系统提示词/记忆/用户资料）仅 DEV_MODE 给，非 DEV_MODE 整个键剥掉。
  // 别把这行改成"与列表同一口径"：那会让「查看原文」弹窗在生产环境只剩摘要，排障直接断一条腿。
  const logRowMatch = method === "GET" ? path.match(/^\/api\/logs\/(\d+)$/) : null;
  if (logRowMatch) {
    const row = modelCallById(Number(logRowMatch[1]));
    if (row === null) {
      sendJson(response, 404, { ok: false, error: "找不到这条调用记录，可能已被清理" });
      return;
    }
    // 非 DEV_MODE：请求原文整个键都不出口，而不是发一个 null（发 null 等于告诉外面"有这个东西"）
    const call = config.devMode ? row : (({ req_full: _omit, ...rest }) => rest)(row);
    sendJson(response, 200, { ok: true, devMode: config.devMode, call });
    return;
  }

  // 试连：可以带"还没保存的参数"，让用户先在设置页试通了再保存。
  if (method === "POST" && path === "/api/model/ping") {
    const body = await readJson<{
      model?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
      timeoutMs?: unknown;
      /** 要测什么：chat（默认）/ list / both。见下面为什么要分开。 */
      want?: unknown;
    }>(request);

    const override: Partial<ModelSettings> = {};
    // 地址语义：没传 baseUrl = 用已保存的配置测（状态页「实测模型连通」走这条）；
    // 显式传空串 = 用户在表单里清空了地址栏，这时如实报"还缺地址"，
    // 绝不能回落到 .env 默认值替他白测一个无关地址。
    if (typeof body.baseUrl === "string") {
      override.baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
    }
    // 密钥特例：前端传掩码（含 ••••）或空串时，表示"沿用已保存的密钥"，不覆盖。
    // 只有明确给了新密钥才替换——这样用户不碰那一栏就等于没改。
    if (typeof body.apiKey === "string" && body.apiKey.trim() !== "" && !body.apiKey.includes("••")) {
      override.apiKey = body.apiKey.trim();
    }
    const settings = { ...modelConfig(), ...override };

    /*
     * 注意这里用的是"地址+密钥齐了没"，而不是 modelReadyNow()。
     * 原因：用户点「测试连接」的意图就是"验证这组参数能不能用"，
     * 不该被"当前运行模式是 echo"挡住——否则用户会陷入"想试连 → 被要求先切模式 →
     * 切了模式又想先把参数试通"的死循环。mode 只影响真实对话走不走模型。
     */
    if (settings.baseUrl === "" || settings.apiKey === "") {
      const missing = [
        settings.baseUrl === "" ? "接口地址" : "",
        settings.apiKey === "" ? "密钥" : "",
      ].filter((part) => part !== "");
      sendJson(response, 200, {
        ok: true,
        modelReady: false,
        hint: `还缺：${missing.join("、")}。填上就能测。`,
      });
      return;
    }

    // 「这组参数能不能用」和「服务商有哪些模型」是两件事。从前一次请求里串行做两个：
    // 不暴露 /models 的服务商（火山 plan 端点实测 404）要白等满列表超时才出测试结果，
    // 而"拉列表失败"还会被拼进测试结论那一行里，看着就像连接坏了。现在各要各的。
    const want = body.want === "list" || body.want === "both" ? body.want : "chat";
    const model =
      typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : settings.name;
    const result: Record<string, unknown> = {
      ok: true, modelReady: true, baseUrl: settings.baseUrl, model, want,
      // 测的是"这一家"，回执就该说这一家的名字——只有地址时得自己对着地址想是谁
      provider: providerLabel(settings.baseUrl),
    };
    if (want !== "chat") {
      const listed = await listModels(10_000, settings);
      result.list = listed.ok
        ? { ok: true, elapsedMs: listed.elapsedMs, ids: listed.ids, chatIds: listed.ids.filter(isChatModelId) }
        : { ok: false, code: listed.error.code, message: listed.error.message };
    }
    if (want !== "list") {
      const pinged = await pingChat(model, 25_000, settings);
      // 连通测试也落一条记录，体检的「最近一次调用」才反映刚测的结果
      logModelCall({
        purpose: "ping", ok: pinged.ok,
        code: pinged.ok ? null : pinged.error.code,
        status: pinged.ok ? null : pinged.error.status,
        model, url: settings.baseUrl + "/chat/completions",
        elapsedMs: pinged.ok ? pinged.elapsedMs : pinged.error.elapsedMs,
        message: pinged.ok ? null : pinged.error.message,
        profileId: activeProfileId(),
      });
      result.ping = pinged.ok
        ? { ok: true, elapsedMs: pinged.elapsedMs, text: pinged.text }
        : { ok: false, code: pinged.error.code, message: pinged.error.message, elapsedMs: pinged.error.elapsedMs };
    }
    sendJson(response, 200, result);
    return;
  }

  // ── 设置（自定义接口 / 角色卡 / TA眼中的你）──────────────
  // 出厂那份角色卡。新建联系人时「换回默认人设」要把三段填进表单，而那一刻还没有 contact id
  // ——走 /api/contacts/:id/reset-card 会拼成 /api/contacts//reset-card（未知路径）。
  // 真源在后端 defaultPersona()，前端不抄一份：抄一份迟早跟提示词那边漂移。
  if (method === "GET" && path === "/api/persona/default-card") {
    const { identity, background, relationship } = defaultPersona().character;
    sendJson(response, 200, { ok: true, card: { identity, background, relationship } });
    return;
  }

  if (method === "GET" && path === "/api/settings") {
    sendJson(response, 200, { ok: true, ...snapshotResponse() });
    return;
  }

  if (method === "POST" && path === "/api/settings") {
    const body = await readJson<{
      model?: Partial<ModelSettings>;
      character?: Record<string, unknown>;
      owner?: Record<string, unknown>;
      recentTurns?: unknown;
      reset?: unknown;
      onboarding?: { completed?: boolean };
    }>(request, MAX_CARD_BODY_BYTES);

    if (body.reset === true) {
      resetAll();
      sendJson(response, 200, { ok: true, ...snapshotResponse() });
      return;
    }

    // 首次设置的完成标记走单独一条：它没有要校验的字段，也不该被卷进「合并后统一报错」。
    if (body.onboarding !== undefined) {
      setOnboardingDone(body.onboarding?.completed === true);
      sendJson(response, 200, { ok: true, ...snapshotResponse() });
      return;
    }

    const errors: string[] = [];

    if (body.model !== undefined) {
      const patch = normalizeModelPatch(body.model);
      const check = validateModel(patch);
      if (!check.ok) errors.push(...check.errors);
    }

    const personaPatch: { character?: Partial<CharacterCard>; owner?: Partial<OwnerProfile>; recentTurns?: unknown } = {};
    if (body.character !== undefined) {
      personaPatch.character = pickStrings(body.character) as Partial<CharacterCard>;
    }
    if (body.owner !== undefined) {
      personaPatch.owner = pickStrings(body.owner) as Partial<OwnerProfile>;
    }
    if (body.recentTurns !== undefined) personaPatch.recentTurns = body.recentTurns;
    if (body.character !== undefined || body.owner !== undefined || body.recentTurns !== undefined) {
      const check = validatePersona(personaPatch);
      if (!check.ok) errors.push(...check.errors);
    }

    if (errors.length > 0) {
      sendJson(response, 400, { ok: false, error: errors[0], errors });
      return;
    }

    if (body.model !== undefined) updateModel(normalizeModelPatch(body.model));
    if (body.character !== undefined || body.owner !== undefined || body.recentTurns !== undefined) {
      updatePersona({
        character: personaPatch.character,
        owner: personaPatch.owner,
        ...(typeof body.recentTurns === "number" ? { recentTurns: body.recentTurns } : {}),
      });
    }

    resetToolsUnsupported(); // 配置变了：旧的「不支持 tools」探测结论作废，下次调用重新试错
    sendJson(response, 200, {
      ok: true,
      ...snapshotResponse(),
      note: "已保存并立即生效，不需要重启",
    });
    return;
  }

  // ── 模型配置档：收藏多份 OpenAI 兼容接口配置，一键切换 ──
  // 语义：档是收藏，settings.model 是当前生效；「应用」= 把档拷进当前生效。
  if (method === "POST" && path === "/api/settings/profiles") {
    const body = await readJson<Record<string, unknown>>(request);
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label === "") {
      sendJson(response, 400, { ok: false, error: "给配置档起个名字（最多 24 个字）" });
      return;
    }
    if (label.length > 24) {
      sendJson(response, 400, { ok: false, error: "配置档名字最多 24 个字" });
      return;
    }

    const patch = normalizeModelPatch(body);
    const check = validateModel(patch);
    if (!check.ok) {
      sendJson(response, 400, { ok: false, error: check.errors[0], errors: check.errors });
      return;
    }

    saveProfile({
      ...(patch as Partial<ModelSettings>),
      id: typeof body.id === "string" && body.id !== "" ? body.id : undefined,
      label,
    } as Parameters<typeof saveProfile>[0]);

    sendJson(response, 200, {
      ok: true,
      ...snapshotResponse(),
      note: "配置档已保存（只是收藏，要生效请点「应用」）",
    });
    return;
  }

  if (method === "POST" && path === "/api/settings/profiles/activate") {
    const body = await readJson<{ id?: unknown }>(request);
    if (typeof body.id !== "string" || body.id === "") {
      sendJson(response, 400, { ok: false, error: "缺少要应用的配置档 id" });
      return;
    }
    try {
      activateProfile(body.id);
    } catch (error) {
      sendJson(response, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    resetToolsUnsupported(); // 应用了新档：重新探测工具支持
    sendJson(response, 200, {
      ok: true,
      ...snapshotResponse(),
      note: "已应用这份配置档，立即生效",
    });
    return;
  }

  // 快速测一个已存的档：发一条最小指令，报告可用性与延迟（列表行的「测试」按钮）。
  if (method === "POST" && path === "/api/settings/profiles/test") {
    const body = await readJson<{ id?: unknown }>(request);
    const profile = listProfiles().find((p) => p.id === body.id);
    if (!profile) {
      sendJson(response, 404, { ok: false, code: "PROFILE_NOT_FOUND", error: "配置档不存在，可能已被删除" });
      return;
    }
    if (profile.baseUrl === "" || profile.apiKey === "") {
      sendJson(response, 200, { ok: true, pass: false, error: "这个档缺接口地址或密钥" });
      return;
    }
    const override: Partial<ModelSettings> = {
      mode: "openai",
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      name: profile.name,
      timeoutMs: profile.timeoutMs,
    };
    // 测试这一击把超时夹到 30s：真挂的模型早点回一句"连不上"，别让前端的圈照 90s 转。
    const pinged = await pingChat(profile.name, Math.min(profile.timeoutMs, 30_000), override);
    // 测试也要落调用记录：体检的「最近一次调用」得能看到刚测的结果
    logModelCall({
      purpose: "ping", ok: pinged.ok,
      code: pinged.ok ? null : pinged.error.code,
      status: pinged.ok ? null : pinged.error.status,
      model: profile.name, url: profile.baseUrl + "/chat/completions",
      elapsedMs: pinged.ok ? pinged.elapsedMs : pinged.error.elapsedMs,
      message: pinged.ok ? null : pinged.error.message,
      profileId: profile.id,
    });
    sendJson(response, 200, pinged.ok
      ? { ok: true, pass: true, elapsedMs: pinged.elapsedMs, text: pinged.text }
      : { ok: true, pass: false, elapsedMs: pinged.error.elapsedMs, error: pinged.error.message });
    return;
  }

  if (method === "POST" && path === "/api/settings/profiles/delete") {
    const body = await readJson<{ id?: unknown }>(request);
    if (typeof body.id !== "string" || body.id === "") {
      sendJson(response, 400, { ok: false, error: "缺少要删除的配置档 id" });
      return;
    }
    const bound = contactsBoundToProfile(body.id);
    if (bound.length > 0) {
      // 不级联删绑定：静默把那位联系人切到全局模型（另一家、另一份计费）比拒绝删除危险得多。
      sendJson(response, 409, {
        ok: false,
        code: "PROFILE_IN_USE",
        error: `还有 ${bound.length} 位联系人绑着这份档（${bound.map((c) => c.name).join("、")}）：先到 TA 们的资料页改成「跟随全局」或换成别的档，再删`,
      });
      return;
    }
    const removed = deleteProfile(body.id);
    if (!removed) {
      sendJson(response, 404, { ok: false, code: "PROFILE_NOT_FOUND", error: "配置档不存在，可能已被删除" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      ...snapshotResponse(),
      note: "已删除这份配置档（当前生效的模型不受影响）",
    });
    return;
  }

  // ── 供应商（按接口地址从配置档派生的一层）────────────────
  // rename：给这一家起显示名；sync：改地址/密钥并同步给它下面所有模型档。
  if (method === "POST" && path === "/api/settings/providers") {
    const body = await readJson<{ op?: unknown; baseUrl?: unknown; toBaseUrl?: unknown; label?: unknown; apiKey?: unknown }>(request);
    const op = typeof body.op === "string" ? body.op : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (baseUrl === "") {
      sendJson(response, 400, { ok: false, error: "缺少供应商的接口地址" });
      return;
    }
    let note = "";
    try {
      if (op === "rename") {
        renameProvider(baseUrl, typeof body.label === "string" ? body.label : "");
        note = "供应商名已更新";
      } else if (op === "sync") {
        const to = typeof body.toBaseUrl === "string" && body.toBaseUrl.trim() !== "" ? body.toBaseUrl.trim() : baseUrl;
        const n = syncProviderConnection(baseUrl, to, typeof body.apiKey === "string" ? body.apiKey : "");
        resetToolsUnsupported(); // 端点变了：旧的「不支持 tools」探测结论作废
        note = `已同步到这一家的 ${n} 个模型`;
      } else {
        sendJson(response, 400, { ok: false, error: "op 只能是 rename / sync" });
        return;
      }
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    sendJson(response, 200, { ok: true, ...snapshotResponse(), note });
    return;
  }
  // ── 能力端点档（每张卡自己存一组「一家供应商 × 一个模型」，其中一份生效）──
  //
  // 一条路由三种动作，替代过去的「卡内保存 + 整套档 + 单卡候选档」三条：那三条
  // 叠在同一张卡上时，用户看到的是三个互相覆盖的入口，而不是一个配置面。
  if (method === "POST" && path === "/api/settings/capabilities") {
    const body = await readJson<Record<string, unknown>>(request);
    const cap = CAPABILITY_NAMES.find((n) => n === body.capability);
    const op = typeof body.op === "string" ? body.op : "";
    if (!cap) {
      sendJson(response, 400, { ok: false, error: "capability 只能是 " + CAPABILITY_NAMES.join(" / ") });
      return;
    }
    const label = CAPABILITY_LABELS[cap];
    let note = "";
    try {
      if (op === "save") {
        const patch = {
          id: body.id, label: body.label, baseUrl: body.baseUrl, apiKey: body.apiKey,
          name: body.name, timeoutMs: body.timeoutMs, voice: body.voice,
        };
        const check = validateCapabilityProfile(patch);
        if (!check.ok) {
          sendJson(response, 400, { ok: false, error: `${label}：${check.errors.join("；")}`, errors: check.errors });
          return;
        }
        const saved = saveCapabilityProfile(cap, patch);
        // 这张卡上第一份档存下去就顺手启用：用户的意图是"配好就能用"，
        // 还要再点一次启用只会让人以为没保存上。往后再存的就只存不切。
        if (capabilityActiveId(cap) === "") activateCapabilityProfile(cap, saved.id);
        note = "已保存，立即生效";
      } else if (op === "activate") {
        if (typeof body.id !== "string") {
          sendJson(response, 400, { ok: false, error: "缺少要启用的档 id（传空串表示回到跟随主模型）" });
          return;
        }
        activateCapabilityProfile(cap, body.id);
        note = body.id.trim() === "" ? `${label}已回到跟随主模型` : `${label}已换到这一份`;
      } else if (op === "delete") {
        if (typeof body.id !== "string" || !deleteCapabilityProfile(cap, body.id)) {
          sendJson(response, 400, { ok: false, error: "那份端点档不存在，可能已被删除" });
          return;
        }
        note = `${label}的一份端点档已删除`;
      } else {
        sendJson(response, 400, { ok: false, error: "op 只能是 save / activate / delete" });
        return;
      }
    } catch (error) {
      // 档不存在、id 形状不对这类问题都从这里出去：界面直接贴这句话，不用猜。
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    resetToolsUnsupported(); // 能力配置变了：工具支持的探测结论作废
    sendJson(response, 200, { ok: true, ...snapshotResponse(), note });
    return;
  }

  // 能力就绪状态：聊天页据此显示/隐藏 发图、录音、播放 入口（不泄露任何配置内容）。
  if (method === "GET" && path === "/api/capabilities") {
    sendJson(response, 200, { ok: true, ready: capabilitiesStatus() });
    return;
  }

  // 用户自定义技能：设置页「技能」分区的数据源。
  // 磁盘目录就是真源，但用户不必为此去翻文件管理器——这一组接口让他能在应用里
  // 新建 / 改内容 / 删除，写下去的仍是同一批文件、过的仍是 inspect() 那一道闸门。
  // 所以"去文件夹里操作"和"在应用里操作"没有两条路，改完立即生效（每轮现扫，不用重启后端）。
  //
  // 名字寻址先按形态筛一遍：技能名就是目录名，只用小写字母数字_-
  // （见 skills.ts 的 SKILL_NAME_RE），对不上的路径不值得为它跑一次解码。
  const skillNameMatch = path.startsWith("/api/skills/")
    ? /^\/api\/skills\/([a-z0-9][a-z0-9_-]{0,39})$/.exec(path)
    : null;

  if (method === "GET" && path === "/api/skills") {
    sendJson(response, 200, { ok: true, dir: skillsDir(), skills: listSkills() });
    return;
  }

  if (method === "POST" && path === "/api/skills/enabled") {
    const body = await readJson<{ name?: unknown; enabled?: unknown }>(request);
    const name = typeof body.name === "string" ? body.name : "";
    if (name.trim() === "") {
      sendJson(response, 400, { ok: false, error: "技能名不能为空" });
      return;
    }
    if (!setSkillEnabled(name.trim(), body.enabled === true)) {
      // 目录在这之后被删掉/改名时会落到这里：报错而不是假装改成功了。
      sendJson(response, 404, { ok: false, error: `没有这个技能「${name.trim()}」，列表可能已经变了，重新载入看看` });
      return;
    }
    sendJson(response, 200, { ok: true, dir: skillsDir(), skills: listSkills() });
    return;
  }

  // /api/skills/<name>：按名字寻址的三件事（读原文 / 覆盖写 / 删目录）。
  // 必须排在 /api/skills/enabled **之后**——"enabled" 也长得像一个技能名，
  // 顺序一反，停用/启用就再也调不到一个叫 enabled 的技能（后端也拒建这个名字）。
  if (skillNameMatch !== null) {
    const [, encoded = ""] = skillNameMatch;
    const name = decodeURIComponent(encoded);
    if (method === "GET") {
      const read = readSkill(name);
      if (!read.ok) {
        sendJson(response, 404, { ok: false, error: read.error });
        return;
      }
      sendJson(response, 200, { ok: true, name: read.name, content: read.content });
      return;
    }
    if (method === "PUT") {
      // 一篇技能最多 24000 字，汉字 3 字节一字 → 通用 32KB 上限会在校验前就误杀，
      // 所以这里显式放大到 MAX_SKILL_FILE_BYTES（skills.ts 里有这道数字的来历）。
      const body = await readJson<{ content?: unknown }>(request, MAX_SKILL_FILE_BYTES);
      const content = typeof body.content === "string" ? body.content : "";
      if (content.trim() === "") {
        sendJson(response, 400, { ok: false, error: "技能内容不能为空" });
        return;
      }
      const saved = saveSkill(name, content, "overwrite");
      if (!saved.ok) {
        sendJson(response, 400, { ok: false, error: saved.error });
        return;
      }
      // 落盘成功 ≠ 生效：闸门的结论在 saved 里，界面据此决定是收起编辑器还是接着改。
      sendJson(response, 200, { ok: true, dir: skillsDir(), skills: listSkills(), saved: saved.saved });
      return;
    }
    if (method === "DELETE") {
      const gone = deleteSkill(name);
      if (!gone.ok) {
        sendJson(response, 404, { ok: false, error: gone.error });
        return;
      }
      sendJson(response, 200, { ok: true, dir: skillsDir(), skills: listSkills(), deleted: gone.name });
      return;
    }
  }

  if (method === "POST" && path === "/api/skills") {
    const body = await readJson<{ name?: unknown; content?: unknown }>(request, MAX_SKILL_FILE_BYTES);
    const name = typeof body.name === "string" ? body.name : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (name.trim() === "") {
      sendJson(response, 400, { ok: false, error: "技能名不能为空" });
      return;
    }
    if (content.trim() === "") {
      sendJson(response, 400, { ok: false, error: "技能内容不能为空" });
      return;
    }
    // create 而不是 overwrite：已存在同名目录时拒绝，别把用户改好的那篇换成白纸。
    const saved = saveSkill(name, content, "create");
    if (!saved.ok) {
      sendJson(response, 400, { ok: false, error: saved.error });
      return;
    }
    sendJson(response, 200, { ok: true, dir: skillsDir(), skills: listSkills(), saved: saved.saved });
    return;
  }

  // 她的画：生成产物台账。按联系人隔离，翻页口径与调用记录/记忆清单一致。
  // 内容库：作品台账 + 聊天媒体附件聚合视图。只读，动作继续走各自原有接口。
  if (method === "GET" && path === "/api/content") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const rawFilter = url.searchParams.get("filter") || "all";
    const allowed: ContentFilter[] = ["all", "artifacts", "chat", "starred", "reference"];
    const filter = (allowed as string[]).includes(rawFilter) ? rawFilter as ContentFilter : "all";
    const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const data = listContent(contactId, filter, limit, offset);
    sendJson(response, 200, { ok: true, filter, limit, offset, ...data });
    return;
  }

  if (method === "GET" && path === "/api/artifacts") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const { items, total } = listArtifacts(contactId, limit, offset);
    sendJson(response, 200, { ok: true, artifacts: items, total, limit, offset });
    return;
  }

  if (method === "POST" && path === "/api/artifacts") {
    const body = await readJson<{ op?: unknown; id?: unknown; contactId?: unknown }>(request);
    const id = typeof body.id === "string" ? body.id : "";
    const artifact = id === "" ? null : getArtifact(id);
    if (!artifact) {
      sendJson(response, 404, { ok: false, error: "这张画不存在（可能已经被删掉了）" });
      return;
    }
    const op = body.op;
    // 户主校验对**每一个** op 生效，不只 setFaceRef：artifacts 表按 contact_id 隔离，
    // 而 getArtifact 只按 id 查。少了这一行，看着 A 的界面就能 star/delete B 的画——
    // delete 还会连文件一起释放，那是不可恢复的跨联系人破坏。
    // 判据用请求带的 contactId（界面从来都带），不认"当前选中谁"——服务端不该猜。
    const contactId = typeof body.contactId === "string" ? body.contactId : "";
    if (contactId === "" || artifact.contactId !== contactId) {
      sendJson(response, 403, { ok: false, error: "这张画不属于这个联系人" });
      return;
    }
    if (op === "star") {
      sendJson(response, 200, { ok: true, starred: setArtifactStarred(id, !artifact.starred) });
      return;
    }
    if (op === "delete") {
      // 唯一会让画消失的路径：删行 + 释放文件。删聊天消息不会走到这里。
      deleteArtifact(id);
      sendJson(response, 200, { ok: true, deleted: true });
      return;
    }
    if (op === "setFaceRef") {
      const updated = updateContact(contactId, { faceRef: artifact.url });
      if (!updated) {
        sendJson(response, 404, { ok: false, error: "联系人不存在" });
        return;
      }
      sendJson(response, 200, { ok: true, faceRef: updated.faceRef });
      return;
    }
    sendJson(response, 400, { ok: false, error: "op 只支持 star / delete / setFaceRef" });
    return;
  }

  // 上下文占用：下一次发消息时系统提示词/记忆/工具/历史各占多少（估算值，供界面浮层展示）。
  if (method === "GET" && path === "/api/context/usage") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    sendJson(response, 200, { ok: true, ...contextUsage(contactId) });
    return;
  }

  // 能力连接测试：用「表单里还没保存的参数」（给了就覆盖），语义与 /api/model/ping 一致。
  // 视觉能力走 chat ping；语音能力没有 chat 端点可言，退化为「拉列表 + 模型名是否在内」。
  if (method === "POST" && path === "/api/settings/capabilities/test") {
    const body = await readJson<{ capability?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown }>(request);
    if (typeof body.capability !== "string" || !CAPABILITY_NAMES.includes(body.capability as CapabilityName)) {
      sendJson(response, 400, { ok: false, error: "capability 不是已知能力" });
      return;
    }
    const name = body.capability as CapabilityName;
    const cap = capabilityConfig(name);
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : cap.baseUrl;
    const apiKey =
      typeof body.apiKey === "string" && body.apiKey.trim() !== "" && !body.apiKey.includes("••")
        ? body.apiKey.trim()
        : cap.apiKey;
    const model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : cap.model;

    if (baseUrl === "" || apiKey === "") {
      const missing = [baseUrl === "" ? "接口地址" : "", apiKey === "" ? "密钥" : ""].filter((p) => p !== "");
      sendJson(response, 200, { ok: true, ready: false, hint: `还缺：${missing.join("、")}。填上就能测。` });
      return;
    }

    const override: Partial<ModelSettings> = { baseUrl, apiKey, name: model };
    const listed = await listModels(10_000, override);
    const result: Record<string, unknown> = {
      ok: true,
      capability: name,
      model,
      list: listed.ok
        ? { ok: true, elapsedMs: listed.elapsedMs, count: listed.ids.length }
        : { ok: false, code: listed.error.code, message: listed.error.message },
    };
    if (name === "imageVision") {
      const pinged = await pingChat(model, 25_000, override);
      result.ping = pinged.ok
        ? { ok: true, elapsedMs: pinged.elapsedMs, text: pinged.text }
        : { ok: false, code: pinged.error.code, message: pinged.error.message };
    } else if (listed.ok) {
      const lower = model.toLowerCase();
      result.modelInList = listed.ids.some((id) => id.toLowerCase() === lower || id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase()));
    }
    sendJson(response, 200, result);
    return;
  }

  // 图片上传：请求体就是二进制（content-type 标 mime），返回 /media URL 供 /api/say 引用。
  // 单独走二进制而不是 JSON dataURL：32KB 的 JSON 上限对图片毫无意义。
  if (method === "POST" && path === "/api/media") {
    const mime = ((request.headers["content-type"] ?? "").split(";")[0] ?? "").trim().toLowerCase();
    const buffer = await readBinary(request, MAX_IMAGE_BYTES + 1024);
    try {
      const saved = saveImage(buffer, mime);
      sendJson(response, 200, { ok: true, ...saved });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // 语音识别：浏览器录音（dataURL）→ 文字。返回给输入框而不是直接发送——转错了用户还能改。
  if (method === "POST" && path === "/api/asr") {
    const body = await readJson<{ audio?: unknown }>(request, MAX_AUDIO_BODY_BYTES);
    if (typeof body.audio !== "string" || body.audio === "") {
      sendJson(response, 400, { ok: false, error: "缺少 audio（dataURL）" });
      return;
    }
    try {
      const text = await transcribeAudio(body.audio);
      sendJson(response, 200, { ok: true, text });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: friendlyModelError(error) });
    }
    return;
  }

  // 语音合成：消息文本 → mp3 dataURL。错误同样走 ok/error JSON，前端一套逻辑处理。
  if (method === "POST" && path === "/api/tts") {
    const body = await readJson<{ text?: unknown }>(request);
    try {
      const result = await synthesizeSpeech(typeof body.text === "string" ? body.text : "");
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: friendlyModelError(error) });
    }
    return;
  }
  /** 预览：把当前（或正在编辑的）角色卡拼成模型真正会收到的系统提示词。
   *  带 contactId = 还原「下一轮发消息时她实际收到的请求」：
   *  联系人卡（可被 character 草稿覆盖）+ 陪伴段 + 距上次说话 + 按你最后一句话的真实召回
   *  + 按生效轮数回放的对话历史 + 与真实发送同一套的图片降级标记。助手卡内置提示词，不参与。
   *  唯一说破的差异：预览不做发送前的预算裁剪（那一刻才知道要裁多少）。 */
  if (method === "POST" && path === "/api/settings/preview") {
    const body = await readJson<{
      character?: Record<string, unknown>;
      owner?: Record<string, unknown>;
      contactId?: unknown;
    }>(request, MAX_CARD_BODY_BYTES);
    const current = personaConfig();
    const cid = typeof body.contactId === "string" ? body.contactId : "";
    const perContact = cid !== "" && cid !== ASSISTANT_CONTACT_ID && contactExists(cid);
    const base = perContact ? contactCard(cid) : current.character;
    const character = { ...base, ...pickStrings(body.character ?? {}) };
    const owner = { ...current.owner, ...pickStrings(body.owner ?? {}) };
    if (!perContact) {
      // 全局预览也换成真实记忆，不再塞两条编造的示例：预览=精确重建是这里的标准，
      // 让用户看到"模型会收到这些"而模型其实收不到，等于把预览变成假样本。
      // 没有指定联系人时按默认联系人兜底，并在 memoryNote 里说破是按谁召回的。
      sendJson(response, 200, {
        ok: true,
        prompt: previewSystemPrompt(character, owner, {
          memories: recallExplained(DEFAULT_CONTACT_ID, "").events,
          lastUserAt: lastUserMessageAt(DEFAULT_CONTACT_ID),
          companion: companionPromptExtras(getContact(DEFAULT_CONTACT_ID)),
        }),
        memoryNote: "[记忆] 全局预览不带具体召回查询，这里显示默认联系人最近的几条记忆。要看某段关系的召回，请到该联系人的资料页预览。",
      });
      return;
    }
    // 与 respondToTurn 同口径：真图/看不见的图走同一套选图与标记函数，
    // 不再在这里自写一个 "[发过图片]"——那和真实发出去的文案是两句话。
    const rawRows = recentMessages(cid);
    const visionOn = capabilityReady("imageVision");
    const replay = visionOn ? selectReplayImages(rawRows, []) : new Set<string>();
    const rows = imageProxiedHistory(rawRows, replay, visionOn);
    const lastUser = [...rows].reverse().find((r) => r.role === "user");
    // 预览是观测：走 recallExplained，不推进 last_used_at（同 /api/context/usage）。
    const memories = lastUser
      ? recallExplained(cid, lastUser.text).events
      : listMemoryEventsFiltered(cid, { limit: 8 }).filter(
          (e) => e.valid_until === null || e.valid_until > Date.now(),
        );
    sendJson(response, 200, {
      ok: true,
      prompt: previewSystemPrompt(character, owner, {
        companion: companionPromptExtras(getContact(cid), rows[0]?.id),
        lastUserAt: lastUserMessageAt(cid),
        memories,
      }),
      history: rows.map((r) => ({ role: r.role, text: r.text })),
      memoryNote: lastUser
        ? `[记忆] 按你最后一句话召回：「${String(lastUser.text).slice(0, 30)}」`
        : "[记忆] 还没有可召回的对话，这里展示的是最近的记忆",
      historyNote: `历史按生效轮数原样带全，不含真实发送时的预算裁剪；本轮若装不下会从最旧一轮开始丢。`,
    });
    return;
  }

  // ── 对话 ────────────────────────────────────────────────
  if (method === "POST" && path === "/api/say") {
    const body = await readJson<{ text?: unknown; contactId?: unknown; attachments?: unknown; clientId?: unknown }>(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    // 图片先传 /api/media 落盘，这里只带 URL 引用；逐个校验文件真实存在
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    const attachments: string[] = [];
    for (const item of rawAttachments.slice(0, 3)) {
      if (typeof item === "string" && item.startsWith("/media/") && mediaUrlExists(item)) attachments.push(item);
    }
    if (text === "" && attachments.length === 0) {
      sendJson(response, 400, { ok: false, error: "text 与 attachments 至少给一个" });
      return;
    }
    // 前端统一用 ?contactId= 携带（cq 助手），body 里的写法保留兼容其它客户端
    const requested = typeof body.contactId === "string" ? body.contactId : url.searchParams.get("contactId");
    const contactId = requested && (getContact(requested) || isAssistantThreadContactId(requested))
      ? requested
      : DEFAULT_CONTACT_ID;
    if (!getContact(contactId) && !isAssistantThreadContactId(contactId)) {
      sendJson(response, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
      return;
    }
    // 助手工作区：新工作区的第一条消息用它的内容自动命名
    autoTitleThread(contactId, text);
    const channel = getChannel("web");
    if (!channel) {
      sendJson(response, 503, { ok: false, error: "没有可用通道" });
      return;
    }
    // 关键：这里立刻返回，不等模型。处理可能要十几秒，平台回调不能等这么久。
    const clientId = typeof body.clientId === "string" ? body.clientId.trim().slice(0, 80) : "";
    const { turnId } = channel.receive(text.slice(0, 4000), contactId, attachments, undefined, clientId || undefined);
    sendJson(response, 202, { ok: true, turnId, ...(clientId ? { clientId } : {}) });
    return;
  }

  if (method === "GET" && path.startsWith("/api/turn/")) {
    const id = decodeURIComponent(path.slice("/api/turn/".length));
    const turn = getTurn(id);
    if (!turn) {
      sendJson(response, 404, { ok: false, error: "处理单不存在" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      id: turn.id,
      status: turn.status,
      reply: turn.reply,
      error: turn.error,
      createdAt: turn.created_at,
      finishedAt: turn.finished_at,
    });
    return;
  }

  if (method === "POST" && path.startsWith("/api/turn/") && path.endsWith("/retry")) {
    const id = decodeURIComponent(path.slice("/api/turn/".length, -"/retry".length));
    try {
      await retryTurn(id);
      sendJson(response, 202, { ok: true, turnId: id, note: "已重新提交，用户消息不会重复" });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // 重新生成：只对最新一轮的已完成回复开放，整轮气泡作废重答（与失败重试同一条流水线）。
  if (method === "POST" && path.startsWith("/api/turn/") && path.endsWith("/regenerate")) {
    const id = decodeURIComponent(path.slice("/api/turn/".length, -"/regenerate".length));
    try {
      await retryTurn(id, { regenerate: true });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: (error as Error).message });
    }
    return;
  }

  if (method === "POST" && path.startsWith("/api/turn/") && path.endsWith("/cancel")) {
    const id = decodeURIComponent(path.slice("/api/turn/".length, -"/cancel".length));
    // 只停还在飞的轮次。已经回完的停不了——别让用户以为点一下能收回那句回答。
    if (!cancelTurn(id)) {
      sendJson(response, 400, {
        ok: false,
        error: getTurn(id) ? "这一轮已经结束了，没有可停止的处理" : "找不到这一轮，可能已经被删掉了",
      });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/turns/recent") {
    const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    // 不带 contactId = 全局总览（状态页要的就是这个口径）；带了就只看那一个联系人的轮次。
    // 聊天页的失败横幅走后者：不过滤会把别人的失败轮当成本会话的，重试还会重跑别人的轮。
    let contactId: string | undefined;
    if (url.searchParams.get("contactId")) {
      const strict = strictContactId(url, response);
      if (strict === null) return;
      contactId = strict;
    }
    sendJson(response, 200, { ok: true, turns: recentTurns(limit, offset, contactId), stats: turnStats() });
    return;
  }

  // 会话内搜索 / 命中后取窗口：都是当前联系人的只读查询。
  if (method === "GET" && path === "/api/messages/search") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q === "" || q.length > 50) {
      sendJson(response, 400, { ok: false, error: "搜索词要在 1~50 个字之间" });
      return;
    }
    const limit = clampInt(url.searchParams.get("limit"), 200, 1, 500);
    sendJson(response, 200, { ok: true, q, messages: searchMessagesForContact(contactId, q, limit) });
    return;
  }

  if (method === "GET" && path === "/api/messages/around") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const id = clampInt(url.searchParams.get("id"), 0, 1, Number.MAX_SAFE_INTEGER);
    const messages = messagesAround(contactId, id);
    if (!messages) {
      sendJson(response, 404, { ok: false, error: "这条消息不存在或不属于当前联系人" });
      return;
    }
    const oldest = messages[0]?.id ?? 0;
    sendJson(response, 200, {
      ok: true,
      contactId,
      messages,
      total: countMessagesFor(contactId),
      olderRemaining: countMessagesBefore(contactId, oldest),
    });
    return;
  }

  if (method === "GET" && path === "/api/messages") {
    const since = clampInt(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
    // all=1 走全量。编辑消息后必须用这个模式：失效是打在**已经渲染过的**消息上的，
    // 增量模式（id > since）永远不会把它们重新下发，界面上就看不到任何变化。
    const all = url.searchParams.get("all") === "1";
    // before=<消息id> + all=1：往回再取一页（「载入更早」）
    const before = clampInt(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER);
    // turn=<处理单id>：只重取那一轮。撤回/删除/停止/改一句文字都只动一轮，
    // 为一行变化重敲整页（实测 250 KB）不值。
    const turn = url.searchParams.get("turn");
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const messages = turn
      ? messagesForTurn(turn, contactId)
      : all
        ? before > 0 ? messagesBefore(contactId, before, CHAT_EARLIER_PAGE) : allMessages(contactId, CHAT_FIRST_PAGE)
        : messagesSince(contactId, since);
    // 更早还剩多少条：界面自己数行数会与服务端页大小脱钩，所以由这里报。
    // 只有全量/往前翻两档需要它——增量轮询每 1.5 秒一次，不为它跑两条 COUNT。
    const oldest = messages[0]?.id ?? 0;
    sendJson(response, 200, {
      ok: true,
      modelReady: modelReadyNow(),
      // 首次设置的清单挂在聊天空态上，跟着这一趟轮询回来，不为它单发一次请求。
      onboardingDone: onboardingDone(),
      personaIsDefault: defaultPersonaIsDefault(),
      contactId,
      ...(all && !turn
        ? { total: countMessagesFor(contactId), olderRemaining: countMessagesBefore(contactId, oldest) }
        : {}),
      messages,
    });
    return;
  }

  /**
   * 编辑一条自己发过的消息，并从那里重新开始对话。
   *
   * 立刻返回（重新生成要调模型，可能十几秒），前端拿 turnId 去轮询 /api/turn/:id。
   * 已有记忆不回滚——理由写在 agent.ts 的 editAndRegenerate 注释里，
   * 界面上也必须把这一点告诉用户，否则他会以为改了就等于抹掉了。
   */
  if (method === "POST" && path.startsWith("/api/message/") && path.endsWith("/edit")) {
    const raw = decodeURIComponent(path.slice("/api/message/".length, -"/edit".length));
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(response, 400, { ok: false, error: "消息 id 不合法" });
      return;
    }
    const body = await readJson<{ text?: unknown; attachments?: unknown }>(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    // 附件与 /api/say 同一套校验：只认 /media/ 前缀且文件真实存在。
    // 不传 = 不动附件（老客户端只改文字）；传数组（含空数组）= 覆盖。
    let attachments: string[] | undefined;
    if (body.attachments !== undefined) {
      attachments = [];
      const raw = Array.isArray(body.attachments) ? body.attachments : [];
      for (const item of raw.slice(0, 3)) {
        if (typeof item === "string" && item.startsWith("/media/") && mediaUrlExists(item)) attachments.push(item);
      }
    }
    if (text === "" && (attachments === undefined || attachments.length === 0)) {
      sendJson(response, 400, { ok: false, error: "内容不能为空。想撤回的话，直接说一句新的就行。" });
      return;
    }
    if (!ownMessageOrReject(url, response, id)) return;
    try {
      const result = editAndRegenerate({ messageId: id, text: text.slice(0, 4000), attachments });
      sendJson(response, 200, {
        ok: true,
        turnId: result.turnId,
        superseded: result.superseded,
        note: "已从这里重新开始，之后的消息不再进入上下文（已经记住的事不会回滚）",
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  /**
   * 修改她的一条回复文本：只改这一句，不重新生成、不动后续消息。
   * 与 /edit（改自己的话并从这里重来）是两码事——这里没有 turn，改完即完。
   */
  if (method === "PUT" && path.startsWith("/api/message/") && path.endsWith("/text")) {
    const raw = decodeURIComponent(path.slice("/api/message/".length, -"/text".length));
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(response, 400, { ok: false, error: "消息 id 不合法" });
      return;
    }
    const body = await readJson<{ text?: unknown }>(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "") {
      sendJson(response, 400, { ok: false, error: "内容不能为空" });
      return;
    }
    if (!ownMessageOrReject(url, response, id)) return;
    // 两个角色共用这一条「只改文本」通道：各自的 UPDATE 都按 role + superseded_at 收窄，
    // 互斥，所以先后试一次就能覆盖「改她的回复」和「改自己说的话」两种诉求。
    const changed = updateAssistantText(id, text.slice(0, 4000)) || updateUserMessageText(id, text.slice(0, 4000));
    if (!changed) {
      sendJson(response, 400, { ok: false, error: "这条消息改不了（可能已被删除或撤回）" });
      return;
    }
    sendJson(response, 200, { ok: true, note: "文本已更新" });
    return;
  }

  /**
   * 撤回：只把这一条从上下文摘除，界面显示成「已撤回」。她的回复**保留**。
   * 与「删除」的分工见 agent.ts 的 retractMessage 注释。
   */
  if (method === "POST" && path.startsWith("/api/message/") && path.endsWith("/retract")) {
    const raw = decodeURIComponent(path.slice("/api/message/".length, -"/retract".length));
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(response, 400, { ok: false, error: "消息 id 不合法" });
      return;
    }
    if (!ownMessageOrReject(url, response, id)) return;
    try {
      const result = retractMessage(id);
      sendJson(response, 200, {
        ok: true,
        ...result,
        note: `已撤回，该联系人不会再看到这句（对话历史仍可回溯）`,
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  /**
   * 彻底删除一轮：选中那条 + 与它同处理单的消息一起真删。
   * 不可恢复，所以前端必须先二次确认过才发这个请求。
   */
  if (method === "DELETE" && path.startsWith("/api/message/")) {
    const raw = decodeURIComponent(path.slice("/api/message/".length));
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(response, 400, { ok: false, error: "消息 id 不合法" });
      return;
    }
    if (!ownMessageOrReject(url, response, id)) return;
    try {
      const result = deleteMessage(id);
      sendJson(response, 200, { ok: true, ...result, note: "已删除，不可恢复" });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // ── 记忆 ────────────────────────────────────────────────
  if (method === "GET" && path === "/api/memory") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const query = url.searchParams.get("q");
    // 用户在记忆页搜自己的记忆是观测行为，不该记成"她想起过"。
    const events = query ? recallExplained(contactId, query, 10).events : listMemoryEventsFiltered(contactId, { limit: 20 });
    sendJson(response, 200, {
      ok: true,
      contactId,
      total: memoryCount(contactId),
      extractFailures: extractFailures(contactId),
      query: query ?? null,
      events,
    });
    return;
  }

  if (method === "GET" && path === "/api/memory/stats") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    sendJson(response, 200, { ok: true, contactId, ...memoryStats(contactId) });
    return;
  }

  if (method === "GET" && path === "/api/memory/events") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const kind = url.searchParams.get("kind") ?? undefined;
    // offset 从前夹到 5000：每页 200 时第 25 页之后会永远停在同一页。翻页深度
    // 根本不是攻击面（越界只是返回空数组），没有为它设上限的理由。
    const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    sendJson(response, 200, {
      ok: true,
      contactId,
      kind: kind ?? null,
      offset,
      total: memoryCount(contactId, kind),
      events: listMemoryEventsFiltered(contactId, { limit, kind, offset }),
    });
    return;
  }

  if (method === "GET" && path === "/api/memory/recall") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = clampInt(url.searchParams.get("limit"), 6, 1, 50);
    if (query === "") {
      sendJson(response, 400, { ok: false, error: "q 不能为空" });
      return;
    }
    const result = recallExplained(contactId, query, limit);
    sendJson(response, 200, { ok: true, contactId, ...result });
    return;
  }

  // 记忆纠错通道（roadmap P0-2）：编辑用标准动词 PATCH，删除是墓碑标记。
  // 归属校验在 SQL 里（id + contact_id 同时匹配），拿别人的记忆 id 改不动。
  const memoryEventMatch = /^\/api\/memory\/events\/(\d+)$/.exec(path);
  if (memoryEventMatch && method === "PATCH") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const id = Number(memoryEventMatch[1]);
    const body = await readJson<Record<string, unknown>>(request);
    const patch: { content?: string; kind?: MemoryKind; weight?: number } = {};
    if (typeof body.content === "string") {
      const content = body.content.trim();
      if (content === "" || content.length > 60) {
        sendJson(response, 400, { ok: false, error: "记忆内容要在 1~60 字之间" });
        return;
      }
      patch.content = content;
    }
    if (body.kind !== undefined) {
      if (typeof body.kind !== "string" || !isMemoryKind(body.kind)) {
        sendJson(response, 400, { ok: false, error: "记忆类型不认识" });
        return;
      }
      patch.kind = body.kind;
    }
    if (body.weight !== undefined) {
      const w = Number(body.weight);
      if (!Number.isFinite(w)) {
        sendJson(response, 400, { ok: false, error: "重要度得是数字" });
        return;
      }
      patch.weight = Math.min(3, Math.max(0.5, w));
    }
    if (Object.keys(patch).length === 0) {
      sendJson(response, 400, { ok: false, error: "没有要改的字段" });
      return;
    }
    if (!updateMemoryEvent(id, contactId, patch)) {
      sendJson(response, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆不存在或不属于当前联系人" });
      return;
    }
    sendJson(response, 200, { ok: true, note: "记忆已更新，下次召回立即生效" });
    return;
  }
  if (memoryEventMatch && method === "DELETE") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    if (!deleteMemoryEvent(Number(memoryEventMatch[1]), contactId)) {
      sendJson(response, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆不存在或不属于当前联系人" });
      return;
    }
    sendJson(response, 200, { ok: true, note: `已删除，该联系人不会再想起这件事` });
    return;
  }
  // 撤销删除：删记忆只是打墓碑（deleted_at），擦掉就回来了——界面上那句「可撤销」得是真的。
  const memoryRestoreMatch = method === "POST" ? path.match(/^\/api\/memory\/events\/(\d+)\/restore$/) : null;
  if (memoryRestoreMatch) {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    if (!restoreMemoryEvent(Number(memoryRestoreMatch[1]), contactId)) {
      sendJson(response, 404, { ok: false, code: "MEMORY_NOT_FOUND", error: "这条记忆没被删过，或不属于当前联系人" });
      return;
    }
    sendJson(response, 200, { ok: true, note: "已撤销删除，这条记忆已经恢复" });
    return;
  }

  // 把一条消息显式记成长期记忆：用户主动收藏，不靠抽取，重复点击幂等。
  if (method === "POST" && path === "/api/memory/from-message") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const body = await readJson<{ messageId?: unknown }>(request);
    const messageId = Math.trunc(Number(body.messageId));
    if (!Number.isInteger(messageId) || messageId <= 0) {
      sendJson(response, 400, { ok: false, error: "messageId 不合法" });
      return;
    }
    const result = rememberMessage(messageId, contactId);
    if (!result) {
      sendJson(response, 404, { ok: false, error: "这条消息不存在、不属于当前联系人或没有文字" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      id: result.id,
      duplicate: result.duplicate,
      note: result.duplicate ? "这条已经在记忆里了" : "已记到联系人的长期记忆",
    });
    return;
  }

  // 全局搜索：跨联系人的消息 + 记忆，一次性给出（「我上周说的那句话在哪」）。
  if (method === "GET" && path === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q === "" || q.length > 50) {
      sendJson(response, 400, { ok: false, error: "q 要在 1~50 个字之间" });
      return;
    }
    sendJson(response, 200, { ok: true, q, messages: searchMessages(q, 50), memories: searchMemoryEvents(q, 50) });
    return;
  }

  // ── 联系人 ──────────────────────────────────────────────
  if (method === "GET" && path === "/api/contacts") {
    const archivedOnly = url.searchParams.get("archived") === "1";
    // 侧栏搜索词。以前是「把每位联系人的人设正文整串下发到浏览器再本地过滤」——
    // 实测那一项占掉列表响应体的 48%，而这个列表前台每 10 秒整份重拉一次且 no-store。
    // 过滤挪到这边之后人设一个字都不出后端，而且顺带搜得到预览（本地那份搜不到）。
    const needle = (url.searchParams.get("q") ?? "").trim().slice(0, 40).toLowerCase();
    const projected = listContacts({ includeArchived: archivedOnly })
      .filter((ct) => (archivedOnly ? ct.archived_at !== null : ct.archived_at === null))
      // 保留联系人「设置助手」不属于会话列表——它只活在助手视图里（资料仍走 /api/contacts/:id）
      .filter((ct) => ct.id !== ASSISTANT_CONTACT_ID)
      .map((contact) => {
        const last = lastMessagePreview(contact.id);
        const pending = pendingProactiveTask(contact.id);
        const item = {
          id: contact.id,
          name: contact.name,
          type: contact.type,
          avatar: avatarForDisplay(contact),
          gender: contact.gender,
          recentTurns: contact.recent_turns,
          // 聊天框显示开关（纯显示，不影响落库与状态页）：会话页按联系人各算一份
          showThinking: contact.features.showThinking,
          showTools: contact.features.showTools,
          // 流式渲染由「回复方式」派生：分多条→非流式（整条弹出），单条整段→逐字流式。
          streamReveal: !contact.features.splitReply,
          // 图像生成开没开：会话页据此决定露不露「画一张」，能力就绪与否由 /api/status 那份 caps 决定
          imageGen: contact.features.imageGen,
          createdAt: contact.created_at,
          preview: last ? (last.role === "user" ? "我：" : "") + last.text.replace(/\s+/g, " ").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/^\s*[-*#]\s+/g, "").slice(0, 40) : "打过招呼就能开始聊",
          lastAt: last?.at ?? contact.created_at,
          pending: pending ? 1 : 0,
          pendingFocus: pending?.focus ?? "",
          archivedAt: contact.archived_at,
          unread: unreadCount(contact.id),
        };
        // 可搜文本只用来筛，绝不进响应：里面装的是人设正文。
        const haystack = needle === "" ? ""
          : [contact.name, contact.card.identity, contact.card.background, contact.card.relationship, item.preview]
            .join("\n").toLowerCase();
        return { item, hit: needle === "" || haystack.includes(needle) };
      });
    const contacts = projected.filter((row) => row.hit).map((row) => row.item);
    // 会话列表按「最后一条消息」倒序（微信口径）：此前是建号先后，行里印着时间却完全对不上。
    // 排在这里而不是各消费方自己排：侧栏会话列表与页头切换器吃的是同一个接口，一处改才一致。
    // 归档分组不排——那是管理面，建号先后是稳定顺序，好找。
    if (!archivedOnly) contacts.sort((a, b) => b.lastAt - a.lastAt || a.createdAt - b.createdAt);
    sendJson(response, 200, { ok: true, contacts });
    return;
  }

  // 已读记账：聊天界面看到最新消息时上报，红点随即消失。
  if (method === "POST" && path === "/api/contacts/read") {
    const body = await readJson<Record<string, unknown>>(request);
    const cid = typeof body.contactId === "string" ? body.contactId : "";
    const target = cid || currentContactId(url);
    const messageId = Number(body.messageId);
    // 不校验就会把任意字符串写进 kv 的已读表（那一行是 JSON，能被外部无限撑大），
    // 非数字的 messageId 也会顺着写进去，之后 unreadCount 直接算错。
    // 助手工作区的派生 id（assistant:<线程>）不在 contacts 表里，但它是合法作用域——
    // 按注册表放行，否则助手弹窗每拉一次新消息就吃一个 400 并反复重试。
    if ((!contactExists(target) && !isAssistantThreadContactId(target)) || !Number.isFinite(messageId) || messageId <= 0) {
      sendJson(response, 400, { ok: false, error: "已读上报的联系人或消息 id 不合法" });
      return;
    }
    markContactRead(target, messageId);
    sendJson(response, 200, { ok: true });
    return;
  }

  // ── QQ 连接（全局一份机器人凭据 + 每联系人一条 openid 绑定）────
  // 与微信不同：官方是"一个机器人服务很多用户"，所以 AppID/AppSecret 是全局资产，
  // 放在 /api/qq/credentials；资料页那张卡只管这一位联系人的绑定。
  if (path === "/api/qq/credentials") {
    if (method === "GET") {
      sendJson(response, 200, { ok: true, ...qq.summary() });
      return;
    }
    if (method === "POST") {
      const body = await readJson<Record<string, unknown>>(request);
      try {
        sendJson(response, 200, { ok: true, ...qq.setCredentials(body), ...qq.summary() });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
  }

  // 扫码拿凭据：官方推荐这条（不用去平台手抄 AppID/AppSecret）。
  // 完成时后端直接把凭据存下来并连上网关，AppSecret 与那把 AES 钥匙都不出服务端。
  if (path === "/api/qq/qr" && method === "POST") {
    try {
      sendJson(response, 200, { ok: true, ...(await qq.beginCredentialQr()) });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const qqQrMatch = method === "GET" ? path.match(/^\/api\/qq\/qr\/([^/]+)$/) : null;
  if (qqQrMatch) {
    try {
      sendJson(response, 200, { ok: true, ...(await qq.pollCredentialQr(decodeURIComponent(qqQrMatch[1] ?? ""))) });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const qqMatch = path.match(/^\/api\/contacts\/([^/]+)\/qq(\/[^/]*)?(\/[^/]*)?$/);
  if (qqMatch) {
    const contactId = decodeURIComponent(qqMatch[1] ?? "");
    const action = qqMatch[2] ?? "";
    const arg = qqMatch[3] ? decodeURIComponent(qqMatch[3].slice(1)) : "";
    if (method === "GET" && action === "") {
      sendJson(response, 200, { ok: true, ...qq.snapshotFor(contactId) });
      return;
    }
    if (method === "POST" && action === "/bind" && arg === "") {
      try {
        sendJson(response, 200, { ok: true, ...qq.beginBind(contactId) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (method === "GET" && action === "/bind" && arg !== "") {
      sendJson(response, 200, { ok: true, ...qq.pollBind(arg) });
      return;
    }
    if (method === "POST" && (action === "/flags" || action === "/disconnect")) {
      const existing = qq.snapshotFor(contactId).binding;
      if (existing === null) {
        sendJson(response, 404, { ok: false, error: "该联系人还没有 QQ 绑定" });
        return;
      }
      if (action === "/disconnect") {
        qq.disconnect(existing.id);
        sendJson(response, 200, { ok: true });
        return;
      }
      const body = await readJson<Record<string, unknown>>(request);
      const patch: { enabled?: boolean; proactive?: boolean } = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.proactive === "boolean") patch.proactive = body.proactive;
      if (!qq.setFlags(existing.id, patch)) {
        sendJson(response, 404, { ok: false, error: "该联系人还没有 QQ 绑定" });
        return;
      }
      sendJson(response, 200, { ok: true, binding: qq.snapshotFor(contactId).binding });
      return;
    }
  }

  // ── 微信连接（每联系人一条 iLink 绑定）────────────────────
  const wechatMatch = path.match(/^\/api\/contacts\/([^/]+)\/wechat(\/[^/]*)?(\/[^/]*)?$/);
  if (wechatMatch) {
    const contactId = decodeURIComponent(wechatMatch[1] ?? "");
    const action = wechatMatch[2] ?? "";
    const arg = wechatMatch[3] ? decodeURIComponent(wechatMatch[3].slice(1)) : "";
    if (method === "GET" && action === "") {
      sendJson(response, 200, { ok: true, ...wechat.snapshotFor(contactId) });
      return;
    }
    if (method === "POST" && action === "/bind" && arg === "") {
      try {
        sendJson(response, 200, { ok: true, ...(await wechat.beginBind(contactId)) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (method === "GET" && action === "/bind" && arg !== "") {
      sendJson(response, 200, { ok: true, ...(await wechat.pollBind(arg)) });
      return;
    }
    if (method === "POST" && (action === "/flags" || action === "/disconnect")) {
      const existing = wechat.snapshotFor(contactId).link;
      if (!existing) {
        sendJson(response, 404, { ok: false, error: "该联系人还没有微信连接" });
        return;
      }
      if (action === "/disconnect") {
        wechat.disconnect(existing.id);
        sendJson(response, 200, { ok: true });
        return;
      }
      const body = await readJson<Record<string, unknown>>(request);
      const patch: { enabled?: boolean; proactive?: boolean } = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.proactive === "boolean") patch.proactive = body.proactive;
      if (!wechat.setFlags(existing.id, patch)) {
        sendJson(response, 404, { ok: false, error: "该联系人还没有微信连接" });
        return;
      }
      sendJson(response, 200, { ok: true, link: wechat.snapshotFor(contactId).link });
      return;
    }
  }

  if (method === "GET" && path.startsWith("/api/contacts/")) {
    const id = decodeURIComponent(path.slice("/api/contacts/".length));
    const contact = getContact(id);
    if (!contact) {
      sendJson(response, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
      return;
    }
    sendJson(response, 200, { ok: true, contact: { ...contact, avatar: avatarForDisplay(contact) } });
    return;
  }

  if (method === "POST" && path === "/api/contacts") {
    // 与 PUT 同口径：新建也能带头像 dataURL（≤150KB）+ 三段合计 30000 字的人设
    const body = await readJson<Record<string, unknown>>(request, MAX_CARD_BODY_BYTES);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "" || name.length > 20) {
      sendJson(response, 400, { ok: false, error: "给联系人起个名字（最多 20 个字）" });
      return;
    }
    const card: Record<string, string> = {};
    for (const key of ["identity", "background", "relationship"] as const) {
      if (typeof body[key] === "string" && (body[key] as string).trim() !== "") card[key] = (body[key] as string).trim();
    }
    // 新建时也要能带头像（资料页上传，不再走列表行误触）
    let createAvatar: string | undefined;
    if (body.avatar !== undefined) {
      const clean = sanitizeAvatar(body.avatar);
      if (body.avatar !== "" && clean === undefined) {
        sendJson(response, 400, { ok: false, error: "头像只支持 png/jpg/webp 图片（≤150KB）" });
        return;
      }
      createAvatar = clean;
    }
    // 性别与 PUT 同口径：非法值直接拒绝，缺省由 createContact 归到 female
    let createGender: ContactGender | undefined;
    if (body.gender !== undefined) {
      if (body.gender !== "female" && body.gender !== "male" && body.gender !== "other") {
        sendJson(response, 400, { ok: false, error: "性别只能是 female / male / other" });
        return;
      }
      createGender = body.gender;
    }
    const contact = createContact({ name, card, avatar: createAvatar, gender: createGender });
    sendJson(response, 200, { ok: true, contact, note: "新联系人已创建，记忆从零开始" });
    return;
  }

  const contactUpdateMatch = method === "PUT" ? path.match(/^\/api\/contacts\/([^/]+)$/) : null;
  if (contactUpdateMatch) {
    const id = decodeURIComponent(contactUpdateMatch[1] ?? "");
    // 放宽上限：这条收头像 dataURL（≤150KB）加三段合计 30000 字的人设，
    // 通用 32KB 会在字段校验之前就把合法请求挡掉（见 MAX_CARD_BODY_BYTES 的注释）。
    // 注意这里的字段只是原样收下，合计额度由 settings.ts 的 sanitizeCharacter 统一截。
    const body = await readJson<Record<string, unknown>>(request, MAX_CARD_BODY_BYTES);
    let avatar: string | undefined;
    if (body.avatar !== undefined) {
      const clean = sanitizeAvatar(body.avatar);
      if (body.avatar !== "" && clean === undefined) {
        sendJson(response, 400, { ok: false, error: "头像只支持 png/jpg/webp 图片（≤150KB）" });
        return;
      }
      avatar = clean;
    }
    // 长相参考图：先经 /api/media 落盘，这里只收那条 /media 路径（文件必须真在）
    let faceRef: string | undefined;
    if (body.faceRef !== undefined) {
      const clean = sanitizeFaceRef(body.faceRef);
      if (body.faceRef !== "" && clean === undefined) {
        sendJson(response, 400, { ok: false, error: "长相参考图得是已上传到本机的 /media 图片" });
        return;
      }
      faceRef = clean;
    }
    const card: Record<string, string> = {};
    for (const key of ["identity", "background", "relationship"] as const) {
      if (typeof body[key] === "string") card[key] = (body[key] as string).trim();
    }
    // 模型绑定：空串 = 跟随全局；给了档 id 就必须真实存在，宁挡错不放过悬空引用
    let modelProfile: string | undefined;
    if (body.modelProfile !== undefined) {
      modelProfile = typeof body.modelProfile === "string" ? body.modelProfile.trim() : "";
      if (modelProfile !== "" && !listProfiles().some((p) => p.id === modelProfile)) {
        sendJson(response, 400, { ok: false, error: "绑定的模型档不存在，可能已被删除" });
        return;
      }
    }
    // 陪伴能力开关（局部覆盖：只改传进来的键）；生活线与温度计允许用户手改。
    let features: Partial<CompanionFeatures> | undefined;
    if (body.features !== undefined) {
      if (body.features === null || typeof body.features !== "object" || Array.isArray(body.features)) {
        sendJson(response, 400, { ok: false, error: "features 必须是对象" });
        return;
      }
      features = body.features as Partial<CompanionFeatures>;
    }
    // 回放轮数（按联系人覆盖全局）：0 = 跟随全局；-1 = 全部；1~MAX_TURNS 自定义；越界直接拒绝，不静默截断
    let recentTurns: number | undefined;
    if (body.recentTurns !== undefined) {
      const t = body.recentTurns;
      if (typeof t !== "number" || !Number.isInteger(t) || (t !== ALL_TURNS && (t < 0 || t > MAX_TURNS))) {
        sendJson(response, 400, { ok: false, error: `回放轮数只能是 0（跟随全局）、-1（全部）或 1~${MAX_TURNS} 的整数` });
        return;
      }
      recentTurns = t;
    }
    // 性别：驱动界面与提示词里的代词（她/他/TA）；非法值拒绝
    let gender: ContactGender | undefined;
    if (body.gender !== undefined) {
      if (body.gender !== "female" && body.gender !== "male" && body.gender !== "other") {
        sendJson(response, 400, { ok: false, error: "性别只能是 female / male / other" });
        return;
      }
      gender = body.gender;
    }
    const lifeline = typeof body.lifeline === "string" ? body.lifeline : undefined;
    const recap = typeof body.recap === "string" ? body.recap : undefined;
    // bond 局部覆盖：只把传进来的键并进现有温度计，缺省键保持原样（sanitizeBond 兜形状）。
    const bond = body.bond !== undefined && body.bond !== null && typeof body.bond === "object" && !Array.isArray(body.bond)
      ? (body.bond as Partial<BondState>)
      : undefined;
    const contact = updateContact(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      card,
      avatar,
      faceRef,
      modelProfile,
      recentTurns,
      gender,
      features,
      lifeline,
      recap,
      bond,
    });
    if (!contact) {
      sendJson(response, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
      return;
    }
    sendJson(response, 200, { ok: true, contact: { ...contact, avatar: avatarForDisplay(contact) } });
    return;
  }

  const contactUnarchiveMatch = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/unarchive$/) : null;
  if (contactUnarchiveMatch) {
    const ok = unarchiveContact(decodeURIComponent(contactUnarchiveMatch[1] ?? ""));
    if (!ok) {
      sendJson(response, 400, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
      return;
    }
    sendJson(response, 200, { ok: true, note: "已恢复到列表，对话与记忆原样" });
    return;
  }

  const contactArchiveMatch = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/archive$/) : null;
  if (contactArchiveMatch) {
    const ok = archiveContact(decodeURIComponent(contactArchiveMatch[1] ?? ""));
    if (!ok) {
      sendJson(response, 400, { ok: false, error: "联系人不存在，或那是内置的设置助手（助手不属于会话，删不掉）" });
      return;
    }
    sendJson(response, 200, { ok: true, note: "已归档（数据保留，人格不可再生）" });
    return;
  }

  // 人格三段换回出厂那份（只动这三段：名字/头像/性别/能力开关都不受牵连）。
  const contactResetCardMatch = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/reset-card$/) : null;
  if (contactResetCardMatch) {
    const restored = restoreDefaultCard(decodeURIComponent(contactResetCardMatch[1] ?? ""));
    if (!restored) {
      sendJson(response, 404, { ok: false, error: "联系人不存在，可能已被删除" });
      return;
    }
    // 不回 contact：头像那层的展示口径（内置小茉回落应用图标）只在读接口里映射，
    // 这里回一份没映射过的原件反而多出一个会说假话的出口。界面自己重拉。
    sendJson(response, 200, { ok: true, note: "人设已换回出厂那份，其余设置没动" });
    return;
  }

  // 彻底删除：只接受已归档的联系人（归档=冷却期）。对话/记忆/任务/用量/图片全清，不可恢复。
  const contactDeleteMatch = method === "DELETE" ? path.match(/^\/api\/contacts\/([^/]+)$/) : null;
  if (contactDeleteMatch) {
    try {
      const id = decodeURIComponent(contactDeleteMatch[1] ?? "");
      const result = deleteContact(id);
      // 微信绑定存在 kv 里，不在 deleteContact 的事务范围内：不主动解绑的话长轮询还在跑，
      // 对端一句话就给一个已不存在的 contact_id 建轮次写消息（界面看不到、也删不掉）。
      const unbound = wechat.disconnectByContact(id);
      // QQ 也一样：网关事件按 openid 找绑定，人不在了还会继续往这段对话里写消息。
      const qqUnbound = qq.disconnectByContact(id);
      sendJson(response, 200, { ok: true, removedMedia: result.removedMedia, unbound, qqUnbound, note: "已彻底删除，不可恢复" });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // 恢复出厂设置：清空全部对话/记忆/任务/画作/设置与绑定，再重新种子内置联系人。
  // 这是全应用唯一一次"抹掉重来"，所以要求显式 confirm—— curl 手滑比界面手滑更常见。
  if (method === "POST" && path === "/api/settings/factory-reset") {
    const body = await readJson<{ confirm?: unknown }>(request);
    if (body.confirm !== "FACTORY") {
      sendJson(response, 400, { ok: false, error: "这个操作要显式确认（confirm=FACTORY）：它会清掉全部对话、记忆、画作与所有设置" });
      return;
    }
    // 收件循环与内存里那份绑定缓存一起抹：只清 kv 的话 store 还在，
    // 而重新种子出来的小茉 id 仍是 default，旧绑定会把新会话镜像出去。
    wechat.clearAll();
    qq.clearAll();   // 凭据与绑定一起抹：网关还连着的话，旧 openid 会把消息写进新种子的会话里
    const cleared = factoryReset();
    ensureDefaultContact();
    ensureAssistantContact();
    resetToolsUnsupported();  // 模型档全没了：工具支持探测重新来一遍，别拿旧结论说话
    console.log(`[factory-reset] 清掉 ${cleared.contacts} 位联系人与 ${cleared.mediaRemoved} 个图片文件，已重新种子`);
    sendJson(response, 200, {
      ok: true, ...snapshotResponse(),
      note: `已回到初始状态：${cleared.contacts} 位联系人的对话与记忆、全部设置与绑定、${cleared.mediaRemoved} 个图片文件都已清除`,
    });
    return;
  }

  // 一键导出/导入：导出是 gzip tar 文件流；导入会先校验临时解包目录，再替换当前数据并要求重启。
  if (method === "GET" && path === "/api/settings/data-export") {
    try {
      await writeDataExport(response);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      response.destroy();
    }
    return;
  }

  if (method === "POST" && path === "/api/settings/data-import") {
    const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/gzip" && contentType !== "application/x-gzip" && contentType !== "application/octet-stream") {
      sendJson(response, 400, { ok: false, error: "请上传小茉导出的 .tar.gz 备份文件" });
      return;
    }
    try {
      const result = await importDataArchive(request);
      sendJson(response, 200, { ok: true, ...result, restartRequired: true });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  // 更改数据存储位置：把库 / media / skills 迁到新目录、更新 desktop.json 的 DATA_DIR。
  // 迁完必须重启才走新位置（config / db / 目录都是模块级常量，见 data-dir.ts 注释）。
  if (method === "POST" && path === "/api/settings/data-dir") {
    const body = await readJson<{ path?: unknown }>(request);
    const target = typeof body.path === "string" ? body.path.trim() : "";
    if (target === "") {
      sendJson(response, 400, { ok: false, error: "要给出新的数据目录路径" });
      return;
    }
    try {
      const moved = await migrateDataDir(target);
      sendJson(response, 200, {
        ok: true, ...snapshotResponse(),
        note: `已把数据迁到 ${moved.newDir}：库 1 个、图片 ${moved.media} 个、技能 ${moved.skills} 个。重启应用后生效。`,
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // 桌面外壳的两项偏好：开机自动启动 / 关窗后留在托盘。
  // 值落 desktop.json（外壳启动时读），同时后端往 stdout 打一行 XIAOMO-PREF 让外壳当场生效
  // ——不这么办，用户点完开关要重启才看得到反应，就是最容易被当成 bug 的"点了没反应"。
  if (method === "POST" && path === "/api/settings/desktop") {
    const body = await readJson<{ autostart?: unknown; tray?: unknown }>(request);
    const patch: { autostart?: boolean; tray?: boolean } = {};
    if (typeof body.autostart === "boolean") patch.autostart = body.autostart;
    if (typeof body.tray === "boolean") patch.tray = body.tray;
    if (Object.keys(patch).length === 0) {
      sendJson(response, 400, { ok: false, error: "要改的项得是 true 或 false" });
      return;
    }
    try {
      const saved = setDesktopPrefs(patch);
      sendJson(response, 200, { ok: true, ...snapshotResponse(), desktop: saved });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // 手动触发一次记忆整理（「立即整理记忆」按钮 / 冒烟测试）。
  // 与后台搭车走同一个 consolidateContact：同一时刻每联系人只跑一份，失败原因原样回显。
  const contactConsolidateMatch = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/consolidate$/) : null;
  if (contactConsolidateMatch) {
    const id = decodeURIComponent(contactConsolidateMatch[1] ?? "");
    if (!getContact(id)) {
      sendJson(response, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
      return;
    }
    try {
      // ConsolidationResult 自带 ok（echo/并发跳过是 ok:false + note），不额外包一层。
      sendJson(response, 200, await consolidateContact(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { ok: false, error: `整理失败：${message}` });
    }
    return;
  }

  // ── 助手工作区（多份互不干扰的对话） ──────────────────────
  if (method === "GET" && path === "/api/assistant/threads") {
    sendJson(response, 200, { ok: true, threads: listAssistantThreads() });
    return;
  }

  if (method === "POST" && path === "/api/assistant/threads") {
    const body = await readJson<Record<string, unknown>>(request);
    const thread = createAssistantThread(typeof body.title === "string" ? body.title : "");
    sendJson(response, 200, { ok: true, thread });
    return;
  }

  if (method === "POST" && path === "/api/assistant/threads/rename") {
    const body = await readJson<Record<string, unknown>>(request);
    const id = typeof body.id === "string" ? body.id : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title === "" || title.length > 24) {
      sendJson(response, 400, { ok: false, error: "工作区名称不能为空（最多 24 个字）" });
      return;
    }
    if (!renameAssistantThread(id, title)) {
      sendJson(response, 404, { ok: false, error: "工作区不存在" });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && path === "/api/assistant/threads/clear") {
    const body = await readJson<Record<string, unknown>>(request);
    // id 空串 = 内置「通用」：它删不掉，所以「清空」正是它唯一的出口。
    const id = typeof body.id === "string" ? body.id : "";
    const cleared = clearAssistantThread(id);
    if (cleared === null) {
      sendJson(response, 404, { ok: false, error: "工作区不存在" });
      return;
    }
    sendJson(response, 200, { ok: true, ...cleared });
    return;
  }

  if (method === "POST" && path === "/api/assistant/threads/delete") {
    const body = await readJson<Record<string, unknown>>(request);
    const id = typeof body.id === "string" ? body.id : "";
    if (id === "") {
      sendJson(response, 400, { ok: false, error: "内置「通用」工作区不可删除" });
      return;
    }
    if (!deleteAssistantThread(id)) {
      sendJson(response, 404, { ok: false, error: "工作区不存在" });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  // ── 主动性 ──────────────────────────────────────────────
  if (method === "GET" && path === "/api/proactive/status") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    sendJson(response, 200, { ok: true, contactId, ...inspectGates(contactId), enabled: config.proactive.enabled });
    return;
  }

  if (method === "POST" && path === "/api/proactive/run") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    // 只有当家进程能跑：主动性会**真的把话说出去**（并镜像到微信/QQ、吃掉每日配额）。
    // 从前这条不看租约，于是桌面端 + 终端里一句 `npm run proactive:once`、或两个窗口
    // 各点一次「立即检查主动性」，两边都通过 spokenCountToday()===0 的门，
    // 同一句话投递两次、日配额翻倍、scheduleNext 插出两条跟进任务。
    // checksInFlight 是进程内的互斥，挡不住跨进程——只有租约挡得住。
    if (!leaseIsFreeOrOurs()) {
      sendJson(response, 409, { ok: false, code: "NOT_PRIMARY", error: "另一个实例正在跑主动性（同一份数据只能有一个当家的），这一边只提供界面与接口" });
      return;
    }
    // 与 /api/say 同一纪律：立刻 202，判断（可能要等模型 30s+）在后台跑，前端轮询看结果。
    void runProactiveCheck(contactId, "manual").catch((error) => {
      console.warn(`[proactive] 手动检查失败：${error instanceof Error ? error.message : String(error)}`);
    });
    sendJson(response, 202, { ok: true, contactId, started: true, note: "已在后台开始检查，稍后刷新看结果" });
    return;
  }

  // 任务留痕：她惦记着什么、上次为什么说/没说、失败原因，全部可查。
  if (method === "GET" && path === "/api/proactive/tasks") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    // 从前只有 LIMIT、没有 offset 也没有 total：这条 SQL 取的是**全状态**（含已执行/已取消），
    // 实测小茉 91 条、阿琳 67 条，界面写死 40 就等于把后一半永久藏起来，还不报一句。
    const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    // state 让「待执行」与「执行记录」各查各的：混着翻页时，一条排得靠后的待执行
    // 计划会掉出第一页，界面那个页签就空了。
    const state = url.searchParams.get("state") === "pending" ? "pending"
      : url.searchParams.get("state") === "history" ? "history" : undefined;
    sendJson(response, 200, {
      ok: true, contactId, offset, state: state ?? "all", total: countProactiveTasks(contactId, state),
      tasks: listProactiveTasks(contactId, limit, offset, state),
    });
    return;
  }

  // 用户自己立一条计划（此前只能看她立的那些，界面连入口都没有）。
  // 到点不等于立刻：发送落在下一次检查（默认 30 分钟一趟），免打扰时段顺延——这句由界面说破。
  if (method === "POST" && path === "/api/proactive/tasks") {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const body = await readJson<Record<string, unknown>>(request);
    let task;
    try {
      task = createProactiveTask(contactId, { kind: body.kind, focus: body.focus, dueAt: body.dueAt });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    sendJson(response, 200, { ok: true, task, note: "已加进待执行计划" });
    return;
  }

  // 取消一条还没执行的打算（只有 pending 状态能取消）。
  const taskCancelMatch = method === "POST" ? path.match(/^\/api\/proactive\/tasks\/(\d+)\/cancel$/) : null;
  if (taskCancelMatch) {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    const cancelled = cancelProactiveTask(Number(taskCancelMatch[1]), contactId);
    if (!cancelled) {
      sendJson(response, 404, { ok: false, error: "任务不存在，或已执行/已取消" });
      return;
    }
    sendJson(response, 200, { ok: true, note: "已取消这条打算", tasks: listProactiveTasks(contactId, 20) });
    return;
  }

  // 撤销取消：把刚被手动取消的那条放回待执行（反悔窗口用，见前端 offerUndo）。
  const taskRestoreMatch = method === "POST" ? path.match(/^\/api\/proactive\/tasks\/(\d+)\/restore$/) : null;
  if (taskRestoreMatch) {
    const contactId = strictContactId(url, response);
    if (contactId === null) return;
    if (!restoreProactiveTask(Number(taskRestoreMatch[1]), contactId)) {
      sendJson(response, 404, { ok: false, error: "这条打算不是被取消的状态，放不回去" });
      return;
    }
    sendJson(response, 200, { ok: true, note: "已放回待执行", tasks: listProactiveTasks(contactId, 20) });
    return;
  }

  sendJson(response, 404, { ok: false, error: `未知路径 ${method} ${path}` });
}

/**
 * 从 Host 头里取主机名。
 *
 * ⚠️ 不能 `split(":")[0]`：IPv6 字面量写成 `[::1]:8787`，按冒号切得到的是 `"["`，
 * 剥掉括号后变空串——于是 `loopbackBinds` 永远匹配不上，绑 `::1` 时**每个请求都 403**
 * （而 `::1` 是 `loopbackBinds` 明确支持的配置）。必须先整体匹配方括号形态。
 */
function hostnameOfHostHeader(raw: string): string {
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
 * 由下面的白名单 + 单机自用定位共同承担，README「已知取舍」里也写明了。
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
function passesLocalGuard(request: IncomingMessage, hostHeader: string): boolean {
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
 * 消息四道写入口（/edit、PUT /text、/retract、DELETE）共用的户主校验。
 *
 * 为什么必须有：这四个路由原来只认数字 id，而消息 id 是**自增整数**——看着 A 的界面
 * 就能改/撤/删 B 的消息，DELETE 还会真删行并回收图片，不可恢复。
 * 联系人多起来之后这不是理论风险：陈旧 id、第二个窗口、书签里的旧链接都能撞上。
 *
 * 口径与 `strictContactId` 一致但用途不同：那边防「拿到不存在的人的数据」，
 * 这边防「动了别人的数据」。没传 contactId 时按既定规则回落 default——
 * 所以前端四处都该用 `cq()` 带上，否则回落值对不上就白白吃一个 404。
 * `contact_id` 为 NULL 是多联系人迁移前的存量行，按 default 认（contacts.ts 的回填同口径）。
 * 返回 false 表示响应已发完，调用方直接 return。
 */
function ownMessageOrReject(url: URL, response: ServerResponse, id: number): boolean {
  const contactId = currentContactId(url);
  const row = getMessage(id);
  if (row === null) {
    sendJson(response, 404, { ok: false, error: "这条消息不存在，可能已被删除" });
    return false;
  }
  const owner = row.contact_id ?? DEFAULT_CONTACT_ID;
  if (owner !== contactId) {
    sendJson(response, 403, { ok: false, error: "这条消息不属于这个联系人" });
    return false;
  }
  return true;
}

/** 从 query 取联系人：不存在或没传一律回落默认联系人（无状态 API，前端负责记住当前选中）。
 *  助手工作区的派生 id（assistant:<线程>）不是联系人，按注册表放行。 */
function currentContactId(url: URL): string {
  const requested = url.searchParams.get("contactId");
  if (!requested) return DEFAULT_CONTACT_ID;
  if (getContact(requested) || isAssistantThreadContactId(requested)) return requested;
  return DEFAULT_CONTACT_ID;
}

/**
 * 严格版联系人解析：未知 id 直接 404，不静默回落。
 * localStorage 里的陈旧 id（联系人已删除）拿到「另一个人的数据」比报错危险得多——
 * 与消息路由的 `404 联系人不存在` 保持同一语义。
 */
function strictContactId(url: URL, response: ServerResponse): string | null {
  const requested = url.searchParams.get("contactId");
  if (!requested) return DEFAULT_CONTACT_ID;
  if (getContact(requested) || isAssistantThreadContactId(requested)) return requested;
  sendJson(response, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在，可能已被删除" });
  return null;
}

/** settingsSnapshot + 三个高频派生字段：原先 8 处响应样板收成一个口。 */
function snapshotResponse(): Record<string, unknown> {
  return {
    ...settingsSnapshot(),
    /** 密钥是否已配置——前端用它决定要不要提示"请填密钥"，而不是看到掩码瞎猜。 */
    hasKey: modelConfig().apiKey !== "",
    modelReady: modelReadyNow(),
    /** 首次设置走完没有（没走完时界面留着那张清单）。 */
    onboardingDone: onboardingDone(),
    /** 默认联系人的人设还是出厂那份（首启引导据此决定要不要问「改改人设」那一步）。
     *  比较的是**真正生效的那份**：聊天吃的是 contacts.card，不是 settings.persona.character。 */
    personaIsDefault: defaultPersonaIsDefault(),
  };
}

/**
 * 内置联系人没自己设过头像时，各回一张出厂默认图（库里始终存空串，只有发给界面时才换成静态路径；
 * 用户换成自己的图照旧覆盖）。小茉 → /xiaomo.png，设置助手 → /assistant.png。
 *
 * 为什么不把默认头像内联成 dataURL 存进库里：会话列表是几秒一轮的轮询，那份几十 KB 的图会变成
 * 每轮多带几十 KB——刚把列表压回 KB 级，不该又顶回去。静态路径由 Vite 拷进 dist 根、白名单路由发出。
 *
 * 与「应用图标」的分工：/icon.png（花朵气泡）仍是任务栏 / favicon / 关于页那一份；小茉头像已从
 * 应用图标解耦出来单独用 /xiaomo.png，花朵图另存一份 /assistant.png 给助手当默认头像。
 */
function avatarForDisplay(contact: { id: string; avatar: string }): string {
  if (contact.avatar !== "") return contact.avatar;
  if (contact.id === DEFAULT_CONTACT_ID) return "/xiaomo.png";
  if (contact.id === ASSISTANT_CONTACT_ID) return "/assistant.png";
  return contact.avatar;
}

// ── gzip ──────────────────────────────────────────────
// 穿透访问下首屏最大的一块成本是 320KB 的产物原文（gzip 后 92KB）；轮询接口同理
// （/api/contacts 每 10 秒 15KB 原文）。node:zlib 是内置的，不引依赖。
// 客户端接不接受 gzip 在请求入口记一次在 response 上，sendJson / sendFile 共用这
// 一个事实来源——否则要给六十多个 sendJson 调用点都加一个 request 参数。
const GZIP_OK = Symbol("accepts-gzip");
type GzipAware = ServerResponse & { [GZIP_OK]?: boolean };

function markGzip(request: IncomingMessage, response: ServerResponse): void {
  const ae = request.headers["accept-encoding"];
  (response as GzipAware)[GZIP_OK] = typeof ae === "string" && ae.includes("gzip");
}

/** 小于这个体积压了也省不下一个 MTU，白付 CPU。 */
const GZIP_MIN_BYTES = 1024;

function gzipHeaders(encoding: string | null): Record<string, string> {
  // Vary 必须带：穿透那层的 CDN 若按 URL 缓存，不带 Vary 会把 gzip 版发给不接受 gzip 的客户端。
  return encoding === null ? {} : { "content-encoding": encoding, vary: "accept-encoding" };
}

/** 静态文件不常变，gzip 结果按 size+mtime 记一份，别每次请求都压一遍。 */
const gzipCache = new Map<string, { key: string; buf: Buffer | null }>();

function gzipOfFile(file: string, body: Buffer): Buffer | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = gzipCache.get(file);
  if (hit !== undefined && hit.key === key) return hit.buf;
  const gz = gzipSync(body);
  const buf = gz.length < body.length ? gz : null;
  gzipCache.set(file, { key, buf });
  if (gzipCache.size > 128) gzipCache.delete(gzipCache.keys().next().value as string);
  return buf;
}

/**
 * 手机第一次打开时看到的登录页。
 * 刻意**不依赖任何站点资源**：那时请求还没有 cookie，前端包也取不到，所以样式全内联。
 */
function sendLanLogin(response: ServerResponse): void {
  sendHtml(response, `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>小茉 · 输入访问码</title>
<style>
 :root{--bg:#efe7da;--fg:#2b241d;--card:#fffdfa;--line:#d9cdbb;--accent:#b7522f}
 @media (prefers-color-scheme:dark){:root{--bg:#171310;--fg:#f0e8dd;--card:#221c18;--line:#3a302a;--accent:#e08a5f}}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
      background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 form{width:100%;max-width:340px;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:16px}
 h1{margin:0 0 6px;font-size:19px}
 p{margin:0 0 18px;font-size:13px;opacity:.72}
 input{width:100%;padding:12px 14px;font-size:20px;letter-spacing:.14em;text-align:center;
       border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
 button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:15px}
 #err{margin-top:10px;min-height:18px;font-size:13px;color:#c0392b}
</style></head>
<body>
<form id="f">
  <h1>小茉</h1>
  <p>请输入电脑上「手机访问」里显示的访问码</p>
  <input id="c" inputmode="numeric" autocomplete="one-time-code" placeholder="000-000" autofocus>
  <button type="submit">进入</button>
  <div id="err"></div>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  try {
    const r = await fetch("/__lan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: document.getElementById("c").value }),
    });
    if (r.ok) { location.replace("/"); return; }
    const data = await r.json().catch(() => ({}));
    err.textContent = data.error || "访问码不对";
  } catch { err.textContent = "连不上，确认手机和电脑还在同一个局域网"; }
});
</script>
</body></html>`);
}

/**
 * 试绑一下这个端口。被占的话现在就说清楚——等用户重启完发现白屏，是最难排查的那种失败。
 */
async function probePort(port: number): Promise<{ ok: boolean; error: string }> {
  const { createServer } = await import("node:net");
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        error: error.code === "EADDRINUSE"
          ? `端口 ${port} 已被别的程序占用，换一个`
          : `端口 ${port} 用不了：${error.message}`,
      });
    });
    probe.once("listening", () => probe.close(() => resolve({ ok: true, error: "" })));
    probe.listen(port, "127.0.0.1");
  });
}

/** 给界面看的局域网状态。端口取当前连接的本地端口——PORT=0 自动分配时也是对的。 */
function lanSummary(request: IncomingMessage): {
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {

  const raw = Buffer.from(JSON.stringify(body));
  let buf = raw;
  let encoding: string | null = null;
  if ((response as GzipAware)[GZIP_OK] === true && raw.length >= GZIP_MIN_BYTES) {
    const gz = gzipSync(raw);
    if (gz.length < raw.length) { buf = gz; encoding = "gzip"; }
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...gzipHeaders(encoding),
  });
  response.end(buf);
}

const DIST_MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** 内容寻址的资源（文件名带 hash 的构建产物、随机 id 的聊天图片）可以永久缓存。 */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** 其余一律不缓存：index.html 缓存住就等于新版本发不出去。 */
const NO_STORE = "no-store";

function serveDistFile(name: string, response: ServerResponse, cacheControl = NO_STORE): void {
  // 防路径穿越：resolve 后必须仍在 dist 目录内
  const file = resolve(reactDist, name);
  if (!file.startsWith(resolve(reactDist) + sep)) {
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return;
  }
  const mime = DIST_MIME[extname(file)] ?? "application/octet-stream";
  sendFile(response, file, mime, cacheControl);
}

function sendFile(response: ServerResponse, file: string, mime: string, cacheControl = NO_STORE): void {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }
  let buf = body;
  let encoding: string | null = null;
  // 图片等已压缩的内容 gzip 压不动，gzipOfFile 里「压不赢就返回 null」兜住。
  if ((response as GzipAware)[GZIP_OK] === true && body.length >= GZIP_MIN_BYTES) {
    const gz = gzipOfFile(file, body);
    if (gz !== null) { buf = gz; encoding = "gzip"; }
  }
  response.writeHead(200, {
    "content-type": mime,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    ...(mime.startsWith("text/html") ? HTML_SECURITY_HEADERS : {}),
    ...gzipHeaders(encoding),
  });
  response.end(buf);
}

/**
 * HTML 响应的安全头。为什么必须由后端发：桌面壳启动后 `window.navigate` 到
 * http://127.0.0.1:随机端口，那已经是**远程 origin**——tauri.conf.json 里那条 CSP
 * 只贴得到 tauri 协议下的启动页，界面本身从来没收到过（实测响应头只有 content-type/cache-control）。
 * 声明和实态对不上比没声明更危险：审计的人会照着它判断边界。
 *
 * - `frame-ancestors 'none'` + `X-Frame-Options: DENY`：挡「把整个应用嵌进攻击者页面」。
 *   本服务只校验 Origin 头，而**顶层导航请求根本不带 Origin**，嵌进来就等于拿到了同源身份。
 * - `script-src 'self' 'unsafe-inline'`：'unsafe-inline' 是被迫的——index.html 里那段主题引导
 *   脚本必须在首帧前跑（防闪白，见 frontend/index.html 的注释）。想收掉它得把脚本外置成
 *   带 hash 的单独文件，那是前端构建的活，不在这里偷偷改。
 * - `img-src`/`media-src` 带 blob:：语音与图片放大走的是本地 blob。
 * - 不放 https:：界面里所有图都是 /media 或 data:（头像也早已落盘到 /media）。
 */
const HTML_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...HTML_SECURITY_HEADERS,
  });
  response.end(html);
}

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

/** 历史路径（/memory 等）→ React hash 路由的重定向。 */
function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

async function readJson<T>(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new SettingsBodyError("请求体过大");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {} as T;
  // 非法 JSON 是用户/前端输入问题 → 400（SettingsBodyError），不该冒 500。
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new SettingsBodyError("请求体不是合法的 JSON");
  }
}

async function readBinary(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new SettingsBodyError(`文件过大（上限 ${Math.round(maxBytes / (1024 * 1024))}MB）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * 列表分页的统一口径。前端「界面 → 列表每页」给的是 25/50/100 三档，
 * 这里只兜一个上限：所有管理面列表都从这两个数取，不再一个接口一个默认值
 * （从前是 25/200、15/100、100/500、20/100 四套，记忆页前端还写死 200）。
 */
const LIST_LIMIT_DEFAULT = 25;
const LIST_LIMIT_MAX = 100;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 把请求体里的模型补丁收窄成允许改的字段。
 * 白名单写法：前端多传什么都不会被存进库——这是防"客户端塞任意字段污染配置"的基本功。
 */
function normalizeModelPatch(input: { [K in keyof ModelSettings]?: unknown }): Partial<ModelSettings> {
  const patch: Partial<ModelSettings> = {};

  if (typeof input.mode === "string") patch.mode = input.mode === "openai" ? "openai" : "echo";
  if (typeof input.baseUrl === "string") patch.baseUrl = input.baseUrl.trim();
  if (typeof input.name === "string") patch.name = input.name.trim();
  if (typeof input.startupCheck === "boolean") patch.startupCheck = input.startupCheck;

  // 能力元数据（勾选组/思考强度/token 上限）：一律过 settings 侧的净化器，脏字段静默丢弃。
  if (input.caps !== undefined) patch.caps = sanitizeModelCaps(input.caps);
  if (input.thinkingLevel !== undefined) {
    const lvl = typeof input.thinkingLevel === "string" && THINKING_LEVELS.some((l) => l.id === input.thinkingLevel)
      ? input.thinkingLevel
      : "";
    patch.thinkingLevel = lvl as ModelSettings["thinkingLevel"];
  }
  // 思考参数形态与开关意图：和档位保存那条路共用同一份净化器，不再各写一份字面量
  if (input.thinkingParam !== undefined) patch.thinkingParam = sanitizeThinkingParam(input.thinkingParam);
  if (input.thinkingMode !== undefined) patch.thinkingMode = sanitizeThinkingMode(input.thinkingMode);
  if (Array.isArray(input.thinkingLevels)) {
    patch.thinkingLevels = input.thinkingLevels.filter(
      (x): x is ModelSettings["thinkingLevels"][number] =>
        typeof x === "string" && THINKING_LEVELS.some((l) => l.id === x),
    );
  }
  if (input.maxInputTokens !== undefined) {
    const n = Number(input.maxInputTokens);
    patch.maxInputTokens = Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.trunc(n) : 0;
  }
  if (input.maxOutputTokens !== undefined) {
    const n = Number(input.maxOutputTokens);
    patch.maxOutputTokens = Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.trunc(n) : 0;
  }

  if (input.timeoutMs !== undefined) {
    const n = Number(input.timeoutMs);
    if (Number.isFinite(n)) patch.timeoutMs = Math.trunc(n);
  }

  if (input.extraBody !== undefined) {
    if (typeof input.extraBody === "string") {
      // 前端用文本框编辑 JSON，这里负责解析成人话错误。
      const raw = input.extraBody.trim();
      if (raw === "") patch.extraBody = {};
      else {
        try {
          const parsed = JSON.parse(raw) as unknown;
          patch.extraBody =
            parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
        } catch {
          patch.extraBody = undefined;
          throw new SettingsBodyError("额外参数不是合法 JSON");
        }
      }
    } else if (input.extraBody !== null && typeof input.extraBody === "object") {
      patch.extraBody = input.extraBody as Record<string, unknown>;
    }
  }

  // 密钥特例：掩码表示"没改"，空串表示"清掉"，其它才是真新密钥。
  if (typeof input.apiKey === "string") {
    const key = input.apiKey.trim();
    if (key.includes("••")) {
      // 原样保留，不改
    } else {
      patch.apiKey = key;
    }
  }

  return patch;
}


/** 只挑字符串字段，其余一律忽略。 */
function pickStrings(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** 请求体解析出错时用它在最外层转成 400。 */
class SettingsBodyError extends Error {}
