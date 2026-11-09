// 设置助手权限档的共用件：三档 option-card 与「完全自主」风险弹窗的全站唯一实现。
//
// 为什么收敛：同一份信任决策曾有两个 UI（输入区 chip 的弹层、助手设置屏的分段按钮），
// 连 auto 的确认文案都已各自漂移——chip 版枚举了影响面，设置屏版只剩一句泛化描述。
// 同一个决定两份风险声明，用户没法确认自己在两处同意的是同一件事。
// 现在三档卡片与风险弹窗只有这一份，chip 与助手设置屏各自带触发器复用。
import { Check, Eye, ShieldAlert, ShieldCheck, X } from "lucide-react";
import Modal from "../../components/Modal";
import type { AssistantPermission } from "../../api";

export const PERMISSION_TIERS: Array<{ key: AssistantPermission; label: string; desc: string; danger?: boolean }> = [
  { key: "readonly", label: "只读", desc: "只回答问题，不调用任何改配置工具。" },
  { key: "confirm", label: "变更前确认", desc: "可逆操作直接执行；高风险操作先弹确认卡片。" },
  { key: "auto", label: "完全自主", desc: "连续完成模型、联系人、扩展等全部配置操作。", danger: true },
];

export const TIER_LABEL: Record<AssistantPermission, string> = {
  readonly: "只读",
  confirm: "变更前确认",
  auto: "完全自主",
};

/** 确认卡等「非决策现场」的一句档位语境：只说这条档此刻真实成立的事。 */
export const TIER_HINT: Record<AssistantPermission, string> = {
  readonly: "助手暂时不能改配置",
  confirm: "高危操作总是先问你",
  auto: "操作将直接执行",
};

export function TierIcon({ tier, size = 15 }: { tier: AssistantPermission; size?: number }): JSX.Element {
  if (tier === "auto") return <ShieldAlert size={size} />;
  if (tier === "readonly") return <Eye size={size} />;
  return <ShieldCheck size={size} />;
}

/** 三档 option-card。variant=menu 时子项带 menuitemradio 语义（弹层内），否则按 radiogroup 渲染。 */
export function AssistantTierOptions({ permission, busy, variant = "radiogroup", onChoose }: {
  permission: AssistantPermission;
  busy: AssistantPermission | "";
  variant?: "menu" | "radiogroup";
  onChoose: (next: AssistantPermission) => void;
}): JSX.Element {
  return (
    <div
      className="asst-perm-options"
      role={variant === "menu" ? undefined : "radiogroup"}
      aria-label={variant === "menu" ? undefined : "助手权限档"}
    >
      {PERMISSION_TIERS.map((tier) => {
        const selected = permission === tier.key;
        return (
          <button key={tier.key} type="button"
            role={variant === "menu" ? "menuitemradio" : "radio"} aria-checked={selected}
            className={"asst-perm-option" + (selected ? " on" : "") + (tier.danger ? " danger" : "")}
            disabled={busy !== ""} onClick={() => onChoose(tier.key)}>
            <span className="asst-perm-option-icon"><TierIcon tier={tier.key} size={16} /></span>
            <span className="asst-perm-option-copy"><b>{tier.label}</b><small>{tier.desc}</small></span>
            {selected && <Check size={15} className="asst-perm-check" />}
          </button>
        );
      })}
    </div>
  );
}

/** 「完全自主」的唯一风险弹窗：影响面在这里枚举，任何入口都同意同一份声明。 */
export function AssistantAutoConfirmModal({ open, busy, onCancel, onConfirm }: {
  open: boolean;
  busy: AssistantPermission | "";
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <Modal label="进入完全自主模式" className="asst-perm-confirm" placement="center"
      onClose={() => { if (busy === "") onCancel(); }}
      head={<div className="asst-perm-confirm-head"><span>进入完全自主模式？</span>
        <button type="button" aria-label="关闭" disabled={busy !== ""}
          onClick={onCancel}><X size={15} /></button></div>}>
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
        <button type="button" disabled={busy !== ""} onClick={onCancel}>取消</button>
        <button type="button" className="primary danger" disabled={busy !== ""}
          onClick={onConfirm}>
          {busy === "auto" ? "切换中…" : "我了解风险，进入完全自主"}
        </button>
      </div>
    </Modal>
  );
}
