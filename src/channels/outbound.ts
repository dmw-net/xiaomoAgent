// 服务端出盒箱调度：持久化、立即尝试、后台重试与死信状态推进。
//
// 只由持租约的当家进程启动后台循环；接口进程即使不是当家，也仍可查看和手动重试。

import { randomUUID } from "node:crypto";
import {
  enqueue, getById, getPending, ignoreDelivery, listDeliveries, markDelivered, markExpired,
  markFailed, markInFlight, nextSchedule, recoverInFlight, retryDelivery, summary,
  type DeliveryFilter, type OutboundChannel, type OutboundDelivery, type OutboundKind,
} from "../core/dqueue.ts";
import { qq } from "./qq.ts";
import { wechat } from "./wechat.ts";
import type { Tier } from "../core/reliability.ts";

export type EnqueueTextInput = {
  contactId: string;
  conversationId?: string;
  channel: "qq" | "wechat";
  segments: string[];
  kind?: OutboundKind;
  tier?: Tier;
  maxAttempts?: number;
  sourceMessageId?: string;
};

const active = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let tick: Promise<void> | null = null;

function cleanSegments(segments: string[]): string[] {
  return segments.map((part) => part.trim()).filter((part) => part !== "");
}

export function enqueueText(input: EnqueueTextInput): string {
  const segments = cleanSegments(input.segments);
  const id = randomUUID();
  enqueue(id, {
    contactId: input.contactId,
    conversationId: input.conversationId ?? "",
    channel: input.channel,
    text: segments.join("\n\n"),
    segments,
    kind: input.kind ?? "chat",
    tier: input.tier ?? (input.kind === "proactive" ? "proactive" : "interactive"),
    maxAttempts: input.maxAttempts ?? 6,
    sourceMessageId: input.sourceMessageId,
  });
  return id;
}

async function dispatch(delivery: OutboundDelivery): Promise<{ ok: boolean; error: string }> {
  const proactive = delivery.kind === "proactive";
  const text = delivery.segments && delivery.segments.length > 0 ? delivery.segments : delivery.text;
  if (delivery.channel === "qq") {
    if (delivery.conversationId !== "") {
      return await qq.deliverToConversation(delivery.conversationId, text, {
        triggerMessageId: delivery.sourceMessageId,
      });
    }
    return await qq.deliverToContact(delivery.contactId, text, {
      proactive,
      msgId: delivery.sourceMessageId,
    });
  }
  if (delivery.channel === "wechat") {
    return await wechat.deliverToContact(delivery.contactId, text, { proactive });
  }
  return { ok: false, error: `不支持的投递通道：${delivery.channel}` };
}

export async function deliverNow(id: string): Promise<OutboundDelivery | null> {
  if (active.has(id)) return null;
  active.add(id);
  try {
    if (!markInFlight(id)) return getById(id);
    const delivery = getById(id);
    if (delivery === null) return null;
    if (delivery.freshnessAt !== undefined && Date.now() >= delivery.freshnessAt) {
      markExpired(id);
      return getById(id);
    }
    let result: { ok: boolean; error: string };
    try {
      result = await dispatch(delivery);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) markDelivered(id);
    else markFailed(id, result.error || "投递失败", nextSchedule(delivery.tier, delivery.attempts), delivery.tier, delivery.freshnessAt);
    return getById(id);
  } finally {
    active.delete(id);
  }
}

function channelAccepts(input: EnqueueTextInput): boolean {
  if (input.channel === "wechat") {
    const link = wechat.snapshotFor(input.contactId).link as { enabled?: boolean; proactive?: boolean } | null;
    if (link === null || link.enabled === false) return false;
    if (input.kind === "proactive" && link.proactive !== true) return false;
    return true;
  }
  const qqSnapshot = qq.snapshotFor(input.contactId);
  if (qqSnapshot.binding === null) return false;
  if (input.conversationId && qqSnapshot.conversations.some((conv) => conv.id === input.conversationId && !conv.enabled)) return false;
  if (input.kind === "proactive" && !input.conversationId && qqSnapshot.binding.proactive !== true) return false;
  return true;
}

export async function enqueueAndDeliver(input: EnqueueTextInput): Promise<OutboundDelivery | null> {
  // 未绑定/已停用的通道不制造死信：这和以前“没绑定就静默跳过”一致。
  if (!channelAccepts(input)) return null;
  const id = enqueueText(input);
  return await deliverNow(id);
}

/** 处理到期的 pending/failed。单进程内串行，避免同一条记录被两个 tick 同时取走。 */
export async function runOutboundOnce(limit = 10): Promise<number> {
  if (tick !== null) return await tick.then(() => 0);
  let handled = 0;
  tick = (async () => {
    const ids = getPending(Date.now(), limit);
    for (const id of ids) {
      const result = await deliverNow(id);
      if (result !== null) handled += 1;
    }
  })();
  try { await tick; return handled; } finally { tick = null; }
}

export function startOutboundLoop(): void {
  if (timer !== null) return;
  recoverInFlight();
  void runOutboundOnce().catch((error: unknown) => {
    console.warn(`[outbound] 首次调度失败：${error instanceof Error ? error.message : String(error)}`);
  });
  timer = setInterval(() => {
    void runOutboundOnce().catch((error: unknown) => {
      console.warn(`[outbound] 调度失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, 2000);
  timer.unref();
}

export function stopOutboundLoop(): void {
  if (timer !== null) { clearInterval(timer); timer = null; }
}

export function retryAndDeliver(id: string): boolean {
  const ok = retryDelivery(id);
  if (ok) {
    void deliverNow(id).catch((error: unknown) => {
      console.warn(`[outbound] 手动重试失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return ok;
}

export function ignore(id: string): boolean {
  return ignoreDelivery(id);
}

export function list(filter: DeliveryFilter): { rows: OutboundDelivery[]; total: number } {
  return listDeliveries(filter);
}

export function outboundSummary() {
  return summary();
}

export function channelOf(value: string | null): OutboundChannel | undefined {
  return value === "qq" || value === "wechat" || value === "web" ? value : undefined;
}
