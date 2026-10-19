import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Eraser, Pencil, Trash2 } from "lucide-react";
import { useDismiss } from "../../hooks/useDismiss";
import { usePopPosition } from "../../hooks/usePopPosition";
import type { AssistantThread } from "../../api";

const POP_W = 252;

/**
 * 助手工作区切换器：与 ContactChip 同款——portal 挂 body 的 fixed 下拉，避免被滚动容器裁切。
 * 每行自带清空/改名/删除（常驻图标，触屏没有 hover 也能点），所以不必先切过去再找菜单。
 * 「清空」是每行都有的那一个：内置「通用」既不能改名也不能删，没有它就只能单向增长。
 */
export default function ThreadChip({ threads, current, dialogOpen, onPick, onRename, onDelete, onClear }: {
  threads: AssistantThread[];
  current: string;
  /** 助手弹窗是否可见。弹窗关闭只是隐藏整层，portal 到 body 的下拉不在其中——不跟着收就留在屏幕上。 */
  dialogOpen: boolean;
  onPick: (id: string) => void;
  onRename: (thread: AssistantThread) => void;
  onDelete: (thread: AssistantThread) => void;
  onClear: (thread: AssistantThread) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { setRef, pos, place } = usePopPosition(POP_W);
  useDismiss(open, () => setOpen(false));
  // × / 悬浮球 / 跳设置这些关闭路径都落在弹窗内部，不会触发上面按"点外部"的下拉 dismiss，
  // 于是弹窗隐藏了、portal 在 body 的下拉还挂着。弹窗一收就把下拉一起归零。
  useEffect(() => { if (!dialogOpen) setOpen(false); }, [dialogOpen]);

  const active = threads.find((t) => t.id === current);

  const toggle = (): void => {
    // place() 必须放在 setState 更新器之外：更新器会被 StrictMode 双调用，
    // 放进去等于切两次开关，下拉刚打开就被关掉。
    if (!open) place(threads.length, 40);
    setOpen(!open);
  };

  return (
    <div className="switcher-wrap" ref={setRef} data-keep-menu="">
      <button type="button" className="contact-chip" aria-expanded={open} aria-haspopup="listbox" onClick={toggle} title="切换工作区">
        <span className="chip-name">{active?.title ?? "工作区"}</span>
        <ChevronDown size={14} className={"chip-arrow" + (open ? " up" : "")} />
      </button>
      {open && createPortal(
        <div className="switch-pop" data-keep-menu="" role="listbox" aria-label="选择工作区"
          style={{ left: pos.left, top: pos.top, width: POP_W, transform: pos.flip ? "translateY(-100%)" : undefined }}>
          <div className="switch-cap">工作区</div>
          {threads.map((t) => (
            <div key={t.id || "builtin"} className={"switch-item" + (t.id === current ? " on" : "")}>
              <button type="button" className="switch-pick" role="option" aria-selected={t.id === current}
                onClick={() => { setOpen(false); onPick(t.id); }}>
                <span className="switch-name">{t.title}</span>
                {t.id === current && <Check size={15} className="switch-check" />}
              </button>
              <button type="button" className="switch-act" title="清空消息"
                aria-label={`清空 ${t.title} 的消息`} disabled={t.messages === 0}
                onClick={() => { setOpen(false); onClear(t); }}>
                <Eraser size={13} strokeWidth={1.8} />
              </button>
              {!t.builtin && (
                <>
                  <button type="button" className="switch-act" title="改名" aria-label={`重命名 ${t.title}`}
                    onClick={() => { setOpen(false); onRename(t); }}>
                    <Pencil size={13} strokeWidth={1.8} />
                  </button>
                  <button type="button" className="switch-act switch-act-danger" title="删除" aria-label={`删除 ${t.title}`}
                    onClick={() => { setOpen(false); onDelete(t); }}>
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
