// 健康与自省：/healthz、/api/status（状态页体检）、/api/diagnostics（用户可点的只读检查）、
// 媒体维护（trash/restore/purge/delete-message）、存储占用与清理、重新计数、用量统计、
// 调用记录列表与单行详情。

import { config } from "../../core/config.ts";
import {
  currentCharacterName,
  modelConfig,
  modelReadyNow,
  providerLabel,
} from "../../settings/settings.ts";
import {
  deleteMessage,
  turnStats,
} from "../../chat/agent.ts";
import {
  extractFailures,
  extractFailuresWorst,
  lastRecallAt,
  memoryCount,
  memoryStats,
  resetExtractFailures,
} from "../../mind/memory.ts";
import {
  countModelCalls,
  failureWatermark,
  lastModelCall,
  listInflightCalls,
  modelCallById,
  modelCallWindow,
  modelFailureCount,
  recentModelCallSummaries,
  resetFailureCounters,
  usageStats,
  type CallFilter,
} from "../../core/logs.ts";
import { listChannels } from "../../channels/types.ts";
import { wechat } from "../../channels/wechat.ts";
import { qq } from "../../channels/qq.ts";
import {
  mediaMaintenanceSnapshot,
  purgeMediaFiles,
  restoreMediaFiles,
  trashMediaFiles,
  voiceMessageIdsForFile,
} from "../../media/media.ts";
import { runUserDiagnostics } from "../../core/diagnostics.ts";
import { inspectGates } from "../../mind/proactive.ts";
import { outboundSummary } from "../../channels/outbound.ts";
import {
  cleanupStorage,
  isStorageCleanupOp,
  storageOverview,
  type StorageCleanupOp,
} from "../../core/storage.ts";
import { DEFAULT_CONTACT_ID } from "../../chat/contacts.ts";
import { strictContactId } from "../context.ts";
import { clampInt, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** 两处共用：「最近失败」过一遍水印——点过重新计数之后，那条旧失败不该继续标红。 */
function lastErrorView() {
  const lastCall = lastModelCall();
  const lastFailure = lastCall && lastCall.ok === 0 && lastCall.created_at >= failureWatermark() ? lastCall : null;
  return {
    modelFailures: modelFailureCount(),
    lastModelError: lastFailure
      ? {
          at: new Date(lastFailure.created_at).toISOString(),
          code: lastFailure.code,
          purpose: lastFailure.purpose,
          message: lastFailure.message,
        }
      : null,
  };
}

const healthRoute: Route = ({ res, path, method }) => {
  if (!(method === "GET" && path === "/healthz")) return false;
  const healthModel = modelConfig();
  const healthReady = modelReadyNow(healthModel);
  const view = lastErrorView();
  sendJson(res, 200, {
    ok: true,
    character: currentCharacterName(),
    modelMode: healthModel.mode,
    modelReady: healthReady,
    model: healthReady ? healthModel.name : null,
    memoryEvents: memoryCount(DEFAULT_CONTACT_ID),
    // 全局体检问的是"有没有哪条通道正在坏"，所以取各联系人里的最大值，
    // 而不是某个共享计数器——失败的计数本来就按联系人各记一份。
    memoryExtractFailures: extractFailuresWorst(),
    lastRecallAt: lastRecallAt(DEFAULT_CONTACT_ID),
    ...view,
    turns: turnStats(),
    channels: listChannels(),
    time: new Date().toISOString(),
  });
  return true;
};

const statusRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/status")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const model = modelConfig();
  const ready = modelReadyNow(model);
  const mem = memoryStats(contactId);
  const view = lastErrorView();
  sendJson(res, 200, {
    ok: true,
    character: currentCharacterName(),
    modelMode: model.mode,
    modelReady: ready,
    model: ready ? model.name : null,
    baseUrl: model.baseUrl,
    /** 这一家叫什么（供应商层的显示名；没起过就退回它第一份档的名字/主机名）。 */
    provider: providerLabel(model.baseUrl),
    /** 后端是否跑在开发模式（DEV_MODE=1，即 npm run dev）：前端据此自动露出排障 tab。 */
    devMode: config.devMode,
    /** 是否保存完整请求体。与“用户诊断是否可见”分开，普通用户永远看不到原始请求。 */
    rawCapture: config.devMode,
    dbPath: config.dbPath,
    memoryEvents: mem.total,
    memoryExtractFailures: extractFailures(contactId),
    memoryExtractSamples: mem.extractSamples,
    memoryExtractEmptyRate: mem.emptyRate,
    lastRecallAt: lastRecallAt(contactId),
    ...view,
    /** 近 24 小时的调用/失败数：健康信号要时间窗，累计值会把多年前的失败一直挂着。 */
    recent: modelCallWindow(24),
    proactive: { ...inspectGates(contactId), enabled: config.proactive.enabled },
    turns: turnStats(),
    channels: listChannels(),
    /** 通道是全局资产（一个联系人一条链接），总览按整体报，不按当前会话那位报。 */
    wechat: wechat.summary(),
    qq: qq.summary(),
    outbound: outboundSummary(),
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
  return true;
};

const diagnosticsRoute: Route = ({ res, path, method }) => {
  // 用户可点的只读运行检查：数据库、卡住的任务、孤立主动计划与媒体文件。
  // 与 DEV_MODE 解耦，不读取、不返回请求体或系统提示词。
  if (!(method === "GET" && path === "/api/diagnostics")) return false;
  sendJson(res, 200, { ok: true, ...runUserDiagnostics() });
  return true;
};

const mediaMaintenanceRoute: Route = async ({ req, res, path, method }) => {
  // 运行检查的闭环：先看哪些普通媒体没人引用，再显式移到回收站。
  // 前端传来的文件名在这里重新校验；真正移盘前 media.ts 还会重新扫一遍引用与保护期。
  if (method === "GET" && path === "/api/media/maintenance") {
    sendJson(res, 200, { ok: true, ...mediaMaintenanceSnapshot() });
    return true;
  }
  if (!(method === "POST" && path === "/api/media/maintenance")) return false;
  const body = await readJson<{ op?: unknown; names?: unknown }>(req);
  const op = typeof body.op === "string" ? body.op : "";
  const names = Array.isArray(body.names)
    ? body.names.filter((name): name is string => typeof name === "string")
    : [];
  if (op !== "trash" && op !== "restore" && op !== "purge" && op !== "delete-message") {
    sendJson(res, 400, { ok: false, error: "op 只支持 trash / restore / purge / delete-message" });
    return true;
  }
  if (names.length === 0 || names.length > 500) {
    sendJson(res, 400, { ok: false, error: "请选择 1 到 500 个媒体文件" });
    return true;
  }
  try {
    if (op === "delete-message") {
      let changed = 0;
      let skipped = 0;
      for (const name of names) {
        const ids = voiceMessageIdsForFile(name);
        if (ids.length !== 1) { skipped += 1; continue; }
        try {
          deleteMessage(ids[0]!);
          changed += 1;
        } catch { skipped += 1; }
      }
      sendJson(res, 200, { ok: true, changed, skipped, bytes: 0, ...mediaMaintenanceSnapshot() });
      return true;
    }
    const result = op === "trash"
      ? trashMediaFiles(names)
      : op === "restore"
        ? restoreMediaFiles(names)
        : purgeMediaFiles(names);
    sendJson(res, 200, { ok: true, ...result, ...mediaMaintenanceSnapshot() });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

const storageRoute: Route = async ({ req, res, path, method }) => {
  // 数据占用与“用户可自行清理”的少量非核心项。
  // 聊天、记忆、联系人、媒体引用不在这个接口里，避免一键误删关系数据。
  if (method === "GET" && path === "/api/storage/overview") {
    sendJson(res, 200, { ok: true, ...storageOverview() });
    return true;
  }
  if (!(method === "POST" && path === "/api/storage/cleanup")) return false;
  const body = await readJson<{ ops?: unknown }>(req);
  const ops = Array.isArray(body.ops)
    ? [...new Set(body.ops.filter((op): op is string => typeof op === "string"))].filter(isStorageCleanupOp)
    : [];
  if (ops.length === 0) {
    sendJson(res, 400, { ok: false, error: "请选择至少一项要清理的数据" });
    return true;
  }
  try {
    const result = cleanupStorage(ops as StorageCleanupOp[]);
    const compactNote = result.compacted ? "数据库已压缩" : "数据已清理，但数据库暂时被占用；下次清理或重启后可继续压缩";
    sendJson(res, 200, { ok: true, ...result, note: compactNote });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

const resetCountersRoute: Route = ({ res, path, method }) => {
  // 「重新计数」：把失败读数的起点挪到现在，红点清零。model_calls 一条不删，
  // 调用记录页照旧能翻到全部历史；记忆提取那边只清连续失败计数器。
  if (!(method === "POST" && path === "/api/status/reset-counters")) return false;
  const at = resetFailureCounters();
  resetExtractFailures();
  sendJson(res, 200, {
    ok: true,
    watermarkAt: new Date(at).toISOString(),
    note: "提醒已忽略：从现在起重新数；历史记录一条没删，「活动记录」里仍可查看。",
  });
  return true;
};

const usageRoute: Route = ({ res, path, method }) => {
  if (!(method === "GET" && path === "/api/usage/stats")) return false;
  sendJson(res, 200, { ok: true, ...usageStats() });
  return true;
};

const logsRoute: Route = ({ res, url, path, method }) => {
  if (method === "GET" && path === "/api/logs") {
    // 列表一律只发摘要行（原文换成字数）：limit=0 是给「在飞」轮询用的，它只要 inflight 列表。
    const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 0, LIST_LIMIT_MAX);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    // scope 三档：不给 = 全都要（老口径，留给 curl / 冒烟 / doctor 这类内部读者）；
    // model = 只模型调用；channel = 只通道投递（qq/wechat，见 CHANNEL_PURPOSES）。
    // 界面默认走 model——调用记录首先是模型调用，通道投递另有一档。
    const scope = url.searchParams.get("scope");
    const filter: CallFilter = {
      onlyFailed: url.searchParams.get("failed") === "1",
      purpose: url.searchParams.get("purpose") || undefined,
      purposes: url.searchParams.get("purposes")?.split(",").map((p) => p.trim()).filter(Boolean).slice(0, 8),
      turnId: url.searchParams.get("turnId") || undefined,
      modelOnly: scope === "model",
      channelOnly: scope === "channel",
    };
    sendJson(res, 200, {
      ok: true,
      failures: modelFailureCount(),
      total: countModelCalls(filter),
      devMode: config.devMode,
      filter,
      // 在飞的调用只存在于内存：模型没返回前 model_calls 根本没有行，
      // 界面上就分不清「没在跑」和「正在跑」。
      inflight: listInflightCalls(),
      calls: limit === 0 ? [] : recentModelCallSummaries(limit, offset, filter),
    });
    return true;
  }

  // 单行详情：全文只服务开发排障。普通模式连字段都不出口，只保留 message/detail
  // 这类短摘要给用户看失败原因；不要在出口层假装“发个 null”也算隐藏。
  const logRowMatch = method === "GET" ? path.match(/^\/api\/logs\/(\d+)$/) : null;
  if (logRowMatch) {
    const row = modelCallById(Number(logRowMatch[1]));
    if (row === null) {
      sendJson(res, 404, { ok: false, error: "找不到这条调用记录，可能已被清理" });
      return true;
    }
    const call = config.devMode ? row : (({ req_full: _req, res_full: _res, ...rest }) => rest)(row);
    sendJson(res, 200, { ok: true, devMode: config.devMode, call });
    return true;
  }
  return false;
};

export const routes: Route[] = [
  healthRoute,
  statusRoute,
  diagnosticsRoute,
  mediaMaintenanceRoute,
  storageRoute,
  resetCountersRoute,
  usageRoute,
  logsRoute,
];
