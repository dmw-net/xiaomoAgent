// 助手设置屏的两块面板：权限档 + 审计（变更记录 / 允许的操作）。
//
// 从前它们和「编辑资料」入口一起装在 AssistantConsole 里，设置屏因此变成两层：
// 助手设置 → 编辑资料。现在资料页自己就是助手设置屏（身份/对话表单都在那儿），
// 这两块作为面板直接嵌进去，中间那一层取消。
//
// 拆成两个组件而不是一个大组件，是为了让「权限档」排在身份与对话之前、
// 「变更记录 / 允许的操作」排在其后——这是助手设置屏唯一合理的阅读顺序。

import { useCallback, useEffect, useState } from "react";
import { History, Layers3, ShieldAlert } from "lucide-react";
import { assistantApi } from "../../api";
import type { AssistantActivity, AssistantPermission } from "../../api/assistant";
import { loadToolState } from "../../lib/toolsStore";
import type { ToolState } from "../../api/tools";
import EmptyState from "../../components/EmptyState";
import { AssistantAutoConfirmModal, AssistantTierOptions, PERMISSION_TIERS, TIER_LABEL } from "./AssistantPermission";

const ACTIVITY_SHOWN = 20;

/**
 * visibleTools() 在助手分支额外注入的三个只读工具（tools.ts 的 WEB_TOOLS + SKILL_TOOL）。
 * 它们的 scope 是 companion，所以不在「允许的操作」那张助手清单里；但助手确实用得上
 * （搜图给联系人配头像、读技能做法），且不随只读档整组摘除。这里必须列出来，
 * 否则「允许的操作」会低报助手真正能做的事。新增/删减由 chat-ui-regression 静态断言锁住。
 */
const ASSISTANT_EXTRA_TOOLS = ["web_search", "web_fetch", "load_skill"] as const;

/** 今天只报时分，更早的带上日期——审计行的时间一眼能对上"刚才那次操作"。 */
function formatActTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** 权限档面板：三档选择 + 待确认动作 / 工作区概览。排在助手设置屏的最前。 */
export function AssistantPermissionPanel({ contactId, threadCount, onBack }: {
  contactId: string;
  threadCount: number;
  /** 「去处理」的出口：回到对话屏（确认卡片浮在那里）。 */
  onBack: () => void;
}): JSX.Element {
  const [permission, setPermission] = useState<AssistantPermission>("confirm");
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState<AssistantPermission | "">("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [confirmAuto, setConfirmAuto] = useState(false);

  const load = useCallback((): void => {
    assistantApi.getPermission()
      .then((r) => setPermission(r.permission))
      .catch(() => undefined);
    assistantApi.fetchPending(contactId)
      .then((r) => setPendingCount(r.pending.length))
      .catch(() => setPendingCount(0));
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
        // 权限切换本身是一条变更记录，且只读档会改「允许的操作」的结论：
        // 广播给审计面板，让它跟着刷新，两屏说的和自己刚做的一致。
        window.dispatchEvent(new CustomEvent("xiaomo:assistant-permission-changed"));
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

  const tierDesc = PERMISSION_TIERS.find((t) => t.key === permission)?.desc ?? "";

  return (
    <section className="ac-panel">
      {err !== "" && <div className="ext-banner is-bad" role="alert">{err}</div>}
      {note !== "" && <div className="ext-banner is-ok" role="status">{note}</div>}
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
      <AssistantAutoConfirmModal
        open={confirmAuto} busy={busy}
        onCancel={() => setConfirmAuto(false)}
        onConfirm={() => applyTier("auto")}
      />
    </section>
  );
}

/** 审计面板：最近的配置变更 + 允许的操作 + 助手也能用的只读工具。排在身份与对话之后。 */
export function AssistantAuditPanels({ onGoTools }: {
  /** 「允许的操作」面板的出口：关掉弹窗、跳到「工具与扩展 → 工具台账」逐项启停。 */
  onGoTools: () => void;
}): JSX.Element {
  const [state, setState] = useState<ToolState | null>(null);
  const [permission, setPermission] = useState<AssistantPermission>("confirm");
  const [activity, setActivity] = useState<AssistantActivity[] | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback((): void => {
    loadToolState()
      .then(setState)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
    assistantApi.getPermission()
      .then((r) => setPermission(r.permission))
      .catch(() => undefined);
    assistantApi.fetchActivity()
      .then((r) => setActivity(r.items))
      .catch(() => setActivity((prev) => prev ?? []));
  }, []);
  useEffect(() => { load(); }, [load]);
  // 权限档在另一块面板里切：档位变了，「允许的操作」的结论与变更记录都要跟着刷新。
  useEffect(() => {
    window.addEventListener("xiaomo:assistant-permission-changed", load);
    return () => window.removeEventListener("xiaomo:assistant-permission-changed", load);
  }, [load]);

  const assistantTools = state?.tools.filter((t) => t.scope === "assistant") ?? [];
  const assistantExtraTools = state?.tools.filter((t) => (ASSISTANT_EXTRA_TOOLS as readonly string[]).includes(t.name)) ?? [];
  const readonly = permission === "readonly";
  const shownActivity = activity?.slice(0, ACTIVITY_SHOWN) ?? [];
  const activityHidden = (activity?.length ?? 0) - shownActivity.length;

  return (
    <>
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
            <small>写操作 = 权限档允许 ∩ 台账未收回；app_status 常开。助手另能用下面一组只读工具。</small>
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

      {state !== null && assistantExtraTools.length > 0 && (
        <section className="ac-panel">
          <div className="lg-panel-head">
            <div className="lg-panel-title">
              <b>助手也能用的只读工具</b>
              <small>从陪伴侧借来，供搜图配头像与读技能做法；不改配置，不随只读档关闭，但仍受台账逐项启停约束。</small>
            </div>
          </div>
          <div className="lg-group">
            {assistantExtraTools.map((tool) => {
              const off = state.disabledTools.includes(tool.name);
              return (
                <div className={"lg-row" + (off ? " is-off" : "")} key={tool.name}>
                  <span className="lg-dot" aria-hidden />
                  <div className="lg-copy">
                    <div className="lg-name">{tool.label}</div>
                    <div className="lg-summary">{tool.summary}</div>
                  </div>
                  <span className={"lg-state" + (off ? " is-muted" : "")}>{off ? "已在台账收回" : "允许"}</span>
                </div>
              );
            })}
          </div>
          <div className="ac-note">load_skill 只在库里有可用技能时才会真正出现。</div>
        </section>
      )}

      <div className="lg-footnote">
        <ShieldAlert size={14} />
        <div>
          逐项启停在「设置 → 工具与扩展 → 工具台账」，这里只看结论；改完回来，两边看到的是同一份状态。
          助手的管理操作不受陪伴工具的「全关」档影响，免得把管理入口一起关掉；
          上面那组联网 / 技能只读工具也不随「只读」档摘除。
        </div>
      </div>
    </>
  );
}
