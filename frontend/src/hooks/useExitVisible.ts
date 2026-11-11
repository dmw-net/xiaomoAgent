import { useCallback, useEffect, useRef, useState, type AnimationEvent } from "react";

/**
 * 退场动画兜底时长：各弹层退场都是 --dur-fast/.12s 或 --dur-base/.18s，
 * 留一点余量，与 Modal / UndoBar 的既有值保持一致。
 */
export const EXIT_FALLBACK_MS = 240;

/**
 * 弹层退场动画的共享计时器（Modal / UndoBar 的退场交接也走这里）。
 *
 * 入场动画由 CSS 自己播，退场却做不到「卸载了再播」——节点一摘动画就没了，
 * 所以关闭时必须先留几帧淡出，播完才真正卸载。这里收成一个口，所有弹层复用：
 *
 *   const { visible, closing, onAnimationEnd } = useExitVisible(open, "menuOut");
 *
 * - visible：弹层此刻是否还该挂在树上。条件挂载的弹层把渲染条件从
 *   `open && …` 换成 `visible && …` 即可，其余 setOpen(false) 的路径
 *   （点选项、useDismiss、Esc）一行都不用改——它们只是把 open 置假，
 *   退场帧由这里接管。
 * - closing：退场帧期间为真。挂到 data-closing 上（CSS 据此播退场动画、
 *   关掉 pointer-events），顺带驱动 aria-hidden 与交互钮 tabIndex=-1 防误触。
 *   useDismiss(open) 这类「开着才生效」的监听随 open 置假自动停用，
 *   动画途中不会再次触发关闭回调。
 * - onAnimationEnd：退场动画播完提前收场，不等兜底计时。必须按动画名过滤——
 *   弹层内部的动画（loader 旋转、骨架屏呼吸）也会冒泡上来，不能听见响就谢幕。
 *
 * 兜底 setTimeout 覆盖 animationend 永远不来的情形：reduced-motion 下
 * theme.css 把 --dur-* 压成 .01ms、部分弹层干脆 animation:none，没有事件可听；
 * 退场中途重开则掐掉计时器立即回到完整在场，不让用户等一场没人看的谢幕。
 */
export function useExitVisible(open: boolean, exitAnimation?: string, exitMs: number = EXIT_FALLBACK_MS): {
  /** 弹层是否还该渲染（open 为真，或退场动画还没走完）。 */
  visible: boolean;
  /** 退场帧期间为真：驱动 data-closing / aria-hidden / tabIndex=-1。 */
  closing: boolean;
  /** 挂在弹层根节点上：退场动画结束（按名字过滤）提前收场。 */
  onAnimationEnd: (e: AnimationEvent) => void;
} {
  // shown 记住「该渲染」这件事本身：open 置假后它仍为真，撑住退场帧，
  // 到点（或动画播完）才落回假——UndoBar 用 ref 拽住最后一条数据的同款思路。
  const [shown, setShown] = useState(open);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finish = useCallback((): void => {
    clearTimer();
    setShown(false);
  }, [clearTimer]);

  useEffect(() => {
    if (open) {
      clearTimer();
      setShown(true);
      return;
    }
    if (!shown) return;
    timerRef.current = window.setTimeout(finish, exitMs);
    return clearTimer;
  }, [open, shown, exitMs, finish, clearTimer]);

  const onAnimationEnd = useCallback((e: AnimationEvent): void => {
    if (exitAnimation === undefined) return;
    // 只认弹层根节点自己播完的退场动画；内部元素的动画一律忽略。
    if (e.target !== e.currentTarget) return;
    if (e.animationName !== exitAnimation) return;
    finish();
  }, [exitAnimation, finish]);

  return { visible: open || shown, closing: !open && shown, onAnimationEnd };
}
