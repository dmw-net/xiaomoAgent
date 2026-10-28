import { useEffect, useState } from "react";
import type { Window as TauriWindow } from "@tauri-apps/api/window";

/**
 * 桌面无边框窗口的页内标题栏。
 *
 * 桌面壳把原生标题栏关掉了（lib.rs 的 decorations(false)）——那块实色压在壁纸上
 * 非常突兀，壁纸必须能铺到窗口顶部。这条 36px 的透明条接管了它的全部职责：
 * 拖拽/双击最大化靠 data-tauri-drag-region（Tauri 核心行为），三个按钮走
 * core:window 权限。只在「确实是 Tauri 窗口且确实没有原生装饰」时渲染——
 * 浏览器开发模式和手机端（Tauri 移动壳，窗口由系统管）都不出现。
 */
export default function Titlebar({ context = "" }: { context?: string }): JSX.Element | null {
  const [win, setWin] = useState<TauriWindow | null>(null);
  const [decorated, setDecorated] = useState(true);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      if (cancelled) return;
      setWin(w);
      void w.isDecorated().then((d) => { if (!cancelled) setDecorated(d); });
      void w.isMaximized().then((m) => { if (!cancelled) setMaximized(m); });
      // 最大化/还原是异步的窗口事件：拖到屏幕边缘贴边、Win+方向键都会改变状态，
      // 图标必须跟着窗口走，不能只在自己的按钮点击里翻转。
      void w.onResized(() => {
        void w.isMaximized().then((m) => { if (!cancelled) setMaximized(m); });
      }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (win === null || decorated) return;
    // 布局要知道「顶上让出一条来」：#shell 的高度与下移都吃 --frame-h（见 components.css）
    document.documentElement.classList.add("native-frame");
    return () => document.documentElement.classList.remove("native-frame");
  }, [win, decorated]);

  if (win === null || decorated) return null;

  return (
    <div className="titlebar" data-tauri-drag-region aria-label="窗口标题栏">
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="titlebar-mark" aria-hidden="true" />
        <span className="titlebar-app">小茉</span>
        {context !== "" && (
          <>
            <span className="titlebar-sep" aria-hidden="true">·</span>
            <span className="titlebar-context">{context}</span>
          </>
        )}
      </div>
      <div className="titlebar-btns">
        <button type="button" className="titlebar-btn" title="最小化" aria-label="最小化"
          onClick={() => void win.minimize()}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" /></svg>
        </button>
        <button type="button" className="titlebar-btn" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原" : "最大化"}
          onClick={() => void win.toggleMaximize()}>
          {maximized ? (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.5 3.5h5v5h-5z" />
              <path d="M3.5 3.5V2h5v5H7" fill="none" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5h7v7h-7z" /></svg>
          )}
        </button>
        <button type="button" className="titlebar-btn titlebar-close" title="关闭" aria-label="关闭"
          onClick={() => void win.close()}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
        </button>
      </div>
    </div>
  );
}
