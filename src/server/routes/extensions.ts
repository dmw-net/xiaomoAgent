// 扩展：外挂能力的登记与插拔（MCP / webhook / script）。
// 语义：import=登记清单，enabled=插拔开关，tools=清单内自定义工具的增改删，
// probe=手动连一次 MCP 刷新目录，script-gate=JS 执行许可（必须显式确认）。
//
// 顺序敏感：保留字（import/enabled/probe/script-gate）必须先于 <id> 通配匹配，
// 别把保留字当成扩展 id 接住。

import {
  removeExtension as deleteExtension,
  deleteTool as deleteExtensionTool,
  snapshot as extensionSnapshot,
  importManifest as importExtension,
  probeExtension,
  saveTool as saveExtensionTool,
  setEnabled as setExtensionEnabled,
  setScriptGate,
} from "../../mind/extensions.ts";
import { readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** 扩展快照（GET /api/extensions）。 */
const extensionsListRoute: Route = ({ res, path, method }) => {
  if (!(path === "/api/extensions" && method === "GET")) return false;
  sendJson(res, 200, { ok: true, ...extensionSnapshot() });
  return true;
};

/** 登记一份扩展清单（import）。 */
const extensionsImportRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/extensions/import" && method === "POST")) return false;
  const body = await readJson<{ manifest?: unknown }>(req, 256_000);
  try {
    const result = importExtension(body.manifest);
    sendJson(res, 200, { ok: true, created: result.created, ...extensionSnapshot() });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** JS 执行许可（script-gate）：必须显式确认。 */
const extensionsScriptGateRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/extensions/script-gate" && method === "POST")) return false;
  const body = await readJson<{ confirmed?: unknown; allow?: unknown }>(req);
  try {
    setScriptGate(body.confirmed === true, body.allow === true);
    sendJson(res, 200, { ok: true, ...extensionSnapshot() });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** 插拔开关（enabled）。 */
const extensionsEnabledRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/extensions/enabled" && method === "POST")) return false;
  const body = await readJson<{ id?: unknown; enabled?: unknown }>(req);
  const id = typeof body.id === "string" ? body.id : "";
  if (id === "") {
    sendJson(res, 400, { ok: false, error: "扩展 id 不能为空" });
    return true;
  }
  try {
    const entry = await setExtensionEnabled(id, body.enabled === true);
    sendJson(res, 200, { ok: true, entry, ...extensionSnapshot() });
  } catch (error) {
    sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** 手动连一次 MCP 刷新目录（probe）。 */
const extensionsProbeRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/extensions/probe" && method === "POST")) return false;
  const body = await readJson<{ id?: unknown }>(req);
  const id = typeof body.id === "string" ? body.id : "";
  if (id === "") {
    sendJson(res, 400, { ok: false, error: "扩展 id 不能为空" });
    return true;
  }
  try {
    const probed = await probeExtension(id);
    sendJson(res, 200, { ok: true, probed, ...extensionSnapshot() });
  } catch (error) {
    sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/**
 * <id> 通配路由：删扩展 / 增改删工具。
 * 必须排在保留字之后，且不把保留字当成 id 接住（见模块头注释）。
 */
const extensionByIdRoute: Route = async ({ req, res, path, url, method }) => {
  const reserved = ["import", "enabled", "probe", "script-gate"];
  const m = reserved.includes(path.slice("/api/extensions/".length))
    ? null
    : /^\/api\/extensions\/([a-z0-9][a-z0-9-]{0,47})(?:\/tools\/([a-z0-9][a-z0-9_]{0,39}))?$/.exec(path);
  if (m === null) return false;
  const [, extensionId = "", toolName] = m;
  if (toolName === undefined) {
    if (method !== "DELETE") return false;
    try {
      deleteExtension(extensionId, url.searchParams.get("confirmed") === "1");
      sendJson(res, 200, { ok: true, ...extensionSnapshot() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (method === "PUT") {
    const body = await readJson<{ tool?: unknown }>(req, 256_000);
    try {
      const entry = saveExtensionTool(extensionId, body.tool);
      sendJson(res, 200, { ok: true, entry, ...extensionSnapshot() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (method === "DELETE") {
    try {
      const entry = deleteExtensionTool(extensionId, toolName);
      sendJson(res, 200, { ok: true, entry, ...extensionSnapshot() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  return false;
};

export const routes: Route[] = [
  extensionsListRoute,
  extensionsImportRoute,
  extensionsScriptGateRoute,
  extensionsEnabledRoute,
  extensionsProbeRoute,
  extensionByIdRoute,
];
