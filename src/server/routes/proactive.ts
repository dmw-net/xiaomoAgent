// 主动性：联系人主动惦记的事（任务台账/手动检查/取消与撤销取消）。
// 顺序敏感（与原 handle() 一致）：status → run → tasks GET → tasks POST →
// tasks/:id/cancel → tasks/:id/restore。

import { config } from "../../core/config.ts";
import {
  cancelProactiveTask,
  countProactiveTasks,
  createProactiveTask,
  inspectGates,
  listProactiveTasks,
  restoreProactiveTask,
  runProactiveCheck,
} from "../../mind/proactive.ts";
import { leaseIsFreeOrOurs } from "../../core/instance.ts";
import { clampInt, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, readJson, sendJson } from "../http.ts";
import { strictContactId } from "../context.ts";
import type { Route } from "../types.ts";

/** GET /api/proactive/status：主动性门（免打扰/时段/总开关）与启用状态。 */
export const proactiveStatusRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/proactive/status")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  sendJson(res, 200, { ok: true, contactId, ...inspectGates(contactId), enabled: config.proactive.enabled });
  return true;
};

/** POST /api/proactive/run：手动触发一次检查（立刻 202，判断在后台跑）。
 *  只有当家进程能跑：主动性会**真的把话说出去**（并镜像到微信/QQ、吃掉每日配额）。 */
export const proactiveRunRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "POST" && path === "/api/proactive/run")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  // 从前这条不看租约，于是桌面端 + 终端各点一次「立即检查」，两边都通过
  // spokenCountToday()===0 的门，同一句话投递两次、日配额翻倍。只有租约挡得住跨进程。
  if (!leaseIsFreeOrOurs()) {
    sendJson(res, 409, { ok: false, code: "NOT_PRIMARY", error: "另一个实例正在跑主动性（同一份数据只能有一个当家的），这一边只提供界面与接口" });
    return true;
  }
  // 与 /api/say 同一纪律：立刻 202，判断（可能要等模型 30s+）在后台跑，前端轮询看结果。
  void runProactiveCheck(contactId, "manual").catch((error) => {
    console.warn(`[proactive] 手动检查失败：${error instanceof Error ? error.message : String(error)}`);
  });
  sendJson(res, 202, { ok: true, contactId, started: true, note: "已在后台开始检查，稍后刷新看结果" });
  return true;
};

/** GET /api/proactive/tasks：任务留痕（联系人惦记着什么、上次为什么说/没说、失败原因）。 */
export const proactiveTasksListRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/proactive/tasks")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  // 从前只有 LIMIT、没有 offset 也没有 total：实测小茉 91 条、阿琳 67 条，
  // 界面写死 40 就等于把后一半永久藏起来，还不报一句。
  const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  // state 让「待执行」与「执行记录」各查各的：混着翻页时，一条排得靠后的待执行
  // 计划会掉出第一页，界面那个页签就空了。
  const state = url.searchParams.get("state") === "pending" ? "pending"
    : url.searchParams.get("state") === "history" ? "history" : undefined;
  sendJson(res, 200, {
    ok: true, contactId, offset, state: state ?? "all", total: countProactiveTasks(contactId, state),
    tasks: listProactiveTasks(contactId, limit, offset, state),
  });
  return true;
};

/** POST /api/proactive/tasks：用户自己立一条计划。到点由调度器准时唤醒：
 *  reminder 在那一刻原样发出，care 在那一刻判断该不该开口（见 mind/proactive.ts）。 */
export const proactiveTasksCreateRoute: Route = async ({ req, res, url, path, method }) => {
  if (!(method === "POST" && path === "/api/proactive/tasks")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const body = await readJson<Record<string, unknown>>(req);
  let task;
  try {
    task = createProactiveTask(contactId, { kind: body.kind, focus: body.focus, dueAt: body.dueAt });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  sendJson(res, 200, { ok: true, task, note: "已加进待执行计划" });
  return true;
};

/** POST /api/proactive/tasks/:id/cancel：取消一条还没执行的打算（只有 pending 能取消）。 */
export const proactiveTaskCancelRoute: Route = ({ res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/proactive\/tasks\/(\d+)\/cancel$/) : null;
  if (!m) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const cancelled = cancelProactiveTask(Number(m[1]), contactId);
  if (!cancelled) {
    sendJson(res, 404, { ok: false, error: "任务不存在，或已执行/已取消" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "已取消这条打算", tasks: listProactiveTasks(contactId, 20) });
  return true;
};

/** POST /api/proactive/tasks/:id/restore：撤销取消（反悔窗口用，见前端 offerUndo）。 */
export const proactiveTaskRestoreRoute: Route = ({ res, url, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/proactive\/tasks\/(\d+)\/restore$/) : null;
  if (!m) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  if (!restoreProactiveTask(Number(m[1]), contactId)) {
    sendJson(res, 404, { ok: false, error: "这条打算不是被取消的状态，放不回去" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "已放回待执行", tasks: listProactiveTasks(contactId, 20) });
  return true;
};

export const routes: Route[] = [
  proactiveStatusRoute,
  proactiveRunRoute,
  proactiveTasksListRoute,
  proactiveTasksCreateRoute,
  proactiveTaskCancelRoute,
  proactiveTaskRestoreRoute,
];
