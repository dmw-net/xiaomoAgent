import { cq, getJson } from "./client";

export type ContentFilter = "all" | "artifacts" | "chat" | "starred" | "reference";
export type ContentAsset = {
  id: string;
  source: "artifact" | "message";
  artifactId?: string;
  messageId?: number;
  contactId: string;
  kind: "image" | "audio" | "file";
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

export function listContent(
  filter: ContentFilter,
  limit: number,
  offset: number,
  cid?: string,
): Promise<{ assets: ContentAsset[]; total: number; counts: Record<string, number> }> {
  const url = cq(`/api/content?filter=${encodeURIComponent(filter)}&limit=${limit}&offset=${offset}`, cid);
  return getJson(url);
}
