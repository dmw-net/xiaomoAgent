import { useCallback, useEffect, useRef, useState } from "react";
import Tabs, { panelAria } from "../../components/Tabs";
import type { PanelAria } from "../../components/Tabs";
import ListPager from "../../components/ListPager";
import Modal from "../../components/Modal";
import { usePagedList } from "../../hooks/usePagedList";
import { offerUndo } from "../../lib/undo";
import { proactiveApi } from "../../api";
import { clockOf, pad, whenText } from "../../lib/datetime";
import { GATE_DEFS } from "../status/constants";
import { TASK_STATUS_LABEL, type GateState, type TaskRow } from "../../types";

type Tab = "pending" | "history" | "gates";
type Out = { cls: string; text: string } | null;

/** 计划的两类：与后端 proactive_tasks.kind 同一口径。 */
type TaskKind = "care" | "reminder";

/** 时间快捷档：算的是**提交那一刻**的时间，所以 at 是函数而不是常量。 */
const QUICK_TIMES: Array<{ id: string; label: string; at: () => number }> = [
  { id: "10m", label: "10 分钟后", at: () => Date.now() + 10 * 60_000 },
  { id: "1h", label: "1 小时后", at: () => Date.now() + 3_600_000 },
  // 「今晚」要认当下：21:30 点「今晚 21:00」该落到明天，而不是立刻过期然后被后端拒掉。
  { id: "tonight", label: "今晚 21:00", at: () => {
    const d = new Date(); d.setHours(21, 0, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  } },
  { id: "morning", label: "明早 9:00", at: () => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    return d.getTime();
  } },
];

/** datetime-local 要的是本地墙钟串 YYYY-MM-DDTHH:MM（不是 ISO，带 Z 会被当 UTC 偏八小时）。 */
const toLocalInput = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 「添加计划」表单。两类计划的**代价不同**（一类必达、一类会被她判掉），
 * 所以类型这一栏不是装饰：选了才看得见那句话会怎么处理。
 */
function AddTaskForm({ contactId, who, onClose, onAdded }: {
  contactId: string;
  who: string;
  onClose: () => void;
  onAdded: (row: TaskRow) => void;
}): JSX.Element {
  const [kind, setKind] = useState<TaskKind>("reminder");
  const [text, setText] = useState("");
  const [quick, setQuick] = useState("10m");
  const [custom, setCustom] = useState(() => toLocalInput(Date.now() + 3_600_000));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const dueAt = (): number => (quick === "custom"
    ? new Date(custom).getTime()
    : (QUICK_TIMES.find((q) => q.id === quick)?.at() ?? NaN));

  const submit = async (): Promise<void> => {
    setErr("");
    const focus = text.trim();
    const at = dueAt();
    if (focus === "") { setErr(kind === "reminder" ? "写下到点要说的那句话" : "写下到时候想关注的事"); return; }
    if (!Number.isFinite(at)) { setErr("时间没填对，换一个快捷档或重填日期"); return; }
    if (at < Date.now() - 60_000) { setErr("时间要在未来（想现在就试一次，用下面那个「现在看看该不该说话」）"); return; }
    setBusy(true);
    try {
      const r = await proactiveApi.createProactiveTask({ kind, focus, dueAt: at }, contactId);
      onAdded(r.task);
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="添加计划" className="add-task">
      <div className="field">
        <label>这一条到点怎么处理</label>
        <div className="preset-row">
          {([
            ["reminder", "到点必达"],
            ["care", "到点想一想"],
          ] as Array<[TaskKind, string]>).map(([k, label]) => (
            <button key={k} type="button" className="preset"
              aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        <div className="hint">
          {kind === "reminder"
            ? `到点原样把这句话发给你，一定送到。`
            : `到点${who}想想该不该开口：会改写成自然的一句，也可能觉得此刻不该说。占${who}每天主动开口的次数。`}
        </div>
      </div>

      <div className="field">
        <label htmlFor="at-text">{kind === "reminder" ? "到点要说的一句话" : "到时候想关注的事"}</label>
        <textarea id="at-text" rows={2} maxLength={200} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={kind === "reminder" ? "例：该去接孩子了" : "例：周五那个答复，到时候问一句"} />
        <div className="hint">{text.trim().length} / 200 字</div>
      </div>

      <div className="field">
        <label htmlFor="at-when">什么时候</label>
        <div className="preset-row">
          {QUICK_TIMES.map((q) => (
            <button key={q.id} type="button" className="preset"
              aria-pressed={quick === q.id} onClick={() => setQuick(q.id)}>{q.label}</button>
          ))}
          <button type="button" className="preset"
            aria-pressed={quick === "custom"} onClick={() => setQuick("custom")}>自选</button>
        </div>
        {quick === "custom" && (
          <input id="at-when" type="datetime-local" className="at-custom" value={custom}
            onChange={(e) => setCustom(e.target.value)} />
        )}
        <div className="hint">
          {Number.isFinite(dueAt()) && dueAt() > Date.now()
            ? `${new Date(dueAt()).toLocaleString("zh-CN")} · ${clockOf(dueAt())} 前后`
            : "选好时间后这里显示具体时刻"}
        </div>
      </div>

      <div className="hint">「到点」不精确到分钟：前后一小会儿内发出，落在免打扰时段会顺延。</div>
      {err !== "" && <div className="onb-msg bad" role="alert">{err}</div>}
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "添加中…" : "添加"}
        </button>
        <button type="button" className="btn" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}


/** 主动性面板（内嵌在联系人资料页）：该联系人的待执行计划 / 执行记录 / 检查项（闸门）。 */
export default function ProactivePanel({ active = true, contactId, who = "联系人", panel }: {
  active?: boolean;
  panel: PanelAria;
  contactId: string;
  who?: string;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>("pending");
  const [gates, setGates] = useState<GateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [out, setOut] = useState<Out>(null);
  const [err, setErr] = useState("");

  // 两个页签各查各的一堆（服务端按 state 过滤 + 报 total）：从前一次混取 40 条，
  // 实测小茉 91 条、阿琳 67 条，后一半既翻不到也没人报一句。
  const fetchTasks = useCallback((limit: number, offset: number) =>
    proactiveApi.fetchProactiveTasks(limit, offset, tab === "history" ? "history" : "pending", contactId)
      .then((d) => ({ rows: d.tasks, total: d.total })), [tab, contactId]);
  const list = usePagedList<TaskRow>(fetchTasks, {
    key: contactId + "|" + tab, enabled: active && tab !== "gates",
  });
  const rows = list.page?.rows ?? [];

  const [gatesNonce, setGatesNonce] = useState(0);
  useEffect(() => {
    if (!active) return;
    setErr("");
    void proactiveApi.fetchProactiveGates(contactId)
      .then(setGates)
      .catch(() => { setGates(null); setErr("读取失败"); });
  }, [active, contactId, gatesNonce]);

  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wake = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!wake) return;
    list.reset();
    setGatesNonce((n) => n + 1);
  }, [active, list.reset]);

  const cancel = (row: TaskRow): void => {
    // 取消只会动这一条（pending → cancelled，它就该从「待执行」里出去）：就地摘掉。
    // 整表重拉既把人甩回顶上，又把邻行换成另一批。
    const index = rows.findIndex((x) => x.id === row.id);
    void proactiveApi.cancelProactiveTask(row.id, contactId).then(() => {
      list.drop(row.id);
      // 点错了要能反悔：后端有 restore，就给 5 秒撤销，与删记忆/归档联系人同一口径。
      offerUndo(`已取消「${row.focus}」`, () => {
        void proactiveApi.restoreProactiveTask(row.id, contactId)
          .then(() => list.insertAt(index < 0 ? 0 : index, row))
          .catch((e: Error) => setOut({ cls: "ping-out bad", text: "撤销失败：" + e.message }));
      });
    })
      .catch((e: Error) => setOut({ cls: "ping-out bad", text: "取消失败：" + e.message }));
  };

  // 面板挂在资料页上，切走即卸载：那个 1.5 秒后的补拉要跟着掐掉。
  const reloadTimer = useRef<number | null>(null);
  useEffect(() => () => { if (reloadTimer.current !== null) clearTimeout(reloadTimer.current); }, []);

  const runCheck = (): void => {
    setBusy(true);
    proactiveApi.runProactiveCheck(contactId)
      .then(() => {
        setOut({ cls: "ping-out", text: `已触发一次检查，${who}说完话会出现在「执行记录」` });
        if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
        reloadTimer.current = window.setTimeout(list.reset, 1500);
      })
      .catch((e: Error) => setOut({ cls: "ping-out bad", text: "触发失败：" + e.message }))
      .finally(() => setBusy(false));
  };

  const pending = rows.filter((t) => t.status === "pending").sort((a, b) => a.due_at - b.due_at);
  const history = rows.filter((t) => t.status !== "pending");
  const gateMap = gates?.gates ?? {};
  const blockedAt = gates?.blockedAt ?? null;
  const next = gates?.nextTask;

  return (
    <div className="pnl" {...panel}>
      <Tabs base="pnl" value={tab} onChange={setTab} tabs={[
        { key: "pending", label: "待执行" },
        { key: "history", label: "执行记录" },
        { key: "gates", label: "为什么没说" },
      ]} />

      {list.error !== "" && tab !== "gates" && (
        /* 待执行 / 执行记录两栏在读不到时整块不渲染：读取失败如果不在这儿说一句，
           用户看到的就是一片空白，和「没有计划」同形。 */
        <div className="hint">执行记录读取失败：{list.error}{" "}
          <button type="button" className="chip" onClick={list.reset}>重试</button>
        </div>
      )}

      {/* 读取失败时不渲染空 .list-card：一张没有行的卡就是横在页面上的一条细线 */}
      {tab === "pending" && list.page !== null && (
        <>
          <div className="pnl-add">
            <button type="button" className="btn sm" onClick={() => setAdding(true)}>＋ 添加计划</button>
            <span className="hint">到点必达 = 一定送到；到点想一想 = 到时候判断该不该开口。</span>
          </div>
          <div className="list-card" {...panelAria("pnl", "pending")}>
            {pending.length === 0 && (
              <div className="empty">还没有待执行的计划。点上面「添加计划」自己立一条，或等{who}自己生出打算。</div>
            )}
            {pending.map((t) => (
              <div key={t.id} className="list-row pend-row">
                <div className="form-row">
                  <div>
                    <div className="focus">
                      {t.kind === "reminder" && <span className="pend-kind">到点必达</span>}
                      {t.focus}
                    </div>
                    <div className="due">{whenText(t.due_at)}（{clockOf(t.due_at)} 前后检查）</div>
                  </div>
                  <button type="button" onClick={() => cancel(t)}>取消</button>
                </div>
              </div>
            ))}
          </div>
          {adding && (
            <AddTaskForm contactId={contactId} who={who} onClose={() => setAdding(false)}
              onAdded={(row) => list.insertAt(0, row)} />
          )}
        </>
      )}

      {tab === "history" && list.page !== null && (
        <div className="list-card" {...panelAria("pnl", "history")}>
          {history.length === 0 && <div className="empty">还没有执行记录。</div>}
          {history.map((t) => {
            const detail = t.status === "failed" ? (t.error || "失败") : (t.result || t.focus || "");
            return (
              <div key={t.id} className="list-row task-row">
                <span className={"st " + t.status}>{TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                <span className="txt">{detail.slice(0, 120)}</span>
                <span className="due">{clockOf(t.finished_at ?? t.created_at)}</span>
              </div>
            );
          })}
        </div>
      )}

      {tab !== "gates" && <ListPager page={list.page} busy={list.busy} refreshing={list.refreshing} onMore={list.more} />}

      {tab === "gates" && (
        <div {...panelAria("pnl", "gates")}>
          {gates !== null && (
            <div className="list-card">
              {GATE_DEFS.map((def, i) => {
                const info = gateMap[def.key] ?? { passed: true, detail: "" };
                let cls = "passed";
                let verdict = "通过";
                if (blockedAt !== null && def.key === blockedAt) { cls = "blocked"; verdict = "卡在这里"; }
                else if (blockedAt !== null && info.passed === false) { cls = "none"; verdict = "未评估"; }
                return (
                  <div key={def.key} className={"list-row gate " + cls}>
                    <span className="idx">{i + 1}</span>
                    <span className="name">{def.name}</span>
                    <span className="detail">{info.detail || ""}</span>
                    <span className="verdict">{verdict}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="hint">
            {gates === null
              ? <>{err === "" ? "检查项状态读不到" : err}，因此无法判断{who}这次该不该找你。{" "}<button type="button" className="chip" onClick={() => setGatesNonce((n) => n + 1)}>重试</button></>
              : blockedAt === null
              ? <>全部检查项通过。下一次主动消息计划见「待执行」。</>
              : blockedAt === "quiet"
              // 免打扰时段挡下来是设计如此，不是没通过检查——别一边把这一行标成
              // 「卡在这里」，一边在底下写「全部检查项通过」。
              ? <>这一次没发不是故障：正处在免打扰时段（上面第 {(GATE_DEFS.findIndex((x) => x.key === "quiet")) + 1} 项）。{who}会在时段结束后照常判断。</>
              : <>本次未发送主动消息：未通过「{(GATE_DEFS.find((x) => x.key === blockedAt) ?? {}).name}」检查。</>}
          </div>
          {/* 读不到闸门时不写「暂无待执行计划」——那是把请求失败说成没有计划 */}
          {gates !== null && (
            <div className="list-card next-task">
              {next && next.focus ? (
                <div className="list-row">
                  <b>下一次主动消息计划</b>
                  <div className="focus">{next.focus}</div>
                  <div className="due">{whenText(next.due_at)}（{clockOf(next.due_at)} 前后检查）</div>
                </div>
              ) : (
                <div className="empty">还没有待执行的计划。</div>
              )}
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={runCheck}>
              {busy ? "检查中…" : "现在看看该不该说话"}
            </button>
            {out && <div className={out.cls}>{out.text}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
