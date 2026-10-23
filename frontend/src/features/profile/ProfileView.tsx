import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, Save, Wand2, FileDown, Images, RotateCcw, SlidersHorizontal, HeartHandshake, BookOpen, X } from "lucide-react";
import { contactsApi, settingsApi } from "../../api";
import { chatApi } from "../../api";
import { fmtTokens } from "../../lib/format";
import { profilePicks } from "../../lib/providers";
import type { ContextUsage } from "../../types";
import type { BondState, CompanionFeatures } from "../../api/contacts";
import { buildMd, exportPersonaMd, parseMd, TEMPLATE } from "../../lib/persona-doc";
import { fileToAvatarDataUrl } from "../../lib/avatar";
import { avatarToneStyle } from "../../lib/avatar-tone";
import { EMPTY_DRAFT, PERSONA_TOTAL_MAX, TABS, type Draft, type ProfileMode, type ProfilePage } from "./constants";
import Modal from "../../components/Modal";
import QqAvatarButton from "../../components/QqAvatarButton";
import PickList from "../../components/PickList";
import { WeChatSection } from "./WeChatSection";
import { QQSection } from "./QQSection";
import MemoryPanel from "../memory/MemoryPanel";
import ProactivePanel from "../tasks/ProactivePanel";
import ContentLibraryPanel from "./ContentLibraryPanel";
import { getProfilePage, setProfilePage, SETTINGS_CHANGED_EVENT } from "../../lib/ui-prefs";
import { cachedStatus, loadStatus } from "../../lib/statusStore";
import { useTabSelect } from "../../hooks/useTabSelect";
import { useDismiss } from "../../hooks/useDismiss";
import Tabs, { panelAria, type PanelAria } from "../../components/Tabs";
import TabPanel from "../../components/TabPanel";
import type { PersonaDraft } from "../../lib/persona-doc";

/** 与后端 FEATURE_DEFAULTS 对齐：除历史行为（memoryExtract 记记忆、splitReply 分条气泡）
 *  与显示开关外默认全关——新增能力由用户主动开，历史行为保持原样、由用户主动关。 */
const FEATURE_DEFAULTS: CompanionFeatures = {
  memoryExtract: true,
  lifeline: false, recap: false, consolidate: false, reminders: false, imageGen: false, web: false, toolRounds: 0, bond: false,
  splitReply: true, turnPct: 0, tokenPct: 0, showThinking: true, showTools: true,
  dailyLimit: 0, temperature: -1, bannedWords: "", schedule: "", lastConsolidatedAt: null,
};
const EMPTY_BOND: BondState = { stage: "", warmth: 50, mood: "", updated_at: null };

/** 陪伴能力开关的一句话说明（记忆 / 生活线 / 温度计这类增强；工具型开关见下方 TOOL_ITEMS）。 */
const FEATURE_ITEMS: Array<{ key: keyof CompanionFeatures; label: string; hint: (who: string) => string }> = [
  { key: "memoryExtract", label: "记忆提取", hint: () => `把对话里新发生的事记下来，以后用得着；关掉后不再记新的，已经记的照常用` },
  { key: "consolidate", label: "记忆整理", hint: () => `定期打扫记忆：记重的合成一条、翻篇的标成过期；记错了能在记忆页翻旧账` },
  { key: "lifeline", label: "生活线摘要", hint: () => `每周总结一段「最近的生活」，该联系人说话不显得没有生活` },
  { key: "recap", label: "窗口边缘梗概", hint: () => `更早的对话压成一句「上次说到」，该联系人接得住「那件事后来呢」` },
  { key: "bond", label: "关系温度计", hint: (p) => `亲密度和心情随聊天变化，${p}的语气也跟着变` },
];

/** 工具清单：她手上每一个能"做点事"的工具一行。开关都绑到现有 features 字段，不另立真源。 */
type ToolRow =
  | { kind: "toggle"; key: keyof CompanionFeatures; label: string; hint: (who: string) => string }
  | { kind: "always"; label: string; hint: string }
  | { kind: "pointer"; label: string; hint: string };

const TOOL_ITEMS: ToolRow[] = [
  { kind: "always", label: "看时间", hint: "报现在几点、今天几号星期几，接得住「今天周几」。一直在。" },
  { kind: "always", label: "翻记忆", hint: "从已记住的事里挑相关的来用；记不记新的归「记忆提取」管。一直在。" },
  { kind: "toggle", key: "web", label: "联网", hint: () => "搜公开网页、读网页正文，接得住当下的事、帮忙找图。这是唯一会主动向外发请求的能力，默认关，会慢一点。" },
  { kind: "toggle", key: "reminders", label: "到点提醒", hint: () => "说一句「明晚九点提醒我吃药」，到点原样发出去；自己立一条或改时间去「主动性」。" },
  { kind: "toggle", key: "imageGen", label: "图像生成", hint: (p) => `${p}能在聊天里画图；要先在 设置 → 能力模型 → 图像生成 配好绘图模型，每人每天最多 5 张，等一分多钟。` },
  { kind: "pointer", label: "技能", hint: "把自定义技能当成一份做法说明书；有可用技能时自动挂载，内容与开关在 设置 → 技能。" },
];

/** 聊天框显示开关（纯显示维）：思考过程折叠条 / 工具调用过程卡片。 */
const CHAT_DISPLAY_ITEMS: Array<{ key: "showThinking" | "showTools"; label: string; short: string; hint: string }> = [
  {
    key: "showThinking", label: "思考过程", short: "气泡顶部可折叠",
    hint: "在回复气泡顶部挂一条「思考过程」，点开看原文。",
  },
  {
    key: "showTools", label: "工具调用过程", short: "查了什么、做了什么",
    hint: "把查时间、设提醒这些步骤显示成卡片；关掉只是不显示，不影响照做。",
  },
];

const GENDER_OPTIONS = [
  { key: "female", label: "女" },
  { key: "male", label: "男" },
  { key: "other", label: "其他" },
] as const;

/** 回放轮数的四种给法：跟随全局 / 固定轮数 / 按这段会话的比例 / 全部。 */
const TURN_MODES: Array<["global" | "turns" | "pct" | "all", string]> = [
  ["global", "跟随全局"], ["turns", "按轮数"], ["pct", "按会话比例"], ["all", "全部"],
];
/** 预设换成"够得着"的档位：3 眼前、10 一段对话、30 一个话题、100 长期陪伴。 */
const TURN_PRESETS = [3, 10, 30, 100];
/** 温度常用档：0.2 稳到 1.6 发散，中间那个就是全局默认值。 */
const TEMP_PRESETS = [0.2, 0.5, 0.8, 1.0, 1.3, 1.6];
/** 与服务端 parseBannedWords 同一套分隔符、同样忽略大小写判重：界面上逐个录入，存的仍是那一行原文。 */
const splitWords = (raw: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of String(raw || "").split(/[,，、;；\r\n]+/)) {
    const w = piece.trim().slice(0, 50);
    const key = w.toLowerCase();
    if (w === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
};
const MAX_BANNED_WORDS = 10;
const bannedCount = (raw: string): number => Math.min(splitWords(raw).length, MAX_BANNED_WORDS);
const PCT_PRESETS = [25, 50, 75];
/** token 粗估，与后端 agent.ts estimateTokens 同口径（CJK 1 字 1 token，其余 4 字符 1 token）。只用于占用展示，不做计费。 */
const estimateTokens = (s: string): number => {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
};
/** 与后端 MAX_TURNS 同值（前端不 import 后端模块）。 */
const MAX_TURNS = 500;

/** 两组长标签候选放在模块层：.tsx 里内联 `Array<[boolean,string]>()` 会被当成泛型调用。 */
const REPLY_MODES: Array<[boolean, string]> = [[true, "分多条"], [false, "单条逐字"]];
const PERSONA_MODES: Array<[boolean, string]> = [[false, "分段编辑"], [true, "整份 Markdown"]];

/**
 * 自定义数字框：聚焦期间由本地字符串接管，**失焦或回车才**夹紧与取整。
 * 两个坑都是实测出来的：
 * ① 在 onChange 里就 clamp 会吃掉打进一半的数字——清空后立刻回填 1，接着打就成了 1x；
 *    温度那一格还做过 `Math.round(v*10)/10`，0.75 永远打不出来。
 * ② number 输入框在打到「1.」这种半成品时会把 value 报成空串，配上派生 value 就等于清空。
 * 所以这里用 type=text + inputMode=decimal，五个自定义格共用同一条口径。
 */
function NumField({ label, className, ariaLabel, min, max, precision = 0, suffix, shown, onCommit }: {
  label: string; className: string; ariaLabel: string;
  min: number; max: number; precision?: number; suffix?: string;
  /** 当前值该显示成什么；哨兵值（0 / 跟随全局）传空串，别让"关闭"这个状态出现在数字框里。 */
  shown: string; onCommit: (n: number) => void;
}): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const commit = (): void => {
    const raw = text;
    setText(null);
    if (raw === null || raw.trim() === "") return;
    const n = Number(raw.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n)) return;
    const factor = 10 ** precision;
    onCommit(Math.min(max, Math.max(min, Math.round(n * factor) / factor)));
  };
  return (
    <label className="pf-custom">{label}
      <input className={"pf-comp-input " + className} type="text" inputMode="decimal"
        aria-label={ariaLabel} title={`${min}~${max}`} placeholder={`${min}~${max}`}
        value={text ?? shown}
        onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
      {suffix}
    </label>
  );
}

/**
 * 禁用词录入框：一个词一枚标签，输入→回车即成一枚，× 或空输入框上的退格删掉。
 * 刻意不再要求用户自己写逗号/顿号来分隔（那是把解析规则的负担甩给填表的人），
 * 但落库仍是后端 parseBannedWords 认的那一行原文（逗号连接），存储与出站拼接都不动。
 */
function WordChips({ value, onChange, ariaLabel, placeholder }: {
  value: string; onChange: (raw: string) => void; ariaLabel: string; placeholder: string;
}): JSX.Element {
  const words = splitWords(value);
  const [text, setText] = useState("");
  // 后端把这一行原文截到 200 字（contacts.ts 的 features 归一），所以格子按剩余空间给：
  // 打满就填不进去，而不是保存时悄悄少几个词。
  const room = Math.max(0, 200 - words.join(",").length - 1);
  const full = words.length >= MAX_BANNED_WORDS || room < 1;
  const commit = (): void => {
    const w = text.trim().slice(0, 50);
    setText("");
    if (w === "" || full) return;
    if (words.some((x) => x.toLowerCase() === w.toLowerCase())) return;
    onChange([...words, w].join(","));
  };
  const remove = (word: string): void => onChange(words.filter((x) => x !== word).join(","));
  return (
    <div className="pf-words" onClick={(e) => { const el = e.target as HTMLElement; if (el.tagName === "DIV") el.querySelector("input")?.focus(); }}>
      {words.map((w) => (
        <span key={w} className="pf-word">{w}
          <button type="button" aria-label={`移除「${w}」`} onClick={() => remove(w)}><X size={11} strokeWidth={2.4} /></button>
        </span>
      ))}
      {!full && (
        <input className="pf-word-input" aria-label={ariaLabel} placeholder={words.length === 0 ? placeholder : ""}
          value={text} maxLength={room}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" || /[,，、;；]/.test(e.key)) { e.preventDefault(); commit(); return; }
            if (e.key === "Backspace" && text === "" && words.length > 0) { const last = words[words.length - 1]; if (last !== undefined) remove(last); }
          }} />
      )}
    </div>
  );
}

/**
 * 联系人定义：整页工作台，四段式——
 * 「人格设定」（背景 / 人设 / 关系 + Markdown）与「对话设置」（模型、回放轮数、陪伴能力、微信连接）是编辑表单；
 * 「记忆」「主动性」内嵌该联系人的运行视图（原顶层导航页并入此处）。
 * 回放轮数与模型绑定同构：默认跟随全局，这里按联系人单独覆盖。
 * 编辑内置「设置助手」（contactId=assistant）时只开放头像/名字/对话设置——
 * 它的提示词是代码内置的，不随卡片走，界面上也不给碰。
 */
export default function ProfileView({ mode, contactId, onBack, onSaved, initialDraft, initialPage }: {
  mode: ProfileMode;
  contactId: string;
  onBack: () => void;
  onSaved: (id: string) => void;
  /** 导入 .md 时的预填草稿（仅 create 模式有意义）。 */
  initialDraft?: PersonaDraft;
  /** 打开时直达的分区（聊天页「⋯」菜单的记忆/主动性入口）。 */
  initialPage?: ProfilePage;
}): JSX.Element {
  const isAssistant = mode === "edit" && contactId === "assistant";
  const [draft, setDraft] = useState<Draft>(initialDraft ?? EMPTY_DRAFT);
  const [gender, setGender] = useState("female");
    const [asMarkdown, setAsMarkdown] = useState(false);
  const [mdDraft, setMdDraft] = useState("");
  const [loaded, setLoaded] = useState(mode === "create");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  /** 已落库表单的快照串：与当前快照不一致即为「有未保存的修改」。 */
  const [baseline, setBaseline] = useState("");
  // 页面分区：persona/settings 是编辑表单；memory/proactive 内嵌该联系人的运行视图，
  // 其条目自己即时写库，表单的保存入口是底部脏值条（见 pf-dock）。
  const [page, setPage] = useState<ProfilePage>(() =>
    initialPage ?? (getProfilePage(contactId) as ProfilePage | null) ?? "persona");
  // 带着目的跳进来（initialPage）优先；否则回到这位**上次看的分区**——刚在「记忆」里删完，
  // 退出再进来不该重新点两下才回到那一屏。
  useEffect(() => { setProfilePage(contactId, page); }, [contactId, page]);
  // 手写 tab 的键盘行为（←→/Home/End 移动并选中，未选中项退出 Tab 序列）
  const onPageKey = useTabSelect();
  // 头像：从会话列表挪到这里，统一走「保存」落库
  const [avatar, setAvatar] = useState("");
  const [avatarDirty, setAvatarDirty] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  // 点头像=看大图（有图时）；换图走旁边那枚「更换头像」按钮
  const [avaZoom, setAvaZoom] = useState<string | null>(null);
  useDismiss(!!avaZoom, () => setAvaZoom(null));
  // 长相参考图：存的是 /media 路径（原图太大，不能像头像那样内联进行里）
  const [faceRef, setFaceRef] = useState("");
  const [faceRefDirty, setFaceRefDirty] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const faceInputRef = useRef<HTMLInputElement>(null);
  // 模型绑定："" = 跟随全局
  const [modelProfile, setModelProfile] = useState("");
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([]);
  // 回放轮数：0 = 跟随全局；globalTurns 用来把「跟随全局」标成具体数字
  const [recentTurns, setRecentTurns] = useState(0);
  const [globalTurns, setGlobalTurns] = useState(6);
  /** 「全部轮数」这一档的代价要看得见：整段历史多大、多少轮（进「对话设置」拉一次）。 */
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  // 陪伴能力（可插拔借鉴功能包）：开关 + 作息 + 生活线 + 温度计
  const [features, setFeatures] = useState<CompanionFeatures>(FEATURE_DEFAULTS);
  const [lifeline, setLifeline] = useState("");
  const [recap, setRecap] = useState("");
  const [bond, setBond] = useState<BondState>(EMPTY_BOND);
  const [consBusy, setConsBusy] = useState(false);
  const [consNote, setConsNote] = useState("");
  // 提示词预览（按此联系人）：还原下一轮发消息 she 实际收到的完整内容
  type PreviewData = { prompt: string; history?: Array<{ role: string; text: string }>; memoryNote?: string };
  const [promptPreview, setPromptPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // 提示词预览属调试面：只在开发模式露出（和状态页的调用记录/最近处理同一口径）。
  const [devMode, setDevMode] = useState(() => cachedStatus(contactId)?.devMode === true);
  useEffect(() => {
    let alive = true;
    void loadStatus(contactId).then((s) => { if (alive) setDevMode(s.devMode === true); }).catch(() => { /* 拿不到就按非 dev 处理 */ });
    return () => { alive = false; };
  }, [contactId]);
  /** 未保存就点返回 / 模板会覆盖已有三段 → 都先拦一次。拦在动作上，不拦在提示上。 */
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmTemplate, setConfirmTemplate] = useState(false);
  /** 「换回默认人设」是覆盖性的，和按模板填写一样先拦一次；resetting 只锁那一个按钮。 */
  const [confirmResetCard, setConfirmResetCard] = useState(false);
  const [resetting, setResetting] = useState(false);

  const onAvatarFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    fileToAvatarDataUrl(file)
      .then((dataUrl) => { setAvatar(dataUrl); setAvatarDirty(true); })
      .catch((err: Error) => setError(err.message));
  };

  /** 长相参考：原图直传 /api/media 落盘，这里只留那条路径（不像头像那样压缩内联）。 */
  const onFaceFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFaceBusy(true);
    chatApi.uploadImage(file)
      .then((r) => { setFaceRef(r.url); setFaceRefDirty(true); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setFaceBusy(false));
  };

  useEffect(() => {
    if (mode !== "edit") return;
    void contactsApi.fetchContact(contactId)
      .then((d) => {
        setDraft({
          name: d.contact.name || "",
          background: d.contact.card.background || "",
          identity: d.contact.card.identity || "",
          relationship: d.contact.card.relationship || "",
        });
        setModelProfile(d.contact.model_profile ?? "");
        setRecentTurns(d.contact.recent_turns ?? 0);
        setGender(d.contact.gender ?? "female");
        setAvatar(d.contact.avatar || "");
        setFaceRef(d.contact.faceRef ?? "");
        setFeatures({ ...FEATURE_DEFAULTS, ...(d.contact.features ?? {}) });
        setLifeline(d.contact.lifeline ?? "");
        setRecap(d.contact.recap ?? "");
        setBond({ ...EMPTY_BOND, ...(d.contact.bond ?? {}) });
        setLoaded(true);
      })
      .catch((e: Error) => setError(e.message));
    void settingsApi.fetchSettings()
      .then((s) => {
        setModelOptions(profilePicks(s.profiles ?? [], s.providerNames ?? {}));
        setGlobalTurns(s.persona?.recentTurns || s.defaultRecentTurns || 6);
      })
      .catch((e: Error) => setError("可选模型与全局轮数读取失败：" + e.message));
  }, [mode, contactId]);

  // 「对话设置」与「人格设定」都拉一次上下文用量：前者把「全部」这一档的代价显示出来，
  // 后者把「三段人设占多少」写进编辑器脚注。
  useEffect(() => {
    if (mode !== "edit" || (page !== "settings" && page !== "persona")) return;
    void chatApi.fetchContextUsage(contactId).then(setUsage).catch(() => setUsage(null));
  }, [mode, page, contactId]);

  // 「对话上下文」的全局轮数在设置页改过，这里那句「当前全局默认 N 轮」要跟着换，
  // 不能等用户退出资料页重进（广播来自设置页那张自带保存的卡）。
  useEffect(() => {
    const sync = (): void => {
      void settingsApi.fetchSettings()
        .then((s) => {
          setGlobalTurns(s.persona?.recentTurns || s.defaultRecentTurns || 6);
          setModelOptions(profilePicks(s.profiles ?? [], s.providerNames ?? {}));
        })
        .catch(() => undefined);
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
  }, []);

  /** 当前是哪种给法。turnPct>0 优先（后端 effectiveRecentTurnsFor 同一判序）。 */
  const turnMode: "global" | "turns" | "pct" | "all" =
    features.turnPct > 0 ? "pct" : recentTurns === -1 ? "all" : recentTurns === 0 ? "global" : "turns";
  const pickTurnMode = (k: "global" | "turns" | "pct" | "all"): void => {
    if (k === "global") { setRecentTurns(0); setFeatures({ ...features, turnPct: 0 }); }
    else if (k === "all") { setRecentTurns(-1); setFeatures({ ...features, turnPct: 0 }); }
    else if (k === "turns") { setFeatures({ ...features, turnPct: 0 }); if (recentTurns <= 0) setRecentTurns(6); }
    else { setFeatures({ ...features, turnPct: features.turnPct > 0 ? features.turnPct : 50 }); if (recentTurns === -1) setRecentTurns(0); }
  };
  const totalTurns = usage?.fullHistory?.turns ?? 0;
  const turnHint = (() => {
    if (turnMode === "pct") {
      // 换算要说人话：比例本身没概念，"这段会话多少轮 → 带多少轮"才有。
      if (totalTurns === 0) return `带这段会话最近 ${features.turnPct}% 的轮数（正在读入轮数…）`;
      return `这段会话 ${totalTurns} 轮 × ${features.turnPct}% = 带最近 ${Math.max(1, Math.ceil(totalTurns * features.turnPct / 100))} 轮`;
    }
    if (turnMode === "all" && usage?.fullHistory) {
      return `全部历史 ≈ ${fmtTokens(usage.fullHistory.tokens)} token · ${usage.fullHistory.turns} 轮`
        + (usage.fullHistory.tokens > 20000 ? "（每次调用的输入都会涨到这个量级）" : "");
    }
    if (turnMode === "turns" && usage?.fullHistory) {
      return `这段会话共 ${usage.fullHistory.turns} 轮 · 全部 ≈ ${fmtTokens(usage.fullHistory.tokens)} token`;
    }
    return null;
  })();
  const tokenHint = features.tokenPct > 0 && usage
    // 没填「输入上限」时窗口是按保守估算来的，这个数就是估的 —— 必须说破（圆环同一口径）。
    ? `历史上限 ≈ ${fmtTokens(Math.floor(usage.limit * features.tokenPct / 100))} token`
      + `（${usage.limitIsFallback ? "按 32K 保守估算的窗口" : `窗口 ${fmtTokens(usage.limit)}`} 的 ${features.tokenPct}%）`
    : null;

  // Markdown 视图与分栏视图共用同一份 effective 草稿，切换不丢内容
  const effective = useMemo<Draft>(
    () => (asMarkdown ? { ...draft, ...parseMd(mdDraft) } : draft),
    [asMarkdown, mdDraft, draft],
  );
  // 界面文案里指代这位角色一律用「该联系人」——不叫名字（名字已在标题/头像处）、也不用他/她。
  const who = "该联系人";
  // 三段人设的体量：字符数 + 粗估 token，写进脚注让"每轮都要带的成本"在改之前就看得见。
  const personaChars = effective.background.length + effective.identity.length + effective.relationship.length;
  // 超预算多少字。save() 拿它拦人，页脚拿它报警——两处必须同一个数，
  // 所以只在这里算一次，不各写一遍 `personaChars > PERSONA_TOTAL_MAX`。
  const personaOver = Math.max(0, personaChars - PERSONA_TOTAL_MAX);
  const personaTokens = estimateTokens(effective.background + effective.identity + effective.relationship);

  const toggleMarkdown = (): void => {
    if (!asMarkdown) {
      setMdDraft(buildMd(effective));
    } else {
      // 切回分段：把 Markdown 里的改动落回 draft。从前只翻视图不落回，
      // 实测在 .md 里追加一段再切回来，那段字就没了 —— 而上面的注释写着"切换不丢内容"。
      setDraft(effective);
    }
    setAsMarkdown(!asMarkdown);
  };

  /** 按此联系人预览：下一轮发消息 she 实际收到的完整内容（系统提示词 + 回放历史）。 */
  const runPromptPreview = (): void => {
    setPreviewing(true);
    settingsApi.previewPrompt({
      contactId,
      character: {
        name: effective.name,
        background: effective.background,
        identity: effective.identity,
        relationship: effective.relationship,
      },
    })
      .then(setPromptPreview)
      .catch((e: Error) => setError(e.message))
      .finally(() => setPreviewing(false));
  };

  // 人格草稿一改，旧预览即成过期结果——清掉，防止被当成新内容读
  useEffect(() => { setPromptPreview(null); }, [effective]);

  const flashSaved = (): void => {
    setSavedFlash(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedFlash(false), 2200);
  };

  /**
   * 表单当前会写回后端的那份载荷——脏比对与保存共用同一个口径，不会两处漂移。
   *
   * `over` 是给「state 还没落下去，但要先按即将生效的值算一次基线」的场合用的
   * （目前只有「立即整理记忆」：整理产出会刷新 features/生活线/梗概/温度计）。
   * 之所以走参数而不是在外面手工拼对象：投影规则必须只有一处。
   * 比如 bond 在这里**刻意丢掉**服务端管的 `updated_at`、字符串都过 trim ——
   * 手拼一份带 `updated_at` 的基线永远不等于 snapshot()，脏值条会从此常驻。
   */
  const formPayload = (over: {
    features?: typeof features;
    lifeline?: string;
    recap?: string;
    bond?: BondState;
    /** 人格三段也要按"即将生效的值"算基线（恢复默认人设那一步），投影规则仍只有一处。 */
    draft?: Draft;
  } = {}): Record<string, unknown> => {
    const eff = over.draft ?? effective;
    const payload: Record<string, unknown> = {
      name: eff.name.trim(),
      ...(mode === "edit" ? { modelProfile, recentTurns } : {}),
      ...(avatarDirty || mode === "create" ? { avatar } : {}),
      // 与头像同一套脏值口径：只有真换过才回传，且基线走同一个投影函数算，
      // 免得"开页就显脏"或"保存后脏值条常驻"（bond 那个坑）。
      ...(faceRefDirty ? { faceRef } : {}),
    };
    const bd = over.bond ?? bond;
    // 助手模式根本不展示人格三段，也绝不回传——后端按 key 合并，漏传即保留内置提示词。
    if (!isAssistant) {
      payload.gender = gender;
      payload.background = eff.background.trim();
      payload.identity = eff.identity.trim();
      payload.relationship = eff.relationship.trim();
      // 陪伴能力：整组回传（后端按 key 并进现有 features）；生活线与温度计允许手改。
      payload.features = over.features ?? features;
      payload.lifeline = (over.lifeline ?? lifeline).trim();
      payload.recap = (over.recap ?? recap).trim();
      payload.bond = { stage: bd.stage.trim(), warmth: bd.warmth, mood: bd.mood.trim() };
    }
    return payload;
  };

  const snapshot = (over?: Parameters<typeof formPayload>[0]): string => JSON.stringify(formPayload(over));

  // 服务端资料落进 state 后才取基线；create 模式没有服务端副本，基线留空 → 保存条常显。
  useEffect(() => {
    if (mode === "edit" && loaded) setBaseline(snapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, loaded]);

  const dirty = loaded && snapshot() !== baseline;

  const save = (): void => {
    const payload = formPayload();
    if (!payload.name) { setError("名称不能为空"); return; }
    // 总量超预算就在界面上拦下，不发请求。后端确实也会砍（sanitizeCharacter 按
    // 背景→人设→关系 的顺序截到合计上限），但那砍法按段序来，被砍中的常常是刚
    // 手打完的那一段，而人在界面上看不出少了什么——宁可让他自己决定删哪段。
    if (personaOver > 0) {
      setError(`三段人设共 ${personaChars} 字，超出上限 ${PERSONA_TOTAL_MAX} 字（多 ${personaOver} 字）。删到预算内再保存。`);
      return;
    }
    setSaving(true);
    setError("");
    const req = mode === "create"
      ? contactsApi.createContact(payload)
      : contactsApi.updateContact(contactId, payload);
    req
      .then((d) => {
        setSaving(false);
        setBaseline(snapshot());
        flashSaved();
        onSaved(mode === "create" ? d.contact.id : contactId);
        // 新建之后**不**把页面关掉：模型绑定、回放轮数、陪伴能力全 gate 在 edit 模式，
        // 一创建就弹回去等于让人家"先建一个再进来配"，两次开门才能配好一个人。
      })
      .catch((e: Error) => { setError(e.message); setSaving(false); });
  };

  /** 填入模板：markdown 模式下必须改 mdDraft，否则 effective 里 parseMd(mdDraft) 会把它盖回去，
   *  按钮点了等于没点。三段已有内容时先拦一次——这是会静默清掉人手写设定的少数几个按钮。 */
  const applyTemplate = (): void => {
    const next = { ...effective, ...TEMPLATE };
    if (asMarkdown) setMdDraft(buildMd(next));
    else setDraft(next);
    setConfirmTemplate(false);
  };
  const wantsTemplate = effective.background !== "" || effective.identity !== "" || effective.relationship !== "";
  /** 返回前拦一次：create 模式下 dirty 恒为真（没有服务端副本），所以按"有没有写过内容"判。 */
  const hasWork = dirty && (mode === "edit" || draft.name !== "" || wantsTemplate || avatar !== "");
  const tryBack = (): void => { if (hasWork) setConfirmLeave(true); else onBack(); };

  /** 手动整理一次：跑完刷新回执，并重新拉资料（生活线/温度计/上次整理时间都是它的产出）。 */
  const runConsolidate = (): void => {
    setConsBusy(true);
    setConsNote("");
    setError("");
    void contactsApi.consolidateContact(contactId)
      .then((r) => {
        setConsNote(r.note);
        if (r.skipped) return undefined;
        return contactsApi.fetchContact(contactId).then((d) => {
          // 整理产出会刷新 features/lifeline/recap/bond，这四项都在快照里；
          // 不同步基线的话，用户什么都没改也会浮出「有未保存的修改」。
          // setState 是异步的，所以基线走 formPayload 的 over 参数按即将生效的值算，
          // 保证和下一次 snapshot() 用的是同一套投影，而不是手工拼一份。
          const applied = {
            features: { ...FEATURE_DEFAULTS, ...(d.contact.features ?? {}) },
            lifeline: d.contact.lifeline ?? "",
            recap: d.contact.recap ?? "",
            bond: { ...EMPTY_BOND, ...(d.contact.bond ?? {}) },
          };
          setFeatures(applied.features);
          setLifeline(applied.lifeline);
          setRecap(applied.recap);
          setBond(applied.bond);
          setBaseline(snapshot(applied));
        });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setConsBusy(false));
  };

  /**
   * 人设换回出厂那份：只动人格三段，名字、头像、性别、能力开关一概不碰
   * （那个按钮说的是「人设」，顺手把别的设置一起改了会让人找不到是哪一步动的）。
   * 与「按模板填写」也不是一回事：那是给人照着改的示例，这里是内置默认那份，直接从后端取。
   *
   * 分两条路是因为新建时**还没有 contact id**：那条路发给服务端就是
   * `/api/contacts//reset-card`（实测报「未知路径」），而且新建态本来也无处可写——
   * 草稿还没落库，把出厂那三段填进表单就等于换好了，留不留由底部「保存」决定。
   */
  const runResetCard = (): void => {
    setResetting(true);
    setError("");
    if (mode === "create") {
      void contactsApi.fetchDefaultCard()
        .then((d) => {
          const next: Draft = { ...draft, ...d.card };
          if (asMarkdown) setMdDraft(buildMd(next));
          else setDraft(next);
          setConfirmResetCard(false);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setResetting(false));
      return;
    }
    void contactsApi.resetContactCard(contactId)
      .then(() => contactsApi.fetchContact(contactId))
      .then((d) => {
        const next: Draft = {
          name: d.contact.name || "",
          background: d.contact.card.background || "",
          identity: d.contact.card.identity || "",
          relationship: d.contact.card.relationship || "",
        };
        // 服务端已经落库，所以草稿与基线都要立刻按新值对齐：
        // setState 是异步的，基线走 formPayload 的 draft 参数算，否则脏值条会一直挂着。
        setDraft(next);
        setMdDraft(buildMd(next));
        setBaseline(snapshot({ draft: next }));
        flashSaved();
        setConfirmResetCard(false);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setResetting(false));
  };

  // 分区内容各是一个根元素，谁渲染就由谁挂 panelAria；create 模式没有 tab 栏，
  // 这时不输出关联，免得 aria-labelledby 指向一个不存在的 tab。
  const pagePanel: PanelAria = mode === "edit" ? panelAria("pf-page", page) : {};
  const pagePanelFor = (key: ProfilePage): PanelAria => mode === "edit" ? panelAria("pf-page", key) : {};
  const [visitedPages, setVisitedPages] = useState<Set<ProfilePage>>(() => new Set([page]));
  useEffect(() => {
    setVisitedPages((prev) => prev.has(page) ? prev : new Set(prev).add(page));
  }, [page]);

  return (
    <div className="pf" data-page={page}>
      <div className="pf-topbar">
        <button type="button" className="pf-back" onClick={tryBack}>
          <ArrowLeft size={15} strokeWidth={1.8} />{isAssistant ? "返回助手" : "返回对话"}
        </button>
        {mode === "edit" && (
          <div className="pf-pages" role="tablist" aria-label="设置分区" onKeyDown={onPageKey}>
            <button type="button" role="tab" id="pf-page-tab-persona" aria-selected={page === "persona"}
              tabIndex={page === "persona" ? 0 : -1}
              className={page === "persona" ? "on" : ""} onClick={() => setPage("persona")}>人格设定</button>
            <button type="button" role="tab" id="pf-page-tab-settings" aria-selected={page === "settings"}
              tabIndex={page === "settings" ? 0 : -1}
              className={page === "settings" ? "on" : ""} onClick={() => setPage("settings")}>
              <SlidersHorizontal size={12} strokeWidth={1.9} />对话设置
            </button>
            {!isAssistant && (
              <>
                <button type="button" role="tab" id="pf-page-tab-care"
                  aria-selected={page === "memory" || page === "proactive"}
                  tabIndex={page === "memory" || page === "proactive" ? 0 : -1}
                  className={page === "memory" || page === "proactive" ? "on" : ""}
                  onClick={() => { if (page !== "memory" && page !== "proactive") setPage("memory"); }}>
                  <HeartHandshake size={12} strokeWidth={1.9} />记忆与主动
                </button>
                <button type="button" role="tab" id="pf-page-tab-gallery" aria-selected={page === "gallery"}
                  tabIndex={page === "gallery" ? 0 : -1}
                  className={page === "gallery" ? "on" : ""} onClick={() => setPage("gallery")}>
                  <Images size={12} strokeWidth={1.9} />内容库
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card card-pad pf-head">
        {/* 眉标单独占一行：从前它嵌在名字那一列里，左边线被头像顶到 391px，
            而卡片内容/头像从 337px 起 —— 看着像浮在卡片上边、不属于任何东西。 */}
        <div className="pf-eyebrow">{mode === "create" ? "新建联系人" : isAssistant ? "助手设置" : "正在编辑"}</div>
        <div className="pf-ava-col">
          <button
            type="button"
            className={"pf-avatar" + (avatar ? " has-img" : "")}
            style={avatarToneStyle(effective.name)}
            title={avatar ? "查看头像大图" : "点击添加头像"}
            aria-label={avatar ? "查看该联系人的头像大图" : "添加该联系人的头像"}
            onClick={() => (avatar ? setAvaZoom(avatar) : avatarInputRef.current?.click())}
          >
            {avatar ? <img src={avatar} alt="" /> : (effective.name || (mode === "create" ? "新" : "联")).slice(0, 1)}
          </button>
          <button type="button" className="pf-ghost pf-ava-change" onClick={() => avatarInputRef.current?.click()}>
            <Camera size={13} strokeWidth={1.8} />更换头像
          </button>
          {/* 用 QQ 号取头像：拿到的是本地 /media 路径，和这张头像现在能收的两种形态之一对得上，
              所以直接写进草稿、跟着底部的「保存」走，不必再压成 dataURL。 */}
          <QqAvatarButton onPick={(url) => { setAvatar(url); setAvatarDirty(true); }} />
        </div>
        <div className="pf-who">
          <input
            className="pf-name"
            aria-label={isAssistant ? "助手名称" : "角色名称"}
            value={draft.name}
            maxLength={20}
            placeholder={isAssistant ? "助手名称" : "角色名称（必填）"}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          {!isAssistant && (
            <div className="pf-gender" role="radiogroup" aria-label="角色性别">
              {GENDER_OPTIONS.map((g) => (
                <button key={g.key} type="button" role="radio" aria-checked={gender === g.key}
                  className={"pf-gender-btn" + (gender === g.key ? " on" : "")}
                  onClick={() => setGender(g.key)}>{g.label}</button>
              ))}
              <span className="pf-gender-hint">聊天时怎么指代{who}；不选就用中性的称呼</span>
            </div>
          )}
        </div>
      </div>

      {mode === "edit" && !isAssistant && (page === "memory" || page === "proactive") && (
        <div className="pf-care-nav">
          <Tabs base="pf-care" value={page} onChange={setPage}
            tabs={[{ key: "memory", label: "记忆" }, { key: "proactive", label: "主动计划" }]} />
        </div>
      )}

      <input ref={avatarInputRef} type="file" accept="image/*" hidden onChange={onAvatarFile} />
      <input ref={faceInputRef} type="file" accept="image/*" hidden onChange={onFaceFile} />

      {avaZoom && (
        <div className="img-zoom" onClick={() => setAvaZoom(null)} role="dialog" aria-modal="true"
          aria-label="头像大图" data-keep-menu>
          <img src={avaZoom} alt="头像大图" onClick={(e) => e.stopPropagation()} />
          <button type="button" aria-label="关闭" onClick={() => setAvaZoom(null)}><X size={18} /></button>
        </div>
      )}

      {error && <div className="pf-error" role="alert">{error}</div>}

      {mode === "edit" && !loaded && (page === "persona" || page === "settings") && (
        <div className="card card-pad empty" {...pagePanel}>读取中…</div>
      )}

      {(visitedPages.has("persona") || page === "persona") && !isAssistant && loaded && (
        <div className="card card-pad" hidden={page !== "persona"} {...pagePanelFor("persona")}>
          {/* 三段一次摊开：从前这里是「段落 tab × 一个大 textarea」，一次只看得见三段里的一段，
              切段时整块换掉，上面还摆了一行「当前编辑 / 整份人格文档（.md）」的文件隐喻——
              系统里根本没有文件，只会让人以为自己在写的是一份份文档而不是同一个人。 */}
          <div className="pf-mode-row">
            <span className="pf-mode-label">编辑方式</span>
            <div className="pf-mode-ctl" role="radiogroup" aria-label="人格文档的编辑方式">
              {PERSONA_MODES.map(([md, label]) => (
                <button key={label} type="button" role="radio" aria-checked={asMarkdown === md}
                  className={"prof-chip" + (asMarkdown === md ? " on" : "")}
                  title={md ? "把三段拼成一份 .md 整份编辑" : "背景 / 人设 / 与用户关系 分段编辑"}
                  onClick={() => { if (asMarkdown !== md) toggleMarkdown(); }}>{label}</button>
              ))}
            </div>
            <span className="pf-mode-actions">
              <button type="button" className="pf-ghost" title="填入示例人格（可改）"
                onClick={() => { if (wantsTemplate) setConfirmTemplate(true); else applyTemplate(); }}>
                <Wand2 size={13} strokeWidth={1.8} />按模板填写
              </button>
              <button type="button" className="pf-ghost" disabled={resetting}
                title="人格三段换回出厂那份；名字、头像、能力开关都不动"
                onClick={() => setConfirmResetCard(true)}>
                <RotateCcw size={13} strokeWidth={1.8} />{resetting ? "还原中…" : "换回默认人设"}
              </button>
              <button type="button" className="pf-ghost" title="下载整份人格文档"
                onClick={() => exportPersonaMd(effective.name || "联系人", effective)}>
                <FileDown size={13} strokeWidth={1.8} />导出 .md
              </button>
            </span>
          </div>

          {asMarkdown ? (
            <textarea
              className="pf-editor mono"
              aria-label="人格文档（Markdown 全文）"
              rows={20}
              spellCheck={false}
              // 全文上限 = 三段合计额度 + 标题占的那几个字。解析回三段时总量仍要被
              // 后端砍到 PERSONA_TOTAL_MAX，不在这里挡一刀就是存进去才发现少了尾巴。
              maxLength={PERSONA_TOTAL_MAX + 200}
              value={mdDraft}
              onChange={(e) => setMdDraft(e.target.value)}
            />
          ) : (
            <div className="pf-secs">
              {TABS.map((t) => (
                <div key={t.key} className="pf-sec">
                  <label className="pf-sec-h" htmlFor={`pf-sec-${t.key}`}>
                    <span className="pf-sec-name">{t.label}</span>
                    <span className="pf-sec-hint">{t.hint}</span>
                  </label>
                  <textarea
                    id={`pf-sec-${t.key}`}
                    className="pf-editor"
                    aria-label={t.label + "正文"}
                    rows={6}
                    placeholder={t.hint}
                    // 单段就能占满全部额度，所以 maxLength 给的是合计上限而不是每段一份。
                    // 少了它，粘贴/导入超长文本时用户能一路打字，直到保存才被后端静默砍掉。
                    maxLength={PERSONA_TOTAL_MAX}
                    value={draft[t.key]}
                    onChange={(e) => setDraft({ ...draft, [t.key]: e.target.value })}
                  />
                  {/* 只报本段字数：额度是三段合计的，写在这里会让人以为每段各有一份。
                      合计与超没超看页脚那条。 */}
                  <div className="pf-sec-count">{draft[t.key].length} 字</div>
                </div>
              ))}
            </div>
          )}

          <div className="pf-foot">
            书写约定：以用户（「我」）视角撰写，「你」指该角色。保存后立即生效。
            <span className="pf-foot-cost">
              三段共 {personaChars} / {PERSONA_TOTAL_MAX} 字，每轮都会带给该联系人
              {personaOver > 0
                ? <span className="over"> · 超 {personaOver} 字，存不下（删到预算内再保存）</span>
                : usage && usage.limit > 0 && personaTokens > 0
                  ? ` · 约占能用到的窗口 ${(personaTokens / usage.limit * 100).toFixed(1)}%`
                  : ""}
              {personaOver > 0 ? "" : "。"}
            </span>
          </div>
        </div>
      )}

      {(visitedPages.has("persona") || page === "persona") && isAssistant && (
        <div className="pf-assist-note" hidden={page !== "persona"} {...pagePanelFor("persona")}>
          助手的内置提示词由程序固定，不提供修改；切到「对话设置」可以换模型、调回放轮数。
        </div>
      )}

      {mode === "edit" && (visitedPages.has("settings") || page === "settings") && loaded && (
        <div className="pf-settings" hidden={page !== "settings"} {...pagePanelFor("settings")}>
          {/* 微信连接放最前：绑不绑通道决定从哪里说话，优先级高于模型参数。 */}
          {!contactId.startsWith("assistant") && <WeChatSection contactId={contactId} who={who} />}
          {/* QQ 跟在微信后面：两条通道各自独立绑定，一张联系人可以两条都开。 */}
          {!contactId.startsWith("assistant") && <QQSection contactId={contactId} who={who} />}

          <div className="card card-pad pf-set-card">
            <div className="pf-set-title">模型与上下文</div>
            <div className="pf-set-row">
              <div className="pf-set-label">
                <span title="该联系人用哪个模型说话；跟随全局 = 用设置里的主模型。">使用模型</span>
              </div>
              <div className="pf-set-ctl">
                <PickList label="该联系人用哪个模型" value={modelProfile}
                  options={[{ value: "", label: "跟随全局（正在生效的主模型）" }, ...modelOptions]}
                  empty={modelOptions.length === 0 ? "还没有存好的模型档" : undefined}
                  onChange={setModelProfile} />
                {modelOptions.length === 0 && (
                  <small className="pf-set-note">先去「设置 → 主对话模型」存一份模型档，这里才有得挑。</small>
                )}
              </div>
            </div>
            <div className="pf-set-row">
              <div className="pf-set-label">
                <span title="分多条：一条条整段弹出（像真人发微信）。单条整段：一个气泡逐字流式写出。">回复方式</span>
              </div>
              <div className="pf-set-ctl" role="radiogroup" aria-label="回复方式">
                {REPLY_MODES.map(([on, label]) => (
                  <button key={label} type="button" role="radio" aria-checked={features.splitReply === on}
                    className={"prof-chip" + (features.splitReply === on ? " on" : "")}
                    onClick={() => setFeatures({ ...features, splitReply: on })}>{label}</button>
                ))}
              </div>
            </div>
            <div className="pf-set-row">
              <div className="pf-set-label">
                <span title={`记得最近几轮对话，调大更连贯、也更费。当前全局默认 ${globalTurns} 轮。`}>回放轮数</span>
                {turnHint && <small className="pf-set-cost">{turnHint}</small>}
              </div>
              <div className="pf-set-ctl pf-set-stack">
                <div className="pf-set-ctl" role="radiogroup" aria-label="回放轮数的给法">
                  {TURN_MODES.map(([key, label]) => (
                    <button key={key} type="button" role="radio" aria-checked={turnMode === key}
                      className={"prof-chip" + (turnMode === key ? " on" : "")}
                      onClick={() => pickTurnMode(key)}>{label}</button>
                  ))}
                </div>
                {turnMode === "turns" && (
                  <div className="pf-set-ctl" role="group" aria-label="轮数">
                    {TURN_PRESETS.map((n) => (
                      <button key={n} type="button" aria-pressed={recentTurns === n}
                        className={"prof-chip" + (recentTurns === n ? " on" : "")}
                        onClick={() => setRecentTurns(n)}>{n} 轮</button>
                    ))}
                    <NumField label="自定义" className="pf-comp-tiny" ariaLabel="自定义回放轮数，1 到 500"
                      min={1} max={MAX_TURNS} shown={recentTurns > 0 ? String(recentTurns) : ""}
                      onCommit={setRecentTurns} />
                  </div>
                )}
                {turnMode === "pct" && (
                  <div className="pf-set-ctl" role="group" aria-label="按会话轮数百分比">
                    {PCT_PRESETS.map((p) => (
                      <button key={p} type="button" aria-pressed={features.turnPct === p}
                        className={"prof-chip" + (features.turnPct === p ? " on" : "")}
                        onClick={() => setFeatures({ ...features, turnPct: p })}>{p}%</button>
                    ))}
                    <NumField label="自定义" className="pf-comp-tiny" ariaLabel="自定义会话轮数百分比，1 到 100"
                      min={1} max={100} suffix="%" shown={features.turnPct > 0 ? String(features.turnPct) : ""}
                      onCommit={(n) => setFeatures({ ...features, turnPct: n })} />
                  </div>
                )}
              </div>
            </div>
            <div className="pf-set-row">
              <div className="pf-set-label">
                <span title="对话历史最多占多大一块，剩下的留给记忆和回复；和轮数谁先到算谁。">历史占比上限</span>
                {tokenHint && <small className="pf-set-cost">{tokenHint}</small>}
              </div>
              <div className="pf-set-ctl" role="group" aria-label="历史占比上限">
                <button type="button" aria-pressed={features.tokenPct === 0}
                  className={"prof-chip" + (features.tokenPct === 0 ? " on" : "")}
                  onClick={() => setFeatures({ ...features, tokenPct: 0 })}>关</button>
                {PCT_PRESETS.map((p) => (
                  <button key={p} type="button" aria-pressed={features.tokenPct === p}
                    className={"prof-chip" + (features.tokenPct === p ? " on" : "")}
                    onClick={() => setFeatures({ ...features, tokenPct: p })}>{p}%</button>
                ))}
                <NumField label="自定义" className="pf-comp-tiny" ariaLabel="自定义历史占比上限，1 到 100"
                  min={1} max={100} suffix="%" shown={features.tokenPct > 0 ? String(features.tokenPct) : ""}
                  onCommit={(n) => setFeatures({ ...features, tokenPct: n })} />
              </div>
            </div>
          </div>

          {/* 生成设置：这两个旋钮管"怎么说"，与用哪个模型无关，所以单独一张卡 */}
          {!isAssistant && (
            <div className="card card-pad pf-set-card">
              <div className="pf-set-title">生成设置</div>
              <div className="pf-set-row">
                <div className="pf-set-label">
                  <span title="越高越有创意、越低越稳。全局默认 0.8。">温度</span>
                </div>
                <div className="pf-set-ctl" role="radiogroup" aria-label="温度">
                  <button type="button" role="radio" aria-checked={features.temperature === -1}
                    className={"prof-chip" + (features.temperature === -1 ? " on" : "")}
                    onClick={() => setFeatures({ ...features, temperature: -1 })}>跟随全局</button>
                  {TEMP_PRESETS.map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={features.temperature === t}
                      className={"prof-chip" + (features.temperature === t ? " on" : "")}
                      onClick={() => setFeatures({ ...features, temperature: t })}>{t}</button>
                  ))}
                  <NumField label="自定义" className="pf-comp-tiny" ariaLabel="自定义温度，0 到 2"
                    min={0} max={2} precision={1}
                    shown={features.temperature >= 0 && !TEMP_PRESETS.includes(features.temperature) ? String(features.temperature) : ""}
                    onCommit={(n) => setFeatures({ ...features, temperature: n })} />
                </div>
              </div>
              <div className="pf-set-row">
                <div className="pf-set-label">
                  <span title={`这些词${who}会尽量不说。聊天和主动说的话都管；是提醒不是拦截，仍可能说漏。`}>禁用词</span>
                  <small className="pf-set-cost">{bannedCount(features.bannedWords)}/10 个</small>
                </div>
                <div className="pf-set-ctl">
                  <WordChips value={features.bannedWords} ariaLabel="禁用词，逐个添加，最多 10 个"
                    placeholder="输入一个词，回车添加"
                    onChange={(raw) => setFeatures({ ...features, bannedWords: raw })} />
                </div>
              </div>
            </div>
          )}

          {!isAssistant && (
            <div className="card card-pad pf-set-card">
              <div className="pf-set-title"><span>聊天框显示</span></div>
              <div className="pf-set-sub">只决定聊天界面里显不显示。</div>
              <div className="pf-comp-grid">
                {CHAT_DISPLAY_ITEMS.map((item) => (
                  <label key={item.key} className="pf-comp-item" title={item.hint}>
                    <input type="checkbox" checked={features[item.key] === true}
                      onChange={(e) => setFeatures({ ...features, [item.key]: e.target.checked })} />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {!isAssistant && (
            <div className="card card-pad pf-set-card">
              <div className="pf-set-title"><span>工具</span></div>
              <div className="pf-set-sub">能主动做的每件事对应一个工具。带开关的由你决定开不开；标「常开」的一直在。</div>
              <div className="pf-comp-grid">
                {TOOL_ITEMS.map((row) =>
                  row.kind === "toggle" ? (
                    <label key={row.label} className="pf-comp-item" title={row.hint(who)}>
                      <input
                        type="checkbox"
                        checked={features[row.key] === true}
                        onChange={(e) => setFeatures({ ...features, [row.key]: e.target.checked })}
                      />
                      <span className="pf-comp-name">{row.label}</span>
                    </label>
                  ) : (
                    <div key={row.label} className="pf-comp-item" title={row.hint}>
                      <span className="pf-comp-tag">{row.kind === "always" ? "常开" : "在「技能」页"}</span>
                      <span className="pf-comp-name">{row.label}</span>
                    </div>
                  ),
                )}
              </div>

              {features.imageGen && (
                <div className="pf-set-row">
                  <div className="pf-set-label">
                    <span title="画自拍时按这张脸来画；建议正脸、光线清楚，别戴帽子口罩。">长相参考</span>
                  </div>
                  <div className="pf-set-ctl pf-face-ctl">
                    {faceRef !== "" && <img className="pf-face-thumb" src={faceRef} alt="当前长相参考图" />}
                    <button type="button" className="chip" disabled={faceBusy}
                      onClick={() => faceInputRef.current?.click()}>
                      {faceBusy ? "上传中…" : faceRef === "" ? "上传一张" : "换一张"}
                    </button>
                    {faceRef !== "" && (
                      <button type="button" className="chip"
                        onClick={() => { setFaceRef(""); setFaceRefDirty(true); }}>清除</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {!isAssistant && (
            <div className="card card-pad pf-set-card">
              <div className="pf-set-title">
                <span>陪伴能力</span>
                <button type="button" className="pf-ghost" onClick={runConsolidate} disabled={consBusy}>
                  <BookOpen size={13} strokeWidth={1.8} />{consBusy ? "整理中…" : "立即整理记忆"}
                </button>
              </div>
              <div className="pf-set-sub">这些增强默认全关，开哪项由你决定；「记忆提取」一直开着，想关也能关。</div>
              {consNote && <div className="pf-comp-note">{consNote}</div>}

              <div className="pf-comp-grid">
                {FEATURE_ITEMS.map((item) => (
                  <label key={item.key} className="pf-comp-item" title={item.hint(who)}>
                    <input
                      type="checkbox"
                      checked={features[item.key] === true}
                      onChange={(e) => setFeatures({ ...features, [item.key]: e.target.checked })}
                    />
                    <span className="pf-comp-name">{item.label}</span>
                  </label>
                ))}
              </div>

              <div className="pf-set-row">
                <div className="pf-set-label">
                  <span title={`${who}每天最多主动开口几次；跟随默认走全局主动性配置。`}>每日主动上限</span>
                </div>
                <div className="pf-set-ctl" role="radiogroup" aria-label="每日主动上限">
                  {[
                    { v: 0, t: "跟随默认" },
                    { v: 1, t: "1 次" },
                    { v: 2, t: "2 次" },
                    { v: 3, t: "3 次" },
                    { v: 5, t: "5 次" },
                  ].map((o) => (
                    <button key={o.v} type="button" role="radio" aria-checked={features.dailyLimit === o.v}
                      className={"prof-chip" + (features.dailyLimit === o.v ? " on" : "")}
                      onClick={() => setFeatures({ ...features, dailyLimit: o.v })}>{o.t}</button>
                  ))}
                </div>
              </div>

              <div className="pf-set-row pf-set-col">
                <div className="pf-set-label">
                  <span title={`${who}会据此说「我刚到家」这类有生活感的话。`}>{who}的作息（可选）</span>
                </div>
                <textarea
                  className="pf-comp-input"
                  aria-label="作息"
                  rows={2}
                  maxLength={120}
                  placeholder="例：朝九晚六上班，晚上十点到家；习惯午休半小时；周日睡懒觉"
                  value={features.schedule}
                  onChange={(e) => setFeatures({ ...features, schedule: e.target.value })}
                />
              </div>

              <div className={`pf-set-row pf-set-col${features.lifeline ? "" : " pf-comp-off"}`}>
                <div className="pf-set-label">
                  <span>生活线摘要</span>
                  <small>{features.lastConsolidatedAt
                    ? `上次整理：${new Date(features.lastConsolidatedAt).toLocaleDateString()} · 由「记忆整理」生成，也能自己写`
                    : "还没整理过 · 由「记忆整理」生成，也能自己写"}</small>
                </div>
                <textarea
                  className="pf-comp-input"
                  aria-label="生活线"
                  rows={3}
                  maxLength={400}
                  disabled={!features.lifeline}
                  placeholder={`${who}每轮都会带着这段话。`}
                  value={lifeline}
                  onChange={(e) => setLifeline(e.target.value)}
                />
              </div>

              <div className={`pf-set-row pf-set-col${features.recap ? "" : " pf-comp-off"}`}>
                <div className="pf-set-label">
                  <span title="更早的对话会自动压成这段摘要 · 也能自己写">窗口边缘梗概</span>
                </div>
                <textarea
                  className="pf-comp-input"
                  aria-label="对话梗概"
                  rows={3}
                  maxLength={200}
                  disabled={!features.recap}
                  placeholder={features.recap ? "还没攒够一批旧对话，梗概会在聊天后台自动出现。" : "打开开关后自动维护。"}
                  value={recap}
                  onChange={(e) => setRecap(e.target.value)}
                />
              </div>

              <div className={`pf-set-row${features.bond ? "" : " pf-comp-off"}`}>
                <div className="pf-set-label">
                  <span title={`阶段 / 亲密度（0~100）/ ${who}此刻的情绪`}>关系温度计</span>
                </div>
                <div className="pf-set-ctl pf-bond-row">
                  <input
                    className="pf-comp-input pf-comp-small"
                    aria-label="关系阶段"
                    maxLength={24}
                    placeholder="阶段（如 熟悉/暧昧/热恋）"
                    disabled={!features.bond}
                    value={bond.stage}
                    onChange={(e) => setBond({ ...bond, stage: e.target.value })}
                  />
                  <input
                    className="pf-comp-input pf-comp-tiny"
                    type="text" inputMode="numeric"
                    aria-label="亲密度，0 到 100"
                    title="亲密度 0~100"
                    disabled={!features.bond}
                    placeholder="0~100"
                    value={String(bond.warmth)}
                    onChange={(e) => setBond({ ...bond, warmth: Math.min(100, Math.max(0, Number(e.target.value.replace(/[^\d]/g, "")) || 0)) })}
                  />
                  <input
                    className="pf-comp-input pf-comp-small"
                    aria-label={who + "此刻的情绪"}
                    maxLength={24}
                    placeholder={`${who}此刻的情绪`}
                    disabled={!features.bond}
                    value={bond.mood}
                    onChange={(e) => setBond({ ...bond, mood: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          {!isAssistant && devMode && (
            <div className="card card-pad pf-set-card">
              <div className="pf-set-title">
                <span>提示词预览</span>
                <button type="button" className="pf-ghost" disabled={previewing} onClick={runPromptPreview}>
                  {previewing ? "拼装中…" : "预览发送时的提示词"}
                </button>
              </div>
              <div className="pf-set-sub">
                看看该联系人下一轮实际会收到的内容：人设是还没保存的当前草稿；记忆按你最后一句话真实回想起来的部分。
              </div>
              {promptPreview && (
                <>
                  {promptPreview.memoryNote && <div className="pf-comp-note">{promptPreview.memoryNote}</div>}
                  <div className="preview show">
                    <div className="label">① 人设与规则（每轮都带）</div>
                    <pre>{promptPreview.prompt}</pre>
                  </div>
                  {(promptPreview.history?.length ?? 0) > 0 && (
                    <div className="preview show">
                      <div className="label">② 最近对话（{promptPreview.history!.length} 条）</div>
                      <pre>
                        {promptPreview.history!.map((h) => `${h.role === "user" ? "你" : who}：${h.text}`).join("\n")}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {mode === "edit" && (visitedPages.has("memory") || page === "memory") && (
        <TabPanel active={page === "memory"} aria={pagePanelFor("memory")}>
          <MemoryPanel panel={{}} active={page === "memory"} contactId={contactId} who={who} />
        </TabPanel>
      )}
      {mode === "edit" && (visitedPages.has("proactive") || page === "proactive") && (
        <TabPanel active={page === "proactive"} aria={pagePanelFor("proactive")}>
          <ProactivePanel panel={{}} active={page === "proactive"} contactId={contactId} who={who} />
        </TabPanel>
      )}
      {mode === "edit" && (visitedPages.has("gallery") || page === "gallery") && (
        <TabPanel active={page === "gallery"} aria={pagePanelFor("gallery")}>
        <ContentLibraryPanel panel={{}} active={page === "gallery"} contactId={contactId} who={who} faceRef={faceRef}
          onFaceRefChanged={(url) => {
            // 服务端已经落库了，所以只同步显示、不标脏：标了脏会让底部出现"有未保存的修改"，
            // 而 formPayload 本来就不带 faceRef（未 dirty），基线对不上反而更误导。
            setFaceRef(url);
            setFaceRefDirty(false);
          }} />
        </TabPanel>
      )}

      {/* 身份卡在四个分区都可编辑，保存入口因此跟着脏值走而不是跟着分区走：
          在「记忆/主动性」里换头像也会浮出这条，平时不占位、不会被误读成保存记忆条目。 */}
      {(dirty || savedFlash) && (
        <div className="pf-dock">
          <span className={"pf-dock-note" + (dirty ? "" : " ok")} role="status">
            {dirty ? (mode === "create" ? "尚未创建" : "有未保存的修改") : "已保存"}
          </span>
          <button type="button" className="pf-save" disabled={saving || !loaded || !dirty} onClick={save}>
            <Save size={14} strokeWidth={1.9} />{saving ? "保存中…" : "保存"}
          </button>
        </div>
      )}

      {/* 没保存就离开：这是这套界面唯一会把人写过的字丢掉的路径（页内返回按钮与系统返回键
          都汇到 onBack），所以拦在返回这一下，而不是只在底部挂一句常驻的「有未保存的修改」。 */}
      {confirmLeave && (
        <Modal label="放弃未保存的修改？" onClose={() => setConfirmLeave(false)}>
          <div className="del-title">放弃未保存的修改？</div>
          <div className="del-note">
            {mode === "create"
              ? "这位联系人还没创建，退出后刚填的内容不会留下。"
              : "这次改动还没保存，退出后回到上一次保存的样子。对话与记忆不受影响。"}
          </div>
          <div className="del-row">
            <button type="button" className="primary" onClick={() => setConfirmLeave(false)}>继续编辑</button>
            <button type="button" className="danger" onClick={() => { setConfirmLeave(false); onBack(); }}>放弃并返回</button>
          </div>
        </Modal>
      )}

      {confirmResetCard && (
        <Modal label="换回默认人设？" onClose={() => setConfirmResetCard(false)}>
          <div className="del-title">换回默认人设？</div>
          <div className="del-note">
            {mode === "create"
              ? "背景、人设、与用户关系三段会填成应用出厂那份，名字、头像、性别都不受影响。还没创建，触点底部的「保存」之前都还能改。"
              : "背景、人设、与用户关系三段立刻换成应用出厂那份并直接保存——这一步不像底部的「保存」那样能不落库地撤掉。名字、头像、性别、陪伴能力开关都不受影响。"}
          </div>
          <div className="del-row">
            <button type="button" onClick={() => setConfirmResetCard(false)}>取消</button>
            <button type="button" className="danger" disabled={resetting} onClick={runResetCard}>换回默认</button>
          </div>
        </Modal>
      )}

      {confirmTemplate && (
        <Modal label="覆盖现有的人格设定？" onClose={() => setConfirmTemplate(false)}>
          <div className="del-title">覆盖现有的人格设定？</div>
          <div className="del-note">背景、人设、与用户关系三段会整组换成示例模板，你写的版本被替换掉。保存之前还能靠不退出找回。</div>
          <div className="del-row">
            <button type="button" onClick={() => setConfirmTemplate(false)}>取消</button>
            <button type="button" className="primary" onClick={applyTemplate}>用模板覆盖</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
