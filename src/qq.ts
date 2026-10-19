// ── QQ 通道：腾讯 QQ 机器人开放平台 v2 ──────────────────────────
//
// 与微信那条的根本差别，决定了数据长什么样：
//   微信是「一个联系人 = 一个机器人会话」，凭证挂在每条绑定上；
//   QQ 是「一个机器人（AppID/AppSecret）服务很多人」，凭证全局只有一份，
//   每条绑定只是这个机器人心下的一个 user_openid。
// 所以这里有两位：qq.credentials（全局）与 qq.bindings（每联系人一条）。
//
// 认领为什么要让对方发一条消息：官方没有「QQ 号 → openid」的接口，openid 只会
// 出现在入站消息里。拿凭证那一步可以扫码，但「这位联系人对应哪个 openid」只能靠他发一条。
// 暗号因此只是两个字——省不掉"发一条"，能省的是让他抄一串字符。
//
// 报文口径（对着官方文档与实测核过，改之前先确认这几条）：
//   · 凭据扫码：POST https://q.qq.com/lite/create_bind_task {key: base64(32B AES key)}
//     → data.task_id；二维码内容是 https://q.qq.com/qqbot/openclaw/connect.html?task_id=…
//     再 POST /lite/poll_bind_result {task_id} → data.status（0 未扫 / 1 待确认 / 2 完成 / 3 过期），
//     完成时给 bot_appid + bot_encrypt_secret（base64：12B nonce + 密文 + 16B GCM tag，
//     用上面那把钥匙解）；
//   · 数据面请求头是 Authorization: QQBot <access_token>；token 由 appId + clientSecret 换，
//     按 expires_in 提前 60 秒续；
//   · GET /gateway 拿 wss 地址 → HELLO(op10) 给心跳周期 → IDENTIFY(op2, intents = 1<<25)；
//     心跳 op1 带 seq；断线时若还有 session_id 与 seq 就走 RESUME(op6)，
//     别重新 IDENTIFY——官方按会话算频控配额；
//   · 事件是 DISPATCH(op0)，私聊为 C2C_MESSAGE_CREATE；
//   · 发送走 POST /v2/users/{openid}/messages：被动回复带 msg_id + 递增 msg_seq
//     （平台按这对儿幂等）；不带 msg_id 的就是主动消息，要单独申请权限，
//     没开通会直接失败——必须落 lastError 让人看见，不许静默丢弃；
//   · close 4914 = 机器人未发布、只能连沙箱；4915 = 被平台限制。这两句要翻成人话；
//   · 单条文本上限 4000 rune，超了整条被拒，所以按段落切开送。
//
// 这一版只送文字（图仍在应用里看），也不接群聊：群要 @ 判定与群内频控，先把私聊跑通。

import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { kvGet, kvSet } from "./db.ts";
import { getChannel } from "./channels/types.ts";
import { getContact } from "./contacts.ts";
import { logModelCall } from "./logs.ts";
import {
  asText,
  chunkText,
  deliverOutbound,
  deliveryAllowed,
  redact,
  SeenKeys,
  SingleFlight,
} from "./channels/delivery.ts";

const KV_CREDENTIALS = "qq.credentials";
const KV_BINDINGS = "qq.bindings";
/** 数据面（收发消息、拿网关地址）与开放平台站点（扫码拿凭据）不是同一个域。 */
const API_ORIGIN = "https://api.bot.qq.com";
const PLATFORM_ORIGIN = "https://q.qq.com";
/** /lite/* 两条的状态值（官方语义）。 */
const QR_NONE = 0;
const QR_COMPLETED = 2;
const QR_EXPIRED = 3;
const INTENT_C2C = 1 << 25;
const TEXT_UNITS = 4000;
const BINDING_CAP = 40;
const SEEN_LIMIT = 160;
const BIND_TTL_MS = 10 * 60_000;
/**
 * 被动回复窗口。官方文档两处口径不一致（概述写「单聊 60 分钟 4 次」，
 * 发送接口的 msg_id 字段写「5 分钟内有效」）。这里按 60 分钟取，以实测为准。
 * 另：同一个 msg_id 平台最多认 4 次，这里没设上限——超了平台会拒，错误码照实落到界面上。
 */
const REPLY_WINDOW_MS = 60 * 60_000;
const TOKEN_SKEW_MS = 60_000;
/** 重连退避：按「连续失败了几次」走，连上就归零。 */
const RECONNECT_STEPS_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 90_000];
/** 认领暗号：整条消息等于它才算，正文里出现不算。 */
const BIND_PHRASE = "绑定";

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
} as const;
/** 界面按这个集合出徽标，多的每一个值都会显示成空白。 */
export type QQStatus = "connected" | "connecting" | "disabled" | "attention" | "not-configured";

export type QQBindingView = {
  id: string;
  contactId: string;
  /** openid 是不透明标识，界面只需要认出「是哪一个」——全给等于多一处可泄露的 id。 */
  userOpenId: string;
  enabled: boolean;
  proactive: boolean;
  status: QQStatus;
  /** 还在被动回复窗口内：这几句能直接送；出了窗口就依赖「主动消息」权限。 */
  hasReplyWindow: boolean;
  lastError: string;
  lastReceivedAt: string;
  lastSentAt: string;
  createdAt: string;
};

type StoredBinding = {
  id: string;
  contactId: string;
  userOpenId: string;
  enabled: boolean;
  proactive: boolean;
  recentMessageIds: string[];
  createdAt: string;
  lastError: string;
  lastReceivedAt: string;
  lastSentAt: string;
  replyMessageId: string;
  replyMessageAt: number;
};

type BindWindow = {
  id: string;
  contactId: string;
  expiresAt: number;
  status: "open" | "claimed";
  error: string;
};

/** 注入用的 socket 形状：真 WebSocket 走 addEventListener，假 socket 走四个 onXxx。 */
type QQSocket = {
  send(data: string): void;
  close(): void;
  addEventListener?: (type: string, handler: (event?: { data?: unknown; code?: number }) => void) => void;
  onOpen?: (handler: () => void) => void;
  onMessage?: (handler: (raw: string) => void) => void;
  onClose?: (handler: (code: number) => void) => void;
  onError?: (handler: (message: string) => void) => void;
};

type Credentials = { appId: string; clientSecret: string; enabled: boolean };

/** QQ 正文按空行切段，段内超长再硬切。 */
export function splitQqText(value: string): string[] {
  return chunkText(value, TEXT_UNITS);
}

const shortId = (): string => randomUUID().slice(0, 10);

/** 从库里读全局凭据；坏的/缺的按「没配」处理。 */
function readCredentials(): Credentials {
  const raw = kvGet(KV_CREDENTIALS);
  if (raw === null || raw === "") return { appId: "", clientSecret: "", enabled: false };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { appId: asText(parsed.appId), clientSecret: asText(parsed.clientSecret), enabled: parsed.enabled === true };
  } catch {
    console.warn("[qq] 凭据不是合法 JSON，已当作未配置");
    return { appId: "", clientSecret: "", enabled: false };
  }
}

/** 把库里的绑定表还原出来；缺字段补默认值，坏条目丢掉。 */
function parseBindings(raw: string | null): StoredBinding[] {
  if (raw === null || raw === "") return [];
  let parsed: { bindings?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw) as { bindings?: unknown };
  } catch {
    console.warn("[qq] 绑定表不是合法 JSON，已当作没有绑定");
    return [];
  }
  const list = Array.isArray(parsed?.bindings) ? parsed.bindings : [];
  const out: StoredBinding[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = asText(row.id);
    const contactId = asText(row.contactId);
    if (id === "" || contactId === "") continue;
    out.push({
      id,
      contactId,
      userOpenId: asText(row.userOpenId),
      enabled: row.enabled !== false,
      proactive: row.proactive === true,
      recentMessageIds: (Array.isArray(row.recentMessageIds) ? row.recentMessageIds : [])
        .map((key) => asText(key))
        .filter((key) => key !== "")
        .slice(-SEEN_LIMIT),
      createdAt: asText(row.createdAt),
      lastError: asText(row.lastError),
      lastReceivedAt: asText(row.lastReceivedAt),
      lastSentAt: asText(row.lastSentAt),
      replyMessageId: asText(row.replyMessageId),
      replyMessageAt: Number(row.replyMessageAt ?? 0) || 0,
    });
  }
  return out.slice(-BINDING_CAP);
}
/**
 * 网关连接。把「一条 socket 的一生」收在一处：握手、心跳、重连、换代。
 *
 * 两个细节值得先说：帧处理必须带着**发起它的那条 socket**（心跳与登录要回到发 HELLO 的那条
 * 连接上，用全局引用会在重连竞态里把帧送进已经换掉的连接）；每次 open 递增 generation，
 * 旧 socket 迟到的那一拍靠它对号入座，不会把新连接拽回旧状态。
 */
class Gateway {
  private readonly fetchImpl: typeof fetch;
  private readonly makeSocket: (url: string) => QQSocket;
  private readonly authHeader: () => Promise<string>;
  private readonly onEvent: (data: Record<string, unknown>) => void;
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
    fetchImpl: typeof fetch;
    makeSocket: (url: string) => QQSocket;
    authHeader: () => Promise<string>;
    onEvent: (data: Record<string, unknown>) => void;
    onProblem: (error: unknown) => void;
    allowed: () => boolean;
    stopped: () => boolean;
  }) {
    this.fetchImpl = options.fetchImpl;
    this.makeSocket = options.makeSocket;
    this.authHeader = options.authHeader;
    this.onEvent = options.onEvent;
    this.onProblem = options.onProblem;
    this.allowed = options.allowed;
    this.stopped = options.stopped;
  }

  /** 建连接。已经有一条在跑就直接返回——两条会让同一条消息被投递两遍。 */
  async open(): Promise<void> {
    if (this.stopped() || this.socket !== null) return;
    if (!this.allowed()) {
      this.phase = "not-configured";
      return;
    }
    this.phase = "connecting";
    const generation = this.generation + 1;
    this.generation = generation;
    let socket: QQSocket;
    try {
      const info = await this.discoverGateway();
      const url = asText(info.url);
      if (!/^wss?:\/\//i.test(url)) throw new Error("QQ 没有返回可用的网关地址");
      socket = this.makeSocket(url);
    } catch (error) {
      this.socket = null;
      this.onProblem(error);
      this.retryLater();
      return;
    }
    if (this.stopped() || this.generation !== generation) {
      try { socket.close(); } catch { /* 已经断了 */ }
      return;
    }
    this.socket = socket;
    this.listen(socket, generation);
  }

  /** 断开连接（重连定时器一起清掉）。 */
  close(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try { this.socket?.close(); } catch { /* 已经断了 */ }
    this.socket = null;
    this.stopHeartbeat();
  }

  /** 让位时用：连接没了，但这不是故障，回来还要能连。 */
  evacuate(): void {
    const wasLive = this.phase === "connected" || this.phase === "connecting";
    this.close();
    if (wasLive) this.phase = this.allowed() ? "attention" : "not-configured";
  }

  /** 忘记会话与退避（换凭据、clearAll 用）。 */
  forget(): void {
    this.session = "";
    this.seq = 0;
    this.failures = 0;
    this.generation += 1;
  }

  /** 拿网关地址；错误包成可读的话。 */
  private async discoverGateway(): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${API_ORIGIN}/gateway`, {
      headers: { authorization: `QQBot ${await this.authHeader()}`, "content-type": "application/json" },
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = Number(data.code ?? 0);
    if (!response.ok || (Number.isFinite(code) && code !== 0)) {
      throw new Error(asText(data.message) || `HTTP ${response.status}`);
    }
    return data;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private retryLater(overrideMs?: number): void {
    if (this.stopped() || this.retryTimer !== null) return;
    const step = RECONNECT_STEPS_MS[Math.min(this.failures, RECONNECT_STEPS_MS.length - 1)] ?? 60_000;
    const delay = overrideMs ?? step;
    this.failures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, delay);
    this.retryTimer.unref?.();
  }

  private write(socket: QQSocket | null, frame: Record<string, unknown>): void {
    if (socket === null) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch { /* 断了的话 onClose 会接手重连 */ }
  }
  /** 真 WebSocket 用 addEventListener，注入的假 socket 用四个 onXxx：两边都接得上。 */
  private listen(socket: QQSocket, generation: number): void {
    const onMessage = (raw: string): void => {
      if (this.generation !== generation || this.socket !== socket) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return; // 不是 JSON 的那几行（心跳 ack 之类）忽略，别为它断线
      }
      this.onFrame(socket, frame);
    };
    const onClose = (code: number): void => {
      if (this.generation !== generation) return;
      this.socket = null;
      this.stopHeartbeat();
      if (this.stopped() || !this.allowed()) return;
      if (code === 4914) {
        this.onProblem(new Error("QQ 机器人现在只能连沙箱环境：请到开放平台检查发布状态"));
        return;
      }
      if (code === 4915) {
        this.onProblem(new Error("QQ 机器人被平台限制，暂时连不上"));
        return;
      }
      if (code === 4004) this.onProblem(new Error("QQ 拒绝了这次登录凭证，正在重取"));
      this.phase = "attention";
      this.retryLater(code === 4008 ? 60_000 : undefined);
    };
    const onError = (message: string): void => {
      if (this.generation === generation) this.onProblem(new Error(message));
    };
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("message", (event) => onMessage(String(event?.data ?? "")));
      socket.addEventListener("close", (event) => onClose(Number(event?.code ?? 0)));
      socket.addEventListener("error", () => onError("QQ 网关连接异常"));
      return;
    }
    socket.onMessage?.((raw) => onMessage(raw));
    socket.onClose?.((code) => onClose(code));
    socket.onError?.((message) => onError(message));
  }

  private onFrame(socket: QQSocket, frame: Record<string, unknown>): void {
    const seq = Number(frame.s);
    if (Number.isSafeInteger(seq) && seq >= 0) this.seq = seq;
    switch (Number(frame.op)) {
      case OP.HELLO: {
        const data = (frame.d ?? {}) as Record<string, unknown>;
        const interval = Number(data.heartbeat_interval);
        this.stopHeartbeat();
        if (Number.isFinite(interval) && interval >= 1000) {
          this.heartbeat = setInterval(() => this.write(socket, { op: OP.HEARTBEAT, d: this.seq }), interval);
          this.heartbeat.unref?.();
        } else {
          this.onProblem(new Error("QQ 网关没给有效的心跳周期"));
        }
        // 有 session_id + seq 就走 RESUME：官方按会话算频控配额，重新 IDENTIFY 会被当新连接。
        const resumable = this.session !== "" && Number.isSafeInteger(this.seq);
        void (async () => {
          let header = "";
          try {
            header = `QQBot ${await this.authHeader()}`;
          } catch (error) {
            this.onProblem(error);
            return;
          }
          if (resumable) {
            this.write(socket, { op: OP.RESUME, d: { token: header, session_id: this.session, seq: this.seq } });
            return;
          }
          this.write(socket, {
            op: OP.IDENTIFY,
            d: {
              token: header,
              intents: INTENT_C2C,
              shard: [0, 1],
              properties: { $os: "windows", $browser: "xiaomo-ai", $device: "xiaomo-ai" },
            },
          });
        })();
        return;
      }
      case OP.DISPATCH: {
        const type = asText(frame.t);
        const data = (frame.d ?? {}) as Record<string, unknown>;
        // 连上了就把退避归零，否则跑了一天之后每次真断线都要从 60 秒那档开始等。
        if (type === "READY") {
          this.session = asText(data.session_id);
          this.phase = "connected";
          this.failures = 0;
          return;
        }
        if (type === "RESUMED") {
          this.phase = "connected";
          this.failures = 0;
          return;
        }
        if (type === "C2C_MESSAGE_CREATE") this.onEvent(data);
        return;
      }
      case OP.RECONNECT:
        this.close();
        this.retryLater(2_000);
        return;
      case OP.INVALID_SESSION:
        // d = true 表示会话还能续；否则连会话带位置一起作废，重新登录。
        if (frame.d !== true) {
          this.session = "";
          this.seq = 0;
        }
        this.close();
        this.retryLater(3_000);
        return;
      default:
        return; // 含心跳回包（有的实现会 echo 一份 op1）
    }
  }
}
export function createQQService(deps: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 注入点：冒烟用假 socket 把网关协议整套跑一遍（Node 没内置 WS 服务端）。 */
  socketFactory?: (url: string) => QQSocket;
} = {}) {
  const http = deps.fetchImpl ?? globalThis.fetch;
  const clock = deps.now ?? ((): number => Date.now());

  let bindings: StoredBinding[] = [];
  let hydrated = false;
  let disposed = false;
  let problem = "";
  const windows = new Map<string, BindWindow>();
  /** msg_seq 按 (绑定, msg_id) 递增：平台对同一对判重。 */
  const replyCounters = new Map<string, number>();
  let qrTask: { taskId: string; bindKey: string; expiresAt: number } | null = null;
  /** 最近一次换到的 token 还剩多久，供 SingleFlight 的 TTL 回调取用。 */
  let tokenTtl = 5 * 60_000;

  const configured = (): boolean => {
    const c = readCredentials();
    return c.enabled && c.appId !== "" && c.clientSecret !== "";
  };

  const hydrate = (): void => {
    if (hydrated) return;
    bindings = parseBindings(kvGet(KV_BINDINGS));
    hydrated = true;
  };

  const persist = (): void => kvSet(KV_BINDINGS, JSON.stringify({ version: 1, bindings }));

  const byId = (id: string): StoredBinding | null => {
    hydrate();
    return bindings.find((b) => b.id === id) ?? null;
  };
  const byContact = (contactId: string): StoredBinding | null => {
    hydrate();
    return bindings.find((b) => b.contactId === contactId) ?? null;
  };
  const byOpenId = (openId: string): StoredBinding | null => {
    hydrate();
    return bindings.find((b) => b.userOpenId === openId) ?? null;
  };

  const noteProblem = (error: unknown): void => {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    if (message === "") return;
    gateway.phase = "attention";
    problem = message;
    console.warn(`[qq] ${message}`);
  };

  // ── access_token（单飞 + 提前过期）──────────────────────────
  const token = new SingleFlight<string>(
    async () => {
      const c = readCredentials();
      if (c.appId === "" || c.clientSecret === "") throw new Error("还没填 QQ 机器人的 AppID 与 AppSecret");
      const started = Date.now();
      const response = await http(`${API_ORIGIN}/app/getAppAccessToken`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: c.appId, clientSecret: c.clientSecret }),
      });
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      const value = asText(data?.access_token);
      const expiresIn = Number(data?.expires_in);
      if (value === "" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        const message = asText(data?.message) || `HTTP ${response.status}`;
        logModelCall({
          purpose: "qq", ok: false, code: "QQ_TOKEN", model: "qqbot",
          url: "/app/getAppAccessToken", elapsedMs: Date.now() - started, message: message.slice(0, 300),
        });
        throw new Error("换不到访问凭证：" + message);
      }
      logModelCall({
        purpose: "qq", ok: true, model: "qqbot", url: "/app/getAppAccessToken",
        elapsedMs: Date.now() - started,
      });
      // 提前量之外再留一个下限：expires_in 特别短时也不能刚拿到就过期。
      tokenTtl = Math.max(30_000, expiresIn * 1000 - TOKEN_SKEW_MS);
      return value;
    },
    () => tokenTtl,
    clock,
  );
  const authHeader = (force = false): Promise<string> => token.get(force);

  // ── 网关 ────────────────────────────────────────────────────
  const gateway = new Gateway({
    fetchImpl: http,
    makeSocket: (url) => (deps.socketFactory !== undefined
      ? deps.socketFactory(url)
      : new WebSocket(url) as unknown as QQSocket),
    authHeader: () => authHeader(),
    onEvent: (data) => { void acceptInbound(data).catch((error) => noteProblem(error)); },
    onProblem: noteProblem,
    allowed: configured,
    stopped: () => disposed,
  });

  const gatewayStatus = (): QQStatus => (configured() ? gateway.phase : "not-configured");

  // ── 数据面调用 ──────────────────────────────────────────────
  /** 几个常见错误码翻成人话；原始 message 跟在后面，不许换成一句笼统的「发送失败」。 */
  const explain = (code: number, message: string): string => {
    const tail = message === "" ? "" : ` · ${message}`;
    if (code === 40120031 || code === 40120032) {
      return `这条发不出去：主动消息需要平台权限（${code}）。请到 QQ 开放平台申请「消息能力」，或让对方先给你发一条消息、在回复窗口内送${tail}`;
    }
    if (code === 40034008 || code === 40094014) return `这条内容被平台拦截（${code}）${tail}`;
    return message === "" ? `QQ 接口返回错误 ${code}` : `QQ 接口错误 ${code}：${message}`;
  };

  const callApi = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> => {
    const started = Date.now();
    const header = await authHeader();
    const response = await http(API_ORIGIN + path, {
      method: init.method ?? "GET",
      headers: { authorization: `QQBot ${header}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    // 官方形状是 {code, message}：HTTP 200 也可能带非零 code，所以不能只看状态码。
    const code = Number(data.code ?? 0);
    if (!response.ok || (Number.isFinite(code) && code !== 0)) {
      const message = asText(data.message) || `HTTP ${response.status}`;
      logModelCall({
        purpose: "qq", ok: false, code: "QQ_API_" + String(code), model: "qqbot",
        url: path, elapsedMs: Date.now() - started, message: message.slice(0, 300),
      });
      throw new Error(explain(code, message));
    }
    logModelCall({ purpose: "qq", ok: true, model: "qqbot", url: path, elapsedMs: Date.now() - started });
    return data;
  };
  // ── 出站 ────────────────────────────────────────────────────
  /** 被动窗口内带 msg_id（平台按 msg_id + msg_seq 幂等），出窗就是真·主动消息。 */
  const nextSeq = (binding: StoredBinding, messageId: string): number => {
    const key = `${binding.id}|${messageId}`;
    const used = replyCounters.get(key) ?? 0;
    const next = used >= 65_535 ? 1 : used + 1;
    replyCounters.set(key, next);
    return next;
  };

  const sendText = async (binding: StoredBinding, content: string): Promise<void> => {
    if (binding.userOpenId === "") throw new Error("这位联系人还没绑到 QQ openid");
    const inWindow = binding.replyMessageId !== "" && clock() - binding.replyMessageAt < REPLY_WINDOW_MS;
    const body: Record<string, unknown> = { msg_type: 0, content };
    if (inWindow) {
      body.msg_id = binding.replyMessageId;
      body.msg_seq = nextSeq(binding, binding.replyMessageId);
    }
    await callApi(`/v2/users/${encodeURIComponent(binding.userOpenId)}/messages`, { method: "POST", body });
  };

  /** 把一句话送到这位联系人的 QQ。没绑定静默跳过；失败只记账，不抛错。 */
  const deliverToContact = async (
    contactId: string,
    text: string,
    opts: { proactive?: boolean } = {},
  ): Promise<void> => {
    const binding = byContact(contactId);
    if (binding === null || !configured() || !deliveryAllowed(binding, opts.proactive === true)) return;
    const segments = splitQqText(text);
    if (segments.length === 0) return;
    const startedAt = clock();
    await deliverOutbound({
      segments,
      send: (segment) => sendText(binding, segment),
      elapsed: () => clock() - startedAt,
      onDelivered: () => {
        binding.lastSentAt = new Date(clock()).toISOString();
        binding.lastError = "";
        persist();
      },
      onFailed: (message) => {
        binding.lastError = message;
        persist();
        console.warn(`[qq] 投递失败（${contactId}）：${message}`);
      },
      log: (ok, message, elapsedMs) => logModelCall({
        purpose: "qq",
        ok,
        model: "qqbot",
        url: "/v2/users/{openid}/messages",
        elapsedMs,
        ...(message === "" ? {} : { message }),
        contactId,
      }),
    });
  };

  // ── 入站 ────────────────────────────────────────────────────
  const expireWindows = (): void => {
    for (const [id, window] of windows) if (window.expiresAt <= clock()) windows.delete(id);
  };

  /** 认领成功：一个 openid 只属于一位联系人，一位联系人也只留一条绑定。 */
  const claimBinding = async (window: BindWindow, openId: string, messageId: string): Promise<void> => {
    hydrate();
    bindings = bindings.filter((b) => b.userOpenId !== openId && b.contactId !== window.contactId);
    const binding: StoredBinding = {
      id: shortId(),
      contactId: window.contactId,
      userOpenId: openId,
      enabled: true,
      proactive: false,
      recentMessageIds: [],
      createdAt: new Date(clock()).toISOString(),
      lastError: "",
      lastReceivedAt: new Date(clock()).toISOString(),
      lastSentAt: "",
      replyMessageId: messageId,
      replyMessageAt: clock(),
    };
    bindings.push(binding);
    if (bindings.length > BINDING_CAP) bindings = bindings.slice(-BINDING_CAP);
    persist();
    window.status = "claimed"; // 留着让界面那一拍轮询认得出「绑成功了」
    // 回执挂在这条触发绑定的消息上（还在被动窗口里）。
    try {
      await sendText(binding, "已连接到这位联系人。之后你发给我的消息都会进这段对话。");
    } catch (error) {
      binding.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      persist();
    }
  };

  /** 网关推来一条私聊事件。 */
  const acceptInbound = async (message: Record<string, unknown>): Promise<void> => {
    const author = (message.author ?? {}) as Record<string, unknown>;
    const openId = asText(author.user_openid ?? author.id);
    const messageId = asText(message.id);
    if (openId === "" || messageId === "") return;
    expireWindows();
    const text = asText(message.content);

    if (text === BIND_PHRASE) {
      // 同一时刻只留一条窗口（beginBind 会把旧的顶掉），所以这里不用挑。
      const open = [...windows.values()].find((window) => window.expiresAt > clock());
      if (open !== undefined) {
        await claimBinding(open, openId, messageId);
        return;
      }
      // 窗口没开也回一句：不然对方发了两个字没反应，只会以为机器人坏了。
      try {
        await callApi(`/v2/users/${encodeURIComponent(openId)}/messages`, {
          method: "POST",
          body: { msg_type: 0, content: "这会儿没有待确认的绑定。回应用面点一下「去绑定」，再把「绑定」发我一次。", msg_id: messageId, msg_seq: 1 },
        });
      } catch { /* 回执失败不打扰主流程 */ }
      return;
    }

    const binding = byOpenId(openId);
    // 没绑定的用户不接，也不替他凭空建联系人——那等于让任何陌生人往库里写对话。
    if (binding === null || !binding.enabled) return;
    // 官方会把长消息切成同 id、不同 msg_idx 的多帧，也会重投递：幂等键把两者都挡住。
    const key = `${openId}|${messageId}|${asText(message.msg_idx)}`;
    const seen = new SeenKeys(SEEN_LIMIT, binding.recentMessageIds);
    if (seen.has(key)) return;
    if (text === "") return; // 纯图片/贴纸：这一版不收媒体，也别回一句空的
    const channel = getChannel("web");
    if (channel === undefined) return;
    // 第四参数记来源：这句是 QQ 里说的，不是本机界面打的——库里/上下文里/记忆抽取里都要认得出。
    channel.receive(text, binding.contactId, undefined, "qq");
    seen.remember(key);
    binding.recentMessageIds = seen.toArray();
    // 记住这条的 id：接下来一小时内的回复都挂在它上面（被动窗口），过了就只能走主动消息权限。
    binding.replyMessageId = messageId;
    binding.replyMessageAt = clock();
    binding.lastReceivedAt = new Date(clock()).toISOString();
    binding.lastError = "";
    persist();
  };
  // ── 对外视图 ────────────────────────────────────────────────
  const viewOf = (binding: StoredBinding): QQBindingView => ({
    id: binding.id,
    contactId: binding.contactId,
    userOpenId: redact(binding.userOpenId),
    enabled: binding.enabled,
    proactive: binding.proactive,
    status: !binding.enabled ? "disabled" : gatewayStatus(),
    hasReplyWindow: binding.replyMessageId !== "" && clock() - binding.replyMessageAt < REPLY_WINDOW_MS,
    lastError: binding.lastError,
    lastReceivedAt: binding.lastReceivedAt,
    lastSentAt: binding.lastSentAt,
    createdAt: binding.createdAt,
  });

  const snapshotFor = (contactId: string): { binding: QQBindingView | null; configured: boolean; status: QQStatus } => {
    const binding = byContact(contactId);
    return { binding: binding === null ? null : viewOf(binding), configured: configured(), status: gatewayStatus() };
  };

  const setFlags = (id: string, patch: { enabled?: boolean; proactive?: boolean }): boolean => {
    const binding = byId(id);
    if (binding === null) return false;
    if (patch.enabled !== undefined) binding.enabled = patch.enabled;
    if (patch.proactive !== undefined) binding.proactive = patch.proactive;
    persist();
    return true;
  };

  const disconnect = (id: string): boolean => {
    hydrate();
    const before = bindings.length;
    bindings = bindings.filter((b) => b.id !== id);
    if (bindings.length === before) return false;
    persist();
    return true;
  };

  const summary = (): {
    configured: boolean; appId: string; status: QQStatus; lastError: string;
    bindings: number; max: number; active: number; proactive: number;
    trouble: Array<{ contactId: string; name: string; lastError: string }>;
  } => {
    hydrate();
    const c = readCredentials();
    const trouble: Array<{ contactId: string; name: string; lastError: string }> = [];
    for (const binding of bindings) {
      if (binding.lastError !== "" || !binding.enabled) {
        if (trouble.length < 3) {
          trouble.push({
            contactId: binding.contactId,
            name: getContact(binding.contactId)?.name || binding.contactId,
            lastError: binding.lastError,
          });
        }
      }
    }
    return {
      configured: configured(),
      appId: c.appId === "" ? "" : redact(c.appId),
      status: gatewayStatus(),
      lastError: problem !== "" ? problem : trouble[0]?.lastError ?? "",
      bindings: bindings.length,
      max: BINDING_CAP,
      active: bindings.filter((b) => b.enabled).length,
      proactive: bindings.filter((b) => b.proactive && b.enabled).length,
      trouble,
    };
  };

  // ── 凭据 ────────────────────────────────────────────────────
  const setCredentials = (patch: { appId?: unknown; clientSecret?: unknown; enabled?: unknown }): { configured: boolean } => {
    const current = readCredentials();
    const next: Credentials = {
      appId: patch.appId !== undefined ? asText(patch.appId) : current.appId,
      // 掩码回显那串不能写回去：点「保存」时密钥栏没动，界面上带的就是掩码。
      clientSecret: patch.clientSecret !== undefined && !asText(patch.clientSecret).includes("••")
        ? asText(patch.clientSecret)
        : current.clientSecret,
      enabled: patch.enabled !== undefined ? patch.enabled === true : current.enabled,
    };
    kvSet(KV_CREDENTIALS, JSON.stringify(next));
    // 换凭据 = 换身份：token、会话、心跳全部作废重来，
    // 否则旧 token 会继续收新机器人不该收的消息。
    token.invalidate();
    gateway.forget();
    gateway.close();
    problem = "";
    gateway.phase = next.enabled && next.appId !== "" && next.clientSecret !== "" ? "connecting" : "not-configured";
    if (gateway.phase === "connecting") void gateway.open();
    return { configured: configured() };
  };
  // ── 认领窗口 ────────────────────────────────────────────────
  const beginBind = (contactId: string): { attemptId: string; keyword: string; expiresInMs: number } => {
    hydrate();
    // 与 wechat.beginBind 同一道闸：联系人不存在就拒绝，别把绑定挂到一个幽灵 id 上。
    // 否则之后每条入站消息都会在没有 contacts 行的 contact_id 下建轮次、调模型、写消息——
    // 那些行按 contact 过滤看不见也删不掉，每一条都在烧配额。
    if (getContact(contactId) === null) throw new Error("联系人不存在");
    if (!configured()) throw new Error("先填好 QQ 机器人的 AppID 与 AppSecret，并勾上启用");
    if (byContact(contactId) === null && gateway.phase !== "connected") void gateway.open();
    // 暗号是固定的两个字，留着上一条窗口就等于让上一次点击还能被认领——所以一次只留一条。
    windows.clear();
    const window: BindWindow = {
      id: shortId(),
      contactId,
      expiresAt: clock() + BIND_TTL_MS,
      status: "open",
      error: "",
    };
    windows.set(window.id, window);
    return { attemptId: window.id, keyword: BIND_PHRASE, expiresInMs: BIND_TTL_MS };
  };

  const pollBind = (attemptId: string): { status: "waiting" | "bound" | "gone"; error: string; binding?: QQBindingView } => {
    hydrate();
    expireWindows();
    const window = windows.get(attemptId);
    if (window === undefined) {
      return { status: "gone", error: "认领窗口已经关掉（过期或重新点过绑定），再点一次「去绑定」" };
    }
    if (window.status === "claimed") {
      const binding = byContact(window.contactId);
      return { status: "bound", error: "", ...(binding !== null ? { binding: viewOf(binding) } : {}) };
    }
    return { status: "waiting", error: window.error };
  };

  // ── 扫码拿凭据（官方推荐这条；手填 AppID/AppSecret 是兜底）──
  /**
   * 一次只留一个待扫任务：再点「扫码」就是换一张码、旧的作废。两条并存会出现
   * 「扫了新码、轮询却认了旧的那把钥匙」——解不开密文还查不出为什么。
   *
   * bindKey 只留在这边，不回界面：它是解开 QQ 返回的那份 AppSecret 的 AES-256 钥匙，
   * 交给浏览器等于把凭据和解密钥匙放在同一个地方。
   */
  const platformCall = async (path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const started = Date.now();
    const response = await http(PLATFORM_ORIGIN + path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const retcode = Number(data.retcode ?? 0);
    if (!response.ok || (Number.isFinite(retcode) && retcode !== 0)) {
      const message = asText(data.msg) || asText(data.message) || `HTTP ${response.status}`;
      logModelCall({
        purpose: "qq", ok: false, code: "QQ_BIND_" + String(retcode), model: "qqbot",
        url: path, elapsedMs: Date.now() - started, message: message.slice(0, 300),
      });
      throw new Error(message === "" ? "QQ 开放平台拒绝了这次请求" : message);
    }
    logModelCall({ purpose: "qq", ok: true, model: "qqbot", url: path, elapsedMs: Date.now() - started });
    const inner = data.data;
    return inner !== null && typeof inner === "object" ? inner as Record<string, unknown> : {};
  };

  /** 官方那份密文的形状是 base64(12B nonce + 密文 + 16B GCM tag)，钥匙就是建任务时上交的那把。 */
  const decryptSecret = (encrypted: string, bindKey: string): string => {
    const key = Buffer.from(bindKey, "base64");
    const raw = Buffer.from(encrypted, "base64");
    if (key.length !== 32) throw new Error("绑定密钥长度不对，重新扫一次码");
    if (raw.length <= 28) throw new Error("QQ 返回的凭证太短，重新扫一次码");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    try {
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8").trim();
    } catch {
      // GCM 校验不过 = 这把钥匙和那份密文不配对，多半是任务已被新的取代；
      // 说这个比抛一句「解密失败」有用。
      throw new Error("解不开 QQ 返回的凭证（绑定任务大概已被新的取代），请重新扫码");
    }
  };

  const beginCredentialQr = async (): Promise<{ taskId: string; qrContent: string; expiresInMs: number }> => {
    const bindKey = Buffer.from(randomBytes(32)).toString("base64");
    const data = await platformCall("/lite/create_bind_task", { key: bindKey });
    const taskId = asText(data.task_id);
    if (taskId === "") throw new Error("QQ 没有返回绑定任务 id，请重试");
    qrTask = { taskId, bindKey, expiresAt: clock() + BIND_TTL_MS };
    return {
      taskId,
      // 手机 QQ 扫这个链接就能建/绑机器人；它不是图片，界面自己渲染成二维码。
      qrContent: `${PLATFORM_ORIGIN}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`,
      expiresInMs: BIND_TTL_MS,
    };
  };

  /**
   * 轮一次扫码结果。完成时把凭据存下来并连上网关（走 setCredentials 那条：旧 token 与旧会话一起作废），
   * 回给界面的只有脱敏 AppID——AppSecret 全程不进前端。
   */
  const pollCredentialQr = async (taskId: string): Promise<{
    status: "waiting" | "created" | "expired" | "gone"; error: string; appId?: string;
  }> => {
    const wanted = asText(taskId);
    if (qrTask === null || qrTask.taskId !== wanted) {
      return { status: "gone", error: "这个二维码已经作废，请重新扫码" };
    }
    if (qrTask.expiresAt <= clock()) {
      qrTask = null;
      return { status: "expired", error: "二维码已过期，请重新扫" };
    }
    const data = await platformCall("/lite/poll_bind_result", { task_id: wanted });
    const status = Number(data.status ?? QR_NONE);
    if (status === QR_EXPIRED) {
      qrTask = null;
      return { status: "expired", error: "二维码已过期，请重新扫" };
    }
    if (status !== QR_COMPLETED) return { status: "waiting", error: "" };
    const appId = asText(data.bot_appid);
    const encrypted = asText(data.bot_encrypt_secret);
    if (appId === "" || encrypted === "") {
      qrTask = null;
      return { status: "gone", error: "扫码成功了，但 QQ 没给完整的凭据，请重新扫一次" };
    }
    const bindKey = qrTask.bindKey;
    qrTask = null; // 一个任务只认一次：成功之后再轮询就是 gone
    let secret = "";
    try {
      secret = decryptSecret(encrypted, bindKey);
    } catch (error) {
      return { status: "gone", error: error instanceof Error ? error.message : String(error) };
    }
    if (secret === "") return { status: "gone", error: "解出来的 AppSecret 是空的，请重新扫码" };
    setCredentials({ appId, clientSecret: secret, enabled: true });
    return { status: "created", error: "", appId: redact(appId) };
  };
  // ── 生命周期 ────────────────────────────────────────────────
  const startAll = (): void => {
    hydrate();
    if (configured()) void gateway.open();
  };

  /** 出厂重置：凭据与绑定一起抹，界面上的「已连接」不许留着说假话。 */
  const clearAll = (): void => {
    gateway.close();
    gateway.forget();
    windows.clear();
    replyCounters.clear();
    bindings = [];
    hydrated = true;
    problem = "";
    qrTask = null;
    token.invalidate();
    kvSet(KV_BINDINGS, JSON.stringify({ version: 1, bindings: [] }));
    kvSet(KV_CREDENTIALS, JSON.stringify({ appId: "", clientSecret: "", enabled: false }));
    gateway.phase = "not-configured";
  };

  return {
    deliverToContact,
    beginBind,
    pollBind,
    snapshotFor,
    summary,
    setCredentials,
    beginCredentialQr,
    pollCredentialQr,
    setFlags,
    disconnect,
    disconnectByContact: (contactId: string): boolean => {
      const binding = byContact(contactId);
      return binding === null ? false : disconnect(binding.id);
    },
    startAll,
    /** 让出当家位：断开连接但可逆——租约抢回来时 startAll 还要能连。 */
    stopAll: (): void => {
      gateway.evacuate();
    },
    dispose: (): void => {
      disposed = true;
      gateway.close();
    },
    clearAll,
    gatewayStatus,
    /** 网关侧最近一条错误：连接断了界面要能说出为什么（冒烟也靠它断言）。 */
    lastGatewayError: (): string => problem,
    /** 冒烟与状态页用它核对分段上限。 */
    splitQqText,
  };
}

/** 进程级单例（与 wechat 一致：只有当家进程 startAll，退出时 dispose）。 */
export const qq = createQQService();
