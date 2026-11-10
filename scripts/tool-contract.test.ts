/**
 * 工具契约回归：把「从前只靠注释维持的规范」变成机器断言。
 *
 * 运行：node --experimental-sqlite scripts/tool-contract.test.ts
 *
 * 覆盖六件事：返回形状归一化、扩展错误形状不再漏判、通用参数校验、递归脱敏、
 * 静态工具池自检（名称唯一 / schema 合法 / 卡片登记）、扩展工具名长度与超时预算。
 * 全程不发起任何外部请求：需要出网的工具只测「参数在入口就被拦下」。
 */

import { redactSecrets, redactToolArguments, isSecretKey } from "../src/core/secrets.ts";
import {
  CARD_SUMMARY_TOOLS, DEFAULT_TOOL_RESULT_BUDGET, MAX_TOOL_NAME_CHARS, TOOL_NAME_RE,
  normalizeToolOutcome, validateAndCoerceArgs, validateToolPool, type ToolLike,
} from "../src/mind/tool-contract.ts";
import { executeTool, staticToolPool, STATIC_TOOL_NAMES, toolPoolDiagnostics, type ToolDef } from "../src/mind/tools.ts";
import { extensionToolName } from "../src/mind/extensions.ts";
import {
  GLOBAL_TOOL_PRESET_DEFAULT, INTERNAL_TOOL_PRESETS, KNOWN_TOOL_NAMES, PRESET_BLOCKS_EXTENSIONS,
  PRESET_OFF, TOOL_META, TOOL_PRESET_CHOICES, TOOL_PRESETS, toolCatalog,
} from "../src/mind/tool-catalog.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n[1] 返回值归一化：四种历史形状收敛成一份判别结果");
{
  const plain = normalizeToolOutcome({ weekday: "周五" });
  check("裸对象 → 成功且载荷原样", plain.ok && plain.error === null && (plain.payload as { weekday: string }).weekday === "周五");

  const soft = normalizeToolOutcome({ ok: false, error: "没画成", hint: "换个说法再试" });
  check("业务软失败 → ok:false 且保留 hint", !soft.ok && soft.error === "没画成"
    && (soft.payload as { hint: string }).hint === "换个说法再试");

  const extError = normalizeToolOutcome({ error: "webhook 返回 HTTP 500", body: "oops" });
  check("扩展/MCP 的 {error} 不再被画成绿勾", !extError.ok && extError.error === "webhook 返回 HTTP 500");

  const produced = normalizeToolOutcome({
    files: ["/media/a.png", "https://example.com/b.png", 42],
    result: { ok: true, seconds: 3 },
    meta: [{ url: "/media/a.png", label: "图" }, { bad: true }],
    deliveredToChannel: true,
  });
  check("产物包装 → 内层 result、只留 /media 附件", produced.ok
    && (produced.payload as { seconds: number }).seconds === 3
    && produced.files?.length === 1 && produced.files[0] === "/media/a.png"
    && produced.meta?.length === 1 && produced.deliveredToChannel === true);

  const candidates = normalizeToolOutcome({ sent: false, candidates: [{ emote_id: "x" }], note: "挑一张" });
  check("候选态仍算成功、载荷不丢（模型要靠它补发）", candidates.ok
    && (candidates.payload as { candidates: unknown[] }).candidates.length === 1);

  const pending = normalizeToolOutcome({ ok: false, needsConfirmation: { actionId: "a1", title: "删除扩展" }, note: "等用户点" });
  check("确认卡片不是失败：卡片绿、模型仍看到 ok:false", pending.ok && pending.error === null
    && (pending.payload as { ok: boolean }).ok === false);

  check("非对象返回值不炸", normalizeToolOutcome("ok").ok && normalizeToolOutcome(null).ok);
}

console.log("\n[2] 通用参数校验：required / type / enum / 边界 / 多余字段");
{
  const schema = {
    type: "object",
    properties: {
      url: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 8 },
      force: { type: "boolean" },
      kind: { type: "string", enum: ["web", "image"] },
    },
    required: ["url"],
    additionalProperties: false,
  };
  const missing = validateAndCoerceArgs(schema, {});
  check("缺 required 直接拦下", missing.error !== null && missing.error.includes("url"));

  const coerced = validateAndCoerceArgs(schema, { url: "https://x", limit: "99", force: "true", kind: "image", junk: 1 });
  check("数字/布尔字符串被纠正、数值按 schema 夹住", coerced.error === null
    && coerced.args.limit === 8 && coerced.args.force === true);
  check("additionalProperties:false 剥掉多余字段但不判失败", !("junk" in coerced.args));

  const badEnum = validateAndCoerceArgs(schema, { url: "https://x", kind: "video" });
  check("enum 之外的取值被拦下", badEnum.error !== null && badEnum.error.includes("kind"));

  const empty = validateAndCoerceArgs({ type: "object", properties: { model: { type: "string" } }, required: ["model"] }, { model: "" });
  check("空字符串算「给了」（bind_contact_model 靠它解除绑定）", empty.error === null);
}

console.log("\n[3] 递归脱敏：嵌套密钥与带连字符的 header 名");
{
  const args = JSON.stringify({
    label: "DeepSeek",
    apiKey: "sk-top-level",
    manifest: {
      name: "ext",
      mcp: { url: "https://mcp.example", headers: { Authorization: "Bearer abcdefgh", "x-api-token": "tok-123" } },
    },
    list: [{ client_secret: "nested-secret", harmless: "keep-me" }],
  });
  const out = JSON.parse(redactToolArguments(args)) as Record<string, any>;
  check("顶层 apiKey 被遮", out.apiKey === "<已省略>");
  check("嵌套 Authorization 被遮（从前漏）", out.manifest.mcp.headers.Authorization === "<已省略>");
  check("带连字符的 x-api-token 被遮（从前漏）", out.manifest.mcp.headers["x-api-token"] === "<已省略>");
  check("数组里的嵌套 client_secret 被遮", out.list[0].client_secret === "<已省略>");
  check("普通字段与形状不变", out.label === "DeepSeek" && out.list[0].harmless === "keep-me" && out.manifest.name === "ext");
  check("全文正则与结构化脱敏同源", redactSecrets(args).includes('"apiKey":"<已省略>"')
    && redactSecrets(args).includes('"Authorization":"<已省略>"'));
  check("非法 JSON 也走全文正则", redactToolArguments('{"apiKey":"sk-x"').includes("<已省略>"));
  check("密钥名判定不误伤普通字段", isSecretKey("x-api-token") && isSecretKey("access_token")
    && !isSecretKey("keyword") && !isSecretKey("author") && !isSecretKey("query"));
}

console.log("\n[4] 静态工具池自检：真实定义必须有 0 个 error");
{
  const pool = staticToolPool();
  const diagnostics = toolPoolDiagnostics();
  const errors = diagnostics.filter((d) => d.level === "error");
  check(`静态工具数量与名字集合一致（${pool.length} 个）`, pool.length === STATIC_TOOL_NAMES.size);
  check("真实工具池 0 个 error", errors.length === 0, errors.map((d) => `${d.tool}: ${d.message}`).join(" | "));
  check("所有工具名唯一", new Set(pool.map((t) => t.name)).size === pool.length);
  check("所有工具名满足 OpenAI 64 字约束", pool.every((t) => TOOL_NAME_RE.test(t.name)));
  check("所有静态工具都登记了卡片摘要", [...STATIC_TOOL_NAMES].every((n) => CARD_SUMMARY_TOOLS.has(n)));
  check("默认结果预算是 4000，大载荷工具单独放宽", DEFAULT_TOOL_RESULT_BUDGET === 4_000
    && (pool.find((t) => t.name === "web_fetch")?.resultBudget ?? 0) > 4_000
    && (pool.find((t) => t.name === "load_skill")?.resultBudget ?? 0) > 4_000);
  check("search_memory 不再声明 required（空参兜底与声明一致）",
    !Array.isArray((pool.find((t) => t.name === "search_memory")?.parameters as { required?: unknown }).required));
  check("schedule_reminder 补上了 required:text",
    JSON.stringify(pool.find((t) => t.name === "schedule_reminder")?.parameters).includes('"required":["text"]'));
}

console.log("\n[5] 自检能抓到坏工具");
{
  const bad: ToolLike[] = [
    { name: "dup_tool", description: "第一个", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { name: "dup_tool", description: "重名", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { name: "has.dot", description: "非法字符", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { name: "no_desc", description: "", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { name: "bad_schema", description: "schema 坏", parameters: { type: "array" } },
    { name: "bad_required", description: "required 坏", parameters: { type: "object", properties: {}, required: ["ghost"], additionalProperties: false } },
  ];
  const messages = validateToolPool(bad).filter((d) => d.level === "error").map((d) => d.message).join(" | ");
  check("能抓重名", messages.includes("工具名重复"));
  check("能抓非法名", messages.includes("工具名不合法"));
  check("能抓空描述", messages.includes("description"));
  check("能抓坏 schema", messages.includes("parameters.type"));
  check("能抓 required 指向不存在的字段", messages.includes("required"));
}

console.log("\n[6] 扩展工具名与调用名分离");
{
  const longId = "a".repeat(48);
  const longName = "b".repeat(40);
  const full = extensionToolName(longId, longName, "mcp");
  check("最长 id + 最长工具名仍 ≤64 且合法", full.length <= MAX_TOOL_NAME_CHARS && TOOL_NAME_RE.test(full), `len=${full.length}`);
  const a = extensionToolName(longId, longName + "1", "mcp");
  const b = extensionToolName(longId, longName + "2", "mcp");
  check("两个被截断的长名不撞车", a !== b);
  check("内置风格的名字保持可读", extensionToolName("weather", "get_forecast", "mcp") === "mcp__weather__get_forecast");
}

console.log("\n[7] 统一执行入口：校验、超时、软失败（不发外部请求）");
{
  const context = { lastUserAt: null, contactId: "default", turnId: "contract-test" };
  const pool = staticToolPool();

  const unknown = await executeTool("no_such_tool", "{}", context, pool);
  check("未知工具 → 结构化失败", !unknown.ok && unknown.error === "未知工具：no_such_tool" && unknown.result !== undefined);

  const badJson = await executeTool("get_current_time", "not-json", context, pool);
  check("坏 JSON → 结构化失败", !badJson.ok && badJson.error.includes("不是合法 JSON"));

  const noUrl = await executeTool("web_fetch", "{}", context, pool);
  check("required 在入口生效，不出网就被拦下", !noUrl.ok && (noUrl.error ?? "").includes("url"));

  const badKind = await executeTool("web_search", JSON.stringify({ query: "x", kind: "video" }), context, pool);
  check("enum 在入口生效，不出网就被拦下", !badKind.ok && (badKind.error ?? "").includes("kind"));

  const clock = await executeTool("get_current_time", '{"junk":1}', context, pool);
  check("正常工具照旧成功、多余参数被剥掉", clock.ok && typeof (clock.result as { text?: string }).text === "string");

  const noConversation = await executeTool("send_voice", JSON.stringify({ text: "你好" }), context, pool);
  check("工具自报的业务失败 → ok:false（卡片不再打绿勾）", !noConversation.ok && (noConversation.error ?? "").includes("会话"));

  const slow: ToolDef = {
    name: "slow_for_test", description: "测试超时", parameters: { type: "object", properties: {}, additionalProperties: false },
    timeoutMs: 20,
    execute: () => new Promise(() => undefined),
  };
  const timedOut = await executeTool("slow_for_test", "{}", context, [...pool, slow]);
  check("统一入口的超时预算生效", !timedOut.ok && (timedOut.error ?? "").includes("20ms"));
}

console.log("\n[8] 工具档位与台账目录");
{
  const quiet = PRESET_OFF.quiet;
  const balanced = PRESET_OFF.balanced;
  check("界面上是三档，全关由独立总开关表达", TOOL_PRESETS.length === 3 && !TOOL_PRESETS.includes("off"));
  check("内部仍认存量 off 值", INTERNAL_TOOL_PRESETS.includes("off") && TOOL_PRESET_CHOICES.includes("off"));
  check("档位严格逐级放大", balanced.every((n) => quiet.includes(n)) && PRESET_OFF.full.length === 0 && quiet.length > balanced.length);
  check("安静档不关表情与技能（升级前默认行为）",
    !quiet.includes("send_emote") && !quiet.includes("emote_search") && !quiet.includes("load_skill"));
  check("安静档仍收紧提醒与高风险三项",
    ["schedule_reminder", "generate_image", "send_voice", "web_search", "web_fetch"].every((n) => quiet.includes(n)));
  check("均衡档只比安静多放开提醒", !balanced.includes("schedule_reminder") && balanced.includes("generate_image"));
  check("三档都放行扩展（全关由总闸负责）", PRESET_BLOCKS_EXTENSIONS.quiet === false
    && PRESET_BLOCKS_EXTENSIONS.balanced === false && PRESET_BLOCKS_EXTENSIONS.full === false);
  check("全局默认档是安静（不翻转默认）", GLOBAL_TOOL_PRESET_DEFAULT === "quiet");
  check("目录覆盖 23 个静态工具", KNOWN_TOOL_NAMES.size === 23 && toolCatalog().length === 23);
  check("动态扩展能进目录且标为 external",
    toolCatalog([{ name: "mcp__demo__search", description: "搜一下" }]).some((t) => t.dynamic === true && t.group === "external"));
  const assistant = Object.entries(TOOL_META).filter(([, m]) => m.scope === "assistant");
  check("助手 13 项里只有 app_status 常开", assistant.length === 13
    && assistant.filter(([, m]) => m.alwaysOn === true).map(([n]) => n).join(",") === "app_status");
}

console.log(failures === 0 ? "\n工具契约回归：全部通过\n" : `\n工具契约回归：${failures} 项失败\n`);
if (failures > 0) process.exit(1);
