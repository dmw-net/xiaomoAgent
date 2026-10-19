import { useState } from "react";
import { Search } from "lucide-react";
import { avatarApi } from "../api";

/**
 * 「用 QQ 头像」：输个 QQ 号，让后端把那张头像抓成本地文件当头像用。
 *
 * 取回来的是本地 /media 路径，怎么用交给调用方——
 * 联系人直接把它当头像（和助手抓图那条路同一种形态，不占轮询载荷），
 * 用户自己那张要先过一遍 canvas 压成 dataURL（全局用户资料只收 dataURL）。
 */
export default function QqAvatarButton({ onPick, disabled = false }: {
  /** 拿到本地 /media 路径之后做什么，由调用方决定。 */
  onPick: (mediaUrl: string) => void | Promise<void>;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [qq, setQq] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const close = (): void => { setOpen(false); setErr(""); setQq(""); };

  const submit = (): void => {
    if (busy) return;
    if (!/^[1-9]\d{4,10}$/.test(qq)) { setErr("应当是 5~11 位数字"); return; }
    setBusy(true);
    setErr("");
    void avatarApi.fetchQqAvatar(qq)
      // onPick 可能是异步的（用户头像那条要再压一遍图），等它落地再收起来
      .then(async (d) => { await onPick(d.url); close(); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <button type="button" className="pf-ghost" disabled={disabled}
        title="输入 QQ 号，用那个号的头像" onClick={() => setOpen(true)}>
        <Search size={13} strokeWidth={1.8} />用 QQ 头像
      </button>
    );
  }
  return (
    <div className="qq-ava-row">
      <input className="qq-ava-input" inputMode="numeric" autoFocus maxLength={11} value={qq}
        placeholder="QQ 号" aria-label="QQ 号"
        onChange={(e) => { setQq(e.target.value.replace(/\D/g, "")); setErr(""); }}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") close(); }} />
      <button type="button" className="pf-ghost" disabled={busy} onClick={submit}>
        {busy ? "取头像中…" : "取头像"}
      </button>
      <button type="button" className="pf-ghost" disabled={busy} onClick={close}>取消</button>
      {err !== "" && <div className="qq-ava-err" role="alert">{err}</div>}
    </div>
  );
}