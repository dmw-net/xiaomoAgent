import { cq, getJson, postJson } from "../api/client";
import type { StatusData } from "../types";

/**
 * 状态页总览（/api/status）的模块级缓存。
 *
 * 服务端算这一份只要 5ms，慢的全是网络往返：视图是条件渲染的，切走即卸载，
 * 组件里的 state 一起被扔掉，切回来只能从零再走一遍「读取中…」——穿透访问时
 * 那是一个完整的往返（实测 142ms）。缓存放到组件外面，重入时先拿上次的值立刻
 * 渲染，同时在后台换新的（stale-while-revalidate）。
 *
 * 按联系人分档：/api/status 里的记忆条数、主动性闸门都是按当前会话那位算的。
 */

const cache = new Map<string, StatusData>();
const flying = new Map<string, Promise<StatusData>>();

/** null = 这位联系人一次都还没拉到过，界面显示「读取中…」。 */
export function cachedStatus(contactId: string): StatusData | null {
  return cache.get(contactId) ?? null;
}

export function loadStatus(contactId: string): Promise<StatusData> {
  // 连点「刷新」或重入视图都不该叠出并发请求。
  const inflight = flying.get(contactId);
  if (inflight) return inflight;
  const p = getJson<StatusData>(cq("/api/status", contactId))
    .then((d) => { cache.set(contactId, d); return d; })
    .finally(() => { flying.delete(contactId); });
  flying.set(contactId, p);
  return p;
}

/**
 * 「重新计数」：把失败读数的起点挪到现在，红点清零，然后重拉一次状态。
 * 后端只动水印与记忆提取的连续失败计数器，model_calls 一条不删。
 */
export async function resetCounters(contactId: string): Promise<StatusData> {
  await postJson<{ ok: boolean }>("/api/status/reset-counters", {});
  cache.delete(contactId);
  return loadStatus(contactId);
}

/** 设置里改了模型之后调用：总览里的模型档、就绪状态都跟着作废。 */
export function invalidateStatus(): void {
  cache.clear();
}
