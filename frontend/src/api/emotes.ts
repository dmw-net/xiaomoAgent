/** 表情包（QQ 表情系统）前端 API。素材库 = 本地 /media 图片 + 关键词，按渠道能力降级。 */

import { deleteJson, getJson, postJson } from "./client";

/** 素材库里的一条表情（一张 /media 图片 + 展示名 + 关键词标签）。 */
export type EmoteAsset = { url: string; label: string; tags: string[] };
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
  assets: EmoteAsset[];
  stats: { total: number; cap: number };
  capabilities: EmoteCapabilities;
  autoCapture: boolean;
};

/** 总览：列表 + 统计 + 渠道能力 + 采集开关，"表情"分区一次拉齐。 */
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

/** 目录批量导入：把本地文件夹里的图片一键入库（按内容 md5 去重，重扫不重复）。 */
export function importDir(dir: string, tag?: string): Promise<{ added: number; skipped: number; total: number }> {
  return postJson<{ ok: true; added: number; skipped: number; total: number }>("/api/emotes/import", { dir, tag });
}

/** 自动采集开关：他发来的图片是否顺手入库。 */
export function setAutoCapture(on: boolean): Promise<{ autoCapture: boolean }> {
  return postJson<{ ok: true; autoCapture: boolean }>("/api/emotes/preferences", { autoCapture: on });
}

/** 摘掉一个素材登记（文件本体交给媒体回收通道，这里只动素材库）。 */
export function remove(url: string): Promise<{ removed: boolean }> {
  return deleteJson<{ ok: true; removed: boolean }>(`/api/emotes?url=${encodeURIComponent(url)}`);
}
