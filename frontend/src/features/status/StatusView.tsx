import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Loader2, X, XCircle } from "lucide-react";
import Tabs, { panelAria, type PanelAria } from "../../components/Tabs";
import TabPanel from "../../components/TabPanel";
import Modal from "../../components/Modal";
import DiagnosticsButton from "../../components/DiagnosticsButton";
import LoadingSkeleton from "../../components/LoadingSkeleton";
import { getJson, settingsApi } from "../../api";
import { cachedStatus, loadStatus, ResetRefetchError, resetCounters as resetCountersStore } from "../../lib/statusStore";
import { cachedCaps, loadCaps, type Caps } from "../../lib/capsStore";
import { clockOf, dayLabel, dayOf } from "../../lib/datetime";
import { copyText } from "../../lib/clipboard";
import OverviewSection from "./OverviewSection";
import UsageSection from "./UsageSection";
import RecallSection from "./RecallSection";
import OutboundQueueSection from "./OutboundQueueSection";
import type { SettingsTab } from "../settings/SettingsView";
import { purposeLabel, TURN_LABEL } from "./constants";
import { usePagedList } from "../../hooks/usePagedList";
import ListPager from "../../components/ListPager";
import type { StatusData, ModelCallRow, InflightCall, StatusTurnRow } from "../../types";

type PingOut = { cls: string; text: string } | null;
type Tab = "overview" | "usage" | "activity" | "recall";
type ActivityView = "calls" | "turns" | "queue";

/** 用户端活动分类。失败状态与类型分开，允许组合成「记忆整理 + 只看失败」。 */
type ActivityFilterDef = { id: string; label: string; purposes?: string[]; scope?: "model" | "channel" };
const DEFAULT_ACTIVITY: ActivityFilterDef = { id: "all", label: "全部活动", scope: "model" };
const ACTIVITY_FILTERS: ActivityFilterDef[] = [
  DEFAULT_ACTIVITY,
  { id: "chat", label: "回消息", purposes: ["chat"] },
  { id: "memory", label: "记忆整理", purposes: ["extract", "consolidate", "recap"] },
  { id: "proactive", label: "主动判断", purposes: ["proactive"] },
  { id: "media", label: "图片与语音", purposes: ["imageGen", "image_understanding", "emote_naming", "asr", "tts"] },
  // 通道投递记录混在同一张表里；默认不展开，避免一次发送的多个步骤淹没主要活动。
  { id: "channel", label: "通道投递", scope: "channel" },
];

/** 毫秒读数：过秒就换成秒，一屏 12345ms 这种数没法扫。 */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 用户先看到“发生了什么”，开发模式再补原始 code/message。 */
function friendlyFailure(code?: string | null, message?: string | null): string {
  const text = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (/timeout|timed out|超时/.test(text)) return "服务商响应超时";
  if (/401|403|unauthorized|forbidden|api.?key|鉴权|密钥/.test(text)) return "密钥无效或权限不足";
  if (/429|rate.?limit|quota|额度|限流/.test(text)) return "调用被限流或额度不足";
  if (/output_truncated|finish_reason.?(length|sensitive|content_filter|safety)|输出额度用完|思考.*额度|安全.*截断|内容.*截断/.test(text)) return "思考太久或内容被安全策略截断";
  if (/network|fetch|econn|dns|连接/.test(text)) return "连接不上服务商";
  if (/non.?json|json|parse|格式/.test(text)) return "服务商返回格式异常";
  return "这次没有完成，可以稍后重试";
}

const SUCCESS_SUMMARY: Record<string, string> = {
  chat: "消息已回复",
  extract: "长期记忆已更新",
  consolidate: "记忆归并完成",
  proactive: "主动判断完成",
  recap: "近况整理完成",
  imageGen: "图片已生成",
  image_understanding: "图片理解完成",
  emote_naming: "智能识别完成",
  asr: "语音已识别",
  tts: "语音已生成",
  ping: "连接正常",
  wechat: "微信已投递",
  qq: "QQ 已投递",
};

/** 抽取成功但 events=[] 是正常结果：活动记录别说成"记忆已更新"，免得用户以为出了错。 */
function successSummary(c: ModelCallRow): string {
  if (c.purpose === "extract" && c.detail) {
    try {
      const body = JSON.parse(c.detail) as unknown;
      const empty = Array.isArray(body)
        ? body.length === 0
        : !!body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
          && (body as { events: unknown[] }).events.length === 0;
      if (empty) return "本轮无需新增记忆";
    } catch { /* 原文被截断或不是 JSON 时沿用通用文案 */ }
  }
  return SUCCESS_SUMMARY[c.purpose] ?? "已完成";
}

/** 请求体是 JSON 字符串，格式化后更好读；解析失败就原样显示。 */
function prettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

/** 一键复制用的整条记录：先给人能读的元数据，再放两段原文（JSON 能解析就缩进）。 */
function rawCopyPayload(call: ModelCallRow): string {
  const meta = [
    `时间：${new Date(call.created_at).toLocaleString()}`,
    `用途：${purposeLabel(call.purpose)}`,
    `结果：${call.ok ? "成功" : `失败${call.code ? `（${call.code}）` : ""}`}`,
    call.status != null ? `HTTP 状态：${call.status}` : "",
    `模型：${call.model || "未记录"}`,
    call.url ? `接口：${call.url}` : "",
    `耗时：${fmtMs(call.elapsed_ms)}`,
    call.total_tokens != null
      ? `Token：输入 ${call.prompt_tokens ?? "?"} / 输出 ${call.completion_tokens ?? "?"} / 合计 ${call.total_tokens}`
      : "",
    call.turn_id ? `处理单：${call.turn_id}` : "",
    call.message ? `摘要：${call.message}` : "",
  ].filter(Boolean);
  return [
    meta.join("\n"),
    "",
    "===== 请求体 =====",
    call.req_full ? prettyJson(call.req_full) : "（未保留原文）",
    "",
    "===== 服务商返回 =====",
    call.res_full ? prettyJson(call.res_full) : (call.detail ?? "（未保留原文）"),
  ].join("\n");
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
  const [activityView, setActivityView] = useState<ActivityView>("calls");
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
  // 原始请求捕获与用户诊断分开：普通用户始终能看活动记录，只有原始请求体受 devMode 控制。
  const rawCapture = status?.rawCapture === true;
  const devMode = status?.devMode === true;
  // 记忆检查在联系人资料页对所有人开放；状态页的独立测试台只留给开发者。
  useEffect(() => {
    if (status && !devMode) setTab((t) => (t === "recall" ? "overview" : t));
  }, [status, devMode]);
  /** 点开「查看原文」的那条调用：列表只发摘要，全文按行另取一次。 */
  const [rawId, setRawId] = useState<number | null>(null);
  const [rawCall, setRawCall] = useState<ModelCallRow | null>(null);
  const [rawErr, setRawErr] = useState("");
  const [rawCopy, setRawCopy] = useState<"idle" | "ok" | "bad">("idle");
  const [pingOut, setPingOut] = useState<PingOut>(null);
  const [busy, setBusy] = useState("");
  const [diag, setDiag] = useState<"idle" | "busy" | "ok" | "bad">("idle");
  /** 活动类型与失败状态是两个维度，可以组合筛选。 */
  const [callFilter, setCallFilter] = useState("all");
  const [callFailed, setCallFailed] = useState(false);

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
  const filterDef = ACTIVITY_FILTERS.find((f) => f.id === callFilter) ?? DEFAULT_ACTIVITY;
  const fetchCalls = useCallback((limit: number, offset: number) =>
    getJson<{ calls: ModelCallRow[]; total: number }>(
      `/api/logs?limit=${limit}&offset=${offset}`
      + (callFailed ? "&failed=1" : "")
      + (filterDef.purposes?.length ? "&purposes=" + encodeURIComponent(filterDef.purposes.join(",")) : "")
      + (filterDef.scope ? "&scope=" + filterDef.scope : ""),
    ).then((d) => ({ rows: d.calls, total: d.total })), [filterDef, callFailed]);
  const callsPage = usePagedList<ModelCallRow>(fetchCalls, {
    key: `calls|${callFilter}|${callFailed ? "failed" : "all"}`,
    enabled: active && tab === "activity" && activityView === "calls",
  });

  const fetchTurns = useCallback((limit: number, offset: number) =>
    getJson<{ turns: StatusTurnRow[]; stats: { total: number } }>(`/api/turns/recent?limit=${limit}&offset=${offset}`)
      .then((d) => ({ rows: d.turns, total: d.stats.total })), []);
  const turnsPage = usePagedList<StatusTurnRow>(fetchTurns, {
    key: "turns",
    enabled: active && tab === "activity" && activityView === "turns",
  });

  // 懒加载：总览有自己的缓存，进 tab 才刷；两张表由 usePagedList 在 enabled 时拉第一页。
  useEffect(() => {
    if (active && tab === "overview") refreshStatus();
  }, [active, tab, refreshStatus]);

  /** 只在「有在飞的调用」时轮询：平时这个页面一个额外请求都不发。
   *  从有到无的那一刻把列表刷回第一页，刚跑完的那条立刻出现，不用手动刷新。 */
  const inflightCountRef = useRef(0);
  useEffect(() => {
    if (tab !== "activity" || activityView !== "calls") return;
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
  }, [active, tab, activityView, inflight.length, callsPage.reset]);

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
      `投递队列：${status?.outbound ? `待处理 ${status.outbound.open}，死信 ${status.outbound.dead}，已送达 ${status.outbound.counts.delivered}` : "未知"}`,
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
    if (tab === "activity" && activityView === "calls") callsPage.reset();
    if (tab === "activity" && activityView === "turns") turnsPage.reset();
  };

  /** 点开某一行才取这一条的全文：列表页永远不带着两列原文跑。 */
  const openRaw = (id: number): void => {
    setRawId(id);
    setRawCall(null);
    setRawErr("");
    setRawCopy("idle");
    void getJson<{ call: ModelCallRow }>(`/api/logs/${id}`)
      .then((d) => setRawCall(d.call))
      .catch((e: Error) => setRawErr(e.message));
  };
  const closeRaw = (): void => { setRawId(null); setRawCall(null); setRawErr(""); setRawCopy("idle"); };

  /** 一键复制这条调用的排障包：元数据 + 请求体 + 服务商返回，直接粘给对方就能定位。 */
  const copyRawCall = async (): Promise<void> => {
    if (rawCall === null) return;
    const result = await copyText(rawCopyPayload(rawCall));
    setRawCopy(result === "ok" ? "ok" : "bad");
    window.setTimeout(() => setRawCopy("idle"), 1800);
  };

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
      .then((d) => { setStatus(d); setStatusErr(""); setPingOut({ cls: "ping-out good", text: "提醒已忽略。历史记录都还在。" }); })
      .catch((e: Error) => setPingOut({
        cls: "ping-out bad",
        // 重取失败 ≠ 忽略失败：水印已经落定，缺的只是这份按联系人算的快照。
        text: e instanceof ResetRefetchError
          ? `提醒已忽略，但这份状态刷不出来：${e.message}`
          : "忽略提醒失败：" + e.message,
      }))
      .finally(() => setBusy(""));
  };

  /** 当前分区根元素上的 ARIA：把面板回指到选中的 tab。 */
  const panelFor = (key: Tab): PanelAria => panelAria("st", key);
  const list = tab === "activity" ? (activityView === "calls" ? callsPage : turnsPage) : null;
  const callRows = callsPage.page?.rows ?? [];
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "概览" },
    { key: "usage", label: "模型用量" },
    { key: "activity", label: "活动记录" },
  ];
  // 记忆检查已移到联系人资料页；状态页这里仅保留开发者的快速试验台。
  if (devMode) tabs.push({ key: "recall", label: "记忆检查" });

  /** 表格底部：四张管理面表共用的那一句「已显示 X / 共 Y」。 */
  const pager = (): JSX.Element | null =>
    (list === null ? null : <ListPager page={list.page} busy={list.busy} refreshing={list.refreshing} onMore={list.more} />);

  /** 每个 tab 一句话说明，渲染在分段控件下方，切 tab 即换。 */
  const TAB_DESC: Record<Tab, string> = {
    overview: "先看健康结论，再看模型、能力、通道与运行详情。这里只读；要修改时从对应卡片进入设置。",
    usage: "模型用了多少、哪个模型用得多、和谁聊的；统计近 30 天。",
    activity: "查看最近的消息回复、记忆整理、主动判断与媒体处理；投递队列可查看自动重试和死信。",
    recall: "输入一句话，看联系人能从中想起哪些记忆。",
  };

  return (
    <div id="status">
      <div className="head">
        <div className="t">
          <h1>状态</h1>
        </div>
        <div className="preset-row" style={{ flex: "none" }}>
          <DiagnosticsButton className="refresh" onAction={(action) => {
            if (action === "activity") { setTab("activity"); setActivityView("calls"); }
            else if (action === "outbound") { setTab("activity"); setActivityView("queue"); }
            else if (action === "backup" || action === "storage" || action === "settings") goSettings("system");
          }} />
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
              d={status}
              caps={caps} capsErr={capsErr} onRetryCaps={() => setCapsNonce((n) => n + 1)}
              onOpenContacts={onOpenContacts}
              onRefresh={refreshStatus}
              notice={statusErr !== "" ? `刷新失败：${statusErr}（下面显示的是上次的结果）` : undefined}
              goSettings={goSettings} goTab={() => {
  setActivityView("calls");
  setTab("activity");
  // 总览页的「查看活动」九成是因为出了失败；自动开启「只看失败」，省掉一次筛选点击。
  if ((status?.recent?.fail ?? 0) > 0) setCallFailed(true);
}}
              goTurns={() => { setActivityView("turns"); setTab("activity"); }}
              goQueue={() => { setActivityView("queue"); setTab("activity"); }}
              actions={<>
                <button type="button" className="primary" id="pingBtn" disabled={busy !== ""} onClick={ping}>
                  {busy === "ping" ? "测试中…" : "实测模型连通"}
                </button>
                <button type="button" className="btn" id="resetBtn" disabled={busy !== ""}
                  title="只忽略当前提醒，不会修复问题；历史记录一条不删。"
                  onClick={resetCounters}>
                  {busy === "reset" ? "处理中…" : "忽略提醒"}
                </button>
                {pingOut && <div id="pingOut" className={pingOut.cls}>{pingOut.text}</div>}
              </>} />
            : statusErr
              ? <div className="empty">读取失败：{statusErr}</div>
              : <LoadingSkeleton rows={4} className="status-skeleton" />}
        </TabPanel>
      )}

      {(visitedTabs.has("usage") || tab === "usage") && (
        <TabPanel active={tab === "usage"} aria={panelFor("usage")}>
          <UsageSection panel={{}} refreshNonce={usageNonce} />
        </TabPanel>
      )}

      {tab === "activity" && (
        <TabPanel active={tab === "activity"} aria={panelFor("activity")}>
          <div className="activity-subnav set-subnav">
            <Tabs base="st-activity" value={activityView} onChange={setActivityView}
              tabs={[
                { key: "calls", label: "活动明细" },
                { key: "turns", label: "回复任务" },
                { key: "queue", label: "投递队列" },
              ]} />
          </div>

          {activityView === "queue" ? (
            <OutboundQueueSection active={active && tab === "activity"} devMode={devMode} onChanged={refreshStatus} />
          ) : activityView === "calls" ? (
            <div className="section" id="callsTable">
              <div className="activity-title-row">
                <div>
                  <h2>{filterDef.scope === "channel" ? "通道投递" : "近期活动"}</h2>
                  <p className="hint">
                    {filterDef.scope === "channel"
                      ? "查看 QQ、微信消息的实际投递结果；失败时会说明原因。"
                      : "按时间查看最近发生了什么；点开任一条可以查看结果和失败原因。"}
                  </p>
                </div>
              </div>
              <div className="activity-toolbar">
                <div className="activity-filter-group" role="group" aria-label="活动类型">
                  <span className="activity-filter-label">类型</span>
                  {ACTIVITY_FILTERS.map((f) => (
                    <button key={f.id} type="button" className={"chip" + (callFilter === f.id ? " on" : "")}
                      aria-pressed={callFilter === f.id}
                      onClick={() => setCallFilter(f.id)}>{f.label}</button>
                  ))}
                </div>
                <button type="button" className={"chip activity-failed-toggle" + (callFailed ? " on" : "")}
                  aria-pressed={callFailed} onClick={() => setCallFailed((v) => !v)}>
                  <XCircle size={12} />只看失败
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>时间</th><th>活动</th><th>结果</th><th>耗时</th><th>说明</th></tr>
                  </thead>
                  <tbody id="callsBody">
                    {inflight.map((c) => (
                      <tr key={"live-" + c.id} className="row-live">
                        <td className="num">{clockOf(c.startedAt)}</td>
                        <td className="activity-name">{purposeLabel(c.purpose)}</td>
                        <td className="state">
                          <span className="activity-status live"><Loader2 size={12} className="spin" />进行中</span>
                        </td>
                        <td className="num">{(c.elapsedMs / 1000).toFixed(1)}s</td>
                        <td><span className="msg">{c.turnText ? `正在回复「${c.turnText.slice(0, 40)}${c.turnText.length > 40 ? "…" : ""}」` : "正在处理…"}</span></td>
                      </tr>
                    ))}
                    {callsPage.page === null ? (
                      <tr><td colSpan={5} className="empty">读取中…</td></tr>
                    ) : callRows.length === 0 && inflight.length === 0 ? (
                      <tr><td colSpan={5} className="empty">
                        {callsPage.error !== "" ? "读取失败：" + callsPage.error
                          : callFailed ? "没有符合条件的失败记录"
                            : filterDef.id === "all" ? "还没有活动记录" : "这个分类下没有记录"}
                      </td></tr>
                    ) : callRows.map((c, i) => {
                      const failed = c.ok === 0;
                      const prev = i > 0 ? callRows[i - 1] : undefined;
                      const showDay = prev === undefined || dayOf(prev.created_at) !== dayOf(c.created_at);
                      return (
                        <Fragment key={c.id ?? i}>
                          {showDay && (
                            <tr className="activity-day-row">
                              <td colSpan={5}>{dayLabel(c.created_at)}</td>
                            </tr>
                          )}
                          <tr
                            className={failed ? "row-failed row-clickable" : "row-clickable"}
                            tabIndex={0}
                            onClick={() => openRaw(c.id)}
                            onKeyDown={(ev) => {
                              if (ev.target !== ev.currentTarget) return;
                              if (ev.key === "Enter" || ev.key === " ") {
                                ev.preventDefault();
                                openRaw(c.id);
                              }
                            }}
                            title="查看这次活动的详情">
                            <td className="num">
                              <time dateTime={new Date(c.created_at).toISOString()}>{clockOf(c.created_at)}</time>
                            </td>
                            <td className="activity-name">{purposeLabel(c.purpose)}</td>
                            <td className="state">
                              {failed
                                ? <span className="activity-status bad"><XCircle size={12} />失败</span>
                                : <span className="activity-status ok"><CheckCircle2 size={12} />成功</span>}
                            </td>
                            <td className="num">{fmtMs(c.elapsed_ms)}</td>
                            <td>
                              <div className="activity-copy">
                                <span className="msg">
                                  {failed ? friendlyFailure(c.code, c.message) : successSummary(c)}
                                </span>
                                <div className="activity-actions">
                                  {failed && (
                                    <button type="button" className="raw-hint"
                                      title="跳到「模型与能力」检查对应模型档"
                                      onClick={(ev) => { ev.stopPropagation(); goSettings("model"); }}>
                                      去检查模型<ChevronRight size={13} />
                                    </button>
                                  )}
                                  <button type="button" className="raw-hint"
                                    aria-label={`查看 ${dayLabel(c.created_at)} ${clockOf(c.created_at)} 的活动详情`}
                                    onClick={(ev) => { ev.stopPropagation(); openRaw(c.id); }}>
                                    详情<ChevronRight size={13} />
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        </Fragment>
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
          ) : (
            <div className="section" id="turnsTable">
              <div className="activity-title-row">
                <div>
                  <h2>回复任务</h2>
                  <p className="hint">每次发送消息后发生了什么：完成、失败或仍在处理中。</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>时间</th><th>状态</th><th>耗时</th><th>你的消息</th><th>回复 / 原因</th></tr>
                  </thead>
                  <tbody id="turnsBody">
                    {turnsPage.page === null ? (
                      <tr><td colSpan={5} className="empty">读取中…</td></tr>
                    ) : turnsPage.page.rows.length === 0 ? (
                      <tr><td colSpan={5} className="empty">{turnsPage.error !== "" ? "读取失败：" + turnsPage.error : "还没有对话"}</td></tr>
                    ) : turnsPage.page.rows.map((t) => {
                      const failed = t.status === "failed";
                      return (
                        <tr key={t.id} className={failed ? "row-failed" : ""}>
                          <td className="num">{clockOf(t.created_at)}</td>
                          <td className="state">
                            {t.status === "done" ? <span className="ok-mark">{TURN_LABEL[t.status]}</span>
                              : failed ? <span className="bad-mark">失败</span>
                              : TURN_LABEL[t.status] ?? t.status}
                          </td>
                          <td className="num">{t.finished_at != null ? fmtMs(t.finished_at - t.created_at) : "—"}</td>
                          <td><span className="msg">{String(t.text || "").slice(0, 50)}</span></td>
                          <td>
                            <span className="msg">
                              {failed ? (devMode ? String(t.error || "").slice(0, 90) : friendlyFailure(null, t.error)) : String(t.reply || "").slice(0, 90)}
                            </span>
                            {failed && devMode && (
                              <button type="button" className="raw-hint" aria-label="查看这次回复任务的失败详情"
                                onClick={(ev) => { ev.stopPropagation(); void openRawForTurn(t.id); }}>
                                查看详情
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {pager()}
            </div>
          )}
        </TabPanel>
      )}
      {(visitedTabs.has("recall") || tab === "recall") && (
        <TabPanel active={tab === "recall"} aria={panelFor("recall")}>
          <RecallSection panel={{}} key={contactId} contactId={contactId} contactName={contactName} contactAvatar={contactAvatar}
            onSwitchContact={onSwitchContact} onOpenContacts={onOpenContacts} />
        </TabPanel>
      )}

      {/* 原文弹窗挂在分区外层：从前它写在「调用记录」里面，
          从「最近处理」点"看请求原文"——请求发了、原文取回来了，弹窗却渲染不出来。 */}
      {rawId !== null && (
        <Modal label="活动详情" className="raw-modal" onClose={closeRaw}>
          <div className="raw-head">
            <div>
              <div className="modal-title">活动详情</div>
              {rawCall && (
                <div className="raw-sub">
                  {dayLabel(rawCall.created_at)} {clockOf(rawCall.created_at)} · {purposeLabel(rawCall.purpose)} ·{" "}
                  {rawCall.ok ? "成功" : <span className="bad-mark">{friendlyFailure(rawCall.code, rawCall.message)}</span>} · {fmtMs(rawCall.elapsed_ms)}
                  {rawCall.total_tokens != null ? ` · ${rawCall.total_tokens} token` : ""}
                </div>
              )}
            </div>
            <div className="raw-actions">
              {rawCall !== null && (
                <button type="button" className="btn sm" onClick={() => void copyRawCall()}>
                  {rawCopy === "ok" ? "已复制" : rawCopy === "bad" ? "复制失败" : "复制诊断信息"}
                </button>
              )}
              <button type="button" className="raw-close" aria-label="关闭" onClick={closeRaw}><X size={15} /></button>
            </div>
          </div>
          {rawErr !== "" && <div className="raw-body">取这一条失败：{rawErr}</div>}
          {rawCall === null && rawErr === "" && <LoadingSkeleton rows={2} />}
          {rawCall !== null && (
            rawCapture ? (
              <>
                <div className="raw-sec-label">
                  服务商返回{rawCall.res_full ? ` · ${rawCall.res_full.length} 字` : "（已滚出全文窗口）"}
                </div>
                <pre className="raw-body">{prettyJson(rawCall.res_full ?? rawCall.detail ?? "")}</pre>
                {rawCall.req_full && (
                  <>
                    <div className="raw-sec-label">请求内容 · {rawCall.req_full.length} 字</div>
                    <pre className="raw-body">{prettyJson(rawCall.req_full)}</pre>
                  </>
                )}
              </>
            ) : (
              <div className="activity-detail-readable">
                <div className="activity-detail-summary">
                  <b>{rawCall.ok ? "这次活动已完成" : friendlyFailure(rawCall.code, rawCall.message)}</b>
                  <span>模型 {rawCall.model || "未记录"} · 耗时 {fmtMs(rawCall.elapsed_ms)}{rawCall.total_tokens != null ? ` · ${rawCall.total_tokens} token` : ""}</span>
                </div>
                {(rawCall.message || !rawCall.ok) && (
                  <div className="activity-detail-note">
                    {rawCall.message
                      ? String(rawCall.message)
                      : "可以稍后重试；如果持续失败，再到设置里检查连接与密钥。"}
                  </div>
                )}
              </div>
            )
          )}
          <div className="raw-note">日常只需要看结果摘要；需要排查时，可以复制这条记录用于定位。</div>
        </Modal>
      )}
    </div>
  );
}
