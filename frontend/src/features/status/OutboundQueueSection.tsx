import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";
import { outboundApi } from "../../api";
import { usePagedList } from "../../hooks/usePagedList";
import ListPager from "../../components/ListPager";
import { clockOf, dayLabel } from "../../lib/datetime";
import type { OutboundDeliveryRow, OutboundStatus, OutboundSummary } from "../../types";

const STATUS_LABEL: Record<OutboundStatus, string> = {
  pending: "等待发送",
  in_flight: "正在发送",
  delivered: "已送达",
  failed: "等待重试",
  dead_letter: "死信",
  expired: "已过期",
  ignored: "已忽略",
};

const CHANNEL_LABEL: Record<string, string> = { qq: "QQ", wechat: "微信", web: "应用内" };

/** 概况卡里可点的那几张：点一下就是把下面的筛选切到同一档，省掉再去 chips 里找一次。 */
type StatFilter = OutboundStatus | "open" | "dead";

function ageText(at: number | null | undefined): string {
  if (!at) return "—";
  const ms = Math.max(0, Date.now() - at);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时`;
  return `${Math.floor(hour / 24)} 天`;
}

function StatusBadge({ status }: { status: OutboundStatus }) {
  if (status === "delivered") return <span className="activity-status ok"><CheckCircle2 size={12} />已送达</span>;
  if (status === "in_flight") return <span className="activity-status live"><Loader2 size={12} className="spin" />正在发送</span>;
  if (status === "dead_letter" || status === "expired") return <span className="activity-status bad"><XCircle size={12} />{STATUS_LABEL[status]}</span>;
  if (status === "failed") return <span className="activity-status warn"><AlertTriangle size={12} />等待重试</span>;
  return <span className="activity-status">{STATUS_LABEL[status]}</span>;
}

export default function OutboundQueueSection({ active, devMode, onChanged }: {
  active: boolean;
  devMode: boolean;
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<OutboundStatus | "open" | "dead" | "all">("open");
  const [channel, setChannel] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<OutboundSummary | null>(null);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const fetchPage = useCallback((limit: number, offset: number) => {
    return outboundApi.list({ status, channel: channel || undefined, q: query || undefined, limit, offset })
      .then((data) => {
        setSummary(data.summary);
        return { rows: data.rows, total: data.total };
      });
  }, [status, channel, query]);

  const page = usePagedList<OutboundDeliveryRow>(fetchPage, {
    key: `${status}|${channel}|${query}`,
    enabled: active,
  });

  const refresh = (): void => { page.reset(); onChanged?.(); };

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => page.reset(), 5000);
    return () => window.clearInterval(timer);
  }, [active, page.reset]);

  const retry = async (row: OutboundDeliveryRow): Promise<void> => {
    if (!row.id) return;
    setBusyId(row.id); setError(""); setNotice("");
    try {
      const out = await outboundApi.retry(row.id);
      setNotice(out.message);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(""); }
  };

  const ignore = async (row: OutboundDeliveryRow): Promise<void> => {
    if (!row.id) return;
    if (!window.confirm("忽略后不会再自动重试。确定忽略这条投递吗？")) return;
    setBusyId(row.id); setError(""); setNotice("");
    try {
      const out = await outboundApi.ignore(row.id);
      setNotice(out.message);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(""); }
  };

  const retryAll = async (): Promise<void> => {
    if (!window.confirm("将重试当前所有死信。旧消息可能已经过时，确定继续吗？")) return;
    setBulkBusy(true); setError(""); setNotice("");
    try {
      const out = await outboundApi.retryAll();
      setNotice(out.message);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBulkBusy(false); }
  };

  const purge = async (): Promise<void> => {
    if (!window.confirm("只清理超过 7 天的死信、过期和已忽略记录，确定继续吗？")) return;
    setBulkBusy(true); setError(""); setNotice("");
    try {
      const out = await outboundApi.purge();
      setNotice(out.message);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBulkBusy(false); }
  };

  const rows = page.page?.rows ?? [];

  /** 卡片选中态跟着筛选值走；「最老待处理」只是读数，保持静态。 */
  const statClass = (key: StatFilter, tone = ""): string =>
    "outbound-stat" + (tone ? ` ${tone}` : "") + (status === key ? " on" : "");

  return (
    <div className="section outbound-queue" id="outboundQueue">
      <div className="activity-title-row">
        <div>
          <h2>投递队列</h2>
          <p className="hint">文字消息先落盘再发送。失败会自动重试；超过重试次数或时效后进入死信。</p>
        </div>
        <div className="outbound-head-actions">
          {devMode && (
            <>
              <button type="button" className="btn sm" disabled={bulkBusy} onClick={() => void retryAll()}>
                <RotateCcw size={13} />重试全部死信
              </button>
              <button type="button" className="btn sm" disabled={bulkBusy} onClick={() => void purge()}>
                <Trash2 size={13} />清理 7 天前终态
              </button>
            </>
          )}
          <button type="button" className="btn sm" onClick={refresh}><RefreshCw size={13} />刷新</button>
        </div>
      </div>

      {summary && (
        <div className="outbound-summary" role="group" aria-label="投递队列概况">
          <button type="button" className={statClass("open")} aria-pressed={status === "open"}
            title="只看待处理" onClick={() => setStatus("open")}>
            <b>{summary.open}</b><span>待处理</span>
          </button>
          <button type="button" className={statClass("dead", summary.dead > 0 ? "bad" : "")} aria-pressed={status === "dead"}
            title="只看死信" onClick={() => setStatus("dead")}>
            <b>{summary.dead}</b><span>死信</span>
          </button>
          <button type="button" className={statClass("in_flight")} aria-pressed={status === "in_flight"}
            title="只看正在发送" onClick={() => setStatus("in_flight")}>
            <b>{summary.counts.in_flight}</b><span>发送中</span>
          </button>
          <div className="outbound-stat">
            <b>{ageText(summary.oldestOpenAt)}</b><span>最老待处理</span>
          </div>
          <button type="button" className={statClass("delivered")} aria-pressed={status === "delivered"}
            title="只看已送达" onClick={() => setStatus("delivered")}>
            <b>{summary.counts.delivered}</b><span>已送达</span>
          </button>
        </div>
      )}

      <div className="activity-toolbar outbound-toolbar">
        <div className="activity-filter-group" role="group" aria-label="投递状态">
          {[
            { key: "open", label: "待处理" },
            { key: "dead", label: "死信" },
            { key: "delivered", label: "已送达" },
            { key: "all", label: "全部" },
          ].map((item) => (
            <button key={item.key} type="button" className={"chip" + (status === item.key ? " on" : "")}
              aria-pressed={status === item.key} onClick={() => setStatus(item.key as typeof status)}>
              {item.label}
            </button>
          ))}
          <select className="ml-select outbound-channel-select" aria-label="按通道筛选" value={channel}
            onChange={(e) => setChannel(e.target.value)}>
            <option value="">全部通道</option>
            <option value="qq">QQ</option>
            <option value="wechat">微信</option>
          </select>
        </div>
        <form className="emote-search media-search outbound-search" onSubmit={(e) => { e.preventDefault(); setQuery(queryDraft.trim()); }}>
          <input value={queryDraft} onChange={(e) => setQueryDraft(e.target.value)} placeholder="搜索消息或失败原因" aria-label="搜索投递记录" />
          <button type="submit" className="chip">搜索</button>
        </form>
      </div>

      {notice && <div className="ov-note" role="status">{notice}</div>}
      {error && <div className="ov-note bad" role="alert">{error}</div>}
      {page.error && <div className="ov-note bad" role="alert">读取失败：{page.error}</div>}

      <div className="table-wrap outbound-table-wrap">
        <table className="outbound-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>联系人 / 通道</th>
              <th>消息</th>
              <th>状态</th>
              <th>尝试</th>
              <th>原因</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {page.page === null ? (
              <tr><td colSpan={7} className="empty">读取中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="empty">{status === "dead" ? "没有死信记录" : "当前没有投递记录"}</td></tr>
            ) : rows.map((row) => (
              <tr key={row.id ?? `${row.createdAt}-${row.text}`}>
                <td className="num" title={new Date(row.createdAt).toLocaleString()}>
                  {dayLabel(row.createdAt)} {clockOf(row.createdAt)}
                </td>
                <td>
                  <div className="outbound-who"><b>{row.contactName ?? row.contactId ?? "联系人"}</b><span>{CHANNEL_LABEL[row.channel] ?? row.channel}</span></div>
                  {devMode && row.id && <div className="outbound-debug">{row.id}{row.tier ? ` · ${row.tier}` : ""}</div>}
                </td>
                <td><span className="outbound-message">{row.text || "（空消息）"}</span></td>
                <td><StatusBadge status={row.status} /></td>
                <td className="num">{row.attempts}/{row.maxAttempts}</td>
                <td><span className="outbound-reason">{row.reason || row.lastError || (row.status === "in_flight" ? "正在等待通道返回" : "—")}</span></td>
                <td>
                  <div className="outbound-actions">
                    {row.id && ["failed", "dead_letter", "expired", "ignored"].includes(row.status) && (
                      <button type="button" className="btn sm" disabled={busyId === row.id} onClick={() => void retry(row)}>重试</button>
                    )}
                    {row.id && ["failed", "dead_letter", "expired"].includes(row.status) && (
                      <button type="button" className="btn sm ghost" disabled={busyId === row.id} onClick={() => void ignore(row)}>忽略</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.error === "" && <ListPager page={page.page} busy={page.busy} refreshing={page.refreshing} onMore={page.more} />}
    </div>
  );
}
