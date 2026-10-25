// MCP 客户端（http transport）：把一个 MCP 服务器的工具目录搬进本项目的工具池。
//
// 只实现桥接所需的最小协议面：initialize 握手、tools/list、tools/call，
// 全部走 JSON-RPC 2.0 over HTTP（streamable http 的非流式用法）。刻意不做：
// stdio、订阅、资源、采样——第一版只需要「有目录、能调用」。
//
// 会话：服务器可能在响应头发 mcp-session-id，后续请求必须带回去；
// 每个端点一份会话，失效（404/400 带会话语义）时重新握手一次再试。
// 客户端无全局状态泄漏：所有可变状态都挂在 Client 实例上，由调用方决定生命周期。

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "xiaomo", version: "1.0.0" };
const REQUEST_TIMEOUT_MS = 10_000;

export type McpEndpoint = { url: string; headers: Record<string, string> };

export type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

class McpProtocolError extends Error {
  code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
  }
}

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };

/**
 * 一个端点对应一个客户端实例：会话 id、请求序号都在实例上。
 * 不是进程级单例——同一个 URL 配不同的 headers 就是两个身份，不该共享会话。
 */
export class McpClient {
  private readonly endpoint: McpEndpoint;
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(endpoint: McpEndpoint) {
    this.endpoint = endpoint;
  }

  /** 发一个 JSON-RPC 请求并取回 result；非 2xx 或 error 字段都转成异常。 */
  private async request<T>(method: string, params?: unknown): Promise<T> {
    const body: JsonRpcRequest = { jsonrpc: "2.0", id: this.nextId++, method, ...(params === undefined ? {} : { params }) };
    const payload = await this.post(body, true);
    if (payload.error !== undefined && payload.error !== null) {
      const err = payload.error as { code?: number; message?: string };
      throw new McpProtocolError(err.message ?? `MCP 请求失败（method=${method}）`, err.code ?? 0);
    }
    return payload.result as T;
  }

  private async notify(method: string): Promise<void> {
    const body: JsonRpcNotification = { jsonrpc: "2.0", method };
    await this.post(body, false);
  }

  /**
   * 底层 POST。响应可能是普通 JSON，也可能是 SSE 帧（text/event-stream）——
   * streamable http 允许服务器选择后者，这里把 data: 行里的 JSON 拼出来。
   * expectResult=false 时是通知，服务器通常回 202 空体，读不到 JSON 就安静返回。
   */
  private async post(body: unknown, expectResult: boolean): Promise<{ result?: unknown; error?: unknown }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.endpoint.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(this.endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseSession = response.headers.get("mcp-session-id");
    if (responseSession) this.sessionId = responseSession;
    if (!response.ok) {
      throw new McpProtocolError(`MCP 服务器返回 HTTP ${response.status}${expectResult ? `（method=${(body as JsonRpcRequest).method}）` : ""}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    if (contentType.includes("text/event-stream")) {
      const payload = parseSsePayload(raw, expectResult ? (body as JsonRpcRequest).id : undefined);
      if (payload === undefined) {
        if (expectResult) throw new McpProtocolError("MCP 响应的 SSE 帧里没有可用的 JSON-RPC 结果");
        return {};
      }
      return payload;
    }
    if (raw.trim() === "") {
      if (expectResult) throw new McpProtocolError("MCP 服务器返回了空响应体");
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as { result?: unknown; error?: unknown; id?: unknown };
      // 收到别的请求的响应（不该发生）也要拒掉，避免串话。
      if (expectResult && "id" in parsed && parsed.id !== (body as JsonRpcRequest).id) {
        throw new McpProtocolError("MCP 响应与请求不匹配（id 对不上）");
      }
      return parsed;
    } catch (error) {
      if (error instanceof McpProtocolError) throw error;
      throw new McpProtocolError("MCP 响应不是合法 JSON");
    }
  }

  /** 首次使用前握手。协议要求 initialized 通知在 initialize 结果之后补发。 */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.request<{ capabilities: unknown }>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await this.notify("notifications/initialized");
    this.initialized = true;
  }

  private async withRecovery<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      // 会话失效的最常见表现是 404/400：丢掉会话与初始化标记，重握手一次。
      if (!(error instanceof McpProtocolError) || !/HTTP (404|400)/.test(error.message) || !this.sessionId) throw error;
      this.sessionId = null;
      this.initialized = false;
      return await action();
    }
  }

  async listTools(): Promise<McpTool[]> {
    return this.withRecovery(async () => {
      await this.ensureInitialized();
      const result = await this.request<{ tools?: McpTool[] }>("tools/list", {});
      return Array.isArray(result.tools) ? result.tools : [];
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }> {
    return this.withRecovery(async () => {
      await this.ensureInitialized();
      return await this.request("tools/call", { name, arguments: args });
    });
  }
}

/** 从 SSE 文本里取目标 id 对应的那帧 JSON-RPC 响应。 */
function parseSsePayload(raw: string, expectedId: number | undefined): { result?: unknown; error?: unknown } | undefined {
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const data = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
    if (data.trim() === "" || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { result?: unknown; error?: unknown; id?: unknown };
      if (expectedId === undefined || parsed.id === undefined || parsed.id === expectedId) return parsed;
    } catch { /* 非JSON帧（注释/心跳）跳过 */ }
  }
  return undefined;
}
