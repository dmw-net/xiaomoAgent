/** 状态页的数据形态（/api/status、/api/logs 下发）。 */

import type { QQStatus } from "./qq";

export type GateState = {
  blockedAt: string | null;
  gates: Record<string, { passed: boolean; detail: string }>;
  /** source：task = 队列里的一条计划/提醒；schedule = 联系人自己定的下次判断节拍。 */
  nextTask?: { focus: string; due_at: number; kind?: "care" | "reminder"; source?: "task" | "schedule" } | null;
  /** 调度器下一次真正会醒的时刻（不发消息时只是去看一眼）。 */
  nextWakeAt?: number | null;
  enabled?: boolean;
};

/** 状态页逐位明细里的一条：连着的是哪位联系人、这一位自己的状态。 */
export type WeChatContactItem = {
  contactId: string;
  name: string;
  enabled: boolean;
  proactive: boolean;
  status: "connected" | "disabled" | "attention" | "paused";
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
  /** 逐位明细（旧后端没有这个字段）：状态页据此直接列出「连着的是哪几位」。 */
  contacts?: WeChatContactItem[];
};

/** 状态页逐位明细里的一条（QQ 版）：名字 + 这一位自己的连接态。 */
export type QQContactItem = {
  contactId: string;
  name: string;
  enabled: boolean;
  proactive: boolean;
  status: QQStatus;
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
  /** at 是错误时间戳（毫秒）；旧后端没有这个字段。 */
  trouble: Array<{ contactId: string; name: string; lastError: string; at?: number }>;
  /** 逐位明细（旧后端没有这个字段）。 */
  contacts?: QQContactItem[];
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
  /** 近 50 次合法抽取的样本数与"本轮无需记录"占比；空结果是正常状态。 */
  memoryExtractSamples?: number;
  memoryExtractEmptyRate?: number | null;
  lastRecallAt?: number | null;
  modelFailures: number;
  /** 「忽略提醒」的水印（毫秒）：早于它的历史失败不进提醒条，累计统计与活动记录照旧保留。
   *  缺省 0 表示后端没下发（旧版），此时按没有忽略过处理。 */
  failureWatermarkAt?: number;
  /** 近 24 小时的调用数与失败数——健康信号只看这个，不看累计。 */
  recent?: { calls: number; fail: number };
  channels: string[];
  dbPath: string;
  proactive: GateState;
  wechat?: WeChatSummary;
  qq?: QQSummary;
  outbound?: OutboundSummary;
  turns?: { total: number; done: number; failed: number; inFlight: number; avgLatencyMs: number; lastFailedAt: number | null };
  uptimeSec?: number;
  time?: string;
  /** 后端是否开发模式（DEV_MODE=1）。只控制原始请求的落盘与开发者细节，不再决定用户诊断是否可见。 */
  devMode?: boolean;
  /** 显式表示是否保存完整请求体；普通用户的诊断界面不应依赖它。 */
  rawCapture?: boolean;
};

export type DiagnosticLevel = "ok" | "warn" | "bad";

export type OutboundStatus =
  | "pending"
  | "in_flight"
  | "delivered"
  | "failed"
  | "dead_letter"
  | "expired"
  | "ignored";

export type OutboundSummary = {
  counts: Record<OutboundStatus, number>;
  open: number;
  dead: number;
  total: number;
  oldestOpenAt: number | null;
  oldestDeadAt: number | null;
};

/** 用户版只拿安全字段；开发模式会多出 id、原始错误、tier 等排障字段。 */
export type OutboundDeliveryRow = {
  id?: string;
  contactId?: string;
  contactName?: string;
  conversationId?: string;
  channel: "qq" | "wechat" | "web";
  kind: "chat" | "proactive";
  status: OutboundStatus;
  text: string;
  segments?: string[];
  attempts: number;
  maxAttempts: number;
  tier?: string;
  lastError?: string;
  reason?: string;
  sourceMessageId?: string;
  createdAt: number;
  scheduledAt?: number;
  deliveredAt?: number;
  failedAt?: number;
  ignoredAt?: number;
  freshnessAt?: number;
};


export type UserDiagnosticCheck = {
  id: string;
  label: string;
  level: DiagnosticLevel;
  summary: string;
  detail?: string;
  action?: "backup" | "storage" | "activity" | "settings" | "media" | "outbound";
};

export type UserDiagnostics = {
  checkedAt: number;
  level: DiagnosticLevel;
  checks: UserDiagnosticCheck[];
};

export type MediaSourceKind = "avatar" | "face_ref" | "chat" | "voice" | "turn" | "artifact" | "tool" | "setting" | "wallpaper" | "none" | "trash";

export type MediaSource = {
  kind: MediaSourceKind;
  label: string;
  detail?: string;
  /** 聊天消息来源可直接从媒体页删除对应的语音消息。 */
  messageId?: number;
  durationMs?: number;
  transcript?: string;
};

export type MediaTypeKey = "image" | "video" | "audio" | "file";

/** 媒体管理弹层的一项：全部文件都带来源，只有 cleanable 的才能清理。 */
export type MediaMaintenanceItem = {
  name: string;
  url: string;
  size: number;
  modifiedAt: number;
  mediaKind: "image" | "video" | "audio" | "wallpaper";
  mediaType: MediaTypeKey;
  mime: string;
  durationMs?: number;
  transcript?: string;
  referenced: boolean;
  cleanable: boolean;
  sources: MediaSource[];
};

export type MediaTrashItem = MediaMaintenanceItem & {
  trashedAt: number;
  expiresAt: number;
};

export type MediaMaintenanceSnapshot = {
  files: number;
  referenced: number;
  pending: number;
  cleanable: number;
  items: MediaMaintenanceItem[];
  all: MediaMaintenanceItem[];
  trash: MediaTrashItem[];
  totalBytes: number;
  allBytes: number;
  trashBytes: number;
  byType: Record<MediaTypeKey, { files: number; bytes: number }>;
  orphanGraceHours: number;
  trashRetentionDays: number;
  checkedAt: number;
};

export type MediaMutationResponse = MediaMaintenanceSnapshot & {
  ok: true;
  changed: number;
  skipped: number;
  bytes: number;
};

export type ModelCallRow = {
  id: number;
  created_at: number;
  purpose: string;
  ok: number;
  code: string | null;
  status?: number | null;
  model?: string | null;
  url?: string | null;
  elapsed_ms: number;
  message: string | null;
  /** 失败时服务商返回的原始报文（截存），状态页可展开查看。 */
  detail: string | null;
  /** 两列原文的字数：列表页只发摘要（实测原文占整页 98% 字节却一行都不显示）。 */
  req_chars?: number | null;
  res_chars?: number | null;
  /** 完整响应正文：仅保留最近若干次调用的原文，更早的为 null（回退 detail 摘要）。开发模式下是服务商原始 JSON 报文。
   *  列表页不发它——只有 GET /api/logs/:id（点开某一行）才带。 */
  res_full?: string | null;
  /** 完整请求体 JSON：仅开发模式（DEV_MODE=1）下服务端才会带此字段。 */
  req_full?: string | null;
  turn_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
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
