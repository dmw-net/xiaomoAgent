import { useLayoutEffect, useState, type RefObject } from "react";

export type AnchoredPopPos = { left: number; bottom: number; width: number };

/**
 * 锚在触发按钮上方的 portal 浮层定位。
 *
 * 为什么不用 CSS absolute：浮层往往比触发按钮宽，留在局部容器里会被
 * overflow:hidden(或滚动容器)裁掉左/右半截。portal 到 body + 按视口钳制
 * 是项目里已经验证过的做法（联系人切换、PickList 同样如此）。
 */
export function useAnchoredPop<T extends HTMLElement>(
  active: boolean,
  anchorRef: RefObject<T | null>,
  preferredWidth: number,
): AnchoredPopPos | null {
  const [pos, setPos] = useState<AnchoredPopPos | null>(null);

  useLayoutEffect(() => {
    if (!active) { setPos(null); return; }
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(preferredWidth, Math.max(120, window.innerWidth - 24));
      const left = Math.min(Math.max(12, rect.right - width), Math.max(12, window.innerWidth - width - 12));
      const bottom = Math.max(12, window.innerHeight - rect.top + 12);
      setPos({ left, bottom, width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, anchorRef, preferredWidth]);

  return pos;
}
