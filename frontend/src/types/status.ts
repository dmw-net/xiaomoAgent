/** 状态页的数据形态（/api/status、/api/logs 下发）。 */

import type { QQStatus } from "./qq";

export type GateState = {
  blockedAt: string | null;
  gates: Record<string, { passed: boolean; detail: string }>;
  nextTask?: { focus: string; due_at: number } | null;
  enabled?: boolean;
  intervalMinutes?: number;
};

/** 全局微信连接概况（一个联系人至多一条链接，各自一条轮询）。 */
export type WeChatSummary = {
  links: number;
  max: number;
  connected: number;
  disabled: number;
  attention: number;
  paused: number;
  proactive: number;
  trouble: Array<{ contactId: string; name: string; lastError: string }>;
};

/** QQ 通道的全局概况：凭据只有一份（一个机器人服务很多用户），所以这里先报配没配。 */
export type QQSummary = {
  configured: boolean;
  /** 已脱敏的 AppID，只为认出"配过哪一台"。 */
  appId: string;
  status: QQStatus;
  lastError: string;
  bindings: number;
  max: number;
  active: number;
  proactive: number;
  trouble: Array<{ contactId: string; name: string; lastError: string }>;
};

export type StatusData = {
  modelReady: boolean;
  model: string;
  modelMode?: string;
  baseUrl: string;
  /** 这一家叫什么（供应商层的显示名，没起过名字就退回它第一份档的名字/主机名）。 */
  provider?: string;
  lastModelError: { code?: string; message?: string; at?: string; purpose?: string } | null;
  memoryEvents: number;
  memoryExtractFailures: number;
  lastRecallAt?: number | null;
  modelFailures: number;
  /** 近 24 小时的调用数与失败数——健康信号只看这个，不看累计。 */
  recent?: { calls: number; fail: number };
  channels: string[];
  dbPath: string;
  proactive: GateState;
  wechat?: WeChatSummary;
  qq?: QQSummary;
  turns?: { total: number; done: number; failed: number; inFlight: number; avgLatencyMs: number; lastFailedAt: number | null };
  uptimeSec?: number;
  time?: string;
  /** 后端是否开发模式（DEV_MODE=1，npm run dev）：前端据此自动显隐 调用记录/最近处理/记忆测试。 */
  devMode?: boolean;
};

export type ModelCallRow = {
  id: number;
  created_at: number;
  purpose: string;
  ok: number;
  code: string | null;
  elapsed_ms: number;
  message: string | null;
  /** 失败时服务商返回的原始报文（截存），状态页可展开查看。 */
  detail: string | null;
  /** 两列原文的字数：列表页只发摘要（实测原文占整页 98% 字节却一行都不显示）。 */
  req_chars?: number | null;
  res_chars?: number | null;
  /** 完整响应正文：仅最近 10 条调用保留，更早的为 null（回退 detail 摘要）。开发模式下是服务商原始 JSON 报文。
   *  列表页不发它——只有 GET /api/logs/:id（点开某一行）才带。 */
  res_full?: string | null;
  /** 完整请求体 JSON：仅开发模式（DEV_MODE=1）下服务端才会带此字段。 */
  req_full?: string | null;
  total_tokens?: number | null;
};

/** 在飞的模型调用（服务端内存登记，不落库）：调用记录只列已完成的行，
 *  没这一份就看不出「正在回复」。 */
export type InflightCall = {
  id: number;
  purpose: string;
  model: string;
  contactId: string | null;
  turnId: string | null;
  startedAt: number;
  elapsedMs: number;
  /** 这一轮在回哪句话（处理单的原文）；非对话类调用可能为 null。 */
  turnText: string | null;
};

/** 状态页的处理单（带文本与回复，与对话页的轻量 TurnRow 不同）。 */
export type StatusTurnRow = {
  id: string;
  status: string;
  text: string;
  reply: string | null;
  error: string | null;
  created_at: number;
  /** 完成时刻：与 created_at 相减就是这一轮跑了多久（进行中的为 null）。 */
  finished_at: number | null;
};

export type UsageBucket = {
  calls: number;
  ok: number;
  fail: number;
  avgMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UsageStats = {
  today: UsageBucket;
  week: UsageBucket;
  total: UsageBucket;
  byDay: Array<{ day: string; calls: number; fail: number; totalTokens: number }>;
  byPurpose: Array<{ purpose: string; calls: number; totalTokens: number }>;
  /** 近 30 天按模型档聚合（profileId null = 全局配置；purposes 含 asr/tts 的是能力模型）。 */
  byModel?: Array<{ profileId: string | null; model: string | null; purposes?: string; calls: number; fail: number; totalTokens: number }>;
  /** 近 30 天按联系人聚合（contactId null = 无归属调用）。 */
  byContact?: Array<{ contactId: string | null; calls: number; fail: number; totalTokens: number }>;
};
