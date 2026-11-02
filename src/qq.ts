// ── QQ 通道：腾讯 QQ 机器人开放平台 v2 ──────────────────────────
//
// 一个联系人 = 一个 QQ BotAccount：凭据按联系人隔离，每个账号拥有独立
// token、网关与重连状态。QQ 私聊并入联系人主会话；每个 QQ 群单独一段
// Conversation，群 openid 只在所属 BotAccount 下解释。

import { createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { db, kvGet, kvSet } from "./db.ts";
import { getChannel } from "./channels/types.ts";
import { getContact } from "./contacts.ts";
import { logModelCall } from "./logs.ts";
import { asText, chunkSegments, CredentialCache, deliverOutbound, deliveryAllowed, redact, SeenKeys, SingleFlight, withRaw } from "./channels/delivery.ts";
import { adoptGroupConversation, ensureConversation, ensureLocalConversation, findAdoptableGroupConversation, getConversation, listConversations, setConversationMembership, type Conversation, type QQGroupTriggerMode } from "./conversations.ts";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, readMedia, saveAudio, saveImage, saveVideo, sniffImageMime } from "./media.ts";
import { needsStaticVariant, staticFrameOf } from "./renditions.ts";
import type { MessageAttachmentMeta } from "../shared/api.ts";
import { config } from "./config.ts";
import { createQQOneBotService } from "./qq-onebot.ts";
import { captureInboundEmote, renderEmote, type EmoteSendResult, type QqEmoteIntent } from "./qq-emote.ts";

const KV_ACCOUNTS = "qq.accounts.v2";
const LEGACY_KV_CREDENTIALS = "qq.credentials";
const LEGACY_KV_BINDINGS = "qq.bindings";
const API_ORIGIN = "https://api.bot.qq.com";

const PLATFORM_ORIGIN = "https://q.qq.com";
const QR_NONE = 0;
const QR_COMPLETED = 2;
const QR_EXPIRED = 3;
const INTENT_GROUP_C2C = 1 << 25;
const TEXT_UNITS = 4000;
/** 官方富媒体本地上传只有两条路（rich-media 文档）：URL 上传（需公网可访问）和分片上传（upload_prepare → 分片 PUT → part_finish → 合并）。
 *  本地 /media 文件不在公网，一律走分片路径；<5MB 的单分片也照走这套，官方不认 base64 直传字段。 */
/** 分片预上传 md5_10m 校验：官方规定取文件前 10002432 字节（约 9.54MB）的 MD5。 */
const QQ_MD5_10M_BYTES = 10_002_432;

/**
 * 出站媒体引用：一个本地 /media 路径 + 可选展示名。
 * 调用方（proactive / agent）只认 /media URL；label 影响上传时的 file_name。
 */
export type QqMediaRef = { url: string; label?: string };

/** 一组媒体投递的回执：send_emote 等调用方要靠它如实回报，不能再"吞了错误还报成功"。 */
export type MediaOutcome = { sent: number; failed: number; lastError: string };
const ACCOUNT_CAP = 40;
const SEEN_LIMIT = 160;
const BIND_TTL_MS = 10 * 60_000;
const REPLY_WINDOW_MS = 60 * 60_000;
const TOKEN_SKEW_MS = 60_000;
/**
 * 平台判定"AccessToken 无效/过期"的错误码：命中时缓存里的旧 token 可能已提前作废
 * （AppSecret 在开放平台被重置、平台侧轮转），必须强制重取再试，不能傻用旧值到 TTL。
 */
const AUTH_FAIL_CODES = new Set([40034001, 40034003]);
/** getAppAccessToken 的"凭据真坏了"错误码（区分于 100001 限流与网络失败）。 */
const CRED_FAIL_CODES = new Set([100004, 100007, 100013, 100016]);
/** token 探活间隔：每 30 分钟用 AppID/Secret 直接换一次 token，主动发现"提前失效"。 */
const TOKEN_PROBE_MS = 30 * 60_000;
/**
 * 富媒体凭证（file_info）缓存的有效期口径。平台在 /files 响应里回 `ttl`（秒，0=可长期使用），
 * 所以有效期照它算，不自己猜：
 *   - 有 ttl → ttl 减掉一个提前作废的余量，避免卡在边界上发失败；
 *   - 没回 ttl（字段缺失/非数字）→ 保守按 6 小时；
 *   - ttl=0（官方语义"可长期使用"）→ 仍按天重传，防平台侧悄悄回收。
 */
const FILE_INFO_MARGIN_MS = 60_000;
const FILE_INFO_NO_TTL_MS = 6 * 3_600_000;
const FILE_INFO_LONG_LIVED_MS = 24 * 3_600_000;
/** 缓存条数上限：一张图一条，200 条足够盖住常用表情包，超了从最旧的开始丢。 */
const FILE_INFO_CACHE_MAX = 200;

/** 平台 ttl（秒）→ 缓存有效期（毫秒）。-1 表示平台没回这个字段。 */
export function fileInfoLifetimeMs(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return FILE_INFO_NO_TTL_MS;
  if (ttlSeconds === 0) return FILE_INFO_LONG_LIVED_MS;
  if (ttlSeconds < 0) return FILE_INFO_NO_TTL_MS;
  return Math.max(0, ttlSeconds * 1000 - FILE_INFO_MARGIN_MS);
}
const RECONNECT_STEPS_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 90_000];
const BIND_PHRASE = "绑定";

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10 } as const;

export type QQStatus = "connected" | "connecting" | "disabled" | "attention" | "not-configured";
export type QQConversationView = { id: string; kind: "private" | "group"; title: string; titleSource: "auto" | "custom"; externalId: string; enabled: boolean; groupProactive: boolean; triggerMode: QQGroupTriggerMode; triggerKeywords: string; leftAt: number | null; messageCount: number; lastMessageAt: string };
export type QQBindingView = {
  id: string; contactId: string; userOpenId: string; enabled: boolean; proactive: boolean;
  /** 是否已认领到真实 openid。凭据配好但没绑定时为 false——UI 据此显示「去绑定」入口。 */
  hasUserOpenId: boolean;
  status: QQStatus; hasReplyWindow: boolean; lastError: string; lastReceivedAt: string;
  lastSentAt: string; createdAt: string; conversations: QQConversationView[];
};
type StoredAccount = {
  id: string; contactId: string; appId: string; clientSecret: string; enabled: boolean; proactive: boolean;
  userOpenId: string; recentMessageIds: string[]; replyMessageId: string; replyMessageAt: number;
  lastError: string; lastReceivedAt: string; lastSentAt: string; createdAt: string;
};
type BindWindow = { id: string; contactId: string; expiresAt: number; status: "open" | "claimed"; error: string };
type QQSocket = {
  send(data: string): void; close(): void;
  addEventListener?: (type: string, handler: (event?: { data?: unknown; code?: number }) => void) => void;
  onOpen?: (handler: () => void) => void; onMessage?: (handler: (raw: string) => void) => void;
  onClose?: (handler: (code: number) => void) => void; onError?: (handler: (message: string) => void) => void;
};

export function splitQqText(value: string | string[]): string[] { return chunkSegments(value, TEXT_UNITS); }
const shortId = (): string => randomUUID().slice(0, 10);

/**
 * 消息场景里的 ext 是 `key=value` 的字符串数组（msg_idx / ref_msg_idx / auth_token），
 * 不是对象——按对象读会永远拿到空。重复投递的判定与「引用了哪条」都靠它。
 */
function sceneExt(message: Record<string, unknown>): Map<string, string> {
  const scene = (message.message_scene ?? {}) as Record<string, unknown>;
  const out = new Map<string, string>();
  for (const item of Array.isArray(scene.ext) ? scene.ext : []) {
    const pair = asText(item); const eq = pair.indexOf("=");
    if (eq > 0) out.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return out;
}

/** 入站附件按 content_type 前缀分到媒体大类；识别不出的（文档等）返回空串。 */
function inboundKindOf(contentType: string): "image" | "audio" | "video" | "" {
  const t = contentType.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  return "";
}

type InboundMedia = { file: Record<string, unknown>; kind: "image" | "audio" | "video" };

/** 收进来的全部媒体附件（图/音/视频）。文档类暂不落库（媒体库没有通用文件白名单）。 */
function inboundMediaFiles(message: Record<string, unknown>): InboundMedia[] {
  const out: InboundMedia[] = [];
  for (const item of (Array.isArray(message.attachments) ? message.attachments : [])) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const kind = inboundKindOf(asText(record.content_type));
    if (kind === "" || asText(record.url) === "") continue;
    out.push({ file: record, kind });
  }
  return out;
}

/**
 * 平台把 @ 从正文里剥掉了，被 @ 的昵称只剩在 mentions[] 里——不补回正文，
 * 模型看到的「就是 他呀」就丢了「在跟谁说话」。bot 自己不在 mentions 里，仍再挡一次。
 */
function withMentions(text: string, message: Record<string, unknown>): string {
  const names: string[] = [];
  for (const item of Array.isArray(message.mentions) ? message.mentions : []) {
    if (item === null || typeof item !== "object") continue;
    const user = item as Record<string, unknown>;
    if (user.bot === true) continue;
    const name = asText(user.username ?? user.member_name ?? user.nickname);
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return text;
  const prefix = names.map((name) => `@${name}`).join(" ");
  return text === "" ? prefix : `${prefix} ${text}`;
}

function parseAccounts(raw: string | null): StoredAccount[] {
  if (raw === null || raw === "") return [];
  let parsed: { accounts?: unknown } | null = null;
  try { parsed = JSON.parse(raw) as { accounts?: unknown }; }
  catch { console.warn("[qq] 账号表不是合法 JSON，已当作没有账号"); return []; }
  const list = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  const out: StoredAccount[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = asText(row.id); const contactId = asText(row.contactId); const appId = asText(row.appId);
    if (id === "" || contactId === "" || appId === "") continue;
    out.push({
      id, contactId, appId, clientSecret: asText(row.clientSecret),
      enabled: row.enabled !== false, proactive: row.proactive === true,
      userOpenId: asText(row.userOpenId),
      recentMessageIds: (Array.isArray(row.recentMessageIds) ? row.recentMessageIds : []).map((key) => asText(key)).filter((key) => key !== "").slice(-SEEN_LIMIT),
      replyMessageId: asText(row.replyMessageId), replyMessageAt: Number(row.replyMessageAt ?? 0) || 0,
      lastError: asText(row.lastError), lastReceivedAt: asText(row.lastReceivedAt), lastSentAt: asText(row.lastSentAt),
      createdAt: asText(row.createdAt),
    });
  }
  return out.slice(-ACCOUNT_CAP);
}

function parseLegacy(): StoredAccount[] {
  let creds = { appId: "", clientSecret: "", enabled: false };
  try {
    const raw = kvGet(LEGACY_KV_CREDENTIALS);
    if (raw) { const parsed = JSON.parse(raw) as Record<string, unknown>; creds = { appId: asText(parsed.appId), clientSecret: asText(parsed.clientSecret), enabled: parsed.enabled === true }; }
  } catch { /* 坏凭据按未配置 */ }
  if (creds.appId === "" || creds.clientSecret === "") return [];
  let bindings: Array<Record<string, unknown>> = [];
  try {
    const raw = kvGet(LEGACY_KV_BINDINGS); const parsed = raw ? JSON.parse(raw) as { bindings?: unknown } : null;
    bindings = Array.isArray(parsed?.bindings) ? parsed.bindings as Array<Record<string, unknown>> : [];
  } catch { /* 坏绑定按空 */ }
  const contacts = bindings.length > 0 ? bindings : [{ contactId: "default" }];
  return contacts.map((row) => ({
    id: shortId(), contactId: asText(row.contactId) || "default", appId: creds.appId, clientSecret: creds.clientSecret,
    enabled: creds.enabled && row.enabled !== false, proactive: row.proactive === true, userOpenId: asText(row.userOpenId),
    recentMessageIds: Array.isArray(row.recentMessageIds) ? row.recentMessageIds.map(asText).filter(Boolean).slice(-SEEN_LIMIT) : [],
    replyMessageId: asText(row.replyMessageId), replyMessageAt: Number(row.replyMessageAt ?? 0) || 0,
    lastError: asText(row.lastError), lastReceivedAt: asText(row.lastReceivedAt), lastSentAt: asText(row.lastSentAt),
    createdAt: asText(row.createdAt) || new Date().toISOString(),
  }));
}

class Gateway {
  private readonly fetchImpl: typeof fetch;
  private readonly makeSocket: (url: string) => QQSocket;
  private readonly authHeader: () => Promise<string>;
  private readonly onEvent: (type: string, data: Record<string, unknown>) => void;
  private readonly onProblem: (error: unknown) => void;
  private readonly allowed: () => boolean;
  private readonly stopped: () => boolean;
  private socket: QQSocket | null = null;
  private session = "";
  private seq = 0;
  private generation = 0;
  private failures = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  phase: QQStatus = "not-configured";

  constructor(options: {
    fetchImpl: typeof fetch; makeSocket: (url: string) => QQSocket; authHeader: () => Promise<string>;
    onEvent: (type: string, data: Record<string, unknown>) => void; onProblem: (error: unknown) => void;
    allowed: () => boolean; stopped: () => boolean;
  }) {
    this.fetchImpl = options.fetchImpl; this.makeSocket = options.makeSocket; this.authHeader = options.authHeader;
    this.onEvent = options.onEvent; this.onProblem = options.onProblem; this.allowed = options.allowed; this.stopped = options.stopped;
  }

  async open(): Promise<void> {
    if (this.stopped() || this.socket !== null) return;
    if (!this.allowed()) { this.phase = "not-configured"; return; }
    this.phase = "connecting";
    const generation = this.generation + 1; this.generation = generation;
    let socket: QQSocket;
    try {
      const info = await this.discoverGateway(); const url = asText(info.url);
      if (!/^wss?:\/\//i.test(url)) throw new Error("QQ 没有返回可用的网关地址");
      socket = this.makeSocket(url);
    } catch (error) { this.socket = null; this.onProblem(error); this.retryLater(); return; }
    if (this.stopped() || this.generation !== generation) { try { socket.close(); } catch { /* 已断 */ } return; }
    this.socket = socket; this.listen(socket, generation);
  }

  close(): void {
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { this.socket?.close(); } catch { /* 已断 */ }
    this.socket = null; this.stopHeartbeat();
  }

  evacuate(): void {
    const wasLive = this.phase === "connected" || this.phase === "connecting";
    this.close();
    if (wasLive) this.phase = this.allowed() ? "attention" : "not-configured";
  }

  forget(): void { this.session = ""; this.seq = 0; this.failures = 0; this.generation += 1; }

  private async discoverGateway(): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${API_ORIGIN}/gateway`, { headers: { authorization: `QQBot ${await this.authHeader()}`, "content-type": "application/json" } });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = Number(data.code ?? 0);
    if (!response.ok || (Number.isFinite(code) && code !== 0)) throw new Error(asText(data.message) || `HTTP ${response.status}`);
    return data;
  }

  private stopHeartbeat(): void { if (this.heartbeat !== null) { clearInterval(this.heartbeat); this.heartbeat = null; } }

  private retryLater(overrideMs?: number): void {
    if (this.stopped() || this.retryTimer !== null) return;
    const step = RECONNECT_STEPS_MS[Math.min(this.failures, RECONNECT_STEPS_MS.length - 1)] ?? 60_000;
    const delay = overrideMs ?? step; this.failures += 1;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.open(); }, delay);
    this.retryTimer.unref?.();
  }

  private write(socket: QQSocket | null, frame: Record<string, unknown>): void {
    if (socket === null) return;
    try { socket.send(JSON.stringify(frame)); } catch { /* 断了由 onClose 接手 */ }
  }

  private listen(socket: QQSocket, generation: number): void {
    const onMessage = (raw: string): void => {
      if (this.generation !== generation || this.socket !== socket) return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      this.onFrame(socket, frame);
    };
    const onClose = (code: number): void => {
      if (this.generation !== generation) return;
      this.socket = null; this.stopHeartbeat();
      if (this.stopped() || !this.allowed()) return;
      if (code === 4914) { this.phase = "attention"; this.onProblem(new Error("QQ 机器人现在只能连沙箱环境：请到开放平台检查发布状态")); return; }
      if (code === 4915) { this.phase = "attention"; this.onProblem(new Error("QQ 机器人被平台限制，暂时连不上")); return; }
      if (code === 4004) this.onProblem(new Error("QQ 拒绝了这次登录凭证，正在重取"));
      this.phase = "attention"; this.retryLater(code === 4008 ? 60_000 : undefined);
    };
    const onError = (message: string): void => { if (this.generation === generation) this.onProblem(new Error(message)); };
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("message", (event) => onMessage(String(event?.data ?? "")));
      socket.addEventListener("close", (event) => onClose(Number(event?.code ?? 0)));
      socket.addEventListener("error", () => onError("QQ 网关连接异常")); return;
    }
    socket.onMessage?.((raw) => onMessage(raw)); socket.onClose?.((code) => onClose(code)); socket.onError?.((message) => onError(message));
  }

  private onFrame(socket: QQSocket, frame: Record<string, unknown>): void {
    const seq = Number(frame.s); if (Number.isSafeInteger(seq) && seq >= 0) this.seq = seq;
    switch (Number(frame.op)) {
      case OP.HELLO: {
        const data = (frame.d ?? {}) as Record<string, unknown>; const interval = Number(data.heartbeat_interval);
        this.stopHeartbeat();
        if (Number.isFinite(interval) && interval >= 1000) {
          this.heartbeat = setInterval(() => this.write(socket, { op: OP.HEARTBEAT, d: this.seq }), interval); this.heartbeat.unref?.();
        } else this.onProblem(new Error("QQ 网关没给有效的心跳周期"));
        const resumable = this.session !== "" && Number.isSafeInteger(this.seq);
        void (async () => {
          let header = "";
          try { header = `QQBot ${await this.authHeader()}`; } catch (error) { this.onProblem(error); return; }
          if (resumable) { this.write(socket, { op: OP.RESUME, d: { token: header, session_id: this.session, seq: this.seq } }); return; }
          this.write(socket, { op: OP.IDENTIFY, d: { token: header, intents: INTENT_GROUP_C2C, shard: [0, 1], properties: { $os: "windows", $browser: "xiaomo-ai", $device: "xiaomo-ai" } } });
        })();
        return;
      }
      case OP.DISPATCH: {
        const type = asText(frame.t); const data = (frame.d ?? {}) as Record<string, unknown>;
        if (type === "READY") { this.session = asText(data.session_id); this.phase = "connected"; this.failures = 0; return; }
        if (type === "RESUMED") { this.phase = "connected"; this.failures = 0; return; }
        if (["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "GROUP_ADD_ROBOT", "GROUP_DEL_ROBOT"].includes(type)) this.onEvent(type, data);
        return;
      }
      case OP.RECONNECT: this.close(); this.retryLater(2_000); return;
      case OP.INVALID_SESSION:
        if (frame.d !== true) { this.session = ""; this.seq = 0; }
        this.close(); this.retryLater(3_000); return;
      default: return;
    }
  }
}

export function createQQService(deps: { fetchImpl?: typeof fetch; now?: () => number; socketFactory?: (url: string) => QQSocket } = {}) {
  const http = deps.fetchImpl ?? globalThis.fetch;
  const clock = deps.now ?? ((): number => Date.now());
  let accounts: StoredAccount[] = [];
  let hydrated = false;
  let disposed = false;
  let problem = "";
  let tokenProbeTimer: ReturnType<typeof setInterval> | null = null;
  const windows = new Map<string, BindWindow>();
  const replyCounters = new Map<string, number>();
  const qrTasks = new Map<string, { taskId: string; contactId: string; bindKey: string; expiresAt: number }>();
  const workers = new Map<string, { gateway: Gateway; token: SingleFlight<string> }>();
  /** 每个账号最近一次"取访问凭证失败"的明确原因（区分凭据真坏 / 临时不可用）。探活据此升级状态。 */
  const credentialFaults = new Map<string, string>();

  const persist = (): void => kvSet(KV_ACCOUNTS, JSON.stringify({ version: 2, accounts }));
  const hydrate = (): void => {
    if (hydrated) return;
    accounts = parseAccounts(kvGet(KV_ACCOUNTS));
    if (accounts.length === 0) { accounts = parseLegacy(); if (accounts.length > 0) persist(); }
    hydrated = true;
  };
  const byContact = (contactId: string): StoredAccount | null => { hydrate(); return accounts.find((a) => a.contactId === contactId) ?? null; };
  const byId = (id: string): StoredAccount | null => { hydrate(); return accounts.find((a) => a.id === id) ?? null; };
  const hasCredentials = (account: StoredAccount | null): boolean => account !== null && account.appId !== "" && account.clientSecret !== "";
  const configured = (account: StoredAccount | null): boolean => hasCredentials(account) && account!.enabled;

  const explain = (code: number, message: string): string => {
    const tail = message === "" ? "" : ` · ${message}`;
    if (code === 40120031 || code === 40120032) return `这条发不出去：主动消息需要平台权限（${code}）。请到 QQ 开放平台申请「消息能力」，或让对方先给你发一条消息、在回复窗口内送${tail}`;
    if (code === 40034008 || code === 40094014) return `这条内容被平台拦截（${code}）${tail}`;
    if (code === 40054005 || code === 40054006) return `这一轮群回复次数已达平台限制（${code}）${tail}`;
    return message === "" ? `QQ 接口返回错误 ${code}` : `QQ 接口错误 ${code}：${message}`;
  };

  const noteProblem = (account: StoredAccount, error: unknown): void => {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    if (message === "") return;
    account.lastError = message; problem = message; persist();
    console.warn(`[qq] ${account.contactId}: ${message}`);
  };

  const makeWorker = (account: StoredAccount): { gateway: Gateway; token: SingleFlight<string> } => {
    let tokenTtl = 5 * 60_000;
    const token = new SingleFlight<string>(async () => {
      const current = byId(account.id) ?? account;
      if (current.appId === "" || current.clientSecret === "") throw new Error("还没填 QQ 机器人的 AppID 与 AppSecret");
      const started = Date.now();
      const response = await http(`${API_ORIGIN}/app/getAppAccessToken`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: current.appId, clientSecret: current.clientSecret }) });
      const rawBody = await response.text().catch(() => "");
      let data: Record<string, unknown> | null = null;
      try { data = rawBody === "" ? null : JSON.parse(rawBody) as Record<string, unknown>; } catch { /* 非 JSON 报文走下面的空判 */ }
      const value = asText(data?.access_token); const expiresIn = Number(data?.expires_in);
      if (value === "" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        const code = Number(data?.code ?? 0);
        // 区分「凭据真坏了」与「临时不可用」：前者是平台明确判死（secret 不对 / 机器人没了 / 被封），
        // 探活要靠它把状态升级为"需要重扫"；后者（限流、网络抖动）重试就好，不该惊动用户。
        const transient = code === 100001 || response.status >= 500;
        const message = asText(data?.message) || (transient ? `HTTP ${response.status}` : "换不到访问凭证");
        logModelCall({ purpose: "qq", ok: false, code: "QQ_TOKEN", model: "qqbot", url: "/app/getAppAccessToken", elapsedMs: Date.now() - started, message: message.slice(0, 300), resRaw: rawBody.slice(0, 2000), contactId: current.contactId });
        if (!transient) credentialFaults.set(current.id, message.slice(0, 200)); else credentialFaults.delete(current.id);
        throw new Error((transient ? "取访问凭证失败（临时）：" : "换不到访问凭证：") + message);
      }
      credentialFaults.delete(current.id);
      logModelCall({ purpose: "qq", ok: true, model: "qqbot", url: "/app/getAppAccessToken", elapsedMs: Date.now() - started, contactId: current.contactId });
      tokenTtl = Math.max(30_000, expiresIn * 1000 - TOKEN_SKEW_MS); return value;
    }, () => tokenTtl, clock);
    const gateway = new Gateway({
      fetchImpl: http,
      makeSocket: (url) => deps.socketFactory !== undefined ? deps.socketFactory(url) : new WebSocket(url) as unknown as QQSocket,
      authHeader: () => token.get(),
      onEvent: (type, data) => { void acceptEvent(account.id, type, data).catch((error) => noteProblem(account, error)); },
      onProblem: (error) => {
        noteProblem(account, error);
        const worker = workers.get(account.id);
        if (worker !== undefined) worker.gateway.phase = "attention";
      },
      allowed: () => configured(byId(account.id)),
      stopped: () => disposed,
    });
    return { gateway, token };
  };

  const getWorker = (account: StoredAccount): { gateway: Gateway; token: SingleFlight<string> } => {
    const existing = workers.get(account.id); if (existing) return existing;
    const made = makeWorker(account); workers.set(account.id, made); return made;
  };

  const statusOf = (account: StoredAccount | null): QQStatus => {
    if (account === null || account.appId === "" || account.clientSecret === "") return "not-configured";
    if (!account.enabled) return "disabled";
    // 凭据被平台判死（secret 重置/机器人失效）时，即使网关还连得上也必须显式暴露——
    // 这是"token 过期了但界面看不出"那次事故的直接解法。
    if (credentialFaults.has(account.id)) return "attention";
    return getWorker(account).gateway.phase;
  };
  const gatewayStatus = (contactId?: string): QQStatus => {
    hydrate();
    if (contactId !== undefined) return statusOf(byContact(contactId));
    const live = accounts.find((a) => configured(a));
    if (live) return statusOf(live);
    const known = accounts.find((a) => hasCredentials(a));
    return known ? statusOf(known) : "not-configured";
  };

  const callApi = async (account: StoredAccount, path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> => {
    const worker = getWorker(account);
    // 一次调用：取 token → 打 API → 归一化成 {code, message, data, failed}。
    const callOnce = async (): Promise<{ code: number; message: string; data: Record<string, unknown>; failed: boolean; raw: string }> => {
      const started = Date.now(); const header = await worker.token.get();
      const response = await http(API_ORIGIN + path, { method: init.method ?? "GET", headers: { authorization: `QQBot ${header}`, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      // 先取原文再解析：失败时把服务商原始报文留给日志（res_full），详情弹窗才有东西可看。
      const rawBody = await response.text().catch(() => "");
      let data: Record<string, unknown> = {};
      try { data = rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>; } catch { /* 非 JSON 报文原样进日志 */ }
      const code = Number(data.code ?? 0);
      if (!response.ok || (Number.isFinite(code) && code !== 0)) {
        const message = asText(data.message) || `HTTP ${response.status}`;
        logModelCall({ purpose: "qq", ok: false, code: "QQ_API_" + String(code), model: "qqbot", url: path, elapsedMs: Date.now() - started, message: message.slice(0, 300), resRaw: rawBody.slice(0, 2000), contactId: account.contactId });
        return { code, message, data, failed: true, raw: rawBody.slice(0, 2000) };
      }
      logModelCall({ purpose: "qq", ok: true, model: "qqbot", url: path, elapsedMs: Date.now() - started, contactId: account.contactId });
      return { code, message: "", data, failed: false, raw: "" };
    };
    let result = await callOnce();
    // token 被平台提前作废（AppSecret 在开放平台被重置 / 平台侧轮转）时，缓存里的旧 token 可能
    // 已无效——命中鉴权失效码就强制重取一次再试，别傻用旧值到 TTL 自然结束。
    if (result.failed && AUTH_FAIL_CODES.has(result.code)) {
      worker.token.invalidate();
      const retried = await callOnce();
      if (!retried.failed) return retried.data;
      noteProblem(account, new Error("强制重取凭证后仍失败：" + (retried.message === "" ? "未知" : retried.message)));
      throw withRaw(new Error(explain(retried.code, retried.message)), retried.raw);
    }
    if (result.failed) {
      noteProblem(account, new Error(explain(result.code, result.message)));
      throw withRaw(new Error(explain(result.code, result.message)), result.raw);
    }
    return result.data;
  };

  /**
   * 收进来的图先落到本地媒体库：视觉通道只认 /media 路径，而 QQ 的 CDN 地址过期很快，
   * 不能留到看图时再抓。抓不动的一张就跳过（只记日志），别让一张坏图吞掉整条消息。
   */
  /**
   * 收进来的媒体先落到本地媒体库：视觉/听觉通道只认 /media 路径，而 QQ 的 CDN 地址
   * 过期很快，不能留到看时再抓。一张/一段坏媒体就跳过（只记日志），别让它吞掉整条消息。
   * 文档类附件暂不落库（媒体库没有通用文件白名单）。
   */
  const saveInboundMedia = async (
    account: StoredAccount,
    message: Record<string, unknown>,
  ): Promise<{ urls: string[]; meta: MessageAttachmentMeta[] }> => {
    const urls: string[] = []; const meta: MessageAttachmentMeta[] = [];
    const limitOf = (kind: InboundMedia["kind"]): number =>
      kind === "video" ? MAX_VIDEO_BYTES : kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
    for (const entry of inboundMediaFiles(message)) {
      const target = asText(entry.file.url); const started = Date.now();
      const limit = limitOf(entry.kind);
      try {
        if (!/^https?:\/\//i.test(target)) throw new Error("附件地址不是 http(s)");
        const declared = Number(entry.file.size ?? 0);
        if (Number.isFinite(declared) && declared > limit) throw new Error(`媒体超过 ${limit / (1024 * 1024)}MB，已跳过`);
        const response = await http(target);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(length) && length > limit) throw new Error(`媒体超过 ${limit / (1024 * 1024)}MB，已跳过`);
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length === 0) throw new Error("附件内容为空");
        let savedUrl: string; let savedMime: string;
        if (entry.kind === "image") {
          const mime = sniffImageMime(body);
          if (mime === "") throw new Error("图片魔数无法识别");
          savedUrl = saveImage(body, mime).url; savedMime = mime;
          // 表情系统自动采集：开关开着就把他发来的图顺手登记成素材（关则 no-op）。
          captureInboundEmote(savedUrl);
        } else if (entry.kind === "audio") {
          const saved = saveAudio(body); savedUrl = saved.url; savedMime = saved.mime;
        } else {
          const saved = saveVideo(body); savedUrl = saved.url; savedMime = saved.mime;
        }
        urls.push(savedUrl);
        meta.push({ url: savedUrl, kind: entry.kind, mime: savedMime });
      } catch (error) {
        logModelCall({
          purpose: "qq", ok: false, code: "QQ_MEDIA", model: "qqbot", url: "/qq/inbound-" + entry.kind,
          elapsedMs: Date.now() - started, message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          contactId: account.contactId,
        });
      }
    }
    return { urls, meta };
  };

  const nextSeq = (key: string): number => { const used = replyCounters.get(key) ?? 0; const next = used >= 65_535 ? 1 : used + 1; replyCounters.set(key, next); return next; };
  const sendPrivate = async (account: StoredAccount, content: string, msgId = ""): Promise<void> => {
    if (account.userOpenId === "") throw new Error("这位联系人还没绑到 QQ openid");
    const body: Record<string, unknown> = { msg_type: 0, content };
    if (msgId !== "") { body.msg_id = msgId; body.msg_seq = nextSeq(`${account.id}|user|${msgId}`); }
    await callApi(account, `/v2/users/${encodeURIComponent(account.userOpenId)}/messages`, { method: "POST", body });
  };
  const sendGroup = async (account: StoredAccount, groupOpenId: string, content: string, msgId: string): Promise<void> => {
    if (groupOpenId === "") throw new Error("群 openid 为空");
    const body: Record<string, unknown> = { msg_type: 0, content };
    if (msgId !== "") { body.msg_id = msgId; body.msg_seq = nextSeq(`${account.id}|group|${groupOpenId}|${msgId}`); }
    await callApi(account, `/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, { method: "POST", body });
  };

  /** mime/扩展 → 官方 file_type：1=图片, 2=视频, 3=语音, 4=文件。 */
  const mediaTypeOfExt = (ext: string): number => {
    switch (ext) {
      case "png": case "jpg": case "jpeg": case "gif": case "webp": case "bmp": return 1;
      case "mp4": case "webm": return 2;
      case "silk": case "mp3": case "wav": case "ogg": case "m4a": case "opus": case "weba": case "aac": return 3;
      default: return 4;
    }
  };

  /** 上传文件名：label 自带扩展名就用它，否则按 mime 推断补上。 */
  const mediaFileNameOf = (ref: QqMediaRef, ext: string): string => {
    const label = ref.label?.trim() ?? "";
    if (label !== "" && label.includes(".")) return label;
    if (label !== "") return label + (ext !== "" ? `.${ext}` : "");
    return ext !== "" ? `xiaomo.${ext}` : "xiaomo.file";
  };

  /**
   * file_info 缓存（有界、带有效期）。同一张梗图往往被反复甩，而每次上传要跑满四次往返，
   * 其中一次还是直传腾讯 COS——业内（TG file_id / WA media_id / 微信 media_id）统一是
   * 「按内容缓存平台侧凭证，到期前复用」。
   * 键必须带场景：官方语义里 file_info 不能跨私聊/群复用，混用就是拿错凭证。
   */
  const fileInfoCache = new CredentialCache<string>(FILE_INFO_CACHE_MAX, clock);
  const fileInfoKey = (account: StoredAccount, target: "private" | "group", targetId: string, md5: string): string =>
    `${account.id}|${target}|${targetId}|${md5}`;

  /**
   * 把本地 /media 文件上传到官方富媒体端点，拿回 file_info。
   * targetId 是「发到哪」的 openid（私聊=userOpenId，群=groupOpenId）——上传与发送必须同场景，
   * file_info 不能跨场景复用，所以这里一并带上。本地文件一律走分片上传（小文件只是单分片）。
   */
  const uploadMedia = async (
    account: StoredAccount,
    target: "private" | "group",
    targetId: string,
    ref: QqMediaRef,
  ): Promise<{ fileInfo: string; cacheKey: string; fromCache: boolean }> => {
    const idPath = target === "private" ? encodeURIComponent(account.userOpenId) : encodeURIComponent(targetId);
    // 官方富媒体接口挂在 /v2 下（/v2/users/{openid}/upload_prepare|files）——
    // 少了这段前缀平台会回 11001「不支持的调用」，与文字消息的 /v2/users/.../messages 同一版式。
    const prefix = target === "private" ? "v2/users" : "v2/groups";
    // 官方富媒体只认 png/jpg，GIF 会吃 850019。这里把动图换成它的派生静帧再上传——
    // 不是在选素材时躲动图：库里全是动图也必须发得出去。派生不出来就按原样发，
    // 让平台的错误如实浮出来，而不是我们静默换一张别的图。
    const sendUrl = needsStaticVariant(ref.url) ? (await staticFrameOf(ref.url) ?? ref.url) : ref.url;
    const file = readMedia(sendUrl);
    if (file === null) throw new Error("本地媒体文件读不到，无法上传到 QQ：" + sendUrl);
    const { buffer, mime } = file;
    const ext = sendUrl.split(".").pop()?.toLowerCase() ?? "";
    const fileType = mediaTypeOfExt(ext);
    const nameWithExt = mediaFileNameOf(ref, ext);
    const wholeMd5 = createHash("md5").update(buffer).digest("hex");
    const cacheKey = fileInfoKey(account, target, targetId, wholeMd5);
    const cached = fileInfoCache.get(cacheKey);
    if (cached !== undefined) return { fileInfo: cached, cacheKey, fromCache: true };

    // 本地文件一律走分片上传（官方 rich-media 文档不认 base64 直传字段；
    // 小文件 <5MB 只是单分片，流程与大图相同——upload_prepare 返回 parts，
    // 1 个 part 也照样 PUT + part_finish + 合并）。
    const started = clock();
    const wholeSha1 = createHash("sha1").update(buffer).digest("hex");
    const md510m = createHash("md5").update(buffer.subarray(0, QQ_MD5_10M_BYTES)).digest("hex");
    const prep = await callApi(account, `/${prefix}/${idPath}/upload_prepare`, {
      method: "POST",
      body: {
        file_type: fileType, file_size: String(buffer.length), file_name: nameWithExt,
        md5: wholeMd5, sha1: wholeSha1, md5_10m: md510m,
      },
    });
    const uploadId = asText(prep.upload_id);
    if (uploadId === "") throw new Error("分片预上传没拿到 upload_id");
    const blockSize = Number(asText(prep.block_size) || String(5 * 1024 * 1024));
    const parts = Array.isArray(prep.parts) ? (prep.parts as Array<Record<string, unknown>>) : [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part === null || part === undefined) continue;
      const index = Number(asText(part.index) || String(i));
      const presigned = asText(part.presigned_url);
      if (presigned === "") throw new Error("分片 " + index + " 缺预签名 URL");
      const sizeOf = part.block_size !== undefined ? Number(part.block_size) : blockSize;
      // 末片可能小于 blockSize；按文件实际剩余长度收口，多出的字节不传。
      const chunkStart = index * blockSize;
      const chunkLen = index === parts.length - 1 ? buffer.length - chunkStart : sizeOf;
      const chunkBuf = buffer.subarray(chunkStart, chunkStart + chunkLen);
      // PUT 分片到预签名 COS URL（腾讯 COS 直传，不走鉴权头）。
      const putResp = await http(presigned, { method: "PUT", headers: { "content-type": mime }, body: Buffer.from(chunkBuf) });
      if (!putResp.ok) throw new Error("分片 " + index + " PUT 失败：HTTP " + putResp.status);
      await callApi(account, `/${prefix}/${idPath}/upload_part_finish`, {
        method: "POST",
        body: {
          upload_id: uploadId, part_index: index, block_size: String(sizeOf),
          md5: createHash("md5").update(chunkBuf).digest("hex"),
        },
      });
    }
    // 合并
    const merged = await callApi(account, `/${prefix}/${idPath}/files`, {
      method: "POST",
      body: { file_type: fileType, file_name: nameWithExt, upload_id: uploadId, srv_send_msg: false },
    });
    const fileInfo = asText(merged.file_info);
    if (fileInfo === "") throw new Error("分片合并成功但没返回 file_info");
    // 有效期照平台回的 ttl 算（秒，0=可长期使用）；没回这个字段时按保守值，不当成长期有效。
    const ttlRaw = merged.ttl;
    const ttlSeconds = ttlRaw === undefined || ttlRaw === null || asText(ttlRaw) === "" ? -1 : Number(asText(ttlRaw));
    fileInfoCache.set(cacheKey, fileInfo, fileInfoLifetimeMs(ttlSeconds));
    logModelCall({ purpose: "qq", ok: true, model: "qqbot", url: `/${prefix}/{id}/files`, elapsedMs: clock() - started, contactId: account.contactId });
    return { fileInfo, cacheKey, fromCache: false };
  };

  /** 发一条富媒体消息（msg_type=7 + media.file_info）。 */
  const sendMedia = async (
    account: StoredAccount,
    target: "private" | "group",
    targetId: string,
    ref: QqMediaRef,
    msgId: string,
  ): Promise<void> => {
    const post = async (fileInfo: string): Promise<void> => {
      const idPath = target === "private" ? encodeURIComponent(account.userOpenId) : encodeURIComponent(targetId);
      const prefix = target === "private" ? "v2/users" : "v2/groups";
      const body: Record<string, unknown> = { msg_type: 7, media: { file_info: fileInfo } };
      // msg_seq 每次尝试都重新取号：重发不能复用同一个序号，否则平台按重复消息丢掉。
      if (msgId !== "") { body.msg_id = msgId; body.msg_seq = nextSeq(`${account.id}|${target}|${targetId}|${msgId}`); }
      await callApi(account, `/${prefix}/${idPath}/messages`, { method: "POST", body });
    };
    const uploaded = await uploadMedia(account, target, targetId, ref);
    if (!uploaded.fromCache) { await post(uploaded.fileInfo); return; }
    // 凭证是从缓存拿的：平台可能已经回收了它。失败就作废重传一次，别把「缓存过期」误报成「这张图发不出去」。
    // 刚上传完就失败的不重试——那是格式(850019)/配额(40093002)类硬失败，重传只会再烧一次上传。
    try {
      await post(uploaded.fileInfo);
    } catch {
      fileInfoCache.invalidate(uploaded.cacheKey);
      const fresh = await uploadMedia(account, target, targetId, ref);
      await post(fresh.fileInfo);
    }
  };

  /** 把文字 + 一组本地媒体投到私聊。媒体逐个发，单个失败不吞掉后面的。 */
  const deliverMediaToContact = async (
    contactId: string,
    text: string | string[],
    media: QqMediaRef[],
    opts: { proactive?: boolean } = {},
  ): Promise<MediaOutcome> => {
    const outcome: MediaOutcome = { sent: 0, failed: 0, lastError: "" };
    const account = byContact(contactId);
    if (account === null || !configured(account) || !deliveryAllowed(account, opts.proactive === true)) return outcome;
    if (text !== "") {
      const inWindow = account.replyMessageId !== "" && clock() - account.replyMessageAt < REPLY_WINDOW_MS;
      await deliver(account, text, { proactive: opts.proactive === true, msgId: inWindow ? account.replyMessageId : "" });
    }
    const refMsgId = text !== "" ? account.replyMessageId : "";
    for (const ref of media) {
      try {
        await sendMedia(account, "private", "", ref, refMsgId);
        account.lastSentAt = new Date(clock()).toISOString(); account.lastError = ""; persist();
        outcome.sent += 1;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        account.lastError = message; persist();
        outcome.failed += 1; outcome.lastError = message;
        console.warn(`[qq] 媒体投递失败（${contactId}）：${message}`);
      }
    }
    return outcome;
  };

  /** 把一组本地媒体按顺序投到指定群（主动消息无 msg_id 引用）。 */
  const deliverMediaToGroup = async (
    contactId: string,
    groupConvId: string,
    text: string,
    media: QqMediaRef[],
  ): Promise<MediaOutcome> => {
    const outcome: MediaOutcome = { sent: 0, failed: 0, lastError: "" };
    const conv = getConversation(groupConvId);
    if (conv === null || conv.channel !== "qq" || conv.kind !== "group" || !conv.enabled) return outcome;
    const account = byId(conv.account_id) ?? byContact(contactId);
    if (account === null || !configured(account)) return outcome;
    if (text !== "") {
      const segments = splitQqText(text);
      if (segments.length > 0) {
        const startedAt = clock();
        await deliverOutbound({
          segments, send: (segment) => sendGroup(account, conv.external_id, segment, ""), elapsed: () => clock() - startedAt,
          onDelivered: () => { account.lastSentAt = new Date(clock()).toISOString(); account.lastError = ""; persist(); },
          onFailed: (message) => { account.lastError = message; persist(); console.warn(`[qq] 群媒体文字失败（${conv.id}）：${message}`); },
          log: (ok, message, elapsedMs, raw) => logModelCall({ purpose: "qq", ok, model: "qqbot", url: "/v2/groups/{group_openid}/messages", elapsedMs, ...(message === "" ? {} : { message }), ...(raw ? { resRaw: raw } : {}), contactId: account.contactId }),
        });
      }
    }
    for (const ref of media) {
      try {
        await sendMedia(account, "group", conv.external_id, ref, "");
        account.lastSentAt = new Date(clock()).toISOString(); account.lastError = ""; persist();
        outcome.sent += 1;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        account.lastError = message; persist();
        outcome.failed += 1; outcome.lastError = message;
        console.warn(`[qq] 群媒体投递失败（${conv.id}）：${message}`);
      }
    }
    return outcome;
  };

  /**
   * 按会话分派「文字 + 媒体」：私聊走联系人账号，群走该群 external_id。
   * 普通对话回复带图时用它闭环（之前是文字 + 一句"图发不出去"的兜底）。
   */
  const deliverMediaToConversation = async (
    conversationId: string,
    text: string,
    media: QqMediaRef[],
  ): Promise<void> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq") return;
    if (conv.kind === "group") {
      await deliverMediaToGroup(conv.contact_id, conversationId, text, media);
      return;
    }
    await deliverMediaToContact(conv.contact_id, text, media);
  };

  /**
   * 发一个表情（表情系统入口，官方渠道版）。按当前渠道把意图渲染成能落地的形态：
   *   - 图片类（image/custom）→ 走富媒体上传（官方原生支持）。
   *   - face/mface → 官方没有内置/动态表情概念，降级成 emoji 或标签文字，知情返回 native=false。
   * 按会话分派：群走群 external_id，私聊走联系人账号。
   */
  const deliverEmote = async (conversationId: string, intent: QqEmoteIntent): Promise<EmoteSendResult> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq" || !conv.enabled) {
      return { ok: false, native: false, via: "skipped", detail: "会话不可用或不是 QQ 会话" };
    }
    const render = renderEmote(intent);
    if (render.mediaRefs.length > 0) {
      // 图片类表情：只发图本身，不重复发标签文字。
      const outcome = conv.kind === "group"
        ? await deliverMediaToGroup(conv.contact_id, conversationId, "", render.mediaRefs)
        : await deliverMediaToContact(conv.contact_id, "", render.mediaRefs);
      if (outcome.sent > 0) return { ok: true, native: render.native, via: "media", detail: render.mediaRefs[0]?.url };
      // 富媒体一条没发出去：有降级文案就降级成文字发出去，回执里带上失败原因——
      // 之前这里无条件报 ok，模型被"发出去了"的回执骗着在 QQ 里说"喏，发了"，图其实没到。
      const fallback = render.fallbackText;
      if (fallback !== "") {
        if (conv.kind === "group") await deliverToConversation(conversationId, fallback);
        else await deliverToContact(conv.contact_id, fallback);
        return { ok: true, native: false, via: "text", detail: `图片没发出去（${outcome.lastError || "原因不明"}），已改发文字「${fallback}」` };
      }
      return { ok: false, native: false, via: "skipped", detail: outcome.lastError || "图片表情投递失败" };
    }
    // face/mface 官方渠道降级：能降级成文字就发文字，纯原生表情（无降级文案）则跳过。
    if (render.fallbackText !== "") {
      if (conv.kind === "group") await deliverToConversation(conversationId, render.fallbackText);
      else await deliverToContact(conv.contact_id, render.fallbackText);
      return { ok: true, native: render.native, via: "text", detail: render.fallbackText };
    }
    return { ok: false, native: false, via: "skipped", detail: "官方渠道发不了这种表情，已跳过" };
  };

  const deliver = async (account: StoredAccount | null, text: string | string[], opts: { proactive?: boolean; msgId?: string } = {}): Promise<void> => {
    if (account === null || !configured(account) || !deliveryAllowed(account, opts.proactive === true)) return;
    const segments = splitQqText(text); if (segments.length === 0) return;
    const startedAt = clock();
    await deliverOutbound({
      segments, send: (segment) => sendPrivate(account, segment, opts.msgId ?? ""), elapsed: () => clock() - startedAt,
      onDelivered: () => { account.lastSentAt = new Date(clock()).toISOString(); account.lastError = ""; persist(); },
      onFailed: (message) => { account.lastError = message; persist(); console.warn(`[qq] 投递失败（${account.contactId}）：${message}`); },
      log: (ok, message, elapsedMs, raw) => logModelCall({ purpose: "qq", ok, model: "qqbot", url: "/v2/users/{openid}/messages", elapsedMs, ...(message === "" ? {} : { message }), ...(raw ? { resRaw: raw } : {}), contactId: account.contactId }),
    });
  };

  const deliverToContact = async (contactId: string, text: string | string[], opts: { proactive?: boolean } = {}): Promise<void> => {
    const account = byContact(contactId);
    if (account === null || !configured(account) || !deliveryAllowed(account, opts.proactive === true)) return;
    const inWindow = account.replyMessageId !== "" && clock() - account.replyMessageAt < REPLY_WINDOW_MS;
    await deliver(account, text, { proactive: opts.proactive === true, msgId: inWindow ? account.replyMessageId : "" });
  };

  const deliverToConversation = async (conversationId: string, text: string | string[], opts: { triggerMessageId?: string } = {}): Promise<void> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq" || !conv.enabled) return;
    const account = byId(conv.account_id) ?? byContact(conv.contact_id);
    if (account === null || !configured(account)) return;
    if (conv.kind === "private") { await deliver(account, text, { msgId: opts.triggerMessageId || account.replyMessageId }); return; }
    const segments = splitQqText(text); if (segments.length === 0) return;
    const startedAt = clock();
    await deliverOutbound({
      segments, send: (segment) => sendGroup(account, conv.external_id, segment, opts.triggerMessageId ?? ""), elapsed: () => clock() - startedAt,
      onDelivered: () => { account.lastSentAt = new Date(clock()).toISOString(); account.lastError = ""; persist(); },
      onFailed: (message) => { account.lastError = message; persist(); console.warn(`[qq] 群投递失败（${conv.id}）：${message}`); },
      log: (ok, message, elapsedMs, raw) => logModelCall({ purpose: "qq", ok, model: "qqbot", url: "/v2/groups/{group_openid}/messages", elapsedMs, ...(message === "" ? {} : { message }), ...(raw ? { resRaw: raw } : {}), contactId: account.contactId }),
    });
  };

  const expireWindows = (): void => { for (const [id, window] of windows) if (window.expiresAt <= clock()) windows.delete(id); };
  const claimBinding = async (window: BindWindow, account: StoredAccount, openId: string, messageId: string): Promise<void> => {
    for (const other of accounts) if (other.id !== account.id && other.userOpenId === openId) other.userOpenId = "";
    account.userOpenId = openId; account.replyMessageId = messageId; account.replyMessageAt = clock();
    account.lastReceivedAt = new Date(clock()).toISOString(); account.lastError = "";
    window.status = "claimed"; persist();
    ensureLocalConversation(account.contactId);
    try { await sendPrivate(account, "已连接到这位联系人。之后你发给我的消息都会进这段私聊。", messageId); }
    catch (error) { account.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300); persist(); }
  };

  const receivePrivate = async (account: StoredAccount, message: Record<string, unknown>): Promise<void> => {
    const author = (message.author ?? {}) as Record<string, unknown>;
    const openId = asText(author.user_openid ?? author.id); const messageId = asText(message.id);
    if (openId === "" || messageId === "") return;
    expireWindows(); const text = asText(message.content);
    if (text === BIND_PHRASE && (account.userOpenId === "" || account.userOpenId === openId)) {
      const open = [...windows.values()].find((w) => w.contactId === account.contactId && w.expiresAt > clock());
      if (open !== undefined) { await claimBinding(open, account, openId, messageId); return; }
      try { await callApi(account, `/v2/users/${encodeURIComponent(openId)}/messages`, { method: "POST", body: { msg_type: 0, content: "这会儿没有待确认的绑定。回应用面点一下「去绑定」，再把「绑定」发我一次。", msg_id: messageId, msg_seq: 1 } }); } catch { /* ignore */ }
      return;
    }
    if (account.userOpenId !== openId || !account.enabled) return;
    // 纯媒体消息（content 为空）平台照样推，别按空正文丢掉。
    if (text === "" && inboundMediaFiles(message).length === 0) return;
    const scene = sceneExt(message);
    const key = `${account.id}|${openId}|${messageId}|${scene.get("msg_idx") ?? ""}`;
    const seen = new SeenKeys(SEEN_LIMIT, account.recentMessageIds);
    if (seen.has(key)) return;
    const media = await saveInboundMedia(account, message);
    const conv = ensureLocalConversation(account.contactId);
    account.replyMessageId = messageId; account.replyMessageAt = clock();
    account.lastReceivedAt = new Date(clock()).toISOString(); account.lastError = "";
    seen.remember(key); account.recentMessageIds = seen.toArray(); persist();
    const channel = getChannel("web"); if (channel === undefined) return;
    channel.receive(withMentions(text, message), account.contactId, media.urls.length > 0 ? media.urls : undefined, "qq", undefined, {
      conversationId: conv.id, senderId: openId, senderName: asText(author.username ?? author.nickname) || "QQ 用户",
      sourceMessageId: messageId, replyToMessageId: scene.get("ref_msg_idx"), atBot: false,
      ...(media.meta.length > 0 ? { attachmentMeta: media.meta } : {}),
    });
  };

  const receiveGroupAt = async (account: StoredAccount, message: Record<string, unknown>): Promise<void> => {
    const groupOpenId = asText(message.group_openid ?? message.group_id); const messageId = asText(message.id);
    if (groupOpenId === "" || messageId === "") return;
    if (!account.enabled) return;
    const text = asText(message.content);
    if (text === "" && inboundMediaFiles(message).length === 0) return;
    const scene = sceneExt(message);
    const key = `${account.id}|group|${groupOpenId}|${messageId}|${scene.get("msg_idx") ?? ""}`;
    const seen = new SeenKeys(SEEN_LIMIT, account.recentMessageIds); if (seen.has(key)) return;
    const author = (message.author ?? {}) as Record<string, unknown>;
    const senderId = asText(author.member_openid ?? author.id);
    const senderName = (asText(author.member_name ?? author.username ?? author.nickname) || "群成员")
      // 主人识别（官方渠道）：私聊绑定的 userOpenId 就是主人本人的 openid——同一用户在同一
      // 机器人下 openid 跨 C2C/群稳定，比对即可。没有 C2C 绑定的机器人认不出主人，不硬猜。
      + (account.userOpenId !== "" && senderId === account.userOpenId ? "（主人）" : "");
    // 渠道过户（双向）：OneBot 时期留下的同联系人群会话（数字群号命名空间）恰好一条就认领，
    // 免得切回官方后同一个群裂成两条。官方会话归属回官方账号。
    const adoptable = findAdoptableGroupConversation(account.contactId, false);
    if (adoptable !== null) adoptGroupConversation(adoptable.id, groupOpenId, account.id);
    const conv = ensureConversation({ contactId: account.contactId, channel: "qq", kind: "group", externalId: groupOpenId, accountId: account.id, title: asText(message.group_name) });
    if (conv.left_at !== null || !conv.enabled) return;
    account.lastReceivedAt = new Date(clock()).toISOString(); account.lastError = "";
    seen.remember(key); account.recentMessageIds = seen.toArray(); persist();
    const channel = getChannel("web"); if (channel === undefined) return;
    const media = await saveInboundMedia(account, message);
    channel.receive(withMentions(text, message), account.contactId, media.urls.length > 0 ? media.urls : undefined, "qq", undefined, {
      conversationId: conv.id, senderId, senderName, sourceMessageId: messageId,
      replyToMessageId: scene.get("ref_msg_idx"), atBot: true,
      ...(media.meta.length > 0 ? { attachmentMeta: media.meta } : {}),
    });
  };

  const receiveGroupLifecycle = async (account: StoredAccount, type: string, message: Record<string, unknown>): Promise<void> => {
    const groupOpenId = asText(message.group_openid ?? message.group_id); if (groupOpenId === "") return;
    const conv = ensureConversation({ contactId: account.contactId, channel: "qq", kind: "group", externalId: groupOpenId, accountId: account.id, title: asText(message.group_name) });
    setConversationMembership(conv.id, type === "GROUP_ADD_ROBOT", clock());
    account.lastReceivedAt = new Date(clock()).toISOString(); persist();
  };

  const acceptEvent = async (accountId: string, type: string, message: Record<string, unknown>): Promise<void> => {
    const account = byId(accountId); if (account === null) return;
    if (type === "C2C_MESSAGE_CREATE") { await receivePrivate(account, message); return; }
    if (type === "GROUP_AT_MESSAGE_CREATE") { await receiveGroupAt(account, message); return; }
    if (type === "GROUP_ADD_ROBOT" || type === "GROUP_DEL_ROBOT") await receiveGroupLifecycle(account, type, message);
  };

  const conversationsFor = (contactId: string): QQConversationView[] => {
    const account = byContact(contactId);
    // QQ 私聊已并入联系人主会话；这里只暴露需要独立切换的群。
    return listConversations(contactId).filter((conv) => conv.channel === "qq" && conv.kind === "group").map((conv) => ({
      id: conv.id, kind: conv.kind, title: conv.title, titleSource: conv.title_source,
      externalId: redact(conv.external_id), enabled: conv.enabled, groupProactive: conv.group_proactive, leftAt: conv.left_at,
      triggerMode: conv.trigger_mode, triggerKeywords: conv.trigger_keywords,
      messageCount: Number((db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?").get(conv.id) as { c: number }).c),
      lastMessageAt: conv.last_message_at ? new Date(conv.last_message_at).toISOString() : "",
    }));
  };

  const viewOf = (account: StoredAccount): QQBindingView => ({
    id: account.id, contactId: account.contactId, userOpenId: redact(account.userOpenId), enabled: account.enabled,
    proactive: account.proactive, hasUserOpenId: account.userOpenId !== "", status: statusOf(account),
    hasReplyWindow: account.replyMessageId !== "" && clock() - account.replyMessageAt < REPLY_WINDOW_MS,
    lastError: account.lastError, lastReceivedAt: account.lastReceivedAt, lastSentAt: account.lastSentAt,
    createdAt: account.createdAt, conversations: conversationsFor(account.contactId),
  });

  const snapshotFor = (contactId: string): { binding: QQBindingView | null; configured: boolean; status: QQStatus; conversations: QQConversationView[] } => {
    const account = byContact(contactId);
    return { binding: account === null ? null : viewOf(account), configured: hasCredentials(account), status: statusOf(account), conversations: conversationsFor(contactId) };
  };

  const setCredentials = (contactId: string, patch: { appId?: unknown; clientSecret?: unknown; enabled?: unknown }): { configured: boolean } => {
    hydrate(); if (getContact(contactId) === null) throw new Error("联系人不存在");
    let account = byContact(contactId); const oldWorker = account ? workers.get(account.id) : undefined;
    if (oldWorker) { oldWorker.gateway.close(); oldWorker.gateway.forget(); oldWorker.token.invalidate(); workers.delete(account!.id); }
    if (account === null) {
      account = { id: shortId(), contactId, appId: "", clientSecret: "", enabled: false, proactive: false, userOpenId: "", recentMessageIds: [], replyMessageId: "", replyMessageAt: 0, lastError: "", lastReceivedAt: "", lastSentAt: "", createdAt: new Date(clock()).toISOString() };
      accounts.push(account);
    }
    const nextAppId = patch.appId !== undefined ? asText(patch.appId) : account.appId;
    const nextSecret = patch.clientSecret !== undefined && !asText(patch.clientSecret).includes("••") ? asText(patch.clientSecret) : account.clientSecret;
    if (nextAppId !== account.appId) { account.userOpenId = ""; account.replyMessageId = ""; account.replyMessageAt = 0; }
    account.appId = nextAppId; account.clientSecret = nextSecret;
    account.enabled = patch.enabled !== undefined ? patch.enabled === true : account.enabled; account.lastError = "";
    credentialFaults.delete(account.id); // 换了凭据：旧的探活故障作废，交给下一轮探活重新判
    if (accounts.length > ACCOUNT_CAP) accounts = accounts.slice(-ACCOUNT_CAP);
    persist(); if (configured(account) && account.enabled) void getWorker(account).gateway.open();
    return { configured: hasCredentials(account) };
  };

  const beginBind = (contactId: string): { attemptId: string; keyword: string; expiresInMs: number } => {
    hydrate(); if (getContact(contactId) === null) throw new Error("联系人不存在");
    const account = byContact(contactId);
    if (account === null || !configured(account)) throw new Error("先为这位联系人填好 QQ 机器人的 AppID 与 AppSecret，并勾上启用");
    for (const [id, window] of windows) if (window.contactId === contactId) windows.delete(id);
    const window: BindWindow = { id: shortId(), contactId, expiresAt: clock() + BIND_TTL_MS, status: "open", error: "" };
    windows.set(window.id, window);
    return { attemptId: window.id, keyword: BIND_PHRASE, expiresInMs: BIND_TTL_MS };
  };

  const pollBind = (contactId: string, attemptId: string): { status: "waiting" | "bound" | "gone"; error: string; binding?: QQBindingView } => {
    hydrate(); expireWindows();
    const window = windows.get(attemptId);
    if (window === undefined || window.contactId !== contactId) return { status: "gone", error: "认领窗口已经关掉（过期或重新点过绑定），再点一次「去绑定」" };
    if (window.status === "claimed") { const account = byContact(contactId); return { status: "bound", error: "", ...(account !== null ? { binding: viewOf(account) } : {}) }; }
    return { status: "waiting", error: window.error };
  };

  const setFlags = (id: string, patch: { enabled?: boolean; proactive?: boolean }): boolean => {
    const account = byId(id); if (account === null) return false;
    if (patch.enabled !== undefined) account.enabled = patch.enabled;
    if (patch.proactive !== undefined) account.proactive = patch.proactive;
    persist(); const worker = workers.get(account.id);
    if (!account.enabled) worker?.gateway.close();
    else if (configured(account)) void getWorker(account).gateway.open();
    return true;
  };
  const setFlagsByContact = (contactId: string, patch: { enabled?: boolean; proactive?: boolean }): boolean => {
    const account = byContact(contactId); return account === null ? false : setFlags(account.id, patch);
  };

  const disconnect = (id: string): boolean => {
    hydrate(); const before = accounts.length; const account = accounts.find((a) => a.id === id);
    if (account) { workers.get(account.id)?.gateway.close(); workers.delete(account.id); }
    accounts = accounts.filter((a) => a.id !== id);
    if (accounts.length === before) return false;
    persist(); return true;
  };

  const summary = (): { configured: boolean; appId: string; status: QQStatus; lastError: string; bindings: number; max: number; active: number; proactive: number; trouble: Array<{ contactId: string; name: string; lastError: string }> } => {
    hydrate(); const trouble: Array<{ contactId: string; name: string; lastError: string }> = [];
    for (const account of accounts) {
      if ((account.lastError !== "" || !account.enabled) && trouble.length < 3) trouble.push({ contactId: account.contactId, name: getContact(account.contactId)?.name || account.contactId, lastError: account.lastError });
    }
    const first = accounts[0];
    return { configured: accounts.some((a) => configured(a)), appId: first?.appId ? redact(first.appId) : "", status: gatewayStatus(), lastError: problem !== "" ? problem : trouble[0]?.lastError ?? "", bindings: accounts.length, max: ACCOUNT_CAP, active: accounts.filter((a) => configured(a) && a.enabled).length, proactive: accounts.filter((a) => a.proactive && a.enabled).length, trouble };
  };

  const platformCall = async (path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const started = Date.now();
    const response = await http(PLATFORM_ORIGIN + path, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
    const rawBody = await response.text().catch(() => "");
    let data: Record<string, unknown> = {};
    try { data = rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>; } catch { /* 非 JSON 报文原样进日志 */ }
    const retcode = Number(data.retcode ?? 0);
    if (!response.ok || (Number.isFinite(retcode) && retcode !== 0)) {
      const message = asText(data.msg) || asText(data.message) || `HTTP ${response.status}`;
      logModelCall({ purpose: "qq", ok: false, code: "QQ_BIND_" + String(retcode), model: "qqbot", url: path, elapsedMs: Date.now() - started, message: message.slice(0, 300), resRaw: rawBody.slice(0, 2000) });
      throw withRaw(new Error(message === "" ? "QQ 开放平台拒绝了这次请求" : message), rawBody.slice(0, 2000));
    }
    logModelCall({ purpose: "qq", ok: true, model: "qqbot", url: path, elapsedMs: Date.now() - started });
    const inner = data.data; return inner !== null && typeof inner === "object" ? inner as Record<string, unknown> : {};
  };

  const decryptSecret = (encrypted: string, bindKey: string): string => {
    const key = Buffer.from(bindKey, "base64"); const raw = Buffer.from(encrypted, "base64");
    if (key.length !== 32) throw new Error("绑定密钥长度不对，重新扫一次码");
    if (raw.length <= 28) throw new Error("QQ 返回的凭证太短，重新扫一次码");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(raw.length - 16));
    try { return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8").trim(); }
    catch { throw new Error("解不开 QQ 返回的凭证（绑定任务大概已被新的取代），请重新扫码"); }
  };

  const beginCredentialQr = async (contactId: string): Promise<{ taskId: string; qrContent: string; expiresInMs: number }> => {
    if (getContact(contactId) === null) throw new Error("联系人不存在");
    const bindKey = Buffer.from(randomBytes(32)).toString("base64");
    const data = await platformCall("/lite/create_bind_task", { key: bindKey });
    const taskId = asText(data.task_id); if (taskId === "") throw new Error("QQ 没有返回绑定任务 id，请重试");
    qrTasks.set(contactId, { taskId, contactId, bindKey, expiresAt: clock() + BIND_TTL_MS });
    return { taskId, qrContent: `${PLATFORM_ORIGIN}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`, expiresInMs: BIND_TTL_MS };
  };

  const pollCredentialQr = async (contactId: string, taskId: string): Promise<{ status: "waiting" | "created" | "expired" | "gone"; error: string; appId?: string }> => {
    const task = qrTasks.get(contactId);
    if (task === null || task === undefined || task.taskId !== taskId) return { status: "gone", error: "这个二维码已经作废，请重新扫码" };
    if (task.expiresAt <= clock()) { qrTasks.delete(contactId); return { status: "expired", error: "二维码已过期，请重新扫" }; }
    const data = await platformCall("/lite/poll_bind_result", { task_id: taskId }); const status = Number(data.status ?? QR_NONE);
    if (status === QR_EXPIRED) { qrTasks.delete(contactId); return { status: "expired", error: "二维码已过期，请重新扫" }; }
    if (status !== QR_COMPLETED) return { status: "waiting", error: "" };
    const appId = asText(data.bot_appid); const encrypted = asText(data.bot_encrypt_secret);
    if (appId === "" || encrypted === "") { qrTasks.delete(contactId); return { status: "gone", error: "扫码成功了，但 QQ 没给完整的凭据，请重新扫一次" }; }
    const bindKey = task.bindKey; qrTasks.delete(contactId);
    let secret = ""; try { secret = decryptSecret(encrypted, bindKey); } catch (error) { return { status: "gone", error: error instanceof Error ? error.message : String(error) }; }
    if (secret === "") return { status: "gone", error: "解出来的 AppSecret 是空的，请重新扫码" };
    setCredentials(contactId, { appId, clientSecret: secret, enabled: true });
    return { status: "created", error: "", appId: redact(appId) };
  };

  /**
   * 主动探活：对每个已配置且启用的账号，直接调一次 getAppAccessToken（绕过 SingleFlight 缓存），
   * 把"token 被平台提前作废 / AppSecret 重置"变成**可被检测到的事实**，而不是等某条消息发出失败
   * 才被动暴露。每 30 分钟跑一次（token 生命周期 7200s，这个频率足以兜住提前失效）。
   * 失败原因已写进 credentialFaults，statusOf 会把该账号状态升级为 attention。
   */
  const probeCredentials = async (): Promise<void> => {
    hydrate();
    for (const account of accounts) {
      if (!configured(account) || !account.enabled) continue;
      try {
        await getWorker(account).token.get(true); // 强制重取，绕过 TTL 缓存
        const hadFault = credentialFaults.has(account.id);
        credentialFaults.delete(account.id);
        if (hadFault) { account.lastError = ""; persist(); } // 只清凭据故障本身留下的错误，别的提示（如未绑 openid）不动
      } catch {
        // 失败原因已在 makeWorker 里写进 credentialFaults；这里把网关状态一并拉成 attention，
        // 让用户在状态页一眼看到"凭据出问题了"，而不是等某条消息报错。
        const worker = workers.get(account.id);
        if (worker !== undefined) worker.gateway.phase = "attention";
        noteProblem(account, new Error("访问凭证探活失败：" + (credentialFaults.get(account.id) ?? "未知原因")));
      }
    }
  };
  const startTokenProbe = (): void => {
    if (tokenProbeTimer !== null || disposed) return;
    void probeCredentials();
    tokenProbeTimer = setInterval(() => { void probeCredentials(); }, TOKEN_PROBE_MS);
    tokenProbeTimer.unref?.();
  };
  const stopTokenProbe = (): void => { if (tokenProbeTimer !== null) { clearInterval(tokenProbeTimer); tokenProbeTimer = null; } };

  const startAll = (): void => { hydrate(); for (const account of accounts) if (configured(account) && account.enabled) void getWorker(account).gateway.open(); startTokenProbe(); };
  const stopAll = (): void => { stopTokenProbe(); for (const worker of workers.values()) worker.gateway.evacuate(); };
  const clearAll = (): void => { for (const worker of workers.values()) { worker.gateway.close(); worker.gateway.forget(); worker.token.invalidate(); } workers.clear(); windows.clear(); replyCounters.clear(); qrTasks.clear(); credentialFaults.clear(); accounts = []; hydrated = true; problem = ""; persist(); };

  return {
    deliverToContact, deliverToConversation,
    deliverMediaToContact, deliverMediaToGroup, deliverMediaToConversation,
    deliverEmote, beginBind, pollBind, snapshotFor, summary,
    setCredentials, beginCredentialQr, pollCredentialQr, setFlags, setFlagsByContact, disconnect,
    disconnectByContact: (contactId: string): boolean => { const account = byContact(contactId); return account === null ? false : disconnect(account.id); },
    startAll, stopAll,
    dispose: (): void => { disposed = true; stopTokenProbe(); for (const worker of workers.values()) worker.gateway.close(); },
    clearAll, gatewayStatus,
    lastGatewayError: (): string => problem,
    splitQqText,
  };
}

/** 官方 Bot API 后端的单例。消费点应通过 qq-routed.ts 的门面（按 config.qq.backend 选择后端）。 */
export const qqOfficial = createQQService();

/**
 * 后端统一接口：消费点（proactive / agent / index / 路由）只认这个面，
 * 不关心背后是官方 Bot API 还是 OneBot v11 协议端。QQService = 官方后端的返回形状。
 */
export type QQService = typeof qqOfficial;

/**
 * 消费点统一用的门面。背后两个后端：
 *   - "official"（默认）→ qq.ts 的官方 Bot API 后端；
 *   - "onebot"         → qq-onebot.ts 的 OneBot v11 协议端后端。
 * 两边都实现同一个 QQService 面，消费点零感知即可切换——而且切换是**运行期热切**：
 * 门面把每次成员调用实时分发到当前生效的实例，切换瞬间旧后端 stopAll、新后端 startAll，
 * 在飞的投递跑完旧实例自然收尾，下一条消息就走新渠道，全程不断服务。
 *
 * 选型的真源：界面里切换后落 KV（`qq.backend`）并当场热切；KV 同时是下次启动的初值，
 * 环境变量/desktop.json 只是没有界面选择时的缺省（config 是冻结的，不回写）。
 * 生效值统一从 qqBackend() 读：表情能力探测、路由分流都认它，永远对齐。
 */
const QQ_BACKEND_KV = "qq.backend";
const savedBackend = kvGet(QQ_BACKEND_KV);
let effectiveBackend: "official" | "onebot" =
  savedBackend === "official" || savedBackend === "onebot" ? savedBackend : config.qq.backend;
/** 当前生效的 QQ 渠道（热切换由 applyQQBackend 改写，读方拿到的永远是现行值）。 */
export function qqBackend(): "official" | "onebot" { return effectiveBackend; }
/** 界面里选过、写在库里的渠道；与 qqBackend() 一致是常态，不一致只出现在写盘失败的瞬间。 */
export function qqBackendSaved(): "official" | "onebot" | null {
  const value = kvGet(QQ_BACKEND_KV);
  return value === "official" || value === "onebot" ? value : null;
}
export function saveQQBackend(backend: "official" | "onebot"): void {
  kvSet(QQ_BACKEND_KV, backend);
}

// ── 渠道热切换：门面 + 双后端缓存 ─────────────────────────────
// 两个后端实例都常驻（懒创建），`qq` 门面的每次调用都实时分发到当前生效的那个。
let officialService: QQService = qqOfficial;
let onebotService: QQService | null = null;
const activeService = (): QQService => {
  if (effectiveBackend === "onebot") {
    if (onebotService === null) onebotService = createQQOneBotService();
    return onebotService;
  }
  return officialService;
};

/** 运行期切换渠道：落库由调用方（saveQQBackend）负责，这里只负责把进程切过去。 */
export function applyQQBackend(backend: "official" | "onebot"): void {
  if (backend === effectiveBackend) return;
  const previous = activeService();
  effectiveBackend = backend;
  const next = activeService();
  previous.stopAll();
  next.startAll();
  console.log(`[qq] 渠道已热切换：${previous === officialService ? "official" : "onebot"} → ${backend}`);
}

/**
 * 门面：Proxy 把每个成员调用转发到当前生效的后端实例。
 * 服务的公开面全是方法（读写 KV、发消息、开/停网关），逐调用分发没有一致性问题；
 * 切换瞬间拿到的引用换目标，等于"下一条消息就走新渠道"。
 */
export const qq: QQService = new Proxy({} as QQService, {
  get: (_target, prop) => Reflect.get(activeService(), prop),
});
