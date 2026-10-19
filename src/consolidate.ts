// 记忆整理（后台副通道里的定期精炼）。
//
// 为什么需要它：抽取只增不改，时间一长必然堆积——同一件事记了三遍、
// 搬完家旧住址还天天冒出来。关系事件要可信，就得有人定期「睡觉整理」。
//
// 三条纪律（与整个记忆层一致）：
// 1) 副通道：只搭主动性定时器的车、按最小间隔节流，绝不在对话主链路上同步跑；
// 2) 可撤销：合并=墓碑删（deleted_at），过期=valid_until，都不物理删行——
//    整理判断错了，用户在记忆页还能翻旧账；
// 3) 产出可见：生活线与温度计写进联系人并在资料页展示/可手改，
//    整理动作与结果计数打进控制台日志（失败必须看得见）。

import { config } from "./config.ts";
import { db, withTx } from "./db.ts";
import { callModelJson } from "./model.ts";
import { modelConfig, modelReadyNow, personaConfig } from "./settings.ts";
import { contactModelSettings } from "./model.ts";
import {
  getContact,
  listContacts,
  pronounOf,
  applyConsolidation,
  type BondState,
} from "./contacts.ts";
import {
  deleteMemoryEvent,
  listEventsForConsolidation,
  setMemoryValidUntil,
  updateMemoryEvent,
} from "./memory.ts";
import { memoryAgeLabel, ownerPronoun } from "./persona.ts";
import type { ChatMessage } from "./model.ts";

/** 距上次整理新增这么多条关系事件就提前整理一次，别等满一周让重复条目占满召回预算。 */
const CONSOLIDATE_BACKLOG = 20;

type ConsolidateOutput = {
  merges?: Array<{ keep?: unknown; drop?: unknown; content?: unknown }>;
  expire?: unknown;
  lifeline?: unknown;
  bond?: unknown;
};

export type ConsolidationResult = {
  /** 请求本身都算处理完成；真出错（模型挂了/JSON 不合法）走抛错，由路由回 5xx。 */
  ok: true;
  /** 没干活的原因（echo 未接模型 / 上一次还在跑）：跳过是诚实状态，不是失败。 */
  skipped: boolean;
  note: string;
  events: number;
  merged: number;
  expired: number;
  lifelineUpdated: boolean;
  bondUpdated: boolean;
};

/** pron = 角色的代词（contact.gender）；ownerPron = 用户的代词（owner.gender）。 */
export function buildConsolidateSystem(pron: string, ownerPron: string): string {
  return `你在整理一段长期陪伴关系的记忆库。给你：现存的关系事件清单（带 id）、
上次的「生活线」摘要、当前关系温度计。你要做的是让记忆重新变得可信：

只输出 JSON：
{"merges":[{"keep":12,"drop":[34,56],"content":"合并后的一句话事实"}],
 "expire":[78,90],
 "lifeline":"我们最近的生活轮廓，≤160字，以「你」指${pron}、「${ownerPron}」指用户",
 "bond":{"stage":"熟悉","warmth":62,"mood":"平静"} 或 null}

规则：
- merges：同一件事记了多遍、或一条被另一条完全取代时合并。keep 保留最重要的 id，
  content 是合并后 ≤40 字的独立事实（涉及日期必须写成绝对日期）。拿不准就不合并。
- expire：明显已经翻篇的事（结束的项目、过去的临时状态）列 id 即可，不删内容、只标过期。
- lifeline：基于较新的事件写一段克制的近况轮廓，没有素材就输出 ""。
- bond：温度计明显该动才给新值，否则 null。warmth 是 0-100 整数。
- 只做上面四件事，不复述清单、不新增事实（新事实由对话抽取负责）。`;
}

/** 正在整理的联系人（同一时刻一个联系人只跑一份，与主动性互斥同理）。 */
const inFlight = new Set<string>();

export async function consolidateContact(contactId: string): Promise<ConsolidationResult> {
  const contact = getContact(contactId);
  if (!contact) {
    return { ok: true, skipped: true, note: "联系人不存在", events: 0, merged: 0, expired: 0, lifelineUpdated: false, bondUpdated: false };
  }
  if (inFlight.has(contactId)) {
    return { ok: true, skipped: true, note: "这个联系人的上一次整理还在进行中，本次跳过", events: 0, merged: 0, expired: 0, lifelineUpdated: false, bondUpdated: false };
  }

  const effective = contactModelSettings(contactId) ?? modelConfig();
  if (!modelReadyNow(effective)) {
    return { ok: true, skipped: true, note: "演示模式或未接模型：整理跳过（不产生任何变更）", events: 0, merged: 0, expired: 0, lifelineUpdated: false, bondUpdated: false };
  }
  inFlight.add(contactId);
  try {
    return await runConsolidation(contactId, contact.lifeline, contact.bond);
  } finally {
    inFlight.delete(contactId);
  }
}

async function runConsolidation(
  contactId: string,
  currentLifeline: string,
  currentBond: BondState,
): Promise<ConsolidationResult> {
  const events = listEventsForConsolidation(contactId, 150);
  const now = Date.now();
  const listText = events
    .map((e) => {
      const expired = e.valid_until !== null && e.valid_until <= now ? "（已过期）" : "";
      return `- id=${e.id} ${e.kind}（${memoryAgeLabel(e.created_at, now)}）${expired}${e.content}`;
    })
    .join("\n");
  const bondText = currentBond.stage === "" ? "（还没建立）" : JSON.stringify(currentBond);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildConsolidateSystem(pronounOf(getContact(contactId)?.gender), ownerPronoun(personaConfig().owner.gender)),
    },
    {
      role: "user",
      content: `（今天是 ${new Date(now).toISOString().slice(0, 10)}）\n现存事件：\n${listText || "（空）"}\n\n上次生活线：${currentLifeline || "（无）"}\n当前温度计：${bondText}`,
    },
  ];

  const raw = await callModelJson<ConsolidateOutput>(messages, {
    purpose: "consolidate",
    maxTokens: 800,
    contactId,
    capability: "memoryExtract",
  });

  const validIds = new Set(events.map((e) => e.id));
  const merged = withTx(() => {
    let mergedCount = 0;
    let expiredCount = 0;
    const droppedInRun = new Set<number>();
    for (const m of Array.isArray(raw?.merges) ? raw.merges : []) {
      const keep = Number(m?.keep);
      const content = typeof m?.content === "string" ? m.content.trim() : "";
      const drop = Array.isArray(m?.drop) ? m.drop.map(Number).filter((n) => validIds.has(n)) : [];
      if (!validIds.has(keep) || droppedInRun.has(keep) || content === "" || content.length > 60 || drop.length === 0) continue;
      if (!updateMemoryEvent(keep, contactId, { content })) continue;
      for (const id of drop) {
        if (id === keep) continue;
        deleteMemoryEvent(id, contactId);
        droppedInRun.add(id);
      }
      mergedCount += 1;
    }
    const expireIds = Array.isArray(raw?.expire) ? raw.expire : [];
    for (const item of expireIds) {
      const id = Number(item);
      if (!validIds.has(id) || droppedInRun.has(id)) continue;
      if (setMemoryValidUntil(id, contactId, now)) expiredCount += 1;
    }
    return { mergedCount, expiredCount };
  });

  // 整理跑在模型调用之后（数秒到数十秒），这期间联系人可能被彻底删除。
  // 此时 withTx 里的合并/过期已经提交了，只能把后半段跳过——
  // 非空断言会抛 TypeError，留下"记忆改了、生活线和 lastConsolidatedAt 没写"的半截整理。
  const after = getContact(contactId);
  if (!after) {
    const note = `整理到一半联系人已被删除：合并 ${merged.mergedCount} 组、标过期 ${merged.expiredCount} 条已落库，生活线/温度计未回写`;
    console.log(`[consolidate] ${contactId} ${note}`);
    return {
      ok: true, skipped: true, note, events: events.length,
      merged: merged.mergedCount, expired: merged.expiredCount,
      lifelineUpdated: false, bondUpdated: false,
    };
  }
  const features = after.features;
  let lifelineUpdated = false;
  let bondUpdated = false;
  const output: { lifeline?: string; bond?: Partial<BondState> | null; consolidatedAt: number } = {
    consolidatedAt: now,
  };
  if (features.lifeline && typeof raw?.lifeline === "string" && raw.lifeline.trim() !== "") {
    output.lifeline = raw.lifeline.trim();
    lifelineUpdated = true;
  }
  if (features.bond && raw?.bond && typeof raw.bond === "object") {
    output.bond = raw.bond as Partial<BondState>;
    bondUpdated = true;
  }
  applyConsolidation(contactId, output);

  const note = `整理完成：合并 ${merged.mergedCount} 组、标过期 ${merged.expiredCount} 条`
    + `、生活线${lifelineUpdated ? "已刷新" : "未动"}、温度计${bondUpdated ? "已更新" : "未动"}`;
  console.log(`[consolidate] ${contactId} ${note}`);
  return {
    ok: true, skipped: false, note, events: events.length,
    merged: merged.mergedCount, expired: merged.expiredCount,
    lifelineUpdated, bondUpdated,
  };
}

/**
 * 主动性循环搭车的节流入口。两个触发条件：
 * 1) 距上次整理 ≥ CONSOLIDATE_INTERVAL_DAYS；
 * 2) 上次整理之后又攒够 CONSOLIDATE_BACKLOG 条 —— 抽取侧已按相似条目改写去重，
 *    但改不了"跨话题的同一件事"，堆积到一定程度就别等满一周了。
 * 异常只告警不抛——整理失败不该影响主动关心（两条副通道互不拖累）。
 */
export function maybeRunConsolidation(): void {
  const intervalMs = config.consolidateIntervalDays * 86_400_000;
  if (intervalMs <= 0) return;
  const now = Date.now();
  for (const contact of listContacts()) {
    if (!contact.features.consolidate) continue;
    // 失败退避单独记一个键：把时间戳伪造进 lastConsolidatedAt 会让资料页
    // 「上次整理时间」显示一个根本没发生过的时刻。
    if (now < (contact.features.consolidateRetryAt ?? 0)) continue;
    const last = contact.features.lastConsolidatedAt ?? 0;
    const dueByTime = now - last >= intervalMs;
    const dueByBacklog = !dueByTime && newEventsSince(contact.id, last) >= CONSOLIDATE_BACKLOG;
    if (!dueByTime && !dueByBacklog) continue;
    void consolidateContact(contact.id).catch((error) => {
      console.warn(
        `[consolidate] ⚠️ ${contact.name} 整理失败：${error instanceof Error ? error.message : String(error)}`,
      );
      // 失败也要有个退避，否则每个 tick 都重试烧 token：至少隔一天再试。
      const row = db
        .prepare(`SELECT features FROM contacts WHERE id = ?`)
        .get(contact.id) as { features: string | null } | undefined;
      if (!row) return;
      try {
        const f = JSON.parse(row.features ?? "{}") as Record<string, unknown>;
        f.consolidateRetryAt = now + 86_400_000;
        db.prepare(`UPDATE contacts SET features = ? WHERE id = ?`).run(JSON.stringify(f), contact.id);
      } catch { /* 脏 features 交给读侧净化 */ }
    });
  }
}

/** 上次整理（含从未整理，传 0）之后新增了多少条关系事件。 */
function newEventsSince(contactId: string, since: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM memory_events WHERE contact_id = ? AND deleted_at IS NULL AND created_at > ?`)
    .get(contactId, since) as { c: number };
  return row.c;
}
