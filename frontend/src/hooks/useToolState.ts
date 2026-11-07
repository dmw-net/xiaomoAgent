// 订阅工具台账快照的最小 hook：挂载时拿缓存先渲染，没有缓存再拉一次。
//
// 写方（设置台账、助手控制台）不要用这个——它们要每次挂载都看到最新，
// 自己调 toolsStore.loadToolState()；这里服务的是读方（聊天卡的动作短语、
// 联系人页的档位文案），缓存优先、零打扰。

import { useEffect, useState } from "react";
import { cachedToolState, ensureToolState } from "../lib/toolsStore";
import type { ToolState } from "../api/tools";

/** null = 还没读到（调用方显示兜底或「读取中」，别拿空目录渲染选项）。 */
export function useToolState(): ToolState | null {
  const [state, setState] = useState<ToolState | null>(() => cachedToolState());
  useEffect(() => {
    let alive = true;
    ensureToolState()
      .then((next) => { if (alive) setState(next); })
      .catch(() => undefined); // 读不到就用兜底文案，聊天卡不因一次请求失败而坏
    return () => { alive = false; };
  }, []);
  return state;
}
