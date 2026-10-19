/** 分段控件（微信小程序式）：视图内一级 tab 共用。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTabSelect } from "../hooks/useTabSelect";

/**
 * 面板根元素上直接 spread 的一组 ARIA：把自己标成 tabpanel，并回指所属 tab。
 * base 是这一组 tab 在页面内的唯一前缀，与 <Tabs base> 传同一个值。
 * 不做 aria-controls：那是 APG 的可选项，而设置页五个分区共用一个容器，
 * 未选中的 tab 指过去会指向一个当前不存在的 id，反而留下坏引用。
 */
export const panelAria = (base: string, key: string): PanelAria =>
  ({ role: "tabpanel", "aria-labelledby": `${base}-tab-${key}` });

/** 两个属性都可空：没有 tab 栏的场景（如资料页的「新建联系人」）传 {}，
    spread 上去等于什么都不加，不会留下指向不存在 tab 的引用。 */
export type PanelAria = { role?: "tabpanel"; "aria-labelledby"?: string };

export default function Tabs<T extends string>({ tabs, value, onChange, base }: {
  tabs: Array<{ key: T; label: string }>;
  value: T;
  onChange: (key: T) => void;
  /** 给了才输出 tab 元素 id，供面板用 panelAria() 回指。 */
  base?: string;
}): JSX.Element {
  const onKeyDown = useTabSelect();
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  /** 只让真正溢出的一侧渐隐：没有横向滚动时不能无端把首尾标签擦淡。 */
  const updateEdges = useCallback(() => {
    const box = listRef.current;
    if (!box) return;
    const left = box.scrollLeft > 2;
    const right = box.scrollLeft + box.clientWidth < box.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useLayoutEffect(() => {
    const box = listRef.current;
    if (!box) return;
    updateEdges();
    // 首帧有时还会在容器宽度落定前量一次；补一拍和一次短延迟，
    // 保证偶发出现横向溢出的页面不会漏掉渐隐提示。
    const raf = requestAnimationFrame(updateEdges);
    const timer = window.setTimeout(updateEdges, 120);
    box.addEventListener("scroll", updateEdges, { passive: true });
    window.addEventListener("resize", updateEdges);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateEdges);
    observer?.observe(box);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      box.removeEventListener("scroll", updateEdges);
      window.removeEventListener("resize", updateEdges);
      observer?.disconnect();
    };
  }, [updateEdges]);

  // 窄屏标签栏横向滚动后，从外部直接跳到「能力模型」等后面的分区时，
  // 当前项必须在视口里；否则页面内容已经切了，顶栏看起来却还停在前几项。
  useEffect(() => {
    updateEdges();
    const box = listRef.current;
    if (!box || box.scrollWidth <= box.clientWidth + 1) return;
    const selected = box.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!selected) return;
    const pad = 8;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (left < box.scrollLeft + pad) {
      box.scrollTo({ left: Math.max(0, left - pad), behavior });
    } else if (right > box.scrollLeft + box.clientWidth - pad) {
      box.scrollTo({ left: right - box.clientWidth + pad, behavior });
    }
  }, [updateEdges, value]);

  return (
    <div className={"seg" + (edges.left ? " fade-left" : "") + (edges.right ? " fade-right" : "")}
      ref={listRef} role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key}
          id={base ? `${base}-tab-${t.key}` : undefined}
          tabIndex={value === t.key ? 0 : -1}
          className={value === t.key ? "on" : ""} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
