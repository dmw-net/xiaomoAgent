// 从 koishijs/QFace 的 QQNT 表情索引生成「face id → 中文表情名」全量表。
//
// 为什么要生成而不是手写：项目原先在 qq-emote.ts 里手搓了 16 条 FACES，
// 逐条比对 QFace 索引后 15 条对不上（id 14 实际是「微笑」，手写表写的是「晕」）。
// QQ 的编号有三套（老 CQ 表 / QQNT emojiId / qzoneCode），且会随协议端漂移，
// 手写表既不全也不可靠。QFace 是 Koishi 团队用 NapCat(QQNT) 容器扫出来的，
// 与我们对接的协议端同源，是眼下最可信的一份。
//
// 用法：
//   node scripts/gen-qq-faces.mjs                     从线上索引重新同步
//   node scripts/gen-qq-faces.mjs --from <索引.json>  离线重跑（CI / 无网）
//
// 只取 emojiId + describe 两个字段的事实性数据，不下载任何表情图片：
// QFace 明确写着「表情资源来自腾讯官方，仅供学习交流、请勿用于商业用途」，
// 名称表不涉及资源版权，打包进发行版没有这个顾虑。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_URL = "https://koishi.js.org/QFace/assets/qq_emoji/_index.v2.json";
const OUT = join(import.meta.dirname, "..", "src", "emote", "qq-face-names.generated.ts");

async function loadIndex() {
  const at = process.argv.indexOf("--from");
  if (at >= 0) {
    const path = process.argv[at + 1];
    if (!path) throw new Error("--from 后面要跟一个本地 JSON 路径");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const response = await fetch(INDEX_URL);
  if (!response.ok) throw new Error(`拉取 QFace 索引失败：HTTP ${response.status}`);
  return response.json();
}

const index = await loadIndex();
const emojis = index?.emojis;
if (emojis === null || typeof emojis !== "object") throw new Error("QFace 索引里没有 emojis 字段");

const entries = [];
for (const [key, def] of Object.entries(emojis)) {
  const id = Number(key);
  if (!Number.isInteger(id) || id < 0) continue;
  // describe 形如 "/微笑"；去掉前导斜杠，空名字不收。
  const name = String(def?.describe ?? "").replace(/^\//, "").trim();
  if (name === "") continue;
  entries.push([id, name]);
}
entries.sort((a, b) => a[0] - b[0]);
// 拉到半截数据/接口改版时宁可失败，也不要悄悄生成一张残缺表。
if (entries.length < 100) throw new Error(`只解析出 ${entries.length} 条表情名，索引可能坏了，拒绝生成`);

const syncedAt = String(index.syncedAt ?? "");
const lines = entries.map(([id, name]) => `  ${id}: ${JSON.stringify(name)},`);
const source = `// 自动生成，勿手动编辑。运行 node scripts/gen-qq-faces.mjs 重新同步。
// 数据来源：koishijs/QFace（QQNT 系统表情库）的 _index.v2.json
//   https://github.com/koishijs/QFace
//   ${INDEX_URL}
// 同步时间：${syncedAt || "未知"}；共 ${entries.length} 条有名称的表情。
// 只取 emojiId → describe 的事实性对应关系，不含任何图片资源。
// 编号归属若与本机协议端不一致，用 qq-emote.ts 的 overrideFaceNames() 在进程内纠偏。

export const QQ_FACE_SYNCED_AT = ${JSON.stringify(syncedAt)};
export const QQ_FACE_NAMES: Readonly<Record<number, string>> = Object.freeze({
${lines.join("\n")}
});
`;
writeFileSync(OUT, source, "utf8");
console.log(`[gen-qq-faces] ✓ ${entries.length} 条 → ${OUT}（syncedAt=${syncedAt || "未知"}）`);
