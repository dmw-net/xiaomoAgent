// 内容库索引：把独立作品台账与聊天里的媒体附件汇成同一个只读视图。
//
// 不新建媒体表：当前附件已经归属 messages，生成作品归属 artifacts；这里只做聚合、去重和
// 分类。以后若落盘语音消息或普通文件，仍可从 messages.attachments 自然纳入，不必搬数据。

import { db } from "./db.ts";

export type ContentFilter = "all" | "artifacts" | "chat" | "starred" | "reference";
export type ContentKind = "image" | "audio" | "file";

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
  createdAt: number;
};

type ArtifactRow = {
  id: string; contact_id: string; url: string; prompt: string; revised_prompt: string;
  with_reference: number; shape: string; starred: number; created_at: number;
};
type MessageRow = {
  id: number; contact_id: string; role: string; text: string; attachments: string; created_at: number;
};

function kindOf(url: string): ContentKind {
  if (/\.(png|jpe?g|webp|gif|avif)$/i.test(url)) return "image";
  if (/\.(mp3|wav|m4a|ogg|opus|webm)$/i.test(url)) return "audio";
  return "file";
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
    "SELECT id, contact_id, role, text, attachments, created_at FROM messages WHERE contact_id = ? AND attachments IS NOT NULL ORDER BY created_at DESC, id DESC",
  ).all(contactId) as MessageRow[];
  const chat: ContentAsset[] = [];
  for (const m of messages) {
    parseAttachments(m.attachments).forEach((url, index) => {
      if (artifactUrls.has(url)) return; // 生成图通常也会随消息落一份，作品身份优先，不重复展示。
      const kind = kindOf(url);
      const fallback = kind === "image" ? (m.role === "user" ? "你发出的图片" : "联系人发来的图片") : fileNameOf(url);
      const label = m.text.trim().slice(0, 60) || fallback;
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
        createdAt: m.created_at,
      });
    });
  }
  return [...artifacts, ...chat].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function listContent(
  contactId: string,
  filter: ContentFilter,
  limit: number,
  offset: number,
): { assets: ContentAsset[]; total: number; counts: Record<string, number> } {
  const all = collect(contactId);
  const counts = {
    all: all.length,
    artifacts: all.filter((a) => a.source === "artifact").length,
    chat: all.filter((a) => a.source === "message").length,
    starred: all.filter((a) => a.starred).length,
    reference: all.filter((a) => a.withReference).length,
  };
  const filtered = all.filter((a) => {
    if (filter === "artifacts") return a.source === "artifact";
    if (filter === "chat") return a.source === "message";
    if (filter === "starred") return a.starred;
    if (filter === "reference") return a.withReference;
    return true;
  });
  return { assets: filtered.slice(offset, offset + limit), total: filtered.length, counts };
}
