// ── 微信通道：腾讯 iLink 机器人接口 ─────────────────────────────
//
// 形态：桌面进程直连 iLink——出站是普通 HTTPS，入站是这个进程自己开的长轮询。
// 没有公网回调，也没有第三方协议库。一个联系人绑一个机器人会话；这一版只送文字。
//
// 三条来自实测的硬约束，动它之前先读：
//   · 发送必须带 context_token。它只随「用户从微信发来的那条消息」下发，
//     所以扫码成功只是开始——用户得先在微信里说一句话，这边才回得出去；
//   · ret = -2 是会话上下文过期：重读一次库里的最新 token 再试一次，
//     还失败就要求用户再发一条（这是真断了，不许静默吞掉）；
//   · errcode = -14 是绑定凭证失效：停掉收件循环，要求重新扫码。
//
// 投递的公共部分（切段、去重窗口、单飞凭证、顺序发送）在 channels/delivery.ts，
// 这里只管 iLink 自己的报文与状态机。

import { randomBytes } from "node:crypto";
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

const KV_LINKS = "wechat.links";
const ILINK_ORIGIN = "https://ilinkai.weixin.qq.com";
const PROTOCOL_VERSION = "1.0.0";
/** 远端对单条正文有大小上限，超了整条发不出去，所以按段落切开送。 */
const CHUNK_UNITS = 3800;
const LINK_CAP = 40;
const SEEN_LIMIT = 120;
const BIND_TTL_MS = 8 * 60_000;
/** 收件长轮询失败后的退避上限；正常一轮结束就复位。 */
const POLL_WAIT_CEILING_MS = 30_000;
/** 短请求必须有界：对端接受连接却不响应时，默认会吊着用户好几分钟。 */
const REQUEST_TIMEOUT_MS = 20_000;
const BIND_POLL_FLOOR_MS = 900;
const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_TICKET_TTL_MS = 10 * 60_000;
const TYPING_GIVE_UP_MS = 120_000;
const TYPING_WATCH_STEP_MS = 2_500;
/** iLink 的两个业务码（见顶注）。 */
const RET_CONTEXT_EXPIRED = -2;
const ERR_CREDENTIAL_EXPIRED = -14;

export type WeChatLink = {
  id: string;
  contactId: string;
  accountId: string;
  linkedUserId: string;
  baseUrl: string;
  enabled: boolean;
  proactive: boolean;
  cursor: string;
  recentMessageIds: string[];
  createdAt: string;
  lastError: string;
  lastReceivedAt: string;
  lastSentAt: string;
};

/** 落库那份比界面看到的多两个凭证字段。 */
type StoredLink = WeChatLink & { token: string; contextToken: string };

type Store = {
  version: 1;
  links: StoredLink[];
};

/** 一次扫码会话（只活在内存里，进程退出即作废）。 */
type BindSession = {
  id: string;
  contactId: string;
  baseUrl: string;
  qrKey: string;
  qrContent: string;
  status: "waiting" | "scanned" | "error";
  error: string;
  expiresAt: number;
  lastPollAt: number;
};

type TypingSession = {
  turnId: string;
  ticket: string;
  keepalive: ReturnType<typeof setInterval> | null;
};

const emptyStore = (): Store => ({ version: 1, links: [] });

/** 本地 id：6 字节随机十六进制，够短也够不撞（同库里最多几十条）。 */
const newId = (): string => randomBytes(6).toString("hex");

/** 微信正文按空行切段，段内超长再硬切。 */
export function splitWechatText(value: string): string[] {
  return chunkText(value, CHUNK_UNITS);
}

/** 从库里那一包 JSON 还原绑定；缺字段走默认值，整包坏了当空处理。 */
function parseLinks(raw: string | null, limit: number): Map<string, StoredLink> {
  const out = new Map<string, StoredLink>();
  if (raw === null || raw === "") return out;
  let parsed: { links?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw) as { links?: unknown };
  } catch {
    return out;
  }
  const list = Array.isArray(parsed?.links) ? parsed.links : [];
  for (const item of list.slice(0, limit)) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = asText(row.id);
    const contactId = asText(row.contactId);
    if (id === "" || contactId === "") continue;
    out.set(id, {
      id,
      contactId,
      accountId: asText(row.accountId),
      linkedUserId: asText(row.linkedUserId),
      baseUrl: asText(row.baseUrl) || ILINK_ORIGIN,
      enabled: row.enabled !== false,
      proactive: row.proactive === true,
      cursor: asText(row.cursor),
      recentMessageIds: (Array.isArray(row.recentMessageIds) ? row.recentMessageIds : [])
        .map((key) => asText(key))
        .filter((key) => key !== "")
        .slice(-SEEN_LIMIT),
      createdAt: asText(row.createdAt),
      lastError: asText(row.lastError),
      lastReceivedAt: asText(row.lastReceivedAt),
      lastSentAt: asText(row.lastSentAt),
      token: asText(row.token),
      contextToken: asText(row.contextToken),
    });
  }
  return out;
}

/**
 * 绑定表在内存里的那一份，以及它跟 kv 的对齐规则。
 *
 * 为什么不能「改了就直接整包写回」：同一台机器可能开着两个窗口，用的是同一个库。
 * 直接覆盖会把另一个窗口刚绑上的那条抹掉。对齐规则是——以库为准，只把本进程
 * **改过或新增**的那几条盖上去，再落地本进程发起的删除：
 *   · 别人绑的 → 下一次对齐就能看见，收件循环跟着起来；
 *   · 我们改的 → 不会被别人的旧副本盖回去；
 *   · 我们删的 → 不会因为库里还有就复活（墓碑）。
 */
class LinkTable {
  private rows: StoredLink[] = [];
  private synced = new Map<string, string>();
  private tombstones = new Set<string>();
  private opened = false;
  private readonly read: () => string | null;
  private readonly write: (value: string) => void;
  private readonly limit: number;

  constructor(options: { read: () => string | null; write: (value: string) => void; limit: number }) {
    this.read = options.read;
    this.write = options.write;
    this.limit = options.limit;
  }

  /** 首次读库；此后的重新读只发生在 merge。 */
  open(): void {
    if (this.opened) return;
    const incoming = parseLinks(this.read(), this.limit);
    this.rows = [...incoming.values()];
    this.markSynced(incoming);
    this.opened = true;
  }

  all(): StoredLink[] {
    this.open();
    return this.rows;
  }

  byId(id: string): StoredLink | null {
    this.open();
    return this.rows.find((row) => row.id === id) ?? null;
  }

  byContact(contactId: string): StoredLink | null {
    this.open();
    return this.rows.find((row) => row.contactId === contactId) ?? null;
  }

  keep(row: StoredLink): void {
    this.open();
    this.rows = [...this.rows.filter((existing) => existing.id !== row.id), row];
    if (this.rows.length > this.limit) this.rows = this.rows.slice(-this.limit);
  }

  drop(id: string): void {
    this.open();
    this.rows = this.rows.filter((row) => row.id !== id);
    this.tombstones.add(id);
  }

  /** 重复扫码：这位联系人先前的绑定全作废（留着会出现两条并存）。 */
  dropByContact(contactId: string): string[] {
    this.open();
    const removed = this.rows.filter((row) => row.contactId === contactId).map((row) => row.id);
    for (const id of removed) this.tombstones.add(id);
    this.rows = this.rows.filter((row) => row.contactId !== contactId);
    return removed;
  }

  /** 只对齐不写：让别的窗口刚刷新的凭证立刻对投递可见。 */
  merge(): void {
    this.open();
    const merged = parseLinks(this.read(), this.limit);
    for (const row of this.rows) {
      if (this.synced.get(row.id) !== JSON.stringify(row)) merged.set(row.id, row);
    }
    for (const id of this.tombstones) merged.delete(id);
    this.rows = [...merged.values()].slice(0, this.limit);
    this.markSynced(merged);
  }

  /** 对齐 + 写回；这次删除已经落库，墓碑可以清掉。 */
  save(): void {
    this.merge();
    this.write(JSON.stringify({ version: 1, links: this.rows } as Store));
    this.tombstones.clear();
  }

  /** 出厂重置：不读库，把当前视图当成全部。 */
  reset(): void {
    this.rows = [];
    this.markSynced(new Map());
    this.tombstones.clear();
    this.opened = true;
    this.write(JSON.stringify(emptyStore()));
  }

  private markSynced(rows: Map<string, StoredLink>): void {
    this.synced = new Map([...rows].map(([id, row]) => [id, JSON.stringify(row)]));
  }
}

export function createWeChatService(deps: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const http = deps.fetchImpl ?? globalThis.fetch;
  const clock = deps.now ?? ((): number => Date.now());

  const links = new LinkTable({
    read: () => kvGet(KV_LINKS),
    write: (value) => kvSet(KV_LINKS, value),
    limit: LINK_CAP,
  });

  const pollers = new Map<string, AbortController>();
  const sessions = new Map<string, BindSession>();
  const tickets = new Map<string, SingleFlight<string>>();
  const typing = new Map<string, TypingSession>();
  /** 已到终态的回合：迟到的那一拍不许再把「正在输入」点亮。 */
  const settledTurns = new Set<string>();
  let disposed = false;

  // ── 与 iLink 说话 ───────────────────────────────────────────
  /**
   * 一次 iLink 调用。带 token 的会自动补上那三个头（AuthorizationType / Authorization /
   * X-WECHAT-UIN）——最后一个是对端要求的随机串，每次现造。
   */
  const callIlink = async (args: {
    base: string;
    path: string;
    body: Record<string, unknown>;
    token?: string;
    signal?: AbortSignal;
    /** 0 = 不设超时（收件长轮询那条由它自己的 controller 管生命周期）。 */
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> => {
    const url = new URL(args.path, args.base.replace(/\/+$/, "") + "/");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (args.token !== undefined) {
      headers.AuthorizationType = "ilink_bot_token";
      headers.Authorization = "Bearer " + args.token;
      headers["X-WECHAT-UIN"] = Buffer.from(String(Math.floor(Math.random() * 0x1_0000_0000))).toString("base64");
    }
    const lifetime = args.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const timeout = lifetime > 0 ? AbortSignal.timeout(lifetime) : null;
    const guard = args.signal !== undefined && timeout !== null
      ? AbortSignal.any([args.signal, timeout])
      : args.signal ?? timeout ?? undefined;
    const response = await http(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(args.body),
      signal: guard,
    });
    if (!response.ok) throw new Error(`微信接口 ${args.path} HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };

  /** 带绑定凭证调用；没有凭证就别发（说明没扫过码或已失效）。 */
  const callAsLink = (link: StoredLink, path: string, body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) => {
    if (link.token === "") throw new Error("微信连接凭证不可用，请重新扫码绑定");
    return callIlink({ base: link.baseUrl, path, body, token: link.token, signal: opts.signal, timeoutMs: opts.timeoutMs });
  };

/** iLink 的业务码在 ret 里：非零一律当失败，且必须把 errmsg 带出来。 */
  const requireOk = (reply: Record<string, unknown>, what: string): void => {
    const code = Number(reply.ret ?? 0);
    if (code === 0) return;
    throw new Error(`${what}：${asText(reply.errmsg) || "ret=" + String(code)}`);
  };
  /** 发一条 item。上下文过期时重读库里的新 token 再试一次，然后才认输。 */
  const postItem = async (
    link: StoredLink,
    item: Record<string, unknown>,
    opts: { contextToken?: string; signal?: AbortSignal } = {},
  ): Promise<void> => {
    let contextToken = opts.contextToken !== undefined && opts.contextToken !== "" ? opts.contextToken : link.contextToken;
    if (contextToken === "") throw new Error("请先从微信向该机器人发一条消息，建立会话后才能回复");
    const attempt = (token: string) => callAsLink(link, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: link.linkedUserId,
        client_id: "xiaomo-" + newId(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: token,
      },
      base_info: { channel_version: PROTOCOL_VERSION },
    }, { signal: opts.signal });
    let reply = await attempt(contextToken);
    if (Number(reply.ret) === RET_CONTEXT_EXPIRED) {
      links.merge(); // 收件循环可能刚好刷新过 token——重读一次再试
      const fresh = links.byId(link.id);
      if (fresh === null || fresh.contextToken === "" || fresh.contextToken === contextToken) {
        throw new Error("微信会话上下文已过期，请从微信再发一条消息");
      }
      contextToken = fresh.contextToken;
      reply = await attempt(contextToken);
    }
    requireOk(reply, "微信消息发送失败");
  };

  // ── 「对方正在输入…」────────────────────────────────────────
  // 先 getconfig 换一张 typing_ticket，再 sendtyping status=1 点亮 / 2 收停，期间每 5 秒续一次。
  // 纯装饰：任何一步失败都静默降级，绝不打扰对话本身。
  const ticketFor = (link: StoredLink): Promise<string> => {
    let slot = tickets.get(link.id);
    if (slot === undefined) {
      slot = new SingleFlight<string>(
        async () => {
          const reply = await callAsLink(link, "ilink/bot/getconfig", {
            ilink_user_id: link.linkedUserId,
            ...(link.contextToken !== "" ? { context_token: link.contextToken } : {}),
            base_info: { channel_version: PROTOCOL_VERSION },
          });
          if (Number(reply.ret ?? 0) !== 0) throw new Error("微信输入状态凭证获取失败");
          const ticket = asText(reply.typing_ticket);
          if (ticket === "") throw new Error("微信没有返回输入状态凭证");
          return ticket;
        },
        () => TYPING_TICKET_TTL_MS,
        clock,
      );
      tickets.set(link.id, slot);
    }
    return slot.get();
  };

  /** 把一条超时回合记进「别再点亮」名单，顺手控制它别无限长大。 */
  const settleTurn = (turnId: string): void => {
    if (turnId === "") return;
    settledTurns.add(turnId);
    if (settledTurns.size <= 200) return;
    for (const old of settledTurns) {
      if (old === turnId) continue;
      settledTurns.delete(old);
      break;
    }
  };

  /** 收停。给了 turnId 就只停那一拍（已经被新回合接管的不管）；不给就是「谁在打字停谁」。 */
  const stopTyping = async (linkId: string, turnId = ""): Promise<void> => {
    if (turnId !== "") settleTurn(turnId);
    const session = typing.get(linkId);
    if (session === undefined) return;
    if (turnId !== "" && session.turnId !== turnId) return;
    typing.delete(linkId);
    if (session.keepalive !== null) clearInterval(session.keepalive);
    if (session.ticket === "") return;
    const link = links.byId(linkId);
    if (link === null) return;
    try {
      await pushTyping(link, session.ticket, false);
    } catch {
      tickets.delete(linkId);
    }
  };

  const pushTyping = async (link: StoredLink, ticket: string, on: boolean): Promise<void> => {
    const reply = await callAsLink(link, "ilink/bot/sendtyping", {
      ilink_user_id: link.linkedUserId,
      typing_ticket: ticket,
      status: on ? 1 : 2,
      base_info: { channel_version: PROTOCOL_VERSION },
    });
    requireOk(reply, "微信输入状态同步失败");
  };

  const startTyping = (link: StoredLink, turnId: string): void => {
    if (turnId === "" || settledTurns.has(turnId)) return;
    void (async () => {
      await stopTyping(link.id); // 一说话就把上一拍收掉，同一时刻只亮一个
      if (settledTurns.has(turnId)) return;
      let ticket = "";
      try {
        ticket = await ticketFor(link);
      } catch {
        tickets.delete(link.id);
        return;
      }
      if (settledTurns.has(turnId) || typing.has(link.id)) return;
      const session: TypingSession = { turnId, ticket, keepalive: null };
      typing.set(link.id, session);
      try {
        await pushTyping(link, ticket, true);
      } catch {
        tickets.delete(link.id);
        if (typing.get(link.id) === session) typing.delete(link.id);
        return;
      }
      if (settledTurns.has(turnId)) {
        void stopTyping(link.id, turnId);
        return;
      }
      session.keepalive = setInterval(() => {
        if (typing.get(link.id) !== session) {
          if (session.keepalive !== null) clearInterval(session.keepalive);
          return;
        }
        const current = links.byId(link.id);
        if (current === null || !current.enabled) {
          void stopTyping(link.id);
          return;
        }
        void pushTyping(current, ticket, true).catch(() => tickets.delete(link.id));
      }, TYPING_KEEPALIVE_MS);
      session.keepalive.unref?.();
    })();
  };

  /** 处理单到终态（尤其 failed——失败不会有投递来收停）之后把输入状态收掉。 */
  const watchTurn = async (linkId: string, turnId: string): Promise<void> => {
    const { getTurn } = await import("./agent.ts");
    const deadline = clock() + TYPING_GIVE_UP_MS;
    while (clock() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TYPING_WATCH_STEP_MS));
      const session = typing.get(linkId);
      if (session === undefined || session.turnId !== turnId) return; // 已被投递收掉或被新回合接管
      const turn = getTurn(turnId);
      if (turn === null || turn.status === "done" || turn.status === "failed") break;
    }
    await stopTyping(linkId, turnId);
  };

  // ── 出站 ────────────────────────────────────────────────────
  /** 把一句话送到这位联系人的微信。没绑定就静默跳过；失败只记账，不抛错。 */
  const deliverToContact = async (
    contactId: string,
    text: string,
    opts: { proactive?: boolean } = {},
  ): Promise<void> => {
    const link = links.byContact(contactId);
    if (link === null || !deliveryAllowed(link, opts.proactive === true)) return;
    const segments = splitWechatText(text);
    if (segments.length === 0) return;
    const startedAt = clock();
    await deliverOutbound({
      segments,
      send: (segment) => postItem(link, { type: 1, text_item: { text: segment } }),
      elapsed: () => clock() - startedAt,
      onDelivered: () => {
        link.lastSentAt = new Date(clock()).toISOString();
        link.lastError = "";
        links.save();
        // 话都送到了，微信那边的「对方正在输入…」该收了。
        void stopTyping(link.id);
      },
      onFailed: (message) => {
        link.lastError = message;
        links.save();
        console.warn(`[wechat] 投递失败（${contactId}）：${message}`);
      },
      log: (ok, message, elapsedMs) => logModelCall({
        purpose: "wechat",
        ok,
        ...(ok ? {} : { code: "WECHAT_DELIVER" }),
        model: "ilink",
        url: link.baseUrl,
        elapsedMs,
        ...(message === "" ? {} : { message }),
        contactId,
      }),
    });
  };

  // ── 入站 ────────────────────────────────────────────────────
  /** iLink 报文的去重键：四个字段拼起来。数字字段必须先转字符串。 */
  const idempotencyKey = (message: Record<string, unknown>): string =>
    [message.from_user_id, message.message_id, message.seq, message.create_time_ms].map((part) => asText(part)).join("#");

  /** 从 item_list 里取文字：type 1 是文本、3 是语音转写。 */
  const extractText = (message: Record<string, unknown>): string => {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    const parts: string[] = [];
    for (const raw of items) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const textItem = (item.text_item ?? item.textItem) as Record<string, unknown> | undefined;
      const voiceItem = (item.voice_item ?? item.voiceItem) as Record<string, unknown> | undefined;
      if (Number(item.type) === 1 || textItem !== undefined) parts.push(asText(textItem?.text));
      else if (Number(item.type) === 3 || voiceItem !== undefined) parts.push(asText(voiceItem?.text));
    }
    return parts.filter((part) => part !== "").join("\n").slice(0, 4000);
  };

  const acceptInbound = async (link: StoredLink, message: Record<string, unknown>): Promise<void> => {
    if (Number(message.message_type) === 2) return; // 机器人自己发出去的回声
    const from = asText(message.from_user_id);
    if (from === "" || from !== link.linkedUserId) return; // 不是绑定的那位
    const key = idempotencyKey(message);
    const seen = new SeenKeys(SEEN_LIMIT, link.recentMessageIds);
    if (key === "" || seen.has(key)) return;
    const contextToken = asText(message.context_token);
    if (contextToken !== "") link.contextToken = contextToken;
    const text = extractText(message);
    if (text === "") return;
    const channel = getChannel("web");
    if (channel === undefined) return;
    // 第四参数记来源：这句话是微信里说的，不是本机界面打的（记忆抽取要按来源套外壳）。
    const { turnId } = channel.receive(text, link.contactId, undefined, "wechat");
    seen.remember(key);
    link.recentMessageIds = seen.toArray();
    link.lastReceivedAt = new Date(clock()).toISOString();
    link.lastError = "";
    links.save();
    // 回复不在这里发：agent 在轮次结束时统一镜像（含重试那条路）。这里只点亮输入状态。
    startTyping(link, turnId);
    void watchTurn(link.id, turnId).catch(() => { /* 兜底收停失败不打扰对话 */ });
  };

  // ── 收件长轮询 ──────────────────────────────────────────────
  const watchInbox = (linkId: string): void => {
    if (disposed || pollers.has(linkId)) return;
    const link = links.byId(linkId);
    if (link === null || !link.enabled) return;
    const controller = new AbortController();
    pollers.set(linkId, controller);
    void (async () => {
      let wait = 1_000;
      while (!disposed && !controller.signal.aborted) {
        const current = links.byId(linkId);
        if (current === null || !current.enabled) break;
        try {
          const reply = await callAsLink(current, "ilink/bot/getupdates", {
            get_updates_buf: current.cursor,
            base_info: { channel_version: PROTOCOL_VERSION },
          }, { signal: controller.signal, timeoutMs: 0 });
          if (Number(reply.errcode) === ERR_CREDENTIAL_EXPIRED) {
            current.lastError = "微信连接已过期，请重新扫码绑定";
            links.save();
            break;
          }
          const batch = Array.isArray(reply.msgs) ? reply.msgs : [];
          for (const raw of batch) {
            if (raw === null || typeof raw !== "object") continue;
            await acceptInbound(current, raw as Record<string, unknown>).catch((error: unknown) => {
              current.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
              links.save();
            });
          }
          const cursor = asText(reply.get_updates_buf);
          if (cursor !== "" && cursor !== current.cursor) {
            current.cursor = cursor;
            links.save();
          }
          wait = 1_000; // 这一轮正常，退避复位
        } catch (error) {
          if (controller.signal.aborted) break;
          const current2 = links.byId(linkId);
          if (current2 !== null) {
            current2.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
            links.save();
          }
          await new Promise((resolve) => setTimeout(resolve, wait));
          wait = Math.min(wait * 2, POLL_WAIT_CEILING_MS);
        }
      }
      // 只清属于自己这条循环的条目：用同一个 linkId 重启过的话不能误删新循环。
      if (pollers.get(linkId) === controller) pollers.delete(linkId);
    })();
  };

  // ── 对外视图 ────────────────────────────────────────────────
  /** 开着却没有循环在跑 = 收不到消息，和报错一样归入「需要处理」。 */
  const statusOf = (link: StoredLink): "connected" | "disabled" | "attention" | "paused" => {
    if (!link.enabled) return "disabled";
    if (pollers.has(link.id)) return "connected";
    return link.lastError !== "" ? "attention" : "paused";
  };

  const viewOf = (link: StoredLink) => ({
    id: link.id,
    contactId: link.contactId,
    accountId: redact(link.accountId),
    linkedUserId: redact(link.linkedUserId),
    enabled: link.enabled,
    proactive: link.proactive,
    status: statusOf(link),
    hasContext: link.contextToken !== "",
    lastError: link.lastError,
    lastReceivedAt: link.lastReceivedAt,
    lastSentAt: link.lastSentAt,
    createdAt: link.createdAt,
  });

  // ── 扫码绑定 ────────────────────────────────────────────────
  const beginBind = async (contactId: string): Promise<{ attemptId: string; qrContent: string; status: string }> => {
    if (getContact(contactId) === null) throw new Error("联系人不存在");
    const stale = [...sessions.values()].find((session) => session.contactId === contactId);
    if (stale !== undefined) sessions.delete(stale.id);
    const reply = await callIlink({ base: ILINK_ORIGIN, path: "ilink/bot/get_bot_qrcode", body: { bot_type: "3" } });
    const qrKey = asText(reply.qrcode);
    const qrContent = asText(reply.qrcode_img_content);
    if (qrKey === "" || qrContent === "") throw new Error("微信没有返回可用二维码，请重试");
    const session: BindSession = {
      id: newId(),
      contactId,
      baseUrl: ILINK_ORIGIN,
      qrKey,
      qrContent,
      status: "waiting",
      error: "",
      expiresAt: clock() + BIND_TTL_MS,
      lastPollAt: 0,
    };
    sessions.set(session.id, session);
    return { attemptId: session.id, qrContent: session.qrContent, status: session.status };
  };

  /** 前端轮一次扫码结果；扫上了就把绑定落库并起收件循环。 */
  const pollBind = async (attemptId: string): Promise<{ status: string; error: string; link?: ReturnType<typeof viewOf> }> => {
    const session = sessions.get(attemptId);
    if (session === undefined) return { status: "gone", error: "二维码会话已结束，请重新生成" };
    if (session.status === "error") return { status: "error", error: session.error };
    if (clock() - session.lastPollAt < BIND_POLL_FLOOR_MS) {
      return { status: session.status, error: session.error };
    }
    session.lastPollAt = clock();
    try {
      const reply = await callIlink({
        base: session.baseUrl,
        path: "ilink/bot/get_qrcode_status",
        body: { qrcode: session.qrKey },
      });
      const state = asText(reply.status).toLowerCase();
      if (state === "confirmed") {
        const token = asText(reply.bot_token ?? reply.botToken);
        const accountId = asText(reply.ilink_bot_id ?? reply.ilinkBotId);
        const linkedUserId = asText(reply.ilink_user_id ?? reply.ilinkUserId);
        if (token === "" || accountId === "" || linkedUserId === "") {
          throw new Error("微信扫码确认未返回完整绑定信息，请重新生成二维码");
        }
        const baseUrl = asText(reply.baseurl ?? reply.base_url) || ILINK_ORIGIN;
        // 同一位联系人的旧绑定先停掉再落新的——两条并存会把同一句话发两遍。
        for (const id of links.dropByContact(session.contactId)) {
          pollers.get(id)?.abort();
          pollers.delete(id);
        }
        const link: StoredLink = {
          id: newId(),
          contactId: session.contactId,
          accountId,
          linkedUserId,
          baseUrl,
          enabled: true,
          proactive: false,
          cursor: "",
          recentMessageIds: [],
          createdAt: new Date(clock()).toISOString(),
          lastError: "",
          lastReceivedAt: "",
          lastSentAt: "",
          token,
          contextToken: "",
        };
        links.keep(link);
        links.save();
        sessions.delete(attemptId);
        watchInbox(link.id);
        return { status: "confirmed", error: "", link: viewOf(link) };
      }
      if (state === "expired") {
        sessions.delete(attemptId);
        return { status: "expired", error: "二维码已过期，请重新生成" };
      }
      session.status = state === "scaned" || state === "scanned" ? "scanned" : "waiting";
      return { status: session.status, error: "" };
    } catch (error) {
      session.status = "error";
      session.error = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      return { status: "error", error: session.error };
    }
  };

  const snapshotFor = (contactId: string) => {
    const link = links.byContact(contactId);
    return { link: link === null ? null : viewOf(link) };
  };

  /** 全局概况：状态页总览看这个（不属于某一位联系人的连接态）。 */
  const summary = () => {
    const by: Record<"connected" | "disabled" | "attention" | "paused", number> = {
      connected: 0, disabled: 0, attention: 0, paused: 0,
    };
    const trouble: Array<{ contactId: string; name: string; lastError: string }> = [];
    for (const link of links.all()) {
      const status = statusOf(link);
      by[status] += 1;
      if ((status === "attention" || status === "paused") && trouble.length < 3) {
        trouble.push({ contactId: link.contactId, name: getContact(link.contactId)?.name || link.contactId, lastError: link.lastError });
      }
    }
    return {
      links: links.all().length,
      max: LINK_CAP,
      ...by,
      proactive: links.all().filter((link) => link.proactive && link.enabled).length,
      trouble,
    };
  };

  // ── 开关与生命周期 ──────────────────────────────────────────
  const setFlags = (id: string, patch: { enabled?: boolean; proactive?: boolean }): boolean => {
    const link = links.byId(id);
    if (link === null) return false;
    if (patch.enabled !== undefined) link.enabled = patch.enabled;
    if (patch.proactive !== undefined) link.proactive = patch.proactive;
    links.save();
    if (!link.enabled) {
      pollers.get(link.id)?.abort();
      pollers.delete(link.id); // 立刻腾位置，允许马上重新启用
      void stopTyping(link.id);
    } else {
      watchInbox(link.id);
    }
    return true;
  };

  const disconnect = (id: string): boolean => {
    const link = links.byId(id);
    if (link === null) return false;
    pollers.get(link.id)?.abort();
    pollers.delete(link.id);
    void stopTyping(link.id);
    links.drop(id);
    links.save();
    return true;
  };

  /** 掐掉全部收件循环与输入状态定时器（stopAll / clearAll / dispose 三条路共用）。 */
  const halt = (): void => {
    for (const controller of pollers.values()) controller.abort();
    pollers.clear();
    for (const session of typing.values()) if (session.keepalive !== null) clearInterval(session.keepalive);
    typing.clear();
    tickets.clear();
  };

  return {
    deliverToContact,
    beginBind,
    pollBind,
    snapshotFor,
    summary,
    setFlags,
    disconnect,
    /** 联系人被彻底删除时解绑：不然长轮询还在跑，对端一句话就给一个不存在的
     *  contact_id 建轮次写消息——界面看不到，也没法再删。 */
    disconnectByContact: (contactId: string): boolean => {
      const link = links.byContact(contactId);
      return link === null ? false : disconnect(link.id);
    },
    startAll: (): void => {
      for (const link of links.all()) if (link.enabled) watchInbox(link.id);
    },
    /** 让出当家位时停收件，但不置 disposed——租约可能又被抢回来，那时 startAll 要能重起。 */
    stopAll: (): void => {
      halt();
    },
    /** 出厂重置：停收件 + 绑定整包抹掉。只 stopAll 不够——kv 清了内存里那份还在，
     *  而重新种子出来的联系人 id 仍是 default，旧绑定会把新会话镜像到别人的微信上。 */
    clearAll: (): void => {
      halt();
      sessions.clear();
      links.reset();
    },
    dispose: (): void => {
      disposed = true;
      halt();
      sessions.clear();
    },
    /** 冒烟/测试注入点：模拟一条微信入站消息。 */
    _handleInbound: acceptInbound,
    _linkFor: (contactId: string) => links.byContact(contactId),
  };
}

/** 进程级单例（server 启动时 startAll，退出时 dispose）。 */
export const wechat = createWeChatService();