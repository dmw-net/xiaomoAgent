// 设置助手的控制台：权限档、允许的操作概览、待确认动作与工作区概览。
//
// 从前这一屏 lazy 复用联系人资料页，而资料页对 isAssistant 隐藏了工具/陪伴/显示
// 几乎所有卡片，点开「设置」等于一屏空白；真正要紧的权限档反而塞在输入区一枚 chip 里。
//
// 逐项收回的写路径已撤：这里与「工具与扩展 → 台账」写的是同一份全局 disabledTools，
// 两处各挂一排开关等于同一件事有两个闸，改这边看不到那边、因果要用户自己拼。
// 现在控制台只负责权限档（它独有的决策）+ 只读展示允许的操作，启停统一回台账。
// 身份/头像/模型绑定仍交给资料页那份唯一实现，不重写表单。

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Layers3, ShieldAlert, UserRound } from "lucide-react";
import { assistantApi } from "../../api";
import type { AssistantPermission } from "../../api/assistant";
import { loadToolState } from "../../lib/toolsStore";
import type { ToolState } from "../../api/tools";
import Modal from "../../components/Modal";

const TIERS: Array<{ key: AssistantPermission; label: string; desc: string }> = [
  { key: "readonly", label: "只读", desc: "只保留读应用状态，10 个写操作整组摘掉" },
  { key: "confirm", label: "变更前确认", desc: "不可逆动作弹确认卡片，由你点一下才执行" },
  { key: "auto", label: "完全自主", desc: "全部放行，不再弹卡片；只在你确实信任时开启" },
];

export default function AssistantConsole({ onBack, onEditProfile, onGoTools, contactId, threadCount }: {
  onBack: () => void;
  onEditProfile: () => void;
  /** 「允许的操作」面板的出口：关掉弹窗、跳到「工具与扩展 → 工具台账」逐项启停。 */
  onGoTools: () => void;
  contactId: string;
  threadCount: number;
}): JSX.Element {
  const [state, setState] = useState<ToolState | null>(null);
  const [permission, setPermission] = useState<AssistantPermission>("confirm");
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [confirmAuto, setConfirmAuto] = useState(false);

  const load = useCallback((): void => {
    loadToolState()
      .then(setState)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
    assistantApi.getPermission()
      .then((r) => setPermission(r.permission))
      .catch(() => undefined);
    assistantApi.fetchPending(contactId)
      .then((r) => setPendingCount(r.pending.length))
      .catch(() => setPendingCount(0));
  }, [contactId]);
  useEffect(() => { load(); }, [load]);

  const applyTier = (next: AssistantPermission): void => {
    setBusy("tier");
    setErr("");
    setNote("");
    setConfirmAuto(false);
    assistantApi.setPermission(next)
      .then((r) => { setPermission(r.permission); setNote(`权限档已切到「${TIERS.find((t) => t.key === r.permission)?.label ?? r.permission}」，下一条消息起生效。`); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(""));
  };

  const assistantTools = state?.tools.filter((t) => t.scope === "assistant") ?? [];
  const readonly = permission === "readonly";

  return (
    <div className="ac-console">
      <div className="ac-console-head">
        <button type="button" className="btn sm" onClick={onBack} aria-label="返回助手对话">
          <ArrowLeft size={14} /> 返回对话
        </button>
        <div className="ac-console-title"><b>助手控制台</b><small>权限与它能动的手，都在这里</small></div>
        <button type="button" className="btn sm" onClick={onEditProfile}>
          <UserRound size={14} /> 编辑资料
        </button>
      </div>

      {err !== "" && <div className="ext-banner is-bad" role="alert">{err}</div>}
      {note !== "" && <div className="ext-banner is-ok" role="status">{note}</div>}

      <section className="ac-panel">
        <div className="ac-tier-row">
          <Layers3 size={15} />
          <span className="ac-tier-label">权限档</span>
          <span className="ac-badge">{TIERS.find((t) => t.key === permission)?.label ?? permission}</span>
          <span className="ac-note">变更从下一条消息开始生效</span>
        </div>
        <div className="lg-segmented lg-segmented-3" role="radiogroup" aria-label="助手权限档">
          {TIERS.map((tier) => (
            <button key={tier.key} type="button" role="radio"
              aria-checked={permission === tier.key}
              className={"lg-seg" + (permission === tier.key ? " is-on" : "")}
              disabled={busy !== ""}
              onClick={() => tier.key === "auto" && permission !== "auto" ? setConfirmAuto(true) : applyTier(tier.key)}>
              {tier.label}
            </button>
          ))}
        </div>
        <div className="ac-note">{TIERS.find((t) => t.key === permission)?.desc}</div>
        <div className="ac-tier-row">
          <span className="ac-note">待确认动作 <b>{pendingCount}</b> 张</span>
          <span className="lg-divider" />
          <span className="ac-note">工作区 <b>{threadCount}</b> 个</span>
        </div>
      </section>

      <section className="ac-panel">
        <div className="lg-panel-head">
          <div className="lg-panel-title">
            <b>允许的操作</b>
            <small>实际可用 = 权限档允许 ∩ 台账未收回；读状态的工具常开。</small>
          </div>
          <button type="button" className="btn sm" onClick={onGoTools} title="逐项启停在「工具与扩展 → 工具台账」">
            去台账启停
          </button>
        </div>
        {readonly && (
          <div className="ac-readonly-note">当前是只读档：下面的写操作已整组关闭。切回「变更前确认」或「完全自主」后才会恢复。</div>
        )}
        {state === null ? (
          <div className="lg-loading">{err === "" ? "正在读取工具清单…" : err}</div>
        ) : (
          <div className="lg-group">
            {assistantTools.map((tool) => {
              const off = state.disabledTools.includes(tool.name);
              const forcedOff = readonly && tool.alwaysOn !== true;
              const reason = tool.alwaysOn === true ? "常开 · 不可关"
                : off ? "已在台账收回"
                  : forcedOff ? "只读档统一关闭"
                    : "允许";
              return (
                <div className={"lg-row" + (off || forcedOff ? " is-off" : "")} key={tool.name}>
                  <span className="lg-dot lg-dot-admin" aria-hidden="true" />
                  <div className="lg-copy">
                    <div className="lg-name">
                      {tool.label}
                      {tool.alwaysOn === true && <span className="lg-tag is-fixed">常开</span>}
                      {tool.risk === "high" && <span className="lg-tag is-risk">高风险</span>}
                    </div>
                    <div className="lg-summary">{tool.summary}</div>
                  </div>
                  <span className={"lg-state" + (reason !== "允许" ? " is-muted" : "")}>{reason}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="lg-footnote">
        <ShieldAlert size={14} />
        <div>
          逐项启停在「设置 → 工具与扩展 → 工具台账」，这里只看结论；改完回来，两边看到的是同一份状态。
          助手的管理操作不受陪伴工具的「全关」档影响，免得把管理入口一起关掉。
        </div>
      </div>

      {confirmAuto && (
        <Modal label="开启完全自主" onClose={() => setConfirmAuto(false)} placement="center">
          <div className="del-title">开启「完全自主」？</div>
          <div className="del-note">
            助手将不再为删除扩展、导入清单、开启 JS 执行许可这类不可逆动作弹确认卡片。
            被诱导的调用可能直接改掉配置。确认后仍可随时切回「变更前确认」。
          </div>
          <div className="del-row">
            <button type="button" onClick={() => setConfirmAuto(false)}>取消</button>
            <button type="button" className="danger" onClick={() => applyTier("auto")}>确认开启</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
