import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/useDismiss";

/** 多层弹窗共享一个页面滚动锁；计数器避免内层关闭时误解锁外层。 */
let openModalCount = 0;

/** 退场动画兜底时长：遮罩/卡片都是 --dur-base（.18s），留一点余量。 */
const EXIT_FALLBACK_MS = 240;

/**
 * 通用弹窗：点遮罩关闭、Esc 关闭、role=dialog + aria-modal。
 * 此前 WeChatSection / ModelSection / MemoryPanel 各写一套，
 * 无障碍语义全缺——收成一个口。
 */
export default function Modal({ onClose, label, className = "", head, children, placement = "sheet" }: {
  onClose: () => void;
  /** 读屏用的弹窗名（一般与标题一致）。 */
  label: string;
  /** 自定义类名（如 about-card / ml-form），与 .modal-card 并列挂在卡片上。 */
  className?: string;
  /** 自带头部（标题行/关闭钮）；不传则不渲染，正文从卡片顶部开始。 */
  head?: ReactNode;
  children: ReactNode;
  /** 桌面端都是居中；sheet 只在手机端贴底，center 给确认类短弹窗保持居中。 */
  placement?: "sheet" | "center";
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    openModalCount += 1;
    document.documentElement.classList.add("modal-open");
    return () => {
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0) document.documentElement.classList.remove("modal-open");
    };
  }, []);
  // 退场动画：入场有 scrimIn/cardIn，关闭以前是瞬时消失——Quiet Studio 的收尾
  // 突兀感是全站最明显的动效缺口。挂上 data-closing 先播淡出，动画结束（或
  // EXIT_FALLBACK_MS 兜底，覆盖 reduced-motion 下 animation:none 的情形）才真正
  // 卸载。遮罩点击 / Esc 这两条内部收口走 requestClose；children 里按钮直接调
  // parent 的 onClose 的路径保持原样瞬时关——那是调用方语义，不强行拦。
  const [closing, setClosing] = useState(false);
  const finishedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = (): void => {
    if (!finishedRef.current) setClosing(true);
  };
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => { finishedRef.current = true; onCloseRef.current(); }, EXIT_FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [closing]);
  // 卡片本体就是"内部"：点它不关，点遮罩关。开层那一发手势不会被这里看到
  // （useDismiss 听的是 pointerdown，比这个监听器存在更早），所以不需要时间宽限。
  useDismiss(!closing, requestClose, cardRef);
  // 此前弹窗既不给初始焦点也不在关闭后交还：Tab 会溜到遮罩背后，关掉之后
  // 焦点掉回 body，键盘用户得从头走一遍页面。
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    // preventScroll：焦点该进弹窗，但不该因此卷动背景列表
    const firstField = cardRef.current?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled])");
    const firstAction = cardRef.current?.querySelector<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex=\"-1\"])");
    (firstField ?? firstAction)?.focus({ preventScroll: true });
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
    // data-closing 由退场动画消费（scrimOut/cardOut）；animationend 名字过滤是
    // 因为卡片内部也可能有动画冒泡上来（骨架屏呼吸、loader 旋转）。
    <div
      className={"modal-overlay" + (placement === "center" ? " is-center" : "")}
      data-closing={closing || undefined}
      aria-hidden={closing || undefined}
      onAnimationEnd={(e) => {
        if (!closing) return;
        if (e.target === e.currentTarget && e.animationName === "scrimOut") {
          finishedRef.current = true;
          onCloseRef.current();
        }
      }}
    >
      <div className={"modal-card" + (className ? " " + className : "")} data-keep-menu ref={cardRef}
        role="dialog" aria-modal="true" aria-label={label}>
        {head}
        {children}
      </div>
    </div>,
    document.body,
  );
}
