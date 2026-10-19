import { useEffect, useRef } from "react";

/**
 * 把「详情页」（窄屏会话页、资料页等）接进浏览器历史：
 * 进入时压一条带自己 key 的 history 条目，系统/浏览器返回键先弹掉它并回退到上一层，
 * 而不是直接退出网站；页内返回按钮收起详情时，替用户把这条历史消费掉。
 * 多层叠加（会话页 → 资料页）各压各的 key：弹掉上层时只有上层响应。
 */
export function useDetailHistory(key: string, active: boolean, goBack: () => void): void {
  const backRef = useRef(goBack);
  backRef.current = goBack;
  useEffect(() => {
    if (!active) return;
    let consumedBySystem = false;
    const pushedHash = location.hash;
    history.pushState({ ...(history.state ?? {}), [key]: true }, "");
    const onPop = (e: PopStateEvent): void => {
      if ((e.state as Record<string, boolean> | null)?.[key]) return; // 弹掉的是更上层的详情页，与本层无关
      consumedBySystem = true;
      backRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // 只有「页内按钮退的」才替用户把压入的那条清掉。hash 已经变了说明是跨视图跳转
      // （去设置、切状态页），此时新视图的条目就压在上面——再 back() 会把 URL 拽回
      // 旧的 #/chat，hashchange 又把视图改回来，用户看到的是设置页一闪即被弹回对话。
      if (!consumedBySystem && location.hash === pushedHash) history.back();
    };
  }, [active, key]);
}
