// /api/extensions 的前端入口。所有写动作的回包都带整份快照：
// 扩展数量少，整刷比局部合并更不容易出现「界面和库对不上」。

import { getJson, postJson, putJson, deleteJson } from "./client";
import type { ExtensionSnapshot, ExtensionSnapshotEntry } from "../types";

export type ExtensionList = ExtensionSnapshot & { ok: true };

export function listExtensions(): Promise<ExtensionList> {
  return getJson("/api/extensions");
}

/** 上传一份清单 JSON（前端已读过文件）。失败（校验不过）时 error 是后端的人话原因。 */
export function importExtension(manifest: unknown): Promise<ExtensionList> {
  return postJson("/api/extensions/import", { manifest });
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionList> {
  return postJson("/api/extensions/enabled", { id, enabled });
}

/** 手动连一次 MCP：刷新工具目录，回包 diagnostics 里带连接结果。 */
export function probeExtension(id: string): Promise<ExtensionList> {
  return postJson("/api/extensions/probe", { id });
}

export function removeExtension(id: string, confirmed: boolean): Promise<ExtensionList> {
  return deleteJson(`/api/extensions/${encodeURIComponent(id)}?confirmed=${confirmed ? "1" : "0"}`);
}

export function saveExtensionTool(id: string, tool: unknown): Promise<ExtensionList> {
  return putJson(`/api/extensions/${encodeURIComponent(id)}/tools/${encodeURIComponent(String((tool as { name?: string }).name ?? ""))}`, { tool });
}

export function deleteExtensionTool(id: string, name: string): Promise<ExtensionList> {
  return deleteJson(`/api/extensions/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}`);
}

/** JS 工具执行许可。confirmed=false 后端直接拒绝——这里总是传 true，确认交给界面弹窗。 */
export function setScriptGate(confirmed: boolean, allow: boolean): Promise<ExtensionList> {
  return postJson("/api/extensions/script-gate", { confirmed, allow });
}

export type { ExtensionSnapshot, ExtensionSnapshotEntry };
