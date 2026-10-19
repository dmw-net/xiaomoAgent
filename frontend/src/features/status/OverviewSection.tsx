import { ReactNode } from "react";
import { relTime, whenText } from "../../lib/datetime";
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
type Row = { led: Led; k: string; v: ReactNode; fix?: ReactNode; silent?: boolean; note?: string };

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
  imageGeneration: "图像生成",
};
/** 未就绪时分别意味着什么：只说「未配置」等于让人去猜少了什么功能。 */
const CAP_OFF: Record<CapabilityName, string> = {
  imageVision: "未配置：收到的图片看不懂内容",
  speechToText: "未配置：输入框里没有麦克风",
  textToSpeech: "未配置：回复没有朗读按钮",
  memoryExtract: "用的那个模型没配好：对话可能记不成长期记忆",
  imageGeneration: "未配置：画不出图（开关开着也没用）",
};
const CHANNEL_LABEL: Record<string, string> = { web: "网页", wechat: "微信" };

/**
 * 状态与配置总览：只读，且只讲**全局**。
 * 两条纪律：一是不放编辑控件——一旦能改配置，就和设置页变成两份要同步的 UI，
 * 每类信息给一个「去改」跳转就够了；二是不看单个联系人的状态——主动性闸门、
 * 记忆条数、微信绑定都在各联系人的资料页里，总览按联系人显示等于随机挑一位。
 * 提醒条同理只收真会坏事的：按设计如此的静默/配额不该天天报警。
 */
export default function OverviewSection({ d, caps, capsErr, onRetryCaps, notice, actions, goSettings, goTab, devMode, panel }: {
  panel: PanelAria;
  /** 开发者模式：只有开着时才给「调用记录 / 最近处理」这类排障 tab 的跳转链接（这些 tab 本身也只在开发模式出现）。 */
  devMode: boolean;
  d: StatusData;
  /** 能力就绪状态由父级与 /api/status 并行取；null = 一次都还没拉到过。 */
  caps: Caps | null;
  capsErr: string;
  onRetryCaps: () => void;
  /** 后台刷新失败时的一句话：数据是上次的，但不能让人以为它是刚拉到的。 */
  notice?: string;
  actions: ReactNode;
  goSettings: (tab: "model" | "capability") => void;
  goTab: (tab: "calls" | "turns") => void;
}): JSX.Element {
  const now = Date.now();
  const recent = d.recent ?? { calls: 0, fail: 0 };
  const errAge = d.lastModelError?.at ? now - Date.parse(d.lastModelError.at) : null;
  const errRecent = errAge !== null && errAge < DAY;
  // 「跳转」在正文里做成链接：让人当场就知道去哪一步看明细，而不是只告诉他有事发生。
  const link = (label: string, on: () => void): ReactNode =>
    <button type="button" className="ov-link" onClick={on}>{label}</button>;

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
      fix: recent.fail > 0 ? <>累计失败 {d.modelFailures} 次{devMode ? <>，{link("逐条原因看「调用记录」", () => goTab("calls"))}</> : null}</> : undefined,    },
    ...(d.lastModelError ? [{
      led: (errRecent ? "warn" : "ok") as Led, k: "最近失败",
      silent: !errRecent,
      note: errRecent ? `最近一次调用失败：${d.lastModelError.code || "未知"}` : undefined,
      v: <>{when(Date.parse(d.lastModelError.at ?? ""))} · <code>{d.lastModelError.code || "未知"}</code>{" "}
        {String(d.lastModelError.message || "").slice(0, 70)}</>,
    } as Row] : []),
  ];

  // 顺序跟着后端 CAPABILITY_NAMES：记忆提取 → 看得见的两张 → 听得到的两张
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
    },
    // QQ 与微信差在凭据是全局一份：没配凭据时不存在"某条连接断了"，只有"这个通道还没接上"。
    (() => {
      const q = d.qq;
      const qTrouble = q ? q.trouble.filter((t) => t.lastError !== "").length : 0;
      return {
        led: (qTrouble > 0 || (q && q.status === "attention") ? "bad" : "ok") as Led,
        k: "QQ",
        note: q && q.status === "attention" ? "QQ 网关连不上，绑定中的联系人收不到回复" : undefined,
        v: !q ? "读取中…" : !q.configured ? "还没填机器人凭据"
          : q.bindings === 0 ? "凭据已配 · 还没有联系人绑定 QQ"
            : <>共 {q.bindings} 条 · {qqApi.QQ_STATUS_LABEL[q.status]} · 启用 {q.active}</>,
        fix: q && q.status === "attention" && q.lastError !== ""
          ? <>{q.lastError.slice(0, 90)}（沙箱/未发布要去开放平台把机器人发布后再连）</>
          : q && qTrouble > 0
            ? <>{q.trouble.filter((t) => t.lastError !== "").map((x) => x.name + "：" + x.lastError.slice(0, 40)).join("；")}</>
            : undefined,
      };
    })(),
  ];

  const t = d.turns;
  const turnFailRecent = !!t?.lastFailedAt && now - t.lastFailedAt < DAY;
  const runRows: Row[] = [
    { led: "ok", k: "已运行", silent: true, v: uptimeText(d.uptimeSec ?? 0) },
    {
      led: (d.proactive.enabled ? "ok" : "warn") as Led, k: "主动性",
      silent: !!d.proactive.enabled,
      note: d.proactive.enabled ? undefined : "主动性总开关关着，不会主动找你",
      v: d.proactive.enabled ? `开着，每 ${d.proactive.intervalMinutes ?? 30} 分钟看看要不要说话` : "总开关关着：不会主动找你",
      fix: d.proactive.enabled
        ? undefined
        : <>总开关在配置文件里改；免打扰与每天说几次在各联系人的「主动性」里配</>,
    },
    {
      led: (d.memoryExtractFailures > 0 ? "bad" : "ok") as Led, k: "记忆提取",
      note: d.memoryExtractFailures > 0 ? `记忆提取连续 ${d.memoryExtractFailures} 次失败` : undefined,
      v: d.memoryExtractFailures > 0 ? `连续 ${d.memoryExtractFailures} 次失败，对话正记不下来` : "最近一次整理成功",
      fix: d.memoryExtractFailures > 0 && devMode
        ? <>{link("失败原因看「调用记录」", () => goTab("calls"))}（用途为「记忆提取」的那些）</>
        : undefined,
    },
    ...(t ? [{
      led: (t.failed > 0 && turnFailRecent ? "warn" : "ok") as Led, k: "处理单",
      silent: !(t.failed > 0 && turnFailRecent),
      note: t.failed > 0 && turnFailRecent ? "最近有消息处理失败" : undefined,
      v: <>{t.total} 条消息 · 完成 {t.done} · 失败 {t.failed} · 处理中 {t.inFlight}</>,
      fix: t.failed > 0 && turnFailRecent
        ? <>最近一次失败 {when(t.lastFailedAt!)}{devMode ? <>，{link("明细看「最近处理」", () => goTab("turns"))}</> : null}</>
        : undefined,
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

  return (
    <div className="section" {...panel}>
      <div className="ov-head">
        <h2>状态与配置</h2>
        <div className="actions">{actions}</div>
      </div>
      <div className="ov-desc">这套配置整体跑得怎么样。想改就点各卡片右上角的「去设置」；某位联系人的主动性、记忆和微信绑定在联系人的资料页里。</div>
      {notice && <div className="ov-note bad" role="status">{notice}</div>}
      {alerts.length > 0 && (
        <div className="ov-alerts" role="status">
          <div className="ov-alerts-h">{alerts.length} 项需要你留意</div>
          {alerts.map((a) => (
            <div key={a.title} className="ov-alert">
              <span className={"led " + a.rows.reduce<Led>((acc, r) => worse(acc, r.led), "ok")} />
              <b>{a.title}</b>
              <span className="d">{a.rows.map((r) => r.note).join("；")}</span>
              {a.goto && <button type="button" className="ov-goto" onClick={a.goto.on}>{a.goto.label}</button>}
            </div>
          ))}
        </div>
      )}
      <div className="ov-grid">
        {cards.map((c) => <Card key={c.title} title={c.title} rows={c.rows} goto={c.goto} />)}
      </div>
    </div>
  );
}
