/** 表情包（QQ 表情系统）前端 API：渠道能力探测、采集开关、导入上传，以及「智能识别」的语义作业。
 *  库里的东西本身在 /api/assets（媒体库那一页），这里只列能力与控制，不列第二份清单。 */

import { getJson, postJson } from "./client";
import type { NamingStats } from "./assets";

/** 渠道能力：official 发不了 face/mface（会降级），image 两条链路都原生。 */
export type EmoteCapabilities = {
  backend: "official" | "onebot";
  face: boolean;
  mface: boolean;
  image: boolean;
};
/** 内置表情词（可发词 + 降级 emoji + face id）。 */
export type EmoteFace = { keyword: string; id: number; emoji: string };

export type EmoteOverview = {
  stats: { total: number; cap: number };
  capabilities: EmoteCapabilities;
  autoCapture: boolean;
};

/** 能力 + 采集开关 + 张数。 */
export function overview(): Promise<EmoteOverview> {
  return getJson<EmoteOverview>("/api/emotes");
}

/** 内置表情词表（给用户/模型当"可选清单"）。 */
export function faces(): Promise<{ faces: EmoteFace[] }> {
  return getJson<{ faces: EmoteFace[] }>("/api/emotes/faces");
}

/** 单图上传：二进制直接落媒体库并登记成素材，一步到位。label 走查询参数。 */
export async function upload(file: File, label?: string): Promise<{ url: string }> {
  const qs = label !== undefined && label !== "" ? `?label=${encodeURIComponent(label)}` : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("/api/emotes/upload" + qs, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as { ok?: boolean; error?: string; url?: string };
    if (!data.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
    return { url: data.url };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("上传超时了，换个更小的文件试试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 目录批量导入：把本地文件夹里的图片一键入库（按内容 md5 去重，重扫不重复），归入同名文件夹。
 *  skippedFiles 给出每张没进来的文件叫什么、为什么（超上限 / 读不出是图片 / 库里有同一张）。 */
export function importDir(dir: string): Promise<{
  added: number;
  skipped: number;
  total: number;
  skippedFiles: Array<{ name: string; reason: string }>;
}> {
  return postJson<{
    ok: true;
    added: number;
    skipped: number;
    total: number;
    skippedFiles: Array<{ name: string; reason: string }>;
  }>("/api/emotes/import", { dir });
}

/** 自动采集开关：用户发来的图片是否顺手入库。 */
export function setAutoCapture(on: boolean): Promise<{ autoCapture: boolean }> {
  return postJson<{ ok: true; autoCapture: boolean }>("/api/emotes/preferences", { autoCapture: on });
}

// ── 智能识别：把库里的表情逐张看一遍，补上中文名与用法 ──────────────

/** 一轮作业里每张图的结局：识别成功给名字与写回的用法，失败给人话原因。 */
export type NamingResult = {
  id: string; file: string; name: string; error: string;
  /** 成功时写回的用法与标签：弹窗里那颗「智能识别」原地回填读的就是这一行。 */
  caption: string; tags: string[];
};

export type NamingJob = {
  running: boolean;
  total: number;
  done: number;
  named: number;
  failed: number;
  current: string;
  /** 最近一次失败的人话原因，界面用它解释「为什么有几张识别失败」。 */
  lastError: string;
  /** 当前自动降速的间隔（毫秒）；>0 表示服务商在限流，慢是在避墙不是卡住。 */
  throttleMs: number;
  finishedAt: number;
  /** 本轮逐张结果（失败的排在前面）。 */
  results: NamingResult[];
};

export type NamingStatus = {
  ok: boolean;
  job: NamingJob;
  naming: NamingStats;
};

/** 排进队列的结果：整库、勾选的几张、弹窗里那一张都走这一个入口。
 *  作业已经在跑就是往里追加（started 仍为 true，queued 是这次新加进去的张数）。
 *  started=false 时也带着当前 job：界面接着轮询那一个就行，
 *  不用靠比中文提示文案判断「是不是已经有人在跑了」。 */
export type NamingStart = {
  ok: boolean;
  started: boolean;
  reason?: string;
  total: number;
  queued: number;
  job: NamingJob;
  naming: NamingStats;
};

export function startNaming(options: { force?: boolean; only?: string[] } = {}): Promise<NamingStart> {
  return postJson<NamingStart>("/api/emotes/naming", options);
}

export function namingStatus(): Promise<NamingStatus> {
  return getJson<NamingStatus>("/api/emotes/naming");
}
