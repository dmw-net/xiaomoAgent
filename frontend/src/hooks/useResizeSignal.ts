import { useEffect, type RefObject } from "react";

/** 聊天区有内容异步长高（链接卡、展开详情）时派发；ChatView 靠它补一跳贴底。 */
export const CHAT_RESIZE_EVENT = "xiaomo:chat-resize";

/**
 * 监听元素尺寸变化并广播一个窗口事件。
 *
 * 图片有 load 事件可以兜底，但链接卡从「加载中」变成「有标题/描述」只会让卡片自己重渲染，
 * ChatView 的 layout effect 依赖没有变化，于是贴底逻辑不会跑；最新内容会被顶到视口外。
 * 用 ResizeObserver 把「长高了」这件事广播出去，比在 ChatView 里猜哪些节点会变可靠。
 */
export function useResizeSignal(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      window.dispatchEvent(new CustomEvent(CHAT_RESIZE_EVENT));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}
