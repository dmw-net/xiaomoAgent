// 表情语义的清洗与写回：登记、导入、认图作业共用同一道门。
//
// 为什么单独一层：认图作业（emote-naming.ts）要把模型给的名字写回素材库，
// 素材库的登记/采集又在 qq-emote.ts。原先两边互相 import，形成运行时环。
// 把与「谁触发的」无关的清洗口径和写回入口收在这里，两边各自向下依赖即可。

import { applyEmoteSemantics } from "../media/assets.ts";

/**
 * 「机器名」＝内容哈希 / UUID 这类没有人类可读性的文件名（下载站、协议端落盘的常态）。
 * 口径：去掉 `-` `_` 分段后整串只剩十六进制、且长度 ≥16 —— md5(32)、sha1(40)、
 * UUID(32)、`<md5>_0`(33) 全在网内，而 `beefcafe`、`dead`、`token-2` 这类人类起的词不会误杀。
 *
 * 为什么要挡：素材库一屏哈希标签会把标签筛选直接废掉；更要紧的是 pickEmoteByKeyword
 * 走的是 `includes`，纯 hex 串里可能藏着 `face` / `dead` / `cafe` 这种词，
 * 一旦同义词表哪天收进这样的候选词，就会随机甩出一张毫不相干的图。
 */
const MACHINE_NAME = /^[0-9a-f]{16,}$/i;

export function isMachineName(value: string): boolean {
  return MACHINE_NAME.test(value.replace(/[-_]/g, ""));
}

/** 清洗后的名字：机器名一律当「没有名字」处理，交给标签兜底显示。 */
export function cleanLabel(value: string): string {
  // 引号/反斜杠要一起去掉：批次名要进 JSON 数组按整词筛选（assets.ts 的 emote_pack LIKE），
  // 名字里带引号会把那个匹配条件破掉；顺带也不会出现「名字里带转义符」这种界面上看不懂的标签。
  const trimmed = value.replace(/["\\]/g, "").trim();
  return isMachineName(trimmed) ? "" : trimmed;
}

export function cleanTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = cleanLabel(raw);
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 认图作业回填语义。清洗口径和登记时同一条（机器名、引号都在 cleanLabel 里挡），
 * 所以模型给出的名字和用户上传时给的名字，进库前过的是同一道门。
 * 只写语义三个字段，不碰 alias/pack——那是用户的归类，作业无权覆盖。
 */
export function applyEmoteNaming(url: string, named: { name: string; caption: string; tags: string[] }, at: number): boolean {
  return applyEmoteSemantics(url, {
    label: cleanLabel(named.name),
    caption: cleanLabel(named.caption),
    tags: cleanTags(named.tags),
    namedAt: at,
    namedBy: "auto",
  });
}
