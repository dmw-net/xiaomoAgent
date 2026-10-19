import { useCallback, useRef, useState } from "react";

export type PopPos = { left: number; top: number; flip: boolean };

/**
 * 下拉浮层定位：空间不够且上方放得下就向上翻转。
 * ContactChip 与 ThreadChip 曾逐行重复这段逻辑（review P2-17），这里收口。
 */
export function usePopPosition(width: number, max = 280): {
  setRef: (el: HTMLDivElement | null) => void;
  pos: PopPos;
  place: (count: number, rowHeight: number) => void;
} {
  const elRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopPos>({ left: 0, top: 0, flip: false });
  const setRef = useCallback((el: HTMLDivElement | null): void => { elRef.current = el; }, []);

  const place = useCallback((count: number, rowHeight: number): void => {
    const r = elRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const need = 60 + Math.max(count, 2) * rowHeight;
    const flip = spaceBelow < Math.min(need, max) && r.top > spaceBelow;
    setPos({
      left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
      top: flip ? r.top - 8 : r.bottom + 8,
      flip,
    });
  }, [width, max]);

  return { setRef, pos, place };
}
