/**
 * 滚动中给滚动容器挂 `is-scrolling`，让 hover 反馈整体失效。
 *
 * 快速滚动时指针不动、内容从指针下经过，`:hover` 反复挂摘——聊天气泡的描边、
 * 设置页卡片与 chip 的边框都会因此一闪一闪（用户报的「描边闪 / 边框闪」，
 * 实测一段滚轮里气泡描边换了 6 次行）。停滚 150ms 后摘类，
 * 「停下来看某一条」的 hover 暗示仍然有效。
 *
 * 为什么用 pointer-events 而不是逐条覆盖 hover 规则：全站有约 40 条
 * 「hover 改 border / outline / translate」的规则，逐条重置既漏又脆；
 * 把滚动容器的直接子代 pointer-events 关掉，一行覆盖全部，且子代没有
 * 显式设 pointer-events，继承即可。滚动容器本身保持 auto，滚轮照样滚动。
 *
 * scroll 事件不冒泡，必须用捕获阶段才能接到所有滚动容器。
 */
import { useEffect } from "react";

export function useScrollHoverLock(): void {
  useEffect(() => {
    const scrolling = new Set<Element>();
    let timer: number | null = null;
    const onScroll = (e: Event): void => {
      const el = e.target;
      // document / window 也会派发 scroll，它们没有 classList。
      if (!(el instanceof Element)) return;
      scrolling.add(el);
      el.classList.add("is-scrolling");
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        for (const s of scrolling) s.classList.remove("is-scrolling");
        scrolling.clear();
      }, 150);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (timer !== null) window.clearTimeout(timer);
      for (const s of scrolling) s.classList.remove("is-scrolling");
      scrolling.clear();
    };
  }, []);
}
