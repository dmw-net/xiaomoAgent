// 表情怎么选：把「一个中文说法」变成「库里最贴的那几张」。
//
// 为什么单独一层（而不是继续留在 qq-emote.ts 的 pickEmoteByKeyword）：
// 旧实现是 `includes` + 命中集合内 `Math.random()`，两个硬伤都出在数据形态上——
//   1) 批次名（导入时填的图包名，如「鲸鱼娘·静态」）和语义标签挤在同一个 tags 数组里，
//      于是一个批次名能命中挂在它下面的一百多张图，随机就等于抽奖；
//   2) 库里的文本全是文件名句柄（heart-hands / juejuezi），回复模型只会说中文，
//      中文查询打英文句柄恒为 0 命中。实测 200 张里只有 34 张可达。
// 所以现在按字段分层打分，文件夹名**退出匹配**（它只做筛选），语义靠认图作业补进库里。
//
// 为什么不引入向量检索：200 张这个量级，字段加权 + 中文 n-gram 已经够；
// embedding 要带索引一致性校验（模型/维度/文件夹三者对齐）和一整套重建流程，
// 那是千张以上、且检索质量真的不够时才对的东西。
//
// 为什么没有那张手写同义词表：见 qq-emote.ts 里 FACE_SYNONYMS 的注释。
// 叫法属于数据（每个用户的库不一样），不属于源码。

import { listEmoteAssets, type AssetRow } from "./assets.ts";

export type EmoteMatchField = "label" | "alias" | "tag" | "caption" | "pack";

export type EmoteHit = {
  asset: AssetRow;
  score: number;
  /** 最高分是在哪个字段上拿到的；pack 意味着「只命中了文件夹名」，属于宽泛桶，不该自动发。 */
  matchedOn: EmoteMatchField;
};

/**
 * 字段权重。名字比标签准，标签比说明准，句柄只作兜底，文件夹名最低（且被阈值挡在自动发之外）。
 * 同一字段里「整句命中」高于「片段命中」：查「开心」命中名字「开心」应当压过命中名字「不太开心但还行」。
 */
const WEIGHT: Record<EmoteMatchField, number> = {
  label: 6, alias: 4.5, tag: 3.5, caption: 2, pack: 1.2,
};
const PARTIAL = 0.6;
/** 用得越多越往前站一点，但封顶：不能因为一张图被甩过 500 次就把新图永远压死。 */
const USAGE_CAP = 1.5;
/** 自动发（send_emote 只给 keyword 的那条快路）的最低分。
 *  这个阈值的作用是把「只命中了文件夹名」和「半个词凑巧撞上」挡掉——宁可回一句没有，也别甩一张不相干的。 */
export const AUTO_PICK_MIN_SCORE = 3;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").trim();
}

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 把查询拆成可匹配的片段。
 * 中文没有空格，所以自己做 bi-gram 兜住分词缺失：「也太开心了吧」要能撞上「开心」。
 * 英文句柄按 `-` `_` 拆开：查 heart 应该撞得上 heart-hands。
 */
export function queryTerms(query: string): string[] {
  const norm = normalize(query);
  if (norm === "") return [];
  const out = [norm];
  if (CJK.test(norm)) {
    if (norm.length >= 3) {
      for (let i = 0; i + 2 <= norm.length && out.length < 24; i += 1) out.push(norm.slice(i, i + 2));
    }
  } else {
    for (const part of query.toLowerCase().split(/[-_\s]+/)) {
      if (part.length >= 3 && !out.includes(part)) out.push(part);
    }
  }
  return out;
}

/** 一个字段对一个词的分：整串相等 > 字段包含词 > 词包含字段（后者是查询比名字长的那种口语说法）。 */
function fieldScore(fieldValue: string, term: string, weight: number, whole: boolean): number {
  if (fieldValue === "" || term === "") return 0;
  const base = whole ? weight : weight * PARTIAL;
  if (fieldValue === term) return base * 1.4;
  if (fieldValue.includes(term)) return base;
  if (term.includes(fieldValue) && fieldValue.length >= 2) return base * 0.5;
  return 0;
}

function usageBonus(asset: AssetRow): number {
  return Math.min(USAGE_CAP, Math.log10(asset.emoteUseCount + 1) * 1.2);
}

/** 对一张表情打分；返回 0 表示完全不沾边。 */
export function scoreEmote(asset: AssetRow, terms: string[]): { score: number; matchedOn: EmoteMatchField } {
  const label = normalize(asset.emoteLabel);
  const caption = normalize(asset.emoteCaption);
  const aliases = asset.emoteAlias.map(normalize);
  const tags = asset.emoteTags.map(normalize);
  const packs = asset.emotePack.map(normalize);
  let best = 0;
  let field: EmoteMatchField = "tag";
  const consider = (value: number, on: EmoteMatchField): void => {
    if (value > best) { best = value; field = on; }
  };
  terms.forEach((term, index) => {
    const whole = index === 0;
    consider(fieldScore(label, term, WEIGHT.label, whole), "label");
    for (const alias of aliases) consider(fieldScore(alias, term, WEIGHT.alias, whole), "alias");
    for (const tag of tags) consider(fieldScore(tag, term, WEIGHT.tag, whole), "tag");
    consider(fieldScore(caption, term, WEIGHT.caption, whole), "caption");
    // 文件夹名只认「整句就是这个文件夹」：查「鲸鱼娘」给的是这叠的所有图，不是某一张的语义。
    if (whole) for (const pack of packs) consider(fieldScore(pack, term, WEIGHT.pack, true), "pack");
  });
  return { score: best, matchedOn: field };
}

/** 全库检索：按分排，同分先常用、再随机（同质桶里随机是特性，不是缺陷）。
 *  默认池排除「已失效」——原图不在盘上的候选，选中也发不出去，不如一开始就别给。 */
export function searchEmotes(query: string, topK = 5, pool?: AssetRow[]): EmoteHit[] {
  const terms = queryTerms(query);
  const assets = pool ?? listEmoteAssets().filter((a) => !a.missing);
  if (terms.length === 0 || assets.length === 0) return [];
  const hits: EmoteHit[] = [];
  for (const asset of assets) {
    const { score, matchedOn } = scoreEmote(asset, terms);
    if (score <= 0) continue;
    hits.push({ asset, score: score + usageBonus(asset), matchedOn });
  }
  hits.sort((a, b) => b.score - a.score || b.asset.emoteUseCount - a.asset.emoteUseCount);
  const want = Math.max(1, topK);
  const top = hits.slice(0, want);
  // 同分的那几张换个顺序：同一个「开心」桶里连着回同一张，会显得她很呆。
  const tie = top.filter((h) => h.score >= (top[0]?.score ?? 0) - 0.001);
  if (tie.length <= 1) return top;
  const rest = top.filter((h) => !tie.includes(h));
  for (let i = tie.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = tie[i]; tie[i] = tie[j]!; tie[j] = swap!;
  }
  return [...tie, ...rest].slice(0, want);
}

/**
 * 只给一个关键词时的快路：分够高才敢直接发。
 * 返回 null 不代表库是空的，代表「没有一个够贴的」——调用方要如实这么说，并给出 emote_search 这条退路。
 */
export function pickEmoteByKeyword(keyword: string): EmoteHit | null {
  const hits = searchEmotes(keyword, 3);
  const best = hits[0];
  if (best === undefined || best.score < AUTO_PICK_MIN_SCORE || best.matchedOn === "pack") return null;
  return best;
}

/** 没给说法时的随机采样（「就是想甩个表情，无所谓哪张」）。空库返回空数组；失效行同被排除。 */
export function sampleEmotes(count = 3, pool?: AssetRow[]): AssetRow[] {
  const assets = pool ?? listEmoteAssets().filter((a) => !a.missing);
  if (assets.length === 0) return [];
  const picked: AssetRow[] = [];
  const rest = [...assets];
  for (let i = 0; i < Math.min(Math.max(1, count), rest.length); i += 1) {
    const index = Math.floor(Math.random() * rest.length);
    picked.push(...rest.splice(index, 1));
  }
  return picked;
}

/**
 * 库的规模与「命名过没有」——工具的失败回执用它说话：
 * 库里有多少张、以及没命名时应该先去做智能识别，而不是让模型反复猜词。
 */
export function emoteLibraryStatus(): { total: number; named: number } {
  const assets = listEmoteAssets();
  return { total: assets.length, named: assets.filter((a) => a.emoteNamedAt > 0).length };
}
