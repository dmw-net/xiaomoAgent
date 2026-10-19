import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/useDismiss";

/**
 * 通用弹窗：点遮罩关闭、Esc 关闭、role=dialog + aria-modal。
 * 此前 WeChatSection / ModelSection / MemoryPanel 各写一套，
 * 无障碍语义全缺——收成一个口。
 */
export default function Modal({ onClose, label, className = "", head, children }: {
  onClose: () => void;
  /** 读屏用的弹窗名（一般与标题一致）。 */
  label: string;
  /** 自定义类名（如 about-card / ml-form），与 .modal-card 并列挂在卡片上。 */
  className?: string;
  /** 自带头部（标题行/关闭钮）；不传则不渲染，正文从卡片顶部开始。 */
  head?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  // 卡片本体就是"内部"：点它不关，点遮罩关。开层那一发手势不会被这里看到
  // （useDismiss 听的是 pointerdown，比这个监听器存在更早），所以不需要时间宽限。
  useDismiss(true, onClose, cardRef);
  // 此前弹窗既不给初始焦点也不在关闭后交还：Tab 会溜到遮罩背后，关掉之后
  // 焦点掉回 body，键盘用户得从头走一遍页面。
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    // preventScroll：焦点该进弹窗，但不该因此卷动背景列表
    cardRef.current?.querySelector<HTMLElement>("input:not([disabled]), textarea, button")?.focus({ preventScroll: true });
    // 焦点陷阱：Tab 走到最后一个可聚焦元素就绕回第一个（Shift+Tab 反向）。
    // 只监听卡片内部，不给背景加 inert —— 两个弹窗叠着时不会互相解锁。
    const card = cardRef.current;
    const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex=\"-1\"])";
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || !card) return;
      const items = card.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = items.item(0);
      const last = items.item(items.length - 1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus({ preventScroll: true }); }
    };
    card?.addEventListener("keydown", onKey);
    return () => {
      card?.removeEventListener("keydown", onKey);
      // 这里必须 preventScroll：删一条记录时"来路"那枚按钮已经被摘出 DOM，
      // 把焦点还给它会顺带把容器卷回顶上——实测 scrollTop 1400→0 就是这么来的。
      // 老浏览器不认这个参数也只是忽略它（照旧卷动），不会抛错。
      back?.focus?.({ preventScroll: true });
    };
  }, []);
  // portal 到 body：助手弹窗本体带 transform（居中用的 translate），而 transform 会把
  // 自己变成 position:fixed 后代的包含块——不 portal 出去的话，从弹窗里打开的确认框
  // 遮罩只盖得住弹窗那一块，"模态"就只剩下名字叫模态。
  return createPortal(
    // 遮罩不再自己挂 onClick 关闭：按下遮罩就是 useDismiss 眼里的"点在卡片外部"，
    // 一处判定就够（两处都写会各自演化出宽限期）。
    <div className="modal-overlay">
      <div className={"modal-card" + (className ? " " + className : "")} data-keep-menu ref={cardRef}
        role="dialog" aria-modal="true" aria-label={label}>
        {head}
        {children}
      </div>
    </div>,
    document.body,
  );
}
