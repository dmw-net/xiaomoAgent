import { useSyncExternalStore } from "react";
import { Undo2, X } from "lucide-react";
import { dismissUndo, getUndo, subscribeUndo, takeUndo } from "../lib/undo";

/**
 * 「已删除 · 撤销」这条反悔栏。全局挂在 App 上、浮在屏幕下缘：
 * 它必须出现在"刚做完事的那一眼"里，跟着某个列表排在末尾，长列表一滚就看不见
 * （窄屏实测：18 张记忆卡时那条栏落在 top:2810，等于没有）。
 * 一处 store 一个出口，同一时刻只有一条待撤销。
 */
export default function UndoBar(): JSX.Element | null {
  const item = useSyncExternalStore(subscribeUndo, getUndo, getUndo);
  if (item === null) return null;
  return (
    <div className="undo-bar" role="status" aria-live="polite" key={item.id}>
      <span className="t">{item.text}</span>
      <button type="button" className="undo-act" onClick={() => takeUndo()}>
        <Undo2 size={13} strokeWidth={1.9} />撤销
      </button>
      {/* 关掉不等于撤销：只把这条提示收走 */}
      <button type="button" className="undo-x" aria-label="关掉这条提示" onClick={dismissUndo}>
        <X size={13} />
      </button>
    </div>
  );
}
