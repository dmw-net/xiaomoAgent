import { useEffect, type RefObject } from "react";

/**
 * 点外部 / 按 Esc 关闭浮层（下拉、菜单、弹窗共用这一个口）。
 *
 * 为什么监听 **pointerdown** 而不是 click：浮层的 opener 在 click 里 setState，
 * React 处理完就把这个监听挂上了，而**同一发 click 还在往 document 冒泡** ——
 * 于是"刚点开就被自己关掉"，用户看到的是点了没反应。这不是浏览器那个 300ms
 * ghost click（`touch-action: manipulation` 早就把它消掉了），是同一发手势被
 * 两个监听器看到。换成 pointerdown 之后：打开那一发的 pointerdown 早于监听器存在，
 * 结构上不可能被抓到，所以也不需要任何时间宽限期。
 *
 * root：把"触发点 + 浮层本体"包在一个 wrapper 上并把 ref 交给这里，内部点击就不算外部。
 * 但 portal 到 body 的浮层（下拉、弹窗卡片）不在 root 子树里，只认 root 会把它们当成"外部"——
 * 于是从助手弹窗里点开工作区下拉，整层跟着关掉，而下拉自己还挂在 body 上没消失。
 * 所以带 `data-keep-menu` 标记的浮层本体一律算内部，root 再兜住内联后代（两者取并集）。
 * 判定必须走 composedPath：React 离散事件会同步重渲染，被点的旧节点（如图标 svg）
 * 可能在事件冒泡出去前就被摘出 DOM，那时 e.target.closest 会沿断掉的链找不到归属。
 */
export function useDismiss(
  active: boolean,
  onClose: () => void,
  root?: RefObject<Element | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const inside = (path: EventTarget[]): boolean => {
      if (path.some((n) => n instanceof Element && n.hasAttribute("data-keep-menu"))) return true;
      return !!root?.current && path.includes(root.current);
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (inside(e.composedPath())) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, onClose, root]);
}
