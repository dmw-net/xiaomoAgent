import { getJson, postJson } from "./client";

/** 她画出来的一张图。后端 artifacts 表的一行。 */
export type Artifact = {
  id: string;
  contactId: string;
  turnId: string | null;
  kind: string;
  url: string;
  prompt: string;
  revisedPrompt: string;
  withReference: boolean;
  shape: string;
  starred: boolean;
  createdAt: number;
};

export function listArtifacts(limit: number, offset: number, cid: string): Promise<{ artifacts: Artifact[]; total: number }> {
  const q = `limit=${limit}&offset=${offset}${cid ? "&contactId=" + encodeURIComponent(cid) : ""}`;
  return getJson("/api/artifacts?" + q);
}

/** 收藏 / 删除 / 设为她的长相。三个动作共用一条路由，靠 op 分。 */
export function manageArtifact(op: "star" | "delete" | "setFaceRef", id: string, contactId?: string): Promise<Record<string, unknown>> {
  return postJson("/api/artifacts", { op, id, ...(contactId ? { contactId } : {}) });
}
