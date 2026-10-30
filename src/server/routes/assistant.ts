// 助手工作区：多份互不干扰的对话线程（CRUD + 自动命名），权限档位与危险动作确认卡片。
// 顺序敏感（与原 handle() 一致）：threads 五个端点（GET/POST/rename/clear/delete）→
// permission GET/POST → pending GET → pending/:id/:decision POST。

import {
  clearAssistantThread,
  createAssistantThread,
  deleteAssistantThread,
  listAssistantThreads,
  renameAssistantThread,
  assistantPermission,
  setAssistantPermission,
  pendingActionsFor,
  resolvePendingAction,
  isAssistantThreadContactId,
} from "../../assistant.ts";
import { ASSISTANT_CONTACT_ID } from "../../contacts.ts";
import { getChannel } from "../../channels/types.ts";
import { readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** GET /api/assistant/threads：列出所有工作区。 */
export const assistantThreadsGetRoute: Route = ({ res, path, method }) => {
  if (!(method === "GET" && path === "/api/assistant/threads")) return false;
  sendJson(res, 200, { ok: true, threads: listAssistantThreads() });
  return true;
};

/** POST /api/assistant/threads：新建工作区（第一条消息自动命名）。 */
export const assistantThreadsCreateRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/assistant/threads")) return false;
  const body = await readJson<Record<string, unknown>>(req);
  const thread = createAssistantThread(typeof body.title === "string" ? body.title : "");
  sendJson(res, 200, { ok: true, thread });
  return true;
};

/** POST /api/assistant/threads/rename：重命名工作区。 */
export const assistantThreadsRenameRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/assistant/threads/rename")) return false;
  const body = await readJson<Record<string, unknown>>(req);
  const id = typeof body.id === "string" ? body.id : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title === "" || title.length > 24) {
    sendJson(res, 400, { ok: false, error: "工作区名称不能为空（最多 24 个字）" });
    return true;
  }
  if (!renameAssistantThread(id, title)) {
    sendJson(res, 404, { ok: false, error: "工作区不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true });
  return true;
};

/** POST /api/assistant/threads/clear：清空工作区（内置「通用」的唯一出口）。 */
export const assistantThreadsClearRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/assistant/threads/clear")) return false;
  const body = await readJson<Record<string, unknown>>(req);
  const id = typeof body.id === "string" ? body.id : "";
  const cleared = clearAssistantThread(id);
  if (cleared === null) {
    sendJson(res, 404, { ok: false, error: "工作区不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true, ...cleared });
  return true;
};

/** POST /api/assistant/threads/delete：删除工作区（内置「通用」不可删）。 */
export const assistantThreadsDeleteRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/assistant/threads/delete")) return false;
  const body = await readJson<Record<string, unknown>>(req);
  const id = typeof body.id === "string" ? body.id : "";
  if (id === "") {
    sendJson(res, 400, { ok: false, error: "内置「通用」工作区不可删除" });
    return true;
  }
  if (!deleteAssistantThread(id)) {
    sendJson(res, 404, { ok: false, error: "工作区不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true });
  return true;
};

/** GET /api/assistant/permission 或 POST：读/写权限档位。 */
export const assistantPermissionRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/assistant/permission")) return false;
  if (method === "GET") {
    sendJson(res, 200, { ok: true, permission: assistantPermission() });
    return true;
  }
  if (method === "POST") {
    const body = await readJson<{ permission?: unknown }>(req);
    try {
      const permission = setAssistantPermission(body.permission);
      sendJson(res, 200, { ok: true, permission });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  return false;
};

/** GET /api/assistant/pending：查询当前联系人的待确认危险动作。 */
export const assistantPendingGetRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/assistant/pending")) return false;
  const contactId = url.searchParams.get("contactId") ?? "";
  // 裸 assistant（内置「通用」）与派生线程都是合法作用域。
  if (contactId !== ASSISTANT_CONTACT_ID && !isAssistantThreadContactId(contactId)) {
    sendJson(res, 400, { ok: false, error: "contactId 必须是助手线程（assistant 或 assistant:<id>）" });
    return true;
  }
  sendJson(res, 200, { ok: true, pending: pendingActionsFor(contactId) });
  return true;
};

/** POST /api/assistant/pending/:actionId/(confirm|decline)：确认/拒绝危险动作，合成用户消息续跑。 */
export const assistantPendingDecisionRoute: Route = async ({ req, res, path, method }) => {
  if (method !== "POST") return false;
  const m = /^\/api\/assistant\/pending\/([0-9a-f-]{36})\/(confirm|decline)$/.exec(path);
  if (!m) return false;
  const [, actionId = "", decision = ""] = m;
  try {
    const resolved = await resolvePendingAction(actionId, decision === "confirm");
    // 续跑文本对模型是一条普通的用户消息——它由此知道结果并接着说话。
    const note = resolved.executed ? `（用户已确认：${resolved.title}）` : `（用户拒绝了：${resolved.title}）`;
    const { turnId } = getChannel("web")!.receive(note, resolved.contactId, undefined, undefined, undefined);
    sendJson(res, 202, { ok: true, executed: resolved.executed, turnId, result: resolved.result });
  } catch (error) {
    sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

export const routes: Route[] = [
  assistantThreadsGetRoute,
  assistantThreadsCreateRoute,
  assistantThreadsRenameRoute,
  assistantThreadsClearRoute,
  assistantThreadsDeleteRoute,
  assistantPermissionRoute,
  assistantPendingGetRoute,
  assistantPendingDecisionRoute,
];
