import { useEffect, useState } from "react";
import { REVEAL_CHARS_PER_TICK, REVEAL_REDUCED_CHARS, REVEAL_TICK_MS, revealStep } from "../lib/live-reveal";

/**
 * 把「收到的草稿」演成「正在打的字」。
 *
 * active=false（这一轮不在飞）就返回空串：不留残稿，也不给历史气泡补动画——
 * 历史那些是定稿，重排一次就够。
 * prefers-reduced-motion 下不是整段直出，而是照打但快一档（见 REVEAL_REDUCED_CHARS 的说明）：
 * 一坨文本砸出来再静一秒正是用户报的僵硬，而"减少动效"该管的是那个闪烁光标——CSS 里关掉了。
 */
export function useLiveReveal(target: string, active: boolean): { text: string; done: boolean } {
  const [shown, setShown] = useState("");
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 一轮结束或换轮时会先把 target 清空。这里必须把进度也归零，否则下一条
  // 如果恰好以相同的几个字开头（甚至内容完全相同），会直接跳过打字。
  useEffect(() => {
    if (!active || target === "") setShown("");
  }, [active, target]);
  const done = active && target !== "" && shown === target;

  useEffect(() => {
    if (!active || done) return;
    const per = reduced ? REVEAL_REDUCED_CHARS : REVEAL_CHARS_PER_TICK;
    const timer = setInterval(() => setShown((s) => revealStep(target, s, per)), REVEAL_TICK_MS);
    return () => clearInterval(timer);
  }, [active, done, reduced, target]);

  return { text: active ? shown : "", done };
}
