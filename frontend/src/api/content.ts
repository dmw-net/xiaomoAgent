import { cq, getJson } from "./client";

export type ContentFilter = "all" | "artifacts" | "chat" | "starred" | "reference";
export type ContentMediaFilter = "all" | "image" | "video" | "audio" | "file";
export type ContentAsset = {
  id: string;
  source: "artifact" | "message";
  artifactId?: string;
  messageId?: number;
  contactId: string;
  kind: "image" | "video" | "audio" | "file";
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

export function listContent(
  filter: ContentFilter,
  media: ContentMediaFilter,
  limit: number,
  offset: number,
  cid?: string,
): Promise<{
  assets: ContentAsset[];
  total: number;
  counts: Record<string, number>;
  kindCounts: Record<ContentMediaFilter, number>;
}> {
  const url = cq(`/api/content?filter=${encodeURIComponent(filter)}&media=${encodeURIComponent(media)}&limit=${limit}&offset=${offset}`, cid);
  return getJson(url);
}
