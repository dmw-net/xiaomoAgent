import { useCallback, useEffect, useRef } from "react";

/**
 * 长按手势（手机端等价于右键）。500ms 触发；有文字选中时不算（拖选复制优先）。
 * 返回可直接铺到元素上的 touch 事件处理器。
 */
export function useLongPress(onLongPress: (x: number, y: number) => void, delay = 500): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
  onTouchCancel: () => void;
} {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cbRef = useRef(onLongPress);
  cbRef.current = onLongPress;

  const clear = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  return {
    onTouchStart: useCallback((e: React.TouchEvent): void => {
      const touch = e.touches[0];
      if (!touch) return;
      // 第二个触点落下时先清掉前一个定时器：否则它失去引用、clear 再也够不到，
      // 手指全离开后仍会到点弹出菜单。
      clear();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const sel = window.getSelection ? window.getSelection() : "";
        if (sel && String(sel) !== "") return;
        if (navigator.vibrate) navigator.vibrate(12);
        cbRef.current(touch.clientX, touch.clientY + 8);
      }, delay);
    }, [delay, clear]),
    onTouchEnd: clear,
    onTouchMove: clear,
    onTouchCancel: clear,
  };
}
