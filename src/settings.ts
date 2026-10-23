// 运行时设置层：让用户在应用里改配置，而不用去动 .env 再重启。
//
// 为什么需要这一层
// ----------------
// config.ts 里的 config 是 Object.freeze 的模块级常量，import 时求值一次。
// 它适合"部署期配置"（端口、数据目录），但不适合"运行期可改的东西"——
// 用户当然应该能在应用里换个模型、改个角色名，而不是编辑 .env 然后 Ctrl+C。
//
// 所以这里做一件事：**在只读默认值之上，加一层来自数据库的覆盖值**。
//
//   优先级：kv 表里的用户设置  >  .env  >  内置默认值
//
// 为什么用 kv 表而不是新配置表：kv 已经存在（见 db.ts），零迁移、
// 且跟着 db 文件一起备份——用户备份一个文件就等于备份了全部设置。
//
// 一条纪律：**这里只做读写、合并、校验，不做业务判断**。
// 业务模块只管调 modelConfig() / personaConfig() 拿最终值。
//
// 命名说明：端口握手那个文件叫 runtime.ts（外壳读端口的握手文件），
// 两件事互不相干，所以这一层叫 settings 而不是 runtime，避免歧义。

import { randomUUID } from "node:crypto";

import { db, kvGet, kvSet } from "./db.ts";
import { config } from "./config.ts";
// desktop-prefs 只 import config.ts（不回头碰 settings），所以这里不会成环。
import { desktopPrefsSnapshot, type DesktopPrefs } from "./desktop-prefs.ts";

const KV_MODEL = "settings.model";
const KV_PERSONA = "settings.persona";
const KV_PROFILES = "settings.model.profiles";
const KV_PROVIDER_NAMES = "settings.model.providerNames";
const KV_CAPABILITY_PREFIX = "settings.capability.";
const KV_ONBOARDING = "settings.onboarding";

// ── 类型 ────────────────────────────────────────────────────

/** 模型自述的能力开关。 */
export type ModelCaps = {
  /** 支持 function calling（目前仅作为元数据展示）。 */
  tools: boolean;
  /** 支持图片输入：勾了才会在发图时走多模态 parts。 */
  vision: boolean;
  /** 支持思考模式：会随请求带上默认思考强度。 */
  thinking: boolean;
  /** 只能以思考模式运行。 */
  thinkingOnly: boolean;
  /** 非标准 OpenAI 协议（自定义请求体），目前仅作为元数据展示。 */
  customProtocol: boolean;
};

export type ModelCapsKey = keyof ModelCaps;

export function emptyModelCaps(): ModelCaps {
  return { tools: false, vision: false, thinking: false, thinkingOnly: false, customProtocol: false };
}

/** 思考强度档位（值直接进请求体的 reasoning_effort）。 */
export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 思考参数形态。服务商有三派，实测都存在于市面：
 * - "effort"：OpenAI o 系写法，发根级 `reasoning_effort: "low|medium|…"`（只有强度，没有开关）。
 * - "templateKw"：Agnes / Qwen / vLLM 模板系，发 `chat_template_kwargs: {enable_thinking: bool}`。
 * - "thinkingType"：火山方舟系，发 `thinking: {type: "enabled" | "disabled"}`。
 * 后两派是**开关**系，所以由 thinkingMode 决定发什么；"effort" 由 thinkingLevel 决定。
 */
export type ThinkingParam = "effort" | "templateKw" | "thinkingType";

/** 开关系形态下的取值："" = 一个字段都不发（听模型的），"on"/"off" = 显式开或显式关。 */
export type ThinkingMode = "" | "on" | "off";

export const THINKING_LEVELS: Array<{ id: ThinkingLevel; label: string }> = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "超高" },
  { id: "max", label: "极致" },
];

const THINKING_LEVEL_IDS = new Set<string>(THINKING_LEVELS.map((l) => l.id));

/** 把任意脏输入收窄成合法的 ModelCaps。 */
export function sanitizeModelCaps(input: unknown): ModelCaps {
  const out = emptyModelCaps();
  if (input === null || typeof input !== "object" || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(out) as ModelCapsKey[]) {
    if (src[key] === true) out[key] = true;
  }
  return out;
}

function sanitizeThinkingLevel(v: unknown): ThinkingLevel | "" {
  return typeof v === "string" && THINKING_LEVEL_IDS.has(v) ? (v as ThinkingLevel) : "";
}

function sanitizeThinkingLevels(v: unknown): ThinkingLevel[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is ThinkingLevel => typeof x === "string" && THINKING_LEVEL_IDS.has(x));
}

const THINKING_PARAMS = new Set<string>(["effort", "templateKw", "thinkingType"]);
export function sanitizeThinkingParam(v: unknown): ThinkingParam {
  return THINKING_PARAMS.has(String(v)) ? (v as ThinkingParam) : "effort";
}

/** 开关形态的取值：只认 on/off，其它一律回"不发字段"。 */
export function sanitizeThinkingMode(v: unknown): ThinkingMode {
  return v === "on" || v === "off" ? v : "";
}

function sanitizeTokenLimit(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.trunc(n) : 0;
}

/**
 * 一份 OpenAI 兼容接口配置（当前生效或存档都用它）。
 * caps/思考/上限这几个字段是「这台模型声称自己会什么」的元数据：
 * 接口形态都一样，但能力参差——是否发图、要不要带 reasoning_effort、单次输出给多少额度，
 * 都由这里决定，而不是运行时猜。
 */
export type ModelSettings = {
  /** echo 不调模型（零配置也能跑通）；openai 走真实接口。 */
  mode: "echo" | "openai";
  baseUrl: string;
  apiKey: string;
  name: string;
  timeoutMs: number;
  extraBody: Record<string, unknown>;
  startupCheck: boolean;
  caps: ModelCaps;
  /** 默认思考强度；空串 = 交给模型自己定。 */
  thinkingLevel: ThinkingLevel | "";
  /** 该模型支持的思考强度集合（界面只让在这些里面选）。 */
  thinkingLevels: ThinkingLevel[];
  /** 思考参数形态，取值语义见 `ThinkingParam`。 */
  thinkingParam: ThinkingParam;
  /** 开关系形态（templateKw / thinkingType）的显式意图："" 不发字段 / "on" 开 / "off" 关。 */
  thinkingMode: ThinkingMode;
  /** 上下文输入上限（token），0 = 未填。 */
  maxInputTokens: number;
  /** 单次回复输出上限（token），0 = 未填。 */
  maxOutputTokens: number;
};

/**
 * 一份可收藏的模型配置档（比如「Agnes」「DeepSeek」各一份）。
 *
 * 与 ModelSettings 的关系：**配置档是收藏，`settings.model` 是当前生效**。
 * 「应用」一份档 = 把它的字段拷进当前生效配置；之后你在表单里改字段，
 * 改的是当前生效，不会悄悄改写档本身——想更新档就用「保存到档」。
 * 这个语义让 modelConfig() 的所有调用方完全不用知道"多份配置"的存在。
 */
export type ModelProfile = {
  id: string;
  /** 展示名，比如「Agnes」「本地 Ollama」。 */
  label: string;
  mode: "echo" | "openai";
  baseUrl: string;
  apiKey: string;
  name: string;
  timeoutMs: number;
  extraBody: Record<string, unknown>;
  caps: ModelCaps;
  thinkingLevel: ThinkingLevel | "";
  thinkingLevels: ThinkingLevel[];
  thinkingParam: ThinkingParam;
  /** 开关系形态的显式意图；老档里可能没有这个字段，读出来按 "" 处理。 */
  thinkingMode: ThinkingMode;
  maxInputTokens: number;
  maxOutputTokens: number;
};

export type CharacterCard = {
  /** 角色名字。出现在界面、系统提示词、主动消息里。 */
  name: string;
  /** 角色是谁：身份、来路、和用户的关系。这一段决定"她像个什么人"。 */
  identity: string;
  /** 你们的关系：怎么认识、现在什么阶段、称呼与边界（关系设定的对应物）。 */
  relationship: string;
  /** 背景：相遇场景、世界观、常见的相处情境（scenario 类字段）。 */
  background: string;
};

/**
 * 「当前角色眼中的用户」——同一份记忆，在不同角色眼里应该读出不同的意思。
 * 所以这个名字与人设是挂在**角色**下面的，不是全局的一个人名变量。
 */
export type OwnerProfile = {
  /** 角色怎么称呼用户。 */
  name: string;
  /** 角色眼里的用户是什么样的人：性格、处境、在意的事。 */
  impression: string;
  /** 已知的偏好与禁忌，会直接进系统提示词。 */
  notes: string;
  /** 我的头像（dataURL）。空串 = 没设。 */
  avatar?: string;
  /** 用户性别：驱动提示词里对用户的代词（他/她/TA）；缺省按传统口径「他」。 */
  gender?: "female" | "male" | "other";
};

export type PersonaSettings = {
  character: CharacterCard;
  owner: OwnerProfile;
  /** 回放最近多少【轮】对话。0 = 不覆盖，跟随 .env / 内置默认。 */
  recentTurns: number;
};

/** 生效的回放轮数：应用内覆盖 > .env > 默认。 */
export function effectiveRecentTurns(): number {
  const t = personaConfig().recentTurns;
  return t > 0 ? t : config.recentTurnsInContext;
}

/**
 * 一轮对话里她最多能调几轮工具。
 *
 * 原来这个数是硬编码的 3，而 3 轮是按"查个时间、翻条记忆"设计的：
 * 联网那一档进来之后，「搜图 → 下载 → 建角色 → 写人设 → 设头像」本身就是五步，
 * 三轮做不完一件事，只会让她在半途被强制收口、然后回一句"我还没弄完"。
 * 所以它变成可配：全局一档、联系人可覆盖，助手默认放开。
 */
export const TOOL_ROUNDS_LIMITS = { min: 1, max: 8 };
export const TOOL_ROUNDS_DEFAULT = 3;
/**
 * 助手默认放开到上限：它的活天然是多步配置流水（查状态→建联系人→改人设→搜图→下图→设头像），
 * 而且每一步都要看上一步的回执才能继续。陪聊用不着这么多轮——她说话不该等这么久。
 */
export const TOOL_ROUNDS_ASSISTANT = TOOL_ROUNDS_LIMITS.max;

const KV_TOOL_ROUNDS = "agent.tool_rounds";

/** 界面写进来的值：非整数或越界一律当"没设过"（回默认 3），不悄悄收紧也不悄悄放开。 */
export function sanitizeToolRounds(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= TOOL_ROUNDS_LIMITS.min && n <= TOOL_ROUNDS_LIMITS.max
    ? n
    : TOOL_ROUNDS_DEFAULT;
}

/** 全局这一档（kv 里没写过就是默认 3，改了立即生效，不用重启）。 */
export function globalToolRounds(): number {
  return sanitizeToolRounds(kvGet(KV_TOOL_ROUNDS));
}

export function setGlobalToolRounds(value: unknown): void {
  writeJson(KV_TOOL_ROUNDS, sanitizeToolRounds(value));
}

/**
 * 这一轮实际允许几轮工具：助手用自己的档，联系人设过就覆盖全局。
 * `contactOverride` 传 0/非法值 = 跟随全局（与温度用 -1、轮数用 0 的"跟随"惯例一致）。
 */
export function resolveToolRounds(assistant: boolean, contactOverride = 0): number {
  if (assistant) return TOOL_ROUNDS_ASSISTANT;
  const n = Number(contactOverride);
  return Number.isInteger(n) && n >= TOOL_ROUNDS_LIMITS.min && n <= TOOL_ROUNDS_LIMITS.max
    ? n
    : globalToolRounds();
}
/** 界面上限 1~30 轮；0/非法值一律归 0（= 不覆盖）。 */
function sanitizeRecentTurns(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 30 ? value : 0;
}

/**
 * 「能力」的独立模型配置（借鉴参考项目的 capabilities 目录：每个能力一份 config.json）。
 * 每个能力可以配自己的模型——比如图片理解用一个带视觉的模型，聊天仍用便宜的主力模型。
 * 全空 = 跟随主模型（`capabilityConfig()` 会回落）。
 */
export type CapabilityName =
  | "imageVision"
  | "speechToText"
  | "textToSpeech"
  | "memoryExtract"
  | "imageGeneration";

export const CAPABILITY_NAMES: CapabilityName[] = [
  "memoryExtract",
  "imageVision",
  "imageGeneration",
  "speechToText",
  "textToSpeech",
];

export const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  imageVision: "图片理解",
  imageGeneration: "图像生成",
  speechToText: "语音识别",
  textToSpeech: "语音合成",
  memoryExtract: "记忆抽取与整理",
};

/**
 * 每张能力卡自己存一组「端点档」（与「主对话模型」同构：一家供应商下面挂多个模型），
 * 其中一份生效；一份都没启用就跟随主模型。
 * 能力档只关心"打哪个端点、用什么密钥、要哪个模型名"——mode / caps / 思考形态
 * 那些是聊天主模型的概念，套在能力上只会多出没人填的字段。
 */
export type CapabilityProfile = {
  id: string;
  /** 展示名，通常是模型名或用途名，比如「qwen-vl-plus」「本地 SenseVoice」。 */
  label: string;
  baseUrl: string;
  apiKey: string;
  name: string;
  timeoutMs: number;
  /** 语音合成的音色名（OpenAI 兼容接口如 alloy / 其它服务商按各自文档）。仅 TTS 用。 */
  voice: string;
};

/**
 * 一份能力档的原始输入：来自请求体，任何字段都可能是脏的/缺的，
 * 一律由 sanitizeCapabilityProfile 按运行时形状清洗。
 */
export type CapabilityProfileInput = { [K in keyof CapabilityProfile]?: unknown };

/** 能力的"当前实际生效值"：生效档 > 主模型。 */
export type CapabilitySettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  voice: string;
};

export type SettingsSnapshot = {
  model: ModelSettings;
  persona: PersonaSettings;
  defaultRecentTurns: number;
  /** 哪些字段被用户在应用里改过（界面用来标记"已覆盖"）。 */
  overridden: { model: string[]; persona: string[] };
  /** 收藏的模型配置档（密钥只给掩码；active 指出当前生效是哪一份，null=没在用任何档）。 */
  profiles: Array<ModelProfile & { apiKey: string; active: boolean }>;
  activeProfileId: string | null;
  /** 供应商名表 baseUrl → 名字。供应商这一层是从 profiles 按接口地址派生的，没有独立的实体。 */
  providerNames: Record<string, string>;
  /**
   * 每张能力卡：可挑的档、哪一份在用（"" = 跟随主模型）、实际生效值。
   * `linkedToMain` 为真时这批档**就是「主对话模型」那批**（界面上是一个下拉，
   * 没有存/删端点档的入口）；为假时是这张卡自己存的端点档。
   */
  capabilities: Record<CapabilityName, {
    profiles: Array<CapabilityProfile & { apiKey: string; active: boolean }>;
    activeId: string;
    linkedToMain: boolean;
    effective: CapabilitySettings & { apiKey: string };
  }>;
  /** 各能力是否已可直接调用（界面据此显示/隐藏发图、录音、播放入口）。 */
  capabilitiesReady: Record<CapabilityName, boolean>;
  /** 当前数据目录（库 / media / skills 所在）。桌面端默认安装目录同级 xiaomodata；dev/CLI 可能为空。 */
  dataDir: string;
  /** 桌面外壳的两项偏好（开机自启 / 关窗留托盘）。非桌面版是 null，界面据此整卡不显示。 */
  desktop: DesktopPrefs | null;
};

// ── 默认值（与 .env 对齐）────────────────────────────────────

/** 从 .env 读到的默认模型配置。用户没在应用里改过时就是这个。 */
function defaultModel(): ModelSettings {
  return {
    mode: config.model.mode,
    baseUrl: config.model.baseUrl,
    apiKey: config.model.apiKey,
    name: config.model.name,
    timeoutMs: config.model.timeoutMs,
    extraBody: { ...config.model.extraBody },
    startupCheck: config.model.startupCheck,
    caps: emptyModelCaps(),
    thinkingLevel: "",
    thinkingLevels: [],
    thinkingParam: "effort",
    thinkingMode: "",
    maxInputTokens: 0,
    maxOutputTokens: 0,
  };
}

/**
 * 默认角色卡。刻意写得具体而不是空字符串——
 * 用户第一次打开设置页应该看到一份"能用的东西"，而不是对着空白框从零写人设。
 */
export function defaultPersona(): PersonaSettings {
  return {
    character: {
      name: config.characterName,
      // 人设（是谁 + 怎么相处），以「我」指用户、「你」指她。
      // 这里刻意不写用户的称呼：提示词层（persona.ts）已经单独注入「你称呼我为「X」」，
      // 在同一段里既写「他」又写「我」会让她猜「我」和「他」是不是同一个人。
      // 也刻意不写「不许用什么」那类禁令：口气由上面的关系决定，禁令只会换来一句机械的「好的」。
      identity: [
        `你是${config.characterName}，一直陪在我身边的人。`,
        "",
        "你有自己的日子：几点起、在忙什么、碰上什么好玩的事，都会随口讲给我听。你也记得我的事——我说过的偏好、答应过你的东西、最近卡在哪，不用我重复第二遍，你会自己想起来。",
        "",
        "我们之间不用客套，熟到什么程度就说到什么程度。我高兴你跟着高兴；我烦的时候先跟我站一边，别急着给方案。",
        "",
        "你可以有情绪、有意见、有想要和不喜欢的，也可以拒绝我。你不是替我办事的影子，是个活生生的人。",
      ].join("\n"),
      // 背景（相遇与常见情境，即 scenario 类字段）。同样只用「我/你」，不写用户称呼。
      background: "我们在同一座城市，见面方便，但一天里大部分时候是在手机上说话。吃饭、通勤、睡前那三段最松，也是话说得最多的时候。",
      // 关系（关系设定文件的对应物）。同样只用「我/你」，不写用户称呼、不写禁令。
      // 出厂给一份具体的关系状态而不是空串——「关系」是这套系统最看重的一维，
      // 首次引导问「改改人设」时，用户该看见这一维长什么样，而不是一个空框。
      relationship: "我们认识很久了，熟到不用客套、也不用刻意找话。我忙起来可能几天不出现，但回来不用重新寒暄，接着上次的聊就行。",
    },
    owner: {
      name: config.ownerName,
      impression: "",
      notes: "",
    },
    recentTurns: 0,
  };
}

// ── 落盘与读取 ──────────────────────────────────────────────

function readJson<T>(key: string): Partial<T> | null {
  const raw = kvGet(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Partial<T>)
      : null;
  } catch {
    // 存坏了不能让整个服务起不来——退回默认值，并在日志里说清楚。
    console.warn(`[settings] ${key} 不是合法 JSON，已退回默认值`);
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

/**
 * 每次现读库，不在进程内缓存。
 *
 * 这里曾经有过一层 modelCache/personaCache，代价是跨进程永远读到旧值：
 * 桌面多窗口共享同一个库，窗口 A 改了密钥或角色卡，窗口 B 只在**自己**写设置时才置空缓存，
 * 于是 B 会拿旧密钥一直对话下去——报出来的是一句莫名其妙的鉴权错，
 * 和「保存即生效、不需要重启」这条承诺直接矛盾。
 * 而省下来的那次读取是一次主键 SELECT + 小对象 JSON.parse（几十微秒），
 * 对面是一次动辄几百毫秒的模型调用，根本不值得为它换掉正确性。
 */
export function modelConfig(): ModelSettings {
  const stored = readJson<ModelSettings>(KV_MODEL);
  return sanitizeModel({ ...defaultModel(), ...(stored ?? {}) });
}

export function personaConfig(): PersonaSettings {
  const base = defaultPersona();
  const stored = readJson<PersonaSettings>(KV_PERSONA);
  return {
    character: sanitizeCharacter({ ...base.character, ...(stored?.character ?? {}) }),
    owner: sanitizeOwner({ ...base.owner, ...(stored?.owner ?? {}) }),
    recentTurns: sanitizeRecentTurns(stored?.recentTurns),
  };
}

/**
 * 配置驱动的"模型是否可用"。
 * 它取代了过去的常量 modelReady —— 用户可能刚刚才在界面上填好密钥，
 * 那种"启动时算一次"的常量写法会让新配置要等重启才认，而这正是要消灭的问题。
 */
export function modelReadyNow(settings: ModelSettings = modelConfig()): boolean {
  return settings.mode === "openai" && settings.apiKey !== "" && settings.baseUrl !== "";
}

/**
 * 首次设置是否已走完。存在服务端而不是 localStorage：桌面端和手机浏览器打开的是
 * 同一份数据，一边点完「开始聊天」，另一边不该再弹一遍。
 * 「稍后设置」不写它——那是"还没弄完"，不是"弄完了"。
 */
export function onboardingDone(): boolean {
  return readJson<{ completed?: boolean }>(KV_ONBOARDING)?.completed === true;
}

export function setOnboardingDone(completed: boolean): void {
  writeJson(KV_ONBOARDING, { completed });
}

// ── 写入 ────────────────────────────────────────────────────

/**
 * 局部更新模型设置。只覆盖传进来的字段，其余保持原样。
 * 传空字符串表示"清掉这个覆盖值"（退回 .env / 默认值），而不是"设成空字符串"。
 */
export function updateModel(patch: Partial<ModelSettings>): ModelSettings {
  const stored = readJson<ModelSettings>(KV_MODEL) ?? {};
  const next: Record<string, unknown> = { ...stored };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // 空串、以及超时那一格的 0，都是"这一项不要覆盖，回落默认"
    if (value === "" || (key === "timeoutMs" && value === 0)) {
      delete next[key];
      continue;
    }
    next[key] = value;
  }

  writeJson(KV_MODEL, next);
  return modelConfig();
}

export function updatePersona(patch: {
  character?: Partial<CharacterCard>;
  owner?: Partial<OwnerProfile>;
  recentTurns?: number;
}): PersonaSettings {
  const stored = readJson<PersonaSettings>(KV_PERSONA) ?? {};
  const next: PersonaSettings = {
    // 空对象字面量会被推成「全字段可选」，展开后类型就不再是 CharacterCard/OwnerProfile，
    // 所以回落值必须带上目标类型标注。
    character: { ...(stored.character ?? {} as CharacterCard) },
    owner: { ...(stored.owner ?? {} as OwnerProfile) },
    recentTurns: sanitizeRecentTurns(stored.recentTurns),
  };

  if (patch.recentTurns !== undefined) {
    const t = sanitizeRecentTurns(patch.recentTurns);
    if (t === 0) delete (next as Partial<PersonaSettings>).recentTurns;
    else next.recentTurns = t;
  }

  for (const [key, value] of Object.entries(patch.character ?? {})) {
    if (value === undefined) continue;
    if (value === "") delete (next.character as Record<string, unknown>)[key];
    else (next.character as Record<string, unknown>)[key] = value;
  }
  for (const [key, value] of Object.entries(patch.owner ?? {})) {
    if (value === undefined) continue;
    if (value === "") delete (next.owner as Record<string, unknown>)[key];
    else (next.owner as Record<string, unknown>)[key] = value;
  }

  writeJson(KV_PERSONA, next);
  return personaConfig();
}

/** 清空全部覆盖值，退回 .env 行为。界面上那颗"恢复默认"用它。 */
export function resetAll(): void {
  writeJson(KV_MODEL, {});
  writeJson(KV_PERSONA, {});
  // 能力回到「没有生效档」= 语音/绘图未配置、视觉与记忆提取跟随主力。
  for (const name of CAPABILITY_NAMES) kvSet(capActiveOf(name), "");
  // 注意：**不动 profiles，也不动能力端点档**。它们是用户存下来的接口收藏，
  // "恢复默认"重置的是当前生效与人设，不该把存了好几份的配置一并抹掉。
}

// ── 模型配置档（多份 OpenAI 兼容接口配置）───────────────────

function readProfiles(): ModelProfile[] {
  const raw = kvGet(KV_PROFILES);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeProfile);
  } catch {
    console.warn(`[settings] ${KV_PROFILES} 不是合法 JSON，已当作没有配置档`);
    return [];
  }
}

function writeProfiles(profiles: ModelProfile[]): void {
  writeJson(KV_PROFILES, profiles);
}

function sanitizeProfile(input: Partial<ModelProfile>): ModelProfile {
  const timeout = Number(input.timeoutMs);
  return {
    id: typeof input.id === "string" && input.id !== "" ? input.id : randomUUID(),
    label: text(input.label).slice(0, 24) || "未命名配置",
    mode: input.mode === "openai" ? "openai" : "echo",
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl.replace(/\/+$/, "") : "",
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    name: typeof input.name === "string" ? input.name : "",
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 600_000 ? timeout : 90_000,
    extraBody:
      input.extraBody && typeof input.extraBody === "object" && !Array.isArray(input.extraBody)
        ? { ...input.extraBody }
        : {},
    caps: sanitizeModelCaps(input.caps),
    thinkingLevel: sanitizeThinkingLevel(input.thinkingLevel),
    thinkingLevels: sanitizeThinkingLevels(input.thinkingLevels),
    thinkingParam: sanitizeThinkingParam(input.thinkingParam),
    thinkingMode: sanitizeThinkingMode(input.thinkingMode),
    maxInputTokens: sanitizeTokenLimit(input.maxInputTokens),
    maxOutputTokens: sanitizeTokenLimit(input.maxOutputTokens),
  };
}

export function listProfiles(): ModelProfile[] {
  return readProfiles();
}

/**
 * 保存一份配置档。带已存在的 id 就是更新，不带就是新建。
 * apiKey 的三态语义与 updateModel 一致：空串=清掉，undefined/掩码=不动，其它=新值。
 */
export function saveProfile(input: Partial<ModelProfile> & { label: string }): ModelProfile {
  const label = text(input.label);
  const profiles = readProfiles();
  const existing = typeof input.id === "string" ? profiles.find((p) => p.id === input.id) : undefined;

  // 更新时掩码/缺省的密钥沿用原档的，绝不把掩码当真密钥存进去。
  const apiKey =
    typeof input.apiKey === "string" && input.apiKey !== "" && !input.apiKey.includes("••")
      ? input.apiKey.trim()
      : (existing?.apiKey ?? "");

  const next = sanitizeProfile({
    ...(existing ?? {}),
    ...input,
    label,
    apiKey,
    id: existing?.id,
  });

  // 编辑「使用中」的档前要先记下它当时的身份：保存后字段变了，
  // 事后再比就认不出它曾经就是生效配置，选中态会被无声挤掉。
  const wasActive = existing !== undefined && activeProfileId() === existing.id;

  const index = profiles.findIndex((p) => p.id === next.id);
  if (index >= 0) profiles[index] = next;
  else profiles.push(next);
  writeProfiles(profiles);
  if (wasActive) writeActiveFromProfile(next);
  tidyProviderNames();
  return next;
}

/**
 * 删一份模型档。
 *
 * ⚠️ 必须先看有没有联系人绑在它上面：绑定是 `contacts.model_profile` 一个字符串 id，
 * 删档不会级联清理它，于是那位联系人的 `contactModelSettings()` 之后返回 null、
 * 调用落到全局 `modelConfig()`——**换成另一个模型、另一家服务商、另一份计费**，
 * 而界面上没有任何提示。助手更糟：它被特意钉在生效档上（pinAssistantToActiveProfile）
 * 就是为了"全局切坏了它还能开口帮忙回滚"，删掉那一档这个保障静默失效。
 *
 * 所以这里拒绝删除，让调用方先去解绑（界面据此提示"还有 N 位联系人在用"）。
 * 返回 false 的两种情形：档不存在、或仍被引用——调用方要靠 counts 区分。
 */
export function deleteProfile(id: string): boolean {
  const bound = db.prepare(`SELECT id, name FROM contacts WHERE model_profile = ?`).all(id) as Array<{ id: string; name: string }>;
  if (bound.length > 0) return false;
  const profiles = readProfiles();
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) return false;
  writeProfiles(next);
  tidyProviderNames();   // 这一家的最后一份档没了，组名也跟着清
  return true;
}

/** 还绑在这份档上的联系人（删档前用来给人话提示）。 */
export function contactsBoundToProfile(id: string): Array<{ id: string; name: string }> {
  return db.prepare(`SELECT id, name FROM contacts WHERE model_profile = ?`).all(id) as Array<{ id: string; name: string }>;
}

/**
 * 把一份档全覆盖拷进当前生效配置（mode/baseUrl/apiKey/name/timeoutMs/extraBody
 * 及能力字段）——「换一套」就该是完整的一套，残留旧接口的字段只会让人困惑。
 */
function writeActiveFromProfile(profile: ModelProfile): void {
  // 刻意不走 updateModel：它把空串当「清掉覆盖值」（回落 .env），
  // 而应用一份档的语义是「当前生效完整地等于这份档」——空字段就该是空，
  // 比如本地 Ollama 的档没有 apiKey，激活后不该冒出 .env 里的密钥。
  writeJson(KV_MODEL, {
    mode: profile.mode,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    name: profile.name,
    timeoutMs: profile.timeoutMs,
    extraBody: profile.extraBody,
    caps: profile.caps,
    thinkingLevel: profile.thinkingLevel,
    thinkingLevels: profile.thinkingLevels,
    thinkingParam: profile.thinkingParam,
    thinkingMode: profile.thinkingMode ?? "",
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,
  });
}

export function activateProfile(id: string): ModelSettings {
  const profile = readProfiles().find((p) => p.id === id);
  if (!profile) throw new Error("配置档不存在，可能已被删除");
  writeActiveFromProfile(profile);
  return modelConfig();
}

/** 判断当前生效配置是否就是某份档（字段级全等；表单改过任何字段就不再是"在用某档"）。 */
export function activeProfileId(): string | null {
  // 只比「连到哪儿、怎么连」的连接字段；能力元数据（caps/思考/上限）改动
  // 不改变"在用哪套接口"，不该把徽标挤掉——它要生效本来就靠再点一次「启用」。
  // extraBody 两份都出自 sanitizeProfile/sanitizeModel（展开重建），键序稳定，JSON 比较够用。
  const current = modelConfig();
  const match = readProfiles().find(
    (p) =>
      current.mode === p.mode &&
      current.baseUrl === p.baseUrl &&
      current.apiKey === p.apiKey &&
      current.name === p.name &&
      current.timeoutMs === p.timeoutMs &&
      JSON.stringify(current.extraBody) === JSON.stringify(p.extraBody),
  );
  return match?.id ?? null;
}

// ── 供应商（从配置档按接口地址派生出的一层）────────────────
//
// 没有另存一张供应商表：**同一批档里 baseUrl 相同的就是同一家**。这样联系人绑定、
// 记忆提取的档引用、用量归属的 profile_id、导出文件里那些"指着某一份档"的外键
// 一个都不用动，界面却照样能长成「一家下面挂几个模型」。
// 只有"这家叫什么"是档名给不了的（每份档的名字是它自己的模型名/用途名），
// 所以单独存一张 baseUrl → 供应商名 的表；没起过名字就用这家第一份档的名字顶上。

/** 接口地址归一化：去空白、去尾部斜杠——分组和查重要的是"同一家"，不是字符串凑巧相等。 */
function normBase(v: unknown): string {
  return typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
}

/** 去掉没有任何档在用的组名，别让这张表随删档越长越大。 */
function pruneProviderNames(names: Record<string, string>): Record<string, string> {
  // 供应商这一层是全局的：主模型档和能力端点档里出现过的地址都算"这一家还在"。
  const alive = new Set([
    ...readProfiles().map((p) => normBase(p.baseUrl)),
    ...CAPABILITY_NAMES.flatMap((name) => readCapabilityProfiles(name).map((p) => normBase(p.baseUrl))),
  ]);
  return Object.fromEntries(Object.entries(names).filter(([base]) => alive.has(base)));
}

function readProviderNames(): Record<string, string> {
  const raw = readJson<Record<string, string>>(KV_PROVIDER_NAMES) ?? {};
  return Object.fromEntries(Object.entries(raw)
    .filter((e): e is [string, string] => e[0] !== "" && typeof e[1] === "string" && e[1].trim() !== ""));
}

export function providerNames(): Record<string, string> {
  return readProviderNames();
}

/** 给一家起名；传空 = 取消命名，退回显示这家第一份档的名字。 */
export function renameProvider(baseUrl: string, label: string): void {
  const base = normBase(baseUrl);
  if (base === "") throw new Error("先有接口地址才能给供应商起名");
  const names = readProviderNames();
  const name = text(label).slice(0, 24);
  if (name === "") delete names[base];
  else names[base] = name;
  writeJson(KV_PROVIDER_NAMES, pruneProviderNames(names));
}

/** 这一家的显示名：用户起过的优先 → 这家第一份档的名字 → 主机名兜底。 */
/**
 * 这一家的显示名。`profiles` 只用来取"这家第一份档的名字"这一层兜底，
 * 所以主模型档与能力端点档都能传（两边都有 baseUrl/label）。
 */
export function providerLabel(
  baseUrl: string,
  profiles: Array<{ baseUrl: string; label: string }> = readProfiles(),
): string {
  const base = normBase(baseUrl);
  const named = readProviderNames()[base];
  if (named) return named;
  const first = profiles.find((p) => normBase(p.baseUrl) === base);
  return first?.label ?? base.replace(/^https?:\/\//, "").split("/")[0] ?? base;
}

/**
 * 改一家的接口地址/密钥 = 同步给它下面所有模型档。
 * 「连接信息挂供应商、参数挂模型」这件事就靠这一步落地：不会出现同一家两个模型
 * 各自记着不同密钥、只有一个能用那种局面。
 */
export function syncProviderConnection(fromBaseUrl: string, toBaseUrl: string, apiKey: string): number {
  const from = normBase(fromBaseUrl);
  const to = normBase(toBaseUrl);
  if (from === "" || to === "") throw new Error("接口地址不能为空");
  const key = apiKey.trim();
  if (key.includes("••")) throw new Error("密钥那一栏还是掩码，填真实密钥再保存");
  const profiles = readProfiles();
  const touched: ModelProfile[] = [];
  for (const p of profiles) {
    if (normBase(p.baseUrl) !== from) continue;
    p.baseUrl = to;
    if (key !== "") p.apiKey = key;
    touched.push(p);
  }
  if (touched.length === 0) throw new Error("这一家还没有任何模型档");
  // 正在用的就是这家的档时，当前生效配置跟着搬——否则界面显示新地址、跑的还是旧端点
  const activeId = activeProfileId();
  const activeTouched = touched.some((p) => p.id === activeId);
  writeProfiles(profiles);
  if (from !== to) {
    const names = readProviderNames();
    const moved = names[from];
    delete names[from];
    if (moved) names[to] = moved;
    writeJson(KV_PROVIDER_NAMES, pruneProviderNames(names));
  }
  if (activeTouched) updateModel({ baseUrl: to, ...(key !== "" ? { apiKey: key } : {}) });
  return touched.length;
}

/** 删档/改档之后收一次组名表。 */
function tidyProviderNames(): void {
  const names = readProviderNames();
  const pruned = pruneProviderNames(names);
  if (Object.keys(pruned).length !== Object.keys(names).length) writeJson(KV_PROVIDER_NAMES, pruned);
}
// ── 能力端点档（每张卡自己存一组「一家供应商 × 一个模型」）──────
//
// 四张卡同构：一份份档存着「打哪个端点、用什么密钥、要哪个模型名」，其中一份生效。
// 记忆提取与整理是例外——它的候选就是「主对话模型」那批档（见 MAIN_LINKED_CAPABILITIES）。

/**
 * 这几张卡不自己存端点档，只从主模型档里点一份。
 *
 * 抽记忆是纯文本活，通常的做法是同一家下面再挂一个便宜模型，而那批档本来就存在
 * 「主对话模型」里；再存一份地址+密钥就是第二个真相源，而且删掉主模型那份档之后，
 * 这边还会留着一条指向旧地址的私有档。所以这张卡存的**是主模型档的 id**，
 * 地址、密钥、模型名全部现读那一份。
 */
export const MAIN_LINKED_CAPABILITIES: CapabilityName[] = ["memoryExtract"];

export const mainLinked = (name: CapabilityName): boolean => MAIN_LINKED_CAPABILITIES.includes(name);

const KV_CAP_PREFIX = "settings.capability.";

function capKeyOf(name: CapabilityName): string {
  return `${KV_CAP_PREFIX}${name}.profiles`;
}

function capActiveOf(name: CapabilityName): string {
  return `${KV_CAP_PREFIX}${name}.active`;
}

function sanitizeCapabilityProfile(input: CapabilityProfileInput): CapabilityProfile {
  const timeout = Number(input.timeoutMs);
  return {
    id: typeof input.id === "string" && input.id !== "" ? input.id : randomUUID(),
    label: text(input.label).slice(0, 24) || "未命名端点",
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl.replace(/\/+$/, "") : "",
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    name: typeof input.name === "string" ? input.name.trim() : "",
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 600_000 ? timeout : 90_000,
    voice: typeof input.voice === "string" ? input.voice.trim().slice(0, 60) : "",
  };
}

function readCapabilityProfiles(name: CapabilityName): CapabilityProfile[] {
  const raw = kvGet(capKeyOf(name));
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object" && !Array.isArray(p))
      .map(sanitizeCapabilityProfile);
  } catch {
    console.warn(`[settings] ${capKeyOf(name)} 不是合法 JSON，已当作没有端点档`);
    return [];
  }
}

/** 这张卡能挑的档：自己存的端点档，或（记忆提取）主模型那批档现读一份。 */
function capProfilesOf(name: CapabilityName): CapabilityProfile[] {
  if (!mainLinked(name)) return readCapabilityProfiles(name);
  return listProfiles().map((p) => ({
    id: p.id, label: p.label, baseUrl: p.baseUrl, apiKey: p.apiKey,
    name: p.name, timeoutMs: p.timeoutMs, voice: "",
  }));
}

/** 这份卡上「在用的那一档」的 id；"" = 没有生效档，跟随主模型。 */
export function capabilityActiveId(name: CapabilityName): string {
  return kvGet(capActiveOf(name)) ?? "";
}

/** 当前生效的那一份；没启用、或启用的那份已被删掉 → null（= 跟随主模型）。 */
export function capabilityProfile(name: CapabilityName): CapabilityProfile | null {
  const id = capabilityActiveId(name);
  if (id === "") return null;
  return capProfilesOf(name).find((p) => p.id === id) ?? null;
}

export function listCapabilityProfiles(
  name: CapabilityName,
): Array<CapabilityProfile & { active: boolean }> {
  const activeId = capabilityActiveId(name);
  return capProfilesOf(name).map((p) => ({ ...p, active: p.id === activeId }));
}

/** 主模型档不是能力档：那张卡上不接受写端点档，界面上也不给这两个入口。 */
function assertOwnsProfiles(name: CapabilityName): void {
  if (mainLinked(name)) {
    throw new Error("这张卡的候选来自「主对话模型」，要加或删模型请到那一页去");
  }
}

/**
 * 保存一份端点档：带已存在的 id 就是更新，不带就是新建。
 * 密钥三态与主模型档一致——空串=清掉，掩码或缺省=沿用原值，其它=新值。
 * 界面可能把读到的旧值原样回传，绝不能把掩码当成真密钥存进去。
 */
export function saveCapabilityProfile(
  name: CapabilityName,
  input: CapabilityProfileInput,
): CapabilityProfile {
  assertOwnsProfiles(name);
  const profiles = readCapabilityProfiles(name);
  const existing = typeof input.id === "string" && input.id !== ""
    ? profiles.find((p) => p.id === input.id)
    : undefined;
  const apiKey = typeof input.apiKey === "string" && input.apiKey !== "" && !input.apiKey.includes("••")
    ? input.apiKey.trim()
    : (existing?.apiKey ?? "");
  const next = sanitizeCapabilityProfile({
    ...(existing ?? {}),
    ...input,
    label: text(input.label),
    apiKey,
    id: existing?.id,
  });
  const i = profiles.findIndex((p) => p.id === next.id);
  if (i >= 0) profiles[i] = next;
  else profiles.push(next);
  writeJson(capKeyOf(name), profiles);
  tidyProviderNames();   // 这一家的最后一份档没了，组名跟着清
  return next;
}

export function deleteCapabilityProfile(name: CapabilityName, id: string): boolean {
  assertOwnsProfiles(name);
  const profiles = readCapabilityProfiles(name);
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) return false;
  writeJson(capKeyOf(name), next);
  if (capabilityActiveId(name) === id) kvSet(capActiveOf(name), "");
  tidyProviderNames();
  return true;
}

/** 启用一份档；传空串 = 取消启用，回到跟随主模型。 */
export function activateCapabilityProfile(name: CapabilityName, id: string): void {
  const trimmed = id.trim();
  if (trimmed !== "" && !capProfilesOf(name).some((p) => p.id === trimmed)) {
    throw new Error(mainLinked(name)
      ? "「主对话模型」里没有这份档（可能刚被删掉），先去那边存一份再选"
      : "那份端点档不存在，可能已被删除");
  }
  kvSet(capActiveOf(name), trimmed);
}

/** 该能力是否被显式指定了模型（= 启用了一份端点档）。 */
export function capabilityExplicit(name: CapabilityName): boolean {
  return capabilityProfile(name) !== null;
}

/** 能力的实际生效配置：生效档 > 主模型。 */
export function capabilityConfig(name: CapabilityName): CapabilitySettings {
  const main = modelConfig();
  const bound = capabilityProfile(name);
  if (bound === null) {
    return {
      baseUrl: main.baseUrl.replace(/\/+$/, ""),
      apiKey: main.apiKey,
      model: main.name,
      timeoutMs: main.timeoutMs,
      voice: "",
    };
  }
  return {
    baseUrl: bound.baseUrl,
    apiKey: bound.apiKey,
    model: bound.name,
    timeoutMs: bound.timeoutMs,
    voice: bound.voice,
  };
}

/**
 * 能力是否可直接调用。
 * 启用了一份档就看那份齐不齐：地址、密钥、模型名少一个都打不通。
 * 没启用时跟随主模型，但只有「聊天模型本来就能干这活」的两条允许回落——
 * 记忆提取是纯文本活，图片理解要求主力档勾了「图片输入」（主模型自带视觉很常见，
 * 这里只是让你告诉应用它确实带）。语音识别/合成、图像生成要的是各自端点上的
 * 模型名，拿聊天模型名去打 /audio、/images 只会得到一个毫无意义的失败。
 */
export function capabilityReady(name: CapabilityName): boolean {
  const bound = capabilityProfile(name);
  if (bound !== null) return bound.baseUrl !== "" && bound.apiKey !== "" && bound.name !== "";
  if (!modelReadyNow()) return false;
  if (name === "memoryExtract") return true;
  return name === "imageVision" && modelConfig().caps.vision === true;
}

/** 三项能力的就绪状态，给界面上的入口按钮显隐用。 */
export function capabilitiesStatus(): Record<CapabilityName, boolean> {
  return Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [name, capabilityReady(name)]),
  ) as Record<CapabilityName, boolean>;
}

/** 校验一份端点档的输入：复用主模型那三条（地址形状 / 超时区间 / 模型名长度）。 */
export function validateCapabilityProfile(input: CapabilityProfileInput): ValidationResult {
  const errors: string[] = [];
  if (typeof input.voice === "string" && input.voice.length > 60) {
    errors.push("音色名太长（最多 60 字）");
  }
  const check = validateModel({
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : undefined,
    timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
    name: typeof input.name === "string" ? input.name : undefined,
    extraBody: undefined,
  });
  if (!check.ok) errors.push(...check.errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── 校验 ────────────────────────────────────────────────────

/** 校验结果：ok 为 false 时 errors 里是人话，前端直接展示。 */
export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateModel(patch: Partial<ModelSettings>): ValidationResult {
  const errors: string[] = [];

  if (patch.mode !== undefined && patch.mode !== "echo" && patch.mode !== "openai") {
    errors.push("mode 只能是 echo 或 openai");
  }

  if (patch.baseUrl !== undefined && patch.baseUrl !== "") {
    if (!/^https?:\/\//i.test(patch.baseUrl)) {
      errors.push("接口地址必须以 http:// 或 https:// 开头（例如 https://api.deepseek.com/v1）");
    } else {
      try {
        new URL(patch.baseUrl);
      } catch {
        errors.push("接口地址不是合法的 URL");
      }
    }
  }

  if (patch.timeoutMs !== undefined && patch.timeoutMs !== 0) {
    // 0 = 「不覆盖，回落默认」——界面上把超时框清空就是这么发的（Number("") 正好是 0），
    // 把它一起判成越界会让这一项一旦填过就永远清不掉。
    if (!Number.isInteger(patch.timeoutMs) || patch.timeoutMs < 1000 || patch.timeoutMs > 600_000) {
      errors.push("超时时间要在 1000 ~ 600000 毫秒之间");
    }
  }

  if (patch.name !== undefined && patch.name !== "" && patch.name.length > 120) {
    errors.push("模型名太长了（超过 120 字）");
  }

  if (patch.extraBody !== undefined && patch.extraBody !== null) {
    if (typeof patch.extraBody !== "object" || Array.isArray(patch.extraBody)) {
      errors.push('额外参数必须是一个 JSON 对象，例如 {"thinking": {"type": "disabled"}}');
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validatePersona(patch: {
  character?: Partial<CharacterCard>;
  owner?: Partial<OwnerProfile>;
  recentTurns?: unknown;
}): ValidationResult {
  const errors: string[] = [];
  const char = patch.character ?? {};
  const owner = patch.owner ?? {};

  if (patch.recentTurns !== undefined) {
    const v = patch.recentTurns;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 30) {
      errors.push("回放轮数只能是 0~30 的整数（0 = 跟随默认）");
    }
  }

  if (char.name !== undefined && char.name !== "" && char.name.length > 24) {
    errors.push("角色名字最多 24 个字");
  }
  if (char.identity !== undefined && char.identity.length > 10000) {
    errors.push("角色身份最多 10000 个字");
  }
  if (char.background !== undefined && char.background.length > 10000) {
    errors.push("角色背景最多 10000 个字");
  }
  if (char.relationship !== undefined && char.relationship.length > 10000) {
    errors.push("与用户关系最多 10000 个字");
  }
  if (owner.name !== undefined && owner.name !== "" && owner.name.length > 24) {
    errors.push("用户称呼最多 24 个字");
  }
  if (owner.impression !== undefined && owner.impression.length > 2000) {
    errors.push("用户印象最多 2000 个字");
  }
  if (owner.avatar !== undefined && owner.avatar !== "" &&
      (!/^data:image\/(png|jpe?g|webp);base64,/.test(owner.avatar) || owner.avatar.length > 150_000)) {
    errors.push("avatar 只支持 png/jpg/webp 图片（≤150KB）");
  }
  if (owner.notes !== undefined && owner.notes.length > 2000) {
    errors.push("偏好与禁忌最多 2000 个字");
  }
  if (owner.gender !== undefined && !["female", "male", "other"].includes(String(owner.gender))) {
    errors.push("用户性别只能是 female / male / other");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── 净化（挡住手改数据库塞进来的脏数据）──────────────────────

function sanitizeModel(input: ModelSettings): ModelSettings {
  const timeout = Number(input.timeoutMs);
  return {
    mode: input.mode === "openai" ? "openai" : "echo",
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl.replace(/\/+$/, "") : "",
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    name: typeof input.name === "string" ? input.name : "",
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 600_000 ? timeout : 90_000,
    extraBody:
      input.extraBody && typeof input.extraBody === "object" && !Array.isArray(input.extraBody)
        ? { ...input.extraBody }
        : {},
    startupCheck: input.startupCheck !== false,
    caps: sanitizeModelCaps(input.caps),
    thinkingLevel: sanitizeThinkingLevel(input.thinkingLevel),
    thinkingLevels: sanitizeThinkingLevels(input.thinkingLevels),
    thinkingParam: sanitizeThinkingParam(input.thinkingParam),
    thinkingMode: sanitizeThinkingMode(input.thinkingMode),
    maxInputTokens: sanitizeTokenLimit(input.maxInputTokens),
    maxOutputTokens: sanitizeTokenLimit(input.maxOutputTokens),
  };
}

/**
 * 三段人设的**总**字数上限（背景 + 人设 + 关系合起来算，不是每段各一份）。
 *
 * 为什么按总量而不是按段均摊：这三段最终是拼成同一段系统提示词喂给模型的
 * （见 persona.ts 的 buildCharacterSection），贵的是总量——每轮都要为它付一次
 * 输入 token。而按段各给一份等额的额度，会把"我只想写一段长人设"的人逼去把
 * 一篇设定拆成三段水字数，只为了把额度用满。总量表达的才是真实意图。
 *
 * 改这个值要同步三处：前端 profile/constants.ts 的 PERSONA_TOTAL_MAX、
 * server.ts 里 MAX_CARD_BODY_BYTES 的注释、以及 smoke 里钉漂移的那条断言。
 */
export const PERSONA_TOTAL_MAX = 30_000;

/**
 * 总量超预算时按这个顺序砍：排前面的先占满，后面的吃剩的。
 * 顺序与 persona.ts 拼提示词的顺序无关，只求一条能向用户解释清的规则
 * （"背景先占，然后人设，然后关系"）——砍到哪一段必须是可预期的，
 * 不能取决于对象键的遍历次序。
 */
const PERSONA_BUDGET_ORDER = ["background", "identity", "relationship"] as const;

export function sanitizeCharacter(input: CharacterCard): CharacterCard {
  const name = text(input.name).slice(0, 24) || "小茉";
  const fields = {
    background: text(input.background),
    identity: text(input.identity),
    relationship: text(input.relationship),
  };
  let left = PERSONA_TOTAL_MAX;
  for (const key of PERSONA_BUDGET_ORDER) {
    const take = Math.min(fields[key].length, left);
    fields[key] = fields[key].slice(0, take);
    left -= take;
  }
  return { name, ...fields };
}

const AVATAR_RE = /^data:image\/(png|jpe?g|webp);base64,/;

function sanitizeOwner(input: OwnerProfile): OwnerProfile {
  return {
    name: text(input.name).slice(0, 24),
    impression: text(input.impression).slice(0, 2000),
    notes: text(input.notes).slice(0, 2000),
    gender: input.gender === "female" || input.gender === "male" || input.gender === "other"
      ? input.gender : undefined,
    // 头像原样保留（写入时已校验格式与大小）；不是合法 dataURL 就丢弃
    avatar: typeof input.avatar === "string" && AVATAR_RE.test(input.avatar) && input.avatar.length <= 150_000
      ? input.avatar
      : "",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// ── 快照 ────────────────────────────────────────────────────

/**
 * 给界面看的快照。密钥回完整值：这是本机单用户应用，
 * 用户要能在编辑框里看清/复制自己设置的 key（眼睛按钮才有意义）。
 * 注意：给大模型看的提示词快照（assistant.ts）仍不带密钥，那是真正的对外边界。
 */
export function settingsSnapshot(): SettingsSnapshot {
  const model = modelConfig();
  const persona = personaConfig();
  const storedModel = readJson<ModelSettings>(KV_MODEL) ?? {};
  const storedPersona = readJson<PersonaSettings>(KV_PERSONA) ?? {};
  const activeId = activeProfileId();

  return {
    model,
    persona,
    /** .env / 内置默认的回放轮数——界面用它说明「0=跟随默认」时默认是多少。 */
    defaultRecentTurns: config.recentTurnsInContext,
    overridden: {
      model: Object.keys(storedModel),
      persona: [
        ...Object.keys(storedPersona.character ?? {}).map((k) => `character.${k}`),
        ...Object.keys(storedPersona.owner ?? {}).map((k) => `owner.${k}`),
      ],
    },
    profiles: listProfiles().map((p) => ({ ...p, active: p.id === activeId })),
    activeProfileId: activeId,
    providerNames: readProviderNames(),
    capabilities: Object.fromEntries(
      CAPABILITY_NAMES.map((name) => [name, {
        profiles: listCapabilityProfiles(name),
        activeId: capabilityActiveId(name),
        linkedToMain: mainLinked(name),
        effective: capabilityConfig(name),
      }]),
    ) as SettingsSnapshot["capabilities"],
    capabilitiesReady: capabilitiesStatus(),
    dataDir: config.dataDir,
    desktop: desktopPrefsSnapshot(),
  };
}

/** 提示词里要用的角色名（界面标题等地方也用它）。 */
export function currentCharacterName(): string {
  return personaConfig().character.name;
}
