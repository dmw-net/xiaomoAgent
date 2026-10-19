/** 离线发件箱：断网/后端暂时不可达时把话落成设备本地队列，恢复后自动重发。 */

import { ApiError, chatApi } from "../api";

export type OutboxItem = {
  clientId: string;
  contactId: string;
  text: string;
  attachments: string[];
  createdAt: number;
  attempts: number;
  lastError: string;
};

const KEY = "xiaomo.outbox.v1";
const listeners = new Set<(items: OutboxItem[]) => void>();
let items: OutboxItem[] = load();
let flushing = false;
let started = false;

function load(): OutboxItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is OutboxItem => {
      if (!x || typeof x !== "object") return false;
      const v = x as Partial<OutboxItem>;
      return typeof v.clientId === "string" && typeof v.contactId === "string" && typeof v.text === "string"
        && Array.isArray(v.attachments) && typeof v.createdAt === "number";
    }).map((x) => ({
      clientId: x.clientId,
      contactId: x.contactId,
      text: x.text,
      attachments: x.attachments.filter((u) => typeof u === "string"),
      createdAt: x.createdAt,
      attempts: Number(x.attempts) || 0,
      lastError: typeof x.lastError === "string" ? x.lastError : "",
    }));
  } catch { return []; }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* 隐私模式下落不了盘 */ }
  for (const fn of listeners) fn(items);
}

function emit(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function subscribeOutbox(fn: (items: OutboxItem[]) => void): () => void {
  listeners.add(fn);
  fn(items);
  return () => listeners.delete(fn);
}

export function outboxForContact(contactId: string): OutboxItem[] {
  return items.filter((x) => x.contactId === contactId).sort((a, b) => a.createdAt - b.createdAt);
}

export function enqueueOutbox(input: { clientId: string; contactId: string; text: string; attachments?: string[] }): void {
  const existing = items.find((x) => x.clientId === input.clientId);
  if (existing) return;
  items = [...items, {
    clientId: input.clientId,
    contactId: input.contactId,
    text: input.text,
    attachments: input.attachments ? [...input.attachments] : [],
    createdAt: Date.now(),
    attempts: 0,
    lastError: "",
  }];
  save();
  emit("xiaomo:outbox-changed", { clientId: input.clientId, contactId: input.contactId, queued: true });
}

export function removeOutbox(clientId: string): void {
  const before = items.length;
  items = items.filter((x) => x.clientId !== clientId);
  if (items.length !== before) save();
}

export async function flushOutbox(contactId?: string, force = false): Promise<void> {
  if (flushing || items.length === 0) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  flushing = true;
  try {
    for (const item of [...items]) {
      if (contactId && item.contactId !== contactId) continue;
      if (!force && item.attempts >= 12 && item.lastError) continue; // 永久失败不再无限打扰；用户重试时仍可再次触发。
      try {
        const data = await chatApi.say(item.text, item.attachments, item.contactId, item.clientId);
        items = items.filter((x) => x.clientId !== item.clientId);
        save();
        emit("xiaomo:outbox-sent", { clientId: item.clientId, contactId: item.contactId, turnId: data.turnId });
        emit("xiaomo:contacts-changed", {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof ApiError ? error.code : "";
        items = items.map((x) => x.clientId === item.clientId
          ? { ...x, attempts: x.attempts + 1, lastError: code ? `${code}: ${message}` : message }
          : x);
        save();
        emit("xiaomo:outbox-changed", { clientId: item.clientId, contactId: item.contactId, failed: true });
      }
    }
  } finally {
    flushing = false;
  }
}

/** 全局只启动一次：上线、后端恢复、回到前台、周期巡检都会尝试清队列。 */
export function startOutbox(): void {
  if (started) return;
  started = true;
  const kick = (): void => { void flushOutbox(); };
  window.addEventListener("online", kick);
  window.addEventListener("xiaomo:net-ok", kick);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
  window.setInterval(kick, 15_000);
  window.setTimeout(kick, 800);
}
