import { useCallback, useRef } from "react";

/**
 * 竖向分隔条：拖动调整 --side-w（联系人中栏与助手工作区列表共用这一个宽度），
 * 松手后写 localStorage。fixed 定位贴在对应列的右缘，窄屏由 CSS 隐藏。
 */
export default function Splitter({ left }: { left: string }): JSX.Element {
  const startRef = useRef<{ x: number; w: number } | null>(null);

  const current = (): number =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-w")) || 248;

  /** 键盘与鼠标共用一条落点：夹在 200~420，写进 --side-w。 */
  const applyWidth = useCallback((w: number): void => {
    document.documentElement.style.setProperty("--side-w", Math.min(420, Math.max(200, w)) + "px");
  }, []);

  const persist = (): void => {
    localStorage.setItem("xiaomo.sideWidth", getComputedStyle(document.documentElement).getPropertyValue("--side-w").trim() || "248px");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === "PageUp" || e.key === "PageDown" ? 64 : 16;
    if (e.key === "ArrowRight") applyWidth(current() + step);
    else if (e.key === "ArrowLeft") applyWidth(current() - step);
    else if (e.key === "Home") applyWidth(248);
    else return;
    e.preventDefault();
    persist();
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add("on");
    // 捕获指针：触屏上浏览器接管手势时发的是 pointercancel 而不是 pointerup，
    // 不捕获就会留下 window 上的 move/up 监听和 startRef——之后的触摸还在改宽度。
    try { el.setPointerCapture(e.pointerId); } catch { /* 老 WebView 不支持，退回 window 监听 */ }
    startRef.current = { x: e.clientX, w: current() };
    const move = (ev: PointerEvent): void => {
      if (!startRef.current) return;
      applyWidth(startRef.current.w + ev.clientX - startRef.current.x);
    };
    const up = (): void => {
      startRef.current = null;
      el.classList.remove("on");
      persist();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className="side-splitter" style={{ left }} title="拖动调整列表宽度"
      role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label="调整联系人列表宽度（左右方向键各 16px，Home 恢复默认）"
      onPointerDown={onDown} onKeyDown={onKeyDown} />
  );
}
