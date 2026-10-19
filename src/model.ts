// 模型客户端：任何 OpenAI 兼容服务都行（火山方舟 / 通义 / DeepSeek / Agnes / 本地 Ollama …）。
//
// 三条纪律：
// 1) 不绑定单一供应商 —— 只依赖 /chat/completions 这个通用形状，换供应商只改环境变量。
// 2) 只回放"该回放的东西" —— 只发 system / user / assistant 三类消息，
//    绝不把模型自己的思考过程存进历史再回放（这是上下文膨胀最常见的来源）。
// 3) 失败要能自解释 —— 每个错误都被归类、翻译成人话 + 下一步建议，并落进 model_calls 表。
//    背景（本机实测）：有些服务商对"无可用渠道的模型名"**不返回错误，而是让请求挂住**直到超时，
//    前端只看到 "This operation was aborted"，毫无排查线索。所以超时必须被识别并给出提示。

import {
  activeProfileId,
  capabilityConfig,
  capabilityExplicit,
  capabilityReady,
  emptyModelCaps,
  listProfiles,
  modelConfig,
  modelReadyNow,
  type CapabilityName,
  type ModelSettings,
} from "./settings.ts";
import { contactModelProfile } from "./contacts.ts";
import { recordArtifact } from "./artifacts.ts";
import { db } from "./db.ts";
import { beginModelCall, endModelCall, logModelCall } from "./logs.ts";
import { isPrivateAddress } from "./web.ts";
import { isIP } from "node:net";
import { MAX_IMAGE_BYTES, mediaDataUrl, saveImage } from "./media.ts";

/** OpenAI 兼容的多模态内容块：文本 + dataURL 图片（服务商普遍接受 base64 data URL）。 */
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContentPart[];
  /** assistant 消息携带的工具调用请求（工具循环中间消息，不落库、不进历史）。 */
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** tool 消息对应的调用 id。 */
  tool_call_id?: string;
};

export type CallOptions = {
  maxTokens?: number;
  temperature?: number;
  /** 用途标签：chat / extract / proactive / asr / tts，用于日志与排障。 */
  purpose?: string;
  /** 关联的处理单，便于从一次失败回溯到具体那轮对话。 */
  turnId?: string | null;
  /** 走某个能力的独立模型配置（如带图的消息走视觉模型）；不传 = 主力模型。 */
  capability?: CapabilityName;
  /** 当前联系人：绑定了模型档的联系人用档配置，未绑定走全局。 */
  contactId?: string | null;
  /** 外部打断信号（barge-in）：同一联系人来了新消息时，用它 abort 还在飞行的请求。 */
  signal?: AbortSignal;
  /**
   * 思考内容出口：服务商把推理放在 `message.reasoning_content`（实测 agnes 与
   * DeepSeek 系都是这个键）。它不属于要发给用户的正文，所以不进返回值、不进上下文回放，
   * 只从这里交给调用方存起来给界面折叠看 —— 否则思考 token 照付却一个字都看不见。
   */
  onReasoning?: (text: string, reasoningTokens: number) => void;
  /**
   * 正文草稿出口：流式下每来一段就交一次**累计正文**（不是增量），调用方自己节流。
   * 传了它才会发 `stream: true` —— 抽取/主动性/ping/视觉这些"要的是结构而不是过程"的
   * 调用不传，行为与今天一字不差。界面那一侧拿它当"她正在写的这一句"，见 agent.ts 的 draftWriter。
   */
  onDelta?: (accumulated: string) => void;
};

/**
 * 把外部打断信号接到本次请求自己的控制器上：超时与打断共用一个 abort 出口。
 * 返回摘监听的函数，必须在 finally 里调——请求结束后信号对象不该再被这次请求牵着。
 */
function wireOuterSignal(controller: AbortController, options: CallOptions): () => void {
  const outer = options.signal;
  if (!outer) return () => {};
  const onAbort = (): void => controller.abort();
  if (outer.aborted) controller.abort();
  else outer.addEventListener("abort", onAbort, { once: true });
  return () => outer.removeEventListener("abort", onAbort);
}

export type ModelErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "MODEL_UNAVAILABLE"
  | "ENDPOINT_NOT_FOUND"
  | "BAD_REQUEST"
  | "CONTEXT_OVERFLOW"
  | "SERVER_ERROR"
  | "NETWORK"
  | "TIMEOUT"
  | "EMPTY_RESPONSE"
  | "UNKNOWN";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly status: number | null;
  readonly elapsedMs: number;
  readonly url: string;
  readonly model: string;
  readonly bodyExcerpt: string;
  readonly causeDetail: string;

  constructor(input: {
    code: ModelErrorCode;
    message: string;
    status?: number | null;
    elapsedMs: number;
    url: string;
    model: string;
    bodyExcerpt?: string;
    causeDetail?: string;
  }) {
    super(input.message);
    this.name = "ModelError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.elapsedMs = input.elapsedMs;
    this.url = input.url;
    this.model = input.model;
    this.bodyExcerpt = input.bodyExcerpt ?? "";
    this.causeDetail = input.causeDetail ?? "";
  }
}

// 每次调用时现算，而不是启动时算一次——用户在设置页改了地址要立刻生效。
const endpoint = (settings: ModelSettings = modelConfig()) => `${settings.baseUrl}/chat/completions`;

/** 非对话模型关键词表（唯一来源）：server /api/models、index 自检、doctor 都用它。 */
export const NON_CHAT_MODEL_WORDS = ["image", "video", "tts", "asr", "voice", "audio", "embedding", "rerank"];

/** 粗筛：把图像/视频/语音等模型排除掉，它们不能用于对话（要调各自的专用端点）。 */
export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_MODEL_WORDS.some((word) => lower.includes(word));
}

/** 联系人绑定的模型档 → 生效配置；没绑定或档已删除返回 null（回落全局，对话不该因失效绑定中断）。 */
export function contactModelSettings(contactId: string): ModelSettings | null {
  const profileId = contactModelProfile(contactId);
  if (profileId === "") return null;
  const profile = listProfiles().find((p) => p.id === profileId);
  if (!profile) return null;
  return {
    mode: profile.mode,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    name: profile.name,
    timeoutMs: profile.timeoutMs,
    extraBody: { ...profile.extraBody },
    startupCheck: false,
    caps: profile.caps,
    thinkingLevel: profile.thinkingLevel,
    thinkingLevels: profile.thinkingLevels,
    thinkingParam: profile.thinkingParam,
    thinkingMode: profile.thinkingMode ?? "",
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,
  };
}

function boundProfileSettings(options: CallOptions): ModelSettings | null {
  if (!options.contactId) return null;
  return contactModelSettings(options.contactId);
}

/**
 * 这次调用实际走哪条能力通道。
 * 「记忆抽取与整理」特殊：它不存端点档，只从主模型那批档里指一份过来，
 * 所以只有指中了一份才算显式指定——没指就维持原行为（联系人绑定档 > 全局主力），
 * 绝不悄悄改变便宜与否的语义。
 */
function effCapability(options: CallOptions): CapabilityName | undefined {
  if (!options.capability) return undefined;
  if (options.capability === "memoryExtract" && !capabilityExplicit("memoryExtract")) return undefined;
  return options.capability;
}

/** 这次调用该用哪份配置：能力自己的（视觉/语音）> 联系人绑定档 > 全局主力模型。快照语义同 modelConfig()。
 *  导出只为让冒烟能钉住"能力通道继承 token 上限"这条——它出错时界面完全看不出来。 */
export function callSettings(options: CallOptions): ModelSettings {
  const capability = effCapability(options);
  if (!capability) return boundProfileSettings(options) ?? modelConfig();
  const cap = capabilityConfig(capability);
  const main = modelConfig();
  return {
    mode: "openai",
    baseUrl: cap.baseUrl,
    apiKey: cap.apiKey,
    name: cap.model,
    timeoutMs: cap.timeoutMs,
    extraBody: {},
    startupCheck: false,
    caps: emptyModelCaps(),
    thinkingLevel: "",
    thinkingLevels: [],
    thinkingParam: "effort",
    thinkingMode: "",
    // 能力卡只有模型/地址/密钥/超时，没有 token 上限这一维（与 capabilityConfig 里
    // baseUrl/apiKey 回落主力档同一套语义），所以沿用主力档的值。
    // 从前这里硬写 0 → resolveMaxTokens 兜底成 1024，于是**那一轮只要带了图，
    // 她的回复就被截到 1024 token**，档上设的 65536 对带图对话完全不生效，
    // 而界面上看不出任何区别。
    maxInputTokens: main.maxInputTokens,
    maxOutputTokens: main.maxOutputTokens,
  };
}

function callReady(options: CallOptions, settings: ModelSettings): boolean {
  if (effCapability(options)) return capabilityReady(options.capability!);
  const bound = boundProfileSettings(options);
  if (bound) return bound.mode === "openai" && bound.apiKey !== "" && bound.baseUrl !== "";
  return modelReadyNow(settings);
}

/** 这次调用该记到谁头上：联系人 + 实际使用的模型档（绑定档 > 当前生效档；能力调用不归档）。 */
function attribution(options: CallOptions): { contactId: string | null; profileId: string | null } {
  const contactId = options.contactId ?? null;
  if (effCapability(options)) return { contactId, profileId: null };
  const bound = options.contactId ? contactModelProfile(options.contactId) : "";
  return { contactId, profileId: bound !== "" ? bound : activeProfileId() };
}

/** 模型档没填「输出上限」、调用方也没给预算时的兜底回复长度。 */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * max_tokens 的唯一算法：档上的「输出上限」是硬顶，调用方的 maxTokens 是这一用途的预算，
 * 两者取小；都没填用 1024 兜底。
 *
 * 所以聊天不传 maxTokens（让用户的设置说了算），而抽取/整理/主动消息各自传小预算
 * ——它们是"这类输出本来就该短"，不是"模型只能输出这么多"。
 * 两个请求体构造点（attempt / callModelWithTools）都必须走这里：
 * 曾经工具路径漏了硬顶，导致「输出上限」对日常聊天完全不生效。
 */
function resolveMaxTokens(settings: ModelSettings, options: CallOptions): number {
  const cap = settings.maxOutputTokens > 0 ? settings.maxOutputTokens : DEFAULT_MAX_TOKENS;
  return Math.min(options.maxTokens ?? cap, cap);
}

export async function callModel(messages: ChatMessage[], options: CallOptions = {}): Promise<string> {
  // 这里读的是运行时设置：用户可能刚在界面填好密钥，不该等到重启才认。
  const settings = callSettings(options);
  if (!callReady(options, settings)) return echo(messages, options);

  // 登记在飞：调用记录只落已完成的行，没这条登记的话十几秒里页面看不出它在干活。
  const attr = attribution(options);
  const inflightId = beginModelCall({
    purpose: options.purpose ?? "chat",
    model: settings.name,
    contactId: attr.contactId,
    turnId: options.turnId ?? null,
  });
  try {
    return await attempt(messages, options, true);
  } catch (error) {
    // 兼容重试：有些服务商不接受 max_tokens / temperature，会返回 400，
    // 且错误正文里会点到字段名。命中就去掉这两个字段重试一次。
    if (
      error instanceof ModelError &&
      error.code === "BAD_REQUEST" &&
      hasUnsupportedParam(error.bodyExcerpt)
    ) {
      console.warn("[model] 服务商不接受 max_tokens/temperature，去掉后重试一次");
      return await attempt(messages, options, false);
    }
    throw error;
  } finally {
    endModelCall(inflightId);
  }
}

/**
 * 思考参数：两个请求体构造点（无工具的 attempt、带工具的 callModelWithToolsInner）都必须走这里。
 * 聊天日常走的是**工具那条**，从前只有 attempt 带思考字段 —— 等于界面上开了也没用。
 *
 * 三种形态（语义见 settings 的 ThinkingParam）：
 * - effort：只有强度没有开关，所以仍由「思考模式」勾选决定发不发。
 * - templateKw / thinkingType：开关系，由 thinkingMode 决定。这里能表达"关"是新加的：
 *   从前模板系硬编码 `enable_thinking: true`，而火山系（`thinking:{type:"disabled"}`）连形态都没有，
 *   于是对默认开思考的模型只能听它的——勾不勾「思考模式」发出去的请求一模一样。
 * 放在 extraBody 合并之前：手工填的「额外参数」仍能覆盖它。
 */
export function applyThinkingParams(body: Record<string, unknown>, settings: ModelSettings): void {
  // 只认显式的 on/off。老档里没有 thinkingMode 这个字段（读出来是 undefined），
  // 不能顺手当成"关"——那会让所有模板系档位一夜之间不再思考。
  const mode = settings.thinkingMode === "on" || settings.thinkingMode === "off" ? settings.thinkingMode : "";
  if (settings.thinkingParam === "templateKw") {
    if (mode === "") return;
    const prev = body.chat_template_kwargs;
    body.chat_template_kwargs = {
      ...(prev && typeof prev === "object" ? prev : {}),
      enable_thinking: mode === "on",
    };
    return;
  }
  if (settings.thinkingParam === "thinkingType") {
    if (mode === "") return;
    body.thinking = { type: mode === "on" ? "enabled" : "disabled" };
    return;
  }
  if (!settings.caps.thinking) return;
  body.reasoning_effort = settings.thinkingLevel === "" ? "medium" : settings.thinkingLevel;
}

/** 服务商 usage 帧（流式在末帧带，非流式在整包里带），两边共用这一个形状。 */
type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

/**
 * 按端点记「这个地址不认 stream」，与 toolsUnsupported 同构：
 * 换地址/换模型自然绕开，改配置或重启清空，不需要界面上再加一个开关。
 */
const streamUnsupportedEndpoints = new Set<string>();

function streamUnsupportedFor(settings: ModelSettings): boolean {
  return streamUnsupportedEndpoints.has(toolsKey(settings));
}

function markStreamUnsupported(settings: ModelSettings): void {
  if (streamUnsupportedEndpoints.has(toolsKey(settings))) return;
  streamUnsupportedEndpoints.add(toolsKey(settings));
  console.warn(`[model] 端点收了 stream 字段却没回 event-stream（${settings.name}），这一档之后按整包 JSON 走（改配置或重启可清除探测）`);
}

/** 服务端是否真的回了 SSE。有些网关收了 stream 仍返回 application/json，那要按整包解析。 */
function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("event-stream");
}

/**
 * 这串 400/422 报文是不是真在说"不支持工具调用"。
 *
 * ⚠️ 不能只 `/tool|function/i`：**我们自己的请求体里就带着**
 * `"tools":[…{"type":"function"}…]`、`"tool_choice"`、`"model"`、`"messages"`。
 * 任何把请求回映进错误响应的网关（瞬时 400/422、限流页、WAF 拦截）都会命中，
 * 于是该配置在进程剩余生命周期里被永久判死——web_search / web_fetch / generate_image /
 * 联系人工具全部静默消失，只剩一句 console.warn，用户看到的是"她突然变笨了"。
 *
 * 所以要求三件事同时成立：①提到工具/函数 ②有拒绝语义 ③**不是**在回映我们的请求。
 * 第三条最管用：真在抱怨的服务商只会引用字段名，不会把整段 messages 一起带回来。
 */
function saysToolsUnsupported(body: string): boolean {
  if (!/tool|function/i.test(body)) return false;
  if (!/unsupport|not support|not enabled|not available|unrecognized|unknown param|invalid|must not|no such|not allowed|无法|不支持/i.test(body)) return false;
  const echoesOurRequest = /"messages"\s*:/.test(body) && /"tools"\s*:/.test(body) && /"model"\s*:/.test(body);
  return !echoesOurRequest;
}

/** 200 但没给 event-stream：只有当它回的是**一份完整 JSON 答卷**才算"这家不流式"。
 *  代理错误页 / CDN 缓存的 HTML 是另一回事——据此把流式永久关掉，用户会以为草稿功能坏了。 */
function answeredWithoutStream(response: Response, body: string): boolean {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("json")) return true;
  return /^\s*[[{]/.test(body) && /"choices"\s*:|"content"\s*:/.test(body);
}

/** 流式读的缓冲区上限：一行没有换行就永远留在 buf 里，得有个顶（见 readChatStream）。 */
const SSE_MAX_BUF_CHARS = 1_000_000;

/** SSE 一帧里的增量（各家键名略有出入，只认 OpenAI 兼容这几个，多余字段一律忽略）。 */
type StreamDelta = {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  tool_calls?: Array<{
    index?: unknown;
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  }>;
};

/**
 * 读 OpenAI 兼容的 SSE 响应，把帧拼成**与非流式同形**的 message/usage 再交给调用方。
 * 这样判空、思考回调、日志、返回值全走同一段代码，两条路不会各自漂移。
 *
 * 草稿上报的闸门在这里而不是在调用方：带 tools 的那一路，一轮可能是「正文 + 工具调用」，
 * 那轮的正文不是最终回复（它只进 messages 给模型接着看，不落气泡）。把它接走，界面会演一遍
 * 「她写了半句又清空」——IM 里这叫撤回复，不叫打字。所以：
 * - 一出现 tool_calls 增量，这一轮的正文就再也不接走（sawToolCallDelta）；
 * - 但正文总是先到、工具调用后到，光看顺序挡不住，于是前面 `holdMs` 毫秒先攒不发：
 *   观察窗内出现工具调用 → 这一轮一个字都不接；窗口到点还没出现 → 补发攒下的前缀，之后逐片接。
 *   代价是草稿晚 300ms 出现（对着实测的 p50 9.6s / p90 56.7s 等待，这点 delay 买的是不闪烁）。
 * holdMs=0 就是关掉观察窗，用于不带 tools 的那一路——那一轮必然产出正文，没什么可观察的。
 */
async function readChatStream(
  response: Response,
  onContent: ((accumulated: string) => void) | undefined,
  holdMs: number,
): Promise<{ content: string; reasoning: string; toolCalls: Array<{ id: string; name: string; args: string }> | null; usage: ChatUsage | null; raw: string }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("流式响应没有可读的响应体");
  const decoder = new TextDecoder();
  const rawParts: string[] = [];
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage: ChatUsage | null = null;
  let sawToolCallDelta = false;
  let holding = holdMs > 0;
  let holdFrom = 0;

  const handleFrame = (payload: string): void => {
    let frame: { choices?: Array<{ delta?: StreamDelta }>; usage?: ChatUsage };
    try {
      frame = JSON.parse(payload);
    } catch {
      return; // 心跳/半帧：跳过，不能因为一帧读不懂就把她这一轮打死
    }
    if (frame.usage) usage = frame.usage;
    const delta = frame.choices?.[0]?.delta;
    if (!delta) return;
    const rc = delta.reasoning_content ?? delta.reasoning;
    if (typeof rc === "string" && rc !== "") reasoning += rc;
    if (Array.isArray(delta.tool_calls)) {
      sawToolCallDelta = true;
      delta.tool_calls.forEach((tc, position) => {
        const index = Number(tc.index ?? position);
        const slot = calls.get(index) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string" && tc.id !== "") slot.id = tc.id;
        const fn = tc.function;
        // name 按 OpenAI 兼容协议只随第一片到达（后续片只带 arguments 的片段），所以这里"空才赋"而不是追加。
        // 有些网关会把 name 在每一片里都重复带上，追加就变成把名字拼两遍。
        if (typeof fn?.name === "string" && fn.name !== "" && slot.name === "") slot.name = fn.name;
        if (typeof fn?.arguments === "string") slot.args += fn.arguments;
        calls.set(index, slot);
      });
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      content += delta.content;
      if (holding && holdFrom === 0) holdFrom = Date.now();
      if (!sawToolCallDelta && !holding) onContent?.(content);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    rawParts.push(text);
    buf += text;
    // 一行没有换行就永远留在 buf 里：不给个顶，一个不发换行的上游（或一次畸形的分块）
    // 能让它长到吃掉整个响应。超了就整块丢掉并告警——真出现这种情况时流式本来也已经不可信了，
    // 但至少不会把内存吃穿。单帧 JSON 正常也就几十 KB，1MB 是留了充分余量的。
    if (buf.length > SSE_MAX_BUF_CHARS) {
      console.warn(`[model] 流式缓冲区超过 ${SSE_MAX_BUF_CHARS} 字仍无换行，丢弃这一块（上游可能没在发 SSE）`);
      buf = "";
    }
    // 逐行扫：只有 data: 行有意义（event:/id:/注释/空行都跳过）。最后一行可能被切断，留下块。
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    // SSE 规范：同一个事件里连续的多个 data: 行要用 "\n" 接起来才是完整 payload。
    // 从前只认最后一行，前面几行被丢掉——一个把一帧 JSON 拆成多行 data: 发的服务商
    // （规范允许，pretty-print 的网关真会这么干）会让 JSON.parse 失败，
    // 而 handleFrame 的 catch 是静默 return：那一帧的正文/工具调用/usage 就无声无息地没了。
    let pending = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") {
        // 空行 = 事件边界，把攒下的 data 行交出去
        if (pending !== "") { handleFrame(pending); pending = ""; }
        continue;
      }
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      pending = pending === "" ? payload : `${pending}\n${payload}`;
    }
    if (pending !== "") handleFrame(pending);
    // 观察窗到点（在分块边界上判，不为它单开定时器）：这一轮没出现工具调用，
    // 就把攒下的前缀一次接出去，之后逐片接。
    if (holding && holdFrom !== 0 && Date.now() - holdFrom >= holdMs) {
      holding = false;
      if (!sawToolCallDelta && content !== "") onContent?.(content);
    }
  }
  // 收尾：残帧里可能还压着一条没有换行的 data: 行，补扫一次，别丢她最后那几个字。
  const tail = buf.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload !== "" && payload !== "[DONE]") handleFrame(payload);
  }
  // 调用方的上报是节流的，收流后补一拍，让草稿与定稿在这一刻一致（否则界面少尾巴一截）。
  if (content !== "" && !sawToolCallDelta) onContent?.(content);

  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id !== "" ? call.id : `call_${index}`,
      name: call.name,
      args: call.args !== "" ? call.args : "{}",
    }))
    .filter((call) => call.name !== "");
  return {
    content,
    reasoning,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    usage,
    raw: rawParts.join(""),
  };
}

async function attempt(
  messages: ChatMessage[],
  options: CallOptions,
  includeOptionalParams: boolean,
): Promise<string> {
  // 一次性快照：同一次请求内的超时、模型名、密钥必须来自同一份配置，
  // 否则用户在请求飞行中改了设置，会出现"用 A 的超时去打 B 的地址"这种诡异现象。
  const settings = callSettings(options);
  const url = endpoint(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const unwire = wireOuterSignal(controller, options);
  const started = Date.now();
  const purpose = options.purpose ?? "chat";
  const attr = attribution(options);
  // 只有要草稿的调用才问服务商要流：抽取/主动性/ping/视觉不传 onDelta，一个字段都不多发。
  const streaming = options.onDelta !== undefined && !streamUnsupportedFor(settings);

  const body: Record<string, unknown> = {
    model: settings.name,
    messages,
    max_tokens: resolveMaxTokens(settings, options),
    temperature: options.temperature ?? 0.8,
    // 不带 stream_options：实测本机这两家（gemai 网关 / Agnes）流式里默认就带 usage，
    // 而这个字段有些自建网关会当非法参数拒掉。真的遇到"流式里没有 usage"的服务商，
    // 代价只是那一行 token 三列为 NULL，再加这个字段才是有依据的做法。
    ...(streaming ? { stream: true } : {}),
  };
  // 勾了「支持思考」就发，强度为空时给默认 medium。
  // 从前这里要求 thinkingLevel 非空，而界面上那个勾选并不会替你填强度 —— 于是"开了思考"
  // 实测什么字段都不发（勾了没反应，比不给勾更难排查）。
  applyThinkingParams(body, settings);
  if (!includeOptionalParams) {
    delete body.max_tokens;
    delete body.temperature;
  }
  Object.assign(body, settings.extraBody);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
        ...(streaming ? { accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // 只有服务端真给了 event-stream 才走流式那一支。
    // 这一支的请求体里没有 tools，所以这一轮必然产出正文，草稿不用等观察窗（holdMs=0）。
    const streamed = streaming && response.ok && isEventStream(response)
      ? await readChatStream(response, options.onDelta, 0)
      : null;
    const elapsedMs = Date.now() - started;
    const text = streamed ? streamed.raw : await response.text();
    if (streaming && !streamed && response.ok && answeredWithoutStream(response, text)) markStreamUnsupported(settings);

    if (!response.ok) {
      const error = buildHttpError(response.status, text, elapsedMs, url, settings.name);
      logModelCall({
        turnId: options.turnId,
        purpose,
        ok: false,
        code: error.code,
        status: response.status,
        model: settings.name,
        url,
        elapsedMs,
        message: error.message,
        detail: text.slice(0, 800),
        resFull: text,
        requestBody: body,
        contactId: attr.contactId,
        profileId: attr.profileId,
      });
      throw error;
    }

    let parsed: {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>;
      usage?: ChatUsage;
    };
    try {
      parsed = streamed
        ? {
            choices: [{
              message: {
                content: streamed.content,
                ...(streamed.reasoning !== "" ? { reasoning_content: streamed.reasoning } : {}),
              },
            }],
            usage: streamed.usage ?? undefined,
          }
        : (JSON.parse(text) as typeof parsed);
    } catch {
      const error = new ModelError({
        code: "UNKNOWN",
        message: `模型返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 120)}`,
        status: response.status,
        elapsedMs,
        url,
        model: settings.name,
        bodyExcerpt: text.slice(0, 300),
      });
      logModelCall({ turnId: options.turnId, purpose, ok: false, code: error.code, status: response.status, model: settings.name, url, elapsedMs, message: error.message, detail: text.slice(0, 500), resFull: text, requestBody: body, contactId: attr.contactId, profileId: attr.profileId });
      throw error;
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      const error = new ModelError({
        code: "EMPTY_RESPONSE",
        message: `模型返回内容为空（HTTP ${response.status}）`,
        status: response.status,
        elapsedMs,
        url,
        model: settings.name,
        bodyExcerpt: text.slice(0, 300),
      });
      logModelCall({ turnId: options.turnId, purpose, ok: false, code: error.code, status: response.status, model: settings.name, url, elapsedMs, message: error.message, detail: text.slice(0, 500), resFull: text, requestBody: body, contactId: attr.contactId, profileId: attr.profileId });
      throw error;
    }

    // 思考内容：单独交出去，绝不混进返回值（它会进正文气泡，也会被下一轮回放读回去）。
    const msg = parsed.choices?.[0]?.message;
    const reasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content
      : typeof msg?.reasoning === "string" ? msg.reasoning : "";
    if (reasoning !== "" && options.onReasoning) {
      options.onReasoning(reasoning, Number(parsed.usage?.completion_tokens_details?.reasoning_tokens) || 0);
    }

    logModelCall({
      turnId: options.turnId,
      purpose,
      ok: true,
      status: response.status,
      model: settings.name,
      url,
      elapsedMs,
      message: `${content.length} 字${streamed ? "（流式）" : ""}`,
      // 成功的调用也留原文（截存）：状态页「查看原文」要能回看模型当时到底答了什么。
      // 流式时 resRaw 是原始 SSE 帧（排障要看帧形状），resFull 仍是拼好的正文（界面读起来和今天一样）。
      detail: content.slice(0, 800),
      resFull: content,
      resRaw: text,
      requestBody: body,
      promptTokens: parsed.usage?.prompt_tokens ?? null,
      completionTokens: parsed.usage?.completion_tokens ?? null,
      totalTokens: parsed.usage?.total_tokens ?? null,
      contactId: attr.contactId,
      profileId: attr.profileId,
    });
    console.log(`[model] ${purpose} ok ${elapsedMs}ms（${settings.name}${streamed ? "，流式" : ""}）`);
    return content.trim();
  } catch (error) {
    if (error instanceof ModelError) throw error;

    const elapsedMs = Date.now() - started;
    const causeDetail = causeChain(error);
    const aborted = isAbort(error);
    const timedOut = aborted && elapsedMs >= settings.timeoutMs - 500;
    const code: ModelErrorCode = aborted
      ? "TIMEOUT"
      : looksLikeNetworkError(error)
        ? "NETWORK"
        : "UNKNOWN";

    const modelError = new ModelError({
      code,
      message: timedOut
        ? `请求超时（${elapsedMs}ms，上限 ${settings.timeoutMs}ms）`
        : aborted
          ? `请求被中断（${elapsedMs}ms）`
          : `请求失败：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs,
      url,
      model: settings.name,
      causeDetail,
    });
    logModelCall({
      turnId: options.turnId,
      purpose,
      ok: false,
      code,
      model: settings.name,
      url,
      elapsedMs,
      message: modelError.message,
      detail: causeDetail,
      requestBody: body,
      contactId: attr.contactId,
      profileId: attr.profileId,
    });
    throw modelError;
  } finally {
    clearTimeout(timer);
    unwire();
  }
}

/** 带工具的响应：content 可能为空，工具调用请求在 toolCalls 里。 */
export type ToolCallResponse = {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: string }> | null;
};

/** 服务商那一侧带工具的报文形状：非流式把整包 JSON.parse 成它，流式把帧拼成它。 */
type ToolsResponseBody = {
  choices?: Array<{ message?: {
    content?: unknown; reasoning_content?: unknown; reasoning?: unknown;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  } }>;
  usage?: ChatUsage;
};

/**
 * 工具调用版请求（agent 循环用）。
 *
 * 与 attempt 的差别：请求带 tools 声明，返回完整 message（content + tool_calls）
 * 而不是纯文本——agent 循环需要把 assistant 的工具调用请求和工具结果继续回传。
 *
 * 降级约定：服务商不支持 tools（通常 400/422 且正文提到 tools/functions）时抛
 * ModelError(BAD_REQUEST)，由 agent 循环捕获后回落为无工具的单次调用，并记住结果
 * 避免每轮对话都多撞一次。
 */
// 按「接口地址+模型名」键控：端点 A 不支持 tools 不该连累端点 B，
// 改配置（换地址/换模型）也自然绕开旧探测结果，不需要重启才能恢复。
const toolsUnsupportedEndpoints = new Set<string>();

const toolsKey = (settings: ModelSettings) => `${settings.baseUrl}|${settings.name}`;

/** 该配置对应的端点是否已知不支持 function calling。 */
export function toolsUnsupportedFor(settings: ModelSettings): boolean {
  return toolsUnsupportedEndpoints.has(toolsKey(settings));
}

/**
 * 配置变更后清空探测缓存（下一次调用重新试错）。
 * 流式探测与它同批清：两者键的都是「同一个 baseUrl + 同一个模型名」，
 * 换档/改地址后拿旧的结论去决定要不要发 stream，等于让一次瞬时故障永久生效。
 */
export function resetToolsUnsupported(): void {
  toolsUnsupportedEndpoints.clear();
  streamUnsupportedEndpoints.clear();
}

export async function callModelWithTools(
  messages: ChatMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  options: CallOptions = {},
): Promise<ToolCallResponse> {
  const settings = callSettings(options);
  if (!callReady(options, settings)) {
    // echo 模式没有工具可言，直接给文本回复（与 callModel 的 echo 行为一致）。
    return { content: await echo(messages, options), toolCalls: null };
  }
  // 与 callModel 同一套在飞登记：工具路径往往是聊天主路径，最需要「正在进行中」这一行。
  const attr = attribution(options);
  const inflightId = beginModelCall({
    purpose: options.purpose ?? "chat",
    model: settings.name,
    contactId: attr.contactId,
    turnId: options.turnId ?? null,
  });
  try {
    return await callModelWithToolsInner(messages, tools, options);
  } finally {
    endModelCall(inflightId);
  }
}

async function callModelWithToolsInner(
  messages: ChatMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  options: CallOptions,
): Promise<ToolCallResponse> {
  const settings = callSettings(options);
  if (toolsUnsupportedFor(settings)) {
    // 已知该端点不支持 tools：直接走无工具路径（上层已包含同样消息，少撞一次 400）。
    return { content: await attempt(messages, options, true), toolCalls: null };
  }

  const url = endpoint(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const unwire = wireOuterSignal(controller, options);
  const started = Date.now();
  const purpose = options.purpose ?? "chat";
  const attr = attribution(options);
  const streaming = options.onDelta !== undefined && !streamUnsupportedFor(settings);

  const body: Record<string, unknown> = {
    model: settings.name,
    messages,
    tools,
    tool_choice: "auto",
    max_tokens: resolveMaxTokens(settings, options),
    temperature: options.temperature ?? 0.8,
    ...(streaming ? { stream: true } : {}),
  };
  applyThinkingParams(body, settings);
  Object.assign(body, settings.extraBody);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
        ...(streaming ? { accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // 与 attempt 同一套：帧先拼成与非流式同形的报文，工具调用聚合与日志都只有一份代码。
    // 这一支带 tools，一轮可能是"正文 + 工具调用"，所以给草稿 300ms 观察窗（见 readChatStream）。
    const streamed = streaming && response.ok && isEventStream(response)
      ? await readChatStream(response, options.onDelta, 300)
      : null;
    const elapsedMs = Date.now() - started;
    const text = streamed ? streamed.raw : await response.text();
    if (streaming && !streamed && response.ok && answeredWithoutStream(response, text)) markStreamUnsupported(settings);

    if (!response.ok) {
      const error = buildHttpError(response.status, text, elapsedMs, url, settings.name);
      // 端点不支持 function calling：按端点记标记，让该配置之后的调用直接回落。
      // 判据见 saysToolsUnsupported——从前只 /tool|function/i，回映请求的网关会把配置永久判死。
      // 超长报错也可能顺带提到 "function"，不能因此把端点永久判死——所以先排除它。
      if ((response.status === 400 || response.status === 422) && error.code !== "CONTEXT_OVERFLOW" && saysToolsUnsupported(text)) {
        toolsUnsupportedEndpoints.add(toolsKey(settings));
        console.warn(`[model] 端点不支持工具调用（${settings.name}），已对该配置降级为无工具模式（改配置或重启可清除探测）`);
      }
      logModelCall({ turnId: options.turnId, purpose, ok: false, code: error.code, status: response.status, model: settings.name, url, elapsedMs, message: error.message, detail: text.slice(0, 500), resFull: text, requestBody: body, contactId: attr.contactId, profileId: attr.profileId });
      throw error;
    }

    const parsed: ToolsResponseBody = streamed
      ? {
          choices: [{
            message: {
              content: streamed.content,
              ...(streamed.reasoning !== "" ? { reasoning_content: streamed.reasoning } : {}),
              ...(streamed.toolCalls
                ? { tool_calls: streamed.toolCalls.map((call) => ({ id: call.id, function: { name: call.name, arguments: call.args } })) }
                : {}),
            },
          }],
          usage: streamed.usage ?? undefined,
        }
      : (JSON.parse(text) as ToolsResponseBody);
    const message = parsed.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    // 同 attempt：思考内容单独交给调用方，不进正文、不进回放。
    const toolReasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content
      : typeof message?.reasoning === "string" ? message.reasoning : "";
    if (toolReasoning !== "" && options.onReasoning) {
      options.onReasoning(toolReasoning, Number(parsed.usage?.completion_tokens_details?.reasoning_tokens) || 0);
    }
    const toolCalls = (message?.tool_calls ?? [])
      .map((call, index) => ({
        id: String(call.id ?? `call_${index}`),
        name: String(call.function?.name ?? ""),
        args: String(call.function?.arguments ?? "{}"),
      }))
      .filter((call) => call.name !== "");

    logModelCall({
      turnId: options.turnId,
      purpose,
      ok: true,
      status: response.status,
      model: settings.name,
      url,
      elapsedMs,
      message: toolCalls.length > 0 ? `${toolCalls.length} 个工具调用` : `${content.length} 字${streamed ? "（流式）" : ""}`,
      // 工具轮没有正文时把调用清单存进原文，状态页同样可回看。
      detail: (content !== "" ? content : toolCalls.map((c) => `${c.name}(${c.args})`).join("\n")).slice(0, 800),
      resFull: content !== "" ? content : toolCalls.map((c) => `${c.name}(${c.args})`).join("\n"),
      resRaw: text,
      requestBody: body,
      promptTokens: parsed.usage?.prompt_tokens ?? null,
      completionTokens: parsed.usage?.completion_tokens ?? null,
      totalTokens: parsed.usage?.total_tokens ?? null,
      contactId: attr.contactId,
      profileId: attr.profileId,
    });
    console.log(`[model] ${purpose} ok ${elapsedMs}ms（${settings.name}${toolCalls.length ? `，${toolCalls.length} 个工具调用` : ""}）`);
    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : null };
  } catch (error) {
    if (error instanceof ModelError) throw error;
    const elapsedMs = Date.now() - started;
    const modelError = new ModelError({
      code: isAbort(error) ? "TIMEOUT" : looksLikeNetworkError(error) ? "NETWORK" : "UNKNOWN",
      message: `工具调用请求失败：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs,
      url,
      model: settings.name,
    });
    logModelCall({ turnId: options.turnId, purpose, ok: false, cancelled: isAbort(error), code: modelError.code, model: settings.name, url, elapsedMs, message: modelError.message, requestBody: body, contactId: attr.contactId, profileId: attr.profileId });
    throw modelError;
  } finally {
    clearTimeout(timer);
    unwire();
  }
}

/**
 * 服务商报「上下文超长」的说法五花八门（OpenAI 用 error.code，各家中文服务用自然语言），
 * 只能按关键词认。认出来的价值在于它是唯一能靠"少带几轮历史"自救的 400——
 * 混在 BAD_REQUEST 里就只能把原始报错甩给用户看。
 */
const CONTEXT_OVERFLOW_WORDS = [
  "context_length_exceeded",
  "maximum context length",
  "context length",
  "context window",
  "too many tokens",
  "prompt is too long",
  "reduce the length",
  "exceeds the maximum",
  "input length",
  "上下文",
  "超出长度",
];

function isContextOverflow(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTEXT_OVERFLOW_WORDS.some((word) => lower.includes(word));
}

function buildHttpError(status: number, text: string, elapsedMs: number, url: string, model: string): ModelError {
  const lower = text.toLowerCase();
  let code: ModelErrorCode = "UNKNOWN";
  if (status === 401 || status === 403) code = "AUTH";
  else if (status === 404) code = "ENDPOINT_NOT_FOUND";
  else if (status === 429) code = "RATE_LIMIT";
  else if (status === 400 || status === 422) code = "BAD_REQUEST";
  else if (status === 503) code = "MODEL_UNAVAILABLE";
  else if (status >= 500) code = "SERVER_ERROR";

  if (
    lower.includes("无可用渠道") ||
    lower.includes("no available channel") ||
    lower.includes("model_not_found") ||
    lower.includes("model not found")
  ) {
    code = "MODEL_UNAVAILABLE";
  }
  if (lower.includes("是 image 模型") || lower.includes("是 video 模型")) {
    code = "MODEL_UNAVAILABLE";
  }
  // 超长判定放在最后：它比"参数被拒绝"更具体，也更能给出可执行的下一步。
  if ((status === 400 || status === 422) && isContextOverflow(text)) code = "CONTEXT_OVERFLOW";

  const detail = extractErrorMessage(text);
  return new ModelError({
    code,
    message: `模型返回 ${status}：${detail || text.slice(0, 120)}`,
    status,
    elapsedMs,
    url,
    model,
    bodyExcerpt: text.slice(0, 500),
  });
}

function extractErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string") return message.slice(0, 200);
  } catch {
    // 非 JSON，用原文
  }
  return "";
}

function hasUnsupportedParam(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    (lower.includes("max_tokens") || lower.includes("temperature")) &&
    (lower.includes("not supported") ||
      lower.includes("unsupported") ||
      lower.includes("unknown") ||
      lower.includes("invalid") ||
      lower.includes("不支持的") ||
      lower.includes("不支持"))
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}

function looksLikeNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|certificate|SSL/i.test(
    `${error.message} ${causeChain(error)}`,
  );
}

function causeChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 5) {
    const record = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof record.code === "string") parts.push(`code=${record.code}`);
    if (typeof record.message === "string") parts.push(record.message);
    current = record.cause;
    depth += 1;
  }
  return [...new Set(parts)].join(" | ").slice(0, 500);
}

/** 把错误翻译成人话 + 下一步该做什么。前端直接展示这段。 */
export function friendlyModelError(error: unknown, turnId?: string | null): string {
  const retryHint = turnId ? "这条可以点下面的「重试」再发一次。" : "";
  if (!(error instanceof ModelError)) {
    return `发送失败：${error instanceof Error ? error.message : String(error)}`;
  }
  switch (error.code) {
    case "TIMEOUT":
      return `请求超时（等了 ${(error.elapsedMs / 1000).toFixed(0)} 秒）。最常见的原因是模型名「${error.model}」在这家没有可用渠道——有的服务商会让请求一直挂着而不报错。到「设置 → 主模型接入」编辑这套配置，点模型名旁的「从接口拉取」换一个真实存在的名字。${retryHint}`;
    case "AUTH":
      return `鉴权失败（HTTP ${error.status}）：API Key 无效或额度用尽。到「设置 → 主模型接入」编辑这套配置核对密钥；额度去服务商控制台看。`;
    case "RATE_LIMIT":
      return `被限流（HTTP 429）：${error.bodyExcerpt.slice(0, 100)} 稍后重试，或换一个额度更宽松的模型。${retryHint}`;
    case "MODEL_UNAVAILABLE":
      return `模型「${error.model}」在这家不可用：${error.bodyExcerpt.slice(0, 100)} 到「设置 → 主模型接入」编辑这套配置，点「从接口拉取」改用列表里存在的名字。${retryHint}`;
    case "ENDPOINT_NOT_FOUND":
      return `接口地址不对（HTTP 404）：${error.url} 到「设置 → 主模型接入」编辑这套配置的接口地址（很多服务要带 /v1 前缀）。`;
    case "BAD_REQUEST":
      return `请求参数被拒绝（HTTP 400）：${error.bodyExcerpt.slice(0, 120)}`;
    case "CONTEXT_OVERFLOW":
      return `这轮要发的内容超出了模型「${error.model}」的上下文窗口，少带几轮历史后仍然装不下。到「设置 → 主模型接入」把这档的「输入上限」填准（留空时按 32K 保守估算），或调小「回放轮数」、换更大窗口的模型。${retryHint}`;
    case "NETWORK":
      return `网络不通：${error.causeDetail || error.message} 国内直连部分海外服务会超时。到「设置 → 主模型接入」换一家国内可访问的服务商，或把接口地址指向你自己的代理。`;
    case "EMPTY_RESPONSE":
      return `模型返回空内容（HTTP ${error.status}）：可能被内容策略拦了，换个说法再试。${retryHint}`;
    default:
      return `发送失败：${error.message}`;
  }
}

/**
 * 拉取可用模型列表（doctor / 启动自检 / 设置页的"读取模型列表"共用）。
 *
 * override 用来支持一个关键体验：**用户在设置页填了地址和密钥、还没点保存，就能先试连一次**。
 * 没有它的话，用户得先存一份错的配置才能试，试错成本很高。
 */
export async function listModels(
  timeoutMs = 10_000,
  override?: Partial<ModelSettings>,
): Promise<{ ok: true; ids: string[]; elapsedMs: number } | { ok: false; error: ModelError }> {
  const settings = { ...modelConfig(), ...(override ?? {}) };
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: controller.signal,
    });
    const text = await response.text();
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, error: buildHttpError(response.status, text, elapsedMs, url, settings.name) };
    }
    const parsed = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
    const ids = (parsed.data ?? [])
      .map((item) => (typeof item.id === "string" ? item.id : ""))
      .filter((id) => id !== "");
    return { ok: true, ids, elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    return {
      ok: false,
      error: new ModelError({
        code: isAbort(error) ? "TIMEOUT" : looksLikeNetworkError(error) ? "NETWORK" : "UNKNOWN",
        message: `拉取模型列表失败：${error instanceof Error ? error.message : String(error)}`,
        elapsedMs,
        url,
        model: settings.name,
        causeDetail: causeChain(error),
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用指定模型真打一次最小请求，返回结构化结果（不抛错，供 doctor / 自检 / 设置页"测试连接"展示）。
 *
 * override 的意义：让用户在设置页**填完还没保存**就能先试连，
 * 试通了再点保存。否则每次试错都要先存一份可能错的配置。
 */
export async function pingChat(
  model?: string,
  timeoutMs = 25_000,
  override?: Partial<ModelSettings>,
): Promise<{ ok: true; text: string; elapsedMs: number } | { ok: false; error: ModelError }> {
  const settings = { ...modelConfig(), ...(override ?? {}) };
  const target = model && model !== "" ? model : settings.name;
  const url = endpoint(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: target,
        max_tokens: 16,
        messages: [{ role: "user", content: "只回复：好" }],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, error: buildHttpError(response.status, text, elapsedMs, url, target) };
    }
    const content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return {
        ok: false,
        error: new ModelError({
          code: "EMPTY_RESPONSE",
          message: "返回内容为空",
          elapsedMs,
          url,
          model: target,
          bodyExcerpt: text.slice(0, 200),
        }),
      };
    }
    return { ok: true, text: content.trim(), elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const aborted = isAbort(error);
    return {
      ok: false,
      error: new ModelError({
        code: aborted ? "TIMEOUT" : looksLikeNetworkError(error) ? "NETWORK" : "UNKNOWN",
        message: aborted
          ? `挂住直到超时（${elapsedMs}ms）——模型名「${target}」很可能没有可用渠道`
          : `请求失败：${error instanceof Error ? error.message : String(error)}`,
        elapsedMs,
        url,
        model: target,
        causeDetail: causeChain(error),
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 让模型返回结构化 JSON 的小工具。失败一律抛错，由调用方决定怎么记录。 */
export async function callModelJson<T>(
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<T> {
  const raw = await callModel(messages, { ...options, temperature: options.temperature ?? 0.2 });
  const text = stripCodeFence(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    const settings = modelConfig();
    throw new ModelError({
      code: "UNKNOWN",
      message: `模型没有返回合法 JSON：${text.slice(0, 120)}`,
      elapsedMs: 0,
      url: endpoint(settings),
      model: settings.name,
      bodyExcerpt: text.slice(0, 300),
    });
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const firstBrace = body.indexOf("{");
  const firstBracket = body.indexOf("[");
  const start = [firstBrace, firstBracket].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return body;
  const lastBrace = body.lastIndexOf("}");
  const lastBracket = body.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  return end > start ? body.slice(start, end + 1) : body;
}

/**
 * 把 dataURL 拆成 mime + 二进制；形状不对直接 undefined，由调用方给成人话错误。
 *
 * ⚠️ mime 与 `;base64` 之间**还可能有别的参数**，别写成 `([^;,]+)(?:;base64)?`：
 * 浏览器 `MediaRecorder` 的 mimeType 就是 `audio/webm;codecs=opus`（Firefox 是
 * `audio/ogg;codecs=opus`），`FileReader.readAsDataURL` 原样带进 dataURL，
 * 于是老正则匹配不上 → transcribeAudio 对着一份**非空**录音报「录音数据为空」。
 * 正确口径：mime 取第一个分号前的部分，`base64` 只当独立参数看它在不在。
 */
function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | undefined {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  const meta = match?.[1] ?? "";
  const payload = match?.[2] ?? "";
  const params = meta.split(";");
  const mime = (params[0] ?? "").trim().toLowerCase();
  const isBase64 = params.some((p) => p.trim().toLowerCase() === "base64");
  if (mime === "" || payload === "" || !isBase64) return undefined;
  return { mime, buffer: Buffer.from(payload, "base64") };
}

const AUDIO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

/**
 * 语音识别：把录音 dataURL 转成文字。
 * 走 OpenAI 兼容的 /audio/transcriptions（multipart），浏览器 MediaRecorder
 * 产出的 webm/opus 正是 whisper 系端点普遍接受的格式。
 */
export async function transcribeAudio(dataUrl: string): Promise<string> {
  if (!capabilityReady("speechToText")) {
    throw new Error("语音识别还没配置：请到 设置 → 能力模型 → 语音识别 填好接口与模型名");
  }
  const audio = parseDataUrl(dataUrl);
  if (!audio || audio.buffer.length === 0) throw new Error("录音数据为空");
  const cap = capabilityConfig("speechToText");
  const url = `${cap.baseUrl}/audio/transcriptions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cap.timeoutMs);
  const started = Date.now();
  const form = new FormData();
  form.append("file", new Blob([audio.buffer], { type: audio.mime }), `audio.${AUDIO_EXT[audio.mime] ?? "bin"}`);
  form.append("model", cap.model);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cap.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const error = buildHttpError(response.status, text, elapsedMs, url, cap.model);
      logModelCall({ turnId: null, purpose: "asr", ok: false, code: error.code, status: response.status, model: cap.model, url, elapsedMs, message: error.message, detail: text.slice(0, 500) });
      throw error;
    }
    const parsed = JSON.parse(text) as { text?: unknown };
    const result = typeof parsed.text === "string" ? parsed.text.trim() : "";
    logModelCall({ turnId: null, purpose: "asr", ok: true, status: response.status, model: cap.model, url, elapsedMs, message: result ? `${result.length} 字` : "空结果" });
    return result;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    const elapsedMs = Date.now() - started;
    const code: ModelErrorCode = isAbort(error) ? "TIMEOUT" : looksLikeNetworkError(error) ? "NETWORK" : "UNKNOWN";
    const modelError = new ModelError({
      code,
      message: `语音识别请求失败：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs,
      url,
      model: cap.model,
      causeDetail: causeChain(error),
    });
    logModelCall({ turnId: null, purpose: "asr", ok: false, cancelled: isAbort(error), code, model: cap.model, url, elapsedMs, message: modelError.message });
    throw modelError;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 语音合成：文本 → mp3 dataURL。走 OpenAI 兼容的 /audio/speech。
 * 返回 dataURL 而不是裸字节：接口统一 JSON 包壳，失败时前端才能走同一套 ok/error 判断。
 */
export async function synthesizeSpeech(input: string): Promise<{ dataUrl: string; elapsedMs: number }> {
  if (!capabilityReady("textToSpeech")) {
    throw new Error("语音合成还没配置：请到 设置 → 能力模型 → 语音合成 填好接口与模型名");
  }
  const text = input.trim();
  if (text === "") throw new Error("没有要合成的内容");
  const cap = capabilityConfig("textToSpeech");
  const url = `${cap.baseUrl}/audio/speech`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cap.timeoutMs);
  const started = Date.now();

  const body: Record<string, unknown> = { model: cap.model, input: text.slice(0, 2000), response_format: "mp3" };
  if (cap.voice !== "") body.voice = cap.voice;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cap.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const detail = await response.text();
      const error = buildHttpError(response.status, detail, elapsedMs, url, cap.model);
      logModelCall({ turnId: null, purpose: "tts", ok: false, code: error.code, status: response.status, model: cap.model, url, elapsedMs, message: error.message, detail: detail.slice(0, 500) });
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new ModelError({ code: "EMPTY_RESPONSE", message: "语音合成返回了空音频", elapsedMs, url, model: cap.model });
    }
    logModelCall({ turnId: null, purpose: "tts", ok: true, status: response.status, model: cap.model, url, elapsedMs, message: `${buffer.length} 字节` });
    return { dataUrl: `data:audio/mpeg;base64,${buffer.toString("base64")}`, elapsedMs };
  } catch (error) {
    if (error instanceof ModelError) throw error;
    const elapsedMs = Date.now() - started;
    const code: ModelErrorCode = isAbort(error) ? "TIMEOUT" : looksLikeNetworkError(error) ? "NETWORK" : "UNKNOWN";
    const modelError = new ModelError({
      code,
      message: `语音合成请求失败：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs,
      url,
      model: cap.model,
      causeDetail: causeChain(error),
    });
    logModelCall({ turnId: null, purpose: "tts", ok: false, cancelled: isAbort(error), code, model: cap.model, url, elapsedMs, message: modelError.message });
    throw modelError;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只允许拉公网 http(s)：服务商给的外链地址由它的响应决定，本机与内网地址一律拒绝。
 *
 * ⚠️ 私网判断必须**复用 web.ts 的 isPrivateAddress**，别在这儿另写一套前缀匹配：
 * 自己写的那版只挡了字面 `[::1]`，于是 `[::]`（全接口）和 `[::ffff:127.0.0.1]`
 * （URL 归一化成 `[::ffff:7f00:1]`，既不是 `[::1]` 也不是 `fe80:`/`fc`/`fd`）全部漏过，
 * 图片端点被劫持时能把本机服务（含云元数据 169.254.169.254）的响应当成图存下来给人看。
 * 两套规则必然漂移，而漂移的方向永远是"这边漏一个"。
 *
 * 这一层仍是**字面检查**，不做 DNS 解析校验（重绑定不在覆盖范围内，理由见下）。
 */
/** 导出来给冒烟钉住：这套 IPv6/私网口径必须与 web.ts 的 isPrivateAddress 完全一致。 */
export function safeMediaUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return false;
  // 域名（非 IP 字面量）放过：它要能解析到哪儿由下面这次 fetch 决定，
  // 而这一层的职责只是挡"响应里直接写了个内网地址"。
  if (isIP(host) !== 0 && isPrivateAddress(host)) return false;
  return true;
}

/**
 * 拉一张图，**边收边数字节**，超过上限就当场掐掉。
 *
 * 为什么不能 `Buffer.from(await res.arrayBuffer())`：那是先把整个响应读完再判大小，
 * 于是一个指错的外链（或配了重定向到某个大文件/无限流的地址）能让内存在判大小之前
 * 先被撑爆，唯一的边界是外层那个 30 秒超时。`web.ts` 早就为抓取做过同一件事
 * （按解压后字节增量截断），出图这条分支是从前漏掉的。
 *
 * 不直接复用 fetchRaw：那条门会连内网地址一起拒（SSRF 门），而出图外链的地址校验
 * 是 safeMediaUrl 的职责，冒烟里的假端点又跑在 127.0.0.1 上——两件事不该焊在一起。
 */
async function fetchImageBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || response.body === null) throw new Error(`图片拉取失败（${response.status}）`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限，已中断下载`);
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new Error("图片是空的");
  return bytes;
}

/**
 * 每个联系人每天最多画几张。出图的响应里没有 usage 字段（本机实测），算不进 token 账，
 * 所以张数是唯一控得住的成本闸门——这个数字就是这条能力全部的上限。
 */
export const IMAGE_DAILY_LIMIT = 5;

/**
 * 今天这个联系人已经成功画了几张。数的是 model_calls 里 purpose=imageGen 且 ok=1 的行：
 * 失败的调用不该占用配额，而落库这一步 generateImage 自己就在做，不必另建一张表。
 * 按本地日界线，和主动性每日配额同口径。
 */
export function imagesToday(contactId: string): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM model_calls WHERE purpose = 'imageGen' AND ok = 1 AND contact_id = ? AND created_at >= ?`,
    )
    .get(contactId, midnight.getTime()) as { c: number };
  return row.c;
}

/**
 * 出图响应原文里有 1.6MB 级的**裸 base64**（不是 data URL，躲得过 logs.ts 那个
 * stripInlineDataUrls），照聊天那样原样入库，DEV_MODE 的十条响应窗口就是十几 MB。
 * 这里只把 b64_json 换成字节数占位，其余形状照留——排查要看的是"服务商回了什么"，
 * 不是那串 base64。
 */
function redactImageResponse(raw: string): string {
  return raw.replace(/"b64_json"\s*:\s*"([^"]*)"/g, (_m, b64: string) => `"b64_json":"<${b64.length} 字符已省略>"`);
}

/**
 * 图像生成：一句话 → 一张落到本地媒体目录的图。走 OpenAI 兼容的 /images/generations。
 *
 * 产物优先用 b64_json，为空时改拉服务商给的外链并落盘到本地媒体目录——本机实测同端点
 * 两次调用一次给 base64、一次给空串只留 url（那是 `cos-…-outputs.agnes-ai.cn/images/…`
 * 的任务产物临时地址，所以拉回来存成我们自己的文件，不把它当持久链接用）。
 * 实测（agnes-image-2.5-flash / n=1）：同步返回、7.8~17.4 秒、
 * data[0] = {url, b64_json, revised_prompt}，**没有 usage 字段**——所以一张图的代价
 * 算不进 token 账，只能靠"每个联系人每天几张"来管（配额在 tools.ts 那侧）。
 */
export async function generateImage(
  prompt: string,
  ctx: {
    contactId?: string | null;
    turnId?: string | null;
    /** 长相参考图（/media 路径）。给了就走图生图，画出来才是"她"。 */
    reference?: string;
    /** 构图：square=1024x1024（默认），portrait=1024x1536（自拍/人像）。 */
    shape?: "square" | "portrait";
  } = {},
): Promise<{ url: string; elapsedMs: number }> {
  if (!capabilityReady("imageGeneration")) {
    throw new Error("图像生成还没配置：请到 设置 → 能力模型 → 图像生成 填好接口与模型名");
  }
  const text = prompt.trim().slice(0, 900);
  if (text === "") throw new Error("没有要画的内容");
  // 参考图读不出来就必须失败：静默丢掉它等于答应一张"她的自拍"却画个陌生人，
  // 那比画不出来更糟——她还会照原样说"这就是我"。
  let referenceDataUrl: string | null = null;
  if (ctx.reference) {
    referenceDataUrl = mediaDataUrl(ctx.reference);
    if (referenceDataUrl === null) throw new Error(`长相参考图的文件不在了：${ctx.reference}`);
  }
  const cap = capabilityConfig("imageGeneration");
  const url = `${cap.baseUrl}/images/generations`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cap.timeoutMs);
  const started = Date.now();
  // `image` 这个字段名是实测出来的：加上它服务商把任务从 /images/t2i/ 换成 /images/i2i/，
  // 而换成 images / reference_images 会被网关按字段白名单直接拒（400）。
  const body: Record<string, unknown> = {
    model: cap.model, prompt: text,
    size: ctx.shape === "portrait" ? "1024x1536" : "1024x1024", n: 1,
    ...(referenceDataUrl ? { image: referenceDataUrl } : {}),
  };
  // 摘要里把"带没带参考图、走的什么构图"写死：这三个数决定成片是不是她，
  // 但请求原文只有 DEV_MODE 才落库，平时看调用记录也得能一眼看出来。
  const meta = `${referenceDataUrl ? `参考图 ${Math.ceil(referenceDataUrl.length / 1024)}KB` : "无参考图"} · ${String(body.size)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cap.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    const raw = await response.text();
    if (!response.ok) {
      const error = buildHttpError(response.status, raw, elapsedMs, url, cap.model);
      logModelCall({ turnId: ctx.turnId ?? null, purpose: "imageGen", ok: false, code: error.code, status: response.status, model: cap.model, url, elapsedMs, message: `${error.message}（${meta}）`, detail: raw.slice(0, 500), resFull: redactImageResponse(raw), requestBody: body, contactId: ctx.contactId ?? null });
      throw error;
    }
    let b64: string | undefined;
    let remoteUrl: string | undefined;
    let revised = "";
    try {
      const parsed = JSON.parse(raw) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
      b64 = parsed.data?.[0]?.b64_json;
      remoteUrl = parsed.data?.[0]?.url;
      revised = typeof parsed.data?.[0]?.revised_prompt === "string" ? parsed.data[0].revised_prompt : "";
    } catch {
      b64 = undefined;
    }
    // 服务商给哪一份产物并不固定：本机实测同一端点两次调用，一次 b64_json 有内容、
    // 一次是空串只给 url。所以 b64 为空就得去拉那条外链，否则"能出图的服务商"会被我们判成不能用。
    let buffer: Buffer | null = b64 && b64 !== "" ? Buffer.from(b64, "base64") : null;
    if (buffer === null && remoteUrl && safeMediaUrl(remoteUrl)) {
      try {
        buffer = await fetchImageBytes(remoteUrl, Math.min(cap.timeoutMs, 30_000));
      } catch {
        // 拉不动（超时/超限）就统一落到下面的 EMPTY_RESPONSE，不在这里编第二套错误文案。
      }
    }
    if (buffer === null || buffer.length === 0) {
      const error = new ModelError({ code: "EMPTY_RESPONSE", message: "图像生成没返回图片数据", elapsedMs, url, model: cap.model });
      logModelCall({ turnId: ctx.turnId ?? null, purpose: "imageGen", ok: false, code: error.code, status: response.status, model: cap.model, url, elapsedMs, message: `${error.message}（${meta}）`, detail: raw.slice(0, 300), resFull: redactImageResponse(raw), requestBody: body, contactId: ctx.contactId ?? null });
      throw error;
    }
    const saved = saveImage(buffer, "image/png");
    // 文件刚落盘就先记账，**不等消息插入**：这一轮之后可能被打断、重试、取消、
    // 或者服务重启——那些情况下画是成功的，但如果只有消息引用它，文件就会变成孤儿被清理掉。
    recordArtifact({
      url: saved.url,
      contactId: ctx.contactId ?? null,
      turnId: ctx.turnId ?? null,
      prompt: text,
      revisedPrompt: revised,
      withReference: referenceDataUrl !== null,
      shape: String(body.size),
    });
    logModelCall({ turnId: ctx.turnId ?? null, purpose: "imageGen", ok: true, status: response.status, model: cap.model, url, elapsedMs, message: `${saved.url}（${meta}）`, resFull: redactImageResponse(raw), requestBody: body, contactId: ctx.contactId ?? null });
    return { url: saved.url, elapsedMs };
  } catch (error) {
    if (error instanceof ModelError) throw error;
    const elapsedMs = Date.now() - started;
    const code: ModelErrorCode = isAbort(error) ? "TIMEOUT" : looksLikeNetworkError(error) ? "NETWORK" : "UNKNOWN";
    const modelError = new ModelError({
      code,
      message: `图像生成请求失败：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs,
      url,
      model: cap.model,
      causeDetail: causeChain(error),
    });
    logModelCall({ turnId: ctx.turnId ?? null, purpose: "imageGen", ok: false, cancelled: isAbort(error), code, model: cap.model, url, elapsedMs, message: `${modelError.message}（${meta}）`, requestBody: body, contactId: ctx.contactId ?? null });
    throw modelError;
  } finally {
    clearTimeout(timer);
  }
}

/** 未配置模型时的本地假回复：让「收消息 → 立刻 200 → 异步处理 → 回消息」整条链路先跑通。 */
function echo(messages: ChatMessage[], options: CallOptions): string {
  const rawLast = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const lastUser = typeof rawLast === "string" ? rawLast : rawLast.map((part) => (part.type === "text" ? part.text : "[图片]")).join(" ");
  if (options.purpose === "extract") return "[]";
  if (options.purpose === "consolidate") {
    return '{"merges":[],"expire":[],"lifeline":"","bond":null}';
  }
  if (options.purpose === "proactive") {
    return JSON.stringify({ should: false, reason: "echo 模式不主动打扰" });
  }
  const preview = lastUser.length > 40 ? `${lastUser.slice(0, 40)}…` : lastUser;
  return `（演示模式）我收到你说的「${preview}」了，这会儿还没接上真实模型——到「设置 → 主模型接入」添加并启用一套模型，我就能真的回你了。`;
}
