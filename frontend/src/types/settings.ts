/** 设置页的数据形态（/api/settings* 下发）。 */

/** 模型自述的能力开关（与后端 ModelCaps 对齐）。 */
export type ModelCaps = {
  /** 未勾选时不声明、也不执行任何工具。 */
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  thinkingOnly: boolean;
  customProtocol: boolean;
};

export type ThinkingLevelId = "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVEL_LABELS: Record<ThinkingLevelId, string> = {
  low: "低", medium: "中", high: "高", xhigh: "超高", max: "极致",
};

/** 思考参数形态，与后端 ThinkingParam 对齐（三处声明收在这一处）。 */
export type ThinkingParamId = "effort" | "templateKw" | "thinkingType";

/** 思考开关意图：auto 跟随模型不发送字段 / on 开 / off 关；"" 仅为兼容老配置。 */
export type ThinkingModeId = "" | "auto" | "on" | "off";

/** 全局表情使用倾向；off = 整条能力关闭（工具与提示词一起下线）。 */
export type EmoteFrequency = "off" | "rare" | "normal" | "often";

/** 模型档/当前生效配置上的能力元数据字段（两处共用）。 */
export type ModelMeta = {
  caps?: ModelCaps;
  thinkingLevel?: ThinkingLevelId | "";
  thinkingLevels?: ThinkingLevelId[];
  /** 思考参数形态：effort = reasoning_effort；templateKw = chat_template_kwargs.enable_thinking；thinkingType = 火山 `thinking:{type}`。 */
  thinkingParam?: ThinkingParamId;
  /** 开关系形态的显式意图："" 不发字段 / "on" 开 / "off" 关。effort 形态不看它。 */
  thinkingMode?: ThinkingModeId;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

export type ModelSettings = {
  mode: string;
  baseUrl: string;
  name: string;
  timeoutMs: number;
  extraBody: Record<string, unknown> | null;
  startupCheck: boolean;
  apiKey: string;
} & ModelMeta;

export type ProfileItem = {
  id: string;
  label: string;
  apiKey: string;
  mode?: string;
  baseUrl?: string;
  name?: string;
  timeoutMs?: number;
  extraBody?: Record<string, unknown> | null;
  active?: boolean;
} & ModelMeta;

export type CapabilityName = "memoryExtract" | "imageVision" | "imageGeneration" | "speechToText" | "textToSpeech" | "embedding";

/** 一张能力卡上的一份端点档：与「主对话模型」的档同构，只是字段少（没有 mode/思考形态）。 */
export type CapabilityEndpoint = {
  id: string;
  label: string;
  baseUrl?: string;
  apiKey?: string;
  name?: string;
  voice?: string;
  timeoutMs?: number;
  active?: boolean;
};

/**
 * 一张能力卡：可挑的档、在用哪一份（"" = 跟随主模型）、实际生效值。
 * `linkedToMain` 为真时 profiles 就是「主对话模型」那批档，界面上只有下拉可挑。
 */
export type CapabilityConfig = {
  profiles: CapabilityEndpoint[];
  activeId: string;
  linkedToMain?: boolean;
  effective: { baseUrl: string; model: string; timeoutMs: number; apiKey: string; voice: string };
};

/** 桌宠设置：桌面透明小窗里的陪伴形象。与后端 src/settings/settings.ts 同源。 */
export type PetSettings = {
  enabled: boolean;
  /** 显示方式：desktop = 独立桌面透明小窗；in-app = 主界面内的陪伴浮层。 */
  displayMode: "desktop" | "in-app";
  /** 桌宠窗口宽度（逻辑像素）。 */
  size: number;
  alwaysOnTop: boolean;
  randomActions: boolean;
  chatter: boolean;
  /** 消息联动：小茉回复时进工作状态、联系人来消息时提示并可口跳转。 */
  linkContacts: boolean;
  /** 戳桌宠的点击音效。 */
  sound: boolean;
  /** 锁定位置：桌宠不可拖动（点击反应保留）。 */
  lockPosition: boolean;
  /** 桌宠整体不透明度（30-100）。 */
  opacity: number;
  /** 桌宠语音：碎碎念/戳它时用语音合成把话念出来（需语音合成能力卡）。 */
  voice: boolean;
  /** 上次拖到的屏幕位置（逻辑像素，仅桌面模式用）。 */
  x?: number;
  y?: number;
  /** 内嵌模式在主窗口视口内的位置（逻辑像素）。与 x/y 分开存：视口坐标 ≠ 屏幕坐标。 */
  inlineX?: number;
  inlineY?: number;
};

export type SettingsSnapshot = {
  model: ModelSettings;
  persona: {
    character: Record<string, string>;
    owner: { name?: string; impression?: string; notes?: string; avatar?: string; gender?: "female" | "male" | "other" };
    /** 回放最近 N 轮（-1 = 全部历史；0/缺省 = 跟随 .env 默认）。 */
    recentTurns?: number;
    /** 全局按会话比例回放（%）。> 0 时优先于 recentTurns，与联系人级 turnPct 同一判序。 */
    recentTurnsPct?: number;
  };
  /** .env / 内置默认的回放轮数（0 = 跟随默认时界面用来显示）。 */
  defaultRecentTurns?: number;
  /** 全局工具循环的模型轮次上限：普通联系人统一使用它。 */
  toolLoopTurns: number;
  toolLoopTurnLimits: { min: number; max: number };
  /** 全局表情使用倾向；仅在联系人开启表情工具时进入系统提示。 */
  emoteFrequency: EmoteFrequency;
  /** 全局逐项禁用的工具名（台账写入点，也由 /api/tools 单独下发）。 */
  disabledTools: string[];
  /** 工具总闸：false = 陪伴侧全关。 */
  toolsEnabled: boolean;
  /** 全局工具档位：off / quiet / balanced / full。 */
  globalToolPreset: "off" | "quiet" | "balanced" | "full";
  overridden: { model: string[]; persona: string[] };
  profiles: ProfileItem[];
  activeProfileId: string | null;
  /** 供应商名表 baseUrl → 名字。供应商这一层是按接口地址从 profiles 派生的，没有独立实体。 */
  providerNames?: Record<string, string>;
  hasKey: boolean;
  modelReady: boolean;
  /** 首次设置走完没有（服务端存的一份，桌面与手机打开同一数据不会各弹一次）。 */
  onboardingDone?: boolean;
  /** 默认联系人的人设还是出厂那份（引导据此问「要不要改人设」）。 */
  personaIsDefault?: boolean;
  capabilities: Record<string, CapabilityConfig>;
  capabilitiesReady?: Record<CapabilityName, boolean>;
  note?: string;
  /** 当前数据目录（库 / 图片 / 技能所在）。桌面端默认安装目录同级 xiaomodata；dev 可能为空。 */
  dataDir?: string;
  /** 桌面外壳的偏好（开机自启 / 关窗留托盘）。非桌面版没有配置文件，后端回 null。 */
  desktop?: { autostart: boolean; tray: boolean } | null;
  /** 桌宠设置。 */
  pet: PetSettings;
};

/** 技能行与后端同源（磁盘目录的扫描结果，不是数据库行）：见仓库根 shared/api.ts。 */
import type { SkillEntry } from "../../../shared/api";
export type { SkillEntry };

/** 扩展快照与后端同源（kv 登记表 + 诊断）：见仓库根 shared/api.ts。 */
import type { ExtensionSnapshot, ExtensionSnapshotEntry, ExtensionDiagnostic, ExtensionToolKind } from "../../../shared/api";
export type { ExtensionSnapshot, ExtensionSnapshotEntry, ExtensionDiagnostic, ExtensionToolKind };

/**
 * 技能写入口（新建 / 覆盖 / 删除）的回包：整份清单 + 刚落盘那一份的扫描结果。
 * saved.valid 才是"联系人看不看得见"，ok 只表示字落盘了——界面据此决定收起编辑器还是接着改。
 */
export type SkillWriteResult = { dir: string; skills: SkillEntry[]; saved?: SkillEntry; deleted?: string };

/** 一份技能的 SKILL.md 原文（编辑时回填用）。 */
export type SkillContent = { name: string; content: string };
