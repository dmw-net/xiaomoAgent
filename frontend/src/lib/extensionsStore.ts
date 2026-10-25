// 扩展快照（/api/extensions）的模块级缓存。
//
// 形状沿用 capsStore 的收口思路：设置页是唯一的写者，但状态页等处也读；
// 有缓存先立刻用，同一时刻只放一个在飞请求，写动作之后整份作废。
// 与 caps 的差别：扩展数据自带全量清单（不是一排布尔），缓存存的就是快照对象。

import { getJson } from "../api/client";
import type { ExtensionSnapshot } from "../types";

let cache: ExtensionSnapshot | null = null;
let flying: Promise<ExtensionSnapshot> | null = null;

/** null = 还没拉到过（界面显示「读取中…」，不要拿空快照冒充）。 */
export function cachedSnapshot(): ExtensionSnapshot | null {
  return cache;
}

export function loadSnapshot(): Promise<ExtensionSnapshot> {
  if (flying) return flying;
  flying = getJson<ExtensionSnapshot & { ok: true }>("/api/extensions")
    .then((r) => {
      cache = { allowScripts: r.allowScripts, extensions: r.extensions };
      return cache;
    })
    .finally(() => { flying = null; });
  return flying;
}

export function invalidateSnapshot(): void {
  cache = null;
}
