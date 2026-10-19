import { cq, getJson, postJson } from "./client";
import type { GateState, TaskRow } from "../types";

/** cid 省略时跟随全局当前联系人；联系人资料页内嵌面板显式传入。 */

/** 202 回执：检查在后台跑，结果靠刷新任务列表/消息看（与 /api/say 同一纪律）。 */
export function runProactiveCheck(cid?: string): Promise<{ started: boolean; note?: string }> {
  return postJson(cq("/api/proactive/run", cid));
}
/** state 分查「待执行 / 已执行」；limit/offset 走统一的那一档（从前这里写死 40，
 *  而服务端只发 LIMIT 不发 total —— 取满就静默到底）。 */
export function fetchProactiveTasks(limit: number, offset = 0, state?: "pending" | "history", cid?: string):
  Promise<{ tasks: TaskRow[]; total: number }> {
  return getJson(cq("/api/proactive/tasks?limit=" + limit + "&offset=" + offset
    + (state ? "&state=" + state : ""), cid));
}

export function cancelProactiveTask(id: number, cid?: string): Promise<unknown> {
  return postJson(cq("/api/proactive/tasks/" + id + "/cancel", cid));
}

/** 用户自己立一条计划：reminder = 到点原样送到（必定说），care = 到点她想想要不要说。 */
export function createProactiveTask(input: { kind: "care" | "reminder"; focus: string; dueAt: number }, cid?: string):
  Promise<{ task: TaskRow; note?: string }> {
  return postJson(cq("/api/proactive/tasks", cid), input);
}

/** 撤销取消：只有 status=cancelled 的行放得回去。 */
export function restoreProactiveTask(id: number, cid?: string): Promise<unknown> {
  return postJson(cq("/api/proactive/tasks/" + id + "/restore", cid));
}

/** 闸门评估结果挂在状态接口的 proactive 段里，同样按联系人返回。 */
export function fetchProactiveGates(cid?: string): Promise<GateState | null> {
  return getJson<{ proactive?: GateState }>(cq("/api/status", cid)).then((d) => d.proactive ?? null);
}
