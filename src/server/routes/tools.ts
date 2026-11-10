// 工具台账：给「工具与扩展 → 总览」下发目录与全局开关状态，并接收写入。
//
// 目录是唯一真相源：静态 23 个来自 tool-catalog.ts 的展示元数据，
// 动态扩展从扩展快照补齐；前端不再维护第二份工具名。
// 联系人档位仍走原有的 PUT /api/contacts/:id，这里只管全局两份状态。

import { db } from "../../core/db.ts";
import {
  INTERNAL_TOOL_PRESETS, TOOL_GROUPS, TOOL_PRESETS, PRESET_LABEL, PRESET_DESC, PRESET_OFF,
  isToolPreset, toolCatalog, type ToolPresetChoice,
} from "../../mind/tool-catalog.ts";
import { snapshot as extensionSnapshot } from "../../mind/extensions.ts";
import {
  capabilityReady, globalDisabledTools, globalEmoteFrequency, globalToolPreset, globalToolsEnabled,
  setGlobalDisabledTools, setGlobalToolPreset, setGlobalToolsEnabled,
} from "../../settings/settings.ts";
import { readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

type ContactPresetRow = { id: string; name: string; preset: ToolPresetChoice };

/** 联系人级档位概览：台账的「例外」矩阵不用再逐位拉详情接口。 */
function contactPresets(): ContactPresetRow[] {
  const rows = db.prepare("SELECT id, name, features FROM contacts WHERE archived_at IS NULL ORDER BY created_at ASC")
    .all() as Array<{ id: string; name: string; features: string | null }>;
  return rows.map((row) => {
    let preset: ToolPresetChoice = "follow";
    try {
      const parsed = row.features ? (JSON.parse(row.features) as { toolPreset?: unknown }) : {};
      const value = parsed.toolPreset;
      // 存量联系人可能存过 off（上一版的「全关」档），仍要能原样显示出来。
      if (value === "follow" || value === "custom" || (typeof value === "string" && (INTERNAL_TOOL_PRESETS as readonly string[]).includes(value))) {
        preset = value as ToolPresetChoice;
      }
    } catch { /* 坏数据按跟随全局处理 */ }
    return { id: row.id, name: row.name, preset };
  });
}

function toolsState(): Record<string, unknown> {
  // 动态工具带上来源扩展与启停状态：台账据此撤掉第二个开关——
  // 扩展停了它的工具整组消失，逐项开关既多余又会误导用户去拧一个不存在的闸。
  const extByTool = new Map<string, { source: string; enabled: boolean }>();
  const dynamic = extensionSnapshot().extensions.flatMap((entry) =>
    entry.tools.map((tool) => {
      extByTool.set(tool.name, { source: entry.name, enabled: entry.enabled });
      return { name: tool.name, description: tool.description, source: entry.name };
    }));
  const catalog = toolCatalog(dynamic);
  const preset = globalToolPreset();
  const enabled = globalToolsEnabled();
  const disabled = new Set(globalDisabledTools());
  const quietEmote = globalEmoteFrequency() === "off";
  // 每个工具给一句人话状态，界面不用自己再做一遍四层布尔推理。
  const status: Record<string, string> = {};
  for (const tool of catalog) {
    const ext = extByTool.get(tool.name);
    if (tool.alwaysOn) status[tool.name] = "常开 · 不可关";
    else if (ext !== undefined && !ext.enabled) status[tool.name] = "扩展已停用";
    else if (disabled.has(tool.name)) status[tool.name] = "已全局关闭";
    else if (tool.scope === "companion" && !enabled) status[tool.name] = "总闸已关闭";
    else if (tool.scope === "companion" && PRESET_OFF[preset].includes(tool.name)) status[tool.name] = "当前档位不含";
    else if (tool.name === "generate_image" && !capabilityReady("imageGeneration")) status[tool.name] = "图像生成未配好";
    else if (tool.name === "send_voice" && !capabilityReady("textToSpeech")) status[tool.name] = "语音合成未配好";
    else if ((tool.name === "send_emote" || tool.name === "emote_search") && quietEmote) status[tool.name] = "表情频率设为关闭";
    else status[tool.name] = "允许";
  }
  return {
    ok: true,
    tools: catalog,
    status,
    groups: TOOL_GROUPS,
    presets: TOOL_PRESETS.map((key) => ({ key, label: PRESET_LABEL[key], desc: PRESET_DESC[key] })),
    choices: [
      { key: "follow", label: PRESET_LABEL.follow, desc: PRESET_DESC.follow },
      ...TOOL_PRESETS.map((key) => ({ key, label: PRESET_LABEL[key], desc: PRESET_DESC[key] })),
      { key: "custom", label: PRESET_LABEL.custom, desc: PRESET_DESC.custom },
    ],
    globalPreset: globalToolPreset(),
    toolsEnabled: enabled,
    disabledTools: globalDisabledTools(),
    contacts: contactPresets(),
  };
}

const toolsGetRoute: Route = ({ res, path, method }) => {
  if (!(path === "/api/tools" && method === "GET")) return false;
  sendJson(res, 200, toolsState());
  return true;
};

const toolsPostRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/tools" && method === "POST")) return false;
  const body = await readJson<{ disabledTools?: unknown; globalPreset?: unknown; toolsEnabled?: unknown }>(req, 64_000);
  if (body.globalPreset !== undefined && (!isToolPreset(body.globalPreset) || body.globalPreset === "off")) {
    sendJson(res, 400, { ok: false, error: `工具档位只能是 ${TOOL_PRESETS.join(" / ")}；全关请用总开关` });
    return true;
  }
  if (body.disabledTools !== undefined && !Array.isArray(body.disabledTools)) {
    sendJson(res, 400, { ok: false, error: "禁用清单必须是数组" });
    return true;
  }
  if (body.toolsEnabled !== undefined && typeof body.toolsEnabled !== "boolean") {
    sendJson(res, 400, { ok: false, error: "工具总闸必须是 true / false" });
    return true;
  }
  if (body.disabledTools !== undefined) setGlobalDisabledTools(body.disabledTools);
  if (body.globalPreset !== undefined) setGlobalToolPreset(body.globalPreset);
  if (body.toolsEnabled !== undefined) setGlobalToolsEnabled(body.toolsEnabled);
  sendJson(res, 200, toolsState());
  return true;
};

export const toolsRoutes: Route[] = [toolsGetRoute, toolsPostRoute];
