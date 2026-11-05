// 扩展层：把「外来的手」装到工具池上，随装随卸。
//
// 一份扩展 = 一段自描述的清单（xiaomo-extension.json）：它声明自己接哪个 MCP 服务、
// 自带哪些自定义工具；本模块负责校验清单、登记、开关，以及把启用中的扩展翻译成
// ToolDef 交给 src/mind/tools.ts 的工具池。模型侧永远只见统一的三件套声明，
// 不感知一只手是内置的、webhook 的、还是 MCP 转发来的。
//
// 存储约束与 settings 相同：全部进 SQLite kv，每次现读，不做进程内缓存——
// 多窗口共享一个库，「保存即生效」不能靠窗口自觉。
//
// 安全面（界面上要如实提示，这里先把边界钉死）：
// - mcp.url 只收 https，或本机回环 http；headers 里允许带鉴权。
// - webhook handler 允许 http/https（要能打局域网里的自建服务），但超时封顶。
// - script handler 在 node:vm 的空上下文里跑，默认整个类别被
//   extensions.allowScripts 锁死；打开它必须走显式确认接口，不能只改前端开关。

import vm from "node:vm";
import { kvGet, kvSet } from "../core/db.ts";
import { McpClient, type McpEndpoint } from "./mcp.ts";
import type { ExtensionDiagnostic, ExtensionSnapshot, ExtensionSnapshotEntry, ExtensionToolKind } from "../../shared/api.ts";

export type { ExtensionDiagnostic, ExtensionSnapshot, ExtensionSnapshotEntry, ExtensionToolKind };

const KV_REGISTRY = "extensions.registry";
const KV_ENABLED = "extensions.enabled";
const KV_SCRIPT_GATE = "extensions.allowScripts";

const MAX_MANIFEST_CHARS = 128_000;
const MAX_TOOLS_PER_EXTENSION = 32;
const MAX_MCP_TOOLS_PER_EXTENSION = 64;
const MAX_WEBHOOK_TIMEOUT_MS = 60_000;
const MAX_SCRIPT_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

const EXTENSION_ID = /^[a-z][a-z0-9-]{1,47}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE_MAX = 1000;
/** URL 查询串里长这样的参数名大概率是密钥——看见就报安全警告。 */
const SECRET_PARAM = /key|token|secret|password|passwd|api[-_]?key/i;

export type ExtensionHandler =
  | { kind: "webhook"; url: string; headers: Record<string, string>; timeoutMs: number }
  | { kind: "script"; code: string; timeoutMs: number };

export type ExtensionTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ExtensionHandler;
};

export type ExtensionManifest = {
  formatVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  mcp?: { url: string; headers: Record<string, string> };
  tools?: ExtensionTool[];
};

type ExtensionRecord = { manifest: ExtensionManifest; importedAt: string };

// ─── kv 读写（每次现读，坏数据退默认值，不让整个服务起不来）───

function readJson<T>(key: string, fallback: T): T {
  const raw = kvGet(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[extensions] ${key} 不是合法 JSON，已退回默认值`);
    return fallback;
  }
}

function readRegistry(): Record<string, ExtensionRecord> {
  return readJson<Record<string, ExtensionRecord>>(KV_REGISTRY, {});
}

function readEnabled(): Record<string, boolean> {
  return readJson<Record<string, boolean>>(KV_ENABLED, {});
}

export function scriptGate(): boolean {
  return readJson<boolean>(KV_SCRIPT_GATE, false);
}

// ─── 清单校验：结构、字段、上限，逐条给出人话错误 ───

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** mcp 只收 https 或本机回环 http；webhook 额外放行局域网 http（自建服务）。 */
function validateUrl(raw: unknown, label: string, allowPlainHttp: boolean): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${label}：地址不能为空`);
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${label}：不是合法的 URL`);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && (allowPlainHttp || loopback.has(parsed.hostname))) return parsed.toString();
  throw new Error(`${label}：只允许 https${allowPlainHttp ? " 或 http" : "（本机回环可用 http）"}`);
}

function validateHeaders(raw: unknown, label: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw new Error(`${label}：headers 必须是对象`);
  const out: Record<string, string> = {};
  const keys = Object.keys(raw);
  if (keys.length > 16) throw new Error(`${label}：headers 最多 16 个`);
  for (const key of keys) {
    if (!HEADER_KEY.test(key)) throw new Error(`${label}：header 名「${key}」不合法`);
    const value = raw[key];
    if (typeof value !== "string" || value.length > HEADER_VALUE_MAX) throw new Error(`${label}：header「${key}」的值必须是不超过 ${HEADER_VALUE_MAX} 字的字符串`);
    out[key] = value;
  }
  return out;
}

function validateParameters(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new Error("parameters 必须是 JSON Schema 对象");
  if (raw.type !== "object") throw new Error("parameters 的 type 必须是 object（工具参数永远是一个对象）");
  return raw;
}

function validateHandler(raw: unknown): ExtensionHandler {
  if (!isPlainObject(raw) || typeof raw.kind !== "string") throw new Error("handler.kind 缺失（webhook 或 script）");
  if (raw.kind === "webhook") {
    if (typeof raw.code === "string" || raw.code !== undefined) throw new Error("webhook handler 不允许携带 code");
    const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TOOL_TIMEOUT_MS : raw.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > MAX_WEBHOOK_TIMEOUT_MS) {
      throw new Error(`webhook timeoutMs 需在 500～${MAX_WEBHOOK_TIMEOUT_MS} 之间`);
    }
    return { kind: "webhook", url: validateUrl(raw.url, "webhook url", true), headers: validateHeaders(raw.headers, "webhook headers"), timeoutMs: Math.round(timeoutMs) };
  }
  if (raw.kind === "script") {
    if (typeof raw.code !== "string" || raw.code.trim() === "") throw new Error("script handler 的 code 不能为空");
    if (raw.code.length > 20_000) throw new Error("script code 超过 20000 字上限");
    const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TOOL_TIMEOUT_MS : raw.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > MAX_SCRIPT_TIMEOUT_MS) {
      throw new Error(`script timeoutMs 需在 500～${MAX_SCRIPT_TIMEOUT_MS} 之间`);
    }
    return { kind: "script", code: raw.code, timeoutMs: Math.round(timeoutMs) };
  }
  throw new Error(`未知的 handler.kind「${String(raw.kind)}」（只支持 webhook 与 script）`);
}

function validateTool(raw: unknown, index: number): ExtensionTool {
  if (!isPlainObject(raw)) throw new Error(`tools[${index}] 必须是对象`);
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!TOOL_NAME.test(name)) throw new Error(`tools[${index}].name「${name}」不合法：小写字母开头，只含小写字母/数字/下划线，最长 40 字`);
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (description === "" || description.length > 500) throw new Error(`tools[${index}]（${name}）：description 必填且不超过 500 字——这是模型判断要不要用它的唯一依据`);
  return { name, description, parameters: validateParameters(raw.parameters), handler: validateHandler(raw.handler) };
}

/**
 * 校验并规范化一份清单。只认自有格式：多一个不认识的顶层字段都直接拒绝——
 * 宽容的导入会悄悄执行用户没审过的语义，宁可报「不是 xiaomo 扩展清单」。
 */
export function validateManifest(raw: unknown): ExtensionManifest {
  if (!isPlainObject(raw)) throw new Error("不是 xiaomo 扩展清单：顶层必须是 JSON 对象");
  if (raw.formatVersion !== 1) throw new Error("formatVersion 必须是 1");
  const known = new Set(["formatVersion", "id", "name", "version", "description", "mcp", "tools"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`不是 xiaomo 扩展清单：不认识顶层字段「${key}」`);
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!EXTENSION_ID.test(id)) throw new Error("id 不合法：小写字母开头，只含小写字母/数字/连字符，2～48 字");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "" || name.length > 80) throw new Error("name 必填且不超过 80 字");
  const version = typeof raw.version === "string" ? raw.version : "";
  if (!SEMVER.test(version)) throw new Error("version 必须是 x.y.z 语义版本");
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (description.length > 500) throw new Error("description 不超过 500 字");
  if (raw.mcp === undefined && raw.tools === undefined) throw new Error("清单至少要有 mcp 或 tools 之一，否则它什么也不提供");
  const manifest: ExtensionManifest = { formatVersion: 1, id, name, version, description };
  if (raw.mcp !== undefined) {
    const mcp = raw.mcp;
    if (!isPlainObject(mcp)) throw new Error("mcp 必须是对象");
    for (const key of Object.keys(mcp)) {
      if (key !== "url" && key !== "headers") throw new Error(`mcp 不认识字段「${key}」`);
    }
    manifest.mcp = { url: validateUrl(mcp.url, "mcp url", false), headers: validateHeaders(mcp.headers, "mcp headers") };
  }
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) throw new Error("tools 必须是数组");
    if (raw.tools.length > MAX_TOOLS_PER_EXTENSION) throw new Error(`tools 最多 ${MAX_TOOLS_PER_EXTENSION} 个`);
    manifest.tools = raw.tools.map(validateTool);
  }
  return manifest;
}

/** 把模型声明的参数名空间化，防止与内置工具或别的扩展撞名。 */
export function extensionToolName(extensionId: string, toolName: string, kind: ExtensionToolKind): string {
  return `${kind === "mcp" ? "mcp" : "ext"}__${extensionId}__${toolName}`;
}

function secretInUrlWarning(url: string): ExtensionDiagnostic | null {
  try {
    const params = new URL(url).searchParams;
    for (const [key, value] of params) {
      if (SECRET_PARAM.test(key) && value !== "") {
        return { level: "warning", message: `URL 查询串里带了疑似密钥的参数「${key}」。密钥会随每一轮请求外发、并留在清单里；建议改放 headers。` };
      }
    }
  } catch { /* 校验过的 URL 不会走到这 */ }
  return null;
}

function diagnosticsOf(record: ExtensionRecord): ExtensionDiagnostic[] {
  const out: ExtensionDiagnostic[] = [];
  if (record.manifest.mcp) {
    const secret = secretInUrlWarning(record.manifest.mcp.url);
    if (secret) out.push(secret);
  }
  for (const tool of record.manifest.tools ?? []) {
    if (tool.handler.kind === "webhook") {
      const secret = secretInUrlWarning(tool.handler.url);
      if (secret) out.push(secret);
      if (tool.handler.url.startsWith("http:")) {
        out.push({ level: "warning", message: `工具 ${tool.name} 的 webhook 是明文 http，参数与结果在局域网内可被截获。` });
      }
    }
    if (tool.handler.kind === "script" && !scriptGate()) {
      out.push({ level: "warning", message: `工具 ${tool.name} 是 JS 工具，但脚本执行许可未开启，模型看不到它。` });
    }
  }
  return out;
}

// ─── 登记 / 开关 / 删除 ───

export function importManifest(raw: unknown): { created: boolean; entry: ExtensionSnapshotEntry } {
  const manifest = validateManifest(raw);
  const registry = readRegistry();
  const created = registry[manifest.id] === undefined;
  const record: ExtensionRecord = {
    manifest,
    importedAt: registry[manifest.id]?.importedAt ?? new Date().toISOString(),
  };
  registry[manifest.id] = record;
  kvSet(KV_REGISTRY, JSON.stringify(registry));
  // 重新导入视为更新：清掉旧的诊断（可能修好了），启用状态保留。
  if (created) {
    const enabled = readEnabled();
    delete enabled[manifest.id];
    kvSet(KV_ENABLED, JSON.stringify(enabled));
  }
  return { created, entry: snapshotOne(record, readEnabled()[manifest.id] === true) };
}

export async function setEnabled(id: string, enabled: boolean): Promise<ExtensionSnapshotEntry> {
  const registry = readRegistry();
  const record = registry[id];
  if (!record) throw new Error(`没有登记过扩展「${id}」`);
  const next = readEnabled();
  next[id] = enabled;
  kvSet(KV_ENABLED, JSON.stringify(next));
  if (enabled && record.manifest.mcp) {
    // 开启时就拉一次目录：声明必须等缓存就绪才出现，所以这一步不能省；
    // 失败不回滚开关（服务可能只是暂时不可达），诊断会如实记录。
    await probeExtension(id).catch(() => undefined);
  } else {
    invalidateToolCache(id);
  }
  return snapshotOne(record, enabled);
}

export function removeExtension(id: string, confirmed: boolean): void {
  if (confirmed !== true) throw new Error("删除扩展需要明确确认");
  const registry = readRegistry();
  if (!registry[id]) throw new Error(`没有登记过扩展「${id}」`);
  delete registry[id];
  kvSet(KV_REGISTRY, JSON.stringify(registry));
  const enabled = readEnabled();
  delete enabled[id];
  kvSet(KV_ENABLED, JSON.stringify(enabled));
  invalidateToolCache(id);
}

/** 编辑清单里自带的自定义工具（新增或覆盖同名）。 */
export function saveTool(id: string, raw: unknown): ExtensionSnapshotEntry {
  const registry = readRegistry();
  const record = registry[id];
  if (!record) throw new Error(`没有登记过扩展「${id}」`);
  const tool = validateTool(raw, 0);
  const tools = (record.manifest.tools ?? []).filter((t) => t.name !== tool.name);
  tools.push(tool);
  if (tools.length > MAX_TOOLS_PER_EXTENSION) throw new Error(`这个扩展的工具已到 ${MAX_TOOLS_PER_EXTENSION} 个上限`);
  record.manifest.tools = tools;
  kvSet(KV_REGISTRY, JSON.stringify(registry));
  invalidateToolCache(id);
  return snapshotOne(record, readEnabled()[id] === true);
}

export function deleteTool(id: string, toolName: string): ExtensionSnapshotEntry {
  const registry = readRegistry();
  const record = registry[id];
  if (!record) throw new Error(`没有登记过扩展「${id}」`);
  record.manifest.tools = (record.manifest.tools ?? []).filter((t) => t.name !== toolName);
  kvSet(KV_REGISTRY, JSON.stringify(registry));
  invalidateToolCache(id);
  return snapshotOne(record, readEnabled()[id] === true);
}

/** JS 工具执行许可。confirmed 是后端要求的显式确认，前端开关改不动它。 */
export function setScriptGate(confirmed: boolean, allow: boolean): void {
  if (confirmed !== true) throw new Error("开启脚本执行需要明确确认");
  kvSet(KV_SCRIPT_GATE, JSON.stringify(allow));
}

// ─── 快照（界面与冒烟断言都吃它）───

function snapshotOne(record: ExtensionRecord, enabled: boolean): ExtensionSnapshotEntry {
  const kinds: ExtensionToolKind[] = [];
  if (record.manifest.mcp) kinds.push("mcp");
  for (const tool of record.manifest.tools ?? []) kinds.push(tool.handler.kind);
  const tools: ExtensionSnapshotEntry["tools"] = [];
  if (record.manifest.mcp) {
    for (const discovered of cachedMcpTools(record.manifest.id)) {
      tools.push({ name: extensionToolName(record.manifest.id, discovered.name, "mcp"), kind: "mcp", description: discovered.description });
    }
  }
  for (const tool of record.manifest.tools ?? []) {
    tools.push({ name: extensionToolName(record.manifest.id, tool.name, tool.handler.kind), kind: tool.handler.kind, description: tool.description });
  }
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    enabled,
    importedAt: record.importedAt,
    tools,
    diagnostics: diagnosticsOf(record),
  };
}

export function snapshot(): ExtensionSnapshot {
  const registry = readRegistry();
  const enabled = readEnabled();
  const extensions = Object.values(registry)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "zh-CN"))
    .map((record) => snapshotOne(record, enabled[record.manifest.id] === true));
  return { allowScripts: scriptGate(), extensions };
}

// ─── 工具池桥接：把启用中的扩展翻译成 ToolDef ───

type DiscoveredMcpTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/**
 * MCP 工具清单的短缓存：一次 tools/list 是一次跨网络往返，不能让每轮对话的
 * 声明构建都付这个钱；但启用/停用/重导入时必须立刻失效，否则刚关掉的手还在。
 * kv 那份「不缓存」的承诺管的是设置真值，这里缓存的是远端目录。
 */
const mcpToolCache = new Map<string, { at: number; tools: DiscoveredMcpTool[] }>();
const MCP_TOOL_CACHE_MS = 60_000;

function invalidateToolCache(extensionId: string): void {
  mcpToolCache.delete(extensionId);
}

/** 同一个 URL 配不同 headers 就是两个身份，会话不共享——按端点序列化出键。 */
function endpointKey(endpoint: McpEndpoint): string {
  return JSON.stringify([endpoint.url, endpoint.headers]);
}

const mcpClients = new Map<string, McpClient>();

function mcpClientFor(endpoint: McpEndpoint): McpClient {
  const key = endpointKey(endpoint);
  let client = mcpClients.get(key);
  if (!client) {
    client = new McpClient(endpoint);
    mcpClients.set(key, client);
  }
  return client;
}

function cachedMcpTools(extensionId: string): DiscoveredMcpTool[] {
  const hit = mcpToolCache.get(extensionId);
  if (hit && Date.now() - hit.at < MCP_TOOL_CACHE_MS) return hit.tools;
  return [];
}

async function refreshMcpTools(id: string, endpoint: McpEndpoint): Promise<DiscoveredMcpTool[]> {
  const discovered = await mcpClientFor(endpoint).listTools();
  const trimmed = discovered.slice(0, MAX_MCP_TOOLS_PER_EXTENSION).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }));
  mcpToolCache.set(id, { at: Date.now(), tools: trimmed });
  return trimmed;
}

/** 拉取并缓存一个 MCP 扩展的工具目录；失败返回诊断而不是抛出。 */
export async function probeExtension(id: string): Promise<{ diagnostics: ExtensionDiagnostic[]; tools: number }> {
  const registry = readRegistry();
  const record = registry[id];
  if (!record) throw new Error(`没有登记过扩展「${id}」`);
  if (!record.manifest.mcp) return { diagnostics: [{ level: "info", message: "该扩展没有 MCP 连接，只包含自带工具。" }], tools: record.manifest.tools?.length ?? 0 };
  try {
    const tools = await refreshMcpTools(id, record.manifest.mcp);
    return { diagnostics: [], tools: tools.length };
  } catch (error) {
    invalidateToolCache(id);
    return { diagnostics: [{ level: "error", message: `MCP 连不上：${error instanceof Error ? error.message : String(error)}` }], tools: 0 };
  }
}

/**
 * 启用中扩展的全部工具，作为 ToolDef 并进工具池。
 * MCP 目录走短缓存（缓存空时不阻塞声明——下一轮再试），webhook/script 直接翻译。
 * script 类工具在许可关闭时绝不出现：不声明 = 模型调不到。
 */
export function extensionToolDefs(): import("./tools.ts").ToolDef[] {
  const registry = readRegistry();
  const enabled = readEnabled();
  const allowScripts = scriptGate();
  const defs: import("./tools.ts").ToolDef[] = [];
  for (const record of Object.values(registry)) {
    if (enabled[record.manifest.id] !== true) continue;
    const id = record.manifest.id;
    if (record.manifest.mcp) {
      const endpoint = record.manifest.mcp;
      for (const discovered of cachedMcpTools(id)) {
        defs.push({
          name: extensionToolName(id, discovered.name, "mcp"),
          description: discovered.description || discovered.name,
          parameters: discovered.inputSchema,
          execute: async (args) => await mcpResultToText(await mcpClientFor(endpoint).callTool(discovered.name, args)),
        });
      }
    }
    for (const tool of record.manifest.tools ?? []) {
      if (tool.handler.kind === "script" && !allowScripts) continue;
      const name = extensionToolName(id, tool.name, tool.handler.kind);
      defs.push({
        name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (args) => tool.handler.kind === "webhook"
          ? await runWebhook(tool.handler, args)
          : await runScript(tool.handler, args),
      });
    }
  }
  return defs;
}

// ─── 执行体 ───

async function runWebhook(handler: Extract<ExtensionHandler, { kind: "webhook" }>, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(handler.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...handler.headers },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(handler.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) return { error: `webhook 返回 HTTP ${response.status}`, body: text.slice(0, 2000) };
  try {
    return text === "" ? { ok: true } : JSON.parse(text);
  } catch {
    return { result: text.slice(0, 20_000) };
  }
}

/**
 * 在 node:vm 的新上下文里执行脚本工具。约定：code 求值为一个函数，
 * 收到参数对象、返回任意值。沙箱里没有 require/process/fetch，
 * 也没有 console——这是把「任意代码执行」压到最小面的代价，界面上已明示。
 */
async function runScript(handler: Extract<ExtensionHandler, { kind: "script" }>, args: Record<string, unknown>): Promise<unknown> {
  const logs: string[] = [];
  const sandbox = vm.createContext({
    JSON, Math, Date,
    console: { log: (...parts: unknown[]) => logs.push(parts.map((p) => typeof p === "string" ? p : JSON.stringify(p)).join(" ")) },
  });
  const script = new vm.Script(`(${handler.code})`, { filename: "extension-tool.js" });
  const fn = script.runInContext(sandbox, { timeout: 2000 });
  if (typeof fn !== "function") throw new Error("script code 求值结果不是函数（应写成一个箭头函数）");
  // 参数是模型给的，只作为函数实参进入，不参与代码求值本身。
  const result = (fn as (args?: unknown) => unknown)(args);
  const settled = result instanceof Promise ? await Promise.race([
    result,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`script 执行超过 ${handler.timeoutMs}ms`)), handler.timeoutMs)),
  ]) : result;
  return logs.length ? { logs, result: settled } : settled;
}

function mcpResultToText(result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }): unknown {
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts: string[] = [];
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    else parts.push(`[该内容为 ${item?.type ?? "unknown"} 类型，本版本不展示]`);
  }
  const text = parts.join("\n");
  return result?.isError ? { error: text } : { result: text };
}

/** 供测试收尾：清空全部模块内缓存（kv 是现读的，不需要清）。 */
export function resetExtensionsForTest(): void {
  mcpToolCache.clear();
  mcpClients.clear();
}
