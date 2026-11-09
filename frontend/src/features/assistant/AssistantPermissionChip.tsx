// 设置助手权限的常驻入口：输入区底部的 chip。
// 三档 option-card 与「完全自主」风险弹窗在 AssistantPermission.tsx（全站唯一实现），
// 这里只负责触发器、弹层定位与多窗口轮询校准；确认卡上的「调整权限」也经由
// xiaomo:assistant-perm-open 事件展开这个弹层——档位决策发生在使用现场。
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, X } from "lucide-react";
import { assistantApi, type AssistantPermission } from "../../api";
import { useAnchoredPop } from "../../hooks/useAnchoredPop";
import { useDismiss } from "../../hooks/useDismiss";
import { AssistantAutoConfirmModal, AssistantTierOptions, TIER_LABEL, TierIcon } from "./AssistantPermission";

export default function AssistantPermissionChip({ active }: {
  /** 助手弹窗关着时不后台轮询；打开后通过后端持续校准多窗口状态。 */
  active: boolean;
}): JSX.Element {
  const [permission, setPermission] = useState<AssistantPermission | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<AssistantPermission | "">("");
  const [err, setErr] = useState("");
  const [confirmAuto, setConfirmAuto] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popPos = useAnchoredPop(open, triggerRef, 348);
  const close = useCallback((): void => setOpen(false), []);
  useDismiss(open, close, wrapRef);

  const refresh = useCallback((silent = false): void => {
    assistantApi.getPermission()
      .then((r) => {
        setPermission(r.permission);
        if (!silent) setErr("");
      })
      .catch((e: unknown) => {
        if (!silent) setErr(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (busy === "" && !confirmAuto) refresh(true);
    }, 10_000);
    return () => window.clearInterval(id);
  }, [active, busy, confirmAuto, refresh]);

  // PendingCard 的「调整权限」就近入口：确认卡是用户理解这套信任模型的一刻，
  // 想升档的念头也在那一刻出现——就地展开弹层，不要求用户先找到 chip。
  useEffect(() => {
    const openPop = (): void => setOpen(true);
    window.addEventListener("xiaomo:assistant-perm-open", openPop);
    return () => window.removeEventListener("xiaomo:assistant-perm-open", openPop);
  }, []);

  const apply = (next: AssistantPermission): void => {
    if (busy !== "") return;
    setBusy(next);
    setErr("");
    assistantApi.setPermission(next)
      .then((r) => {
        setPermission(r.permission);
        setOpen(false);
        setConfirmAuto(false);
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e));
        setConfirmAuto(false);
        setOpen(true);
      })
      .finally(() => setBusy(""));
  };

  const choose = (next: AssistantPermission): void => {
    if (busy !== "" || permission === null) return;
    if (next === permission) { setOpen(false); return; }
    if (next === "auto") {
      // 进入高风险模式必须再明确确认一次；降级到 readonly/confirm 则直接生效。
      setOpen(false);
      setErr("");
      setConfirmAuto(true);
      return;
    }
    apply(next);
  };

  const toggle = (): void => {
    if (permission === null) { refresh(); return; }
    setErr("");
    setOpen((v) => !v);
  };

  const current = permission ?? "confirm";
  const isAuto = permission === "auto";

  return (
    <>
      <span className="asst-perm-wrap" ref={wrapRef}>
        <button type="button" ref={triggerRef}
          className={"asst-perm-chip" + (isAuto ? " is-auto" : "") + (open ? " on" : "")}
          aria-haspopup="menu" aria-expanded={open}
          aria-label={permission === null ? "读取设置助手权限" : `设置助手权限：${TIER_LABEL[current]}`}
          title={isAuto ? "完全自主：设置助手可连续修改配置（高风险）" : "调整设置助手权限"}
          disabled={busy !== ""}
          onClick={toggle}>
          {busy !== "" ? <Loader2 size={14} className="spin" /> : <TierIcon tier={current} size={14} />}
          <span>{permission === null ? "权限" : TIER_LABEL[current]}</span>
          {isAuto && <b className="asst-perm-risk">高风险</b>}
          <ChevronDown size={12} strokeWidth={2} className={open ? "flip" : ""} />
        </button>
      </span>

      {open && createPortal(
        <div className="asst-perm-pop" role="menu" aria-label="设置助手权限" data-keep-menu
          style={popPos ? { left: popPos.left, bottom: popPos.bottom, width: popPos.width } : { visibility: "hidden" }}>
          <div className="asst-perm-head">
            <div>
              <b>设置助手权限</b>
              <small>对所有设置助手会话生效。</small>
            </div>
            <button type="button" aria-label="关闭权限选择" onClick={close}><X size={14} /></button>
          </div>
          <AssistantTierOptions permission={current} busy={busy} variant="menu" onChoose={choose} />
          {err !== "" && <div className="asst-perm-error" role="alert">{err}</div>}
          <div className="asst-perm-note">
            权限变更从下一条消息开始生效；正在执行的一轮继续使用启动时的工具清单。
          </div>
        </div>,
        document.body,
      )}

      <AssistantAutoConfirmModal
        open={confirmAuto} busy={busy}
        onCancel={() => setConfirmAuto(false)}
        onConfirm={() => apply("auto")}
      />
    </>
  );
}
