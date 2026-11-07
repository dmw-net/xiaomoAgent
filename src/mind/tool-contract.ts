// 工具契约层：把「工具长什么样、返回什么、参数怎么验」收成一份机器可校验的约定。
//
// 这里刻意是零业务依赖的叶子模块：不 import tools.ts / agent.ts / db.ts，
// 所以回归测试可以单独 import 它，不会把整条启动链拉起来。
//
// 解决的是三件从前只靠注释维持的事：
// 1. 工具返回值有四种形状（裸对象 / {ok:false} / {files,result} / {error}），
//    统一入口先归一化，下游只认一种判别结果；
// 2. JSON Schema 只声明给模型，执行侧全靠每个工具手写兜底；
// 3. 没有启动期自检：名字撞车、schema 写错、新工具忘了登记卡片，都要等线上翻车才发现。

/** ToolDef 的结构子集（tools.ts 的 ToolDef 与之兼容，不必反向 import）。 */
export type ToolLike = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 这一工具的结果进上下文时允许的字符数；缺省走 DEFAULT_TOOL_RESULT_BUDGET。 */
  resultBudget?: number;
  /** 单次执行的时间预算（毫秒）；缺省不设，由底层各自管超时。 */
  timeoutMs?: number;
};

export const DEFAULT_TOOL_RESULT_BUDGET = 4_000;

/** OpenAI function name 的通行约束；扩展拼接出来的名字也必须满足。 */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_TOOL_NAME_CHARS = 64;

export type NormalizedToolOutcome = {
  /** 界面工具卡的成功/失败。业务软失败与扩展/MCP 的 {error} 都落到这里。 */
  ok: boolean;
  /** 失败时给界面的一句话；成功为 null。 */
  error: string | null;
  /** 给模型、历史存档、工具卡摘要看的**完整载荷**，形状不改写。 */
  payload: unknown;
  /** 产物包装里的 /media 文件；没有则 null。 */
  files: string[] | null;
  /** 与 files 对应的附件元信息。 */
  meta: unknown[] | null;
  /** 渠道已由工具自己投递，agent 不要再发一遍。 */
  deliveredToChannel: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(raw: unknown): string {
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return "执行失败";
}

/**
 * 把任意工具返回值归一成一份判别结果。
 *
 * 四种历史形状都还允许存在（改 21 个工具的返回值风险太大），但只在**这一个函数**里认：
 *   ① {ok:false, error, …}        业务软失败（send_emote / 配置类 / web_*）
 *   ② {error: "…"}                扩展 webhook / MCP isError 的错误（从前漏判成成功）
 *   ③ {files, result, meta, …}    带产物的包装（出图 / 语音 / 表情）
 *   ④ 其它                        成功，载荷原样
 *
 * 关键：payload 永远是原始载荷，不压缩成一句 error。send_emote 的
 * {sent:false, candidates, hint} 必须原样交给模型，它要靠候选 id 再调一次。
 */
export function normalizeToolOutcome(raw: unknown): NormalizedToolOutcome {
  const base: NormalizedToolOutcome = {
    ok: true, error: null, payload: raw, files: null, meta: null, deliveredToChannel: false,
  };
  if (!isRecord(raw)) return base;

  if (raw.ok === false) {
    // 确认卡片不是失败：模型仍拿到 {ok:false, needsConfirmation}，会停下来等用户点击；
    // 但工具卡不该把「已经发出一张待确认卡片」画成一片红字。
    if (isRecord(raw.needsConfirmation)) return { ...base, ok: true, error: null };
    return { ...base, ok: false, error: errorText(raw.error) };
  }
  // 没有 ok:true 的 {error} 一律算失败：扩展与 MCP 从前正是这么把失败画成绿勾的。
  if (raw.ok !== true && typeof raw.error === "string" && raw.error.trim() !== "") {
    return { ...base, ok: false, error: errorText(raw.error) };
  }
  if (Array.isArray(raw.files)) {
    const files = raw.files.filter((f): f is string => typeof f === "string" && f.startsWith("/media/"));
    const meta = Array.isArray(raw.meta)
      ? raw.meta.filter((m) => isRecord(m) && typeof m.url === "string")
      : [];
    return {
      ...base,
      payload: raw.result ?? {},
      files: files.length > 0 ? files : null,
      meta: meta.length > 0 ? meta : null,
      deliveredToChannel: raw.deliveredToChannel === true,
    };
  }
  return base;
}

/** 按声明类型把正文形式/模型偶发写错的参数掰回来；掰不动就给一句人话错误。 */
function coerceValue(rule: unknown, value: unknown): { value: unknown; error: string | null } {
  if (!isRecord(rule)) return { value, error: null };
  const type = rule.type;
  if (type === "number" || type === "integer") {
    const n = typeof value === "number" ? value
      : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n)) return { value, error: "需要数字" };
    let out = type === "integer" ? Math.round(n) : n;
    if (typeof rule.minimum === "number") out = Math.max(out, rule.minimum);
    if (typeof rule.maximum === "number") out = Math.min(out, rule.maximum);
    return { value: out, error: null };
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return { value, error: null };
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) {
      return { value: value.trim().toLowerCase() === "true", error: null };
    }
    return { value, error: "需要 true / false" };
  }
  if (type === "string") {
    if (typeof value === "string") return { value, error: null };
    if (typeof value === "number" || typeof value === "boolean") return { value: String(value), error: null };
    return { value, error: "需要文本" };
  }
  return { value, error: null };
}

/**
 * 通用参数校验。声明里的 required / type / enum / minimum / maximum 在这里真正生效，
 * 不必每个 execute 再手写一遍 `String(args.x ?? "")`。
 *
 * 两个刻意的宽松点：
 * - additionalProperties:false 只**剥掉**多余字段，不判失败（模型偶尔多给一两个字段，
 *   直接拒绝会让整轮白跑）；
 * - required 只查「有没有这个键」，空字符串算给了：bind_contact_model 用 model:""
 *   表示解除绑定，把它当缺失会改坏功能。
 */
export function validateAndCoerceArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; error: string | null } {
  if (schema.type !== "object") return { args, error: null };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (rule === undefined) {
      if (schema.additionalProperties === false) continue;
      out[key] = value;
      continue;
    }
    const coerced = coerceValue(rule, value === undefined || value === null ? "" : value);
    if (coerced.error !== null) return { args, error: `${key}：${coerced.error}` };
    const enumValues = isRecord(rule) && Array.isArray(rule.enum) ? rule.enum : null;
    if (enumValues !== null && !enumValues.includes(coerced.value)) {
      return { args, error: `${key}：只能是 ${enumValues.map(String).join(" / ")}` };
    }
    out[key] = coerced.value;
  }
  for (const key of required) {
    if (!(key in out) || out[key] === undefined || out[key] === null) {
      return { args, error: `缺少必填参数 ${key}` };
    }
  }
  return { args: out, error: null };
}

/** chat/agent.ts 的 toolSummary 里显式登记过摘要的工具。 */
export const CARD_SUMMARY_TOOLS: ReadonlySet<string> = new Set([
  "get_current_time", "search_memory", "schedule_reminder", "generate_image", "send_voice",
  "emote_search", "send_emote", "app_status", "configure_model", "activate_model",
  "create_contact", "update_contact", "bind_contact_model", "set_contact_avatar",
  "web_search", "web_fetch", "load_skill",
  "manage_extensions", "import_extension", "edit_extension_tool", "set_script_gate",
]);

export type ToolDiagnostic = { level: "error" | "warning"; tool: string; message: string };

/**
 * 工具池自检：名称唯一与合法、描述非空、schema 形状、卡片摘要登记。
 * 只返回诊断不抛异常——一个写坏的 MCP 扩展不该让整个应用起不来；
 * 静态工具的 error 由回归测试当门禁（见 scripts/tool-contract.test.ts）。
 */
export function validateToolPool(
  pool: readonly ToolLike[],
  opts: { staticNames?: ReadonlySet<string> } = {},
): ToolDiagnostic[] {
  const out: ToolDiagnostic[] = [];
  const seen = new Set<string>();
  for (const tool of pool) {
    const name = typeof tool?.name === "string" ? tool.name : "(无名工具)";
    const push = (level: ToolDiagnostic["level"], message: string): void => {
      out.push({ level, tool: name, message });
    };
    if (seen.has(name)) push("error", "工具名重复");
    seen.add(name);
    if (!TOOL_NAME_RE.test(name)) push("error", `工具名不合法或超过 ${MAX_TOOL_NAME_CHARS} 字（需 ^[A-Za-z0-9_-]{1,64}$）`);
    if (typeof tool.description !== "string" || tool.description.trim() === "") push("error", "description 不能为空");
    const schema = tool.parameters;
    if (!isRecord(schema)) {
      push("error", "parameters 必须是 JSON Schema 对象");
    } else {
      if (schema.type !== "object") push("error", "parameters.type 必须是 object");
      if (schema.properties !== undefined && !isRecord(schema.properties)) push("error", "parameters.properties 必须是对象");
      if (schema.required !== undefined && !Array.isArray(schema.required)) push("error", "parameters.required 必须是数组");
      const properties = isRecord(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (typeof key !== "string" || !(key in properties)) push("error", `required 里的「${String(key)}」不在 properties 中`);
        }
      }
      if (schema.additionalProperties !== false) push("warning", "未设 additionalProperties:false");
    }
    if (typeof tool.resultBudget === "number" && (tool.resultBudget < 200 || tool.resultBudget > 100_000)) {
      push("warning", "resultBudget 超出合理范围（200～100000）");
    }
    if (typeof tool.timeoutMs === "number" && tool.timeoutMs < 500) push("warning", "timeoutMs 小于 500ms");
  }
  if (opts.staticNames !== undefined) {
    for (const name of opts.staticNames) {
      if (!CARD_SUMMARY_TOOLS.has(name)) out.push({ level: "warning", tool: name, message: "工具卡摘要未登记，界面只会显示兜底文案" });
    }
  }
  return out;
}
