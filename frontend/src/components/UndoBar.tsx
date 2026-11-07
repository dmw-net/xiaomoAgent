import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Undo2, X } from "lucide-react";
import { dismissUndo, getUndo, subscribeUndo, takeUndo, type UndoItem } from "../lib/undo";

/** 退场动画兜底时长：undoOut 是 --dur-base（.18s），留一点余量。 */
const EXIT_FALLBACK_MS = 240;

/**
 * 「已删除 · 撤销」这条反悔栏。全局挂在 App 上、浮在屏幕下缘：
 * 它必须出现在"刚做完事的那一眼"里，跟着某个列表排在末尾，长列表一滚就看不见
 * （窄屏实测：18 张记忆卡时那条栏落在 top:2810，等于没有）。
 * 一处 store 一个出口，同一时刻只有一条待撤销。
 *
 * 退场也做了交接：store 清掉 current 后组件并不能立刻卸载——先用 ref 拽住
 * 最后一条渲染 data-closing 的淡出帧，动画走完（或兜底时长到）才真正消失。
 * 收起期间 aria-hidden，读屏不会把同一条内容听两遍；新提示在退场中途到来时
 * 直接顶掉旧内容（key 变化重放入场动画），不让用户等一场没人看的谢幕。
 */
export default function UndoBar(): JSX.Element | null {
  const item = useSyncExternalStore(subscribeUndo, getUndo, getUndo);
  const [shown, setShown] = useState<UndoItem | null>(item);
  const exitTimer = useRef<number | null>(null);

  useEffect(() => {
    if (item !== null) {
      if (exitTimer.current !== null) { window.clearTimeout(exitTimer.current); exitTimer.current = null; }
      setShown(item);
      return;
    }
    if (shown === null) return;
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      setShown(null);
    }, EXIT_FALLBACK_MS);
    return () => {
      if (exitTimer.current !== null) { window.clearTimeout(exitTimer.current); exitTimer.current = null; }
    };
  }, [item, shown]);

  if (shown === null) return null;
  const closing = item === null;
  return (
    <div
      className="undo-bar"
      role="status"
      aria-live="polite"
      aria-hidden={closing || undefined}
      data-closing={closing || undefined}
      key={shown.id}
    >
      <span className="t">{shown.text}</span>
      <button type="button" className="undo-act" onClick={() => takeUndo()} tabIndex={closing ? -1 : 0}>
        <Undo2 size={13} strokeWidth={1.9} />撤销
      </button>
      {/* 关掉不等于撤销：只把这条提示收走 */}
      <button type="button" className="undo-x" aria-label="关掉这条提示" onClick={dismissUndo} tabIndex={closing ? -1 : 0}>
        <X size={13} />
      </button>
    </div>
  );
}
