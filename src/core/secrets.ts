// 密钥脱敏的唯一实现：核心底座，不认识任何业务模块。
//
// 两个边界共用同一条规则：
// - logs.ts 的 redactSecrets：整段文本（请求体 / 响应原文 / 摘要）入库前擦一遍；
// - agent.ts 的 redactToolArguments：工具参数回传给服务商、以及落进 messages.tool_args 之前擦一遍。
//
// 两侧统一用下面这两个函数：结构化的走递归（嵌在
// import_extension.manifest.mcp.headers 或 webhook headers 里的密钥也逃不掉），
// 纯文本的走全文正则，敏感字段名的判定只此一处——若各自手写正则或只遍历顶层字段，
// 会出现「日志挡住了、工具往返却原样发给下一家服务商、还留在库里」的缺口。
//
// 字段名允许连字符与数字（x-api-token / access_token / Authorization 都得认），
// 但刻意不收「auth」「key」这种裸词：author / keyword 会被误伤。

export const REDACTED = "<已省略>";

/** 值本身是字符串、且键名命中这一串，就把值换成占位。 */
const SECRET_KEY = /^[A-Za-z0-9_-]*(?:api[_-]?key|secret|password|passwd|authorization|token|credential)[A-Za-z0-9_-]*$/i;

/** 文本形态的 `"key":"value"` 与 `Bearer xxx`。用于无法解析成 JSON 的原文。 */
const SECRET_FIELD_TEXT = /"([A-Za-z0-9_-]*(?:api[_-]?key|secret|password|passwd|authorization|token|credential)[A-Za-z0-9_-]*)"\s*:\s*"[^"]*"/gi;
const BEARER_TEXT = /Bearer\s+[A-Za-z0-9._\-]{8,}/g;

/** 整段文本脱敏。model_calls 的 detail / req_full / res_full 都从这过。 */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_FIELD_TEXT, `"$1":"${REDACTED}"`)
    .replace(BEARER_TEXT, `Bearer ${REDACTED}`);
}

/** 递归遍历对象与数组；只有「敏感键 + 字符串值」被换掉，其余原样保留。 */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = typeof child === "string" && child !== "" && SECRET_KEY.test(key)
      ? REDACTED
      : redactValue(child);
  }
  return out;
}

/**
 * 工具参数 JSON 的脱敏：解析成结构后递归，再序列化回合法 JSON（形状不变，
 * 协议要求 assistant.tool_calls 原样回传，不能把它变成一段占位文本）。
 * 不是合法 JSON 时退回全文正则——至少要擦掉肉眼可见的密钥，宁可形状不完美。
 */
export function redactToolArguments(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed === null || typeof parsed !== "object") return argsJson;
    return JSON.stringify(redactValue(parsed));
  } catch {
    return redactSecrets(argsJson);
  }
}

/** 给测试与诊断用：单独判断一个字段名是否属于密钥类。 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}
