import { ReactNode, useState } from "react";
import { clockOf, relTime, whenText } from "../../lib/datetime";
import CheckRow from "./CheckRow";
import { qqApi } from "../../api";
import type { StatusData, CapabilityName } from "../../types";
import type { Caps } from "../../lib/capsStore";
import type { PanelAria } from "../../components/Tabs";

type Led = "ok" | "warn" | "bad";
const RANK: Led[] = ["ok", "warn", "bad"];
const worse = (a: Led, b: Led): Led => RANK[Math.max(RANK.indexOf(a), RANK.indexOf(b))] as Led;

const DAY = 86_400_000;

/** 一行的完整形态：led=灯，silent=只在卡里出现不进提醒条，note=提醒条里的一句人话。 */
type Row = {
  led: Led;
  k: string;
  v: ReactNode;
  fix?: ReactNode;
  silent?: boolean;
  note?: string;
  action?: { label: string; on: () => void };
};

/** 运行时长说人话：4 小时 11 分，而不是 14664 秒。 */
function uptimeText(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h <= 0) return `${m} 分钟`;
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 过去用「13 小时前」，将来用「约 3 小时后」：whenText 只认将来，混用会写出「即将检查的往事」。 */
function when(ts: number): string {
  return ts > Date.now() ? whenText(ts) : relTime(ts);
}

/** 缓存多旧说人话：一分钟内按秒，一小时内按分，再久交给现成的 relTime（小时/天前）。 */
function ageText(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); // 客户端时钟快过服务端时差值为负，钳到 0 免得出现「-2 秒前」
  if (s < 60) return `${s} 秒前`;
  if (s < 3_600) return `${Math.floor(s / 60)} 分钟前`;
  return relTime(ts);
}

/** 把原始错误翻成用户先能理解的一句话；完整技术信息留在可展开区。 */
function friendlyModelError(code?: string, message?: string): string {
  const text = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (/timeout|timed out|超时/.test(text)) return "模型响应超时";
  if (/401|403|unauthorized|forbidden|api.?key|鉴权|密钥/.test(text)) return "模型密钥无效或没有权限";
  if (/429|rate.?limit|quota|额度|限流/.test(text)) return "模型调用被限流或额度不足";
  if (/non.?json|json|parse|格式/.test(text)) return "模型返回格式异常";
  if (/output_truncated|finish_reason.?(length|sensitive|content_filter|safety)|输出额度用完|思考.*额度|安全.*截断|内容.*截断/.test(text)) return "思考太久或内容被安全策略截断";
  if (/network|fetch|econn|dns|连接/.test(text)) return "连接不上模型服务";
  return "模型调用失败";
}

/** 卡片：一个标题 + 每行自己的灯。标题上的灯取各行里「会进提醒条」的那些，最差的那个。 */
function Card({ title, rows, goto }: {
  title: string;
  rows: Row[];
  goto?: { label: string; on: () => void };
}): JSX.Element {
  const led = rows.filter((r) => !r.silent).reduce<Led>((acc, r) => worse(acc, r.led), "ok");
  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className={"led " + led} />
        <span className="t">{title}</span>
        {goto && <button type="button" className="ov-goto" onClick={goto.on}>{goto.label}</button>}
      </div>
      <div className="checks">
        {rows.map((r) => <CheckRow key={r.k} led={r.led} k={r.k} v={r.v} fix={r.fix} />)}
      </div>
    </section>
  );
}

const CAP_LABEL: Record<CapabilityName, string> = {
  imageVision: "图片理解", speechToText: "语音识别", textToSpeech: "语音合成", memoryExtract: "记忆整理",
  imageGeneration: "图像生成", embedding: "向量化记忆",
};
/** 未就绪时分别意味着什么：只说「未配置」等于让人去猜少了什么功能。 */
const CAP_OFF: Record<CapabilityName, string> = {
  imageVision: "未配置：收到的图片看不懂内容",
  speechToText: "未配置：输入框里没有麦克风",
  textToSpeech: "未配置：回复没有朗读按钮",
  memoryExtract: "用的那个模型没配好：对话可能记不成长期记忆",
  imageGeneration: "未配置：画不出图（开关开着也没用）",
  embedding: "未配置：记忆召回退回纯关键词（不影响其它功能）",
};
const CHANNEL_LABEL: Record<string, string> = { web: "网页", wechat: "微信" };

/**
 * 状态与配置总览：只读，且只讲**全局**。
 * 两条纪律：一是不放编辑控件——一旦能改配置，就和设置页变成两份要同步的 UI，
 * 每类信息给一个「去改」跳转就够了；二是不看单个联系人的状态——主动性闸门、
 * 记忆条数、微信绑定都在各联系人的资料页里，总览按联系人显示等于随机挑一位。
 * 提醒条同理只收真会坏事的：按设计如此的静默/配额不该天天报警。
 */
export default function OverviewSection({ d, caps, capsErr, onRetryCaps, notice, actions, goSettings, goTab, goTurns, goQueue, onOpenContacts, onRefresh, panel }: {
  panel: PanelAria;
  d: StatusData;
  /** 清除通道提示后重新拉一次 /api/status，让红字当场消失。 */
  onRefresh: () => void;
  /** 能力就绪状态由父级与 /api/status 并行取；null = 一次都还没拉到过。 */
  caps: Caps | null;
  capsErr: string;
  onRetryCaps: () => void;
  /** 后台刷新失败时的一句话：数据是上次的，但不能让人以为它是刚拉到的。 */
  notice?: string;
  actions: ReactNode;
  goSettings: (tab: "model" | "capability") => void;
  /** 模型调用/记忆整理的明细：活动记录 → 活动明细。 */
  goTab: (tab: "activity") => void;
  /** 处理单自身的明细：活动记录 → 回复任务（别再跳到模型调用那一页）。 */
  goTurns: () => void;
  goQueue: () => void;
  onOpenContacts: () => void;
}): JSX.Element {
  const now = Date.now();
  // 「数据截至」取载荷自带的生成时刻（d.time），而不是组件里另记 receivedAt：
  // 总览走 stale-while-revalidate（statusStore），重入时拿到的是缓存里的上一份，
  // 当场记 Date.now() 会把旧数据谎报成刚拉到的；后端盖章的时刻才说真话。
  // 旧后端没下发 time 就整行不渲染，不硬凑。
  const fetchedAt = d.time ? Date.parse(d.time) : NaN;
  const recent = d.recent ?? { calls: 0, fail: 0 };
  const errAge = d.lastModelError?.at ? now - Date.parse(d.lastModelError.at) : null;
  const errRecent = errAge !== null && errAge < DAY;
  // 「跳转」在正文里做成链接：让人当场就知道去哪一步看明细，而不是只告诉用户有事发生。
  const link = (label: string, on: () => void): ReactNode =>
    <button type="button" className="ov-link" onClick={on}>{label}</button>;

  /** 一次投递失败只是历史：状态页给一个当场清除的出口，别让那条红字一直挂着。 */
  const [qqClearBusy, setQqClearBusy] = useState(false);
  const [qqClearMsg, setQqClearMsg] = useState("");
  const clearQqErrors = async (): Promise<void> => {
    setQqClearBusy(true); setQqClearMsg("");
    try {
      const out = await qqApi.clearQQErrors();
      setQqClearMsg(out.message);
      onRefresh();
    } catch (e) {
      setQqClearMsg(e instanceof Error ? `清除失败：${e.message}` : "清除失败");
    } finally { setQqClearBusy(false); }
  };
  const clearQqButton: ReactNode = <button type="button" className="chip" disabled={qqClearBusy}
    title="只清除这条提示，不删活动记录里的历史"
    onClick={() => void clearQqErrors()}>{qqClearBusy ? "清除中…" : "清除提示"}</button>;

  const modelRows: Row[] = [
    d.modelReady
      ? { led: "ok", k: "模型", v: <><code>{d.provider ? `${d.provider} / ${d.model}` : d.model || "—"}</code> 调用正常</> }
      : {
        led: "warn", k: "模型", note: "演示模式，回复不是模型生成的",
        v: <>演示模式：回复是预设内容，不是模型生成的</>,
        fix: <>到「设置 → 模型接入」关掉演示模式并启用一套模型</>,
      },
    { led: "ok", k: "服务接口", v: <code>{d.baseUrl || "—"}</code> },
    {
      led: (recent.fail > 0 ? "warn" : "ok") as Led, k: "近 24 小时",
      note: recent.fail > 0 ? `近 24 小时调用失败 ${recent.fail} 次` : undefined,
      v: recent.calls === 0 ? "还没有调用记录" : `${recent.calls} 次调用 · ${recent.fail} 次失败`,
      fix: recent.fail > 0 ? <>累计失败 {d.modelFailures} 次，{link("逐条原因看「活动记录」", () => goTab("activity"))}</> : undefined,
      action: recent.fail > 0 ? { label: "查看活动", on: () => goTab("activity") } : undefined,
    },
    ...(d.lastModelError ? [{
      led: (errRecent ? "warn" : "ok") as Led, k: "最近失败",
      silent: !errRecent,
      note: errRecent ? `最近一次调用失败：${friendlyModelError(d.lastModelError.code, d.lastModelError.message)}` : undefined,
      v: <>{when(Date.parse(d.lastModelError.at ?? ""))} · {friendlyModelError(d.lastModelError.code, d.lastModelError.message)}</>,
      fix: <details className="error-detail">
        <summary>查看技术详情</summary>
        <pre>{d.lastModelError.code || "UNKNOWN"}{d.lastModelError.message ? `\n${d.lastModelError.message}` : ""}</pre>
      </details>,
    } as Row] : []),
  ];

  // 顺序跟着后端 CAPABILITY_NAMES：记忆提取 → 看得见的两张 → 听得到的两张。
  // embedding 不列：没配只是召回退纯词面，不算故障，列出来反而是常驻噪音。
  const capRows: Row[] = (["memoryExtract", "imageVision", "imageGeneration", "speechToText", "textToSpeech"] as const).map((name) => {
    // 三态分开：读取中 / 读取失败 / 按真实值。此前 !caps（含读取失败）会把
    // 四项全渲染成绿灯，而语音按钮确实已从输入区消失——用户找不到原因。
    if (capsErr !== "") {
      return {
        led: "bad" as Led, k: CAP_LABEL[name], silent: false, note: capsErr,
        v: <>读取失败 <button type="button" className="chip" onClick={onRetryCaps}>重试</button></>,
      };
    }
    if (!caps) return { led: "ok" as Led, k: CAP_LABEL[name], v: "读取中…", silent: true };
    const ready = caps[name];
    // 三项语音/视觉是可选能力，没配只是没有这个按钮；记忆提取配坏了会静默丢记忆。
    const bad = name === "memoryExtract" && !ready;
    return {
      led: (ready ? "ok" : bad ? "bad" : "ok") as Led,
      silent: !bad,
      k: CAP_LABEL[name],
      v: ready ? "已就绪" : CAP_OFF[name],
      note: bad ? "记忆提取用的模型没配好，对话可能记不下来" : undefined,
      // 这张卡只从主模型档里挑，所以它会坏只有一种方式：挑中的那份档没填齐地址/密钥/模型名
      fix: bad ? <>去「设置 → 能力模型 → 记忆整理」改回「跟随主模型」，或到「模型接入」把选中的那份填齐</> : undefined,
    };
  });

  const wx = d.wechat;
  const wxTrouble = wx ? wx.attention + wx.paused : 0;
  // 只列外部通道（微信 / QQ）；「网页」是桌面/手机端自带的那一条，列出来反而是噪音。
  const extChannels = (d.channels || []).filter((id) => id !== "web");
  const channelRows: Row[] = [
    ...(extChannels.length > 0
      ? [{ led: "ok" as Led, k: "已接入", silent: true, v: extChannels.map((id) => CHANNEL_LABEL[id] ?? id).join("、") }]
      : []),
    {
      led: (wxTrouble > 0 ? "bad" : "ok") as Led, k: "微信",
      note: wxTrouble > 0 ? `${wxTrouble} 条微信连接收不到消息` : undefined,
      v: !wx ? "读取中…" : wx.links === 0 ? "还没有联系人绑定微信"
        : <>共 {wx.links} 条 · 在线 {wx.connected}{wx.disabled > 0 ? ` · 停用 ${wx.disabled}` : ""}</>,
      fix: wx && wxTrouble > 0
        ? <>{wx.trouble.map((x) => x.name + (x.lastError ? "：" + x.lastError.slice(0, 40) : "")).join("；")}，到各自联系人的「对话设置」里重连</>
        : undefined,
      action: wx && wxTrouble > 0 ? { label: "去处理", on: onOpenContacts } : undefined,
    },
    // QQ 与微信差在凭据是全局一份：没配凭据时不存在"某条连接断了"，只有"这个通道还没接上"。
    (() => {
      const q = d.qq;
      // 后端只把「带时间戳且还在时效内」的错误放进 trouble：一次失败不会永远挂在这里。
      const qErrors = q ? q.trouble.filter((t) => t.lastError !== "") : [];
      const qTrouble = qErrors.length;
      const errorLine = qErrors.map((x) =>
        `${x.name}：${x.lastError.slice(0, 40)}${x.at ? `（${when(x.at)}）` : ""}`).join("；");
      const withClear = (content: ReactNode): ReactNode =>
        <>{content} {clearQqButton}{qqClearMsg && <> · {qqClearMsg}</>}</>;
      return {
        led: (qTrouble > 0 || (q && q.status === "attention") ? "bad" : "ok") as Led,
        k: "QQ",
        note: q && q.status === "attention" ? "QQ 网关连不上，绑定中的联系人收不到回复" : undefined,
        v: !q ? "读取中…" : !q.configured ? "还没填机器人凭据"
          : q.bindings === 0 ? "凭据已配 · 还没有联系人绑定 QQ"
            : <>共 {q.bindings} 条 · {qqApi.QQ_STATUS_LABEL[q.status]} · 启用 {q.active}</>,
        fix: q && q.status === "attention" && q.lastError !== ""
          ? withClear(<>{q.lastError.slice(0, 90)}（沙箱/未发布要去开放平台把机器人发布后再连）</>)
          : qTrouble > 0
            ? withClear(<>{errorLine}</>)
            : qqClearMsg !== "" ? <>{qqClearMsg}</> : undefined,
        action: q && (q.status === "attention" || qTrouble > 0) ? { label: "去处理", on: onOpenContacts } : undefined,
      };
    })(),
  ];

  const t = d.turns;
  // 「忽略提醒」是全局水印：24 小时窗口只负责让旧失败自然过期，水印负责当场划掉
  // 用户已经看过的那一批。turnStats 的累计失败数照旧显示在卡片里，历史一条不删；
  // 水印之后再失败，lastFailedAt 会更新成更晚的时间，提醒重新出现。
  const ackAt = d.failureWatermarkAt ?? 0;
  const turnFailRecent = !!t?.lastFailedAt && t.lastFailedAt > ackAt && now - t.lastFailedAt < DAY;
  const extractSamples = d.memoryExtractSamples ?? 0;
  const extractEmptyPct = d.memoryExtractEmptyRate == null ? null : Math.round(d.memoryExtractEmptyRate * 100);
  const outbound = d.outbound;
  const runRows: Row[] = [
    { led: "ok", k: "已运行", silent: true, v: uptimeText(d.uptimeSec ?? 0) },
    ...(outbound ? [{
      led: (outbound.dead > 0 ? "bad" : outbound.open > 0 ? "warn" : "ok") as Led,
      k: "消息投递",
      silent: outbound.dead === 0 && outbound.open === 0,
      note: outbound.dead > 0
        ? `${outbound.dead} 条消息进入死信队列`
        : outbound.open > 0
          ? `${outbound.open} 条消息仍在等待投递`
          : undefined,
      v: <>待处理 {outbound.open} · 死信 {outbound.dead} · 已送达 {outbound.counts.delivered}</>,
      fix: outbound.dead > 0
        ? <>{link("查看投递队列", goQueue)}，可重试或忽略不再需要的消息</>
        : outbound.open > 0
          ? <>{link("查看投递队列", goQueue)}，自动重试仍在进行</>
          : undefined,
      action: outbound.dead > 0 || outbound.open > 0 ? { label: "查看队列", on: goQueue } : undefined,
    } as Row] : []),
    {
      led: (d.proactive.enabled ? "ok" : "warn") as Led, k: "主动性",
      silent: !!d.proactive.enabled,
      note: d.proactive.enabled ? undefined : "主动性总开关关着，不会主动找你",
      v: d.proactive.enabled
        ? (d.proactive.nextWakeAt ? `开着，${whenText(d.proactive.nextWakeAt)}再判断要不要开口` : "开着，等下一条由头再说")
        : "总开关关着：不会主动找你",
      fix: d.proactive.enabled
        ? undefined
        // 总开关是启动环境变量（config.ts 只认 PROACTIVE_ENABLED），设置页没有对应开关；
        // 桌面版外壳每次启动会把 desktop.json 的该项重写回默认值，改它不生效——
        // 所以唯一诚实的出口是把变量名和 .env 路径写具体，别让人对着一句话瞎找。
        : <>总开关是启动环境变量 <code>PROACTIVE_ENABLED</code>（开发/命令行改项目根目录的 <code>.env</code>，改完重启生效；桌面版暂无界面开关）；免打扰与每天说几次在各联系人的「主动性」里配</>,
    },
    {
      led: (d.memoryExtractFailures > 0 ? "bad" : "ok") as Led, k: "记忆提取",
      note: d.memoryExtractFailures > 0 ? `记忆提取连续 ${d.memoryExtractFailures} 次失败` : undefined,
      v: d.memoryExtractFailures > 0
        ? `连续 ${d.memoryExtractFailures} 次失败，对话正记不下来`
        : extractSamples > 0
          ? `近 ${extractSamples} 次抽取正常${extractEmptyPct === null ? "" : `，${extractEmptyPct}% 本轮无需记录`}`
          : "还没有抽取记录",
      fix: d.memoryExtractFailures > 0
        ? <>{link("失败原因看「活动记录」", () => goTab("activity"))}（筛选「记忆整理」）</>
        : undefined,
      action: d.memoryExtractFailures > 0 ? { label: "查看原因", on: () => goTab("activity") } : undefined,
    },
    ...(t ? [{
      led: (t.failed > 0 && turnFailRecent ? "warn" : "ok") as Led, k: "回复任务",
      silent: !(t.failed > 0 && turnFailRecent),
      note: t.failed > 0 && turnFailRecent ? "最近有消息处理失败" : undefined,
      v: <>{t.total} 条消息 · 完成 {t.done} · 失败 {t.failed} · 处理中 {t.inFlight}</>,
      fix: t.failed > 0 && turnFailRecent
        ? <>最近一次失败 {when(t.lastFailedAt!)}，{link("明细看「回复任务」", goTurns)}</>
        : undefined,
      action: t.failed > 0 && turnFailRecent ? { label: "查看任务", on: goTurns } : undefined,
    } as Row] : []),
    { led: "ok", k: "数据", silent: true, v: <>保存在本机 <code>{d.dbPath}</code></> },
  ];

  const cards = [
    { title: "模型接入", rows: modelRows, goto: { label: "去设置", on: () => goSettings("model") } },
    { title: "能力", rows: capRows, goto: { label: "去设置", on: () => goSettings("capability") } },
    { title: "消息通道", rows: channelRows },
    { title: "运行与数据", rows: runRows },
  ];
  const alerts = cards
    .map((c) => ({ title: c.title, rows: c.rows.filter((r) => !r.silent && r.led !== "ok" && r.note), goto: c.goto }))
    .filter((c) => c.rows.length > 0);
  const summaryLed = alerts.reduce<Led>((acc, a) => worse(acc, a.rows.reduce<Led>((x, r) => worse(x, r.led), "ok")), "ok");
  const issueCount = alerts.reduce((n, a) => n + a.rows.length, 0);
  const summaryTitle = issueCount === 0 ? "一切正常" : `${issueCount} 项需要处理`;
  const summaryText = alerts.length === 0
    ? "模型、能力和消息通道都已就绪，暂时没有需要你处理的事情。"
    : alerts.flatMap((a) => a.rows.map((r) => r.note)).filter(Boolean).join("；");

  return (
    <div className="section" {...panel}>
      <div className="ov-head">
        <h2>运行概览</h2>
        <div className="actions">{actions}</div>
      </div>
      <div className="ov-desc">这套配置整体跑得怎么样。想改就点各卡片右上角的「去设置」；某位联系人的主动性、记忆和微信绑定在联系人的资料页里。
        {Number.isFinite(fetchedAt) && (
          <span className="ov-fresh">数据截至 {clockOf(fetchedAt)} · {ageText(fetchedAt)}</span>
        )}
      </div>
      <div className={`ov-summary ${summaryLed}`}>
        <span className="ov-summary-dot" aria-hidden="true" />
        <div className="ov-summary-copy">
          <b>{summaryTitle}</b>
          <span>{summaryText}</span>
        </div>
      </div>
      {issueCount > 0 && (
        <div className="ov-issues" aria-label="需要处理的事项">
          {alerts.flatMap((a) => a.rows.map((r) => (
            <div className="ov-issue" key={`${a.title}-${r.k}`}>
              <span className={`led ${r.led}`} aria-hidden="true" />
              <div className="ov-issue-copy">
                <b>{r.note}</b>
                <small>{a.title} · {r.k}</small>
              </div>
              {r.action ? (
                <button type="button" className="btn sm" onClick={r.action.on}>{r.action.label}</button>
              ) : a.goto ? (
                <button type="button" className="btn sm" onClick={a.goto.on}>{a.goto.label}</button>
              ) : null}
            </div>
          )))}
        </div>
      )}
      {notice && <div className="ov-note bad" role="status">{notice}</div>}

      <div className="ov-grid">
        {cards.map((c) => <Card key={c.title} title={c.title} rows={c.rows} goto={c.goto} />)}
      </div>
    </div>
  );
}
