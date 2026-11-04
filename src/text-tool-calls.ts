// 正文形式的工具调用：有些服务商（Hermes / Qwen-Agent 系聊天模板，常见于国内中转与自建推理服务）
// 不填 OpenAI 的 tool_calls 字段，而是把调用写进正文：
//
//   <tool_call>
//   <function=web_search>
//   <parameter=kind>
//   image
//   </parameter>
//   <parameter=query>
//   deepseek 大肥鱼 鲸鱼娘
//   </parameter>
//   </function>
//   </tool_call>
//
// 不认它，这一轮就等于什么都没做：模型嘴上说「我去搜」，工具一次都没跑，界面上既没有工具卡也没有
// 候选图；下一句它还会顺着自己的话往下编（真实出现过「找到了 6 张图，已经显示在界面上啦」，
// 而库里一条 tool 消息都没有）。所以正文里出现这个格式时必须补一条兼容解析。
//
// 边界：只认闭合的 <tool_call>...</tool_call>，且只认得出函数名的块。认不出来的块**原样留着**——
// 宁可露出一段怪文本，也不能把用户真正看得懂的话吃掉。

/** 与 model.ts 里 ToolCall 同形：id / name / args(JSON 字符串)。 */
export type TextToolCall = { id: string; name: string; args: string };

const BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const FUNCTION_RE = /<function\s*=\s*([A-Za-z0-9_.:-]+)\s*>/i;
const PARAM_RE = /<parameter\s*=\s*([A-Za-z0-9_.:-]+)\s*>([\s\S]*?)<\/parameter>/gi;

/**
 * 参数值按 JSON 口径还原：模板里只有文本，而工具声明里 limit 是 number、开关是 boolean。
 * 原样当字符串发下去，`Number(args.limit ?? 5)` 这类写法能活，`args.force === true` 那种就废了。
 */
function coerce(raw: string): unknown {
  const value = raw.trim();
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d{1,15}(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** <function=name><parameter=k>v</parameter>…</function> 这一支（Hermes / Qwen3 模板）。 */
function fromFunctionBlock(inner: string): { name: string; args: Record<string, unknown> } | null {
  const fn = FUNCTION_RE.exec(inner);
  const name = fn?.[1] ?? "";
  if (name === "") return null;
  const args: Record<string, unknown> = {};
  for (const match of inner.matchAll(PARAM_RE)) {
    const key = match[1];
    if (key) args[key] = coerce(match[2] ?? "");
  }
  return { name, args };
}

/** {"name":…,"arguments":{…}} 这一支（Qwen2.5 / 少数网关）：arguments 也可能是 JSON 字符串。 */
function fromJsonBlock(inner: string): { name: string; args: Record<string, unknown> } | null {
  const text = inner.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const fn = (parsed.function ?? {}) as Record<string, unknown>;
    const name = String(parsed.name ?? fn.name ?? "");
    if (name === "") return null;
    const raw = parsed.arguments ?? parsed.parameters ?? fn.arguments ?? {};
    const args = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    return { name, args: args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {} };
  } catch {
    return null;
  }
}

/** 剥掉块之后收一下空行：正文里留下的空段会在气泡里变成一片空白。 */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 把正文里的工具调用块拆出来。没有块、或块都认不出来时原样返回（calls 为空数组）。
 * 认出来的块会从正文里删掉——它们是调用指令，不是联系人要说给用户听的话。
 */
export function parseTextToolCalls(content: string): { content: string; calls: TextToolCall[] } {
  if (!content.includes("<tool_call>")) return { content, calls: [] };
  const calls: TextToolCall[] = [];
  let cleaned = content;
  for (const match of content.matchAll(BLOCK_RE)) {
    const parsed = fromFunctionBlock(match[1] ?? "") ?? fromJsonBlock(match[1] ?? "");
    if (parsed === null) continue;
    calls.push({
      id: `call_text_${calls.length + 1}`,
      name: parsed.name,
      args: JSON.stringify(parsed.args),
    });
    cleaned = cleaned.replace(match[0], "");
  }
  if (calls.length === 0) return { content, calls };
  return { content: tidy(cleaned), calls };
}

/**
 * 流式草稿里只留到第一个 <tool_call> 之前：调用块是写给机器的，实时打字时闪一整段 XML
 * 比「联系人顿了一下」难看太多。整块还没收完（只有开标签）时同样截断。
 */
export function trimDraftBeforeToolCall(text: string): string {
  const at = text.indexOf("<tool_call>");
  return at < 0 ? text : text.slice(0, at).trimEnd();
}
