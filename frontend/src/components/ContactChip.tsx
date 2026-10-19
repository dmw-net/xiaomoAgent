import { startTransition, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import Avatar from "./Avatar";
import { avatarToneStyle } from "../lib/avatar-tone";
import { useDismiss } from "../hooks/useDismiss";
import { usePopPosition } from "../hooks/usePopPosition";
import { contactId } from "../api";
import { getCachedContacts, isContactsLoaded, subscribeContacts } from "../lib/contactsStore";
import type { ContactItem } from "../types";

const POP_W = 236;
const ROW_H = 45;

/**
 * 页头联系人切换器：所有端一律下拉层直接切人（钉钉式）；
 * 移动端在下拉底部提供「管理联系人」入口——直接跳回「对话」列表页（增删/资料/搜索都在那里）。
 *
 * 性能上只认全局 contactsStore：打开不再打一次网络，名字与头像直接吃缓存；后台刷新到了
 * 再轻量替换，不把一次点按变成「请求 → 等头像解码 → 才看见列表」的长链路。
 */
export default function ContactChip({ name, avatar, onPick, onManageContacts }: {
  name: string;
  avatar: string;
  onPick: (id: string) => void;
  onManageContacts: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<ContactItem[]>(getCachedContacts);
  const [loaded, setLoaded] = useState(isContactsLoaded);
  const { setRef, pos, place } = usePopPosition(POP_W);
  useDismiss(open, () => setOpen(false));

  useEffect(() => {
    const unsubscribe = subscribeContacts((next) => {
      startTransition(() => {
        setContacts(next);
        setLoaded(isContactsLoaded());
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (open) place(contacts.length, ROW_H);
  }, [contacts.length, open, place]);

  const ordered = useMemo(() => {
    const current = contactId();
    return [...contacts].sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));
  }, [contacts]);

  const toggle = (): void => {
    setOpen((v) => {
      if (!v) place(getCachedContacts().length, ROW_H);
      return !v;
    });
  };

  const current = contactId();

  return (
    <div className="switcher-wrap" ref={setRef} data-keep-menu="">
      <button type="button" className="contact-chip" aria-expanded={open} aria-haspopup="listbox" onClick={toggle} title="切换联系人">
        <Avatar className="chip-ava" src={avatar || undefined} name={name} style={avatarToneStyle(name)} />
        <span className="chip-name">{name}</span>
        <ChevronDown size={14} className={"chip-arrow" + (open ? " up" : "")} />
      </button>
      {open && createPortal(
        <div className="switch-pop contact-switch-pop" data-keep-menu=""
          style={{ left: pos.left, top: pos.top, width: POP_W, transform: pos.flip ? "translateY(-100%)" : undefined }}>
          <div className="switch-cap">切换联系人</div>
          <div role="listbox" aria-label="选择联系人">
            {ordered.map((c) => (
              <button key={c.id} type="button" role="option" aria-selected={c.id === current}
                className={"switch-item" + (c.id === current ? " on" : "")}
                onClick={() => { setOpen(false); onPick(c.id); }}>
                <Avatar className="switch-ava" src={c.avatar || undefined} name={c.name} style={avatarToneStyle(c.name)} />
                <span className="switch-name">{c.name}</span>
                {c.id === current && <Check size={15} className="switch-check" />}
              </button>
            ))}
            {ordered.length === 0 && (
              <div className="switch-empty" role="presentation">
                {loaded ? "还没有联系人" : "读取中…"}
              </div>
            )}
          </div>
          <button type="button" className="switch-mgr"
            onClick={() => { setOpen(false); onManageContacts(); }}>
            管理联系人
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
