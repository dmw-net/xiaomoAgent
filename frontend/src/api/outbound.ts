import { getJson, postJson } from "./client";
import type { OutboundDeliveryRow, OutboundStatus, OutboundSummary } from "../types";

export type OutboundListResult = {
  devMode: boolean;
  summary: OutboundSummary;
  total: number;
  rows: OutboundDeliveryRow[];
};

export function list(params: { status?: OutboundStatus | "open" | "dead" | "all"; channel?: string; q?: string; limit?: number; offset?: number } = {}): Promise<OutboundListResult> {
  const search = new URLSearchParams();
  if (params.status && params.status !== "open") search.set("status", params.status);
  if (params.channel) search.set("channel", params.channel);
  if (params.q) search.set("q", params.q);
  search.set("limit", String(params.limit ?? 25));
  search.set("offset", String(params.offset ?? 0));
  return getJson<OutboundListResult>(`/api/outbound/deliveries?${search.toString()}`);
}

export function summary(): Promise<{ devMode: boolean; summary: OutboundSummary }> {
  return getJson<{ devMode: boolean; summary: OutboundSummary }>("/api/outbound/summary");
}

export function retry(id: string): Promise<{ ok: true; queued: true; message: string }> {
  return postJson<{ ok: true; queued: true; message: string }>(`/api/outbound/deliveries/${encodeURIComponent(id)}/retry`, {});
}

export function ignore(id: string): Promise<{ ok: true; message: string }> {
  return postJson<{ ok: true; message: string }>(`/api/outbound/deliveries/${encodeURIComponent(id)}/ignore`, {});
}

export function retryAll(): Promise<{ ok: true; queued: number; message: string }> {
  return postJson<{ ok: true; queued: number; message: string }>("/api/outbound/retry-all", {});
}

export function purge(): Promise<{ ok: true; removed: number; message: string }> {
  return postJson<{ ok: true; removed: number; message: string }>("/api/outbound/purge", {});
}
