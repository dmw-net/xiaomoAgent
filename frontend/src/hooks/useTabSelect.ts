import { useCallback } from "react";

/**
 * role=tablist 的键盘行为，供 Tabs 组件与资料页两组手写 tab 共用。
 *
 * APG 的 tabs 模式要求整组只占一个 Tab 停靠点：未选中项 tabIndex=-1，组内靠
 * ← →（含 ↑ ↓）移动，Home/End 跳首尾。
 *
 * 这里刻意不接收 keys/onSelect：定位到目标 tab 元素后直接 focus + click，
 * 选中走各 tab 本来就有的 onClick。于是调用方只需挂一个 onKeyDown，不必把
 * 自己的键值数组交出来 —— 资料页的分区是按 isAssistant 条件生成的，交出数组
 * 就得在 hook 调用点之上再复制一份那个条件，两处一旦不同步就选中不存在的 tab。
 */
export function useTabSelect(): (e: React.KeyboardEvent<HTMLElement>) => void {
  return useCallback((e: React.KeyboardEvent<HTMLElement>): void => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0 && e.key !== "Home" && e.key !== "End") return;
    const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")];
    if (tabs.length === 0) return;
    e.preventDefault();
    const from = Math.max(0, tabs.findIndex((t) => t === document.activeElement));
    const to = step !== 0
      ? (from + step + tabs.length) % tabs.length
      : e.key === "Home" ? 0 : tabs.length - 1;
    const target = tabs[to];
    if (!target) return;
    target.focus();
    target.click();
  }, []);
}
