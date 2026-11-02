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
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./config.ts";
import { kvGet, kvSet } from "./db.ts";
import { getChannel } from "./channels/types.ts";
import { getContact } from "./contacts.ts";
import { logModelCall } from "./logs.ts";
import {
  MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, mediaAbsPath,
  saveAudio, saveImage, saveVideo, sniffAudioMime, sniffImageMime, sniffVideoMime,
} from "./media.ts";
import { asText, chunkSegments, redact, withRaw } from "./channels/delivery.ts";
import { adoptGroupConversation, ensureConversation, ensureLocalConversation, findAdoptableGroupConversation, getConversation, listConversations } from "./conversations.ts";
import type { MessageAttachmentKind, MessageAttachmentMeta } from "../shared/api.ts";
import { captureInboundEmote, renderEmote, type EmoteSendResult, type QqEmoteIntent } from "./qq-emote.ts";
import type { QQService, QqMediaRef, MediaOutcome, QQBindingView, QQConversationView, QQStatus } from "./qq.ts";

/** 一个 OneBot 端点 = 一个真实 QQ 号，绑定到一个联系人。 */
type OneBotAccount = {
  id: string; contactId: string; qqNumber: string;
  /** 主人的真实 QQ 号：群聊里把他从一众群成员里认出来（sender 标记「主人」）。 */
  ownerQq: string;
  enabled: boolean; proactive: boolean;
  lastError: string; lastReceivedAt: string; lastSentAt: string; createdAt: string;
};

type OneBotSegment = Record<string, unknown>;
const KV_OB = "qq.onebot.v1";

// ── 协议端连接设置：KV 覆盖环境变量，界面里可改、热生效 ───────────────
// 协议端在哪（HTTP 出站地址 / forward WS 入站地址 / 访问令牌）是用户的部署事实，
// 不该逼人去改 desktop.json 再重启。KV 是界面写进去的真源；环境变量只是没配过的缺省。
export type OneBotSettings = { httpBase: string; wsUrl: string; token: string };
const OB_SETTINGS_KV = "qq.onebot.settings";
const obSettingsFromEnv = (): OneBotSettings => ({
  httpBase: config.qq.onebotHttpBase, wsUrl: config.qq.onebotWsUrl, token: config.qq.onebotToken,
});
let obSettings: OneBotSettings = obSettingsFromEnv();
{
  const raw = kvGet(OB_SETTINGS_KV);
  if (raw !== null && raw !== "") {
    try {
      const parsed = JSON.parse(raw) as Partial<OneBotSettings>;
      obSettings = {
        httpBase: typeof parsed.httpBase === "string" && parsed.httpBase.trim() !== "" ? parsed.httpBase.trim().replace(/\/+$/, "") : obSettings.httpBase,
        wsUrl: typeof parsed.wsUrl === "string" ? parsed.wsUrl.trim() : obSettings.wsUrl,
        token: typeof parsed.token === "string" ? parsed.token.trim() : obSettings.token,
      };
    } catch { /* 坏档就按环境变量来 */ }
  }
}
/** 当前生效的协议端连接设置（obAction/openWs 每次读它，改完即热生效）。 */
export function onebotSettings(): OneBotSettings { return { ...obSettings }; }
/** 更新协议端连接设置并落盘；返回写进去的值。进程内的热生效由调用方决定（重启 OneBot 服务）。 */
export function applyOnebotSettings(patch: Partial<OneBotSettings>): OneBotSettings {
  obSettings = {
    httpBase: typeof patch.httpBase === "string" && patch.httpBase.trim() !== ""
      ? patch.httpBase.trim().replace(/\/+$/, "") : obSettings.httpBase,
    wsUrl: typeof patch.wsUrl === "string" ? patch.wsUrl.trim() : obSettings.wsUrl,
    token: typeof patch.token === "string" ? patch.token.trim() : obSettings.token,
  };
  kvSet(OB_SETTINGS_KV, JSON.stringify(obSettings));
  return { ...obSettings };
}

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
        ownerQq: asText(row.ownerQq),
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
export function upsertOneBotAccount(contactId: string, qqNumber: string, patch: { enabled?: boolean; proactive?: boolean; ownerQq?: string } = {}): OneBotAccount {
  hydrate();
  let acc = (accounts ?? []).find((a) => a.contactId === contactId) ?? null;
  if (acc === null) {
    acc = { id: randomUUID().slice(0, 10), contactId, qqNumber, ownerQq: "", enabled: true, proactive: false, lastError: "", lastReceivedAt: "", lastSentAt: "", createdAt: new Date().toISOString() };
    accounts?.push(acc);
  }
  if (qqNumber !== "") acc.qqNumber = qqNumber;
  if (patch.ownerQq !== undefined) acc.ownerQq = patch.ownerQq.trim();
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
/**
 * OneBot v11 的 `file` 字段只认四种形态：协议端已收到的文件名、`file:///` 绝对路径、
 * http(s) URL、`base64://`。站内相对路径 `/media/x.png` 不在其中——协议端会拿它当本地路径去解
 * （Windows 上落到当前盘根的 `\media\x.png`），结果是「文件不存在」或者发出去一张坏图。
 * 所以一律换成绝对 `file:///`：协议端与后端同机（桌面端 sidecar 形态），路径可直接读。
 * 文件真不在盘上时保持原样传过去——让协议端如实报错，比我们编一个假路径静默失败好。
 */
function obFileValue(url: string): string {
  const abs = mediaAbsPath(url);
  return abs === null ? url : pathToFileURL(abs).href;
}

function obMediaSegment(ref: QqMediaRef): OneBotSegment {
  const ext = (ref.url.split(".").pop() ?? "").toLowerCase();
  const data: Record<string, unknown> = { file: obFileValue(ref.url) };
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return { type: "image", data };
  if (["mp3", "wav", "m4a", "ogg", "opus", "weba", "silk", "aac"].includes(ext)) return { type: "record", data };
  if (["mp4", "webm"].includes(ext)) return { type: "video", data };
  return { type: "file", data };
}
/** 入站 message 段 → 纯文本。face/mface 换成「[表情]」占位——
 *  纯表情甩脸是 QQ 日常，整条消息没有文字段时不能让它在闸门处蒸发：
 *  模型至少看得见「对方发了个表情」，界面也留得住这条消息。
 *  （导出只为回归测试直接喂段，运行期消费者仍只有本文件的 handleInbound。） */
export function obInboundText(message: unknown): string {
  if (typeof message === "string") return message.replace(/\[CQ:(?:face|mface)[^\]]*\]/gi, "[表情]");
  if (Array.isArray(message)) {
    return message.map((item) => {
      if (item === null || typeof item !== "object") return "";
      const seg = item as OneBotSegment;
      const data = (typeof seg.data === "object" && seg.data !== null ? seg.data : {}) as Record<string, unknown>;
      const t = asText(seg.type);
      if (t === "text") return asText(data.text);
      if (t === "face" || t === "mface") return "[表情]";
      return "";
    }).join("");
  }
  return "";
}

/** 群消息里是否 @ 了机器人（at 段的 qq === 协议端登录号；字符串消息认 CQ 码）。
 *  群里的闸门：不 @ 不响应——NapCat 默认把所有群都推过来，没这道闸机器人会闯进
 *  别人的群自说自话。 */
function obMessageAtBot(message: unknown, botUin: string): boolean {
  if (botUin === "") return false;
  if (typeof message === "string") return message.includes(`[CQ:at,qq=${botUin}]`);
  if (!Array.isArray(message)) return false;
  return message.some((item) => {
    if (item === null || typeof item !== "object") return false;
    const seg = item as OneBotSegment;
    if (seg.type !== "at") return false;
    const data = (typeof seg.data === "object" && seg.data !== null ? seg.data : {}) as Record<string, unknown>;
    return asText(data.qq) === botUin;
  });
}

/** 群消息是否该进入处理队列：@ 永远放行，其余按该群的响应方式（仅 @ / @或关键词 / 全部消息）。
 *  纯函数，不碰库也不读账号，回归测试直接喂样本。 */
export function obGroupAccepted(mode: string, keywords: string, text: string, atBot: boolean): boolean {
  if (atBot) return true;
  if (mode === "all") return true;
  if (mode !== "at_keyword") return false;
  const haystack = text.trim().toLocaleLowerCase();
  if (haystack === "") return false;
  return keywords.split(/[,，、;；\n\r\t ]+/).some((word) => {
    const needle = word.trim().toLocaleLowerCase();
    return needle !== "" && haystack.includes(needle);
  });
}
/**
 * 入站媒体段的原始引用。各家协议端回填的字段形态不一（NapCat 给 url+path+file，
 * go-cqhttp 老形态可能只给裸文件名），这里先把三种可能收齐，取字节时再按便宜排序。
 */
export type ObInboundMediaRef = {
  kind: "image" | "record" | "video" | "file";
  /** 文件名 / file_id：裸名换不到字节时要拿它找协议端 get_image 换地址。 */
  file: string;
  /** 协议端回填的 http(s) 地址（CDN 签名链接，会过期，所以必须尽快落盘）。 */
  url: string;
  /** 协议端同机落盘的绝对路径（NapCat 开 path 回填时最省）。 */
  path: string;
};

const OB_MEDIA_TYPES = ["image", "record", "video", "file"] as const;

/** file:// 形态转本地路径；坏串返回空，让上一级逻辑继续按裸名处理。 */
function obFileUrlToPath(value: string): string {
  try { return fileURLToPath(value); } catch { return ""; }
}

/** 入站 message 段 → 媒体引用列表（不取字节，只把地址形态归好）。 */
export function obInboundSegments(message: unknown): ObInboundMediaRef[] {
  if (!Array.isArray(message)) return [];
  const out: ObInboundMediaRef[] = [];
  for (const item of message) {
    if (item === null || typeof item !== "object") continue;
    const seg = item as OneBotSegment;
    const t = asText(seg.type);
    const data = (typeof seg.data === "object" && seg.data !== null ? seg.data : {}) as Record<string, unknown>;
    const text = (...keys: string[]): string => {
      for (const key of keys) { const v = asText(data[key]); if (v !== "") return v; }
      return "";
    };
    if (t === "mface") {
      // 动态小表情：有原图地址就按图片收（表情包素材的重要来路），没有就只剩文本里的占位。
      const origin = text("origin_url", "picture_url", "url");
      if (/^https?:\/\//i.test(origin)) out.push({ kind: "image", file: "", url: origin, path: "" });
      continue;
    }
    if (!(OB_MEDIA_TYPES as readonly string[]).includes(t)) continue;
    const kind = t as ObInboundMediaRef["kind"];
    const file = text("file"); const url = text("url"); const localPath = text("path");
    // 完整地址有时整个塞在 file 字段里（老形态）；裸文件名留给 get_image 那条路。
    const httpUrl = /^https?:\/\//i.test(url) ? url : (/^https?:\/\//i.test(file) ? file : "");
    const local = localPath !== "" ? localPath
      : (/^file:\/\/\//i.test(file) ? obFileUrlToPath(file)
        : (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith("/") ? file : ""));
    if (httpUrl === "" && local === "" && file === "") continue;
    out.push({ kind, file, url: httpUrl, path: local });
  }
  return out;
}

/** HTTP 出站调用协议端的 /<action>。失败抛带可读原因的错。 */
async function obAction(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const started = Date.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (obSettings.token !== "") headers["authorization"] = `Bearer ${obSettings.token}`;
  const response = await fetch(`${obSettings.httpBase}/${encodeURIComponent(action)}`, { method: "POST", headers, body: JSON.stringify(params) });
  // 先取原文再解析：失败时把协议端的原始报文留给日志（res_full），详情弹窗才有东西可看。
  const rawBody = await response.text().catch(() => "");
  let data: Record<string, unknown> = {};
  try { data = rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>; } catch { /* 非 JSON 报文原样进日志 */ }
  const retcode = data.retcode;
  const failed = !response.ok || Number(data.status ?? 0) === 660 || (retcode !== undefined && Number(retcode) !== 0);
  if (failed) {
    const message = asText(data.msg ?? data.message) || `HTTP ${response.status}`;
    logModelCall({ purpose: "qq", ok: false, code: "OB_" + action, model: "onebot", url: `/${action}`, elapsedMs: Date.now() - started, message: message.slice(0, 300), resRaw: rawBody.slice(0, 2000) });
    throw withRaw(new Error("OneBot 协议端拒绝了 " + action + "：" + message), rawBody.slice(0, 2000));
  }
  logModelCall({ purpose: "qq", ok: true, model: "onebot", url: `/${action}`, elapsedMs: Date.now() - started });
  return data;
}

// ── 入站媒体落盘 ────────────────────────────────────────────────
// CSP 把 img-src 钉死在 'self' data: blob:，协议端给的远程地址（CDN、带过期签名）
// 在前端根本渲染不出来——收进来就必须当场抓成本地 /media，留到看时再抓等于没存。
// 一条坏附件只跳过它自己（记 OB_MEDIA 日志），不吞整条消息；与官方后端的
// saveInboundMedia 同一纪律。

const OB_MEDIA_LIMIT: Record<ObInboundMediaRef["kind"], number> = {
  image: MAX_IMAGE_BYTES, record: MAX_AUDIO_BYTES, video: MAX_VIDEO_BYTES, file: MAX_VIDEO_BYTES,
};

function obOverLimitError(limit: number, size: number): Error {
  return new Error(`附件 ${Math.round(size / (1024 * 1024))}MB 超过 ${Math.round(limit / (1024 * 1024))}MB 上限，已跳过`);
}

function obReadLocalCapped(file: string, limit: number): Buffer {
  const size = statSync(file).size;
  if (size > limit) throw obOverLimitError(limit, size);
  const body = readFileSync(file);
  if (body.length === 0) throw new Error("附件内容为空");
  return body;
}

async function obFetchCapped(target: string, limit: number): Promise<Buffer> {
  const response = await fetch(target, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > limit) throw obOverLimitError(limit, length);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error("附件内容为空");
  if (body.length > limit) throw obOverLimitError(limit, body.length);
  return body;
}

/**
 * 媒体引用 → 字节。三条路按便宜排序：同机文件直读 → http 地址直取 →
 * 裸文件名/file_id 找协议端 get_image 换地址（NapCat 的 file 字段经常只是个哈希名）。
 */
async function obFetchBody(ref: ObInboundMediaRef): Promise<Buffer> {
  const limit = OB_MEDIA_LIMIT[ref.kind];
  if (ref.path !== "" && existsSync(ref.path)) return obReadLocalCapped(ref.path, limit);
  if (ref.url !== "") return await obFetchCapped(ref.url, limit);
  if (/^https?:\/\//i.test(ref.file)) return await obFetchCapped(ref.file, limit);
  if (/^file:\/\/\//i.test(ref.file)) {
    const local = obFileUrlToPath(ref.file);
    if (local !== "" && existsSync(local)) return obReadLocalCapped(local, limit);
  }
  if (ref.file !== "") {
    const envelope = await obAction("get_image", { file_id: ref.file });
    const payload = (envelope.data !== null && typeof envelope.data === "object"
      ? envelope.data : envelope) as Record<string, unknown>;
    const swapped = asText(payload.url ?? payload.file);
    if (/^https?:\/\//i.test(swapped)) return await obFetchCapped(swapped, limit);
    if (swapped !== "" && existsSync(swapped)) return obReadLocalCapped(swapped, limit);
    // 协议端也可能不转存、直接把字节还回来（go-cqhttp 形态是裸 base64，NapCat 带 base64:// 前缀）。
    const base64 = asText(payload.file_base64 ?? payload.base64);
    const stripped = base64.startsWith("base64://") ? base64.slice("base64://".length) : base64;
    if (stripped !== "") {
      const body = Buffer.from(stripped, "base64");
      if (body.length === 0) throw new Error("协议端回的空字节");
      if (body.length > limit) throw obOverLimitError(limit, body.length);
      return body;
    }
  }
  throw new Error("协议端没给出可读的附件地址");
}

/**
 * 入站 message → 已落盘的本地媒体。落盘后按真实字节归型（不是按段声明——file 段
 * 里装着图片很常见），图片顺手走表情自动采集（开关关着是 no-op，重复内容按哈希挡）。
 */
export async function obMaterializeMedia(message: unknown): Promise<{ urls: string[]; meta: MessageAttachmentMeta[] }> {
  const urls: string[] = [];
  const meta: MessageAttachmentMeta[] = [];
  for (const ref of obInboundSegments(message)) {
    const started = Date.now();
    try {
      const body = await obFetchBody(ref);
      const imageMime = sniffImageMime(body);
      let url = ""; let kind: MessageAttachmentKind; let mime = "";
      if (ref.kind === "image" || (ref.kind === "file" && imageMime !== "")) {
        if (imageMime === "") throw new Error("图片魔数无法识别");
        url = saveImage(body, imageMime).url; mime = imageMime; kind = "image";
        captureInboundEmote(url);
      } else if (ref.kind === "record" || (ref.kind === "file" && imageMime === "" && sniffAudioMime(body) !== "")) {
        const saved = saveAudio(body); url = saved.url; mime = saved.mime; kind = "audio";
      } else if (ref.kind === "video" || (ref.kind === "file" && sniffVideoMime(body) !== "")) {
        const saved = saveVideo(body); url = saved.url; mime = saved.mime; kind = "video";
      } else {
        throw new Error("文档类附件暂不落库");
      }
      urls.push(url);
      meta.push({ url, kind, mime });
    } catch (error) {
      logModelCall({
        purpose: "qq", ok: false, code: "OB_MEDIA", model: "onebot", url: "/inbound-" + ref.kind,
        elapsedMs: Date.now() - started,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }
  return { urls, meta };
}

export type OneBotLoginInfo = {
  /** 协议端是否连得上（HTTP API 可用且应答正常）。 */
  reachable: boolean;
  /** 协议端当前登录的真实 QQ 号与昵称（连不上时为空串）。 */
  userId: string;
  nickname: string;
  /** 连不上时的人类可读原因（给绑定入口的引导文案用）。 */
  error: string;
};

/** 探测协议端并读出它当前登录的账号：绑定入口靠它把「手填 QQ 号」升级成「确认绑定」。
 *  不抛错——连不上也是合法状态，error 里带原因。
 *  obAction 回的是完整信封（{status,retcode,data,echo}），账号字段在 data 里；
 *  从前直接在信封上读 user_id，永远读出空号——HTTP 通着也判成「没连上」。 */
export async function onebotLoginInfo(): Promise<OneBotLoginInfo> {
  try {
    const envelope = await obAction("get_login_info", {});
    const login = (envelope.data !== null && typeof envelope.data === "object"
      ? envelope.data : envelope) as Record<string, unknown>;
    return {
      reachable: true,
      userId: asText(login.user_id ?? login.userId),
      nickname: asText(login.nickname),
      error: "",
    };
  } catch (error) {
    return {
      reachable: false,
      userId: "",
      nickname: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** OneBot v11 后端：出站走协议端 HTTP API，入站靠它推 forward websocket 事件。 */
export function createQQOneBotService(): QQService {
  let ws: OBWebSocket | null = null;
  let disposed = false;
  let reachable = false;
  let inboundTail: Promise<void> = Promise.resolve();

  const byContact = (contactId: string): OneBotAccount | null => { hydrate(); return (accounts ?? []).find((a) => a.contactId === contactId) ?? null; };
  const primaryAccount = (): OneBotAccount | null => { hydrate(); const list = accounts ?? []; return list.find((a) => a.enabled) ?? list[0] ?? null; };
  /** 出站的气泡序列：agent 分好的条原样逐条发，超长元素再按上限硬切——
   *  与官方后端的 splitQqText 同一节奏（本地几颗气泡，QQ 里几条消息），不能 join 成一大段。 */
  const obTextSegments = (text: string | string[]): string[] => chunkSegments(text, 4000);

  /** 发一组段；返回是否真的发出去了（协议端报错时 false），供媒体回执与 send_emote 如实上报。 */
  const sendOut = async (acc: OneBotAccount, scope: "private" | "group", targetId: string, text: string, media: OneBotSegment[]): Promise<boolean> => {
    const segments: OneBotSegment[] = [];
    if (text !== "") segments.push(obText(text));
    segments.push(...media);
    if (segments.length === 0) return false;
    if (targetId === "" && scope === "private") { acc.lastError = "没有绑定真实 QQ 号，无法发送"; persist(); return false; }
    try {
      const params: Record<string, unknown> = scope === "private" ? { user_id: targetId, message: segments } : { group_id: targetId, message: segments };
      await obAction(scope === "private" ? "send_private_msg" : "send_group_msg", params);
      acc.lastSentAt = new Date().toISOString(); acc.lastError = ""; persist();
      return true;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      acc.lastError = message; persist();
      console.warn(`[qq/onebot] ${scope} 投递失败（${acc.contactId}）：${message}`);
      return false;
    }
  };

  const probe = async (): Promise<void> => { try { await obAction("get_status", {}); reachable = true; } catch { reachable = false; } };

  const openWs = (): void => {
    if (ws !== null || obSettings.wsUrl === "" || disposed) return;
    try {
      const socket = new WebSocket(obSettings.wsUrl) as unknown as OBWebSocket;
      ws = socket;
      socket.onopen = () => { void probe(); };
      // 入站串行：媒体落盘是异步的，并发处理会让慢消息插到快消息后面——
      // 聊天记录的时间顺序必须在入库顺序里成立。
      socket.onmessage = (event) => {
        const raw = asText(event.data);
        inboundTail = inboundTail.then(() => handleInbound(raw)).catch(() => { /* handleInbound 自己吞错，这里只保队列不断 */ });
      };
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
    const text = obInboundText(event.message);
    const segments = obInboundSegments(event.message);
    if (text === "" && segments.length === 0) return;

    let contactId: string; let conv; let ownerQq = ""; let atBot = false;
    if (isGroup) {
      const gid = asText(event.group_id);
      if (gid === "") return;
      const acc = primaryAccount();
      atBot = obMessageAtBot(event.message, acc?.qqNumber ?? "");
      contactId = acc?.contactId ?? "default";
      ownerQq = acc?.ownerQq ?? "";
      // ① 已登记的群按该群自己的响应方式放行：@ 永远算命中；「全部消息」放行日常 chatter；
      //    「@或关键词」按关键词表命中。没命中的一概不入库（她不会旁听）。
      conv = listConversations(contactId)
        .find((c) => c.channel === "qq" && c.kind === "group" && c.external_id === gid) ?? null;
      if (conv !== null) {
        if (!obGroupAccepted(conv.trigger_mode, conv.trigger_keywords, text, atBot)) return;
      } else {
        // ② 陌生群只有 @ 才登记：NapCat 会把协议端所在的全部群都推过来，
        //    「全部消息」只对已经收进列表的群生效，不能因此自动把所有群加进来。
        if (!atBot) return;
        // ③ 渠道过户（双向）：官方渠道留下的群会话如果恰好一条，过户成这个群——
        //    同一个物理群在新渠道是另一个 ID，不过户就会裂成两条会话，历史和记忆全断。
        const adoptable = findAdoptableGroupConversation(contactId, true);
        if (adoptable !== null) adoptGroupConversation(adoptable.id, gid);
        // ④ 首次被 @ 的群才登记成新会话。
        conv = ensureConversation({ contactId, channel: "qq", kind: "group", externalId: gid, title: asText(event.group_name) || ("群 " + gid) });
      }
    } else {
      const acc = byContact(asText(event.user_id ?? event.qq));
      if (acc === null) return; // 未绑定到本机联系人的私聊不收
      contactId = acc.contactId;
      conv = ensureLocalConversation(contactId);
      acc.lastReceivedAt = new Date().toISOString(); acc.lastError = ""; persist();
    }
    if (conv.left_at !== null || !conv.enabled) return;
    // 过了所有闸门才取字节：未绑定的号、没开收到的群，一条都不该落盘。
    const media = await obMaterializeMedia(event.message);
    if (text === "" && media.urls.length === 0) return;
    const sender = (event.sender ?? {}) as Record<string, unknown>;
    const channel = getChannel("web");
    if (channel === undefined) return;
    channel.receive(
      text, contactId, media.urls.length > 0 ? media.urls : undefined, "qq", undefined,
      {
        conversationId: conv.id,
        senderId: asText(event.user_id ?? event.member_id ?? event.qq),
        // 主人识别：sender 是绑定时登记的主人 QQ 就在名字上打标——群聊里一屋子人，
        // 模型靠这行标记才知道"哪句是主人说的"，不再见谁都叫主人。
        senderName: (asText(sender.nickname ?? sender.card ?? sender.member_nickname) || (isGroup ? "群成员" : "QQ 用户"))
          + (ownerQq !== "" && asText(event.user_id ?? event.qq) === ownerQq ? "（主人）" : ""),
        sourceMessageId: asText(event.message_id),
        atBot,
        attachmentMeta: media.meta,
      },
    );
  };

  const statusOf = (): QQStatus => {
    hydrate();
    if (obSettings.httpBase === "" || (accounts ?? []).length === 0) return "not-configured";
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
        triggerMode: c.trigger_mode, triggerKeywords: c.trigger_keywords,
        leftAt: c.left_at, messageCount: 0,
        lastMessageAt: c.last_message_at ? new Date(c.last_message_at).toISOString() : "",
      }));

  const viewOf = (acc: OneBotAccount): QQBindingView => ({
    id: acc.id, contactId: acc.contactId, userOpenId: redact(acc.qqNumber),
    enabled: acc.enabled, proactive: acc.proactive, hasUserOpenId: acc.qqNumber !== "", status: statusOf(),
    hasReplyWindow: false, lastError: acc.lastError, lastReceivedAt: acc.lastReceivedAt,
    lastSentAt: acc.lastSentAt, createdAt: acc.createdAt, conversations: convsFor(acc.contactId),
  });

  // ── QQService 方法面（签名与官方后端一致）────────────────────────
  const deliverToContact = async (contactId: string, text: string | string[], opts: { proactive?: boolean } = {}): Promise<void> => {
    const acc = byContact(contactId);
    if (acc === null || !acc.enabled) return;
    if (opts.proactive === true && !acc.proactive) return;
    for (const segment of obTextSegments(text)) {
      await sendOut(acc, "private", acc.qqNumber, segment, []);
    }
  };

  const deliverToConversation = async (conversationId: string, text: string | string[], _opts: { triggerMessageId?: string } = {}): Promise<void> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq" || !conv.enabled) return;
    if (conv.kind === "group") {
      const acc = primaryAccount();
      if (acc !== null) {
        for (const segment of obTextSegments(text)) {
          await sendOut(acc, "group", conv.external_id, segment, []);
        }
      }
      return;
    }
    await deliverToContact(conv.contact_id, text);
  };

  const deliverMediaToContact = async (contactId: string, text: string | string[], media: QqMediaRef[], opts: { proactive?: boolean } = {}): Promise<MediaOutcome> => {
    const outcome: MediaOutcome = { sent: 0, failed: 0, lastError: "" };
    const acc = byContact(contactId);
    if (acc === null || !acc.enabled) return outcome;
    if (opts.proactive === true && !acc.proactive) return outcome;
    for (const segment of obTextSegments(text)) {
      const sent = await sendOut(acc, "private", acc.qqNumber, segment, []);
      if (sent) outcome.sent += 1;
      else { outcome.failed += 1; outcome.lastError = acc.lastError; }
    }
    if (media.length > 0) {
      const sent = await sendOut(acc, "private", acc.qqNumber, "", media.map(obMediaSegment));
      if (sent) outcome.sent += 1;
      else { outcome.failed += 1; outcome.lastError = acc.lastError; }
    }
    return outcome;
  };

  const deliverMediaToGroup = async (contactId: string, groupConvId: string, text: string, media: QqMediaRef[]): Promise<MediaOutcome> => {
    const outcome: MediaOutcome = { sent: 0, failed: 0, lastError: "" };
    const conv = getConversation(groupConvId);
    const acc = primaryAccount();
    if (conv === null || conv.channel !== "qq" || conv.kind !== "group" || !conv.enabled || acc === null) return outcome;
    for (const segment of obTextSegments(text)) {
      const sent = await sendOut(acc, "group", conv.external_id, segment, []);
      if (sent) outcome.sent += 1;
      else { outcome.failed += 1; outcome.lastError = acc.lastError; }
    }
    if (media.length > 0) {
      const sent = await sendOut(acc, "group", conv.external_id, "", media.map(obMediaSegment));
      if (sent) outcome.sent += 1;
      else { outcome.failed += 1; outcome.lastError = acc.lastError; }
    }
    return outcome;
  };

  /** 按会话分派「文字 + 媒体」：私聊走联系人号，群走 primary 号的群 external_id。 */
  const deliverMediaToConversation = async (conversationId: string, text: string, media: QqMediaRef[]): Promise<void> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq" || !conv.enabled) return;
    if (conv.kind === "group") { await deliverMediaToGroup(conv.contact_id, conversationId, text, media); return; }
    await deliverMediaToContact(conv.contact_id, text, media);
  };

  /**
   * 发一个表情（表情系统入口，OneBot 渠道版）。OneBot 协议端对 face/mface/image 都原生支持，
   * 直接把 renderEmote 产出的段塞进协议端 HTTP API。按会话分派：群走 primary 号 external_id，
   * 私聊走该联系人绑定的号。
   */
  const deliverEmote = async (conversationId: string, intent: QqEmoteIntent): Promise<EmoteSendResult> => {
    const conv = getConversation(conversationId);
    if (conv === null || conv.channel !== "qq" || !conv.enabled) {
      return { ok: false, native: false, via: "skipped", detail: "会话不可用或不是 QQ 会话" };
    }
    const render = renderEmote(intent);
    if (render.segments.length === 0) {
      // 只有降级文字（理论上 OneBot 不会走到这，但留个兜底）。
      if (render.fallbackText !== "") {
        if (conv.kind === "group") await deliverToConversation(conversationId, render.fallbackText);
        else await deliverToContact(conv.contact_id, render.fallbackText);
        return { ok: true, native: render.native, via: "text", detail: render.fallbackText };
      }
      return { ok: false, native: false, via: "skipped", detail: "没有可发的表情内容" };
    }
    if (conv.kind === "group") {
      const acc = primaryAccount();
      if (acc === null) return { ok: false, native: false, via: "skipped", detail: "没有可用的 OneBot 账号" };
      const sent = await sendOut(acc, "group", conv.external_id, "", render.segments);
      if (!sent) return { ok: false, native: false, via: "skipped", detail: acc.lastError || "协议端发送失败" };
    } else {
      const acc = byContact(conv.contact_id);
      if (acc === null || !acc.enabled) return { ok: false, native: false, via: "skipped", detail: "联系人没有绑定 OneBot 账号" };
      const sent = await sendOut(acc, "private", acc.qqNumber, "", render.segments);
      if (!sent) return { ok: false, native: false, via: "skipped", detail: acc.lastError || "协议端发送失败" };
    }
    return { ok: true, native: render.native, via: "native" };
  };

  // 官方 Bot 专属的凭据/扫码路径：OneBot 用真实号登录，一律不支持，返回安全态。
  const unsupported = (what: string): void => { console.warn(`[qq/onebot] ${what} 在 OneBot 后端不适用（真实号由协议端登录）`); };

  return {
    deliverToContact,
    deliverToConversation,
    deliverMediaToContact,
    deliverMediaToGroup,
    deliverMediaToConversation,
    deliverEmote,
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
