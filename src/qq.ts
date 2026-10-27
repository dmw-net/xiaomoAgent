// ── QQ 通道：腾讯 QQ 机器人开放平台 v2 ──────────────────────────
//
// 一个联系人 = 一个 QQ BotAccount：凭据按联系人隔离，每个账号拥有独立
// token、网关与重连状态。QQ 私聊并入联系人主会话；每个 QQ 群单独一段
// Conversation，群 openid 只在所属 BotAccount 下解释。

import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { db, kvGet, kvSet } from "./db.ts";
import { getChannel } from "./channels/types.ts";
import { getContact } from "./contacts.ts";
import { logModelCall } from "./logs.ts";
import { asText, chunkText, deliverOutbound, deliveryAllowed, redact, SeenKeys, SingleFlight } from "./channels/delivery.ts";
import { ensureConversation, ensureLocalConversation, getConversation, listConversations, setConversationMembership, type Conversation } from "./conversations.ts";

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
const ACCOUNT_CAP = 40;
const SEEN_LIMIT = 160;
const BIND_TTL_MS = 10 * 60_000;
const REPLY_WINDOW_MS = 60 * 60_000;
const TOKEN_SKEW_MS = 60_000;
const RECONNECT_STEPS_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 90_000];
const BIND_PHRASE = "绑定";

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10 } as const;

export type QQStatus = "connected" | "connecting" | "disabled" | "attention" | "not-configured";
export type QQConversationView = { id: string; kind: "private" | "group"; title: string; titleSource: "auto" | "custom"; externalId: string; enabled: boolean; leftAt: number | null; messageCount: number; lastMessageAt: string };
export type QQBindingView = {
  id: string; contactId: string; userOpenId: string; enabled: boolean; proactive: boolean;
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

export function splitQqText(value: string): string[] { return chunkText(value, TEXT_UNITS); }
const shortId = (): string => randomUUID().slice(0, 10);

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
  const windows = new Map<string, BindWindow>();
  const replyCounters = new Map<string, number>();
  const qrTasks = new Map<string, { taskId: string; contactId: string; bindKey: string; expiresAt: number }>();
  const workers = new Map<string, { gateway: Gateway; token: SingleFlight<string> }>();

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
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      const value = asText(data?.access_token); const expiresIn = Number(data?.expires_in);
      if (value === "" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        const message = asText(data?.message) || `HTTP ${response.status}`;
        logModelCall({ purpose: "qq", ok: false, code: "QQ_TOKEN", model: "qqbot", url: "/app/getAppAccessToken", elapsedMs: Date.now() - started, message: message.slice(0, 300), contactId: current.contactId });
        throw new Error("换不到访问凭证：" + message);
      }
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
    const started = Date.now(); const header = await getWorker(account).token.get();
    const response = await http(API_ORIGIN + path, { method: init.method ?? "GET", headers: { authorization: `QQBot ${header}`, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>; const code = Number(data.code ?? 0);
    if (!response.ok || (Number.isFinite(code) && code !== 0)) {
      const message = asText(data.message) || `HTTP ${response.status}`;
      logModelCall({ purpose: "qq", ok: false, code: "QQ_API_" + String(code), model: "qqbot", url: path, elapsedMs: Date.now() - started, message: message.slice(0, 300), contactId: account.contactId });
      throw new Error(explain(code, message));
    }
    logModelCall({ purpose: "qq", ok: true, model: "qqbot", url: path, elapsedMs: Date.now() - started, contactId: account.contactId });
    return data;
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

  const deliver = async (account: StoredAccount | null, text: string, opts: { proactive?: boolean; msgId?: string } = {}): Promise<void> => {
    if (account === null || !configured(account) || !deliveryAllowed(account, opts.proactive === true)) return;
    const segments = splitQqText(text); if (segments.length === 0) return;
    const startedAt = clock();
    await deliverOutbound({
      segments, send: (segment) => sendPrivate(account, segment, opts.msgId ?? ""), elapsed: () => clock() - startedAt,
      onDelivered: () => { account.lastSentAt = new Date(clock()).toISOString(); account.lastError = ""; persist(); },
      onFailed: (message) => { account.lastError = message; persist(); console.warn(`[qq] 投递失败（${account.contactId}）：${message}`); },
      log: (ok, message, elapsedMs) => logModelCall({ purpose: "qq", ok, model: "qqbot", url: "/v2/users/{openid}/messages", elapsedMs, ...(message === "" ? {} : { message }), contactId: account.contactId }),
    });
  };

  const deliverToContact = async (contactId: string, text: string, opts: { proactive?: boolean } = {}): Promise<void> => {
    const account = byContact(contactId);
    if (account === null || !configured(account) || !deliveryAllowed(account, opts.proactive === true)) return;
    const inWindow = account.replyMessageId !== "" && clock() - account.replyMessageAt < REPLY_WINDOW_MS;
    await deliver(account, text, { proactive: opts.proactive === true, msgId: inWindow ? account.replyMessageId : "" });
  };

  const deliverToConversation = async (conversationId: string, text: string, opts: { triggerMessageId?: string } = {}): Promise<void> => {
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
      log: (ok, message, elapsedMs) => logModelCall({ purpose: "qq", ok, model: "qqbot", url: "/v2/groups/{group_openid}/messages", elapsedMs, ...(message === "" ? {} : { message }), contactId: account.contactId }),
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
    const key = `${account.id}|${openId}|${messageId}|${asText(message.msg_idx)}`;
    const seen = new SeenKeys(SEEN_LIMIT, account.recentMessageIds);
    if (seen.has(key) || text === "") return;
    const conv = ensureLocalConversation(account.contactId);
    account.replyMessageId = messageId; account.replyMessageAt = clock();
    account.lastReceivedAt = new Date(clock()).toISOString(); account.lastError = "";
    seen.remember(key); account.recentMessageIds = seen.toArray(); persist();
    const channel = getChannel("web"); if (channel === undefined) return;
    channel.receive(text, account.contactId, undefined, "qq", undefined, {
      conversationId: conv.id, senderId: openId, senderName: asText(author.username ?? author.nickname) || "QQ 用户",
      sourceMessageId: messageId, replyToMessageId: asText((message.message_reference as Record<string, unknown> | undefined)?.message_id), atBot: false,
    });
  };

  const receiveGroupAt = async (account: StoredAccount, message: Record<string, unknown>): Promise<void> => {
    const groupOpenId = asText(message.group_openid ?? message.group_id); const messageId = asText(message.id);
    if (groupOpenId === "" || messageId === "") return;
    if (!account.enabled) return;
    const text = asText(message.content); if (text === "") return;
    const key = `${account.id}|group|${groupOpenId}|${messageId}|${asText(message.msg_idx)}`;
    const seen = new SeenKeys(SEEN_LIMIT, account.recentMessageIds); if (seen.has(key)) return;
    const author = (message.author ?? {}) as Record<string, unknown>;
    const senderId = asText(author.member_openid ?? author.id);
    const senderName = asText(author.member_name ?? author.username ?? author.nickname) || "群成员";
    const conv = ensureConversation({ contactId: account.contactId, channel: "qq", kind: "group", externalId: groupOpenId, accountId: account.id, title: asText(message.group_name) });
    if (conv.left_at !== null || !conv.enabled) return;
    account.lastReceivedAt = new Date(clock()).toISOString(); account.lastError = "";
    seen.remember(key); account.recentMessageIds = seen.toArray(); persist();
    const channel = getChannel("web"); if (channel === undefined) return;
    channel.receive(text, account.contactId, undefined, "qq", undefined, {
      conversationId: conv.id, senderId, senderName, sourceMessageId: messageId,
      replyToMessageId: asText((message.message_reference as Record<string, unknown> | undefined)?.message_id), atBot: true,
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
      externalId: redact(conv.external_id), enabled: conv.enabled, leftAt: conv.left_at,
      messageCount: Number((db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?").get(conv.id) as { c: number }).c),
      lastMessageAt: conv.last_message_at ? new Date(conv.last_message_at).toISOString() : "",
    }));
  };

  const viewOf = (account: StoredAccount): QQBindingView => ({
    id: account.id, contactId: account.contactId, userOpenId: redact(account.userOpenId), enabled: account.enabled,
    proactive: account.proactive, status: statusOf(account),
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
    const data = await response.json().catch(() => ({})) as Record<string, unknown>; const retcode = Number(data.retcode ?? 0);
    if (!response.ok || (Number.isFinite(retcode) && retcode !== 0)) {
      const message = asText(data.msg) || asText(data.message) || `HTTP ${response.status}`;
      logModelCall({ purpose: "qq", ok: false, code: "QQ_BIND_" + String(retcode), model: "qqbot", url: path, elapsedMs: Date.now() - started, message: message.slice(0, 300) });
      throw new Error(message === "" ? "QQ 开放平台拒绝了这次请求" : message);
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

  const startAll = (): void => { hydrate(); for (const account of accounts) if (configured(account) && account.enabled) void getWorker(account).gateway.open(); };
  const stopAll = (): void => { for (const worker of workers.values()) worker.gateway.evacuate(); };
  const clearAll = (): void => { for (const worker of workers.values()) { worker.gateway.close(); worker.gateway.forget(); worker.token.invalidate(); } workers.clear(); windows.clear(); replyCounters.clear(); qrTasks.clear(); accounts = []; hydrated = true; problem = ""; persist(); };

  return {
    deliverToContact, deliverToConversation, beginBind, pollBind, snapshotFor, summary,
    setCredentials, beginCredentialQr, pollCredentialQr, setFlags, setFlagsByContact, disconnect,
    disconnectByContact: (contactId: string): boolean => { const account = byContact(contactId); return account === null ? false : disconnect(account.id); },
    startAll, stopAll,
    dispose: (): void => { disposed = true; for (const worker of workers.values()) worker.gateway.close(); },
    clearAll, gatewayStatus,
    lastGatewayError: (): string => problem,
    splitQqText,
  };
}

export const qq = createQQService();
