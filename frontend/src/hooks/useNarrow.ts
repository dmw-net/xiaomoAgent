import { useEffect, useState } from "react";

/** 窄屏（手机/矮横屏）判据——默认与 CSS 媒体查询 `(max-width: 760px), (max-height: 520px)` 同一口径。
 *  全应用只有这一条边界：视图内的分区、弹窗、双页流都按它切换，不要再各定各的断点。 */
export function useNarrow(query = "(max-width: 760px), (max-height: 520px)"): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  });
  useEffect(() => {
    try {
      const mq = window.matchMedia(query);
      const paint = (): void => setNarrow(mq.matches);
      mq.addEventListener("change", paint);
      paint();
      return () => { mq.removeEventListener("change", paint); };
    } catch { return undefined; }
  }, [query]);
  return narrow;
}
