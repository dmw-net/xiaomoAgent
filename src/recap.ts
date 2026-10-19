// 窗口边缘梗概（compaction 思路，只借思路不借实现）。
//
// 为什么需要：recentMessages 只回放最近 N 轮，更早的原话就彻底不进上下文了；
// 记忆抽取记的是离散事件（承诺/偏好/事实），接不住「那件事后来怎么样了」这种叙事连续性。
// 于是被挤出去的那段对话压成一段梗概继续带着走——这就是 compaction 在本项目里的形态。
//
// 三条纪律与 consolidate 保持一致：
// 1) 副通道：绝不在对话主链路上同步跑，攒够一批才刷一次（每轮都刷就是白烧一次模型调用）；
// 2) 可撤销：只写 contacts.recap 一个字段，messages 表一个字都不动，梗概写错了历史还在；
// 3) 产出可见：资料页能看能改，提示词预览与真实对话同口径注入。

import { callModelJson, contactModelSettings, type ChatMessage } from "./model.ts";
import { modelConfig, modelReadyNow, personaConfig } from "./settings.ts";
import { db } from "./db.ts";
import { applyRecap, getContact, pronounOf } from "./contacts.ts";
import { ownerPronoun } from "./persona.ts";

/** 攒够这么多条还没折叠的旧消息才刷一次：太少不值得一次模型调用。 */
const RECAP_MIN_PENDING = 8;

/** 单次折叠的消息条数上限。再多模型也抓不住重点，剩下的留给下一批。 */
const RECAP_BATCH = 40;

/** 梗概正文的字数硬顶（提示词里也这么要求，落库再兜一次）。 */
const RECAP_CHARS = 200;

type RecapRow = { id: number; role: string; text: string };

/** 正在刷梗概的联系人（同一联系人同时只跑一份，与整理同理）。 */
const inFlight = new Set<string>();

/**
 * 窗口左边界之外、且还没折叠进梗概的消息。
 * 下界是 recap_upto（上次折叠到的位置），上界是本轮实际带进上下文的最旧一条——
 * 两个截断来源（回放轮数 + 预算裁剪）都被这个区间覆盖，因为预算裁剪只会把边界往前推。
 */
function pendingRows(contactId: string, oldestKeptId: number): RecapRow[] {
  const upto = Number((db.prepare("SELECT recap_upto FROM contacts WHERE id = ?").get(contactId) as { recap_upto?: number } | undefined)?.recap_upto ?? 0);
  return db
    .prepare(
      `SELECT id, role, text FROM messages
       WHERE contact_id = ? AND superseded_at IS NULL AND kind != 'tool'
         AND id > ? AND id < ?
       ORDER BY id ASC LIMIT ?`,
    )
    .all(contactId, upto, oldestKeptId, RECAP_BATCH) as unknown as RecapRow[];
}

export function buildRecapSystem(ownerPron: string, pron: string): string {
  return `你在把一段已经挤出对话窗口的旧记录压成梗概，供「${pron}」下次开口时回看。

只输出 JSON：{"recap":"不超过 ${RECAP_CHARS} 字的一段话"}

要求：
- 把「已有梗概」和「新丢掉的对话」合并成一段更新的梗概；旧梗概里已经翻篇的琐碎细节可以舍掉。
- 按时间顺序说清发生了什么，优先保留：话题的起因与结果、约定有没有兑现、情绪怎么转的、提到过的人名地名和事。
- 只写记录里真有的东西，别补细节、别猜后续；不写「用户说」这种话。
- 指代用户用「${ownerPron}」，指代${pron}用「你」。
- 这段对话确实没什么可留的，就输出 {"recap":""}。`;
}

export function buildRecapInput(
  previous: string,
  rows: RecapRow[],
  ownerPron: string,
): string {
  const lines = rows.map((row) => `${row.role === "user" ? ownerPron : "我"}：${row.text}`).join("\n");
  return `已有梗概：${previous.trim() === "" ? "（还没有）" : previous.trim()}\n\n新丢掉的对话：\n${lines}`;
}

/**
 * 刷一次梗概（fire-and-forget 入口，agent 每轮回复后搭车调用）。
 * 没干活是正常状态：开关关着、还没攒够、模型没就绪、上一次还在跑——都直接返回。
 */
export async function maybeRefreshRecap(contactId: string, oldestKeptId: number): Promise<void> {
  const contact = getContact(contactId);
  if (!contact || !contact.features.recap) return;
  if (oldestKeptId <= 0 || inFlight.has(contactId)) return;

  const effective = contactModelSettings(contactId) ?? modelConfig();
  if (!modelReadyNow(effective)) return;

  inFlight.add(contactId);
  try {
    const rows = pendingRows(contactId, oldestKeptId);
    if (rows.length < RECAP_MIN_PENDING) return;
    const ownerPron = ownerPronoun(personaConfig().owner.gender);
    const pron = pronounOf(contact.gender);
    const messages: ChatMessage[] = [
      { role: "system", content: buildRecapSystem(ownerPron, pron) },
      { role: "user", content: buildRecapInput(contact.recap, rows, ownerPron) },
    ];
    const raw = await callModelJson<{ recap?: unknown }>(messages, {
      purpose: "recap",
      maxTokens: 400,
      contactId,
      capability: "memoryExtract",
    });
    const text = typeof raw?.recap === "string" ? raw.recap.trim().slice(0, RECAP_CHARS) : "";
    const lastId = rows[rows.length - 1]?.id ?? 0;
    // 空梗概也要推进游标（这批确实没什么可留），但不清掉已有梗概——
    // "这段没内容"不等于"以前的梗概作废了"。
    applyRecap(contactId, text === "" ? contact.recap : text, lastId);
    console.log(`[recap] ${contact.name} 折叠 ${rows.length} 条 → 梗概 ${text.length} 字`);
  } catch (error) {
    // 失败不推进游标：下一轮还会重试。刷梗概失败不该影响对话，但必须看得见。
    console.warn(
      `[recap] ⚠️ ${contact.name} 梗概刷新失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    inFlight.delete(contactId);
  }
}
