// 资产注册表：系统里每一个媒体文件，在**落盘那一刻**就有一行记录。
//
// 为什么要有这张表（而不是继续让「表情库 / 内容库 / 媒体清理」各自记一份）：
// 文件的身份此前散在四处——kv 里的一个 JSON blob、artifacts 表、messages.attachments 的字符串、
// 以及「扫全库找 /media/ 子串」这套引用探测。后果不是难看，是**丢东西**：2026-09-28 两张已经画成的
// 自拍被清理器当孤儿删掉，因为「画成功」和「消息落地」是两个时刻，中间一断，文件就没人认领了。
//
// 两段式登记，是这套设计的核心：
//   1) 存在性 = 构造保证。media.ts 的四个 save 函数直接调 registerAsset，调用方**没有忘记的余地**。
//      就算上游一个认领都没做，文件也只是「来源未知」，永远不会被当孤儿删。
//   2) 溯源 = 对账补齐。syncAssetRefs 从既有引用源把 source / contact_id / ref_count 填进来。
//      漏填的代价降级成「这一张我不知道是谁产生的」，而不是「这一张被删了」。
// 也就是说：引用探测那套纪律还是会漏，但它漏掉的后果从数据丢失变成了可见的元数据缺口。
//
// 回收站不在这里：文件一旦进回收站就不属于当前资产，行随之删除；恢复时重新登记。

import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { KIND_DIR, currentFileOf, relocate, syncEmoteLocation } from "./media-layout.ts";

export type AssetKind = "image" | "video" | "audio" | "file";

/** 资产来源。`unclaimed` ＝ 已落盘但还没有人认领它是干什么的——这是合法状态，不是错误。 */
export type AssetSource =
  | "unclaimed" | "upload" | "chat" | "generated" | "imported"
  | "captured" | "avatar" | "face_ref" | "wallpaper" | "tool" | "derived";

export type AssetRow = {
  id: string;
  url: string;
  kind: AssetKind;
  mime: string;
  bytes: number;
  hash: string;
  source: AssetSource;
  contactId: string;
  originRef: string;
  refCount: number;
  refKinds: string[];
  usableAsEmote: boolean;
  emoteLabel: string;
  emoteTags: string[];
  /** 表情的语义层：一句话用法、可叫法（含文件句柄）、文件夹归属、认图时间、发过几次。 */
  emoteCaption: string;
  emoteAlias: string[];
  emotePack: string[];
  emoteNamedAt: number;
  emoteNameSource: string;
  emoteUseCount: number;
  /** 文件在媒体目录里的相对位置；空=未归位（遗留平铺）。 */
  relPath: string;
  /** 盘上找不到文件了：界面标「已失效」，检索/发送排除。 */
  missing: boolean;
  starred: boolean;
  /** 语音时长（毫秒）。只有音频有，来自消息元信息，非音频为 undefined。 */
  durationMs?: number;
  /** 派生形态的父资产 id；用户自己的一份东西没有这个。 */
  parentId?: string;
  /** 出处消息 id：作品提示词、语音转写这些不复制进本表，靠它联表现取。 */
  originMessageId?: number;
  createdAt: number;
};

db.exec(`
CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,
  url             TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  mime            TEXT NOT NULL DEFAULT '',
  bytes           INTEGER NOT NULL DEFAULT 0,
  hash            TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'unclaimed',
  contact_id      TEXT NOT NULL DEFAULT '',
  origin_ref      TEXT NOT NULL DEFAULT '',
  ref_count       INTEGER NOT NULL DEFAULT 0,
  ref_kinds       TEXT NOT NULL DEFAULT '',
  usable_as_emote INTEGER NOT NULL DEFAULT 0,
  emote_label     TEXT NOT NULL DEFAULT '',
  emote_tags      TEXT NOT NULL DEFAULT '[]',
  /** 表情的语义层。见文件末尾「表情语义」那一段：名字/别名/文件夹各归各，文件夹名不参与匹配。 */
  emote_caption   TEXT NOT NULL DEFAULT '',
  emote_alias     TEXT NOT NULL DEFAULT '[]',
  emote_pack      TEXT NOT NULL DEFAULT '[]',
  emote_named_at  INTEGER NOT NULL DEFAULT 0,
  /** 这个名字是谁给的：auto＝智能识别写的，manual＝人写的或改过的。空＝还没名字。 */
  emote_name_source TEXT NOT NULL DEFAULT '',
  emote_use_count INTEGER NOT NULL DEFAULT 0,
  /** 文件在媒体目录里的相对位置（表情包/<文件夹>/x.gif 或 图片/x.jpg）。空=还没归位，按遗留平铺看。 */
  rel_path        TEXT NOT NULL DEFAULT '',
  /** 库里有行、盘上找不到文件（被删/移出库外）：界面标「已失效」，检索与发送都排除它。 */
  missing         INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  origin_message_id INTEGER,
  /** 派生形态（动图的静帧这类）挂在父资产下：它不是用户的一份东西，不该出现在媒体库里。 */
  parent_id       TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assets_contact_time ON assets (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_emote ON assets (usable_as_emote);
`);

/**
 * 文件夹层：每张表情**恰好属于一个文件夹**（emote_pack 存单元素数组）。
 * 导入的→源文件夹名；单传/聊天/其它一切→DEFAULT_EMOTE_FOLDER。
 * 这一层只用于分组筛选，不参与检索打分；它是"从哪来"的快照标签，不是磁盘的实时链接。
 */
export const DEFAULT_EMOTE_FOLDER = "默认";

/** 归一成一个文件夹：给了取第一个，没给/空→默认。多归属是旧形态，收敛到单一父级。 */
export function oneFolder(pack: string[] | undefined): string[] {
  const first = (pack ?? []).find((v) => v.trim() !== "");
  return [first !== undefined ? first : DEFAULT_EMOTE_FOLDER];
}

// 老库补语义列：CREATE TABLE 里的定义只对新库生效，已经在跑的那份要 ALTER 上去。
// 「列在不在」本身就是迁移状态，所以不需要额外的完成标记。
const EMOTE_SEMANTIC_COLUMNS: Array<[string, string]> = [
  ["emote_caption", "TEXT NOT NULL DEFAULT ''"],
  ["emote_alias", "TEXT NOT NULL DEFAULT '[]'"],
  ["emote_pack", "TEXT NOT NULL DEFAULT '[]'"],
  ["emote_named_at", "INTEGER NOT NULL DEFAULT 0"],
  ["emote_name_source", "TEXT NOT NULL DEFAULT ''"],
  ["emote_use_count", "INTEGER NOT NULL DEFAULT 0"],
];
// 存储布局列（不是表情语义）：文件落点与失效状态。和语义列同一套「缺就补」机制。
const STORAGE_COLUMNS: Array<[string, string]> = [
  ["rel_path", "TEXT NOT NULL DEFAULT ''"],
  ["missing", "INTEGER NOT NULL DEFAULT 0"],
];
{
  const have = new Set((db.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, decl] of [...EMOTE_SEMANTIC_COLUMNS, ...STORAGE_COLUMNS]) {
    if (!have.has(name)) db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${decl}`);
  }
  backfillEmoteNameSource();
  backfillEmoteFolder();
}

type AssetInput = {
  id: string;
  url: string;
  kind: AssetKind;
  mime?: string;
  bytes?: number;
  hash?: string;
  source?: AssetSource;
  contactId?: string;
  originRef?: string;
  /** 派生形态的父资产 id（动图静帧这类）。给了就不进媒体库列表。 */
  parentId?: string;
  /** 文件在媒体目录里的相对位置（save* 落哪记哪；对账兜底时也会补）。 */
  relPath?: string;
  /** 登记即表情（对账从 表情包/<文件夹>/ 认领文件时用），普通入库不给。 */
  usableAsEmote?: boolean;
  emotePack?: string[];
};

/**
 * 落盘即登记。重复登记同一个 id 只补元数据，不重置 created_at——
 * 时间线上「这张图什么时候进来的」是用户看得见的顺序，不能被一次对账打乱。
 */
export function registerAsset(input: AssetInput): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO assets (id, url, kind, mime, bytes, hash, source, contact_id, origin_ref, parent_id, rel_path, usable_as_emote, emote_pack, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mime = CASE WHEN excluded.mime <> '' THEN excluded.mime ELSE assets.mime END,
      bytes = CASE WHEN excluded.bytes > 0 THEN excluded.bytes ELSE assets.bytes END,
      hash = CASE WHEN excluded.hash <> '' THEN excluded.hash ELSE assets.hash END,
      source = CASE WHEN assets.source = 'unclaimed' THEN excluded.source ELSE assets.source END,
      contact_id = CASE WHEN assets.contact_id = '' THEN excluded.contact_id ELSE assets.contact_id END,
      origin_ref = CASE WHEN assets.origin_ref = '' THEN excluded.origin_ref ELSE assets.origin_ref END,
      parent_id = COALESCE(assets.parent_id, excluded.parent_id),
      rel_path = CASE WHEN excluded.rel_path <> '' THEN excluded.rel_path ELSE assets.rel_path END,
      missing = 0,
      updated_at = excluded.updated_at
  `).run(
    input.id, input.url, input.kind, input.mime ?? "", input.bytes ?? 0, input.hash ?? "",
    input.source ?? "unclaimed", input.contactId ?? "", input.originRef ?? "",
    input.parentId ?? null, input.relPath ?? "", input.usableAsEmote === true ? 1 : 0,
    JSON.stringify(input.emotePack ?? []), now, now,
  );
}

/** 一个「字符串数组」列的读法。坏 JSON 一律当空数组读，不让一行脏数据把整页拖崩。 */
function parseStringColumn(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch { return []; }
}

function rowToAsset(row: Record<string, unknown>): AssetRow {
  return {
    id: String(row.id),
    url: String(row.url),
    kind: String(row.kind) as AssetKind,
    mime: String(row.mime ?? ""),
    bytes: Number(row.bytes ?? 0),
    hash: String(row.hash ?? ""),
    source: String(row.source ?? "unclaimed") as AssetSource,
    contactId: String(row.contact_id ?? ""),
    originRef: String(row.origin_ref ?? ""),
    refCount: Number(row.ref_count ?? 0),
    refKinds: String(row.ref_kinds ?? "").split(",").filter(Boolean),
    usableAsEmote: Number(row.usable_as_emote ?? 0) === 1,
    emoteLabel: String(row.emote_label ?? ""),
    emoteTags: parseStringColumn(row.emote_tags),
    emoteCaption: String(row.emote_caption ?? ""),
    emoteAlias: parseStringColumn(row.emote_alias),
    emotePack: parseStringColumn(row.emote_pack),
    emoteNamedAt: Number(row.emote_named_at ?? 0),
    emoteNameSource: String(row.emote_name_source ?? ""),
    emoteUseCount: Number(row.emote_use_count ?? 0),
    relPath: String(row.rel_path ?? ""),
    missing: Number(row.missing ?? 0) === 1,
    starred: Number(row.starred ?? 0) === 1,
    ...(row.duration_ms === null || row.duration_ms === undefined ? {} : { durationMs: Number(row.duration_ms) }),
    ...(row.parent_id === null || row.parent_id === undefined ? {} : { parentId: String(row.parent_id) }),
    ...(row.origin_message_id === null || row.origin_message_id === undefined
      ? {} : { originMessageId: Number(row.origin_message_id) }),
    createdAt: Number(row.created_at ?? 0),
  };
}

export function getAssetByUrl(url: string): AssetRow | null {
  const row = db.prepare("SELECT * FROM assets WHERE url = ?").get(url) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToAsset(row);
}

export function getAssetById(id: string): AssetRow | null {
  const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToAsset(row);
}

/**
 * 按内容哈希找已入库的表情——采集去重专用。同一张梗图被反复转发是日常，
 * 按 URL 去重挡不住（每次落盘都是新文件名），只有内容指纹认得出「这还是那张」。
 * 失效行不算命中：原图都被删了，再收到同样内容应当登记成新的一份。
 */
export function findEmoteAssetByHash(hash: string, exceptUrl: string): AssetRow | null {
  if (hash === "") return null;
  const row = db.prepare(
    "SELECT * FROM assets WHERE hash = ? AND usable_as_emote = 1 AND missing = 0 AND url <> ? LIMIT 1",
  ).get(hash, exceptUrl) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToAsset(row);
}

/** 内容哈希：去重、渠道凭证缓存、跨源比对都靠它，所以只在真正需要时算（读一次文件）。 */
export function contentHash(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

// ── 表情素材：assets 上的一个标记，不再是 kv 表里的独立 blob ──────────────
//
// 「联系人发出的一张表情图」和「这张图存在」是同一件事的两个属性。分成两处存，就出现了
// 「删了表情登记、文件还留在盘上」「同一张图在内容库和表情库各有一份名字」这类裂缝。
//
// 语义层的字段分工（检索只读前三样，文件夹名刻意排除在外）：
//   emote_label   这张图**作为一句回复时说的话**，中文，一个短词。界面上的名字，也是打分主字段。
//   emote_tags    中文语义标签：视角、语气、触发场景、画面配字。多对多，用来兜住 label 说不全的。
//   emote_caption 一句用法说明（「上一句是…的时候甩它」），给 emote_search 的候选行、界面副标题。
//   emote_alias   英文文件句柄 + 口语叫法。次级权重，让「heart-hands」这种原名仍然可达。
//   emote_pack    文件夹名（导入时取源文件夹名，其它进「默认」）。**只做筛选与统计，不参与语义匹配**——
//                 一个文件夹名挂在几十张图上，进了匹配就等于「搜一个词命中全库、然后抽奖」。

export type EmoteSemantics = {
  label?: string;
  tags?: string[];
  caption?: string;
  alias?: string[];
  pack?: string[];
  /** 什么时候算「识别过」的。识别作业写它，导入时人话文件名也写它。 */
  namedAt?: number;
  /** 这个名字是谁给的：识别作业写 auto，人写的/从文件名读到的写 manual。 */
  namedBy?: "auto" | "manual" | "file";
};

/**
 * 语义字段必须是对象。写成 `markEmote(url, "大笑", ["哈"])` 这种老调用形状时，
 * 不挡就是**静默写空**——库里那一行还在、标记也打上了，只是名字和标签全没了，
 * 界面上看起来「一切正常」，检索却再也找不到它。（这一条是真踩过：改签名那轮，
 * 三个 .mjs 调用点就这么悄悄变成了 no-op，测试仍然一片绿。）
 */
function semanticsPatch(value: unknown): EmoteSemantics {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("表情语义要用对象传：{ label, tags, caption, alias, pack, namedAt }");
  }
  return value as EmoteSemantics;
}

/** 给了哪个字段就写哪个，没给的不动——认图作业只回填语义，不能顺手把用户的文件夹归类抹掉。 */
export function applyEmoteSemantics(url: string, patch: EmoteSemantics): boolean {
  const sets: string[] = [];
  const args: Array<string | number> = [];
  const text = (column: string, value: string): void => { sets.push(`${column} = ?`); args.push(value); };
  const list = (column: string, value: string[]): void => { sets.push(`${column} = ?`); args.push(JSON.stringify(value)); };
  const next = semanticsPatch(patch);
  if (next.label !== undefined) text("emote_label", next.label);
  if (next.caption !== undefined) text("emote_caption", next.caption);
  if (next.tags !== undefined) list("emote_tags", next.tags);
  if (next.alias !== undefined) list("emote_alias", next.alias);
  if (next.pack !== undefined) list("emote_pack", oneFolder(next.pack));
  if (next.namedAt !== undefined) { sets.push("emote_named_at = ?"); args.push(next.namedAt); }
  if (next.namedBy !== undefined) { sets.push("emote_name_source = ?"); args.push(next.namedBy); }
  if (sets.length === 0) return getAssetByUrl(url) !== null;
  const before = next.pack !== undefined ? getAssetByUrl(url) : null;
  const changed = db.prepare(`UPDATE assets SET ${sets.join(", ")}, updated_at = ? WHERE url = ?`)
    .run(...args, Date.now(), url);
  // 文件夹改到哪个，磁盘上的文件就跟到哪个目录——界面所见即磁盘所在，用户直接开文件夹验收。
  if (changed.changes > 0 && next.pack !== undefined && before !== null && before.usableAsEmote) {
    syncEmoteLocation(url, oneFolder(next.pack), true);
  }
  return changed.changes > 0;
}

/**
 * 打标 = 重新登记这张表情：没给的语义字段回到空，让「刚导进来一堆中文名」和「刚导进来一堆空气」在库里长得不一样。 */
export function markEmote(url: string, patch: EmoteSemantics = {}): boolean {
  const now = Date.now();
  const next = semanticsPatch(patch);
  const changed = db.prepare(
    `UPDATE assets SET usable_as_emote = 1, emote_label = ?, emote_tags = ?, emote_caption = ?, emote_alias = ?,
       emote_pack = ?, emote_named_at = ?, emote_name_source = ?, missing = 0, updated_at = ? WHERE url = ?`,
  ).run(next.label ?? "", JSON.stringify(next.tags ?? []), next.caption ?? "",
    JSON.stringify(next.alias ?? []), JSON.stringify(oneFolder(next.pack)), next.namedAt ?? 0, next.namedBy ?? "", now, url);
  if (changed.changes > 0) syncEmoteLocation(url, oneFolder(next.pack), true);
  return changed.changes > 0;
}

/** 发出去一次就记一笔：打分用它做轻微上浮，界面用它把「联系人常甩的」排前面。 */
export function bumpEmoteUse(id: string): void {
  db.prepare("UPDATE assets SET emote_use_count = emote_use_count + 1 WHERE id = ? AND usable_as_emote = 1").run(id);
}

/**
 * 把「有名字但没记来源」的行补上来源。
 *
 * 导入中文文件名会写 namedAt，但旧版本漏了 namedBy；这些名字是用户提供的，归 manual。
 * 其余历史行只可能是认图作业写的，归 auto。不回填时概览条的三档加不回总数，
 * 用户第一个怀疑的就是数据坏了。写成幂等的：每次启动跑一次，没有可回填的就不动。
 */
export function backfillEmoteNameSource(): number {
  return Number(db.prepare(
    `UPDATE assets SET emote_name_source = CASE WHEN source = 'imported' THEN 'file' ELSE 'auto' END
       WHERE emote_named_at > 0 AND emote_name_source = ''`,
  ).run().changes);
}

/**
 * 文件夹层收敛旧数据：空归属→默认文件夹，多归属→取第一个。
 * 幂等：已经是单元素且非空的行原样跳过，不碰 updated_at——
 * 这是元数据归一，不是用户编辑，不该把时间线顺序打乱。
 */
export function backfillEmoteFolder(): number {
  const rows = db.prepare("SELECT url, emote_pack FROM assets WHERE usable_as_emote = 1")
    .all() as Array<{ url: string; emote_pack: string }>;
  const write = db.prepare("UPDATE assets SET emote_pack = ? WHERE url = ?");
  let changed = 0;
  for (const row of rows) {
    const pack = parseStringColumn(row.emote_pack);
    const folder = oneFolder(pack);
    if (pack.length === 1 && pack[0] === folder[0]) continue;
    write.run(JSON.stringify(folder), row.url);
    changed += 1;
  }
  return changed;
}

/** 识别进度与来源分布：界面上那颗「智能识别」按钮、概览条那行数字都读它。 */
export function emoteNamingStats(): { total: number; named: number; auto: number; manual: number; file: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN emote_named_at > 0 THEN 1 ELSE 0 END), 0) AS named,
           COALESCE(SUM(CASE WHEN emote_named_at > 0 AND emote_name_source = 'auto' THEN 1 ELSE 0 END), 0) AS auto,
           COALESCE(SUM(CASE WHEN emote_named_at > 0 AND emote_name_source = 'manual' THEN 1 ELSE 0 END), 0) AS manual,
           COALESCE(SUM(CASE WHEN emote_named_at > 0 AND emote_name_source NOT IN ('auto', 'manual') THEN 1 ELSE 0 END), 0) AS file
      FROM assets WHERE usable_as_emote = 1 AND parent_id IS NULL
  `).get() as { n: number; named: number; auto: number; manual: number; file: number };
  return { total: row.n, named: row.named, auto: row.auto, manual: row.manual, file: row.file };
}

/** 命名状态筛选：界面上「未命名 / 智能识别 / 手动维护」那排 chips 就是这几个值。 */
export type EmoteNamedFilter = "any" | "unnamed" | "file" | "auto" | "manual";
const NAMED_CLAUSE: Record<EmoteNamedFilter, string> = {
  any: "",
  unnamed: "emote_named_at = 0",
  auto: "emote_named_at > 0 AND emote_name_source = 'auto'",
  manual: "emote_named_at > 0 AND emote_name_source = 'manual'",
  // 老数据可能只有名字、没有来源。导入文件名与来源未记录都归「文件命名」，
  // 不能让有名字的图在分类里凭空消失，也不能冒充用户手改。
  file: "emote_named_at > 0 AND emote_name_source NOT IN ('auto', 'manual')",
};

/**
 * 「这个名字是人话还是文件名」的唯一判据：整串里有没有中日韩文字。
 * 导入、语义迁移、认图作业都读它——三处各写一份正则，早晚对不上。
 */
export function isHumanName(value: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value);
}

/**
 * 把「挤在一个 tags 数组里的两种东西」拆开：文件句柄进 alias，剩下的才是语义标签。
 *
 * 文件夹**不在这里猜**。曾经有一条「共享度 ≥3 就当批次名搬进 pack」的规则，
 * 真库上它把 47 个模型给的语义词（女仆 28 张、女仆装 27、摆烂 17…）啃进了不参与检索的 pack。
 * 文件夹层改成来源事实之后（导入→源文件夹名，其余→默认），归属在登记那一刻就写好了，
 * 靠词频反推文件夹既无必要、又会覆盖来源——这条规则整个退役，不是加守卫。
 *
 * 仍只作用在从没识别过的行上：识别过的行，名字与标签就是权威数据，不再重新解释。
 */
export function migrateEmoteSemantics(): { split: number } {
  const rows = listEmoteAssets().filter((r) => r.emoteNamedAt === 0);
  if (rows.length === 0) return { split: 0 };
  let split = 0;
  for (const row of rows) {
    const original = row.emoteLabel;
    const alias = new Set(row.emoteAlias);
    const semantic: string[] = [];
    for (const tag of row.emoteTags) {
      if (tag === original) { alias.add(tag); continue; }
      semantic.push(tag);
    }
    // 名字整串没有中日韩文字 = 它是文件名去扩展名，不是「这张在说什么」。
    const handle = original !== "" && !isHumanName(original) ? original : "";
    if (handle !== "") alias.add(handle);
    const label = handle === "" ? original : "";
    const untouched = row.emoteTags.length === semantic.length && row.emoteLabel === label
      && row.emoteAlias.length === alias.size;
    if (untouched) continue;
    applyEmoteSemantics(row.url, { label, tags: semantic, alias: [...alias] });
    split += 1;
  }
  return { split };
}

/**
 * 只翻「能不能当表情甩」这个开关，不动语义字段。
 * 界面上那颗笑脸是**开关**，不是重新登记：已经认过名的那张被取消再勾回来，
 * 名字和标签必须还在——否则一次误点就把联系人（或视觉模型）起好的名字洗掉了。
 */
export function setEmoteMark(url: string, on: boolean): boolean {
  // 勾上时若还没有文件夹（聊天里随手标记的图就是这种），归进默认文件夹，
  // 不让它散在「全部」里没有归属。取消标记不动文件夹、也不搬文件——
  // 笑脸是开关，磁盘位置只在「归属变化」时跟着动。
  if (on) {
    const current = getAssetByUrl(url);
    if (current !== null && current.emotePack.length === 0) {
      const changed = db.prepare(
        "UPDATE assets SET usable_as_emote = 1, missing = 0, emote_pack = ?, updated_at = ? WHERE url = ?",
      ).run(JSON.stringify([DEFAULT_EMOTE_FOLDER]), Date.now(), url);
      if (changed.changes > 0) syncEmoteLocation(url, [DEFAULT_EMOTE_FOLDER], true);
      return changed.changes > 0;
    }
    const flipped = db.prepare("UPDATE assets SET usable_as_emote = 1, missing = 0, updated_at = ? WHERE url = ?")
      .run(Date.now(), url);
    if (flipped.changes > 0 && current !== null) syncEmoteLocation(url, current.emotePack, true);
    return flipped.changes > 0;
  }
  const changed = db.prepare("UPDATE assets SET usable_as_emote = ?, updated_at = ? WHERE url = ?")
    .run(on ? 1 : 0, Date.now(), url);
  // 摘掉标记就把文件搬出 表情包/：那个目录里只有表情，用户在资源管理器里看到的和库里的口径一致。
  if (!on && changed.changes > 0) {
    const current = getAssetByUrl(url);
    if (current !== null) relocate(url, KIND_DIR[current.kind] ?? KIND_DIR.image);
  }
  return changed.changes > 0;
}

export function unmarkEmote(url: string): boolean { return setEmoteMark(url, false); }

export function listEmoteAssets(): AssetRow[] {
  const rows = db.prepare("SELECT * FROM assets WHERE usable_as_emote = 1 ORDER BY created_at ASC, id ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToAsset);
}

/**
 * 文件夹清单以及每个文件夹认过图没有。
 * 「表情包」视角那个文件夹下拉读它——联系人备了三个文件夹，用户想先看「语录」那一叠。
 * auto/manual/unnamed 带着命名状态的分桶计数：选中文件夹时，界面上那排状态 chips 的
 * 数字要跟着文件夹变——全库数字不随筛选动，会被读成「筛选坏了」（2026-11-02 用户实测报告）。
 */
export function listEmotePacks(): Array<{ pack: string; total: number; unnamed: number; file: number; auto: number; manual: number }> {
  const out: Array<{ pack: string; total: number; unnamed: number; file: number; auto: number; manual: number }> = [];
  const seen = new Map<string, { total: number; unnamed: number; file: number; auto: number; manual: number }>();
  for (const row of listEmoteAssets()) {
    for (const pack of new Set(row.emotePack)) {
      const bucket = seen.get(pack) ?? { total: 0, unnamed: 0, file: 0, auto: 0, manual: 0 };
      bucket.total += 1;
      if (row.emoteNamedAt === 0) bucket.unnamed += 1;
      else if (row.emoteNameSource === "auto") bucket.auto += 1;
      else if (row.emoteNameSource === "manual") bucket.manual += 1;
      else bucket.file += 1;
      seen.set(pack, bucket);
    }
  }
  for (const [pack, bucket] of seen) out.push({ pack, ...bucket });
  // 「默认」恒排第一：它是兜底桶，用户找它不该排在数字后面。
  return out.sort((a, b) => (a.pack === DEFAULT_EMOTE_FOLDER ? -1 : b.pack === DEFAULT_EMOTE_FOLDER ? 1 : 0)
    || b.total - a.total || a.pack.localeCompare(b.pack, "zh-Hans-CN"));
}

/**
 * 就地验真：文件确实不在盘上了就标失效（返回 true）。
 * 失效标记原本只在启动/巡检对账时刷新——用户在会话中途删了文件，卡片上看不见异常，
 * 直到点「在文件管理器中显示」才撞到 path doesn't exist。那个失败瞬间就是最准的探测点：
 * 验一次、标上，「清理此项」按钮当场出现，不用等下一轮对账。
 */
export function markMissingIfGone(id: string): boolean {
  const row = db.prepare("SELECT url, missing FROM assets WHERE id = ?").get(id) as { url: string; missing: number } | undefined;
  if (row === undefined) return false;
  if (currentFileOf(row.url) !== null) return false;
  if (Number(row.missing) !== 1) db.prepare("UPDATE assets SET missing = 1 WHERE id = ?").run(id);
  return true;
}

/**
 * 清理失效项：只删「原图已不在盘上」的行——用户在磁盘里删了文件后，界面上要能收掉这条记录。
 * 文件还在的行**删不动**（走回收站那条线，别绕开引用检查直接抹账）；
 * 清理后若文件被放回 表情包/，下一轮对账会把它重新登记——所以这不是危险操作，只是销一条死账。
 */
export function dropMissingAsset(id: string): boolean {
  const changed = db.prepare("DELETE FROM assets WHERE id = ? AND missing = 1").run(id);
  return changed.changes > 0;
}

export function setStarred(id: string, on: boolean): boolean {
  const changed = db.prepare("UPDATE assets SET starred = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, Date.now(), id);
  return changed.changes > 0;
}

/**
 * 显式认领：调用方比扫描更早、更清楚地知道这张图是干什么的（导入的表情包、生成的作品、头像）。
 * 只填当前还是 unclaimed / 空的字段，不做覆盖——事后对账不该把确定的事实冲掉。
 */
export function claimAsset(url: string, patch: { source?: AssetSource; contactId?: string; originRef?: string }): boolean {
  const current = getAssetByUrl(url);
  if (current === null) return false;
  const nextSource = current.source === "unclaimed" ? (patch.source ?? current.source) : current.source;
  const nextContact = current.contactId === "" ? (patch.contactId ?? "") : current.contactId;
  const nextOrigin = current.originRef === "" ? (patch.originRef ?? "") : current.originRef;
  db.prepare("UPDATE assets SET source = ?, contact_id = ?, origin_ref = ?, updated_at = ? WHERE url = ?")
    .run(nextSource, nextContact, nextOrigin, Date.now(), url);
  return true;
}

// ── 统一读视图：一个页面、三个视角 ────────────────────────────────────────
//
// 「内容库」「表情包」「媒体」以前是三个各查各源的接口。它们要的其实是同一批行，
// 差别只有一个筛选条件——所以这里只出一个查询，视角是参数，不是功能。

export type AssetView = "all" | "emote" | "starred" | "generated" | "chat";
export type AssetKindFilter = "all" | AssetKind;

const VIEW_CLAUSE: Record<AssetView, string> = {
  all: "",
  emote: "usable_as_emote = 1",
  starred: "starred = 1",
  generated: "source = 'generated'",
  chat: "source = 'chat'",
};

export type AssetQuery = {
  /** 归属联系人；空串＝不隔离，看全库。 */
  contactId?: string;
  view?: AssetView;
  kind?: AssetKindFilter;
  q?: string;
  /** 按文件夹筛；只在有值的时生效。文件夹名不参与语义匹配，但可以是筛选条件。 */
  pack?: string;
  /** 按命名状态筛：未命名 / 智能识别 / 手动维护。识别进度那一排 chips 用它。 */
  named?: EmoteNamedFilter;
  /** 只列原图已经不在磁盘上的失效项。 */
  missing?: boolean;
  limit: number;
  offset: number;
};

/**
 * counts 只按联系人范围算、不受当前 view/kind 影响——页签上的数字要稳定，
 * 否则用户点进「表情包」之后其它页签的计数跟着变，就分不清是筛选还是数据变了。
 */
/**
 * 列表项上额外拼出来的展示信息。刻意**不**复制进 assets：
 * 作品提示词属于 artifacts，语音转写与波形属于那条消息——抄一份过来就是第二份真相，
 * 两边哪天不一样，界面上就分不清哪个是旧的。
 */
export type AssetDetail = {
  artifactId: string;
  prompt: string;
  shape: string;
  withReference: boolean;
  transcript: string;
  waveform: number[];
  /** 出处消息的角色与文字：聊天媒体在没有作品提示词时用它当标题。 */
  originRole: string;
  originText: string;
};

export type AssetItem = AssetRow & { detail: AssetDetail };

const EMPTY_DETAIL: AssetDetail = {
  artifactId: "", prompt: "", shape: "", withReference: false,
  transcript: "", waveform: [], originRole: "", originText: "",
};

function inPlaceholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** 从消息的 attachment_meta（JSON 数组）里取这一条语音的转写与波形。 */
function voiceMeta(raw: string, url: string): { transcript: string; waveform: number[] } {
  if (raw === "") return { transcript: "", waveform: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { transcript: "", waveform: [] };
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue;
      const v = item as Record<string, unknown>;
      if (v.url !== url) continue;
      const waveform = Array.isArray(v.waveform) ? v.waveform.filter((n): n is number => typeof n === "number") : [];
      return { transcript: typeof v.transcript === "string" ? v.transcript : "", waveform };
    }
  } catch { /* 坏元信息按没有处理，不编一个假的 */ }
  return { transcript: "", waveform: [] };
}

/** 给一页资产补上作品与出处消息的展示字段（两次批量查询，不是每行一次）。 */
function enrichAssets(rows: AssetRow[]): AssetItem[] {
  if (rows.length === 0) return [];
  const urls = rows.map((r) => r.url);
  const artRows = db.prepare(
    `SELECT id, url, prompt, shape, with_reference FROM artifacts WHERE url IN (${inPlaceholders(urls.length)})`,
  ).all(...urls) as Array<Record<string, unknown>>;
  const artByUrl = new Map(artRows.map((a) => [String(a.url), a]));

  const msgIds = [...new Set(rows.map((r) => r.originMessageId).filter((v): v is number => typeof v === "number"))];
  const msgById = new Map<number, Record<string, unknown>>();
  if (msgIds.length > 0) {
    const msgs = db.prepare(
      `SELECT id, role, text, attachment_meta FROM messages WHERE id IN (${inPlaceholders(msgIds.length)})`,
    ).all(...msgIds) as Array<Record<string, unknown>>;
    for (const m of msgs) msgById.set(Number(m.id), m);
  }

  return rows.map((row) => {
    const art = artByUrl.get(row.url);
    const msg = typeof row.originMessageId === "number" ? msgById.get(row.originMessageId) : undefined;
    if (art === undefined && msg === undefined) return { ...row, detail: EMPTY_DETAIL };
    const meta = msg === undefined ? { transcript: "", waveform: [] }
      : voiceMeta(String(msg.attachment_meta ?? ""), row.url);
    return {
      ...row,
      detail: {
        artifactId: art === undefined ? "" : String(art.id),
        prompt: art === undefined ? "" : String(art.prompt ?? ""),
        shape: art === undefined ? "" : String(art.shape ?? ""),
        withReference: art !== undefined && Number(art.with_reference ?? 0) === 1,
        transcript: meta.transcript,
        waveform: meta.waveform,
        originRole: msg === undefined ? "" : String(msg.role ?? ""),
        originText: msg === undefined ? "" : String(msg.text ?? ""),
      },
    };
  });
}

type SqlArg = string | number;

export function listAssets(query: AssetQuery): {
  items: AssetItem[]; total: number;
  counts: Record<AssetView, number>; kindCounts: Record<AssetKindFilter, number>;
} {
  const contactId = query.contactId ?? "";
  // 派生形态（动图静帧这类）不进媒体库：它不是用户的一份东西，列出来只会让人以为库里多了张重复图。
  const where: string[] = ["parent_id IS NULL"];
  const args: SqlArg[] = [];
  if (contactId !== "") { where.push("contact_id = ?"); args.push(contactId); }
  const view = query.view ?? "all";
  if (VIEW_CLAUSE[view] !== "") where.push(VIEW_CLAUSE[view]);
  const kind = query.kind ?? "all";
  if (kind !== "all") { where.push("kind = ?"); args.push(kind); }
  const pack = (query.pack ?? "").trim();
  if (pack !== "") {
    // 文件夹名是 JSON 数组里的一个字符串元素，写库时已挡掉引号（见 qq-emote.ts 的 cleanLabel），
    // 所以这里的整词 LIKE 是精确匹配，不会出现「文件夹名里带引号把条件破了」那种事。
    where.push("emote_pack LIKE ?");
    args.push(`%"${pack}"%`);
  }
  const named = query.named ?? "any";
  if (NAMED_CLAUSE[named] !== "") where.push(NAMED_CLAUSE[named]);
  if (query.missing === true) where.push("missing = 1");
  const q = (query.q ?? "").trim().toLowerCase();
  if (q !== "") {
    // 表情语义的四个可搜字段一起搜：中文名、语义标签、用法说明、别名/句柄。
    // 文件夹名不在这里——它有自己的筛选（见 listEmotePacks），混进全文搜会让人误以为搜到了内容。
    where.push("(lower(emote_label) LIKE ? OR lower(emote_tags) LIKE ? OR lower(emote_caption) LIKE ?"
      + " OR lower(emote_alias) LIKE ? OR lower(url) LIKE ? OR lower(source) LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like, like, like, like);
  }
  const clause = where.length === 0 ? "" : "WHERE " + where.join(" AND ");

  const rows = db.prepare(`SELECT * FROM assets ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, query.limit, query.offset) as Record<string, unknown>[];
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM assets ${clause}`).get(...args) as { n: number }).n);

  // 计数只按联系人范围算，不受当前 view/kind 影响——页签上的数字要稳定。
  const scope: string[] = ["parent_id IS NULL"];
  const scopeArgs: SqlArg[] = [];
  if (contactId !== "") { scope.push("contact_id = ?"); scopeArgs.push(contactId); }
  const countWith = (extra: string[], extraArgs: SqlArg[]): number => {
    const all = [...scope, ...extra];
    const where = all.length === 0 ? "" : "WHERE " + all.join(" AND ");
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM assets ${where}`).get(...scopeArgs, ...extraArgs) as { n: number }).n);
  };
  const counts = {} as Record<AssetView, number>;
  for (const key of Object.keys(VIEW_CLAUSE) as AssetView[]) {
    counts[key] = countWith(VIEW_CLAUSE[key] === "" ? [] : [VIEW_CLAUSE[key]], []);
  }
  const kindCounts = {} as Record<AssetKindFilter, number>;
  kindCounts.all = counts.all;
  for (const key of ["image", "video", "audio", "file"] as AssetKind[]) {
    kindCounts[key] = countWith(["kind = ?"], [key]);
  }
  return { items: enrichAssets(rows.map(rowToAsset)), total, counts, kindCounts };
}

/**
 * 概览：条数与占用空间，状态页那一行「本地 1.2 GB」用它。
 * 计数只算用户自己的东西（不含派生形态），但**字节数含派生形态**——
 * 静帧那份确实占了盘，报存储时不能当它不存在。
 */
export function assetStats(): { total: number; bytes: number; emotes: number; broken: number } {
  const row = db.prepare(`
    SELECT (SELECT COUNT(*) FROM assets WHERE parent_id IS NULL) AS n,
           COALESCE((SELECT SUM(bytes) FROM assets), 0) AS b,
           COALESCE((SELECT SUM(usable_as_emote) FROM assets WHERE parent_id IS NULL), 0) AS e,
           (SELECT COUNT(*) FROM assets WHERE usable_as_emote = 1 AND missing = 1) AS m
  `).get() as { n: number; b: number; e: number; m: number };
  return { total: row.n, bytes: row.b, emotes: row.e, broken: row.m };
}

// ── 对账：把「谁在引用这个文件」从扫描结果落进表里 ────────────────────────

/**
 * 引用源的一条，对齐 media.ts 的 MediaSource。
 * `contactId` 必须是 id 而不是显示名——按联系人筛选靠它，写成名字整个视角就废了。
 */
export type AssetRef = { kind: string; contactId?: string; durationMs?: number; messageId?: number };

/**
 * 用扫描结果刷新 ref_count / ref_kinds，并顺带认领来源、归属联系人、语音时长与出处消息。
 *
 * 认领规则是**保守**的：只把 source 从 unclaimed 往上提，绝不覆盖已经明确的来源
 * （落盘那一刻由调用方给的信息比事后推断更可信）；contact_id / duration_ms / 出处消息
 * 只在空着的时候填。
 */
export function syncAssetRefs(refsByUrl: Map<string, AssetRef[]>): { updated: number } {
  let updated = 0;
  const now = Date.now();
  const touch = db.prepare(`
    UPDATE assets
       SET ref_count = ?, ref_kinds = ?,
           source = CASE WHEN source = 'unclaimed' THEN ? ELSE source END,
           contact_id = CASE WHEN contact_id = '' THEN ? ELSE contact_id END,
           duration_ms = CASE WHEN duration_ms IS NULL THEN ? ELSE duration_ms END,
           origin_message_id = CASE WHEN origin_message_id IS NULL THEN ? ELSE origin_message_id END,
           updated_at = ?
     WHERE url = ?
  `);
  for (const [url, refs] of refsByUrl) {
    const kinds = [...new Set(refs.map((r) => r.kind))];
    const firstNumber = (pick: (r: AssetRef) => number | undefined): number | null =>
      refs.map(pick).find((v) => typeof v === "number") ?? null;
    touch.run(
      refs.length, kinds.join(","), sourceFromKinds(kinds), contactFromRefs(refs),
      firstNumber((r) => r.durationMs), firstNumber((r) => r.messageId), now, url,
    );
    updated += 1;
  }
  return { updated };
}

/** 引用类型 → 最可能的来源。顺序即优先级：先具体后笼统。 */
function sourceFromKinds(kinds: string[]): AssetSource {
  if (kinds.includes("artifact")) return "generated";
  if (kinds.includes("avatar")) return "avatar";
  if (kinds.includes("face_ref")) return "face_ref";
  if (kinds.includes("wallpaper")) return "wallpaper";
  if (kinds.includes("chat") || kinds.includes("voice") || kinds.includes("turn")) return "chat";
  if (kinds.includes("tool")) return "tool";
  if (kinds.includes("setting")) return "imported";
  return "unclaimed";
}

/** 归属联系人：取第一个拿得到的 id。全局素材（导入的表情包）本来就没有归属，留空是对的。 */
function contactFromRefs(refs: AssetRef[]): string {
  for (const ref of refs) {
    const id = (ref.contactId ?? "").trim();
    if (id !== "") return id;
  }
  return "";
}
