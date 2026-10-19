import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import Tabs, { panelAria, type PanelAria } from "../../components/Tabs";
import TabPanel from "../../components/TabPanel";
import Modal from "../../components/Modal";
import { getJson, settingsApi } from "../../api";
import { cachedStatus, loadStatus, resetCounters as resetCountersStore } from "../../lib/statusStore";
import { cachedCaps, loadCaps, type Caps } from "../../lib/capsStore";
import { clockOf } from "../../lib/datetime";
import { copyText } from "../../lib/clipboard";
import OverviewSection from "./OverviewSection";
import UsageSection from "./UsageSection";
import RecallSection from "./RecallSection";
import type { SettingsTab } from "../settings/SettingsView";
import { PURPOSE_LABEL, TURN_LABEL } from "./constants";
import { usePagedList } from "../../hooks/usePagedList";
import ListPager from "../../components/ListPager";
import type { StatusData, ModelCallRow, InflightCall, StatusTurnRow } from "../../types";

type PingOut = { cls: string; text: string } | null;
type Tab = "overview" | "usage" | "calls" | "turns" | "recall";

/** 调用记录的筛选芯片：失败与用途互斥地组合成一条 WHERE，服务端算 total。 */
type CallFilterDef = { id: string; label: string; failed?: boolean; purpose?: string; scope?: "model" | "channel" };
/** 默认那一档：只列模型调用。每个筛选都显式带 scope，漏写一个，
    「只看失败」就会把 QQ 失败也捞进来——那正是要择开的东西。 */
const MODEL_CALLS: CallFilterDef = { id: "all", label: "模型调用", scope: "model" };
const CALL_FILTERS: CallFilterDef[] = [
  MODEL_CALLS,
  { id: "failed", label: "只看失败", failed: true, scope: "model" },
  { id: "chat", label: "回消息", purpose: "chat", scope: "model" },
  { id: "extract", label: "记忆整理", purpose: "extract", scope: "model" },
  { id: "proactive", label: "主动判断", purpose: "proactive", scope: "model" },
  // 通道投递（QQ / 微信）打的不是模型，只是记在同一张表里。默认视图把它们择开，
  // 想看投递成没成再到这一档——否则列表前十几行全是 qq，模型调用被挤到看不见。
  { id: "channel", label: "通道投递", scope: "channel" },
];

/** 毫秒读数：过秒就换成秒，一屏 12345ms 这种数没法扫。 */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 请求体是 JSON 字符串，格式化后更好读；解析失败就原样显示。 */
function prettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

/** 状态视图（全局）：总览（状态与配置）/ 模型用量 / 调用记录 / 最近处理 / 记忆召回测试。切到哪个 tab 才拉哪个的数据。 */
export default function StatusView({ active = true, contactId, contactName, contactAvatar, onSwitchContact, onOpenContacts, goSettings }: {
  /** 视图是否真正可见：保活后的隐藏页不再偷偷刷新。 */
  active?: boolean;
  contactId: string;
  contactName: string;
  contactAvatar: string;
  onSwitchContact: (id: string) => void;
  onOpenContacts: () => void;
  goSettings: (tab: SettingsTab) => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>("overview");
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set(["overview"]));
  const [usageNonce, setUsageNonce] = useState(0);
  /** 上次的结果先顶上：切走再切回不必重看一遍「读取中…」（缓存见 lib/statusStore）。 */
  const [status, setStatus] = useState<StatusData | null>(() => cachedStatus(contactId));
  const [statusErr, setStatusErr] = useState("");
  const [caps, setCaps] = useState<Caps | null>(cachedCaps);
  const [capsErr, setCapsErr] = useState("");
  const [capsNonce, setCapsNonce] = useState(0);
  /** 在飞的调用：记录表只落已完成的行，模型十几秒不返回时这里才有「正在进行中」可看。 */
  const [inflight, setInflight] = useState<InflightCall[]>([]);
  // 开发者模式 = 后端 DEV_MODE（`npm run dev` 开 / `start` 与桌面版关）。
  // 刻意**不在设置里给开关**：那是"用哪种方式起这个程序"的属性，不是用户的界面偏好；
  // 摆在设置里只会让人以为普通使用需要动它。
  const devMode = status?.devMode === true;
  // 停在排障 tab（调用记录/最近处理/记忆测试）时后端不是 dev（例如换了个正常模式起的实例）→ 落回总览。
  useEffect(() => {
    if (status && !devMode) setTab((t) => (t === "calls" || t === "turns" || t === "recall" ? "overview" : t));
  }, [status, devMode]);
  /** 点开「查看原文」的那条调用：列表只发摘要，全文按行另取一次。 */
  const [rawId, setRawId] = useState<number | null>(null);
  const [rawCall, setRawCall] = useState<ModelCallRow | null>(null);
  const [rawErr, setRawErr] = useState("");
  const [pingOut, setPingOut] = useState<PingOut>(null);
  const [busy, setBusy] = useState("");
  const [diag, setDiag] = useState<"idle" | "busy" | "ok" | "bad">("idle");
  /** 调用记录的筛选：全部 / 只看失败 / 按用途。total 也跟着这条筛走，见 CALL_FILTERS。 */
  const [callFilter, setCallFilter] = useState("all");

  useEffect(() => {
    setVisitedTabs((prev) => prev.has(tab) ? prev : new Set(prev).add(tab));
  }, [tab]);

  // 换联系人：总览里的记忆条数与主动性闸门都是按人算的，先落回那位的缓存再刷新。
  useEffect(() => { setStatus(cachedStatus(contactId)); setStatusErr(""); }, [contactId]);

  const refreshStatus = useCallback((): void => {
    loadStatus(contactId)
      .then((d) => { setStatus(d); setStatusErr(""); })
      // 拉不到新值不等于旧值是假的：留着上次的结果，另给一条说明白的话。
      .catch((e: Error) => setStatusErr(e.message));
  }, [contactId]);

  // 能力就绪与总览并行拉。能力卡此前挂在「/api/status 回来了」之后，白多串一个往返。
  useEffect(() => {
    if (!active || tab !== "overview") return;
    loadCaps()
      .then((c) => { setCaps(c); setCapsErr(""); })
      .catch((e: Error) => setCapsErr(e.message));
  }, [active, tab, capsNonce]);

  // ── 两张翻页表：统一走 usePagedList，每页条数取「界面 → 列表每页」那一档 ──
  const filterDef = CALL_FILTERS.find((f) => f.id === callFilter) ?? MODEL_CALLS;
  const fetchCalls = useCallback((limit: number, offset: number) =>
    getJson<{ calls: ModelCallRow[]; total: number }>(
      `/api/logs?limit=${limit}&offset=${offset}`
      + (filterDef.failed ? "&failed=1" : "")
      + (filterDef.purpose ? "&purpose=" + filterDef.purpose : "")
      + (filterDef.scope ? "&scope=" + filterDef.scope : ""),
    ).then((d) => ({ rows: d.calls, total: d.total })), [filterDef]);
  const callsPage = usePagedList<ModelCallRow>(fetchCalls, { key: "calls|" + callFilter, enabled: active && tab === "calls" });

  const fetchTurns = useCallback((limit: number, offset: number) =>
    getJson<{ turns: StatusTurnRow[]; stats: { total: number } }>(`/api/turns/recent?limit=${limit}&offset=${offset}`)
      .then((d) => ({ rows: d.turns, total: d.stats.total })), []);
  const turnsPage = usePagedList<StatusTurnRow>(fetchTurns, { key: "turns", enabled: active && tab === "turns" });

  // 懒加载：总览有自己的缓存，进 tab 才刷；两张表由 usePagedList 在 enabled 时拉第一页。
  useEffect(() => {
    if (active && tab === "overview") refreshStatus();
  }, [active, tab, refreshStatus]);

  /** 只在「有在飞的调用」时轮询：平时这个页面一个额外请求都不发。
   *  从有到无的那一刻把列表刷回第一页，刚跑完的那条立刻出现，不用手动刷新。 */
  const inflightCountRef = useRef(0);
  useEffect(() => {
    if (tab !== "calls") return;
    const poll = (): void => {
      if (document.hidden || !active) return; // 与本仓库其它轮询链同一纪律：后台或隐藏视图不发请求
      // limit=0：这一拍只要 inflight，一行摘要都不必拖回来。
      void getJson<{ inflight?: InflightCall[] }>("/api/logs?limit=0")
        .then((d) => {
          const next = d.inflight ?? [];
          const was = inflightCountRef.current;
          inflightCountRef.current = next.length;
          setInflight(next);
          if (was > 0 && next.length === 0) callsPage.reset();
        })
        .catch(() => { /* 一拍轮询失败不打扰，下一拍再说 */ });
    };
    poll();
    if (inflight.length === 0) return;
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
    // callsPage.reset 是稳定身份（usePagedList 里 useCallback([])），列进依赖不会重挂轮询
  }, [active, tab, inflight.length, callsPage.reset]);

  /** 复制一段人类能直接转发的诊断摘要：版本、模型、通道、最近失败与运行环境。 */
  const copyDiagnostics = async (): Promise<void> => {
    setDiag("busy");
    const latestError = status?.lastModelError;
    const text = [
      `小茉 ${__APP_VERSION__}`,
      `时间：${new Date().toLocaleString()}`,
      `系统：${navigator.userAgent}`,
      `模型：${status ? `${status.provider || "未命名"} / ${status.model || "未配置"}` : "状态未加载"}`,
      `接口：${status?.baseUrl || "未配置"}`,
      `模型就绪：${status ? (status.modelReady ? "是" : "否") : "未知"}`,
      `近 24 小时：${status?.recent ? `${status.recent.calls} 次调用 / ${status.recent.fail} 次失败` : "未知"}`,
      `通道：${status?.channels?.join("、") || "未知"}`,
      `处理单：${status?.turns ? `总 ${status.turns.total}，失败 ${status.turns.failed}，进行中 ${status.turns.inFlight}` : "未知"}`,
      `最近错误：${latestError ? `${latestError.code || "ERROR"} ${latestError.message || ""}`.slice(0, 300) : "无"}`,
      statusErr ? `状态页读取错误：${statusErr}` : "",
    ].filter(Boolean).join("\n");
    const result = await copyText(text);
    setDiag(result === "ok" ? "ok" : "bad");
    window.setTimeout(() => setDiag("idle"), 1800);
  };

  const refresh = (): void => {
    if (tab === "overview") { refreshStatus(); setCapsNonce((n) => n + 1); return; }
    if (tab === "usage") { setUsageNonce((k) => k + 1); return; }
    // 刷新 = 清空后重新从第一页拉
    if (tab === "calls") callsPage.reset();
    if (tab === "turns") turnsPage.reset();
  };

  /** 点开某一行才取这一条的全文：列表页永远不带着两列原文跑。 */
  const openRaw = (id: number): void => {
    setRawId(id);
    setRawCall(null);
    setRawErr("");
    void getJson<{ call: ModelCallRow }>(`/api/logs/${id}`)
      .then((d) => setRawCall(d.call))
      .catch((e: Error) => setRawErr(e.message));
  };
  const closeRaw = (): void => { setRawId(null); setRawCall(null); setRawErr(""); };

  /** 失败的处理单直达那一次调用：从前只有手写探针才看得到请求原文。 */
  const openRawForTurn = (turnId: string): Promise<void> =>
    getJson<{ calls: ModelCallRow[] }>(`/api/logs?turnId=${encodeURIComponent(turnId)}&limit=1`)
      .then((d) => {
        const row = d.calls[0];
        if (row === undefined) {
          // 一轮一个调用记录都没有 = 根本没发出请求（被取消/被闸门挡了），说破而不是弹空窗
          setRawId(-1);
          setRawCall(null);
          setRawErr("这一轮没有留下模型调用记录：请求可能根本没发出去（被打断或闸门拦下）。");
          return;
        }
        openRaw(row.id);
      });

  const ping = (): void => {
    setBusy("ping");
    settingsApi.pingModel({ want: "chat" })
      .then((data) => {
        if (!data.modelReady) {
          // 注意：ping 接口不看 echo 开关（echo 下也能试连），modelReady=false 只代表参数不全
          setPingOut({ cls: "ping-out bad", text: String(data.hint || "还不能调用模型：检查接口地址与密钥是否已配置") });
          return;
        }
        const pingRes = data.ping as { ok?: boolean; elapsedMs?: number; text?: string; code?: string; message?: string } | undefined;
        const lines: string[] = [];
        lines.push(pingRes && pingRes.ok ? "连上了" : "连不上");
        if (pingRes) {
          lines.push(pingRes.ok
            ? `模型回了：「${(pingRes.text || "").slice(0, 30)}」`
            : `没连上 ${pingRes.code ?? ""} ${pingRes.message ?? ""}`);
        }
        setPingOut({
          cls: "ping-out " + (pingRes && pingRes.ok ? "good" : "bad"),
          text: lines.join("\n"),
        });
      })
      .catch((e: Error) => setPingOut({ cls: "ping-out bad", text: "测试失败：" + e.message }))
      .finally(() => { setBusy(""); refreshStatus(); });
  };

  /** 失败读数的「重新计数」：只挪读数起点，历史调用记录一条不删。 */
  const resetCounters = (): void => {
    setBusy("reset");
    setPingOut(null);
    resetCountersStore(contactId)
      .then((d) => { setStatus(d); setStatusErr(""); setPingOut({ cls: "ping-out good", text: "红点已清零，记录都还在。" }); })
      .catch((e: Error) => setPingOut({ cls: "ping-out bad", text: "红点清零失败：" + e.message }))
      .finally(() => setBusy(""));
  };

  /** 当前分区根元素上的 ARIA：把面板回指到选中的 tab。 */
  const panelFor = (key: Tab): PanelAria => panelAria("st", key);
  const list = tab === "calls" ? callsPage : tab === "turns" ? turnsPage : null;
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "状态与配置" },
    { key: "usage", label: "模型用量" },
  ];
  // 调用记录 / 最近处理 / 记忆测试都是排障面，只留开发者模式（= 后端 DEV_MODE，`npm run dev` 起才有）。
  if (devMode) tabs.push(
    { key: "calls", label: "调用记录" },
    { key: "turns", label: "最近处理" },
    { key: "recall", label: "记忆测试" },
  );

  /** 表格底部：四张管理面表共用的那一句「已显示 X / 共 Y」。 */
  const pager = (): JSX.Element | null =>
    (list === null ? null : <ListPager page={list.page} busy={list.busy} refreshing={list.refreshing} onMore={list.more} />);

  /** 每个 tab 一句话说明，渲染在分段控件下方，切 tab 即换。 */
  const TAB_DESC: Record<Tab, string> = {
    overview: "现在这套配置长什么样、跑得怎么样：模型、能力、通道、运行。只读；想改就点各卡片右上角的「去设置」。",
    usage: "模型用了多少、哪个模型用得多、和谁聊的；统计近 30 天。",
    calls: "模型调用的每一次动作——回消息、整理记忆、主动找你、画图，成没成都在这里。QQ/微信投递不在这儿，点「通道投递」。",
    turns: "最近的消息是怎么被处理的：成功、失败，还是仍在进行中。",
    recall: "输入一句话，看联系人能从中想起哪些记忆。",
  };

  return (
    <div id="status">
      <div className="head">
        <div className="t">
          <h1>状态</h1>
        </div>
        <div className="preset-row" style={{ flex: "none" }}>
          <button type="button" className="refresh" disabled={diag === "busy"} onClick={() => void copyDiagnostics()}>
            {diag === "ok" ? "已复制" : diag === "bad" ? "复制失败" : diag === "busy" ? "整理中…" : "复制诊断"}
          </button>
          <button type="button" className="refresh" id="refreshBtn" onClick={refresh}>刷新</button>
        </div>
      </div>

      <div className="head-tabs">
        <Tabs base="st" value={tab} onChange={setTab} tabs={tabs} />
        <div className="hint">{TAB_DESC[tab]}</div>
      </div>

      {(visitedTabs.has("overview") || tab === "overview") && (
        <TabPanel active={tab === "overview"} aria={panelFor("overview")}>
          {status
            ? <OverviewSection panel={{}}
              devMode={devMode}
              d={status}
              caps={caps} capsErr={capsErr} onRetryCaps={() => setCapsNonce((n) => n + 1)}
              notice={statusErr !== "" ? `刷新失败：${statusErr}（下面显示的是上次的结果）` : undefined}
              goSettings={goSettings} goTab={(t) => { if (!devMode && (t === "calls" || t === "turns" || t === "recall")) return; setTab(t); }}
              actions={<>
                <button type="button" className="primary" id="pingBtn" disabled={busy !== ""} onClick={ping}>
                  {busy === "ping" ? "测试中…" : "实测模型连通"}
                </button>
                <button type="button" className="btn" id="resetBtn" disabled={busy !== ""}
                  title="把这些红点归零，从现在起重新数。历史记录一条不删。"
                  onClick={resetCounters}>
                  {busy === "reset" ? "处理中…" : "红点清零"}
                </button>
                {pingOut && <div id="pingOut" className={pingOut.cls}>{pingOut.text}</div>}
              </>} />
            : <div className="empty">{statusErr ? "读取失败：" + statusErr : "读取中…"}</div>}
        </TabPanel>
      )}

      {(visitedTabs.has("usage") || tab === "usage") && (
        <TabPanel active={tab === "usage"} aria={panelFor("usage")}>
          <UsageSection panel={{}} refreshNonce={usageNonce} />
        </TabPanel>
      )}

      {(visitedTabs.has("calls") || tab === "calls") && (
        <TabPanel active={tab === "calls"} aria={panelFor("calls")}>
        <div className="section">
          {/* 标题跟着筛选取：通道投递那一档看的不是模型调用，别挂着"模型"两个字。 */}
          <h2>{filterDef.scope === "channel" ? "通道投递记录" : "模型调用记录"}</h2>
          {/* 4416 条按一页翻要 177 页，先给筛选：只看失败 / 按用途。total 跟着这条筛走。 */}
          <div className="preset-row" role="group" aria-label="调用记录筛选">
            {CALL_FILTERS.map((f) => (
              <button key={f.id} type="button" className={"chip" + (callFilter === f.id ? " on" : "")}
                onClick={() => setCallFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          <div className="table-wrap" id="callsTable">
            <table>
              <thead>
                <tr><th>时间</th><th>用途</th><th>结果</th>{devMode && <th>耗时</th>}<th>信息</th></tr>
              </thead>
              <tbody id="callsBody">
                {inflight.map((c) => (
                  <tr key={"live-" + c.id} className="row-live">
                    <td className="num">{clockOf(c.startedAt)}</td>
                    <td>{PURPOSE_LABEL[c.purpose] ?? c.purpose}</td>
                    <td className="state"><span className="live-mark"><Loader2 size={12} className="spin" />进行中</span></td>
                    {devMode && <td className="num">{(c.elapsedMs / 1000).toFixed(1)}s</td>}
                    <td>
                      <span className="msg">
                        {c.turnText ? `正在回复「${c.turnText.slice(0, 40)}${c.turnText.length > 40 ? "…" : ""}」` : devMode ? `${c.model} 还没返回` : "正在处理…"}
                      </span>
                    </td>
                  </tr>
                ))}
                {callsPage.page === null ? (
                  <tr><td colSpan={devMode ? 5 : 4} className="empty">读取中…</td></tr>
                ) : callsPage.page.rows.length === 0 && inflight.length === 0 ? (
                  <tr><td colSpan={devMode ? 5 : 4} className="empty">
                    {callsPage.error !== "" ? "读取失败：" + callsPage.error
                      : filterDef.id === "all" ? "还没有调用记录" : "这个筛选下没有记录"}
                  </td></tr>
                ) : callsPage.page.rows.map((c, i) => {
                  // 失败行普通用户也能点开看具体问题（不然没法排查/反馈）；成功行的原文只留给开发模式。
                  const canOpen = devMode || c.ok === 0;
                  return (
                    <tr key={c.id ?? i}
                      className={(c.ok === 0 ? "row-failed" : "") + (canOpen ? " row-clickable" : "")}
                      onClick={canOpen ? () => openRaw(c.id) : undefined}
                      title={canOpen ? "查看这次调用的详情" : undefined}>
                      <td className="num">{clockOf(c.created_at)}</td>
                      <td>{PURPOSE_LABEL[c.purpose] ?? c.purpose}</td>
                      <td className="state">{c.ok
                        ? <span className="ok-mark">成功</span>
                        : devMode
                          ? <span className="bad-mark code-tag">{c.code || "失败"}</span>
                          : <span className="bad-mark">没成功</span>}</td>
                      {devMode && <td className="num">{fmtMs(c.elapsed_ms)}</td>}
                      <td>
                        <span className="msg">{devMode ? String(c.message || "").slice(0, 90) : c.ok === 0 ? "没回上来" : ""}</span>
                        {canOpen && (
                          <button type="button" className="raw-hint"
                            aria-label={"查看 " + clockOf(c.created_at) + " 这次调用的详情"}
                            onClick={(ev) => { ev.stopPropagation(); openRaw(c.id); }}>详情</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {callsPage.error !== "" && callsPage.page !== null && callsPage.page.rows.length > 0 && (
            <div className="hint">这一页没刷新成功：{callsPage.error}（下面显示的是上次拿到的）</div>
          )}
          {pager()}
        </div>
        </TabPanel>
      )}

      {(visitedTabs.has("turns") || tab === "turns") && (
        <TabPanel active={tab === "turns"} aria={panelFor("turns")}>
        <div className="section">
          <h2>最近处理的消息</h2>
          <div className="table-wrap" id="turnsTable">
            <table>
              <thead>
                <tr><th>时间</th><th>状态</th><th>耗时</th><th>用户消息</th><th>回复 / 错误</th></tr>
              </thead>
              <tbody id="turnsBody">
                {turnsPage.page === null ? (
                  <tr><td colSpan={5} className="empty">读取中…</td></tr>
                ) : turnsPage.page.rows.length === 0 ? (
                  <tr><td colSpan={5} className="empty">{turnsPage.error !== "" ? "读取失败：" + turnsPage.error : "还没有对话"}</td></tr>
                ) : turnsPage.page.rows.map((t) => (
                  <tr key={t.id} className={t.status === "failed" ? "row-failed" : ""}>
                    <td className="num">{clockOf(t.created_at)}</td>
                    <td className="state">
                      {t.status === "done" ? <span className="ok-mark">{TURN_LABEL[t.status]}</span>
                        : t.status === "failed" ? <span className="bad-mark">失败</span>
                        : TURN_LABEL[t.status] ?? t.status}
                    </td>
                    {/* 这一轮到底跑了多久：从前只有总平均（几千毫秒那种），单轮快慢看不见 */}
                    <td className="num">{t.finished_at != null ? fmtMs(t.finished_at - t.created_at) : "—"}</td>
                    <td><span className="msg">{String(t.text || "").slice(0, 50)}</span></td>
                    <td>
                      <span className="msg">{String(t.status === "failed" ? (t.error || "") : (t.reply || "")).slice(0, 90)}</span>
                      {t.status === "failed" && (
                        <button type="button" className="raw-hint"
                          aria-label={"看这一轮失败时发给模型的请求原文"}
                          onClick={(ev) => { ev.stopPropagation(); void openRawForTurn(t.id); }}>
                          看请求原文
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pager()}
        </div>
        </TabPanel>
      )}
      {(visitedTabs.has("recall") || tab === "recall") && (
        <TabPanel active={tab === "recall"} aria={panelFor("recall")}>
          <RecallSection panel={{}} key={contactId} contactName={contactName} contactAvatar={contactAvatar}
            onSwitchContact={onSwitchContact} onOpenContacts={onOpenContacts} />
        </TabPanel>
      )}

      {/* 原文弹窗挂在分区外层：从前它写在「调用记录」里面，
          从「最近处理」点"看请求原文"——请求发了、原文取回来了，弹窗却渲染不出来。 */}
      {rawId !== null && (
        <Modal label="调用详情" className="raw-modal" onClose={closeRaw}>
          <div className="raw-head">
            <div>
              <div className="modal-title">调用详情</div>
              {rawCall && (
                <div className="raw-sub">
                  {clockOf(rawCall.created_at)} · {PURPOSE_LABEL[rawCall.purpose] ?? rawCall.purpose} ·{" "}
                  {rawCall.ok ? "成功" : <span className="bad-mark code-tag">{rawCall.code || "失败"}</span>} · {fmtMs(rawCall.elapsed_ms)}
                  {rawCall.total_tokens != null ? ` · ${rawCall.total_tokens} token` : ""}
                </div>
              )}
            </div>
            <button type="button" className="raw-close" aria-label="关闭" onClick={closeRaw}><X size={15} /></button>
          </div>
          {rawErr !== "" && <div className="raw-body">取这一条失败：{rawErr}</div>}
          {rawCall === null && rawErr === "" && <div className="hint">读取中…</div>}
          {rawCall !== null && (
            <>
              <div className="raw-sec-label">
                响应原文{rawCall.res_full ? ` · ${rawCall.res_full.length} 字` : "（已滚出全文窗口）"}
              </div>
              <pre className="raw-body">{prettyJson(rawCall.res_full ?? rawCall.detail ?? "")}</pre>
              {rawCall.req_full && (
                <>
                  <div className="raw-sec-label">请求原文 · {rawCall.req_full.length} 字</div>
                  <pre className="raw-body">{prettyJson(rawCall.req_full)}</pre>
                </>
              )}
            </>
          )}
          <div className="raw-note">只保留最近几次的完整内容，更早的仅有摘要；完整聊天回复可在聊天窗口查看。</div>
        </Modal>
      )}
    </div>
  );
}
