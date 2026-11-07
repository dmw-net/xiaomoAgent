// 工具台账状态（/api/tools）的模块级缓存。
//
// 形状沿用 extensionsStore 的收口思路：写动作（设置页）的回包就是整份新快照，
// 直接收下不再发 GET；读方各自决定要不要新鲜数据。这份数据以前被设置台账和
// 助手控制台各持一份本地副本，跨视图互不同步——现在全部走这里。
//
// 读方三种：
// - 台账 / 控制台挂载：loadToolState() 强制拉新（它们是写方，必须看到最新）；
// - 聊天工具卡、联系人页档位：cachedToolState() / ensureToolState() 缓存优先，
//   App 启动时预热一次，之后基本零请求；
// - 写方落笔：putToolState(next) 把回包灌回缓存，别的视图下次读到的就是新值。

import { getJson } from "../api/client";
import type { ToolCatalogEntry, ToolState } from "../api/tools";

let cache: ToolState | null = null;
let flying: Promise<ToolState> | null = null;

/** null = 还没拉到过（界面据此显示「读取中…」，别拿空目录冒充）。 */
export function cachedToolState(): ToolState | null {
  return cache;
}

/** 强制拉新：同一时刻只放一个在飞请求，多个挂载共享同一次往返。 */
export function loadToolState(): Promise<ToolState> {
  if (flying) return flying;
  flying = getJson<ToolState & { ok: true }>("/api/tools")
    .then((r) => { cache = r; return r; })
    .finally(() => { flying = null; });
  return flying;
}

/** 缓存优先：有缓存直接用（聊天卡只要动作短语，陈旧几秒无感），没有才拉一次。 */
export function ensureToolState(): Promise<ToolState> {
  if (cache !== null) return Promise.resolve(cache);
  return loadToolState();
}

/** 写动作的回包就是整份新快照：直接收下，别的视图下次读到的就是新值。 */
export function putToolState(next: ToolState): void {
  cache = next;
}

export function invalidateToolState(): void {
  cache = null;
}

/** 聊天工具卡的动作短语表：后端 TOOL_META 的 chat 字段是唯一真源，
 *  前端不再维护第二份工具名 → 短语映射（那份复刻漏登记时会把 JSON 甩给用户）。 */
export function chatLabelsOf(state: ToolState | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (state === null) return map;
  for (const tool of state.tools as ToolCatalogEntry[]) {
    if (typeof tool.chat === "string" && tool.chat !== "") map[tool.name] = tool.chat;
  }
  return map;
}
