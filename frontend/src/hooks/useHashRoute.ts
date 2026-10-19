import { useCallback, useEffect, useState } from "react";
import type { ViewKey } from "../types";

const VIEWS = "chat|status|settings";

/**
 * hash 路由：旧链接、刷新恢复、浏览器后退都靠它。
 * 认不出的 hash（含已下线的 /#/memory、/#/tasks、/#/assistant）落回默认视图，不报错。
 * 返回 [当前视图, 导航函数]；导航时同步 hash，外部 hash 变化（后退键）也能跟上。
 */
export function useHashRoute(): [ViewKey, (key: ViewKey) => void] {
  const [view, setView] = useState<ViewKey>(() => {
    const m = location.hash.match(new RegExp("^#\\/(" + VIEWS + ")"));
    return (m?.[1] as ViewKey) ?? "chat";
  });

  useEffect(() => {
    const apply = (): void => {
      const m = location.hash.match(new RegExp("^#\\/(" + VIEWS + ")"));
      if (m) setView(m[1] as ViewKey);
    };
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // 稳定引用：调用方要把它放进 useCallback/useEffect 依赖里，
  // 每次渲染换一个新函数会让下游整条链跟着重跑。
  const navigate = useCallback((key: ViewKey): void => {
    if (location.hash !== "#/" + key) location.hash = "#/" + key;
    setView(key);
  }, []);

  return [view, navigate];
}
