// ── QQ 表情系统（渠道无关的表情意图层 + 素材库 + 采集/播种）────────
//
// 为什么单独一层：官方 Bot API 与 OneBot v11 协议端对"表情"的支持完全不对称——
//   - 图片表情包（png/jpg/webp）：两条链路都能发（官方走富媒体上传，OneBot 走 image 段）。
//     GIF 只有 OneBot 收——官方富媒体会回 850019，所以官方渠道发的是它的派生静帧
//     （见 renditions.ts：落盘的原图不动，发送时按渠道能力挑形态）。
//   - QQ 内置表情 face / 商城动态表情 mface：只有 OneBot（NapCat / LLOneBot）能发，
//     官方渠道根本没有这个概念，硬发就是乱来。
// 调用方（send_emote 工具 / agent）不该关心"现在挂的是哪条渠道"，只描述"想发哪种表情"，
// 由本层按 config.qq.backend 渲染成该渠道真正能落地的形态，并对发不了的类型做**有意识的降级**
// （官方渠道把 face 降级成一个 emoji 字符，绝不把"表情"当纯文本硬塞）。
//
// 三类表情 + 一个"素材库"：
//   face   QQ 内置表情（id 1..177），仅 OneBot 原生；官方降级为 emoji。
//   mface  商城/动态特效表情，仅 OneBot（NapCat/LLOneBot）原生；官方降级为文字。
//   image  图片表情包 / custom 自定义表情，两条链路都原生（最稳，默认推荐路径）。
//   素材库  把若干张本地 /media 图片登记成"表情包"，按关键词命中随机发一张——
//           这是"水群接梗"的主路径，不依赖协议端是否支持 face。
//
// 素材库怎么长出来（三种来源，都落进同一个 KV，去重 + 有界）：
//   1. 手动上传（界面单图）        registerEmoteAsset
//   2. 目录播种（本地放一批梗图）  importEmoteDir（按内容 md5 去重，重扫不重复）
//   3. 自动采集（用户发来的图）      captureInboundEmote（开关默认关，见 autoCapture）

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../core/config.ts";
import { kvGet, kvSet } from "../core/db.ts";
import {
  claimAsset, contentHash, findEmoteAssetByHash, getAssetByUrl, isHumanName,
  listEmoteAssets as listMarkedEmotes, migrateEmoteSemantics, markEmote,
  registerAsset, unmarkEmote, type AssetSource, type EmoteSemantics,
} from "../media/assets.ts";
import {
  mediaAbsPath, mediaFileInfo, mediaTypeOfUrl, readMedia, saveImage, sniffImageMime,
} from "../media/media.ts";
import { dirFor } from "../media/media-layout.ts";
import { scheduleCaptureNaming } from "./emote-naming.ts";
import { applyEmoteNaming, cleanLabel, cleanTags, isMachineName } from "./emote-semantics.ts";
// 保持原有导出面：isMachineName / applyEmoteNaming 历史上从本模块取，测试与调用方无需改动。
export { isMachineName, applyEmoteNaming } from "./emote-semantics.ts";
import { qqBackend, type QQBackend } from "../channels/qq-backend.ts";
import type { QqMediaRef } from "../channels/qq.ts";
import { QQ_FACE_NAMES, QQ_FACE_SYNCED_AT } from "./qq-face-names.generated.ts";

/** 表情意图：只描述"想发什么"，不描述"渠道怎么说"。 */
export type QqEmoteIntent =
  | { kind: "face"; id: number; label?: string }
  | { kind: "image"; url: string; label?: string }
  | { kind: "custom"; url: string; label?: string }
  | { kind: "mface"; emojiId: string; packageId?: string; key?: string; label?: string };

/** 一次表情投递的结果，供 send_emote 工具读取并回执。via：
 *  media=按图片发出 / text=降级成文字 / native=原生表情段（face/mface）/ skipped=没发。 */
export type EmoteSendResult = {
  ok: boolean;
  /** 是否按该渠道原生发出（false=已降级，调用方好知情）。 */
  native: boolean;
  via: "media" | "text" | "native" | "skipped";
  detail?: string;
};

/** 渲染结果：把意图落成"当前渠道能发的东西"。两个后端各取所需：
 *  OneBot 读 segments（face/mface/image 段），官方读 mediaRefs（图片走富媒体）+ fallbackText（降级文字）。 */
export type EmoteRender = {
  /** OneBot v11 消息段（官方渠道不消费）。 */
  segments: Array<Record<string, unknown>>;
  /** 本地媒体引用（官方渠道走富媒体上传；OneBot 亦可用，但优先 segments）。 */
  mediaRefs: QqMediaRef[];
  /** 能力降级时的兜底文字（官方发不了 face/mface 时给；native=true 时一般为空）。 */
  fallbackText: string;
  /** 是否按该渠道原生发出（false=已降级，调用方好知情）。 */
  native: boolean;
};

// ── 渠道能力探测（统一真源，界面/工具/后端都读它）──────────────────
export type EmoteCapabilities = {
  backend: "official" | "onebot";
  /** 内置 QQ 表情 face 能否原生发（官方渠道发不了，会降级成 emoji）。 */
  face: boolean;
  /** 商城/动态表情 mface 能否原生发。 */
  mface: boolean;
  /** 图片表情包两条链路都原生（官方富媒体 / OneBot image 段），最稳的默认路径。 */
  image: boolean;
};
export function emoteCapabilities(backend: QQBackend = qqBackend()): EmoteCapabilities {
  const onebot = backend === "onebot";
  return { backend, face: onebot, mface: onebot, image: true };
}

// ── 出站用的内置表情词表（关键词 → face id + 降级 emoji）─────────────
/**
 * 只服务「按关键词发一个 QQ 内置表情」这条**出站**链路：模型说「笑」，
 * 从这里挑一个 face id 发出去。FACE_SYNONYMS、faceKeywords() 的界面词表都依赖它。
 *
 * ⚠️ 编号存疑：逐条比对 koishijs/QFace（QQNT，用 NapCat 容器扫出）的索引后，
 * 这张手写表 16 个 id 里 15 个对不上——id 14 实际是「微笑」，这里写的是「晕」。
 * **入站解析已经不用它了**（见 describeFace 与 qq-face-names.generated.ts）。
 * 出站 id 的归属要抓一条真实协议端事件核对后再统一，实测前不动这张词表，
 * 否则会连带改坏 FACE_SYNONYMS 和界面「可发的词」。可用 `overrideFaces` 纠偏。
 */
type FaceDef = { keyword: string; id: number; emoji: string };
const FACES: FaceDef[] = [
  { keyword: "微笑", id: 1, emoji: "🙂" },
  { keyword: "偷笑", id: 3, emoji: "😏" },
  { keyword: "大笑", id: 4, emoji: "😄" },
  { keyword: "开心", id: 4, emoji: "😄" },
  { keyword: "伤心", id: 5, emoji: "😢" },
  { keyword: "委屈", id: 5, emoji: "😢" },
  { keyword: "害羞", id: 6, emoji: "😳" },
  { keyword: "脸红", id: 6, emoji: "😳" },
  { keyword: "大哭", id: 7, emoji: "😭" },
  { keyword: "哭", id: 7, emoji: "😭" },
  { keyword: "惊讶", id: 10, emoji: "😲" },
  { keyword: "吃惊", id: 10, emoji: "😲" },
  { keyword: "生气", id: 11, emoji: "😡" },
  { keyword: "火大", id: 11, emoji: "🔥" },
  { keyword: "得意", id: 12, emoji: "😎" },
  { keyword: "酷", id: 12, emoji: "😎" },
  { keyword: "晕", id: 14, emoji: "😵" },
  { keyword: "迷糊", id: 14, emoji: "😵" },
  { keyword: "弱弱", id: 15, emoji: "😿" },
  { keyword: "委屈巴巴", id: 15, emoji: "😿" },
  { keyword: "亲亲", id: 16, emoji: "😘" },
  { keyword: "赞", id: 18, emoji: "👍" },
  { keyword: "强", id: 18, emoji: "👍" },
  { keyword: "思考", id: 31, emoji: "🤔" },
  { keyword: "嗯", id: 31, emoji: "🤔" },
  { keyword: "爱心", id: 42, emoji: "❤️" },
  { keyword: "喜欢", id: 42, emoji: "❤️" },
  { keyword: "玫瑰", id: 43, emoji: "🌹" },
  { keyword: "比心", id: 43, emoji: "🌹" },
];
/** 进程内覆盖：NapCat/LLOneBot 实测后把编号纠偏，避免发错。 */
let faceOverrides: FaceDef[] | null = null;
export function overrideFaces(defs: FaceDef[]): void { faceOverrides = defs; }

const faceTable = (): FaceDef[] => faceOverrides ?? FACES;

/** 关键词 → 内置表情。未命中返回 null（调用方继续回退到素材库 / 直接给 face id）。
 *  匹配策略：精确查 FACES 表 + 口语叫法扩展（FACE_SYNONYMS 的候选逐个查 FACES）。 */
export function resolveFace(keyword: string): FaceDef | null {
  const key = keyword.trim();
  if (key === "") return null;
  const table = faceTable();
  for (const def of table) if (def.keyword === key) return def;
  // 口语扩展：候选逐个查 FACES 表。
  const cands = FACE_SYNONYMS[key] ?? [];
  for (const c of cands) {
    for (const def of table) if (def.keyword === c) return def;
  }
  return null;
}
/** 内置表情全表（界面给模型/用户看"有哪些可发的词"）。去重 face id 后按关键词展开。 */
export function faceKeywords(): FaceDef[] { return faceTable(); }
/** 全量名称表的同步时间（诊断面可查，也证明这份数据不是随手编的）。 */
export const qqFaceNamesSyncedAt = QQ_FACE_SYNCED_AT;

/**
 * 表情名 → emoji。纯装饰：名称本身才是解析结果，查不到就只显示「[名称]」，
 * 不影响正确性。沿用旧词表的 keyword→emoji，再补 QQNT 常见名称。
 */
const FACE_NAME_EMOJI: Record<string, string> = {
  ...Object.fromEntries(FACES.map((def) => [def.keyword, def.emoji])),
  "惊讶": "😲", "撇嘴": "😖", "色": "😍", "发呆": "😳", "得意": "😎", "流泪": "😢",
  "闭嘴": "🤐", "睡": "😴", "尴尬": "😅", "发怒": "😡", "调皮": "😜", "呲牙": "😁",
  "难过": "😞", "冷汗": "😰", "抓狂": "😫", "吐": "🤮", "可爱": "🥰", "白眼": "🙄",
  "傲慢": "😤", "饥饿": "😋", "困": "😪", "惊恐": "😱", "流汗": "💦", "憨笑": "😄",
  "嘘": "🤫", "敲打": "🔨", "再见": "👋", "擦汗": "😥", "鼓掌": "👏", "坏笑": "😏",
  "鄙视": "😒", "阴险": "😈", "可怜": "🥺", "菜刀": "🔪", "西瓜": "🍉", "啤酒": "🍺",
  "篮球": "🏀", "咖啡": "☕", "猪头": "🐷", "凋谢": "🥀", "心碎": "💔", "蛋糕": "🎂",
  "礼物": "🎁", "太阳": "☀️", "月亮": "🌙", "茶": "🍵", "炸弹": "💣", "爱情": "❤️",
};
/** 表情名 → 装饰 emoji；给入站解析用（协议端直接给了 faceText 时也要能配 emoji）。 */
export function faceNameEmoji(name: string): string { return FACE_NAME_EMOJI[name] ?? ""; }

/**
 * 入站编号纠偏：QQ 的编号有三套（老 CQ 表 / QQNT emojiId / qzoneCode）且会漂移，
 * 万一本机协议端报的不是 QFace 那套，用它在进程内覆盖名称，不必改生成文件。
 */
let faceNameOverrides: Record<number, string> | null = null;
export function overrideFaceNames(names: Record<number, string>): void { faceNameOverrides = names; }
function faceNameOf(id: number): string | undefined {
  return faceNameOverrides?.[id] ?? QQ_FACE_NAMES[id];
}

/** face id → 兜底 emoji（官方渠道降级用，**出站**链路）。仍走旧词表：
 *  renderEmote 拿到的 id 就来自 resolveFace/旧词表，换成全量表反而会把「大笑」降级成「得意」的 emoji。
 *  入站解析走 describeFace（QFace 全量表），两套编号体系不要混。未知 id 返回空串。 */
export function faceEmoji(id: number): string {
  const found = faceTable().find((def) => def.id === id);
  return found ? found.emoji : "";
}
/**
 * face id → 表情名 + emoji，**入站解析**用：QQ 群里甩一个黄脸过来时，
 * 光留「[表情]」等于什么都没解析——界面没东西看，模型也不知道对方在笑还是在哭。
 * 查 koishijs/QFace 的全量表（372 条），未知 id 返回 null，
 * 调用方回退成通用占位（编号漂移时不硬猜）。
 */
export function describeFace(id: number): { keyword: string; emoji: string } | null {
  const name = faceNameOf(id);
  return name === undefined ? null : { keyword: name, emoji: faceNameEmoji(name) };
}

/**
 * 把一个表情意图渲染成"当前渠道能发的形态"。这是整个表情系统的核心分流点：
 *   - image/custom：两渠道都原生。OneBot 产出 image 段（协议端代传），官方产出 mediaRef（富媒体上传）。
 *   - face：OneBot 原生 face 段；官方没有内置表情概念，降级成 emoji 字符（native=false）。
 *   - mface：OneBot（NapCat/LLOneBot）原生 mface 段；官方降级成文字。
 */
export function renderEmote(intent: QqEmoteIntent, backend: QQBackend = qqBackend()): EmoteRender {
  const caps = emoteCapabilities(backend);
  switch (intent.kind) {
    case "image":
    case "custom": {
      const ref: QqMediaRef = intent.label !== undefined && intent.label !== "" ? { url: intent.url, label: intent.label } : { url: intent.url };
      if (caps.backend === "onebot") {
        // OneBot 的 image 段要绝对 file:/// 引用（站内相对路径协议端解不出来），
        // 与 qq-onebot.ts 的 obFileValue 同一口径；这里不 import 它，避免两个模块互相依赖。
        const abs = mediaAbsPath(intent.url);
        return {
          segments: [{ type: "image", data: { file: abs === null ? intent.url : pathToFileURL(abs).href } }],
          mediaRefs: [ref], fallbackText: intent.label ?? "", native: true,
        };
      }
      // 官方：本地文件走富媒体上传端点。
      return { segments: [], mediaRefs: [ref], fallbackText: intent.label ?? "", native: true };
    }
    case "face": {
      if (caps.face) {
        const data: Record<string, unknown> = { id: String(intent.id) };
        if (intent.label !== undefined && intent.label !== "") data.summary = intent.label;
        return { segments: [{ type: "face", data }], mediaRefs: [], fallbackText: faceEmoji(intent.id) || intent.label || "", native: true };
      }
      // 官方渠道无内置表情：降级成一个 emoji 字符，绝不把 face 段当文本硬发。
      return { segments: [], mediaRefs: [], fallbackText: faceEmoji(intent.id) || intent.label || "（表情）", native: false };
    }
    case "mface": {
      if (caps.mface) {
        const data: Record<string, unknown> = { emoji_id: intent.emojiId };
        if (intent.packageId !== undefined && intent.packageId !== "") data.emoji_package_id = intent.packageId;
        if (intent.key !== undefined && intent.key !== "") data.key = intent.key;
        return { segments: [{ type: "mface", data }], mediaRefs: [], fallbackText: intent.label ?? "", native: true };
      }
      return { segments: [], mediaRefs: [], fallbackText: intent.label ?? "（表情）", native: false };
    }
  }
}

// ── 表情包素材库（图片类，最稳、两渠道都能发）─────────────────────────
// 素材就是 assets 表上打了 usable_as_emote 标记的行，语义字段见 assets.ts 的「表情语义」。
// 这一层只负责**进出登记**（谁把一张图变成表情）；**怎么选**在 emote-search.ts，两件事不混在一起。
// 持久化：文件在落盘时已登记，标记只是资产上的属性——所以「删了表情登记、文件失踪」
// 「同一张图在两个库里各有一个名字」这类裂缝从结构上就不成立了。

const KV = "qq.emote.v1";
const ASSET_CAP = 0; // 0 = 不设上限：素材库随导入增长，不再挤掉最早入的素材。

// 机器名判定与语义清洗已下沉到 ./emote-semantics.ts（断开 qq-emote ↔ emote-naming 环）。

/** 老格式（kv 里一整块 JSON）的一行——只服务于一次性迁移。 */
type LegacyEmoteRow = { url: string; label: string; tags: string[] };
/** 读路径就是清洗点：库里存什么样，出去的都保证没有机器名。 */
function readKvBlob(): LegacyEmoteRow[] {
  const raw = kvGet(KV);
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as { assets?: unknown };
    const list = Array.isArray(parsed.assets) ? parsed.assets : [];
    const out: LegacyEmoteRow[] = [];
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const url = typeof row.url === "string" ? row.url : "";
      if (url === "") continue;
      const label = typeof row.label === "string" ? cleanLabel(row.label) : "";
      const tags = Array.isArray(row.tags) ? cleanTags(row.tags.filter((t): t is string => typeof t === "string")) : [];
      out.push({ url, label, tags });
    }
    return out;
  } catch { return []; }
}

/**
 * 素材行必须存在才能打标记。文件不在盘上就拒绝登记——指向一张空气的表情，
 * 到了发送那一刻只会变成一句「本地媒体文件读不到」，不如在这里就不让它进来。
 */
function ensureAssetRow(url: string): boolean {
  if (getAssetByUrl(url) !== null) return true;
  const info = mediaFileInfo(url);
  if (info === null) return false;
  const media = readMedia(url);
  registerAsset({
    id: url.slice("/media/".length).replace(/\.[^.]+$/, ""),
    url,
    kind: mediaTypeOfUrl(url),
    mime: info.mime,
    bytes: info.size,
    hash: media === null ? "" : contentHash(media.buffer),
    source: "imported",
  });
  return getAssetByUrl(url) !== null;
}

/**
 * 一次性迁移：老 blob 搬进 assets 表。
 * 「blob 空了」本身就是已迁移的信号，所以不需要额外的完成标记，也不留第二份真相——
 * 表是唯一出处，重启第二次跑就是 no-op。文件已经不在盘上的那几张会掉（它们本来也发不出去）。
 *
 * 这里**原样**写 label/tags，不做语义拆分：拆句柄的规则只在 assets.ts 里写了一份，
 * 由紧随其后的 migrateEmoteSemantics() 统一执行。两条迁移串在一个地方，不会出现
 * 「新导的走一套拆法、老数据走另一套」。
 */
export function migrateEmoteStore(): boolean {
  const blob = readKvBlob();
  if (blob.length === 0) return false;
  const moved = blob.filter((item) => registerEmoteAsset(item.url, { label: item.label, tags: item.tags }, "imported")).length;
  kvSet(KV, "");
  return moved > 0;
}

// 模块加载即迁移：任何消费者（路由 / 工具 / 媒体引用扫描）拿到的都已经是表里的数据，
// 而且语义列已经拆好——检索层不需要知道 kv 时代曾经存在过。
migrateEmoteStore();
migrateEmoteSemantics();

/**
 * 登记一张本地图片进表情包素材库（url 应为 /media 路径）。同 url 重复登记就是覆盖它的语义字段。
 * source 是这条素材的来路——不给就不改（迁移老数据时宁可留「还没归类」，也不编一个来路）。
 */
export function registerEmoteAsset(url: string, patch: EmoteSemantics = {}, source?: AssetSource): boolean {
  if (url === "" || !ensureAssetRow(url)) return false;
  if (source !== undefined) claimAsset(url, { source });
  return markEmote(url, {
    ...(patch.label !== undefined ? { label: cleanLabel(patch.label) } : {}),
    ...(patch.tags !== undefined ? { tags: cleanTags(patch.tags) } : {}),
    ...(patch.caption !== undefined ? { caption: cleanLabel(patch.caption) } : {}),
    ...(patch.alias !== undefined ? { alias: cleanTags(patch.alias) } : {}),
    ...(patch.pack !== undefined ? { pack: cleanTags(patch.pack) } : {}),
    ...(patch.namedAt !== undefined ? { namedAt: patch.namedAt } : {}),
    ...(patch.namedBy !== undefined ? { namedBy: patch.namedBy } : {}),
  });
}

/** 摘掉一个素材标记。文件本体不动——它还被别的引用用着，或者根本就该由清理通道收口。 */
export function removeEmoteAsset(url: string): boolean { return unmarkEmote(url); }

/** 素材库统计：总数 + 上限（界面概览条用）。cap 恒为 0＝不设上限，素材库按导入增长、不淘汰老素材。 */
export function emoteStats(): { total: number; cap: number } {
  return { total: listMarkedEmotes().length, cap: ASSET_CAP };
}

/**
 * 内置表情的口语叫法 → FACES 表的关键词。
 *
 * 这张表**只服务内置 face 那一层**，不再管素材库。内置表情是一套固定的词，静态映射才是它正确的
 * 形态；素材库的中文名字是数据——每个用户自己导进来的东西各有各的叫法，一张写死在源码里的表
 * 永远追不上（实测 200 张素材里只有 34 张经由那张 65 条的手写表可达，剩下 166 张模型怎么猜都猜不到）。
 * 表里没有对应内置表情的那些词（困/晚安/咖啡）就是没有，不硬编一个假表情顶上。
 */
const FACE_SYNONYMS: Record<string, string[]> = {
  "笑": ["大笑", "偷笑", "开心"], "笑死": ["大笑", "开心"], "哈哈哈": ["大笑"], "哈": ["大笑"],
  "哭": ["大哭", "伤心"], "哭哭": ["大哭"], "呜呜": ["大哭", "伤心"], "委屈": ["委屈", "伤心"],
  "生气": ["生气"], "火大": ["火大", "生气"], "气": ["生气"], "怒": ["生气"],
  "赞": ["赞", "强"], "好": ["赞", "强"], "牛": ["强"], "厉": ["强"], "顶": ["赞"],
  "惊": ["惊讶", "吃惊"], "哇": ["惊讶"], "天哪": ["惊讶"],
  "羞": ["害羞", "脸红"], "亲亲": ["亲亲"], "亲": ["亲亲"],
  "爱心": ["爱心"], "喜欢": ["喜欢"], "比心": ["比心"], "爱": ["爱心", "喜欢"],
  "想": ["思考"], "嗯": ["嗯"], "酷": ["酷"], "晕": ["晕"], "微笑": ["微笑"],
};

// 素材库「怎么选」整段搬到 emote-search.ts：分层打分 + 中文 n-gram，批次名不参与匹配。
// 这一层只留内置 face 的兜底——库里没有够贴的图，才退到 QQ 自带表情那几个词。

// ── 种子/目录批量导入（按内容 md5 去重，重扫不会重复入库）────────────
// 把本地某个文件夹里的图片文件夹播进素材库。每个源文件算一次内容指纹，
// 指纹存进独立的 KV manifest，第二次扫同一目录直接跳过——
// 用户换个文件夹名、多扫几遍，素材库不会越扫越脏。
const IMPORT_KV_PREFIX = "qq.emote.import.";
/**
 * 导入文件夹这一条单独放宽到 20MB：那是用户主动把本地图包交给她，落盘就是静态文件。
 * 全局那道 5MB 闸（MAX_IMAGE_BYTES）管的是自动来的字节——聊天入站抓取、网页找图、
 * 以及要 base64 内联喂视觉模型的那些，跟着一起抬会把十几 MB 的载荷推进对话请求里。
 * 真库实测：5.2MB 的 PNG 在 deepseek 档 7.5s 正常认完；发送侧 OneBot 走本地路径不内联，
 * 官方渠道的 GIF 本来就先派生静帧，所以这两张 5~6MB 的动图进库后不会撞别的墙。
 */
export const MAX_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024;

type SkippedFile = { name: string; reason: string };
type ImportRecord = { added: number; skipped: number; total: number; skippedFiles: SkippedFile[] };
/** 回执里最多列几张被跳过的文件；总数照实报，明细只是让人知道「为什么少了两张」。 */
const SKIPPED_REPORT_CAP = 40;
function contentMd5(buffer: Buffer): string { return createHash("md5").update(buffer).digest("hex"); }

/**
 * 批量表情包的常见文件名是「流水号_名字」（`10N01_猫猫搓手`、`N06_略略略`）。
 * 那串前缀是打包者的编号，不是这张图在说什么——直接当名字，界面上就是一串认不出的字符。
 * 只在剥完剩下的确实是人话时才剥，免得把 `heart-hands` 这种句柄切成 `hands`。
 */
export function stripIndexPrefix(value: string): string {
  const rest = value.replace(/^[0-9A-Za-z]+[_-]/, "").trim();
  return rest !== "" && isHumanName(rest) ? rest : value;
}

/** 文件夹名＝路径最后一段（去掉盘符/尾斜杠）。导入的归属文件夹就是它，没有第二个名字来源。 */
export function folderNameOf(dir: string): string {
  return dir.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/**
 * 扫描一个目录（**不递归子目录**，一层即可）把图片导入素材库。
 * 每张图先复制进媒体库（`/media` 统一路径，两条渠道都能发），再登记成 asset。
 * 归属文件夹＝源文件夹名：文件夹层是来源事实，导入时不再接受手填的别名。
 * 返回本次实际新增 / 跳过的张数**和被跳过的文件名+原因**，方便界面回执"导入了 N 张、少了哪两张"。
 */
export function importEmoteDir(dir: string): ImportRecord | { error: string } {
  const abs = dir.trim();
  if (abs === "") return { error: "没有给目录" };
  let entries: string[];
  try {
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return { error: "目录不存在或不是文件夹" };
    entries = readdirSync(abs);
  } catch (error) {
    return { error: "读目录失败：" + (error instanceof Error ? error.message : String(error)) };
  }
  const packName = folderNameOf(abs);
  const manifestKey = IMPORT_KV_PREFIX + createHash("md5").update(abs.split(/[\\/]/).filter(Boolean).join("/")).digest("hex").slice(0, 16);
  const rawManifest = kvGet(manifestKey);
  const seen: Set<string> = new Set(rawManifest ? (JSON.parse(rawManifest) as string[]) : []);
  let added = 0; let skipped = 0;
  const skippedFiles: SkippedFile[] = [];
  /** 被跳过的每一张都要有名字和原因：只报个数字，用户就只能猜「少的那两张是哪来的」。 */
  const noteSkip = (name: string, reason: string): void => {
    skipped += 1;
    if (skippedFiles.length < SKIPPED_REPORT_CAP) skippedFiles.push({ name, reason });
  };
  for (const name of entries) {
    const file = join(abs, name);
    let buffer: Buffer;
    try {
      if (!statSync(file).isFile()) continue;
      buffer = readFileSync(file);
    } catch { continue; }
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    // 非图片扩展名不算「跳过」——README/说明文件本来就不是表情材料，报进回执只会让人以为丢了图。
    if (!["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) continue;
    const mime = sniffImageMime(buffer);
    if (mime === "") { noteSkip(name, "读不出是图片"); continue; }
    if (buffer.length > MAX_IMPORT_IMAGE_BYTES) {
      noteSkip(name, `超过 ${Math.round(MAX_IMPORT_IMAGE_BYTES / 1024 / 1024)}MB 上限`);
      continue;
    }
    const md5 = contentMd5(buffer);
    if (seen.has(md5)) { noteSkip(name, "库里已经有同一张图"); continue; }
    // 直接落进 表情包/<源文件夹名>/：磁盘位置和库里的归属同一步写就，不存在中间态。
    const saved = saveImage(buffer, mime, dirFor({ emote: true, folder: packName, kind: "image" }), MAX_IMPORT_IMAGE_BYTES);
    // 落盘名是内容哈希，源文件名不在登记时留档就再也对不回那个包（认图也拿不到「导入时叫什么」这条线索），
    // 所以句柄一律进 alias——机器名（纯 hex/UUID）除外，那串字符本来就不可读。
    // 名字里带中文才直接当名字用（省一次识别），但先剥掉批量包的流水号前缀：`10N01_猫猫搓手` 说的是「猫猫搓手」。
    const raw = name.replace(/\.[^.]+$/, "");
    const handle = isMachineName(raw) ? "" : raw;
    const cleanName = stripIndexPrefix(handle);
    const pack = packName === "" ? [] : [packName];
    const patch: EmoteSemantics = { ...(handle === "" ? {} : { alias: [handle] }), pack };
    if (isHumanName(cleanName)) {
      patch.label = cleanName;
      patch.tags = [cleanName];
      patch.namedAt = Date.now();
      patch.namedBy = "file";
    }
    registerEmoteAsset(saved.url, patch, "imported");
    seen.add(md5);
    added += 1;
  }
  const allSeen = new Set([...(rawManifest ? (JSON.parse(rawManifest) as string[]) : []), ...seen]);
  kvSet(manifestKey, JSON.stringify([...allSeen]));
  return { added, skipped, total: entries.length, skippedFiles };
}

// ── 自动采集：把用户发来的图片顺手登记（开关默认关）──────────────────
// 采集开关存进独立 KV；默认值读 env config（QQ_EMOTE_AUTO_CAPTURE，默认关）。
const PREFS_KV = "qq.emote.prefs";

export function emoteAutoCapture(): boolean {
  const raw = kvGet(PREFS_KV);
  if (raw === null || raw === "") return config.qq.emoteAutoCapture;
  try { return (JSON.parse(raw) as { autoCapture?: unknown }).autoCapture === true; }
  catch { return config.qq.emoteAutoCapture; }
}
export function setEmoteAutoCapture(on: boolean): void {
  kvSet(PREFS_KV, JSON.stringify({ autoCapture: on === true }));
}

/**
 * 入站媒体钩子：用户发来一张图片，开关开着就顺手入库，成为以后可接的表情素材。
 * url 应是已落盘的 /media 路径。采集时不猜名字——语义交给认图作业，猜出来的名字是错的还改不掉。
 * 关掉开关时是纯 no-op（不入库、不报错）。
 * 去重按内容哈希：同一张梗图被反复转发时每次落盘都是新文件名，按 URL 挡不住，
 * 只有指纹认得出「这还是那张」；重复入库会让检索抽奖、界面刷屏。
 * 收进一张就排一次延时补名（防抖）——没名字的采集件在检索里等于不存在。
 */
export function captureInboundEmote(url: string): boolean {
  if (url === "" || !url.startsWith("/media/")) return false;
  if (!emoteAutoCapture()) return false;
  const media = readMedia(url);
  if (media !== null && findEmoteAssetByHash(contentHash(media.buffer), url) !== null) return false;
  if (!registerEmoteAsset(url, {}, "captured")) return false;
  scheduleCaptureNaming();
  return true;
}
