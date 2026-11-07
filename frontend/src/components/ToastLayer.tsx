import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getToasts, subscribeToasts } from "../lib/toast";

/**
 * 全局轻提示的宿主：挂在 App 根上（挨着 <UndoBar />），portal 到 body。
 * 为什么 portal 到 body：设置/资料等视图容器可能带 transform，会把自己变成
 * position:fixed 后代的包含块，浮层留在原地会被裁进那一块（ChatView 的轻提示
 * 注释里踩过同一个坑）。
 *
 * 为什么 z-index 单独抬到 --z-toast：foundation.css 的 .toast-layer 用的是
 * --z-chat-pop（会话视图自己的浮层层级），全局这条要盖过设置页里的居中弹窗
 * （危险确认 Modal），否则「确认删除 → 失败提示」会被弹窗压住。
 */
export default function ToastLayer(): JSX.Element | null {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (items.length === 0) return null;
  return createPortal(
    <div className="toast-layer toast-layer-app" role="status" aria-live="polite">
      {items.map((n) => (
        // 视觉上 foundation.css 只立了 ok / warn 两档：error 先借 warn 的红底，
        // kind 保留语义，等以后真需要第三档视觉再分化，不让 store 背样式债。
        <div key={n.id} className={"toast" + (n.kind === "ok" ? "" : " warn")}>{n.text}</div>
      ))}
    </div>,
    document.body,
  );
}
