/**
 * 可靠性内核：分档重试策略、退避、配额闸门、交付时效窗口
 * 
 * 承诺分档（产品语义）：
 * - interactive: 实时对话回复，必须尽快送达；允许短暂重试，超时则放弃
 * - proactive: 主动触达，允许比实时对话多 5 分钟送达窗口
 * - background: 记忆抽取/整理/表情标注等批量作业；跨小时/天都行，慢但可靠
 * - best-effort: 可丢的元数据；一次不成就放弃
 * 
 * 设计原则：
 * 1. 退避有 jitter，避免整库撞墙
 * 2. 尊重 Retry-After header，优先用它定间隔
 * 3. T1 时效窗口内不原样补发迟到的消息
 * 4. 全局配额门控：背景作业在实时对话活跃时主动让路
 */

import { randomInt } from "node:crypto";

// ──────────────────────────────────────────────────────────────────────
// 基础类型与常量
// ──────────────────────────────────────────────────────────────────────

export type Tier = "interactive" | "proactive" | "background" | "best-effort";

/** 可重试的 ModelError 分类（复用 emote-naming 已验证的集合）。*/
export const RETRYABLE_MODEL_CODES = new Set<string>(["RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER_ERROR", "MODEL_UNAVAILABLE", "EMPTY_RESPONSE"]);

/** 不可重试（永不为成功尝试）的错误码。**用户必须干预**或**根本性失败**。*/
export const NON_RETRYABLE_MODEL_CODES = new Set<string>(["AUTH", "ENDPOINT_NOT_FOUND", "BAD_REQUEST", "CONTEXT_OVERFLOW", "OUTPUT_TRUNCATED", "CANCELLED", "UNKNOWN"]);

export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const MAX_DELAY_MS = 45_000;
export const INTERACTIVE_MAX_ATTEMPTS = 2;
export const BACKGROUND_MAX_ATTEMPTS = 6;
export const ONE_SHOT_MAX_ATTEMPTS = 1;

/** 实时对话交付时效窗口：超过这时间再补发就太晚了。*/
export const DELIVERY_FRESHNESS_MS = 10 * 60_000;        // 10 分钟
/** 主动性消息时效：比实时略宽，但仍要在当次会话窗口内。*/
export const PROACTIVE_DELIVERY_FRESHNESS_MS = 15 * 60_000; // 15 分钟

export function deliveryExpiry(createdAt: number, tier: Tier): number | undefined {
  if (tier === "best-effort") return undefined; // no freshness window for best-effort
  if (tier === "proactive") return createdAt + PROACTIVE_DELIVERY_FRESHNESS_MS;
  return createdAt + DELIVERY_FRESHNESS_MS;
}

// ──────────────────────────────────────────────────────────────────────
// 错误分类与解析
// ──────────────────────────────────────────────────────────────────────

export type ModelFailure = {
  retryable: boolean;
  retryAfterMs?: number;          // 来自 Retry-After header，单位毫秒
  reason?: string;                // 人话解释（可选）
};

export function classifyModelFailure(error: { code?: unknown; status?: number }, body?: string): ModelFailure {
  const code = typeof error.code === "string" ? error.code : null;
  const status = Number(error.status ?? 0);

  // HTTP 状态直接映射
  if (status === 429 || code === "RATE_LIMIT") {
    return { retryable: true, reason: "限流，等待后重试" };
  }
  if (status === 503 || code === "MODEL_UNAVAILABLE" || code === "SERVER_ERROR") {
    return { retryable: true, reason: code === "SERVER_ERROR" ? "服务端错误" : "服务暂时不可用" };
  }
  if (status >= 500 && status < 600) {
    return { retryable: true, reason: "服务端错误" };
  }
  if (code === "TIMEOUT" || code === "NETWORK" || code === "EMPTY_RESPONSE") {
    return { retryable: true, reason: code === "TIMEOUT" ? "请求超时" : code === "NETWORK" ? "网络错误" : "空响应" };
  }
  if (code === "CANCELLED") {
    return { retryable: false, reason: "被中断（不打扰重试）" };
  }
  if (code === "AUTH" || code === "ENDPOINT_NOT_FOUND" || code === "BAD_REQUEST" || code === "CONTEXT_OVERFLOW") {
    return { retryable: false, reason: "配置/参数问题，重试不会改善" };
  }

  // fallback：根据 status 区间判断
  if (status === 400 || status === 422) return { retryable: false, reason: "请求无效" };
  if (status === 401 || status === 403) return { retryable: false, reason: "认证失败" };
  if (status === 404) return { retryable: false, reason: "端点不存在" };
  if (status >= 500) return { retryable: true, reason: "服务端错误" };
  if (status >= 400) return { retryable: false, reason: "客户端错误" };

  return { retryable: false, reason: "未知错误" };
}

export function parseRetryAfter(header?: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return Math.min(seconds * 1000, 120_000); // cap at 2min for cooldown respect

  // HTTP-date: not implemented for brevity—treat as 10s
  return 10_000;
}

// ──────────────────────────────────────────────────────────────────────
// 退避策略（equal jitter）
// ──────────────────────────────────────────────────────────────────────

export function backoffDelay(attempt: number, opts?: { baseMs?: number; maxDelayMs?: number }): number {
  const base = opts?.baseMs ?? DEFAULT_BASE_BACKOFF_MS;
  const max = opts?.maxDelayMs ?? MAX_DELAY_MS;
  const capped = Math.min(base * (attempt + 1), max);
  // equal jitter: delay = half + random(0, half)
  const half = capped / 2;
  const jittered = half + randomInt(0, Math.floor(half));
  return jittered;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxDelayMs?: number;
  respectRetryAfter?: boolean;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, cause: string) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? ONE_SHOT_MAX_ATTEMPTS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;
  const respectRetryAfter = opts.respectRetryAfter ?? true;
  const clock = opts.clock ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastCause = "unknown";
  let retryAfterMs: number | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const failure = classifyModelFailure({ code: (error as any).code, status: (error as any).status }, "");
      if (!failure.retryable) {
        throw error;
      }
      lastCause = error.message.slice(0, 200);
      if (respectRetryAfter && failure.retryAfterMs) retryAfterMs = Math.max(retryAfterMs ?? 0, failure.retryAfterMs);

      if (attempt === attempts - 1) {
        throw error;
      }
      const delay = backoffDelay(attempt, { baseMs, maxDelayMs });
      const effectiveDelay = retryAfterMs !== undefined ? Math.max(delay, retryAfterMs) : delay;
      // Respect abort signal
      if (opts.signal?.aborted) throw error;
      await sleep(effectiveDelay);
      retryAfterMs = undefined; // once used, clear it
      opts.onRetry?.(attempt, effectiveDelay, lastCause);
    }
  }
  throw new Error("unreachable");
}

// ──────────────────────────────────────────────────────────────────────
// 配额门控（整库节流 + 交互优先）
// ──────────────────────────────────────────────────────────────────────

export interface QuotaGateOpts {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitterMs?: number;
}

class GlobalQuotaGate {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitterMs: number;

  private cooldownUntil: number = 0;
  private backgroundGapMs: number = 3_000;
  private lastBackgroundAt: number = 0;
  private interactiveInFlight: number = 0;

  constructor(opts: QuotaGateOpts) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.jitterMs = opts.jitterMs ?? 1_000;
  }

  async acquire(tier: Tier, signal?: AbortSignal): Promise<void> {
    const deadline = signal?.aborted ? this.now() + 0 : Infinity;
    // Always wait for cooldown
    while (this.cooldownUntil > this.now()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const remaining = Math.max(0, Math.ceil(this.cooldownUntil - this.now()));
      const waitTime = Math.min(remaining, 5_000);
      await this.sleep(waitTime);
    }
    // Background must also yield to active interactive and maintain gap since last background call
    if (tier === "background") {
      while (true) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const gapSinceLastBg = this.lastBackgroundAt > 0 ? this.now() - this.lastBackgroundAt : Infinity;
        if (gapSinceLastBg >= this.backgroundGapMs) break;
        await this.sleep(Math.min(100, this.backgroundGapMs - gapSinceLastBg));
      }
    } else if (tier === "interactive") {
      // For interactive, only respect cooldown + small jitter to avoid thundering herd
      const jitter = 0 <= this.jitterMs ? this.jitterMs / 2 : 0;
      const futureJitter = this.now() + jitter;
      while (this.now() < futureJitter && this.cooldownUntil > this.now()) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await this.sleep(Math.min(100, this.cooldownUntil - this.now(), jitter));
      }
    }
    if (tier === "interactive") this.interactiveInFlight += 1;
  }

  release(tier: Tier): void {
    if (tier === "interactive") this.interactiveInFlight = Math.max(0, this.interactiveInFlight - 1);
    if (tier === "background") this.lastBackgroundAt = this.now();
  }

  noteRateLimit(retryAfterMs: number): void {
    // Cap per provider's promise but enforce minimum
    const enforced = Math.min(retryAfterMs, 120_000);
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + enforced);
    this.backgroundGapMs = Math.min(20_000, Math.max(3_000, Math.floor(this.backgroundGapMs * 2)));
  }

  noteSuccess(tier: Tier): void {
    if (tier === "background") {
      this.backgroundGapMs = Math.floor(this.backgroundGapMs / 2);
    }
  }
}

let quotaGateInstance: GlobalQuotaGate | null = null;

export function initQuotaGate(opts: QuotaGateOpts = {}): GlobalQuotaGate {
  if (!quotaGateInstance) quotaGateInstance = new GlobalQuotaGate(opts);
  return quotaGateInstance;
}

export async function runWithQuota<T>(tier: Tier, fn: () => Promise<T>, opts?: QuotaGateOpts & { signal?: AbortSignal }): Promise<T> {
  const gate = initQuotaGate(opts);
  await gate.acquire(tier, opts?.signal);
  try {
    return await fn();
  } finally {
    gate.release(tier);
  }
}

// ──────────────────────────────────────────────────────────────────────
// 单次调用包装：为 callModel / callModelWithTools 提供统一接口
// ──────────────────────────────────────────────────────────────────────

export interface CallWithRetryOptions extends RetryOptions {
  tier: Tier;
  jitterMs?: number;
  onRetryLog?: (attempt: number, delayMs: number, cause: string) => void;
}

export async function callWithRetry<T>(fn: () => Promise<T>, callTier: Tier, opts?: Partial<CallWithRetryOptions>): Promise<T> {
  const gateOpts = opts;
  const gate = initQuotaGate({ now: opts?.clock, sleep: opts?.sleep, jitterMs: opts?.jitterMs ?? 500 });
  await gate.acquire(callTier, opts?.signal);
  try {
    return await withRetry(fn, {
      attempts: callTier === "interactive" ? INTERACTIVE_MAX_ATTEMPTS : BACKGROUND_MAX_ATTEMPTS,
      baseMs: opts?.baseMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxDelayMs: opts?.maxDelayMs ?? MAX_DELAY_MS,
      respectRetryAfter: opts?.respectRetryAfter ?? true,
      clock: opts?.clock,
      sleep: opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
      signal: opts?.signal,
      onRetry: (attempt, delayMs, cause) => {
        opts?.onRetryLog?.(attempt, delayMs, cause);
        gate.noteRateLimit(delayMs); // bump cooldown on rate-limit-like delays
        if (delayMs >= 8_000) gate.noteRateLimit(delayMs); // treat long waits as rate limit
      },
    });
  } finally {
    gate.release(callTier);
    const isBk = callTier === "background";
    if (isBk) gate.noteSuccess(isBk ? "background" : "interactive");
  }
}
