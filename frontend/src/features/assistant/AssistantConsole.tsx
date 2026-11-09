// 助手设置屏：权限档、最近的配置变更、待确认动作与工作区概览。
//
// 从前这一屏 lazy 复用联系人资料页，而资料页对 isAssistant 隐藏了工具/陪伴/显示
// 几乎所有卡片，点开「设置」等于一屏空白；真正要紧的权限档反而塞在输入区一枚 chip 里。
//
// 逐项收回的写路径已撤：这里与「工具与扩展 → 台账」写的是同一份全局 disabledTools，
// 两处各挂一排开关等于同一件事有两个闸，改这边看不到那边、因果要用户自己拼。
// 现在这屏只负责助手独有的决策（权限档）+ 事后可见性（变更记录）+ 只读展示允许的操作，
// 启停统一回台账。身份/头像/模型绑定仍交给资料页那份唯一实现，不重写表单。
//
// 「最近的配置变更」是 auto 档唯一的事后可见性：信任但不看见，等于把
// 「确认疲劳 → 升到 auto」这条滑坡的终点变得更危险。数据来自
// /api/assistant/activity（后端给写工具统一包了一层活动记录，见 src/mind/assistant.ts）。

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, History, Layers3, ShieldAlert, UserRound } from "lucide-react";
import { assistantApi } from "../../api";
import type { AssistantActivity, AssistantPermission } from "../../api/assistant";
import { loadToolState } from "../../lib/toolsStore";
import type { ToolState } from "../../api/tools";
import EmptyState from "../../components/EmptyState";
import { AssistantAutoConfirmModal, AssistantTierOptions, PERMISSION_TIERS, TIER_LABEL } from "./AssistantPermission";

const ACTIVITY_SHOWN = 20;

/** 今天只报时分，更早的带上日期——审计行的时间一眼能对上"刚才那次操作"。 */
function formatActTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

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
  const [activity, setActivity] = useState<AssistantActivity[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState<AssistantPermission | "">("");
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
    assistantApi.fetchActivity()
      .then((r) => setActivity(r.items))
      .catch(() => setActivity((prev) => prev ?? []));
  }, [contactId]);
  useEffect(() => { load(); }, [load]);

  const applyTier = (next: AssistantPermission): void => {
    setBusy(next);
    setErr("");
    setNote("");
    setConfirmAuto(false);
    assistantApi.setPermission(next)
      .then((r) => {
        setPermission(r.permission);
        setNote(`权限档已切到「${TIER_LABEL[r.permission]}」，下一条消息起生效。`);
        // 权限切换本身就是一条变更记录：刷一遍，让这屏说的和自己刚做的一致。
        assistantApi.fetchActivity()
          .then((d) => setActivity(d.items))
          .catch(() => undefined);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(""));
  };

  // 与输入区 chip 同一条规则：升到完全自主必须过唯一的风险弹窗，降级直接生效。
  const chooseTier = (next: AssistantPermission): void => {
    if (busy !== "") return;
    if (next === permission) return;
    if (next === "auto") { setConfirmAuto(true); return; }
    applyTier(next);
  };

  const assistantTools = state?.tools.filter((t) => t.scope === "assistant") ?? [];
  const readonly = permission === "readonly";
  const tierDesc = PERMISSION_TIERS.find((t) => t.key === permission)?.desc ?? "";
  const shownActivity = activity?.slice(0, ACTIVITY_SHOWN) ?? [];
  const activityHidden = (activity?.length ?? 0) - shownActivity.length;

  return (
    <div className="ac-console">
      <div className="ac-console-head">
        <button type="button" className="btn sm" onClick={onBack} aria-label="返回助手对话">
          <ArrowLeft size={14} /> 返回对话
        </button>
        <div className="ac-console-title"><b>助手设置</b><small>权限、变更记录与它能动的手，都在这里</small></div>
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
          <span className="ac-note">变更从下一条消息开始生效</span>
        </div>
        <AssistantTierOptions permission={permission} busy={busy} onChoose={chooseTier} />
        <div className="ac-note">{tierDesc}</div>
        <div className="ac-tier-row">
          <span className="ac-note">待确认动作 <b>{pendingCount}</b> 张</span>
          {pendingCount > 0 && (
            /* 卡片浮在对话那一屏：数字不该是死端，给一条回去处理的路。 */
            <button type="button" className="btn sm" onClick={onBack} title="回到对话屏，卡片就浮在那里">
              去处理
            </button>
          )}
          <span className="lg-divider" />
          <span className="ac-note">工作区 <b>{threadCount}</b> 个</span>
        </div>
      </section>

      <section className="ac-panel">
        <div className="lg-panel-head">
          <div className="lg-panel-title">
            <b>最近的配置变更</b>
            <small>权限切换、确认卡决定与助手的写操作都在这里留痕；读状态不记录。</small>
          </div>
        </div>
        {activity === null ? (
          <div className="lg-loading">{err === "" ? "正在读取变更记录…" : err}</div>
        ) : shownActivity.length === 0 ? (
          <EmptyState compact icon={<History size={18} strokeWidth={1.5} />}
            title="还没有配置变更"
            hint="助手执行写操作、你在确认卡上点同意或拒绝、或切换权限档后，都会记录在这里。" />
        ) : (
          <div className="lg-group">
            {shownActivity.map((item) => (
              <div className="lg-row" key={`${item.ts}-${item.tool}-${item.title}`}>
                <span className={"lg-dot " + (item.ok ? "lg-dot-ok" : "lg-dot-bad")} aria-hidden />
                <div className="lg-copy">
                  <div className="lg-name">
                    {item.title}
                    {item.confirmed && <span className="lg-tag">经确认卡</span>}
                  </div>
                  {item.detail && <div className="lg-summary">{item.detail}</div>}
                </div>
                <span className="ac-act-time">{formatActTime(item.ts)}</span>
                <span className={"lg-state" + (item.ok ? "" : " is-bad")}>{item.ok ? "成功" : "失败"}</span>
              </div>
            ))}
            {activityHidden > 0 && (
              <div className="ac-act-more">更早的 {activityHidden} 条没有列出（本地最多保留 100 条）。</div>
            )}
          </div>
        )}
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

      <AssistantAutoConfirmModal
        open={confirmAuto} busy={busy}
        onCancel={() => setConfirmAuto(false)}
        onConfirm={() => applyTier("auto")}
      />
    </div>
  );
}
