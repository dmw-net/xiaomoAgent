// 工具目录：台账、档位与逐项开关共用的唯一真相源。
//
// 刻意做成零业务依赖的纯数据模块：不 import tools.ts / settings.ts / extensions.ts，
// 免得和工具池形成运行时循环。动态扩展由调用方把 ToolDef 传进来补条目。
//
// ToolDef.description 是写给模型看的「什么时候该调用」，动辄几百字，
// 不适合摆在界面上；这里另给一句给人看的 label + summary。

export type ToolGroup = "sense" | "express" | "act" | "network" | "external" | "admin";
export type ToolScope = "companion" | "assistant";

export type ToolCatalogEntry = {
  name: string;
  label: string;
  summary: string;
  group: ToolGroup;
  scope: ToolScope;
  /** 常开不可关：助手读真实状态的前提。 */
  alwaysOn?: boolean;
  /** 高风险：出网 / 花钱 / 授权本机代码，界面上单独标出来。 */
  risk?: "high";
  /** 扩展带来的动态工具，不在静态池里。 */
  dynamic?: boolean;
  /** 来自哪个扩展（仅动态工具有）：台账里不再给第二个开关，启停一律回扩展页。 */
  source?: string;
  /** 聊天工具卡里的动作短语（「看了下时间」）：与设置页的 label 分开——
   *  一个面向聊天里的松弛语气，一个面向设置里的准确名词。也只在这里存一份。 */
  chat?: string;
};

export const TOOL_GROUPS: Array<{ key: ToolGroup; label: string }> = [
  { key: "sense", label: "感知" },
  { key: "express", label: "表达" },
  { key: "act", label: "执行" },
  { key: "network", label: "联网" },
  { key: "external", label: "扩展带来的工具" },
  { key: "admin", label: "助手的管理操作" },
];

type Meta = Omit<ToolCatalogEntry, "name">;

/** 21 个静态工具的展示元数据。与 staticToolPool() 的名字集合由 toolPoolDiagnostics 校验一致。
 *  chat 缺省时聊天卡兜「做了点事」；这里给全 21 个，扩展工具除外（动态的没有自然短语）。 */
export const TOOL_META: Record<string, Meta> = {
  get_current_time: { label: "看时间", chat: "看了下时间", summary: "现在几点、是不是深夜", group: "sense", scope: "companion" },
  search_memory: { label: "翻记忆", chat: "翻了翻记忆", summary: "检索你们之间记过的事", group: "sense", scope: "companion" },
  schedule_reminder: { label: "到点提醒", chat: "记了条提醒", summary: "立一条到点必须说的提醒", group: "act", scope: "companion" },
  generate_image: { label: "画一张图", chat: "画了张图", summary: "按描述生成图片发过来", group: "express", scope: "companion", risk: "high" },
  emote_search: { label: "找表情", chat: "翻了翻表情库", summary: "按想表达的反应翻候选", group: "express", scope: "companion" },
  send_emote: { label: "发表情", chat: "发了张表情", summary: "发一张表情，与频率档联动", group: "express", scope: "companion" },
  send_voice: { label: "发语音", chat: "发了条语音", summary: "把话合成一条语音", group: "express", scope: "companion", risk: "high" },
  web_search: { label: "搜索网页", chat: "联网搜了一下", summary: "搜索公开网页，唯一主动出网", group: "network", scope: "companion", risk: "high" },
  web_fetch: { label: "读网页", chat: "读了个网页", summary: "读取一个公开网页的正文", group: "network", scope: "companion", risk: "high" },
  load_skill: { label: "加载技能", chat: "翻出技能做法", summary: "读取一份自定义做法说明", group: "act", scope: "companion" },
  app_status: { label: "读应用状态", chat: "读了当前配置", summary: "读真实配置状态，助手回答的前提", group: "admin", scope: "assistant", alwaysOn: true },
  configure_model: { label: "配置模型档", chat: "配了模型", summary: "新增 / 修改模型档与密钥", group: "admin", scope: "assistant", risk: "high" },
  activate_model: { label: "切换模型档", chat: "切了模型", summary: "把某个档设为全局默认", group: "admin", scope: "assistant" },
  bind_contact_model: { label: "绑定联系人模型", chat: "绑了模型", summary: "给某位联系人单独绑档", group: "admin", scope: "assistant" },
  create_contact: { label: "新建联系人", chat: "建了联系人", summary: "创建一位新的联系人", group: "admin", scope: "assistant" },
  update_contact: { label: "改联系人设定", chat: "改了联系人", summary: "修改人设与关系文本", group: "admin", scope: "assistant" },
  set_contact_avatar: { label: "设头像", chat: "设了头像", summary: "抓图或画一张头像", group: "admin", scope: "assistant" },
  manage_extensions: { label: "管理扩展", chat: "动了扩展配置", summary: "启停 / 连接测试 / 删除扩展", group: "admin", scope: "assistant", risk: "high" },
  import_extension: { label: "导入扩展", chat: "导入了扩展清单", summary: "登记一份新清单", group: "admin", scope: "assistant", risk: "high" },
  edit_extension_tool: { label: "编辑扩展工具", chat: "改了扩展工具", summary: "增删自定义 Webhook / JS 工具", group: "admin", scope: "assistant", risk: "high" },
  set_script_gate: { label: "JS 执行许可", chat: "改了脚本执行许可", summary: "开启本机脚本工具执行", group: "admin", scope: "assistant", risk: "high" },
};

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOL_META));

// ── 四档 ────────────────────────────────────────────────────────

/** 界面上的三档：程度决策。「全关」是二元决策，独立成总开关，不混进这一排。 */
export const TOOL_PRESETS = ["quiet", "balanced", "full"] as const;
/** 内部仍认 off：上一版与存量联系人可能存过这个值，读到这里要能接住。 */
export const INTERNAL_TOOL_PRESETS = ["off", ...TOOL_PRESETS] as const;
export type ToolPreset = (typeof INTERNAL_TOOL_PRESETS)[number];
/** follow = 跟随全局档；custom = 沿用逐项开关（存量联系人迁移后的默认）。 */
export type ToolPresetChoice = ToolPreset | "follow" | "custom";
export const TOOL_PRESET_CHOICES: readonly ToolPresetChoice[] = ["follow", ...INTERNAL_TOOL_PRESETS, "custom"];

/**
 * 全局默认档取「安静」：它与升级前的逐项默认值在**高风险项**上完全一致
 * （联网 / 出图 / 语音 / 提醒全关），不会替任何用户把花钱或出网的能力翻成开。
 * 新建联系人默认跟随这一档；存量联系人迁移时一律标 custom，配置一个不丢。
 */
export const GLOBAL_TOOL_PRESET_DEFAULT: ToolPreset = "quiet";

export const PRESET_LABEL: Record<ToolPresetChoice, string> = {
  follow: "跟随全局", off: "全关", quiet: "安静", balanced: "均衡", full: "全能", custom: "自定义",
};

export const PRESET_DESC: Record<ToolPresetChoice, string> = {
  follow: "跟着全局档走，全局改了这里一起改",
  off: "一个工具都不给，纯聊天",
  quiet: "看时间、翻记忆、表情、技能与扩展；收紧提醒与联网/出图/语音",
  balanced: "安静档 + 到点提醒",
  full: "均衡档 + 联网、出图与语音（仍需配好能力）",
  custom: "沿用逐项开关，不受档位影响",
};

/**
 * 各档要摘掉的静态工具。off 档在 visibleTools 里直接 return []，这里给空数组占位。
 *
 * 「安静」的边界经过实测校准：升级前默认就开着表情、技能与扩展，只关提醒与
 * 联网/出图/语音。若按字面把安静解释成「只剩时间 + 记忆」，等于替所有用户
 * 把表情能力翻成默认关（表情回归当场挂掉）。所以表情/技能/扩展归安静档，
 * 提醒归均衡档，高风险三项归全能档——四档仍是严格的逐级放大。
 */
export const PRESET_OFF: Record<ToolPreset, readonly string[]> = {
  off: [],
  quiet: ["schedule_reminder", "generate_image", "send_voice", "web_search", "web_fetch"],
  balanced: ["generate_image", "send_voice", "web_search", "web_fetch"],
  full: [],
};

/** 只有全关档连扩展工具一起收掉；其余各档都放行（仍受扩展启停与脚本许可约束）。 */
export const PRESET_BLOCKS_EXTENSIONS: Record<ToolPreset, boolean> = {
  off: true, quiet: false, balanced: false, full: false,
};

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (INTERNAL_TOOL_PRESETS as readonly string[]).includes(value);
}

export function isToolPresetChoice(value: unknown): value is ToolPresetChoice {
  return typeof value === "string" && TOOL_PRESET_CHOICES.includes(value as ToolPresetChoice);
}

/** 目录条目：静态 21 个 + 调用方传入的动态扩展（带扩展名，台账据此把启停还回扩展页）。 */
export function toolCatalog(
  dynamic: ReadonlyArray<{ name: string; description: string; source?: string }> = [],
): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = Object.entries(TOOL_META).map(([name, meta]) => ({ name, ...meta }));
  for (const tool of dynamic) {
    entries.push({
      name: tool.name,
      label: tool.name.replace(/^(mcp|ext)__/, "").replace(/__/g, " · "),
      summary: tool.description || "扩展提供的工具",
      group: "external",
      scope: "companion",
      dynamic: true,
      ...(tool.source !== undefined ? { source: tool.source } : {}),
    });
  }
  return entries;
}
