import { useCallback, useEffect, useRef, useState } from "react";
import { contactsApi, settingsApi, usageApi } from "../../api";
import { fmtInt, fmtTokens } from "../../lib/format";
import { profileTitle } from "../../lib/providers";
import { purposeLabel } from "./constants";
import type { UsageBucket, UsageStats } from "../../types";
import type { PanelAria } from "../../components/Tabs";

/** 维度选择式用量页：今日速览常驻，下面四选一（点哪个看哪个），不再全部堆叠下滑。 */
type Dim = "day" | "model" | "contact" | "purpose";
const LS_DIM = "xiaomo.usageDim";
const DIMS: Array<{ key: Dim; label: string; hint: string; col: string }> = [
  { key: "day", label: "按日", hint: "近 7 天", col: "日期" },
  { key: "model", label: "按模型", hint: "近 30 天 · 每档一行", col: "模型" },
  { key: "contact", label: "按联系人", hint: "近 30 天", col: "联系人" },
  { key: "purpose", label: "按用途", hint: "近 30 天", col: "用途" },
];

/** 用量表初始行数与每次「加载更多」的增量，与调用记录 tab 的翻页手感一致。 */
const PAGE_START = 7;
const PAGE_STEP = 7;

/**
 * 近 7 天消息量 sparkline：纯手写 SVG，不引图表依赖。
 * 设计取舍：
 * - 只画「有记录的日子」——与按日表同一口径（后端 GROUP BY 本来就不给空日子），不硬造 0 点补齐；
 * - 失败线与主曲线共用一套「0 ~ 最高调用」的坐标系：各自归一化会把“失败很多”画得像“失败很少”；
 * - 完全静态、不做生长动画：一瞥即懂的小图上动画是噪音，也免去 prefers-reduced-motion 的专门分支。
 */
const SPARK_H = 56; // 画布高（像素）：SVG 几何不属于主题语义（令牌里没有“图高”这一档），须与 components.css 的 .usage-spark-wrap 保持一致。

function UsageSpark({ days }: { days: UsageStats["byDay"] }): JSX.Element | null {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  // 容器量出多宽，viewBox 就设多宽：1:1 坐标系下数据点才是正圆，
  // preserveAspectRatio="none" 那套省事方案会把圆点拉成椭圆，所以宁可等一帧再画。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      if (cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // byDay 新的一天在前，画趋势先转成时间正序；只取最近 7 个有记录的日子。
  const pts = days.slice(0, 7).reverse();
  const maxCalls = Math.max(0, ...pts.map((p) => p.calls));
  const maxFail = Math.max(0, ...pts.map((p) => p.fail));
  // 画不画的门槛：不足两点连不成线，全是 0 是贴底的直线——都没有信息量，宁可不画。
  if (pts.length < 2 || maxCalls === 0) return null;
  const hi = pts.reduce((a, b) => (b.calls > a.calls ? b : a));
  const lo = pts.reduce((a, b) => (b.calls < a.calls ? b : a));
  const failTotal = pts.reduce((n, p) => n + p.fail, 0);

  // 坐标系内缩留出数据点半径，两端点不被裁掉。
  const PAD = 6;
  const x = (i: number): number => PAD + (i * (w - PAD * 2)) / (pts.length - 1);
  const y = (v: number, max: number): number => SPARK_H - PAD - (v / max) * (SPARK_H - PAD * 2);
  const line = (vals: number[], max: number): string =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v, max).toFixed(1)}`).join(" ");

  return (
    <div>
      <div className="usage-spark-wrap" ref={wrapRef}>
        {w > 0 && (
          <svg className="usage-spark" viewBox={`0 0 ${w} ${SPARK_H}`} role="img"
            aria-label={`近 7 天消息量趋势，最高 ${hi.calls}（${hi.day}），最低 ${lo.calls}（${lo.day}）`
              + (failTotal > 0 ? `；同期失败共 ${failTotal} 次` : "")}>
            {maxFail > 0 && <path className="spark-fail" d={line(pts.map((p) => p.fail), maxCalls)} />}
            <path className="spark-line" d={line(pts.map((p) => p.calls), maxCalls)} />
            {pts.map((p, i) => (
              <circle key={p.day} className="spark-dot" cx={x(i).toFixed(1)} cy={y(p.calls, maxCalls).toFixed(1)} r={2.5} />
            ))}
          </svg>
        )}
      </div>
      {/* 图例只给两条线各一句话：颜色含义靠它说，而不是逼用户去猜红线是什么。 */}
      <div className="usage-spark-legend">
        <span><i className="spark-swatch-main" />消息量</span>
        {maxFail > 0 && <span><i className="spark-swatch-fail" />失败</span>}
      </div>
    </div>
  );
}

/** 模型用量 tab：今日速览 + 近 7 天按日、近 30 天按模型/联系人/用途的分布。token 依赖服务商返回 usage，旧记录为 0。 */
export default function UsageSection({ panel, refreshNonce = 0 }: {
  panel: PanelAria;
  /** 「刷新」每点一次自增：本组件**原地重拉统计**，不靠重挂自己（重挂会把已展开的行数抹回 7 行、各维度表齐闪一遍读取中）。 */
  refreshNonce?: number;
}): JSX.Element {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [profileLabels, setProfileLabels] = useState<Record<string, string>>({});
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [dim, setDim] = useState<Dim>(() => {
    const saved = localStorage.getItem(LS_DIM);
    return saved === "model" || saved === "contact" || saved === "purpose" ? saved : "day";
  });
  /** 当前维度表的可见行数：默认 7 行，「加载更多」每次再放 7 行（数据本来就一次全量拉到前端）。 */
  const [limit, setLimit] = useState(PAGE_START);

  const loadStats = useCallback((): Promise<void> =>
    usageApi.fetchUsageStats().then((d) => { setUsage(d); setLoadErr(""); }).catch((e: Error) => setLoadErr(e.message)), []);

  const load = useCallback((): void => {
    void loadStats();
    // 名字映射只为展示用：拿不到就退回 id/占位文案，不影响统计本身。
    // 所以它们只在挂载时拉一次——点「刷新」不必重敲这两个接口。
    void settingsApi.fetchSettings().then((s) => setProfileLabels(
      // 写成「供应商 · 模型名」：一家挂几个模型之后，光看档名分不出用量记到哪一把上
      Object.fromEntries((s.profiles ?? []).map((p) => [p.id, profileTitle(p, s.providerNames ?? {}, s.profiles ?? [])])),
    )).catch(() => undefined);
    void contactsApi.fetchContacts().then((d) => setContactNames(
      Object.fromEntries(d.contacts.map((c) => [c.id, c.name])),
    )).catch(() => undefined);
  }, [loadStats]);

  useEffect(load, [load]);

  // 刷新只重拉统计，旧数字先顶着：整块清空和"跳回 7 行"是同一种失礼
  const seenNonceRef = useRef(refreshNonce);
  useEffect(() => {
    if (seenNonceRef.current === refreshNonce) return;
    seenNonceRef.current = refreshNonce;
    setRefreshing(true);
    void loadStats().finally(() => setRefreshing(false));
  }, [refreshNonce, loadStats]);

  if (!usage) {
    return (
      <div className="section sec-usage" {...panel}>
        <h2>模型用量</h2>
        {loadErr === "" ? (
          <><div className="skeleton" style={{ height: 56, margin: "8px 0" }} /><div className="skeleton" style={{ height: 56 }} /></>
        ) : (
          <div className="hint">加载失败：{loadErr}
            <button type="button" className="chip" style={{ marginLeft: 8 }} onClick={load}>重试</button>
          </div>
        )}
      </div>
    );
  }
  const t: UsageBucket = usage.today;

  return (
    <div className="section sec-usage" {...panel}>
      <h2>模型用量{refreshing ? <span className="hint" style={{ fontWeight: 400, marginLeft: 8 }}>刷新中…</span> : null}</h2>
      <div className="desc">用量以服务商返回的为准；有的模型不返回就记 0。</div>
      <div className="stats" id="usageStats">
        <div className="stat"><div className="n">{fmtInt(t.calls)}</div><div className="t">今日调用{t.fail > 0 ? ` · 失败 ${t.fail}` : ""}</div></div>
        <div className="stat"><div className="n">{fmtTokens(t.totalTokens)}</div><div className="t">今日消耗</div></div>
        <div className="stat"><div className="n">{fmtTokens(usage.week.totalTokens)}</div><div className="t">近 7 天消耗</div></div>
        <div className="stat"><div className="n">{fmtInt(usage.total.calls)}</div><div className="t">累计调用{usage.total.fail > 0 ? ` · 失败 ${usage.total.fail}` : ""}</div></div>
        <div className="stat"><div className="n">{fmtTokens(usage.total.totalTokens)}</div><div className="t">累计消耗</div></div>
      </div>

      {/* 近 7 天趋势贴着数字块：先看「今天多少」，顺势看「这几天是涨是落」。 */}
      <UsageSpark days={usage.byDay} />

      {/* 维度四选一：点哪个看哪个，页面不再纵向堆叠 */}
      <div className="u-dims" role="radiogroup" aria-label="统计维度">
        {DIMS.map((x) => (
          <button key={x.key} type="button" role="radio" aria-checked={dim === x.key}
            className={"prof-chip" + (dim === x.key ? " on" : "")}
            onClick={() => { setDim(x.key); setLimit(PAGE_START); localStorage.setItem(LS_DIM, x.key); }}>
            {x.label}
          </button>
        ))}
      </div>

      {(() => {
        const head = DIMS.find((x) => x.key === dim)!;
        const rowsAll: Array<{ key: string; label: string; calls: number; fail: number | null; tokens: number }> =
          dim === "day" ? usage.byDay.map((d) => ({ key: d.day, label: d.day, calls: d.calls, fail: d.fail, tokens: d.totalTokens }))
            : dim === "model" ? (usage.byModel ?? []).map((r, i) => ({
              // 同一档可以出现在多行（档 × 模型），key 必须带上行号，不能只按 profileId
              key: `${r.profileId ?? "global"}|${r.model ?? ""}|${i}`,
              label: (r.profileId
                ? (profileLabels[r.profileId] ?? "已删除的模型")
                : /(^|,)(asr|tts)(,|$)/.test(r.purposes ?? "") ? "能力调用（语音/视觉）" : "默认模型")
                + (r.model ? " · " + r.model : ""),
              calls: r.calls, fail: r.fail, tokens: r.totalTokens,
            }))
              : dim === "contact" ? (usage.byContact ?? []).map((r, i) => ({
                key: r.contactId ?? "none" + i,
                label: r.contactId ? (contactNames[r.contactId] ?? "联系人已删除") : "后台自动调用",
                calls: r.calls, fail: r.fail, tokens: r.totalTokens,
              }))
                : usage.byPurpose.map((p) => ({
                  key: p.purpose, label: purposeLabel(p.purpose), calls: p.calls, fail: null, tokens: p.totalTokens,
                }));
        // 四个维度共用一套翻页手感：默认 7 行，「加载更多」每次再放 7 行。
        // 后端已把「最该先看的」排在第一行：按日=最近一天在前，其余=调用数降序。
        const unit = dim === "day" ? "天" : "条";
        const shown = Math.min(limit, rowsAll.length);
        const rows = rowsAll.slice(0, limit);
        return (
          <div className="table-wrap u-card">
            <div className="u-head">
              <span className="u-title">{head.label}</span>
              <span className="u-hint">{dim === "day" ? `近 ${shown} 天` : head.hint}</span>
            </div>
            <table>
              <thead>
                <tr><th>{head.col}</th><th>调用</th>{dim !== "purpose" && <th>失败</th>}<th>tokens</th></tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={dim === "purpose" ? 3 : 4} className="empty">还没有调用记录</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td className="num">{r.calls}</td>
                    {dim !== "purpose" && (
                      <td className="num">{r.fail && r.fail > 0 ? <span className="bad-mark">{r.fail}</span> : 0}</td>
                    )}
                    <td className="num">{r.tokens > 0 ? fmtTokens(r.tokens) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rowsAll.length > 0 && (
              <div className="tbl-pager">
                <span className="hint">已显示 {shown} / 共 {rowsAll.length} {unit}</span>
                {shown < rowsAll.length && (
                  <button type="button" className="btn sm ghost" onClick={() => setLimit((v) => v + PAGE_STEP)}>
                    加载更多
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
