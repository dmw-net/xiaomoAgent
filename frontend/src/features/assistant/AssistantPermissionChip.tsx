// 设置助手权限的唯一入口：输入区底部的常驻 chip。
// 后端 KV 是唯一状态源；这里只读写它，不再在设置页维护第二套单选状态。
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Eye, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { assistantApi, type AssistantPermission } from "../../api";
import { useAnchoredPop } from "../../hooks/useAnchoredPop";
import { useDismiss } from "../../hooks/useDismiss";
import Modal from "../../components/Modal";

type Tier = {
  key: AssistantPermission;
  label: string;
  desc: string;
  danger?: boolean;
};

const TIERS: Tier[] = [
  { key: "readonly", label: "只读", desc: "只回答问题，不调用任何改配置工具。" },
  { key: "confirm", label: "变更前确认", desc: "可逆操作直接执行；高风险操作先弹确认卡片。" },
  { key: "auto", label: "完全自主", desc: "连续完成模型、联系人、扩展等全部配置操作。", danger: true },
];

const TIER_LABEL: Record<AssistantPermission, string> = {
  readonly: "只读",
  confirm: "变更前确认",
  auto: "完全自主",
};

function TierIcon({ tier, size = 15 }: { tier: AssistantPermission; size?: number }): JSX.Element {
  if (tier === "auto") return <ShieldAlert size={size} />;
  if (tier === "readonly") return <Eye size={size} />;
  return <ShieldCheck size={size} />;
}

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
          <div className="asst-perm-options">
            {TIERS.map((tier) => {
              const selected = permission === tier.key;
              return (
                <button key={tier.key} type="button" role="menuitemradio" aria-checked={selected}
                  className={"asst-perm-option" + (selected ? " on" : "") + (tier.danger ? " danger" : "")}
                  disabled={busy !== ""} onClick={() => choose(tier.key)}>
                  <span className="asst-perm-option-icon"><TierIcon tier={tier.key} size={16} /></span>
                  <span className="asst-perm-option-copy"><b>{tier.label}</b><small>{tier.desc}</small></span>
                  {selected && <Check size={15} className="asst-perm-check" />}
                </button>
              );
            })}
          </div>
          {err !== "" && <div className="asst-perm-error" role="alert">{err}</div>}
          <div className="asst-perm-note">
            权限变更从下一条消息开始生效；正在执行的一轮继续使用启动时的工具清单。
          </div>
        </div>,
        document.body,
      )}

      {confirmAuto && (
        <Modal label="进入完全自主模式" className="asst-perm-confirm" placement="center"
          onClose={() => { if (busy === "") setConfirmAuto(false); }}
          head={<div className="asst-perm-confirm-head"><span>进入完全自主模式？</span>
            <button type="button" aria-label="关闭" disabled={busy !== ""}
              onClick={() => setConfirmAuto(false)}><X size={15} /></button></div>}>
          <div className="asst-perm-confirm-body">
            <p>完全自主会允许设置助手连续修改应用配置，不再逐步询问：</p>
            <ul>
              <li>模型档、接口地址与 API Key</li>
              <li>联系人的人设、头像与模型绑定</li>
              <li>扩展、MCP 与 JS 工具执行许可</li>
            </ul>
            <p>该设置对所有设置助手会话生效，并从下一条消息开始生效。</p>
          </div>
          <div className="add-row">
            <button type="button" disabled={busy !== ""} onClick={() => setConfirmAuto(false)}>取消</button>
            <button type="button" className="primary danger" disabled={busy !== ""}
              onClick={() => apply("auto")}>
              {busy === "auto" ? "切换中…" : "我了解风险，进入完全自主"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
