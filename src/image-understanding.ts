// 图片理解分流：聊天轮永远留在聊天档。
//   1. 聊天模型自己支持视觉：原图直接内联，视觉卡即使配置了也不参与聊天；
//   2. 聊天模型不支持视觉、但显式配置了图片理解卡：视觉卡只做一次识图，
//      把文字描述注入聊天上下文。
// 绝不再让带图的一轮整体切到另一张能力端点：那会连带丢掉思考、工具和个人档配置。

import { getAssetByUrl } from "./assets.ts";
import { isAssistant } from "./assistant.ts";
import { db } from "./db.ts";
import { callModel, contactModelSettings } from "./model.ts";
import type { ChatMessage } from "./model.ts";
import {
  capabilityActiveId,
  capabilityConfig,
  capabilityExplicit,
  capabilityReady,
  modelConfig,
  modelReadyNow,
} from "./settings.ts";
import { mediaDataUrl } from "./media.ts";

export type VisionHandling = "inline" | "describe" | "none";
export type DescriptionSource = "chat" | "imageVision";

const MAX_DESCRIPTION_CHARS = 700;
const DESCRIPTION_CACHE_MAX = 128;
const DESCRIPTION_CONCURRENCY = 3;
/** 提示词语义一变就升版本，旧描述保留但不会继续命中。 */
const DESCRIPTION_PROMPT_VERSION = "2026-11-02.1";

const descriptionCache = new Map<string, Promise<string>>();

// 识图结果与聊天原文分开存：它可以跨重启复用，但绝不能污染 messages.text。

const DESCRIPTION_PROMPT = [
  "你是只负责读图的视觉助手。请客观描述这张图片，供另一个聊天模型继续和用户对话。",
  "请包含：画面主体、场景、人物动作与表情、物体之间的关系、界面/截图里的状态；",
  "如果是聊天截图，按顺序说明每个气泡的发送者和内容；如果是界面截图，说明窗口标题、按钮和报错。",
  "尽量逐字转写所有可见文字、按钮、字幕、牌子、表格和对话框内容；看不清就说“不确定”。",
  "不要漏掉画面边缘的小字，但不要猜测图中没有的信息，不要评价，不要寒暄，不要输出 Markdown 标题。",
  "直接输出简洁描述，控制在 500 字以内。",
].join("\n");

/**
 * 这一位联系人的聊天轮该怎么处理图片。
 *
 * 注意：这里看的是联系人实际聊天档，而不是全局 `capabilityReady("imageVision")`。
 * 否则“全局主档支持视觉、某联系人绑定了一个纯文本档”时，会把图误发给纯文本模型。
 */
export function visionHandlingFor(contactId: string): VisionHandling {
  if (isAssistant(contactId)) return "none";
  const chat = contactModelSettings(contactId) ?? modelConfig();
  // 聊天模型自己能看图时，视觉卡只是备用配置，不能抢走本轮。
  if (modelReadyNow(chat) && chat.caps.vision) return "inline";
  // 聊天模型看不了图，才让显式视觉卡做一次性识别补足。卡坏了就如实降级。
  if (capabilityExplicit("imageVision") && capabilityReady("imageVision")) return "describe";
  return "none";
}

interface ImageCacheKey {
  hash: string;
  scope: string;
  key: string;
  model: string;
}

function imageCacheKey(
  url: string,
  options: { contactId?: string | null; source?: DescriptionSource },
): ImageCacheKey {
  const hash = getAssetByUrl(url)?.hash ?? url;
  if (options.source === "chat") {
    const chat = contactModelSettings(options.contactId ?? "") ?? modelConfig();
    const scope = ["chat", chat.baseUrl, chat.name].join("|");
    return { hash, scope, key: [hash, scope, DESCRIPTION_PROMPT_VERSION].join("|"), model: chat.name };
  }
  const cap = capabilityConfig("imageVision");
  const scope = ["imageVision", capabilityActiveId("imageVision"), cap.baseUrl, cap.model].join("|");
  return { hash, scope, key: [hash, scope, DESCRIPTION_PROMPT_VERSION].join("|"), model: cap.model };
}

function trimCache(): void {
  while (descriptionCache.size > DESCRIPTION_CACHE_MAX) {
    const oldest = descriptionCache.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    descriptionCache.delete(oldest);
  }
}

/** 只清内存层，保留 SQLite 持久缓存；测试用它验证跨进程语义。 */
export function clearImageDescriptionMemoryCache(): void {
  descriptionCache.clear();
}

/**
 * 识别一张图并返回可注入聊天上下文的 alt 文本。source=chat 时使用主聊天模型，
 * source=imageVision 时使用显式视觉卡。缓存键由「内容 hash + 来源端点 + 模型 + 提示词版本」组成；
 * 同一张图被重放、被不同消息引用、或应用重启后都不会重复识图。
 */
export function describeImageForChat(
  url: string,
  options: {
    turnId?: string | null;
    contactId?: string | null;
    signal?: AbortSignal;
    /** chat = 主聊天模型（主模型自带视觉时用于生成超限图片的 alt）；imageVision = 显式视觉卡。 */
    source?: DescriptionSource;
  } = {},
): Promise<string> {
  const { hash, scope, key, model } = imageCacheKey(url, options);
  const cached = descriptionCache.get(key);
  if (cached !== undefined) return cached;

  const task = (async (): Promise<string> => {
    try {
      const stored = db.prepare(
        "SELECT description FROM image_descriptions WHERE asset_hash = ? AND vision_scope = ? AND prompt_version = ?",
      ).get(hash, scope, DESCRIPTION_PROMPT_VERSION) as { description: string } | undefined;
      if (stored?.description) {
        console.log(`[vision] 缓存命中 ${hash.slice(0, 8)} via ${model}`);
        return stored.description;
      }
    } catch (error) {
      console.warn(`[vision] 读取持久识图缓存失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const dataUrl = mediaDataUrl(url);
    if (dataUrl === null) throw new Error("图片文件已不在媒体目录里");
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
      { type: "text", text: DESCRIPTION_PROMPT },
      { type: "image_url", image_url: { url: dataUrl } },
    ];
    const messages: ChatMessage[] = [{ role: "user", content }];
    console.log(`[vision] 识图 miss ${hash.slice(0, 8)} via ${model}`);
    const raw = await callModel(messages, {
      ...(options.source === "chat" ? {} : { capability: "imageVision" as const }),
      purpose: "image_understanding",
      turnId: options.turnId ?? null,
      contactId: options.contactId ?? null,
      maxTokens: 900,
      temperature: 0.2,
      signal: options.signal,
    });
    const description = raw.trim().replace(/\r\n/g, "\n").slice(0, MAX_DESCRIPTION_CHARS);
    if (description === "") throw new Error("视觉模型返回了空描述");
    try {
      db.prepare(
        `INSERT INTO image_descriptions
           (asset_hash, vision_scope, prompt_version, model, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_hash, vision_scope, prompt_version)
         DO UPDATE SET model = excluded.model, description = excluded.description, created_at = excluded.created_at`,
      ).run(hash, scope, DESCRIPTION_PROMPT_VERSION, model, description, Date.now());
    } catch (error) {
      console.warn(`[vision] 写入持久识图缓存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return description;
  })();

  descriptionCache.set(key, task);
  void task.catch(() => {
    if (descriptionCache.get(key) === task) descriptionCache.delete(key);
  });
  trimCache();
  return task;
}

function imageUrlsOf(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((url): url is string => typeof url === "string" && /\.(png|jpe?g|webp|gif|avif)$/i.test(url));
  } catch {
    return [];
  }
}

/** 只把本轮选中、且位于这个用户消息里的图片附上描述；未选中的由上游保持“看不到”标记。 */
export function appendImageDescriptions<T extends {
  role?: string;
  text: string;
  attachments: string | null;
  attachment_meta?: string | null;
}>(
  rows: T[],
  replay: ReadonlySet<string>,
  descriptions: ReadonlyMap<string, string>,
): T[] {
  return rows.map((row) => {
    if (row.role !== "user") return row;
    const urls = imageUrlsOf(row.attachments).filter((url) => replay.has(url));
    if (urls.length === 0) return row;
    const marks = urls.map((url, index) => {
      const desc = descriptions.get(url)?.trim()
        ?? "视觉识别失败，你看不到原图内容，别猜也别编";
      const label = urls.length > 1 ? `图片 ${index + 1}` : "图片";
      return `[${label}：${desc}]`;
    });
    return { ...row, text: row.text === "" ? marks.join("\n") : `${row.text}\n${marks.join("\n")}` };
  });
}

/** 以有限并发识别一批图；单张失败只降级成一行诚实说明，不拖垮整轮聊天。 */
export async function describeChatImages(
  urls: string[],
  options: {
    turnId?: string | null;
    contactId?: string | null;
    signal?: AbortSignal;
    source?: DescriptionSource;
  } = {},
): Promise<Map<string, string>> {
  const unique = [...new Set(urls)];
  const descriptions = new Map<string, string>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(DESCRIPTION_CONCURRENCY, unique.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const url = unique[index];
      if (url === undefined) return;
      if (options.signal?.aborted) return;
      try {
        descriptions.set(url, await describeImageForChat(url, options));
      } catch (error) {
        console.warn(`[vision] 识别 ${url} 失败：${error instanceof Error ? error.message : String(error)}`);
        descriptions.set(url, "视觉识别失败，你看不到原图内容，别猜也别编");
      }
    }
  });
  await Promise.all(workers);
  return descriptions;
}