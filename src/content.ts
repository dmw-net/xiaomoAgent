// 内容库索引：把独立作品台账与聊天里的媒体附件汇成同一个只读视图。
//
// 不新建媒体表：当前附件已经归属 messages，生成作品归属 artifacts；这里只做聚合、去重和
// 分类。作品与聊天附件共用同一套媒体类型，语音/视频不另起页面。

import { db } from "./db.ts";
import { mediaTypeOfUrl } from "./media.ts";

export type ContentFilter = "all" | "artifacts" | "chat" | "starred" | "reference";
export type ContentMediaFilter = "all" | "image" | "video" | "audio" | "file";
export type ContentKind = "image" | "video" | "audio" | "file";

export type ContentAsset = {
  id: string;
  source: "artifact" | "message";
  artifactId?: string;
  messageId?: number;
  contactId: string;
  kind: ContentKind;
  url: string;
  fileName: string;
  title: string;
  prompt: string;
  revisedPrompt: string;
  withReference: boolean;
  shape: string;
  starred: boolean;
  role?: string;
  durationMs?: number;
  transcript?: string;
  waveform?: number[];
  mime?: string;
  createdAt: number;
};

type ArtifactRow = {
  id: string; contact_id: string; url: string; prompt: string; revised_prompt: string;
  with_reference: number; shape: string; starred: number; created_at: number;
};
type MessageRow = {
  id: number; contact_id: string; role: string; text: string; attachments: string;
  attachment_meta: string | null; created_at: number;
};
type AttachmentMeta = {
  durationMs?: number; transcript?: string; waveform?: number[]; mime?: string;
};

type ContentCounts = Record<ContentFilter, number>;
type KindCounts = Record<ContentMediaFilter, number>;

function kindOf(url: string): ContentKind {
  return mediaTypeOfUrl(url);
}

function fileNameOf(url: string): string {
  const tail = url.split("/").pop() || "未命名文件";
  try { return decodeURIComponent(tail); } catch { return tail; }
}

function parseAttachments(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.startsWith("/media/")) : [];
  } catch { return []; }
}

function parseAttachmentMeta(raw: string | null): Map<string, AttachmentMeta> {
  const out = new Map<string, AttachmentMeta>();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return out;
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue;
      const v = item as Record<string, unknown>;
      if (typeof v.url !== "string" || !v.url.startsWith("/media/")) continue;
      const durationMs = typeof v.durationMs === "number" && Number.isFinite(v.durationMs)
        ? Math.max(0, Math.round(v.durationMs)) : undefined;
      const transcript = typeof v.transcript === "string" && v.transcript.trim() !== ""
        ? v.transcript.trim().slice(0, 4000) : undefined;
      const waveform = Array.isArray(v.waveform)
        ? v.waveform.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
            .slice(0, 64).map((n) => Math.min(1, Math.max(0, n)))
        : undefined;
      out.set(v.url, {
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(transcript ? { transcript } : {}),
        ...(waveform && waveform.length > 0 ? { waveform } : {}),
        ...(typeof v.mime === "string" ? { mime: v.mime.slice(0, 100) } : {}),
      });
    }
  } catch { /* 坏元信息不影响附件本身 */ }
  return out;
}

function fallbackTitle(kind: ContentKind, role: string): string {
  if (kind === "audio") return role === "user" ? "你发出的语音" : "联系人发来的语音";
  if (kind === "video") return role === "user" ? "你发出的视频" : "联系人发来的视频";
  if (kind === "image") return role === "user" ? "你发出的图片" : "联系人发来的图片";
  return role === "user" ? "你发出的文件" : "联系人发来的文件";
}

function collect(contactId: string): ContentAsset[] {
  const artifacts = (db.prepare(
    "SELECT id, contact_id, url, prompt, revised_prompt, with_reference, shape, starred, created_at FROM artifacts WHERE contact_id = ? ORDER BY created_at DESC, id DESC",
  ).all(contactId) as ArtifactRow[]).map((a): ContentAsset => ({
    id: "artifact:" + a.id,
    source: "artifact",
    artifactId: a.id,
    contactId: a.contact_id,
    kind: kindOf(a.url),
    url: a.url,
    fileName: fileNameOf(a.url),
    title: a.prompt.trim() || "未命名作品",
    prompt: a.prompt,
    revisedPrompt: a.revised_prompt,
    withReference: a.with_reference === 1,
    shape: a.shape,
    starred: a.starred === 1,
    createdAt: a.created_at,
  }));

  const artifactUrls = new Set(artifacts.map((a) => a.url));
  const messages = db.prepare(
    "SELECT id, contact_id, role, text, attachments, attachment_meta, created_at FROM messages WHERE contact_id = ? AND attachments IS NOT NULL ORDER BY created_at DESC, id DESC",
  ).all(contactId) as MessageRow[];
  const chat: ContentAsset[] = [];
  for (const m of messages) {
    const metaByUrl = parseAttachmentMeta(m.attachment_meta);
    parseAttachments(m.attachments).forEach((url, index) => {
      if (artifactUrls.has(url)) return; // 生成图通常也会随消息落一份，作品身份优先，不重复展示。
      const kind = kindOf(url);
      const meta = metaByUrl.get(url);
      const fallback = fallbackTitle(kind, m.role);
      // 语音的 m.text 是转写或占位提示；有真实转写时才拿来当标题，不能让占位提示冒充内容。
      const textLabel = kind === "audio" ? (meta?.transcript ?? "") : m.text.trim().slice(0, 60);
      const label = textLabel || fallback;
      chat.push({
        id: `message:${m.id}:${index}`,
        source: "message",
        messageId: m.id,
        contactId: m.contact_id,
        kind,
        url,
        fileName: label,
        title: label,
        prompt: "",
        revisedPrompt: "",
        withReference: false,
        shape: "",
        starred: false,
        role: m.role,
        ...(meta ?? {}),
        createdAt: m.created_at,
      });
    });
  }
  return [...artifacts, ...chat].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function listContent(
  contactId: string,
  filter: ContentFilter,
  mediaFilter: ContentMediaFilter,
  limit: number,
  offset: number,
): { assets: ContentAsset[]; total: number; counts: ContentCounts; kindCounts: KindCounts } {
  const all = collect(contactId);
  const counts: ContentCounts = {
    all: all.length,
    artifacts: all.filter((a) => a.source === "artifact").length,
    chat: all.filter((a) => a.source === "message").length,
    starred: all.filter((a) => a.starred).length,
    reference: all.filter((a) => a.withReference).length,
  };
  const sourceFiltered = all.filter((a) => {
    if (filter === "artifacts") return a.source === "artifact";
    if (filter === "chat") return a.source === "message";
    if (filter === "starred") return a.starred;
    if (filter === "reference") return a.withReference;
    return true;
  });
  const kindCounts: KindCounts = {
    all: sourceFiltered.length,
    image: sourceFiltered.filter((a) => a.kind === "image").length,
    video: sourceFiltered.filter((a) => a.kind === "video").length,
    audio: sourceFiltered.filter((a) => a.kind === "audio").length,
    file: sourceFiltered.filter((a) => a.kind === "file").length,
  };
  const filtered = mediaFilter === "all" ? sourceFiltered : sourceFiltered.filter((a) => a.kind === mediaFilter);
  return { assets: filtered.slice(offset, offset + limit), total: filtered.length, counts, kindCounts };
}
