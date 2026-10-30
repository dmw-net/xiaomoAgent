// ── QQ 通道：OneBot v11 协议端后端（第三方可选项）─────────────────
//
// 与官方 Bot API 后端（qq.ts）平级的可插拔实现。走 OneBot v11 标准协议，
// 对接 NapCat / go-cqhttp / LLOneBot 等协议端：真实 QQ 号在协议端扫码登录，
// xiaomo 这边不碰 AppID/AppSecret，也不做 C2C/群 intent 的开通申请。
//
// 为什么单独一个后端而不是塞进 qq.ts：
//   - 官方 Bot「绑定一个 Bot 账号」与 OneBot「挂一个真实 QQ 号」是两种凭据模型，
//     混在一起会让官方路径的扫码/认领窗口逻辑变脏。
//   - OneBot 的媒体收发由协议端代传（CQ 段 image/record/video/file），不用
//     xiaomo 自己做 files 上传拿 file_info，链路更短。
//   - 协议端没起来时整个后端降级 not-configured，官方路径完全不受影响。
//
// 消费点（proactive / agent / index / 路由）只认 QQService 面，通过 qq.ts 底部
// 按 config.qq.backend 选择后端；改一行环境变量即可切换。OneBot 专属的
// 「真实号→联系人」映射用 upsertOneBotAccount 注入，不混进 QQService 面。

import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { kvGet, kvSet } from "./db.ts";
import { getChannel } from "./channels/types.ts";
import { getContact } from "./contacts.ts";
import { logModelCall } from "./logs.ts";
import { asText, redact } from "./channels/delivery.ts";
import { ensureConversation, ensureLocalConversation, getConversation, listConversations, listGroupProactiveConversations } from "./conversations.ts";
import type { MessageAttachmentMeta } from "../shared/api.ts";
import type { QQService, QqMediaRef, QQBindingView, QQConversationView, QQStatus } from "./qq.ts";

/** 一个 OneBot 端点 = 一个真实 QQ 号，绑定到一个联系人。 */
type OneBotAccount = {
  id: string; contactId: string; qqNumber: string;
  enabled: boolean; proactive: boolean;
  lastError: string; lastReceivedAt: string; lastSentAt: string; createdAt: string;
};

type OneBotSegment = Record<string, unknown>;
const KV_OB = "qq.onebot.v1";

// 最小 WebSocket 面：协议端 forward ws 只需这几项，避开各 lib 的 MessageEvent 差异。
type OBWebSocket = {
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

// ── 惰性 hydrate 的账号表（与官方后端同款纪律：import 期不碰库）────
let accounts: OneBotAccount[] | null = null;

function parseOb(raw: string | null): OneBotAccount[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as { accounts?: unknown };
    const list = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    const out: OneBotAccount[] = [];
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const contactId = asText(row.contactId);
      if (contactId === "") continue;
      out.push({
        id: asText(row.id) || randomUUID().slice(0, 10), contactId, qqNumber: asText(row.qqNumber),
        enabled: row.enabled !== false, proactive: row.proactive === true,
        lastError: asText(row.lastError), lastReceivedAt: asText(row.lastReceivedAt),
        lastSentAt: asText(row.lastSentAt), createdAt: asText(row.createdAt) || new Date().toISOString(),
      });
    }
    return out;
  } catch { return []; }
}
function hydrate(): void { if (accounts === null) accounts = parseOb(kvGet(KV_OB)); }
function persist(): void { if (accounts !== null) kvSet(KV_OB, JSON.stringify({ version: 1, accounts })); }

/** 注入/更新一个真实 QQ 号到联系人的映射。仅 OneBot 后端有意义。 */
export function upsertOneBotAccount(contactId: string, qqNumber: string, patch: { enabled?: boolean; proactive?: boolean } = {}): OneBotAccount {
  hydrate();
  let acc = (accounts ?? []).find((a) => a.contactId === contactId) ?? null;
  if (acc === null) {
    acc = { id: randomUUID().slice(0, 10), contactId, qqNumber, enabled: true, proactive: false, lastError: "", lastReceivedAt: "", lastSentAt: "", createdAt: new Date().toISOString() };
    accounts?.push(acc);
  }
  if (qqNumber !== "") acc.qqNumber = qqNumber;
  if (patch.enabled !== undefined) acc.enabled = patch.enabled;
  if (patch.proactive !== undefined) acc.proactive = patch.proactive;
  persist();
  return acc;
}
export function removeOneBotAccount(contactId: string): boolean {
  hydrate();
  const before = (accounts ?? []).length;
  accounts = (accounts ?? []).filter((a) => a.contactId !== contactId);
  if (accounts.length !== before) persist();
  return accounts.length !== before;
}

// ── OneBot v11 消息段构造 ─────────────────────────────────────────
function obText(text: string): OneBotSegment { return { type: "text", data: { text } }; }
/** 本地 /media 路径交给协议端上传/下载；按扩展名挑段类型。 */
function obMediaSegment(ref: QqMediaRef): OneBotSegment {
  const ext = (ref.url.split(".").pop() ?? "").toLowerCase();
  const data: Record<string, unknown> = { file: ref.url };
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return { type: "image", data };
  if (["mp3", "wav", "m4a", "ogg", "opus", "weba", "silk", "aac"].includes(ext)) return { type: "record", data };
  if (["mp4", "webm"].includes(ext)) return { type: "video", data };
  return { type: "file", data };
}
/** 入站 message 段 → 纯文本。 */
function obInboundText(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message.map((item) => {
      if (item === null || typeof item !== "object") return "";
      const seg = item as OneBotSegment;
      if (seg.type !== "text") return "";
      const data = (typeof seg.data === "object" && seg.data !== null ? seg.data : {}) as Record<string, unknown>;
      return asText(data.text);
    }).join("");
  }
  return "";
}
/** 入站 message 段 → 媒体 URL 列表（协议端会回填 file/url 字段）。 */
function obInboundMedia(message: unknown): string[] {
  if (!Array.isArray(message)) return [];
  const out: string[] = [];
  for (const item of message) {
    if (item === null || typeof item !== "object") continue;
    const seg = item as OneBotSegment;
    if (!["image", "record", "video", "file"].includes(asText(seg.type))) continue;
    const data = (typeof seg.data === "object" && seg.data !== null ? seg.data : {}) as Record<string, unknown>;
    const url = asText(data.file ?? data.url);
    if (url !== "") out.push(url);
  }
  return out;
}

/** HTTP 出站调用协议端的 /<action>。失败抛带可读原因的错。 */
async function obAction(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const started = Date.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.qq.onebotToken !== "") headers["authorization"] = `Bearer ${config.qq.onebotToken}`;
  const response = await fetch(`${config.qq.onebotHttpBase}/${encodeURIComponent(action)}`, { method: "POST", headers, body: JSON.stringify(params) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  const retcode = data.retcode;
  const failed = !response.ok || Number(data.status ?? 0) === 660 || (retcode !== undefined && Number(retcode) !== 0);
  if (failed) {
    const message = asText(data.msg ?? data.message) || `HTTP ${response.status}`;
    logModelCall({ purpose: "qq", ok: false, code: "OB_" + action, model: "onebot", url: `/${action}`, elapsedMs: Date.now() - started, message: message.slice(0, 300) });
    throw new Error("OneBot 协议端拒绝了 " + action + "：" + message);
  }
  logModelCall({ purpose: "qq", ok: true, model: "onebot", url: `/${action}`, elapsedMs: Date.now() - started });
  return data;
}

/** OneBot v11 后端：出站走协议端 HTTP API，入站靠它推 forward websocket 事件。 */
export function createQQOneBotService(): QQService {
  let ws: OBWebSocket | null = null;
  let disposed = false;
  let reachable = false;

  const byContact = (contactId: string): OneBotAccount | null => { hydrate(); return (accounts ?? []).find((a) => a.contactId === contactId) ?? null; };
  const primaryAccount = (): OneBotAccount | null => { hydrate(); const list = accounts ?? []; return list.find((a) => a.enabled) ?? list[0] ?? null; };
  const norm = (text: string | string[]): string => Array.isArray(text) ? text.join("\n") : String(text ?? "");

  const sendOut = async (acc: OneBotAccount, scope: "private" | "group", targetId: string, text: string, media: OneBotSegment[]): Promise<void> => {
    const segments: OneBotSegment[] = [];
    if (text !== "") segments.push(obText(text));
    segments.push(...media);
    if (segments.length === 0) return;
    if (targetId === "" && scope === "private") { acc.lastError = "没有绑定真实 QQ 号，无法发送"; persist(); return; }
    try {
      const params: Record<string, unknown> = scope === "private" ? { user_id: targetId, message: segments } : { group_id: targetId, message: segments };
      await obAction(scope === "private" ? "send_private_msg" : "send_group_msg", params);
      acc.lastSentAt = new Date().toISOString(); acc.lastError = ""; persist();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      acc.lastError = message; persist();
      console.warn(`[qq/onebot] ${scope} 投递失败（${acc.contactId}）：${message}`);
    }
  };

  const probe = async (): Promise<void> => { try { await obAction("get_status", {}); reachable = true; } catch { reachable = false; } };

  const openWs = (): void => {
    if (ws !== null || config.qq.onebotWsUrl === "" || disposed) return;
    try {
      const socket = new WebSocket(config.qq.onebotWsUrl) as unknown as OBWebSocket;
      ws = socket;
      socket.onopen = () => { void probe(); };
      socket.onmessage = (event) => { void handleInbound(asText(event.data)); };
      socket.onclose = () => { reachable = false; ws = null; if (!disposed) setTimeout(openWs, 5000); };
      socket.onerror = () => { /* onclose 跟进来重连 */ };
    } catch { ws = null; }
  };
  const closeWs = (): void => { if (ws !== null) { try { ws.close(); } catch { /* noop */ } ws = null; } };

  const handleInbound = async (raw: string): Promise<void> => {
    if (raw === "") return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (asText(event.post_type) !== "message") return;
    const isGroup = asText(event.message_type) === "group";
    const mediaUrls = obInboundMedia(event.message);
    const text = obInboundText(event.message);
    if (text === "" && mediaUrls.length === 0) return;

    let contactId: string; let conv;
    if (isGroup) {
      const gid = asText(event.group_id);
      if (gid === "") return;
      contactId = primaryAccount()?.contactId ?? "default";
      conv = ensureConversation({ contactId, channel: "qq", kind: "group", externalId: gid, title: asText(event.group_name) || ("群 " + gid) });
    } else {
      const acc = byContact(asText(event.user_id ?? event.qq));
      if (acc === null) return; // 未绑定到本机联系人的私聊不收
      contactId = acc.contactId;
      conv = ensureLocalConversation(contactId);
      acc.lastReceivedAt = new Date().toISOString(); acc.lastError = ""; persist();
    }
    if (conv.left_at !== null || !conv.enabled) return;
    const sender = (event.sender ?? {}) as Record<string, unknown>;
    const channel = getChannel("web");
    if (channel === undefined) return;
    channel.receive(
      text, contactId, mediaUrls.length > 0 ? mediaUrls : undefined, "qq", undefined,
      {
        conversationId: conv.id,
        senderId: asText(event.user_id ?? event.member_id ?? event.qq),
        senderName: asText(sender.nickname ?? sender.card ?? sender.member_nickname) || (isGroup ? "群成员" : "QQ 用户"),
        sourceMessageId: asText(event.message_id),
        atBot: isGroup,
        attachmentMeta: mediaUrls.map((url): MessageAttachmentMeta => ({ url, kind: "image" })),
      },
    );
  };

  const statusOf = (): QQStatus => {
    hydrate();
    if (config.qq.onebotHttpBase === "" || (accounts ?? []).length === 0) return "not-configured";
    if (!(accounts ?? []).some((a) => a.enabled)) return "disabled";
    if (!reachable) return "attention";
    return "connected";
  };

  const convsFor = (contactId: string): QQConversationView[] =>
    listConversations(contactId)
      .filter((c) => c.channel === "qq" && c.kind === "group")
      .map((c) => ({
        id: c.id, kind: "group", title: c.title, titleSource: c.title_source,
        externalId: redact(c.external_id), enabled: c.enabled, groupProactive: c.group_proactive,
        leftAt: c.left_at, messageCount: 0,
        lastMessageAt: c.last_message_at ? new Date(c.last_message_at).toISOString() : "",
      }));

  const viewOf = (acc: OneBotAccount): QQBindingView => ({
    id: acc.id, contactId: acc.contactId, userOpenId: redact(acc.qqNumber),
    enabled: acc.enabled, proactive: acc.proactive, status: statusOf(),
    hasReplyWindow: false, lastError: acc.lastError, lastReceivedAt: acc.lastReceivedAt,
    lastSentAt: acc.lastSentAt, createdAt: acc.createdAt, conversations: convsFor(acc.contactId),
  });

  // ── QQService 方法面（签名与官方后端一致）────────────────────────
  const deliverToContact = async (contactId: string, text: string | string[], opts: { proactive?: boolean } = {}): Promise<void> => {
    const acc = byContact(contactId);
    if (acc === null || !acc.enabled) return;
    if (opts.proactive === true && !acc.proactive) return;
    await sendOut(acc, "private", acc.qqNumber, norm(text), []);
  };

  const deliverToConversation = async (conversationId: string, text: string | string[], _opts: { triggerMessageId?: string } = {}): Promise<void> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq" || !conv.enabled) return;
    if (conv.kind === "group") {
      const acc = primaryAccount();
      if (acc !== null) await sendOut(acc, "group", conv.external_id, norm(text), []);
      return;
    }
    await deliverToContact(conv.contact_id, text);
  };

  const deliverProactiveToGroup = async (contactId: string, text: string, media: QqMediaRef[] = []): Promise<void> => {
    const acc = primaryAccount();
    if (acc === null) return;
    for (const conv of listGroupProactiveConversations(contactId)) {
      await sendOut(acc, "group", conv.external_id, norm(text), media.map(obMediaSegment));
    }
  };

  const deliverMediaToContact = async (contactId: string, text: string, media: QqMediaRef[], opts: { proactive?: boolean } = {}): Promise<void> => {
    const acc = byContact(contactId);
    if (acc === null || !acc.enabled) return;
    if (opts.proactive === true && !acc.proactive) return;
    await sendOut(acc, "private", acc.qqNumber, norm(text), media.map(obMediaSegment));
  };

  const deliverMediaToGroup = async (contactId: string, groupConvId: string, text: string, media: QqMediaRef[]): Promise<void> => {
    const conv = getConversation(groupConvId);
    const acc = primaryAccount();
    if (conv === null || conv.channel !== "qq" || conv.kind !== "group" || !conv.enabled || acc === null) return;
    await sendOut(acc, "group", conv.external_id, norm(text), media.map(obMediaSegment));
  };

  /** 按会话分派「文字 + 媒体」：私聊走联系人号，群走 primary 号的群 external_id。 */
  const deliverMediaToConversation = async (conversationId: string, text: string, media: QqMediaRef[]): Promise<void> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq" || !conv.enabled) return;
    if (conv.kind === "group") { await deliverMediaToGroup(conv.contact_id, conversationId, text, media); return; }
    await deliverMediaToContact(conv.contact_id, text, media);
  };

  // 官方 Bot 专属的凭据/扫码路径：OneBot 用真实号登录，一律不支持，返回安全态。
  const unsupported = (what: string): void => { console.warn(`[qq/onebot] ${what} 在 OneBot 后端不适用（真实号由协议端登录）`); };

  return {
    deliverToContact,
    deliverToConversation,
    deliverProactiveToGroup,
    deliverMediaToContact,
    deliverMediaToGroup,
    deliverMediaToConversation,
    beginBind: (contactId: string) => { unsupported("beginBind"); void contactId; return { attemptId: "", keyword: "绑定", expiresInMs: 0 }; },
    pollBind: (_contactId: string, _attemptId: string) => ({ status: "gone", error: "OneBot 后端不支持认领绑定" }),
    snapshotFor: (contactId: string) => {
      const acc = byContact(contactId);
      return { binding: acc === null ? null : viewOf(acc), configured: (accounts ?? []).length > 0, status: statusOf(), conversations: convsFor(contactId) };
    },
    summary: () => {
      const list = (accounts ?? []);
      const primary = list.find((a) => a.enabled) ?? list[0];
      const trouble = list.filter((a) => a.lastError !== "").slice(0, 3).map((a) => ({ contactId: a.contactId, name: getContact(a.contactId)?.name || a.contactId, lastError: a.lastError }));
      return {
        configured: list.length > 0,
        appId: primary !== undefined && primary.qqNumber !== "" ? redact(primary.qqNumber) : "",
        status: statusOf(),
        lastError: reachable ? "" : "OneBot 协议端连不上（检查 QQ_ONEBOT_HTTP 与协议端是否启动）",
        bindings: list.length, max: list.length,
        active: list.filter((a) => a.enabled).length,
        proactive: list.filter((a) => a.proactive && a.enabled).length,
        trouble,
      };
    },
    setCredentials: (_contactId: string, _patch: { appId?: unknown; clientSecret?: unknown; enabled?: unknown }) => { unsupported("setCredentials"); hydrate(); return { configured: (accounts ?? []).length > 0 }; },
    beginCredentialQr: async (_contactId: string) => { unsupported("beginCredentialQr"); return { taskId: "", qrContent: "", expiresInMs: 0 }; },
    pollCredentialQr: async (_contactId: string, _taskId: string) => ({ status: "gone", error: "OneBot 后端不支持扫码取凭据" }),
    setFlags: (id: string, patch: { enabled?: boolean; proactive?: boolean }): boolean => {
      hydrate();
      const acc = (accounts ?? []).find((a) => a.id === id);
      if (acc === undefined) return false;
      if (patch.enabled !== undefined) acc.enabled = patch.enabled;
      if (patch.proactive !== undefined) acc.proactive = patch.proactive;
      persist(); return true;
    },
    setFlagsByContact: (contactId: string, patch: { enabled?: boolean; proactive?: boolean }): boolean => {
      const acc = byContact(contactId);
      if (acc === null) return false;
      if (patch.enabled !== undefined) acc.enabled = patch.enabled;
      if (patch.proactive !== undefined) acc.proactive = patch.proactive;
      persist(); return true;
    },
    disconnect: (id: string): boolean => {
      hydrate();
      const before = (accounts ?? []).length;
      accounts = (accounts ?? []).filter((a) => a.id !== id);
      if (accounts.length !== before) persist();
      return accounts.length !== before;
    },
    disconnectByContact: (contactId: string): boolean => removeOneBotAccount(contactId),
    startAll: (): void => { void probe(); openWs(); },
    stopAll: (): void => { closeWs(); },
    dispose: (): void => { disposed = true; closeWs(); },
    clearAll: (): void => { closeWs(); accounts = []; reachable = false; persist(); },
    gatewayStatus: (_contactId?: string): QQStatus => statusOf(),
    lastGatewayError: (): string => reachable ? "" : "OneBot 协议端连不上",
    splitQqText: (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]).map((s) => String(s).trim()).filter((s) => s !== ""),
  };
}

export type QQOneBotService = ReturnType<typeof createQQOneBotService>;
