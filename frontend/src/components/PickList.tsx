import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { useDismiss } from "../hooks/useDismiss";
import { usePopPosition } from "../hooks/usePopPosition";

export type PickOption = { value: string; label: string; hint?: string; disabled?: boolean };

/**
 * 自绘下拉：一个按钮 + portal 到 body 的选择层（沿用联系人切换器那一套定位与轻关）。
 *
 * 为什么不用原生 `<select>`：它的弹层不吃应用主题，暗色下就是系统那块浅蓝补丁
 * （legacy.css 早写了这条口径）。为什么用下拉而不是一排 chips：档名是
 * 「供应商 · 模型名」这种长串，档一多 chips 会换行成三四排，选中哪份也看不出来。
 */
export default function PickList({ value, options, onChange, label, width = 264, empty, disabled }: {
  value: string;
  options: PickOption[];
  onChange: (value: string) => void;
  /** 给读屏用；可见的标题由外层那条 label 提供 */
  label: string;
  width?: number;
  /** 列表为空时顶上摆一行提示（比如「先去主对话模型存一份」） */
  empty?: ReactNode;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { setRef, pos, place } = usePopPosition(width);
  useDismiss(open, () => setOpen(false));
  const current = options.find((o) => o.value === value) ?? null;

  const toggle = (): void => {
    setOpen((v) => {
      if (!v) place(options.length + 1, 44);
      return !v;
    });
  };

  return (
    <div className="pick-wrap" ref={setRef} data-keep-menu="">
      <button type="button" className={"pick" + (open ? " on" : "")} disabled={disabled === true || options.length === 0}
        aria-expanded={open} aria-haspopup="listbox" aria-label={label} onClick={toggle}>
        <span className="pick-val">{current ? current.label : empty ?? "未选择"}</span>
        <ChevronDown size={14} className={"chip-arrow" + (open ? " up" : "")} />
      </button>
      {open && createPortal(
        <div className="switch-pop pick-pop" data-keep-menu="" role="listbox" aria-label={label}
          style={{ left: pos.left, top: pos.top, width, transform: pos.flip ? "translateY(-100%)" : undefined }}>
          {options.map((o) => (
            <button key={o.value || "none"} type="button" role="option" aria-selected={o.value === value}
              disabled={o.disabled} className={"switch-item" + (o.value === value ? " on" : "")}
              title={o.hint ?? o.label}
              onClick={() => { setOpen(false); onChange(o.value); }}>
              <span className="switch-name">{o.label}</span>
              {o.value === value && <Check size={15} className="switch-check" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
