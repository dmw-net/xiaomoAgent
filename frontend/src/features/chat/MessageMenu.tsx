import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../lib/clipboard";
import type { MessageRow } from "../../types";

/** 目标气泡的视口矩形；拿不到时退回点击点。 */
export type MenuAnchor = { left: number; right: number; top: number; bottom: number; cx: number };
export type MenuState = { m: MessageRow; x: number; y: number; anchor: MenuAnchor | null };

/**
 * 消息操作菜单（右键/长按/回车呼出）——仿微信/QQ：
 * 深色小圆角气泡、箭头指着被操作的消息、每项只留两个字的短标签。
 * 细节说明放 title（桌面悬停可见）。删除的二次确认不在这，走居中弹窗。
 */
export default function MessageMenu({ menu, setMenu, addNotice, onEdit, onReedit, onRetract, onRequestDelete, onRegenerate, onRemember }: {
  menu: MenuState;
  setMenu: (m: MenuState | null) => void;
  addNotice: (text: string, opts?: { info?: boolean }) => void;
  /** textOnly=true 时保存走「只改文字」，不作废任何后续。 */
  onEdit: (m: MessageRow, textOnly?: boolean) => void;
  /** 撤回过的话捞回输入框，作为新消息再发一次（不走"从这里重建"）。 */
  onReedit: (m: MessageRow) => void;
  onRetract: (m: MessageRow) => void;
  onRequestDelete: (m: MessageRow) => void;
  onRegenerate: (m: MessageRow) => void;
  /** 把这条话写进长期记忆；后端按消息 id 幂等。 */
  onRemember: (m: MessageRow) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const m = menu.m;
  const close = (): void => setMenu(null);

  /**
   * 键盘路径：Enter 打开菜单后必须把焦点送进来，否则 Tab 会直接走到输入框，
   * 菜单里的按钮对键盘用户等于不存在。关闭时把焦点还给打开前的那一行。
   */
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true });
    return () => { back?.focus?.({ preventScroll: true }); };
  }, []);

  // 贴边时收回视口内；优先悬在气泡上方，放不下就翻到下方，箭头始终指向气泡中心。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 10;
    const gap = 10;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    let ax: number;
    let below = false;
    const a = menu.anchor;
    if (a) {
      top = a.top - h - gap;
      if (top < pad) { top = a.bottom + gap; below = true; }
      if (top + h > vh - pad) top = Math.max(pad, vh - h - pad);
      left = Math.min(Math.max(a.cx - w / 2, pad), vw - w - pad);
      ax = Math.min(Math.max(a.cx - left, 16), w - 16);
    } else {
      left = Math.min(Math.max(menu.x - w / 2, pad), vw - w - pad);
      top = menu.y + 6;
      below = true;
      if (top + h > vh - pad) { top = menu.y - h - 6; below = false; }
      ax = Math.min(Math.max(menu.x - left, 16), w - 16);
    }
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.setProperty("--ax", Math.round(ax) + "px");
    el.classList.toggle("below", below);
  }, [menu]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus({ preventScroll: true }); }
  };

  const item = (label: string, hint: string, cls: string | null, fn: () => void): JSX.Element => (
    <button type="button" role="menuitem" className={cls ?? ""} title={hint} onClick={(e) => { e.stopPropagation(); fn(); }}>
      <span className="lb">{label}</span>
      <span className="nt">{hint}</span>
    </button>
  );

  let body: JSX.Element;
  if (m.superseded_kind === "retract") {
    // 撤回过的消息此前只剩「彻底删除」一个出口，等于把说过的话丢了。
    // 「编辑」在这里不给：它的语义是从那条重建对话，而这条已经不在对话里了。
    body = (
      <>
        {m.role === "user" && m.text !== "" &&
          item("重新编辑", "放回输入框，作为新消息再发一次", null, () => { close(); onReedit(m); })}
        {item("彻底删除", "清除撤回记录，不可恢复", "danger", () => onRequestDelete(m))}
      </>
    );
  } else {
    body = (
      <>
        {item("复制", "复制这条消息", null, () => {
          close();
          void copyText(m.text).then((r) => {
            if (r === "ok") addNotice("已复制", { info: true });
            else addNotice("没复制成，长按气泡手动选吧", { info: true });
          });
        })}
        {m.text !== "" && m.kind !== "tool" && item("记成记忆", "写进长期记忆", null, () => { close(); onRemember(m); })}
        {m.role === "user" && m.superseded_at === null && item("编辑", "只改这句文字，后面的对话原样保留", null, () => onEdit(m, true))}
        {m.role === "user" && m.superseded_at === null && item("改后重聊", "改这句，后面从这句重来", null, () => onEdit(m, false))}
        {m.role === "assistant" && m.superseded_at === null && m.kind === "chat" && m.text !== "" &&
          item("编辑回复", "只改这一句，不重新生成", null, () => onEdit(m))}
        {/* 重新生成：任何一轮都能重答（后端就是这样放的）。较早的轮次会把新回复写回它
            原来的位置，后面那些轮保留不动——它们当初是基于旧回答说的。一句话说清这两半。 */}
        {m.superseded_at === null && m.turn_id !== null && (m.role === "user" || m.kind === "chat") &&
          item("重新生成", "这条回答会换成新的，后面的不动", null, () => { close(); onRegenerate(m); })}
        {item("撤回", "把这条撤掉，联系人不会再记得", null, () => { close(); onRetract(m); })}
        {item("删除", "这条和联系人的回答一起删，找不回来了", "danger",
          () => onRequestDelete(m))}
      </>
    );
  }

  // 菜单是按视口坐标算位置的（window.innerWidth + getBoundingClientRect），
  // 必须挂在 body 上：祖先一旦带 transform（助手弹窗就带），position:fixed 会改成
  // 相对那个祖先定位，坐标整体偏半个弹窗，还被它的 overflow:hidden 裁掉。
  return createPortal(
    <div className="msgmenu dark" ref={ref} style={{ left: menu.x, top: menu.y }} data-keep-menu
      role="menu" aria-label="消息操作" onKeyDown={onKeyDown}>
      <span className="mm-arrow" aria-hidden="true" />
      {body}
    </div>,
    document.body,
  );
}
