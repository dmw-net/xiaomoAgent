import { getJson, postJson } from "./client";

/** 视角是参数，不是功能：一个页面用同一个接口，切换的就是这几个值。 */
export type AssetView = "all" | "emote" | "starred" | "generated" | "chat";
export type AssetKind = "image" | "video" | "audio" | "file";
export type AssetKindFilter = "all" | AssetKind;

/** 联表现取的展示信息（作品提示词、语音转写等），不复制进资产表。 */
export type AssetDetail = {
  artifactId: string;
  prompt: string;
  shape: string;
  withReference: boolean;
  transcript: string;
  waveform: number[];
  originRole: string;
  originText: string;
};

export type Asset = {
  id: string;
  url: string;
  kind: AssetKind;
  mime: string;
  bytes: number;
  hash: string;
  source: string;
  contactId: string;
  originRef: string;
  refCount: number;
  refKinds: string[];
  usableAsEmote: boolean;
  emoteLabel: string;
  emoteTags: string[];
  /** 表情语义层：一句话用法 / 别名（含文件句柄）/ 文件夹归属 / 认图时间 / 发过几次。 */
  emoteCaption: string;
  emoteAlias: string[];
  /** 文件夹层：单一归属，恒为单元素数组（导入→源文件夹名，其余→「默认」）。 */
  emotePack: string[];
  emoteNamedAt: number;
  /** 名字是谁给的：auto＝智能识别，manual＝人写的或改过的，空＝还没名字。 */
  emoteNameSource: string;
  emoteUseCount: number;
  /** 文件在媒体目录里的相对位置（表情包/<文件夹>/x.gif 或 图片/x.jpg）；桌面端「在文件管理器中显示」用它。 */
  relPath: string;
  /** 原图不在盘上了：卡片标「已失效」，检索与发送都排除它，放回文件自动恢复。 */
  missing: boolean;
  starred: boolean;
  durationMs?: number;
  originMessageId?: number;
  createdAt: number;
  detail: AssetDetail;
};

export type EmotePackCount = { pack: string; total: number; unnamed: number; auto: number; manual: number };

/** 识别进度与来源分布：概览条那一行数字读它。 */
export type NamingStats = { total: number; named: number; auto: number; manual: number };

export type EmoteNamedFilter = "any" | "unnamed" | "auto" | "manual";

export type AssetListResult = {
  ok: boolean;
  view: AssetView;
  kind: AssetKindFilter;
  items: Asset[];
  total: number;
  counts: Record<AssetView, number>;
  kindCounts: Record<AssetKindFilter, number>;
  stats: { total: number; bytes: number; emotes: number; broken: number };
  /** 识别进度：界面上那颗「智能识别」要不要出现、概览条写什么数，读这个。 */
  naming: NamingStats;
  /** 文件夹清单（文件夹名 + 张数 + 还有几张没命名）。 */
  packs: EmotePackCount[];
  /** 媒体落盘目录的绝对路径：桌面端「在文件管理器中显示」按它拼原图路径。 */
  mediaDir: string;
};

export type AssetQuery = {
  view?: AssetView;
  kind?: AssetKindFilter;
  q?: string;
  /** 按文件夹筛（文件夹名不参与语义匹配，但可以是筛选条件）。 */
  pack?: string;
  /** 按命名状态筛：未命名 / AI 命名 / 手动维护。 */
  named?: EmoteNamedFilter;
  /** 给了就是「和某人」视角；不给是全库。注意不要走 cq——它会无条件带上当前联系人。 */
  contactId?: string;
  limit: number;
  offset: number;
};

export function listAssets(query: AssetQuery): Promise<AssetListResult> {
  const p = new URLSearchParams();
  p.set("view", query.view ?? "all");
  p.set("kind", query.kind ?? "all");
  p.set("limit", String(query.limit));
  p.set("offset", String(query.offset));
  const q = (query.q ?? "").trim();
  if (q !== "") p.set("q", q);
  const pack = (query.pack ?? "").trim();
  if (pack !== "") p.set("pack", pack);
  if (query.named !== undefined && query.named !== "any") p.set("named", query.named);
  if (query.contactId !== undefined && query.contactId !== "") p.set("contactId", query.contactId);
  return getJson<AssetListResult>("/api/assets?" + p.toString());
}

export type AssetAction = "markEmote" | "unmarkEmote" | "editEmote" | "probeMissing" | "dropMissing" | "star" | "unstar";

/** 只动资产自己的标记；文件本体归媒体清理那条线。 */
export function assetAction(
  op: AssetAction, id: string,
  extra: {
    label?: string; tags?: string[]; caption?: string; alias?: string[]; pack?: string[];
  } = {},
): Promise<{ ok: boolean; error?: string; marked?: boolean }> {
  return postJson("/api/assets", { op, id, ...extra });
}
