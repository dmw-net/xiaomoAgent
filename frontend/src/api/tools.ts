// 工具台账的 HTTP 入口。目录与状态都由后端下发，前端不维护第二份工具名。

import { getJson, postJson } from "./client";

export type ToolGroup = "sense" | "express" | "act" | "network" | "external" | "admin";
export type ToolScope = "companion" | "assistant";
export type ToolPreset = "off" | "quiet" | "balanced" | "full";
export type ToolPresetChoice = ToolPreset | "follow" | "custom";

export type ToolCatalogEntry = {
  name: string;
  label: string;
  summary: string;
  /** 聊天工具卡里的动作短语（「看了下时间」）；动态扩展工具没有，聊天卡兜「做了点事」。 */
  chat?: string;
  group: ToolGroup;
  scope: ToolScope;
  /** 来自哪个扩展（仅动态工具有）：启停一律回「扩展」页，台账不提供第二个开关。 */
  source?: string;
  alwaysOn?: boolean;
  risk?: "high";
  dynamic?: boolean;
};

export type ToolState = {
  ok: true;
  tools: ToolCatalogEntry[];
  /** 每个工具当前为什么可用/不可用，一句人话，后端算好。 */
  status: Record<string, string>;
  groups: Array<{ key: ToolGroup; label: string }>;
  presets: Array<{ key: ToolPreset; label: string; desc: string }>;
  choices: Array<{ key: ToolPresetChoice; label: string; desc: string }>;
  globalPreset: ToolPreset;
  /** 工具总闸：false = 陪伴侧全关。助手管理操作不受影响。 */
  toolsEnabled: boolean;
  disabledTools: string[];
  contacts: Array<{ id: string; name: string; preset: ToolPresetChoice }>;
};

export function fetchToolState(): Promise<ToolState> {
  return getJson("/api/tools");
}

export function saveToolState(patch: { disabledTools?: string[]; globalPreset?: ToolPreset; toolsEnabled?: boolean }): Promise<ToolState> {
  return postJson("/api/tools", patch);
}
