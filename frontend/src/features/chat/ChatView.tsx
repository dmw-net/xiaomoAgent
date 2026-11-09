import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowDown, BellRing, Archive, BookOpen, CalendarCheck, Check, ChevronDown, ChevronLeft, ChevronUp, Cpu, FileDown, ImagePlus, Loader2, MapPinned as MapIcon, Mic, MoreHorizontal, Palette, Pencil, RotateCcw, Search, Smile, Square, X } from "lucide-react";
import { ApiError, chatApi, contactsApi, memoryApi, proactiveApi, settingsApi } from "../../api";
import { refreshContacts } from "../../lib/contactsStore";
import { DATA_WIPED_EVENT, SETTINGS_CHANGED_EVENT } from "../../lib/ui-prefs";
import { CAPS_OFF, cachedCaps, loadCaps, type Caps } from "../../lib/capsStore";
import OnboardingChecklist from "../onboarding/Checklist";
import { exportPersonaMd } from "../../lib/persona-doc";
import { dayLabel, dayTimeLabel, dayOf, clockOf } from "../../lib/datetime";
import { fmtTokens } from "../../lib/format";
import { profilePicks, providerLabel } from "../../lib/providers";
import { blobToDataUrl, fileToImageBlob } from "../../lib/image";
import { CLOCK_EVENT, getClockPref, getShowTokensPerSec, CHAT_SPEED_EVENT, getShowTtsButton, CHAT_TTS_EVENT, type ClockPref } from "../../lib/ui-prefs";
import { offerUndo } from "../../lib/undo";
import { isBusConnected, onBusEvent } from "../../lib/eventBus";
import { enqueueOutbox, flushOutbox, outboxForContact, subscribeOutbox } from "../../lib/outbox";
import { useDismiss } from "../../hooks/useDismiss";
import { useAnchoredPop } from "../../hooks/useAnchoredPop";
import { useExitVisible } from "../../hooks/useExitVisible";
import { useLiveReveal } from "../../hooks/useLiveReveal";
import { useNotices } from "../../hooks/useNotices";
import { CHAT_RESIZE_EVENT } from "../../hooks/useResizeSignal";
import { stopExclusiveAudio, playExclusiveAudio } from "../../lib/audioBus";
import Avatar from "../../components/Avatar";
import EmotePicker from "../../components/EmotePicker";
import { avatarToneStyle } from "../../lib/avatar-tone";
import MessageMenu, { type MenuState } from "./MessageMenu";
import Modal from "../../components/Modal";
import MessageRowItem from "./MessageRow";
import VoiceMessageBubble from "../../components/VoiceMessageBubble";
import ToolCard from "./ToolCard";
import ThinkingBlock, { ThinkingLive } from "./ThinkingBlock";
import ChatMap, { type ChatMapNode } from "./ChatMap";
import ConversationSwitcher from "./ConversationSwitcher";
import { PENDING_TTL_MS, PROACTIVE_GAP_MS, PULL_IDLE_STEPS, PULL_INTERVAL_MS, TURN_WATCH_MAX_TRIES, WATCH_PULL_EVERY } from "./constants";
import { THINKING_LEVEL_LABELS, type ContactConversationItem, type ContextUsage, type MessageAttachmentMeta, type MessageRow, type ThinkingControl, type ThinkingQuickChoice } from "../../types";
import { MAX_CHAT_IMAGES } from "../../../../shared/limits";

type Pending = { text: string; at: number; imgs: string[]; localId: string; turnId?: string; failed?: boolean; queued?: boolean; outbox?: boolean; voice?: MessageAttachmentMeta };
type ModelOption = { value: string; label: string; detail: string; provider: string };

/** 会丢掉或重写已有内容的聊天动作，一律先经过同一个确认框。 */
type PendingChatConfirm =
  | { kind: "edit-switch"; m: MessageRow; textOnly: boolean }
  | { kind: "regenerate"; m: MessageRow }
  | { kind: "retract"; m: MessageRow };

/** 消息流的渲染节点：普通消息之间插日分隔；时间戳落在气泡内，不再占独立行。 */
type ListNode =
  /* day：daysep 的 React key 用日期串而不是 label——「今天」这类相对称呼跨页拼接
     （载入更早 / 搜索窗口合并）后列表里可能出现两条同 label 的分隔，label 做 key
     会撞；日期串在同一帧构建里天然唯一（只在跨天时推入），时钟偏好切换时也更稳。 */
  | { t: "daysep"; label: string; day: string }
  | { t: "msg"; m: MessageRow; gap: boolean; clock?: string }
  | { t: "tool"; m: MessageRow }
  | { t: "pending"; id: string; text: string; imgs: string[]; voice?: MessageAttachmentMeta; gap: boolean; failed?: boolean; queued?: boolean }
  | { t: "stale"; items: MessageRow[] }
  | { t: "draft" }
  | { t: "intro" };

/** 会话消息的模块级种子缓存：视图重挂载（切 tab / 换工作区）先画上一帧，
    拉全量在后台覆盖——去掉「白屏一下再弹回底部」的抖动。 */
const msgsSeed = new Map<string, MessageRow[]>();

/** 种子缓存容量。Map 的迭代顺序即插入顺序，先删再插等于 LRU。 */
const SEED_MAX = 5;

/** 「已经到最早了」提示的最低加载量。首屏一页就是几百条（后端 CHAT_FIRST_PAGE=500，
 *  「载入更早」一页 200，同一量级取 200）：不到这个量说明会话本身就短、用户没翻过页，
 *  顶部挂这句纯属占地方——新会话发完第一句顶上就写着"已经到最早了"，像句废话。
 *  超过它才值得说破"上面真的没有了"。 */
const EARLIEST_HINT_MIN_ROWS = 200;
/** 上下文各分量的白话名：后端给的是「系统提示词 / 记忆召回」这类内部词，界面换成用户能看懂的说法。 */
const CTX_PART_LABEL: Record<string, string> = {
  system: "联系人的人设与规则",
  memory: "想起来的往事",
  tools: "联系人的工具",
  history: "最近对话",
  images: "图片处理",
};
function rememberMsgs(key: string, rows: MessageRow[]): void {
  msgsSeed.delete(key);
  msgsSeed.set(key, rows);
  while (msgsSeed.size > SEED_MAX) {
    const oldest = msgsSeed.keys().next().value;
    if (oldest === undefined) break;
    msgsSeed.delete(oldest);
  }
}

/** 两条消息行内容是否完全一样（附件是解析出来的数组，只能逐项比）。 */
function sameRow(a: MessageRow, b: MessageRow): boolean {
  const aa = a.attachments ?? [];
  const ba = b.attachments ?? [];
  return a.text === b.text && a.role === b.role && a.kind === b.kind
    && a.created_at === b.created_at && a.turn_id === b.turn_id
    && a.superseded_at === b.superseded_at && a.superseded_kind === b.superseded_kind
    && (a.variant_index ?? 0) === (b.variant_index ?? 0)
    && (a.variant_count ?? 0) === (b.variant_count ?? 0)
    && aa.length === ba.length && aa.every((x, i) => x === ba[i]);
}

/**
 * 全量重绘时按 id 沿用内容没变的行。
 *
 * 整表替换给每一行都是新对象引用，`MessageRow` 的 memo 一次性被击穿，
 * 500 行气泡全要重跑一遍 renderMd —— 实测一次重答收尾的"闪"，成本主要就在
 * 这一次换引用，而不是网络。行内容真的变了（重答就地改写那一行）才会换新引用。
 */
function reuseRows(oldRows: MessageRow[], next: MessageRow[]): MessageRow[] {
  if (oldRows.length === 0) return next;
  const byId = new Map(oldRows.map((r) => [r.id, r] as const));
  return next.map((r) => {
    const o = byId.get(r.id);
    return o && sameRow(o, r) ? o : r;
  });
}

/**
 * 按 id 合并新旧两批，保留 old 里 next 没有的行。
 *
 * 为什么不能整体替换：`all=1` 只回最新 CHAT_FIRST_PAGE 条，而「载入更早的消息」
 * 是用 `before=` 一页页往前翻的——翻过头的那些行不在最新一页里，换掉就等于丢掉。
 * 表现是编辑任意一条消息之后，用户从第 1 条被瞬移到第 800 条，olderLeft 也跟着变大。
 * 顺序按 id 排（消息表以自增 id 当时间轴，reuseRows 那套"内容相同就复用旧对象"
 * 的省渲染技巧在这里照样用得上）。
 */
function mergeRows(oldRows: MessageRow[], next: MessageRow[]): MessageRow[] {
  if (oldRows.length === 0) return next;
  const kept = new Map(oldRows.map((r) => [r.id, r] as const));
  for (const r of next) {
    const o = kept.get(r.id);
    kept.set(r.id, o && sameRow(o, r) ? o : r);
  }
  return [...kept.values()].sort((a, b) => a.id - b.id);
}

/**
 * 全量页（`?all=1` 的最新一页快照）专用合并：按 id 去重沿用旧对象之外，还要**丢幽灵行**。
 *
 * 本地列表里 id ≥ 本页最小 id、却不在本页里的行，服务端一定已经不存在——全量页是
 * `ORDER BY id DESC LIMIT N` 的原样快照，窗口内一行不漏，缺席只能意味着被删了
 * （重答/打断对旧气泡的硬删除、另一台设备的删除）。这些行若不丢，就会在「操作后
 * POST 还在飞就切走了联系人」的窗口里被种子缓存记住——切回来时 mergeRows 的只增不删
 * 把它们原地复活，和新回复并存，之后任何轮询都清不掉，只能刷新页面。
 * 丢的判据必须只用于全量页：增量拉取（pullOnce）传进来的只是新增小批，最小 id 之上
 * 不在批里的行大都是正常历史，照这个规则丢就把会话砍没了。
 * 「载入更早」翻过的页 id 都比本页最小 id 小，天然落在保留区，不受影响。
 */
function mergeRowsFullPage(oldRows: MessageRow[], next: MessageRow[]): MessageRow[] {
  if (oldRows.length === 0) return next;
  if (next.length === 0) return next; // 服务端真的一条不剩：本地这些全是幽灵，一并丢掉
  const byId = new Map(next.map((r) => [r.id, r] as const));
  const minNextId = Math.min(...next.map((r) => r.id));
  for (const r of oldRows) {
    if (r.id < minNextId && !byId.has(r.id)) byId.set(r.id, r);
  }
  // 内容相同沿用旧对象（reuseRows 同一套省渲染）；内容变了以新对象为准。
  const oldById = new Map(oldRows.map((r) => [r.id, r] as const));
  return [...byId.values()].sort((a, b) => a.id - b.id).map((r) => {
    const o = oldById.get(r.id);
    return o && sameRow(o, r) ? o : r;
  });
}

/**
 * 正在打的字按会话留着（微信口径）：换联系人以前会连草稿一起吞掉，
 * 因为会话页按联系人 key 挂载，重挂载就把输入框打回空。
 *
 * 只存文字、不存待发图片：没发出去的图在 /api/media 里属于孤儿，
 * sweepOrphanMedia 满 24 小时无引用就删，留回来只剩个碎图占位。
 * 容量按插入顺序淘汰（助手工作区的线程 id 是不可数的，得有个顶）。
 */
const draftSeed = new Map<string, string>();
function rememberDraft(key: string, text: string): void {
  if (key === "") return;
  if (text === "") { draftSeed.delete(key); return; }
  draftSeed.delete(key);
  draftSeed.set(key, text);
  while (draftSeed.size > 20) {
    const oldest = draftSeed.keys().next().value;
    if (oldest === undefined) break;
    draftSeed.delete(oldest);
  }
}

/**
 * 会话内记住的阅读位置（切走时视口顶部压着的锚点行 + 它到容器顶的像素偏移）。
 * 与 draftSeed 同一生命周期口径：只活在本次应用会话里，重启后回到最新消息。
 *
 * 为什么存「锚点行」而不是 scrollTop 绝对值：切走再切回来是整实例重挂载（key 换人），
 * 消息要重新拉取，拉取条数、图片占位都会让绝对像素失配；锚点行定位（scrollIntoView
 * / 矩形差补偿）不依赖 scrollHeight 的绝对值，行还没按真实高度布局时也准——
 * 也一样准——浏览器会先把目标行变相关、渲染出真实高度再算滚动位置。
 * 本来就贴着底切走的（绝大多数情况）不存记录，回来照旧落底，旧契约不变。
 */
type SavedReadPos = { anchorId: number; offset: number };
const readPosSeed = new Map<string, SavedReadPos>();
function rememberReadPos(key: string, pos: SavedReadPos | null): void {
  if (key === "") return;
  if (pos === null) { readPosSeed.delete(key); return; }
  readPosSeed.delete(key);
  readPosSeed.set(key, pos);
  while (readPosSeed.size > 12) {
    const oldest = readPosSeed.keys().next().value;
    if (oldest === undefined) break;
    readPosSeed.delete(oldest);
  }
}

/**
 * 录音态的实时音量波形（composer 里那条细长条）。
 *
 * 数据不另采：startRecording 已经在用 AudioContext + AnalyserNode 按 120ms 一拍把
 * 归一化 RMS 推进 recWaveRef——正是发语音时存进 meta.waveform 的那份数据。这里只做
 * 重画，composer 上的波形等于是「将要发出去的语音波形」的实时预览：两份数据天然一致，
 * 也不会出现第二套采集口径。
 *
 * 视觉纪律：单色 var(--accent)，历史条向左渐隐、最新一帧恒在最右，不做彩色频谱。
 *
 * prefers-reduced-motion 的取舍：选「低频更新」而不是整条隐藏。彻底砍掉会把录音中
 * 唯一的连续反馈也带走（只剩红点+秒数，信息量倒退）；降级成 500ms 一拍的重画——
 * 离散跳变、无滑移无闪烁节奏，与 .spin 退让成慢呼吸是同一先例。两条路各自建帧/清帧，
 * 卸载即 cancel，不泄漏 rAF。
 */
function RecWaveMeter({ active, samplesRef }: {
  active: boolean;
  /** 已在采的音量历史（ChatView 的 recWaveRef），120ms 一拍，0.1..1。 */
  samplesRef: RefObject<number[]>;
}): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 初始值读一次即可；运行中系统切换 reduce 档位是极小概率事件，监听一遍成本也不高。
  const [reduced, setReduced] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let timer = 0;
    const draw = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const samples = samplesRef.current;
      if (!samples || samples.length === 0) return;
      // 3px 条 + 1px 缝：宽度自适应剩多少空间就画多少根，历史按 120ms 一帧回放。
      const slot = 4;
      const count = Math.max(1, Math.floor(w / slot));
      const visible = samples.slice(-count);
      // 强调色是运行时变量（用户可换 accent），canvas 读不到 CSS 变量，每帧从计算样式取。
      const color = getComputedStyle(canvas).getPropertyValue("--accent").trim();
      if (color === "") return;
      ctx.fillStyle = color;
      const mid = h / 2;
      for (let i = 0; i < visible.length; i++) {
        const level = Math.min(1, Math.max(0.06, visible[i] ?? 0));
        // 平方渐隐：越老的帧退得越快，视觉重心始终压在最新一拍上。
        const age = (i + 1) / visible.length;
        ctx.globalAlpha = 0.14 + 0.86 * age * age;
        const barH = Math.max(2, level * (h - 4));
        ctx.fillRect(w - (visible.length - i) * slot, mid - barH / 2, slot - 1, barH);
      }
      ctx.globalAlpha = 1;
    };
    if (reduced) {
      draw();
      timer = window.setInterval(draw, 500);
    } else {
      const loop = (): void => { draw(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    return () => { cancelAnimationFrame(raf); window.clearInterval(timer); };
  }, [active, reduced, samplesRef]);

  if (!active) return null;
  // 纯装饰：录音状态已由 rec-state 的文字与红点向读屏通报，画布对辅助技术静默。
  return <canvas ref={canvasRef} className="rec-wave" aria-hidden="true" />;
}

export default function ChatView({ characterName, ownerName, ownerAvatar, contactAvatar, onSwitchContact, contactIdOverride, conversationId, conversationTitle, readOnly = false, onOpenLocal, conversations = [], onOpenConversation, introChip, onBack, onEditProfile, onOpenSection, onOpenModelSettings, onOpenOnboarding, onContactArchived, msgScope, focusMessageId, onFocusHandled, onStatus, paused , showThinking = true, showTools = true, imageGenOn = false, streamReveal = true, composerAccessory }: {
  characterName: string;
  ownerName: string;
  ownerAvatar: string;
  contactAvatar: string;
  /** 当前联系人的中文代词。 */
  /** 只用来在「选中的联系人已经被删掉」时切回默认会话——顶栏那颗切人芯片早已不在这里渲染
   *  （窄屏给的是返回钮，宽屏侧栏就在旁边），所以不再收 onOpenContacts。 */
  onSwitchContact?: (id: string) => void;
  /** 助手工作区：会话按派生联系人 id 隔离，不走全局当前联系人。 */
  contactIdOverride?: string;
  /** QQ 群会话 id；空 = 联系人主私聊（应用/微信/QQ 私聊共用）。 */
  conversationId?: string;
  conversationTitle?: string;
  /** 平台会话只读：输入框隐藏，禁止把它当成群成员发言。 */
  readOnly?: boolean;
  /** 从平台会话切回联系人本地对话。 */
  onOpenLocal?: () => void;
  /** 当前联系人名下的全部会话；有 QQ 来源时在顶栏显示来源切换器。 */
  conversations?: ContactConversationItem[];
  /** 在联系人内部切换上下文：null = 主私聊，字符串 = QQ 群。 */
  onOpenConversation?: (conversationId: string | null, title?: string, readOnly?: boolean) => void;
  /** 空会话引导里的第一个示例问句。 */
  introChip?: string;
  /** 窄屏双页流：给了就在顶栏显示「←」返回列表，而不是联系人切换芯片。 */
  onBack?: () => void;
  /** 顶栏「⋯」菜单里的编辑资料入口（助手线程不给）。 */
  onEditProfile?: () => void;
  /** 打开联系人资料页的记忆 / 主动性分区（「⋯」菜单与空态链接）。 */
  onOpenSection?: (page: "memory" | "proactive") => void;
  /** 上下文提示里的「去设置」：跳到设置页的「主对话模型」并展开高级参数。
   *  带 profileId 时直接落到那一档——同名的档不止一个（hy3 / 本地中转 · agent2api/hy3），
   *  只送到列表等于让人自己认门。 */
  onOpenModelSettings?: (profileId?: string) => void;
  /** 空态清单上的「继续设置」：打开首次设置弹窗。 */
  onOpenOnboarding?: () => void;
  /** 从「⋯」归档成功后的收尾（切回默认联系人/列表），不给就只刷新列表。 */
  onContactArchived?: () => void;
  /** 消息种子缓存的命名空间（联系人 id / 助手线程 id）。 */
  msgScope?: string;
  /** 从全局搜索点进来的那条消息：滚到它并闪一下。 */
  focusMessageId?: number | null;
  onFocusHandled?: () => void;
  /** 弹窗宿主（助手）把会话状态搬进自己的头部；这里只回吐，不改变自身渲染。 */
  onStatus?: (text: string, tone: string) => void;
  /** 宿主把本会话收进了 display:none 的层里（关掉的助手弹窗）。看不见就别打后端。 */
  paused?: boolean;
  /** 聊天框显示开关（按联系人，来自资料页「对话设置」）：纯显示，数据照旧落库。 */
  showThinking?: boolean;
  showTools?: boolean;
  /** 这个联系人开没开「图像生成」。和 caps.imageGeneration 同时为真才露出「画一张」。 */
  imageGenOn?: boolean;
  /** 流式渲染：开着才逐字追字显示草稿；关着（默认）只挂「正在输入」到整条弹出。助手弹窗不传=按开处理。 */
  streamReveal?: boolean;
  /** 宿主放进输入区底栏的专属控件（目前只有设置助手的权限 chip）。 */
  composerAccessory?: ReactNode;
}): JSX.Element {
  const cid = contactIdOverride;
  const cacheKey = (msgScope ?? cid ?? "") + (conversationId ? ":" + conversationId : ":local");
  const hasGroupSources = conversations.some((conv) => conv.channel === "qq" && conv.kind === "group");
  // 发言人昵称只在群聊有意义；私聊是 1v1，连模型上下文里都不该带「[某某]」前缀。
  const isGroupChat = conversations.find((conv) => conv.id === conversationId)?.kind === "group";
  const [msgs, setMsgs] = useState<MessageRow[]>(() => msgsSeed.get(cacheKey) ?? []);
  /**
   * 新消息入场动效的判定。
   *
   * 时间轴就是自增 id：上一帧见过的最大 id 与这一帧的差值，正是"刚追加进来"的那几条。
   * 首帧（含切联系人重挂载）只把最大 id 记成基线、一条都不动 —— 否则一屏几百条会集体弹一下；
   * 往前翻历史拿到的是更小的 id，同样落在判定之外。
   * 只给联系人的回复/主动消息做入场：我自己那句话的入场由乐观气泡（pending）负责，
   * 真消息认领回来时再播一遍就是同一个位置闪两下。
   */
  const seenMaxIdRef = useRef<number | null>(null);
  const enterIdsRef = useRef<Map<number, number>>(new Map());
  {
    const last = msgs[msgs.length - 1];
    const maxId = last ? last.id : 0;
    const base = seenMaxIdRef.current;
    if (base !== null && base > 0 && maxId > base) {
      let seq = 0;
      for (const m of msgs) {
        if (m.id > base && m.role !== "user") {
          enterIdsRef.current.set(m.id, Math.min(seq * 45, 135));
          seq += 1;
        }
      }
    }
    seenMaxIdRef.current = base === null ? maxId : Math.max(base, maxId);
  }
  /** 视口是否贴在底部：决定「回到消息底部」那颗钮要不要出现（微信式）。 */
  const [atBottom, setAtBottom] = useState(true);
  /** 离开底部那一刻看到的最大行号：它之后进来的就是"下面还有几条没看"。 */
  const bottomIdRef = useRef(0);
  const [pendings, setPendings] = useState<Pending[]>([]);
  // 气泡时间偏好（设备级，设置→界面 里改）：事件驱动即时重排，不用刷新
  const [clockPref, setClockPrefState] = useState<ClockPref>(getClockPref);
  useEffect(() => {
    const sync = (): void => setClockPrefState(getClockPref());
    window.addEventListener(CLOCK_EVENT, sync);
    return () => window.removeEventListener(CLOCK_EVENT, sync);
  }, []);
  // 生成速度（t/s）显示开关（设备级，同在「聊天显示」里改）
  const [speedOn, setSpeedOn] = useState<boolean>(getShowTokensPerSec);
  useEffect(() => {
    const sync = (): void => setSpeedOn(getShowTokensPerSec());
    window.addEventListener(CHAT_SPEED_EVENT, sync);
    return () => window.removeEventListener(CHAT_SPEED_EVENT, sync);
  }, []);
  // 气泡 🔊 播放按钮显示开关（设备级，同在「聊天显示」里改；只管显示，不动语音能力）
  const [ttsBtnOn, setTtsBtnOn] = useState<boolean>(getShowTtsButton);
  useEffect(() => {
    const sync = (): void => setTtsBtnOn(getShowTtsButton());
    window.addEventListener(CHAT_TTS_EVENT, sync);
    return () => window.removeEventListener(CHAT_TTS_EVENT, sync);
  }, []);
  const { notices, addNotice, dropNotices } = useNotices();
  const [typing, setTyping] = useState(false);
  /**
   * 流式草稿：联系人正在写的这一句（后端把累计正文按 200ms 节流写进 turns.reply，
   * 这一拍本来就随 watch 的 /api/turn 轮询回来，不额外发请求）。
   * 空串=没有草稿，气泡维持三个点：echo 模式、非流式回退、工具轮都是这一支。
   * 名字别叫 draft——那是输入框里**用户**的草稿（见下面 line 160）。
   */
  const [streamText, setStreamText] = useState("");
  /** 这一轮的实时思考草稿：与正文分两列落库，确保思考先到、正文开始时也不会被抹掉。 */
  const [streamReasoning, setStreamReasoning] = useState("");
  /** 按轮次保存思考展开态：草稿气泡切到定稿气泡时沿用同一个值，不自动收起。 */
  const [thinkingOpenTurns, setThinkingOpenTurns] = useState<Record<string, boolean>>({});
  const setThinkingOpen = useCallback((turnId: string, open: boolean): void => {
    setThinkingOpenTurns((prev) => prev[turnId] === open ? prev : { ...prev, [turnId]: open });
  }, []);
  /** 当前这份草稿属于哪一轮：本轮真气泡已取回、且逐字揭示完成后，草稿才退场。 */
  const draftTurnRef = useRef<string | null>(null);
  /** 本轮的真气泡是否已经被某一拍轮询取回。 */
  const draftHasBubble = draftTurnRef.current !== null && msgs.some((m) =>
    m.role === "assistant" && m.kind === "chat" && m.turn_id === draftTurnRef.current);
  /**
   * 逐字揭示必须活到目标文本全部显完。单条模式里后端会先把定稿气泡落库、下一拍才把
   * turn 标成 done；若只按“气泡上屏”就撤草稿，用户会看到打字打到一半突然被整段替换。
   * 开着逐字时，等 typing 结束且 reveal.done 才让真气泡接手；分条模式不显示草稿，
   * 仍按原来的 450ms 一条条出现。
   */
  const reveal = useLiveReveal(streamText, streamText !== "");
  const draftRetired = draftHasBubble && (!streamReveal || (!typing && reveal.done));
  const draftLive = (typing || streamText !== "" || streamReasoning !== "") && !draftRetired;
  /** 只有真的在逐字显示正文时才隐藏同轮定稿气泡，三个点阶段不受影响。 */
  const draftTyping = streamReveal && streamText !== "" && draftLive;
  const draftShown = reveal.text;
  const [busy, setBusy] = useState(false);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  /** 首次设置走完没有。默认 true：老用户不该在第一次轮询回来之前先看见那张清单闪一下。 */
  const [onboardingDone, setOnboardingDone] = useState(true);
  /** 人设还是出厂那份：跟着那一趟轮询回来，清单据此决定「改改人设」这行算不算完成。 */
  const [personaIsDefault, setPersonaIsDefault] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  /** 最新一轮没回上来的横幅状态。empty = 轮子 done 了却一条回复气泡都没有（模型回了空）：
   *  失败重试那条路后端对 done 轮是拒收的，重试入口得换「重新生成」。 */
  const [failure, setFailure] = useState<{ id: string; error: string | null; empty?: boolean } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 删除的二次确认：微信式居中弹窗（菜单只留短标签，说明文字放这里）。
  const [delTarget, setDelTarget] = useState<MessageRow | null>(null);
  // 切编辑目标、重新生成、撤回共用同一张确认框：菜单只负责发起，不再点一下就直接改数据。
  const [pendingConfirm, setPendingConfirm] = useState<PendingChatConfirm | null>(null);
  // 会话内搜索：只搜当前联系人，命中后按窗口跳转。
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<MessageRow[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [searchFocusId, setSearchFocusId] = useState<number | null>(null);
  const searchSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchJumpRef = useRef<(m: MessageRow) => void>(() => {});
  // 词高亮只描命中的行：与计数、↑↓ 跳转共用同一份 searchHits，看到的 mark 数和「n/m」对得上。
  const searchHitIds = useMemo(() => new Set(searchHits.map((h) => h.id)), [searchHits]);
  /** 搜索/地图跳转命中的那一条：一次只挂一个脉冲（行 + 定时器），连跳下一条时
      先摘旧的再挂新的，定时器只留最新一个——不然快速 ↓ 连跳会漏下一堆计时器。 */
  const hitPulseRef = useRef<{ row: HTMLElement; timer: number } | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapActiveId, setMapActiveId] = useState<number | null>(null);
  const mapRafRef = useRef<number | null>(null);
  const [draft, setDraft] = useState<string>(() => draftSeed.get(cacheKey) ?? "");
  /** 「画一张」是勾选态而不是即发：勾上=下一条消息带上配图意图，Enter/发送才真出去。 */
  const [drawArmed, setDrawArmed] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  // 编辑自己消息时的图片：可删可换。之前编辑框只有文字，带图的消息一进编辑态图就"消失"，
  // 保存后虽然还在但用户全程看不见也改不了——「删除图片换新图片」无路可走。
  const [editImgs, setEditImgs] = useState<string[]>([]);
  /** 编辑自己的话有两种后果：只改文字（后面原样保留）/ 改完从这里重开。菜单决定，这里记住。 */
  const [editTextOnly, setEditTextOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** 待恢复的阅读位置：boot 拉到消息时挂进来，由 loaded 翻真那一拍的 layout effect 消费一次。 */
  const restoreRef = useRef<SavedReadPos | null>(null);
  useEffect(() => { if (cacheKey) rememberMsgs(cacheKey, msgs); }, [msgs, cacheKey]);
  useEffect(() => { rememberDraft(cacheKey, draft); }, [draft, cacheKey]);

  // ── 上下文用量（估算值）：圆环常驻显示，挂载即拉、消息变动时刷新；点开浮层再拉一次 ──
  const [ctx, setCtx] = useState<ContextUsage | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  // 浮层退场：open 置假先播 cardOut 淡出，走完再摘 portal（背板一起走）。
  const ctxExit = useExitVisible(ctxOpen, "cardOut");
  const [ctxErr, setCtxErr] = useState("");
  const ctxBtnRef = useRef<HTMLButtonElement>(null);
  const loadCtx = useCallback((): void => {
    void chatApi.fetchContextUsage(cid, conversationId)
      .then((d) => { setCtx(d); setCtxErr(""); })
      .catch((e: Error) => { setCtx(null); setCtxErr(e.message); });
  }, [cid, conversationId]);

  // ── 思考强度：收进模型选择浮层做二级区（不再是并排的独立按钮）──
  const [thinking, setThinking] = useState<ThinkingControl | null>(null);
  const [thinkBusy, setThinkBusy] = useState(false);
  const loadThinking = useCallback((): void => {
    void chatApi.fetchThinkingControl(cid)
      .then(setThinking)
      .catch(() => setThinking(null));
  }, [cid]);
  useEffect(() => { loadThinking(); }, [loadThinking]);

  // 首个实时推理片段到达时自动展开；用户一旦手动收起，就不再被后续增量强行打开。
  useEffect(() => {
    const turnId = draftTurnRef.current;
    if (!turnId || streamReasoning === "") return;
    setThinkingOpenTurns((prev) => prev[turnId] === undefined ? { ...prev, [turnId]: true } : prev);
  }, [streamReasoning]);

  // 草稿→定稿交接拍（draftRetired 翻真＝真气泡落位）：把这轮的展开态补记成草稿
  // 当时的值（草稿侧默认 ?? true，所以补记的正是 true）。常规路径上首个推理片段
  // 到达时上面那条已经写入，但推理与气泡落位之间存在时序窗口——同拍到达、
  // 切走再回来由 checkTurnState 重新接管 watch 时会先删掉这条记录——漏记的话
  // 定稿气泡拿到 undefined，落回 ThinkingBlock 内部的默认收起：用户正读着的
  // 推理面板啪地合上，persistKey 的滚动位置恢复也一起失效。只在「草稿真的挂着
  // 思考面板」（streamReasoning 非空）且只写交接那一拍的那一轮，历史旧气泡不受影响；
  // 用户在流式期间手动收起（记录为 false）时不动，尊重用户的选择。
  useEffect(() => {
    if (!draftRetired || streamReasoning === "") return;
    const turnId = draftTurnRef.current;
    if (!turnId) return;
    setThinkingOpenTurns((prev) => prev[turnId] !== undefined ? prev : { ...prev, [turnId]: true });
  }, [draftRetired, streamReasoning]);

  // ── 聊天模型快捷切换：只改这一位联系人的绑定，不动全局主模型 ──
  const chatModelScope = cid ?? msgScope ?? "";
  const modelSwitchable = cid === undefined && chatModelScope !== "";
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelProfileId, setModelProfileId] = useState("");
  const [globalModelName, setGlobalModelName] = useState("");
  const [globalModelReady, setGlobalModelReady] = useState(false);
  const [globalModelEcho, setGlobalModelEcho] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  // 模型浮层退场：open 置假先播 cardOut（与入场 cardIn 互为镜像），走完再摘 portal。
  // 定位 hook 吃 visible 而不是 open：退场帧里坐标得原样保留，visibility:hidden 会闪没。
  const modelExit = useExitVisible(modelOpen, "cardOut");
  /** 模型浮层当前展开的区：模型列表 / 推理等级。开浮层永远回到模型列表。 */
  const [modelPane, setModelPane] = useState<"models" | "think">("models");
  const [modelQuery, setModelQuery] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState("");
  const modelWrapRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const loadModels = useCallback((): void => {
    if (!modelSwitchable) return;
    void Promise.all([
      settingsApi.fetchSettings(),
      contactsApi.fetchContact(chatModelScope),
    ])
      .then(([settings, contact]) => {
        const profiles = settings.profiles ?? [];
        const byId = new Map(profiles.map((profile) => [profile.id, profile]));
        const names = settings.providerNames ?? {};
        setModelOptions(profilePicks(profiles, names).map((pick) => {
          const profile = byId.get(pick.value);
          const modelName = profile?.name?.trim() || profile?.label || "未填模型名";
          const profileName = profile?.label?.trim() || "";
          const provider = providerLabel(profile?.baseUrl, names, profiles) || "未命名供应商";
          return {
            value: pick.value,
            label: modelName,
            detail: profile?.mode === "echo" ? "演示模式"
              : profileName !== "" && profileName !== modelName && profileName !== provider ? profileName : "",
            provider,
          };
        }));
        setGlobalModelName(settings.model?.name || "");
        setGlobalModelReady(settings.modelReady === true);
        setGlobalModelEcho(settings.model?.mode === "echo");
        setModelProfileId(contact.contact?.model_profile ?? "");
        setModelError("");
      })
      .catch((error: Error) => setModelError(error.message));
  }, [chatModelScope, modelSwitchable]);
  useDismiss(modelOpen, () => setModelOpen(false), modelWrapRef);
  const modelPopPos = useAnchoredPop(modelExit.visible, modelTriggerRef, 390);
  useEffect(() => {
    if (!modelSwitchable) return;
    loadModels();
    const sync = (): void => loadModels();
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
  }, [loadModels, modelSwitchable]);
  const toggleModel = (): void => {
    setCtxOpen(false);
    if (!modelOpen) { setModelPane("models"); setModelQuery(""); loadModels(); loadThinking(); }
    setModelOpen((v) => !v);
  };
  const chooseModel = (profileId: string): void => {
    if (!modelSwitchable || modelBusy || profileId === modelProfileId) return;
    setModelBusy(true);
    contactsApi.updateContact(chatModelScope, { modelProfile: profileId })
      .then(() => {
        setModelProfileId(profileId);
        setModelOpen(false);
        addNotice(profileId === "" ? "已改为跟随全局模型" : "这位联系人的模型已切换", { info: true });
        refreshContacts();
        loadThinking();
        loadCtx();
        void pullRef.current?.();
      })
      .catch((error: Error) => addNotice("模型没切成：" + error.message, { info: true }))
      .finally(() => setModelBusy(false));
  };
  const globalModelStatus = globalModelEcho ? "演示模式" : globalModelReady ? (globalModelName || "已就绪") : "未就绪";
  const currentModel = modelOptions.find((item) => item.value === modelProfileId) ?? null;
  const currentModelLabel = currentModel !== null
    ? `${currentModel.provider} · ${currentModel.label}`
    : modelProfileId !== "" ? "已绑定模型" : `跟随全局 · ${globalModelStatus}`;
  const modelQueryText = modelQuery.trim().toLowerCase();
  const visibleModels = modelQueryText === "" ? modelOptions : modelOptions.filter((item) =>
    `${item.provider} ${item.label} ${item.detail}`.toLowerCase().includes(modelQueryText));
  const visibleModelGroups: Array<{ provider: string; items: ModelOption[] }> = [];
  for (const item of visibleModels) {
    const last = visibleModelGroups[visibleModelGroups.length - 1];
    if (last?.provider === item.provider) last.items.push(item);
    else visibleModelGroups.push({ provider: item.provider, items: [item] });
  }
  const showModelGroups = visibleModelGroups.length > 1;
  const modelOptionRow = (item: ModelOption): JSX.Element => (
    <button key={item.value} type="button" role="radio"
      aria-checked={modelProfileId === item.value}
      className={"model-option" + (modelProfileId === item.value ? " on" : "")}
      disabled={modelBusy} tabIndex={modelExit.closing ? -1 : undefined} onClick={() => chooseModel(item.value)}>
      <span className="model-option-copy">
        <b>{item.label}</b>
        {item.detail !== "" && <small>{item.detail}</small>}
      </span>
      {modelProfileId === item.value && <Check size={15} strokeWidth={2.4} />}
    </button>
  );
  const thinkingSummary = thinking === null
    ? "未读取"
    : thinking.thinking.mode === "auto"
      ? "跟随模型"
      : thinking.thinking.mode === "off"
        ? "不指定"
        : thinking.thinking.param !== "effort"
          ? (thinking.thinking.mode === "on" ? "开启" : "跟随模型")
          : thinking.thinking.level !== ""
            ? THINKING_LEVEL_LABELS[thinking.thinking.level]
            : "默认";
  const reasoningAvailable = thinking?.thinking.switchable === true;
  /** 明确开启思考时，首个正文片段到达前给出「正在思考」状态；跟随模型不冒充确定状态。 */
  const thinkingLive = showThinking && thinking?.thinking.mode === "on";
  const chooseThinking = (choice: ThinkingQuickChoice): void => {
    if (!thinking) return;
    const autoSelected = choice === "auto"
      ? thinking.thinking.mode === "auto" || (thinking.thinking.param === "effort" && thinking.thinking.mode === "off") || (thinking.thinking.param !== "effort" && thinking.thinking.mode === "")
      : false;
    const selected = autoSelected
      || (choice === "on" && thinking.thinking.mode === "on" && thinking.thinking.param !== "effort")
      || (choice === "off" && thinking.thinking.mode === "off")
      || (choice !== "auto" && choice !== "on" && choice !== "off"
        && thinking.thinking.mode !== "off" && thinking.thinking.mode !== "auto" && thinking.thinking.level === choice);
    if (selected || thinkBusy) return;
    const before = thinking;
    const optimistic: ThinkingControl = { ...thinking, thinking: choice === "auto"
      ? { ...thinking.thinking, mode: "auto", off: false, level: "" }
      : choice === "on"
        ? { ...thinking.thinking, mode: "on", off: false, level: "" }
        : choice === "off"
          ? { ...thinking.thinking, mode: "off", off: true, level: "" }
          : { ...thinking.thinking, mode: "on", off: false, level: choice } };
    setThinking(optimistic);
    setThinkBusy(true);
    chatApi.setThinkingLevel(choice, cid)
      .then((next) => {
        setThinking(next);
        // 强度改在模型档上：档被多位联系人共享、或改的是全局主模型时，必须说破——
        // 不然用户以为只动了当前这位，别的联系人跟着变了却没人知道。
        const shared = next.appliedTo;
        const change = choice === "auto" ? "推理等级已改为跟随模型"
          : choice === "on" ? "思考已开启"
            : choice === "off" ? "思考已关闭"
              : `推理等级已切到「${THINKING_LEVEL_LABELS[choice]}」`;
        addNotice(shared?.scope === "profile" && shared.contacts > 1
          ? `${change}（「${shared.label}」由 ${shared.contacts} 位联系人共用，一起改了）`
          : shared?.scope === "global"
            ? `${change}（这是全局主模型「${shared.label}」的设置）`
            : change, { info: true });
      })
      .catch((error: Error) => {
        // 回滚只认自己那份乐观快照：在途期间 loadThinking 可能已用服务器最新状态
        // 刷过 thinking，按引用比较，别把新快照打回旧值。
        setThinking((cur) => (cur === optimistic ? before : cur));
        addNotice("没切成推理等级：" + error.message, { info: true });
      })
      .finally(() => setThinkBusy(false));
  };
  // 这两个浮层此前只认「点遮罩」，键盘用户按 Esc 什么都不会发生。
  // 浮层本体标 data-keep-menu，内部点击才不会被 useDismiss 误判成外部点击。
  useDismiss(ctxOpen, () => { setCtxOpen(false); });
  // 定位 hook 吃 visible：退场帧里坐标原样保留（useAnchoredPop 关掉会清成 null，
  // 弹层会以 visibility:hidden 渲染，退场动画就白播了）。
  const ctxPopPos = useAnchoredPop(ctxExit.visible, ctxBtnRef, 264);

  const toggleCtx = (): void => {
    setModelOpen(false);
    setCtxOpen((v) => !v);
    if (!ctxOpen) loadCtx();
  };
  // 圆环常驻：进会话就拉一次，之后随消息增删刷新（与消息轮询同频，不额外加定时器）。
  // 判据用「最新消息 id」而不是行数：载入更早的分页只增行数、不改时间轴，按行数会把它
  // 误当上下文变了，多打一次服务端最贵的 token 估算；新消息/删掉最新一条才真的改占用。
  const maxMsgId = msgs.length > 0 ? (msgs[msgs.length - 1]?.id ?? 0) : 0;
  useEffect(() => { loadCtx(); }, [loadCtx, maxMsgId]);

  // ── 多媒体（图片附件 / 录音 / 播报 / 看大图） ──
  const [imgs, setImgs] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  /** 语音/视觉入口按能力就绪状态显隐；还没拉到过就保守地全不显示。 */
  const [caps, setCaps] = useState<Caps>(() => cachedCaps() ?? CAPS_OFF);
  // 图片入口必须按当前联系人实际分流的 visionMode 判断；ctx 还没回来时才退回全局能力值。
  const canModelSeeImages = ctx?.visionMode !== undefined ? ctx.visionMode !== "none" : caps.imageVision;
  const [recSec, setRecSec] = useState<number | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [ttsBusyId, setTtsBusyId] = useState<number | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  useDismiss(!!zoom, () => { setZoom(null); });

  // composer 表情入口：弹层走 portal + 锚定定位（model-pop 同一套）。
  // 触发钮外包一层 wrapper 交给 useDismiss——弹层本体虽标 data-keep-menu，
  // 但触发钮不在里面，不兜住的话「点开钮的那一下」会先被当成外部点击关掉再立刻重开。
  const [emoteOpen, setEmoteOpen] = useState(false);
  // 表情弹层退场：open 置假先播 menuOut 淡出（与 menuIn 互为镜像），走完再摘 portal。
  const emoteExit = useExitVisible(emoteOpen, "menuOut");
  const emoteWrapRef = useRef<HTMLDivElement>(null);
  const emoteBtnRef = useRef<HTMLButtonElement>(null);
  useDismiss(emoteOpen, () => setEmoteOpen(false), emoteWrapRef);
  const emotePopPos = useAnchoredPop(emoteExit.visible, emoteBtnRef, 320);

  // 微信式的会话状态：联系人在忙什么就说什么，连接信息退到异常时才出现。
  const chatStatus = useMemo<{ text: string; tone: string }>(() => {
    if (recSec !== null) return { text: "正在录音…", tone: "typing" };
    if (voiceBusy) return { text: "正在准备语音消息…", tone: "typing" };
    if (transcribing) return { text: "识别语音中…", tone: "typing" };
    if (typing || busy) return { text: "正在回复…", tone: "typing" };
    if (failure) return { text: "上一条没回上来", tone: "bad" };
    if (modelReady === null) return { text: "准备中…", tone: "" };
    if (!modelReady) return { text: "还没接入模型", tone: "echo" };
    return { text: "在线", tone: "live" };
  }, [recSec, voiceBusy, transcribing, typing, busy, failure, modelReady]);

  useEffect(() => { onStatus?.(chatStatus.text, chatStatus.tone); }, [chatStatus, onStatus]);

  const imgsRef = useRef<string[]>([]);
  /** 当前会话 id 的镜像：异步回调（录音转写）回来时要确认"人还是不是同一个"。 */
  const cidRef = useRef(cid);
  cidRef.current = cid;
  /** msgScope 的稳定镜像：事件回调（不随渲染重建）读它判作用域。 */
  const msgScopeRef = useRef(msgScope);
  msgScopeRef.current = msgScope;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recActionRef = useRef<"cancel" | "voice" | "transcribe">("voice");
  const recStartedRef = useRef(0);
  const recWaveRef = useRef<number[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const waveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const lastIdRef = useRef(0);
  if (lastIdRef.current === 0 && msgs.length > 0) {
    // 种子帧带来的水位：增量拉取从已画的最大 id 续，不会重复追加
    for (const m of msgs) if (m.id > lastIdRef.current) lastIdRef.current = m.id;
  }
  const pendingsRef = useRef<Pending[]>([]);
  const editingRef = useRef<number | null>(null);
  const editingRoleRef = useRef<string | null>(null);
  /** 正在改的那条属于哪一轮：改完只需重取这一轮（不必重敲整页）。 */
  const editingTurnRef = useRef<string | null>(null);
  const pendingTurnRef = useRef<string | null>(null);
  const stickRef = useRef(true);
  /**
   * 用户「亲手」往上翻了没有。翻了就停止自动追底，直到用户回到真正的底部（±2px）才交还。
   * 只靠 onScroll 里的 nearBottom 判定不够：我们自己每拍写的 scrollTop 也触发它，
   * 而那个判定有 120px 宽限——用户拖不到 120px 就被下一拍拽回去，
   * 手感就是「滚不动、气泡一直往上顶」。
   */
  const userHoldRef = useRef(false);
  /** 顶栏「⋯」下拉（微信式聊天详情入口）：编辑资料。 */
  const [headMenu, setHeadMenu] = useState(false);
  // 菜单退场：先播 menuOut 淡出再从树上摘掉；useDismiss 随 headMenu 置假自动停用。
  const headMenuExit = useExitVisible(headMenu, "menuOut");
  const headBtnRef = useRef<HTMLButtonElement>(null);
  /** 「⋯」里的归档二次确认（和侧栏右键菜单一个套路）。触发点与菜单本体都标了 data-keep-menu。 */
  useDismiss(headMenu && editingId === null, () => setHeadMenu(false));
  /** 菜单是按视口坐标定位的：开菜单本身可能带一次滚动（贴底/长按置顶），那道判定用它。 */
  const menuOpenedAt = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  /** 暂停态存 ref：轮询链读最新值即可，不必因 paused 变化重建整条链。 */
  const pausedRef = useRef(!!paused);
  const wasPausedRef = useRef(!!paused);
  /**
   * 沉睡 = 标签页切走 / 宿主暂停 / 自身被 display:none 收起。
   * 第三条最易漏：窄屏的会话列表页与资料页叠层时 ChatView 仍在全速轮询。
   *
   * 提到组件作用域是故意的：轮询链与在飞处理单的 watch 链**都要**看它，
   * 而 watch 那条从前各写一份判断，结果关着的助手弹窗还在以约 2.2 req/s 打 4.5 分钟。
   * 一个定义两处用，就不会再漂移。
   */
  const asleep = useCallback((): boolean => document.hidden
    || pausedRef.current
    || (logRef.current !== null && logRef.current.offsetParent === null), []);
  const pullInflight = useRef(false);
  const pullAllInflight = useRef(false);
  const iptRef = useRef<HTMLTextAreaElement>(null);

  const nearBottom = useCallback((): boolean => {
    const el = logRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);
  /** 强制滚动的序号：搜索/地图跳转、编辑定位、键盘走位这类「去别处」的显式滚动
      会把它 +1，正在跑的落底收敛循环看到序号变了就收手让位。 */
  const scrollSeqRef = useRef(0);
  const scrollDown = useCallback((force?: boolean, instant?: boolean) => {
    const el = logRef.current;
    if (!el || !(force || nearBottom())) return;
    const jump = (): void => {
      const prev = el.style.scrollBehavior;
      el.style.scrollBehavior = "auto";
      el.scrollTop = el.scrollHeight;
      el.style.scrollBehavior = prev;
    };
    const far = el.scrollHeight - el.clientHeight - el.scrollTop > 300;
    if (instant || far) {
      // 远距离定位（进会话/切联系人）与逐字追底：跳过平滑动画直接落底。
      // 追字那一档尤其要走这里——smooth 被 30 次/秒重启就永远追不完，看着是整页在往上爬。
      jump();
      // 收敛循环：跳转落点附近的行在跳完之后才完成最终布局（图片解码、链接卡异步
      // 长高），scrollHeight 会在随后一两帧里变化——单次赋值可能停在半空。「一键到底」
      // 点完不到底、切联系人回来落点不对，都是它。逐帧验证还没贴底就再顶一次，贴底即收。
      // 只挂在瞬时分支：≤300px 的近距平滑滚动不进来，微滚动手感不受影响。
      //
      // 让位条件必须用 userHoldRef 而不是 stickRef：落底过程中间态离底超过 120px 时，
      // 跳转自己触发的 scroll 事件会把 stickRef 重判成 false（那次事件是在高度长完之后
      // 才派发的，看到的已经是新 scrollHeight）——上一版收敛循环在第一帧就被它掐死，
      // 「一键到底」还是不到底。用户上滑（wheel/touchmove → takeOver）与显式滚动命令
      // （scrollSeqRef 变号）才是真正的「别再顶了」。
      const seq = ++scrollSeqRef.current;
      const start = performance.now();
      const settle = (): void => {
        if (!logRef.current || scrollSeqRef.current !== seq) return;
        if (userHoldRef.current || performance.now() - start > 800) return;
        if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) return;
        jump();
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [nearBottom]);

  /**
   * 会话被清空：整段重取并**替换**，不是合并。
   *
   * 为什么非要有这条路：增量拉取只收 id 比 lastIdRef 更大的消息，全量拉取又是按 id
   * mergeRows 的——两条路都只会加不会减。工作区被清空后服务端已经一条不剩，界面上那堆
   * 消息却会一直挂到切走再切回来。所以清空这个动作必须主动通报一声，走替换这一条。
   * 只认自己这一屏的 contactId：清的是别的联系人时这边不动。
   */
  useEffect(() => {
    const onCleared = (e: Event): void => {
      const detail = (e as CustomEvent<{ contactId?: string }>).detail;
      if (cid === undefined || detail?.contactId !== cid) return;
      void chatApi.fetchAllMessages(cid, conversationId).then((data) => {
        let maxId = 0;
        for (const m of data.messages) if (m.id > maxId) maxId = m.id;
        lastIdRef.current = maxId;
        setMsgs(data.messages);
        setOlderLeft(data.olderRemaining ?? 0);
      }).catch(() => { /* 拉不动就保持现状，下一拍轮询照旧 */ });
    };
    window.addEventListener("xiaomo:messages-cleared", onCleared);
    return () => window.removeEventListener("xiaomo:messages-cleared", onCleared);
  }, [cid]);

  // 窄屏双页流与资料页叠层都会把会话页藏成 display:none：沉睡期轮询链没跑，
  // lastIdRef 落后一截。被显示出来的这一下先唤醒补拉，再补滚到底（用户上翻过就不动）。
  const wakeRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onShown = (): void => {
      wakeRef.current();
      if (stickRef.current) requestAnimationFrame(() => scrollDown(true));
    };
    window.addEventListener("xiaomo:chat-shown", onShown);
    return () => window.removeEventListener("xiaomo:chat-shown", onShown);
  }, [scrollDown]);

  // ── 拉取（放 ref 里：轮询与各动作都调最新版，不必进依赖数组） ──
  const pullRef = useRef<() => Promise<void>>();
  const pullAllRef = useRef<() => Promise<void>>();
  const pullTurnRef = useRef<(turnId: string, prefetched?: MessageRow[]) => Promise<MessageRow[]>>();
  /** 比当前最早那条更早、还没进界面的行数（服务端报的，0 = 已经到顶）。
   *  从前是 `返回行数 >= 200` 反推，那个 200 前后端各写一遍，改一边就悄悄失效。 */
  const [olderLeft, setOlderLeft] = useState(0);
  /** 连续无变化的轮询次数：驱动退避（2.5s→5s→10s），任何动静都归零。 */
  const idleTicksRef = useRef(0);

  /** 盯一个处理单直到出结果（done/failed），期间每 900ms 轮询。
   *  stopped 标志纳入卸载清理：切联系人/离开页面后旧监控链立即终止，不再空跑 300 拍。
   *  fullRedraw：收尾时走全量重绘。重新生成**较早**的轮次时，新回复是写回它原来那个
   *  气泡行的（为了不甩到对话末尾），行号没变——增量拉取（id > since）永远看不到它变了。 */
  /** 草稿退场。结束/失败/停止/换轮都要走这里——草稿气泡现在会活到自己那轮的气泡上屏，
   *  少清一次就会在屏幕上挂着一段已经不代表的回答。 */
  const retireDraft = (): void => { draftTurnRef.current = null; setStreamText(""); setStreamReasoning(""); };
  const watchStopRef = useRef<(() => void) | null>(null);
  /** 流式帧的接收状态（draft/thought 各一份）：text=已收正文（null=检测到断档、
   *  等回源对齐），seq=最后续上的帧号。正文的主显示通道是事件总线上的帧；
   *  watch 轮询拍只做播种（首拍）、断档回源与断连兜底——三个来源都整段对齐
   *  到同一份 ref，谁都不会把谁的状态改坏。 */
  const draftStreamRef = useRef<{ text: string | null; seq: number }>({ text: "", seq: 0 });
  const thoughtStreamRef = useRef<{ text: string | null; seq: number }>({ text: "", seq: 0 });
  /** 断档标记：帧跳号或 lean 拍发现序号超前时置位，watch 下一拍先回源全量再继续。 */
  const streamResyncRef = useRef(false);
  /** 立即触发一次 watch 拍（帧断档回源、turn 收尾事件用），由 watch 挂载。 */
  const wakeWatchRef = useRef<(() => void) | null>(null);
  /** 实例存活哨兵：重答/发送的 POST 落在卸载之后（在飞时切走了联系人）时，watch 链不许
   *  再启动——卸载清理那时已经跑过，再没有人会调它的 stop，泄漏的轮询链会以旧作用域
   *  空转满 300 拍，还会顺手把旧联系人的已读进度上报出去。各拉取入口同守这道哨兵。 */
  const mountedRef = useRef(true);
  /** 被 barge-in 打断的旧轮：它已插的气泡是服务端删掉的，两种拉取（增量按 id、全量按 id 合并）
   *  都看不见删除。本地先撤下，等新轮收尾后再按轮窄取校准一次（打断收尾在旧执行体的
   *  下一个检查点才落库，立刻窄取可能太早）。 */
  const interruptedTurnsRef = useRef<Set<string>>(new Set());
  const watch = useCallback((turnId: string, opts: { fullRedraw?: boolean } = {}) => {
    if (!mountedRef.current) return;
    watchStopRef.current?.();
    // 新一轮（含重答同一轮）从默认展开重新开始，不继承上一轮用户收起后的状态。
    setThinkingOpenTurns((prev) => {
      if (!(turnId in prev)) return prev;
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
    let stopped = false;
    let tries = 0;
    let failDelay = 1200;
    watchStopRef.current = (): void => { stopped = true; };
    // 新一轮开始：先把上一轮残留的草稿摘掉，否则这 900ms 里联系人"正在写"的是旧话。
    retireDraft();
    // 流式接收状态归零：正文从这一轮的帧/首拍全量重新开始。
    draftStreamRef.current = { text: "", seq: 0 };
    thoughtStreamRef.current = { text: "", seq: 0 };
    streamResyncRef.current = false;
    const redraw = (): Promise<void> =>
      Promise.resolve(opts.fullRedraw ? pullAllRef.current?.() : pullRef.current?.());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number): void => { timer = setTimeout(tick, ms); };
    const tick = (): void => {
      if (stopped) return;
      // 沉睡时也要继续排下一拍（否则永远不会自己醒），但**不发请求**：
      // 关着的助手弹窗、切走的标签页，没有理由继续每 900ms 打一次 /api/turn
      // 外加每两拍一次的 /api/messages 和 /api/turns/recent。
      if (asleep()) { schedule(900); return; }
      tries += 1;
      // 草稿正文的到达路径分两条：事件总线的 draft/thought 流式帧（主路，
      // 服务端 200ms 一帧增量）与这一拍的 /api/turn（兜底）。连接着总线时，
      // 第一拍全量播种、之后走 lean 瘦身（只带回状态与帧序号，断档检测用）；
      // 断连或回源对齐那一拍才重新拉全量正文——旧行为（每拍全量快照）就是断连档。
      const wantFull = tries === 1 || streamResyncRef.current || !isBusConnected();
      streamResyncRef.current = false;
      chatApi.fetchTurn(turnId, cid, wantFull ? undefined : { lean: true })
        .then((turn) => {
          if (stopped) return;
          failDelay = 1200;
          // cancelled 也算收尾：别的入口（另一台设备/手机端）打断这一轮时，轮询状态永远
          // 停在 cancelled —— 不认的话 watch 会空转满 300 拍，界面上「正在回复」挂死。
          const over = turn.status === "done" || turn.status === "failed" || turn.status === "cancelled" || tries > TURN_WATCH_MAX_TRIES;
          const finished = turn.status === "done";
          // 定稿正文只认 done：failed 轮的 reply 列可能还留着断气前的半截草稿，
          // watch 超时（tries 耗尽）的轮连 done 都没到。把它们交给逐字揭示，草稿会永远
          // 等不到接手的真气泡（该轮不再有气泡上屏，draftHasBubble 恒假），挂死在屏幕上。
          // 结束这一拍**不清**已认定的 done 定稿——清了到气泡上屏之间会露出一个往返的空窗。
          if (!over || (finished && (turn.reply || turn.reasoning))) {
            // done 这一拍也把定稿正文交给逐字揭示：单条模式必须让最后一段字打完，
            // 再由下方真气泡接手，不能在中途整段闪换。
            if (turn.reply || turn.reasoning) draftTurnRef.current = turnId;
            const fullBody = turn.reply !== undefined; // lean 拍不带正文字段
            if (fullBody) {
              // 全量拍：整段采纳，帧号一并续上——之后到达的增量帧以此为基准。
              setStreamReasoning(String(turn.reasoning ?? ""));
              setStreamText(String(turn.reply ?? ""));
              draftStreamRef.current = {
                text: String(turn.reply ?? ""),
                seq: typeof turn.draftSeq === "number" ? turn.draftSeq : draftStreamRef.current.seq,
              };
              thoughtStreamRef.current = {
                text: String(turn.reasoning ?? ""),
                seq: typeof turn.reasoningSeq === "number" ? turn.reasoningSeq : thoughtStreamRef.current.seq,
              };
            } else if (
              (typeof turn.draftSeq === "number" && turn.draftSeq > draftStreamRef.current.seq + 1) ||
              (typeof turn.reasoningSeq === "number" && turn.reasoningSeq > thoughtStreamRef.current.seq + 1)
            ) {
              // lean 拍发现帧序号超前（有帧没送到）：下一拍回源全量补齐。
              streamResyncRef.current = true;
            }
          }
          // 消息列表不必每拍都拉：草稿走的是 /api/turn 这一拍，气泡最快也只有分条那 450ms 一条。
          // 每 WATCH_PULL_EVERY 拍拉一次，「首句先到」仍然靠这里。
          // 出结果那一拍不单独拉：下面紧接着就是 redraw（增量或全量），
          // 两处同发是实测「重答完闪几下」里的两次独立重排。
          if (!over && tries % WATCH_PULL_EVERY === 0) void pullRef.current?.();
          if (over) {
            if (turn.status === "done") dropNotices((n) => n.retryTurnId === turnId);
            pendingTurnRef.current = null;
            setTyping(false);
            setBusy(false);
            idleTicksRef.current = 0; // 刚有动静：轮询回到最快档
            if (turn.status === "failed") {
              // 失败必须当场说破：此前只有 checkTurnState（首屏/有新消息那一拍）会立横幅，
              // watch 的收尾一路静默 —— 模型挂掉后「正在回复」一灭就什么都不剩，
              // 会话里凭空少一条。横幅（详情+重试）与轻提示双保险，重试成功后一起收掉。
              setFailure({ id: turnId, error: turn.error ?? null });
              addNotice("这条没回上来，点重试再试一次", { retryTurnId: turnId });
            } else if (turn.status === "cancelled") {
              // 这一轮在别处被终止（整轮不留痕，行已从服务端删掉）：本地已插的半截气泡
              // 两种拉取都看不见删除，登记下来由下面的收尾按轮窄取校准。
              interruptedTurnsRef.current.add(turnId);
            } else if (turn.status !== "done") {
              addNotice("联系人半天没回话，可以再试一次", { retryTurnId: turnId });
            }
            // 等重绘真的把气泡取回来再撤草稿：setMsgs 在这一步里先落地，
            // 于是"气泡出现"和"草稿退场"是同一次渲染，中间不露底。
            // 逐字模式例外：草稿要活到 reveal.done；done 之外的收尾（failed / watch 超时）
            // 真气泡可能永远不来，必须当场撤，不能交给 draftHasBubble 判。
            void redraw().then(async () => {
              // done 但一轮下来连一条回复气泡都没有（模型回了空、或收尾时产物被清）：
              // 界面上就是"联系人没说话"，必须留一句提示 + 重答入口，不能无声无息。
              // 只查 reply 为空的 done 轮——正常完成时气泡必然随 redraw 落地，不多打这一发。
              if (finished && !turn.reply) {
                const rows = await pullTurnRef.current?.(turnId);
                if (rows && !rows.some((m) => m.role === "assistant" && m.kind === "chat")) {
                  setFailure({ id: turnId, error: turn.error ?? null, empty: true });
                  addNotice("这条回复是空的，可以重新答一次", { info: true });
                }
              }
            }).finally(() => {
              if (!streamReveal || !turn.reply || !finished) retireDraft();
              // 被打断的旧轮：新轮收尾时它的清理早已落库，按轮窄取把本地残留校准掉。
              if (interruptedTurnsRef.current.size > 0) {
                for (const tid of interruptedTurnsRef.current) void pullTurnRef.current?.(tid);
                interruptedTurnsRef.current.clear();
              }
            }).catch(() => { /* 重绘/空回复检查失败：下一拍轮询照旧，别留未处理的拒绝 */ });
            return;
          }
          // 连着总线时草稿正文由帧实时推，拍只监视状态，可以放宽；断连回到 900ms
          // 快档（那时的拍还兼着正文快照的职责）。
          schedule(isBusConnected() ? 2000 : 900);
        })
        .catch(() => {
          if (stopped) return;
          // 失败路径也要有次数上限：then 路径封顶 300 拍，catch 只退避到 8s 就永远循环。
          // 处理单被另一端硬删后 fetchTurn 会一直 404，typing 永挂、busyGuard 永久拦撤回/删除/编辑。
          if (tries > TURN_WATCH_MAX_TRIES) {
            pendingTurnRef.current = null;
            setTyping(false);
            setBusy(false);
            idleTicksRef.current = 0;
            retireDraft();
            addNotice("这一条没回成功，刷新看看", { info: true });
            return;
          }
          schedule(failDelay);
          failDelay = Math.min(failDelay * 2, 8000); // 网络故障指数退避，封顶 8s
        });
    };
    // 立即拍：turn 收尾事件、帧断档回源都从这条路插队，不等下一拍。
    const wake = (): void => {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      tick();
    };
    wakeWatchRef.current = wake;
    tick();
  }, [addNotice, cid, dropNotices, asleep, streamReveal]);
  useEffect(() => () => { mountedRef.current = false; watchStopRef.current?.(); wakeWatchRef.current = null; }, []);

  // 数据被整库清空：模块级那份种子缓存必须当场作废。
  // 库是 DELETE 清的、AUTOINCREMENT 不复位，所以没有任何 id 变化能提醒缓存"这些行已经没了"——
  // 不清的话切回对话页，那一整段被清掉的对话会原样重现，新消息还会接在它后面
  // （lastIdRef 也是从那批陈旧行里取的）。
  useEffect(() => {
  const onWiped = (): void => {
    msgsSeed.clear();
    draftSeed.clear();
    readPosSeed.clear();
    setMsgs([]);
    lastIdRef.current = 0;
    pendingsRef.current = [];
    setPendings([]);
    setOlderLeft(0);
  };
    window.addEventListener(DATA_WIPED_EVENT, onWiped);
    return () => window.removeEventListener(DATA_WIPED_EVENT, onWiped);
  }, []);

  const retry = useCallback((turnId: string) => {
    if (pendingTurnRef.current) return;
    pendingTurnRef.current = turnId;
    setBusy(true);
    setTyping(true);
    // 旧的同轮失败提示先收掉：重试再失败会挂新的，不收就连点几次堆几条一样的。
    dropNotices((n) => n.retryTurnId === turnId);
    chatApi.retryTurn(turnId, cid)
      .then(() => {
        // 这一轮重新在跑了：失败横幅还挂着就是自相矛盾的状态（横幅说失败、顶栏说在线）。
        setFailure(null);
        return watch(turnId);
      })
      .catch(() => {
        setTyping(false);
        setBusy(false);
        pendingTurnRef.current = null;
        retireDraft();
        addNotice("没重试上，稍后再试", { info: true });
      });
  }, [addNotice, dropNotices, watch]);

  /** 空回复那一轮的补答入口：轮子已经 done，失败重试的后端不收（"已经成功了，不用重试"），
   *  得走「重新生成」——它对 done 轮开放；空回复的多半就是最新一轮，照常分条落库。 */
  const regenerateEmpty = useCallback((turnId: string): void => {
    if (pendingTurnRef.current) { addNotice("上一条还在回，稍等一下", { info: true }); return; }
    pendingTurnRef.current = turnId;
    setBusy(true);
    setTyping(true);
    chatApi.regenerateTurn(turnId, cid)
      .then(() => {
        setFailure(null);
        return watch(turnId);
      })
      .catch((error: Error) => {
        pendingTurnRef.current = null;
        setTyping(false);
        setBusy(false);
        retireDraft();
        addNotice("没重答成：" + error.message, { info: true });
      });
  }, [addNotice, cid, watch]);

  /**
   * 本会话最近一轮处理单的下场：失败给横幅，**还在飞的把界面接上**。
   *
   * 为什么必须查：typing/busy/pendingTurnRef 全在这个组件实例里，而会话页按联系人
   * `key` 挂载 —— 重答跑了一半你切走再回来，人还在答，界面却已经"在线"了，
   * 连「停止」都够不到（实测：切回时顶栏=在线、无停止钮、气泡数比离开时少两条）。
   * 顺带覆盖另一条此前没人接的路：联系人从微信/别的窗口回话，这边同样该显示在忙。
   *
   * 在飞的那一轮不能只在「最新一条」里找：重答**较早**轮次时，那一轮的 created_at
   * 还是它当初的时间，排不进 LIMIT 1 —— 切走再切回（或刷新页面）就找不到在飞轮，
   * watch 无人接手；而重答较早轮次是**原地写回原气泡行**的，行号不变，增量拉取
   * （id > since）永远看不见它完成，界面就永远停在旧回答上。所以服务端在
   * /api/turns/recent 的响应里随最新轮一起带回在飞轮（active 字段），一发两用。
   *
   * 只置 typing 不置 busy —— 与 `send()` 同一套：busy 会把发送键锁成"发送中"，
   * 而"联系人还在回话时发新的一句 = 打断重来"是设计好的 barge-in，不能被恢复状态杀掉。
   */
  const checkTurnState = useCallback(async (): Promise<void> => {
    // 空闲与否要在**请求前**定格：await 期间用户可能 barge-in 发了新句、pendingTurnRef
    // 已换成新轮。不复核的话，迟到的旧响应会把 ref 改写回旧轮并 watch(旧轮)——
    // watch 开头的 watchStopRef 把新轮的监控杀掉，新回复从此无人认领。
    const wasIdle = pendingTurnRef.current === null;
    try {
      // 一发两用：失败横幅看最新一轮（turns[0]），在飞监控看服务端随响应带回的
      // active（重答较早轮次时它排不进「最新一条」，只能在响应里单独带回）。
      const recent = await chatApi.fetchRecentTurns(1, cid ?? msgScope, conversationId);
      const t = recent.turns?.[0];
      setFailure(t && t.status === "failed" ? { id: t.id, error: t.error } : null);
      const active = recent.active;
      if (active && (active.status === "queued" || active.status === "running") && wasIdle && pendingTurnRef.current === null) {
        pendingTurnRef.current = active.id;
        setTyping(true);
        watch(active.id, { fullRedraw: true });
      }
    } catch { /* 状态检查失败不阻塞消息 */ }
  }, [cid, msgScope, conversationId, watch]);

  // 已读上报：只在页面可见时把「看到哪条」记进后端，红点才会消失。
  // 切走/隐藏时不上报，别人才会在侧栏看到该联系人的未读。
  const lastReadSentRef = useRef(0);
  const reportRead = useCallback((): void => {
    if (typeof document !== "undefined" && document.hidden) return;
    const id = lastIdRef.current;
    if (id <= lastReadSentRef.current) return;
    lastReadSentRef.current = id;
    // 作用域必须显式带上：这一拍有可能是卸载之后才落地的（切联系人时在途的那一次拉取），
    // 省略 cid 会让 api 层回落去读**响应时刻**的全局联系人——A 的进度就记到了 B 头上，
    // B 的红点被凭空清掉还落了库。
    contactsApi.markRead(cid ?? msgScope, id, conversationId)
      .then(() => window.dispatchEvent(new Event("xiaomo:contacts-changed")))
      .catch(() => { lastReadSentRef.current = 0; });
  }, [cid, msgScope, conversationId]);

  const pullOnce = async (): Promise<void> => {
    if (!mountedRef.current) return; // 卸载后迟到的调用：不再发请求、不再上报已读
    const data = await chatApi.fetchMessages(lastIdRef.current, cid, conversationId);
    setModelReady(data.modelReady);
    setOnboardingDone(data.onboardingDone);
    setPersonaIsDefault(data.personaIsDefault === true);
    let pend = pendingsRef.current;
    const toAdd: MessageRow[] = [];
    for (const m of data.messages) {
      if (m.id <= lastIdRef.current) continue;
      // 占位认领：只负责移除占位气泡，真实消息一律要进列表。
      // legacy 版认领=把占位 DOM 升级成真消息；这里如果认领后不 push，
      // 用户刚发的那句话会当场消失（0.1.0 实测踩过）。
      if (m.role === "user") {
        // 有 turn_id 且占位也已回填才按单认领（精确）；占位还没拿到 turnId（/api/say
        // 的响应比这一拍轮询慢）或老数据没有 turn_id 时回落文本全等——否则认领不上，
        // 真消息进了列表而占位不撤，同一句话双气泡一直挂到 20s 超时。
        const idx = pend.findIndex((p) => (p.turnId !== undefined && m.turn_id ? p.turnId === m.turn_id : p.text === m.text));
        if (idx >= 0) pend = pend.filter((_, i) => i !== idx);
      }
      toAdd.push(m);
      lastIdRef.current = m.id;
    }
    if (pend !== pendingsRef.current) {
      pendingsRef.current = pend;
      setPendings([...pend]);
    }
    // 追加也走按 id 合并，不是裸 concat：并发的 pullAll 刚把水位回拨过的话（见下），
    // toAdd 里会混进已经上屏的行，裸追加就把同一气泡渲染两份。
    if (toAdd.length) setMsgs((prev) => mergeRows(prev, toAdd));
    if (toAdd.length) idleTicksRef.current = 0;
    if (toAdd.length || pendingsRef.current.length > 0) await checkTurnState();
    if (toAdd.length) reportRead();
  };

  pullRef.current = async (): Promise<void> => {
    // 在途保护：turn 轮询每拍都会顺手拉一次消息，与 2.5s 的空闲链并发；
    // 弱网下后发先至会让 lastIdRef 倒挂、把同一批消息重复推进列表。全量在飞时同样让路。
    if (pullInflight.current || pullAllInflight.current) return;
    pullInflight.current = true;
    try {
      await pullOnce();
    } finally {
      pullInflight.current = false;
    }
  };

  pullAllRef.current = async (): Promise<void> => {
    // 与 pullOnce 同一套在飞保护：连点两次「撤销编辑」之类会并发两个全量，
    // 后落地的那份把 lastIdRef 按更旧的快照改写。
    if (pullAllInflight.current) return;
    pullAllInflight.current = true;
    try {
      await pullAllOnce();
    } finally {
      pullAllInflight.current = false;
    }
  };

  const pullAllOnce = async (): Promise<void> => {
    if (!mountedRef.current) return; // 卸载后迟到的调用：不再发请求、不再上报已读
    const data = await chatApi.fetchAllMessages(cid, conversationId);
    setModelReady(data.modelReady);
    setOnboardingDone(data.onboardingDone);
    setPersonaIsDefault(data.personaIsDefault === true);
    setOlderLeft(data.olderRemaining ?? 0);
    if (editingRef.current !== null) return;
    let maxId = 0;
    for (const m of data.messages) if (m.id > maxId) maxId = m.id;
    // 水位只进不退：并发跑过一拍增量的话，lastIdRef 可能已经被推到比这份全量快照
    // 更新的位置——直接赋值会倒退，下一拍增量把已上屏的消息再推一遍。
    if (maxId > lastIdRef.current) lastIdRef.current = maxId;
    // 只清"还在飞"的占位。failed 的是故意留下来的——它带「没发出去 / 重试」，
    // 用户随时可能点那个重试。整段清空的话，网络抖一次之后打过的字和重试入口
    // 一起从界面上消失，而且没有任何地方还能找回来（消息从没落库）。
    const keepFailed = pendingsRef.current.filter((p) => p.failed);
    pendingsRef.current = keepFailed;
    setPendings(keepFailed);
    // 全量页合并（会丢幽灵行），不是只增不删的 mergeRows：`all=1` 是服务端最新一页的
    // 原样快照，用它认得出哪些本地行已经被服务端删掉（见 mergeRowsFullPage 的说明）。
    setMsgs((prev) => mergeRowsFullPage(prev, data.messages));
    reportRead();
  };

  /**
   * 只重取一条处理单的行并就地合并：撤回 / 删除 / 停止 / 改一句文字都只动那一轮，
   * 为一行变化重敲整页（实测首屏 500 行 / 250 KB / 线上 57 KB）不值。
   * 合并按 id 重排——messagesForTurn 给的是升序，落回原位置即可。
   * 返回服务端这一轮的行：watch 收尾要用它判断"done 了却没气泡"的空回复。
   */
  pullTurnRef.current = async (turnId: string, prefetched?: MessageRow[]): Promise<MessageRow[]> => {
    if (!mountedRef.current) return []; // 卸载后迟到的调用：不再发请求
    // prefetched：动作响应里直接带回的行（如版本切换），省一趟 /api/messages?turn=。
    const data = prefetched ?? (await chatApi.fetchTurnMessages(turnId, cid, conversationId)).messages;
    if (editingRef.current !== null) return data;
    setMsgs((prev) => reuseRows(prev,
      [...prev.filter((m) => m.turn_id !== turnId), ...data].sort((a, b) => a.id - b.id)));
    return data;
  };

  /** 只动某一轮的操作之后该重取什么：能按轮窄取就窄取；
   *  行上没有 turn_id（这列是后加的，老数据可能为空）才退回整页重敲。
   *  两个 ref 里装的永远是最新实现，所以本回调身份稳定、不必进任何依赖。 */
  const pullAffected = useCallback((turnId?: string | null): Promise<unknown> =>
    (turnId ? pullTurnRef.current?.(turnId) : pullAllRef.current?.()) ?? Promise.resolve(), []);

  /**
   * 归档：不弹"你确定吗"——联系人只是从列表挪进「已归档」，对话与记忆一个字都不动，
   * 所以直接做掉，落到列表后给 5 秒撤销（撤销就是 unarchive）。
   */
  const archiveNow = useCallback((): void => {
    const scope = cid ?? msgScope ?? "";
    const name = characterName;
    void contactsApi.archiveContact(scope)
      .then(() => {
        refreshContacts();
        // 侧栏的「已归档」分组听这个事件刷新（refreshContacts 只驱动活跃列表）。
        window.dispatchEvent(new Event("xiaomo:contacts-changed"));
        offerUndo(`已归档「${name}」`, () => {
          void contactsApi.unarchiveContact(scope)
            .then(() => {
              refreshContacts();
              window.dispatchEvent(new Event("xiaomo:contacts-changed"));
            })
            .catch(() => addNotice("没撤销成，稍后再试"));
        });
        if (onContactArchived) onContactArchived();
        else if (onBack) onBack();
      })
      .catch(() => addNotice("没归档成，稍后再试"));
  }, [addNotice, characterName, cid, msgScope, onBack, onContactArchived, refreshContacts]);

  // ── 发送 / 编辑 / 撤回 / 删除 ─────────────────────────────
  const send = useCallback((raw: string, extras?: {
    attachments?: string[];
    attachmentMeta?: MessageAttachmentMeta[];
    voice?: MessageAttachmentMeta;
    /** 独立发送（语音 / 表情这类自成一条的动作）：不合并待发图片、不吞草稿。 */
    standalone?: boolean;
  }): void => {
    const text = raw.trim();
    const extraAttachments = extras?.attachments ?? [];
    const voice = extras?.voice;
    const standalone = extras?.standalone === true;
    // 语音/表情是独立的发送动作：不把输入区里还没发的图片一起塞进这条消息。
    const attachments = voice || standalone ? [...extraAttachments] : [...imgsRef.current, ...extraAttachments];
    const attachmentMeta = extras?.attachmentMeta ?? [];
    const outboxContactId = cid ?? msgScope ?? "";
    if (!text && attachments.length === 0) return;
    /** 被这句打断的旧轮（barge-in）；202 回来后再做清理。 */
    let interrupted: string | null = null;
    if (pendingTurnRef.current) {
      interrupted = pendingTurnRef.current;
      // barge-in：联系人还在回上一条时发这句 = 打断旧轮、按新的一句重来（后端每联系人单飞）。
      // 旧轮不插任何气泡，给一句轻提示说明它去哪了——免得"回复消失了"变成悬案。
      addNotice("已停止上一条回复，按你这句重来", { info: true });
      // 旧草稿当场退场：从现在到 watch() 接手之间隔着 say() 的往返，不清的话
      // draftTurnRef 还指着旧轮，草稿会被就地锚定插到新占位气泡上面。
      watchStopRef.current?.();
      retireDraft();
    }
    stickRef.current = true;
    userHoldRef.current = false;   // 自己发了一句 = 明确要看联系人的回答，把自动跟随收回来
    idleTicksRef.current = 0;

    const localId = globalThis.crypto?.randomUUID?.() ?? (Math.random().toString(36).slice(2) + Date.now().toString(36));
    pendingsRef.current = [...pendingsRef.current, { text, at: Date.now(), imgs: attachments, localId, ...(voice ? { voice } : {}) }];
    setPendings([...pendingsRef.current]);
    // 语音/表情消息不吞正在写的草稿，也不消费待发图片；它们是与文字并列的另一种发送方式。
    if (!voice && !standalone) {
      setDraft("");
      imgsRef.current = [];
      setImgs([]);
      if (iptRef.current) iptRef.current.style.height = "auto";
    }
    setTyping(true);

    chatApi.say(text, attachments, cid, localId, conversationId, attachmentMeta)
      .then((data) => {
        pendingTurnRef.current = data.turnId;
        // 把 turnId 回填到这条占位上：之后按单认领，连发两句相同的话也不会互相错认。
        pendingsRef.current = pendingsRef.current.map((p) => (p.localId === localId ? { ...p, turnId: data.turnId } : p));
        setPendings([...pendingsRef.current]);
        const prior = interrupted;
        if (prior !== null) {
          // 旧轮已确认被打断（202 = 服务端收下了新轮、起跑时会作废旧轮）：它已插的气泡
          // 是服务端删掉的，增量拉取和按 id 合并的全量都看不见删除——本地按同一口径
          // 先撤下，再按轮窄取校准。立刻窄取可能还太早（旧执行体在下一个检查点收尾），
          // 所以同时登记下来，新轮 watch 收尾时会再校准一次。
          interruptedTurnsRef.current.add(prior);
          setMsgs((prev) => prev.filter((x) => x.turn_id !== prior || x.role === "user"));
          void pullTurnRef.current?.(prior);
        }
        return pullRef.current?.().then(() => watch(data.turnId));
      })
      .catch((error: Error) => {
        const retryable = navigator.onLine === false || (error instanceof ApiError && error.code === "NETWORK")
          || /超时|fetch|network|网络/i.test(error.message);
        if (retryable) {
          if (outboxContactId) {
            enqueueOutbox({ clientId: localId, contactId: outboxContactId, text, attachments, attachmentMeta });
            pendingsRef.current = pendingsRef.current.map((p) => (p.localId === localId ? { ...p, queued: true, failed: false, outbox: true } : p));
            addNotice("网络暂时不可用，已放进待发箱，联网后自动发送", { info: true });
          } else {
            // 没有作用域可入队（cid 与 msgScope 都为空的挂载）：标成"待发送"却没有任何
            // 东西会去发它，TTL 还豁免 queued 项——比失败态更坑。留失败态让用户手动重试。
            pendingsRef.current = pendingsRef.current.map((p) => (p.localId === localId ? { ...p, failed: true } : p));
            addNotice("没发出去，点这条消息重试", { info: true });
          }
        } else {
          // 非网络错误不清掉这条——留成失败态，用户能点它重试（无网络时话不能白打）。
          pendingsRef.current = pendingsRef.current.map((p) => (p.localId === localId ? { ...p, failed: true } : p));
          addNotice("没发出去，点这条消息重试", { info: true });
        }
        setPendings([...pendingsRef.current]);
        setTyping(false);
        setBusy(false);
        retireDraft();
      });
  }, [addNotice, cid, conversationId, watch]);

  /** 点选一张表情 = 独立发一条「表情消息」：attachments + kind:image 的 meta（label 随行），
   *  与 send_emote 在应用端的落库口径一致——模型回放历史时靠 meta.label 记住发过哪张。
   *  文本留空：图即是这句话，气泡里不再并排一行字。 */
  const sendEmote = useCallback((pick: { url: string; label: string }): void => {
    send("", {
      attachments: [pick.url],
      attachmentMeta: [{ url: pick.url, kind: "image", label: pick.label }],
      standalone: true,
    });
    setEmoteOpen(false);
  }, [send]);

  /** 重发一条发送失败的占位消息（无网络时 say 没成功，本地还留着这条）。成功就接回正常轮询。 */
  const rememberMessage = useCallback((m: MessageRow): void => {
    memoryApi.rememberMessage(m.id, cid)
      .then((r) => {
        if (r.duplicate) {
          addNotice("这条已经在记忆里了", { info: true });
          return;
        }
        addNotice("已记到长期记忆", { info: true });
        offerUndo(`已记到「${characterName}」的记忆`, () => {
          void memoryApi.deleteMemoryEvent(r.id, cid).catch(() => addNotice("撤销失败，稍后再试", { info: true }));
        });
      })
      .catch((error: Error) => addNotice("没记上：" + error.message, { info: true }));
  }, [addNotice, characterName, cid]);

  const retryPending = useCallback((localId: string): void => {
    const p = pendingsRef.current.find((x) => x.localId === localId);
    if (!p) return;
    if (pendingTurnRef.current) { addNotice("上一条还在回，稍等一下", { info: true }); return; }
    if (p.outbox) {
      pendingsRef.current = pendingsRef.current.map((x) => x.localId === localId ? { ...x, queued: true, failed: false } : x);
      setPendings([...pendingsRef.current]);
      addNotice("正在重试待发消息…", { info: true });
      void flushOutbox(cid, true);
      return;
    }
    setTyping(true);
    chatApi.say(p.text, p.imgs, cid, localId, conversationId, p.voice ? [p.voice] : undefined)
      .then((data) => {
        pendingTurnRef.current = data.turnId;
        pendingsRef.current = pendingsRef.current.map((x) => (x.localId === localId ? { ...x, turnId: data.turnId, failed: false } : x));
        setPendings([...pendingsRef.current]);
        return pullRef.current?.().then(() => watch(data.turnId));
      })
      .catch(() => {
        setTyping(false);
        setBusy(false);
        addNotice("还是没发出去，再试一次", { info: true });
      });
  }, [addNotice, watch]);

  /** 离线队列是跨挂载保存的：重进会话先把它画成“待发送”气泡，而不是像没打过这句话。 */
  useEffect(() => {
    const sync = (): void => {
      const queued = outboxForContact(cid ?? msgScope ?? "");
      const ids = new Set(queued.map((x) => x.clientId));
      const transient = pendingsRef.current.filter((p) => !p.outbox && !ids.has(p.localId));
      const fromOutbox: Pending[] = queued.map((x) => ({
        text: x.text,
        at: x.createdAt,
        imgs: x.attachments,
        localId: x.clientId,
        failed: !!x.lastError,
        queued: !x.lastError,
        outbox: true,
        ...(x.attachmentMeta?.find((item) => item.kind === "audio") ? { voice: x.attachmentMeta.find((item) => item.kind === "audio") } : {}),
      }));
      pendingsRef.current = [...transient, ...fromOutbox];
      setPendings([...pendingsRef.current]);
    };
    const unsubscribe = subscribeOutbox(sync);
    const sent = (event: Event): void => {
      const d = (event as CustomEvent<{ contactId?: string; clientId?: string }>).detail;
      // 入队用的作用域是 cid ?? msgScope（send 里同一套），判定必须同源——
      // 只比 cid 的话，msgScope 挂载（助手工作区）下发送成功事件永远对不上号，
      // 待发气泡撤不下来，只能靠下一拍轮询按文本全等回落认领。
      if (!d || !d.clientId || d.contactId !== (cid ?? msgScope ?? "")) return;
      pendingsRef.current = pendingsRef.current.filter((p) => p.localId !== d.clientId);
      setPendings([...pendingsRef.current]);
      void pullRef.current?.();
    };
    window.addEventListener("xiaomo:outbox-sent", sent);
    return () => {
      unsubscribe();
      window.removeEventListener("xiaomo:outbox-sent", sent);
    };
  }, [cid, msgScope]);

  const busyGuard = useCallback((): boolean => {
    if (pendingTurnRef.current) {
      addNotice("上一条还在回，稍等一下", { info: true });
      return true;
    }
    return false;
  }, [addNotice]);

  const doRetract = useCallback((m: MessageRow): void => {
    if (busyGuard()) return;
    setBusy(true);
    chatApi.retractMessage(m.id, cid)
      .then(() => pullAffected(m.turn_id))
      .then(() => { setBusy(false); addNotice("已撤回，联系人不会再记得", { info: true }); })
      .catch(() => { setBusy(false); addNotice("没撤回成，稍后再试", { info: true }); });
  }, [addNotice, busyGuard, pullAffected]);

  /**
   * 删除整轮。删完必须**本地先撤下**，不能只等重取：
   * 主动性消息（kind=proactive）没有 turn_id，服务端只删它自己这一行，前端于是回落
   * 全量重取，而 pullAll 走的 mergeRows 是「只增不删」的（为保住「载入更早」翻过的那些页）——
   * 服务端已经不返回它了，界面上的气泡却会一直挂着，直到切走再切回来。
   * 表现就是弹了「已删除」，那条消息还赖在原地。
   * 判据与后端同一套：有 turn_id 撤整轮，没有（主动性 / 老数据）就只撤这一条。
   */
  const doDelete = useCallback((m: MessageRow): void => {
    if (busyGuard()) return;
    setBusy(true);
    chatApi.deleteMessage(m.id, cid)
      .then(() => {
        setMsgs((prev) => prev.filter((x) => (m.turn_id ? x.turn_id !== m.turn_id : x.id !== m.id)));
        addNotice("已删除", { info: true });
        // 重绘只是补正（附件、计数、同轮别的行），失败也不影响本地已经撤下的这条。
        return pullAffected(m.turn_id).catch(() => { /* 下一拍轮询照旧 */ });
      })
      .catch(() => addNotice("没删成，稍后再试", { info: true }))
      .finally(() => setBusy(false));
  }, [addNotice, busyGuard, cid, pullAffected]);

  /** 重新生成：整轮回答作废重答，任何一轮都行（较早的轮次写回它原来的气泡位置）。
   *  旧气泡即刻本地撤下，新回复由 watch 盯着落地。 */
  const doRegenerate = useCallback((m: MessageRow): void => {
    if (!m.turn_id || busyGuard()) return;
    const tid = m.turn_id;
    // 与 send / retry 同一套：登记在飞的处理单、点亮「正在回复」、盯着它直到出结果。
    // 此前只把旧气泡撤下就结束了，接下来十几秒界面毫无动静——看不出到底有没有在重答。
    pendingTurnRef.current = tid;
    setTyping(true);
    setBusy(true);
    chatApi.regenerateTurn(tid, cid)
      .then(() => {
        setMsgs((prev) => prev.filter((x) => x.turn_id !== tid || x.role !== "assistant"));
        addNotice("重新答一次，马上就好", { info: true });
        // fullRedraw：重答较早的轮次时后端是写回原气泡行的，行号不变，增量拉取看不见。
        watch(tid, { fullRedraw: true });
      })
      .catch(() => {
        pendingTurnRef.current = null;
        setTyping(false);
        setBusy(false);
        retireDraft();
        addNotice("没重答成，稍后再试", { info: true });
      });
  }, [addNotice, busyGuard, cid, watch]);

  /** 切换这一轮回复的版本（swipe）：后端把选中版本写回气泡行、新行随响应带回，
   *  这里只做合并落位——一趟往返，界面即刻换字。 */
  const changeVariant = useCallback((m: MessageRow, index: number): void => {
    if (!m.turn_id || busyGuard()) return;
    setBusy(true);
    chatApi.setTurnVariant(m.turn_id, index, cid)
      .then((res) => pullTurnRef.current?.(m.turn_id!, res.messages))
      .catch(() => addNotice("没切换成，稍后再试", { info: true }))
      .finally(() => setBusy(false));
  }, [addNotice, busyGuard, cid]);

  /** 版本条右位的「再来一版」：与菜单「重新生成」同一条确认弹窗，
   *  确认后 doRegenerate 重答，旧版本留档、新回答追加为下一个版本。 */
  const requestVariantGenerate = useCallback((m: MessageRow): void => {
    if (busyGuard()) return;
    setPendingConfirm({ kind: "regenerate", m });
  }, [busyGuard]);

  useLayoutEffect(() => {
    if (editingId === null) return;
    const row = logRef.current?.querySelector(`[data-id="${editingId}"]`);
    scrollSeqRef.current += 1; // 「去别处」的显式滚动：叫停正在跑的落底收敛
    row?.scrollIntoView({ block: "nearest" });
  }, [editingId]);

  /**
   * 发送这一条。勾了「画一张」时把草稿包成点名的画图请求（仍是走同一条 send 流水线）。
   * 发完自动摘掉勾选：画一张是几十秒加一份每日配额，勾着不动会让人以为还在上一条里。
   */
  const submitDraft = useCallback((): void => {
    if (!drawArmed) { send(draft); return; }
    const subject = draft.trim();
    send(subject === "" ? "给我画一张图吧，画什么你来定。" : `画一张：${subject}`);
    setDrawArmed(false);
  }, [draft, drawArmed, send]);

  /**
   * 终止还在飞的那一轮。整轮抹掉不留痕（与被打断同一套语义：删气泡、不写回复、不跑抽取）。
   *
   * 判据用 typing 不是 busy：`send()` 只置 typing(true)，busy 是重试/撤回/删除/编辑那些
   * 本地操作在用的闸门——只看 busy 的话，刚发完消息这个按钮根本不会出现。
   *
   * 收尾必须走 pullAll（全量重绘）而不是增量 pull：被取消的那轮，它已经插进去的半截气泡
   * 是在服务端删掉的，而增量拉取（id > since）永远不会把"某条被删了"通知给前端——
   * 不重绘就会留下一屏早就该消失的话，"不留痕"就成了空话。
   */
  const stopTurn = useCallback((): void => {
    const turnId = pendingTurnRef.current;
    if (!turnId) return;
    chatApi.cancelTurn(turnId, cid)
      .then(() => {
        watchStopRef.current?.();
        pendingTurnRef.current = null;
        setTyping(false);
        setBusy(false);
        idleTicksRef.current = 0;
        retireDraft();   // 这一轮的行被后端删了，没有气泡会来接草稿，必须当场撤
        addNotice("已停止，这一轮不留记录", { info: true });
        // 这一轮的行被后端删掉了：按轮重取即可让它们从界面消失
        void pullAffected(turnId).then(() => { pullRef.current?.(); }).catch(() => { /* 重绘失败下一拍轮询会补 */ });
        scrollDown(true);
      })
      .catch((error: Error) => addNotice("停止失败：" + error.message, { info: true }));
  }, [addNotice, cid, pullAffected, scrollDown]);

  /**
   * 撤回过的话「重新编辑」：把原文放回输入框，作为**新消息**再发一次。
   * 微信就是这个语义。刻意不走编辑那条链路——编辑会从那里重建对话并作废后续，
   * 而撤回过的消息只是想捞回文字，谁都不该被顺手抹掉。
   */
  const reeditRetracted = useCallback((m: MessageRow): void => {
    setMenu(null);
    setDraft(m.text);
    imgsRef.current = (Array.isArray(m.attachments) ? m.attachments : []).filter((url) => /\.(png|jpe?g|webp|gif|avif)$/i.test(url));
    setImgs(imgsRef.current);
    if (iptRef.current) {
      iptRef.current.focus();
      const len = m.text.length;
      try { iptRef.current.setSelectionRange(len, len); } catch { /* 无选区能力的浏览器忽略 */ }
    }
  }, []);

  /** 真正切换到某条消息的编辑态；确认框和首条进入都走这里。 */
  const beginEdit = useCallback((m: MessageRow, textOnly = false): void => {
    editingRef.current = m.id;
    editingRoleRef.current = m.role;
    editingTurnRef.current = m.turn_id ?? null;
    setEditingId(m.id);
    setEditDraft(m.text);
    setEditImgs(Array.isArray(m.attachments) ? m.attachments : []);
    setEditTextOnly(textOnly && m.role === "user");
    setMenu(null);
    setPendingConfirm(null);
    // 打开编辑不跳底：视口该停在正在改的那条上（大厂惯例），
    // 跳底只发生在「保存后对话从这里重建」的那一刻。
  }, []);

  const startEdit = useCallback((m: MessageRow, textOnly = false): void => {
    setMenu(null);
    if (editingRef.current === m.id) return;
    if (busyGuard()) return;
    if (editingRef.current !== null) {
      // 不静默拦截，也不直接吞掉当前编辑内容：先问一句，确认后把编辑态转给这一条。
      setPendingConfirm({ kind: "edit-switch", m, textOnly });
      return;
    }
    beginEdit(m, textOnly);
  }, [beginEdit, busyGuard]);

  /** 确认框只在这里落地真正动作：确认前不改数据，取消就保持原样。 */
  const acceptPendingConfirm = (): void => {
    const target = pendingConfirm;
    setPendingConfirm(null);
    if (!target) return;
    // 弹窗开着的时候目标可能已经被删/被作废（另一端停止、重答中）。按 id 从最新列表
    // 重取一行再动手——拿陈旧行去 regenerate/retract 会打到失效目标上，
    // 拿它填编辑框则会把已被取代的内容当原文。
    const fresh = msgs.find((m) => m.id === target.m.id);
    if (!fresh) {
      addNotice("这条消息已经不在了", { info: true });
      return;
    }
    if (target.kind === "edit-switch") beginEdit(fresh, target.textOnly);
    else if (target.kind === "regenerate") doRegenerate(fresh);
    else doRetract(fresh);
  };

  const cancelEdit = useCallback((): void => {
    editingRef.current = null;
    editingRoleRef.current = null;
    editingTurnRef.current = null;
    setEditingId(null);
    setEditImgs([]);
    setEditTextOnly(false);
    void pullAllRef.current?.();
  }, []);

  const submitEdit = useCallback((): void => {
    const id = editingRef.current;
    if (id === null) return;
    const text = editDraft.trim();
    const isReply = editingRoleRef.current === "assistant";
    const textOnly = editTextOnly && !isReply;
    const imgs = isReply || textOnly ? [] : editImgs;
    if (!text && imgs.length === 0) {
      addNotice("内容不能为空", { info: true });
      return;
    }
    // 先取走本轮 id：下面清编辑态会把它抹掉，而"只改一句文本"之后只需要重取这一轮
    const editedTurn = editingTurnRef.current;
    editingRef.current = null;
    editingRoleRef.current = null;
    editingTurnRef.current = null;
    setEditingId(null);
    setEditImgs([]);
    setEditTextOnly(false);
    setBusy(true);
    if (isReply || textOnly) {
      // 只动这一句文本：不重生成、不作废任何后续。
      // 改自己的话时附件原样不动（textOnly 下 imgs 恒为空数组，不传给后端即"不改"）。
      chatApi.editMessageText(id, text, cid)
        .then(() => pullAffected(editedTurn))
        .then(() => { setBusy(false); addNotice(isReply ? "回复已修改" : "已改文字，后面的对话原样保留", { info: true }); })
        .catch((error: Error) => {
          setBusy(false);
          addNotice("修改失败：" + error.message, { info: true });
          return pullAffected(editedTurn);
        });
      return;
    }
    // 改后重聊 = 版本式重答（与重新生成同构）：旧回复进版本条、新回答落回这一轮的位置，
    // 编辑点之后的对话原样保留——不再作废折叠。
    stickRef.current = true;
    userHoldRef.current = false;
    chatApi.editMessage(id, text, imgs, cid)
      .then((data) => {
        pendingTurnRef.current = data.turnId;
        // 旧回复会被服务端删掉（先存进版本条再硬删），而 mergeRows 只增不删（为保住
        // "载入更早"的分页），删掉的行不再返回却赖在本地——先本地按同一口径撤下。
        if (editedTurn) setMsgs((prev) => prev.filter((x) => x.turn_id !== editedTurn || x.role !== "assistant"));
        setTyping(true);
        // fullRedraw：重答较早的轮次时新回复写回原气泡行，行号不变，增量拉取看不见。
        return pullAffected(editedTurn).then(() => watch(data.turnId, { fullRedraw: true }));
      })
      .catch((error: Error) => {
        pendingTurnRef.current = null;
        setBusy(false);
        addNotice("编辑没生效：" + error.message, { info: true });
        return pullAllRef.current?.();
      });
  }, [addNotice, editDraft, editImgs, editTextOnly, pullAffected, watch]);

  // ── 渲染节点推导 ─────────────────────────────────────────
  const nodes = useMemo((): ListNode[] => {
    const out: ListNode[] = [];
    let lastDay: string | null = null;
    let lastAt = 0;
    let lastRole: string | null = null;
    let stale: MessageRow[] = [];
    // 作废的那一段折在哪儿：只有**被编辑那一轮的重新回答**排在它上面（那条回复是
    // 新起的行号，按 id 会落到废弃尾巴之后，不挪就把新回复挤到折叠组下面，看着像
    // 联系人在回答那堆已作废的话）。判据只用轮号：轮号等于折叠组上面那条现有消息的，
    // 才是"取代它的内容"。从前这里比的是生成时刻，于是编辑之后继续聊的每一条都算
    // "更新"，折叠组被一路推到底——所有「已被编辑取代」都沉到聊天框底部。
    let lastLiveTurn: string | null = null;
    const flushStale = (): void => {
      if (stale.length) { out.push({ t: "stale", items: stale }); stale = []; }
    };

    for (const m of msgs) {
      if (m.superseded_at !== null && m.superseded_kind !== "retract") { stale.push(m); continue; }
      if (stale.length > 0 && m.turn_id !== lastLiveTurn) flushStale();
      if (m.kind === "tool") {
        // 关掉「工具调用过程」只是不想看联系人查了什么；卡片上挂着的候选图是**用户要的产出**
        // （搜图本来就是为了挑一张）。跟着一起吞掉，就会出现「联系人说图已经显示在界面上、
        // 界面上却什么都没有」——图明明在库里，只是被这条显示开关拦掉了。
        if (!showTools && (m.attachments ?? []).length === 0) continue;
        // 工具卡也算"一天里的话"：跨天落在工具卡上时同样要出日分隔，
        // 否则前一天的回复和今天的第一句之间什么标记都没有。
        const dayChanged = lastDay === null || dayOf(m.created_at) !== lastDay;
        if (clockPref !== "off" && dayChanged) out.push({ t: "daysep", label: clockPref === "auto" ? dayTimeLabel(m.created_at) : dayLabel(m.created_at), day: dayOf(m.created_at) });
        out.push({ t: "tool", m });
        lastDay = dayOf(m.created_at);
        lastAt = m.created_at;
        lastLiveTurn = m.turn_id ?? lastLiveTurn;
        continue;
      }
      const dayChanged = lastDay === null || dayOf(m.created_at) !== lastDay;
      if (clockPref !== "off" && dayChanged) out.push({ t: "daysep", label: clockPref === "auto" ? dayTimeLabel(m.created_at) : dayLabel(m.created_at), day: dayOf(m.created_at) });
      // 智能模式的当天首条时间放在日分隔里；气泡右下角只在隔得久时补带。每条显示=全带；极简=全无
      const showClock = clockPref === "always"
        || (clockPref === "auto" && !dayChanged && m.created_at - lastAt > PROACTIVE_GAP_MS);
      const gap = dayChanged || lastRole !== m.role || m.created_at - lastAt >= PROACTIVE_GAP_MS;
      out.push({ t: "msg", m, gap, clock: showClock ? clockOf(m.created_at) : undefined });
      lastDay = dayOf(m.created_at);
      lastAt = m.created_at;
      lastRole = m.role;
      lastLiveTurn = m.turn_id ?? lastLiveTurn;
    }
    flushStale();

    for (const p of pendings) out.push({ t: "pending", id: p.localId, text: p.text, imgs: p.imgs, ...(p.voice ? { voice: p.voice } : {}), gap: true, failed: p.failed, queued: p.queued });

    if (out.length === 0) out.push({ t: "intro" });

    /* 流式草稿落在它那一轮该在的位置，而不是永远吊在整列表末尾：重新生成/编辑都是
       就地重答——重答写回原行号（后端），落点在本轮现有消息之后；草稿跟着同一个位置，
       才不会出现"先在最后一条输出、完成后跳回原位"。本轮的行还没进列表（刚发出去、
       只有本地占位）时留在末尾，与以前一致。
       条件就是 draftLive：逐字揭示完成后草稿必须真正退场，否则会与同轮真气泡并存；
       typing 为真但还没有正文时 draftLive 仍为真，三个点照常挂在锚点后面。 */
    if (draftLive) {
      // 在飞的那一轮优先于草稿正文所属的轮：两者不一致只可能是窗口期——新轮已经开跑、
      // 旧草稿还没退场（重答/编辑打断、或新消息进来），这时草稿是旧轮的残影，
      // 落点必须跟着新轮走，否则占位会插在旧回复后面、比它新的消息之前。
      const anchor = pendingTurnRef.current ?? draftTurnRef.current;
      let at = -1;
      // 还有**在飞**的占位气泡（刚发出、还没被真消息认领）时，锚点只可能是旧轮
      // （新轮的用户消息还没进列表），就地锚定会把"正在回复"插到用户刚发的那句上面
      // ——这时草稿一律垫到末尾。离线待发（outbox/queued）与失败态不算在飞：
      // 它们的新轮还不存在，不该阻止重答较早轮次时的就地锚定。
      // 同一窗口期还有另一副面孔：占位刚被轮询认领、pendings 已清空，但 say() 的响应
      // 还没回来把 pendingTurnRef 回填——typing 还亮着，锚同样是旧轮，一样垫到末尾。
      if (anchor !== null && !pendings.some((p) => !p.failed && !p.outbox)
          && !(typing && pendingTurnRef.current === null)) {
        for (const [i, n] of out.entries()) {
          if ((n.t === "msg" || n.t === "tool") && n.m.turn_id === anchor) at = i;
        }
      }
      out.splice(at >= 0 ? at + 1 : out.length, 0, { t: "draft" });
    }
    return out;
    // typing/draftShown 是草稿的可见性与内容（typing 还参与上面"发送在飞"那个窗口期的判定）；
    // 锚定的轮号只在换轮时随这些状态一起变，所以不必（也不能）把 ref 本身写进依赖。
  }, [msgs, pendings, clockPref, showTools, draftLive, typing, streamReasoning]);

  /** 贴底时把"看到哪儿了"推到最新：不这么做，第一次往上翻会把整段历史都算成"没看的新消息"
   *  （首屏不滚动就不触发 scroll，光靠 scroll 事件更新会漏掉这一档）。 */
  useEffect(() => {
    if (atBottom) bottomIdRef.current = lastIdRef.current;
  }, [atBottom, msgs]);

  /** 离开底部之后又进来的行数（联系人回的话、主动说的话）：贴底时恒为 0。 */
  const newBelow = atBottom ? 0 : msgs.reduce((n, m) => (m.id > bottomIdRef.current ? n + 1 : n), 0);

  // 占位气泡过期回收
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const alive = pendingsRef.current.filter((p) => p.failed || p.queued || now - p.at <= PENDING_TTL_MS);
      if (alive.length !== pendingsRef.current.length) {
        pendingsRef.current = alive;
        setPendings([...alive]);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const [bootErr, setBootErr] = useState("");
  const [earlierBusy, setEarlierBusy] = useState(false);

  /** 首屏全量拉取。失败也必须置 loaded 并给出可见的重试入口。 */
  const boot = useCallback((): void => {
    setBootErr("");
    void pullAllRef.current?.().then(() => {
      setLoaded(true);
      const saved = readPosSeed.get(cacheKey);
      readPosSeed.delete(cacheKey);
      if (saved && lastIdRef.current > 0 && saved.anchorId <= lastIdRef.current) {
        // 切走前用户停在历史中间：恢复阅读位置而不是砸回底部。stickRef 先摘掉，
        // nodes 落位的 layout effect 才不会先把人拽到最底、下一拍又跳回锚点闪一下；
        // 真正的定位在 loaded 翻真那一拍的 layout effect 里做（行已进 DOM）。
        stickRef.current = false;
        restoreRef.current = saved;
      } else {
        scrollDown(true);
      }
      // 落底与恢复都靠 scrollDown / 锚点定位自身收敛（见 scrollDown 的收敛循环），
      // 这里不再有「落底后放开跳渲染」的后续动作——content-visibility 实验撤掉了，
      // 它与这套滚动契约（scroll 事件重判 stickRef、贴底 ±2px、未读计数）冲突了两次，
      // foundation.css 与 experience.css 各留了一条「为什么撤」的记录。
      // 首屏这一拍也要认处理单：重答跑到一半切走再回来，界面得接着显示"正在回复"。
      // 增量拉取不会把"上一轮还在飞"通知给前端，不主动查就永远看不到了。
      void checkTurnState();
      // 不再补一拍增量拉取：全量刚落、lastIdRef 必是最新，这一发实测必空。
      // 竞态窗口里进来的消息由空闲链（2.5s 一拍）与事件总线兜住，不值得多打一发。
    }).catch((e: Error) => {
      setLoaded(true);
      // 选中的联系人已经不在了：本机删过，或在别处删了而 localStorage 还留着旧 id。
      // 只给「重试」是死路——重试永远 404，用户被卡在一片空白的会话里出不去。
      // 回落默认联系人并说明。两个前提：调用方允许切人（助手弹窗不传 onSwitchContact，
      // 不能拿它去改主联系人），且当前作用域不是助手的派生工作区。
      const scope = cid ?? msgScope ?? "";
      if (e instanceof ApiError && e.code === "CONTACT_NOT_FOUND"
          && onSwitchContact && !scope.startsWith("assistant:")) {
        setBootErr("这个联系人已经不在了，已切回默认会话");
        onSwitchContact("default");
        return;
      }
      setBootErr(e.message);
    });
  }, [scrollDown, onSwitchContact, cid, msgScope, checkTurnState, cacheKey]);

  /** 每次渲染都取最新的 boot：它闭包里带着当前作用域与调用方回调。 */
  const bootRef = useRef(boot);
  bootRef.current = boot;

  // 启动：先全量重绘一次（失效消息要折叠），再转入增量轮询。
  // 轮询自带退避：连续无新消息时 2.5s→5s→10s；页面隐藏时整个停摆，
  // 回到前台立刻补一拍——后台标签页不该继续每小时几千个请求。
  //
  // 这个 effect 必须**每实例只跑一次**。本组件按作用域 key 挂载（App 的 key={current}、
  // 助手弹窗的 key={sel}），换人就是换实例，草稿/附件/编辑态/录音随之重生，不需要在这里清；
  // 从前它挂在 [scrollDown, boot] 上，而 boot 认调用方回调的引用 —— App 每重渲染一次
  // 就重跑一次。实测代价（隔离实例 + 真模型）：别人回一条消息 → 未读总数跳变 → App 重渲染
  // → 正在打的草稿被清空 + 视口从阅读位置一步砸回底部（跳 9994px）+ 白发送一次 500 条全量。
  useEffect(() => {
    bootRef.current();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const schedule = (): void => {
      if (stopped || timer) return; // timer 非空说明链还在跑，不另起一条
      const step = Math.min(idleTicksRef.current, PULL_IDLE_STEPS.length);
      const delay = step === 0 ? PULL_INTERVAL_MS : PULL_IDLE_STEPS[step - 1];
      timer = setTimeout(async () => {
        timer = null;
        if (stopped) return;
        if (asleep()) {
          // 不请求也不累计，等唤醒：见 asleep() 的三种沉睡来源
        } else if (pendingTurnRef.current !== null) {
          // 一轮在飞：消息列表由 watch 那一拍负责（它 900ms 一跳），这条空闲链整拍跳过、
          // 也不累计 idleTicks——否则同一件事有两个轮询者，实测多出一档重复请求。
        } else {
          try {
            await pullRef.current?.();
            idleTicksRef.current += 1;
          } catch { /* 网络抖动：下一拍重试 */ }
        }
        schedule();
      }, delay);
    };
    /** 沉睡 = 标签页切走 / 宿主暂停 / 自身被 display:none 收起。
        最后一条此前漏了：窄屏的会话列表页与资料页叠层时 ChatView 仍在全速轮询。 */
    const wake = (): void => {
      if (asleep() || stopped) return;
      idleTicksRef.current = 0;
      if (timer) { clearTimeout(timer); timer = null; }
      void pullRef.current?.();
      schedule();
    };
    // 供「藏→显」事件调用：那条监听在组件更外层注册，拿不到这个闭包。
    wakeRef.current = wake;
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    schedule();
    return () => {
      stopped = true;
      wakeRef.current = () => {};
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);

  // 切走时把「读到哪儿」记下来（本实例卸载 = 切联系人 / 切视图的必经之路）。
  // 只在用户真的停在历史中间时才记：贴底切走的不记，回来照旧落底，旧契约不变。
  // 锚点行取「视口顶部压着的那条 data-id 行」——从上往下第一条底边越过容器顶的行。
  useEffect(() => {
    return () => {
      const el = logRef.current;
      if (!el || lastIdRef.current === 0 || nearBottom()) return;
      const top = el.getBoundingClientRect().top;
      let anchor: HTMLElement | null = null;
      for (const row of el.querySelectorAll<HTMLElement>(".msg-row[data-id]")) {
        if (row.getBoundingClientRect().bottom > top) { anchor = row; break; }
      }
      if (anchor === null) return;
      const anchorId = Number(anchor.dataset.id);
      if (!Number.isFinite(anchorId) || anchorId <= 0) return;
      rememberReadPos(cacheKey, { anchorId, offset: Math.round(anchor.getBoundingClientRect().top - top) });
    };
  }, [cacheKey, nearBottom]);

  // 恢复阅读位置（boot 挂进 restoreRef 的那笔）：loaded 翻真那一拍消息已进 DOM，
  // 用矩形差把锚点行对回切走时的视口位置——比 scrollIntoView 更可控（不依赖
  // offsetParent，也不用二段补偿）。锚点行已经不在（被删、或落在还没翻页载入的
  // 更早历史里）就回落落底，不让人悬在半空。此拍在 boot 的消息 commit 同帧运行，
  // 全量行都按真实高度布局着，定位是准的。
  useLayoutEffect(() => {
    if (!loaded) return;
    const saved = restoreRef.current;
    if (saved === null) return;
    restoreRef.current = null;
    const el = logRef.current;
    const row = el?.querySelector<HTMLElement>(`.msg-row[data-id="${saved.anchorId}"]`);
    if (!el || !row) {
      stickRef.current = true;
      scrollDown(true);
      return;
    }
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    scrollSeqRef.current += 1; // 恢复阅读位置是显式滚动：叫停可能还在跑的落底收敛
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset;
    el.style.scrollBehavior = prev;
  }, [loaded, scrollDown]);

  /** 跳转命中的那一行挂一次性描边脉冲（.hit-pulse，样式在 experience.css）：
      只 scrollIntoView 的话，用户在满屏气泡里找「是哪条」还得自己扫两秒。
      与 .flash 同一套路：动画负责闪，JS 负责摘类（动画时长 1.2s，定时器跟着给）；
      同一行连着命中两次时先摘类再强制 reflow，动画才能重新起跳。 */
  const pulseHitRow = useCallback((row: HTMLElement): void => {
    const prev = hitPulseRef.current;
    if (prev) {
      window.clearTimeout(prev.timer);
      prev.row.classList.remove("hit-pulse");
    }
    row.classList.remove("hit-pulse");
    void row.offsetWidth; // 读取强制排版：刚摘过类的同一行要重启动画，得先抹掉旧状态
    row.classList.add("hit-pulse");
    const timer = window.setTimeout(() => {
      row.classList.remove("hit-pulse");
      if (hitPulseRef.current?.row === row) hitPulseRef.current = null;
    }, 1200);
    hitPulseRef.current = { row, timer };
  }, []);
  // 卸载时把挂着的类和计时器一起收掉：行已经不在了，定时器再响就是空跑。
  useEffect(() => () => {
    if (hitPulseRef.current) {
      window.clearTimeout(hitPulseRef.current.timer);
      hitPulseRef.current.row.classList.remove("hit-pulse");
      hitPulseRef.current = null;
    }
  }, []);

  /** 搜索点进来的那条：等它真的进了列表再滚过去。
   *  消息可能在渲染窗口之外（首屏只画最近 500 条），那一行此时还不存在——
   *  不等到就动手，等于 silently 什么都不做。 */
  useEffect(() => {
    if (!focusMessageId || !loaded) return;
    const scrollToStr = (): boolean => {
      const row = logRef.current?.querySelector<HTMLElement>(`[data-id="${focusMessageId}"]`);
      if (!row) return false;
      stickRef.current = false;          // 别在跳完之后又把人拽回底部
      userHoldRef.current = true;        // 这一路都当是用户主动在上翻，直到用户回到底部
      scrollSeqRef.current += 1;         // 「去别处」的显式滚动：叫停正在跑的落底收敛
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      pulseHitRow(row);
      onFocusHandled?.();
      return true;
    };
    if (scrollToStr()) return;
    // 增量拉取够不着它（比首屏窗口更早）：先按「载入更早」那一路把它补进来。
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (scrollToStr() || tries > 8) {
        window.clearInterval(timer);
        if (!scrollToStr()) {
          addNotice("这句话在这段会话的更早处，先点「载入更早的消息」再跳", { info: true });
          onFocusHandled?.();
        }
      }
    }, 260);
    return () => window.clearInterval(timer);
  }, [focusMessageId, loaded, onFocusHandled, addNotice, pulseHitRow]);

  // 宿主的暂停态（助手弹窗关闭＝收进 display:none）与唤醒
  useEffect(() => {
    pausedRef.current = !!paused;
    // 沉睡期整条链没跑，lastIdRef 落后了一截：只在「暂停→可见」这个跳变上补一拍
    if (wasPausedRef.current && !paused) void pullRef.current?.();
    wasPausedRef.current = !!paused;
  }, [paused]);

  /**
   * 事件总线：服务端推下来的「联系人那边发生了什么」——空闲（没有在飞处理单、页面可见）时
   * 立刻做**增量**拉取，把「联系人回的话 / 主动说的话」从 2.5~10s 的轮询退避提前到事件到达。
   * 一轮在飞时由 watch 那拍负责消息列表，这里整拍跳过，避免两个轮询者打架。
   * 只拉自己这一屏的联系人（作用域与 send/读光口同一套 cid ?? msgScope）；
   * 全量重绘仍归 watch / 编辑那些显式动作，总线只补增量那一小块。
   */
  useEffect(() => {
    const onEvent = (event: import("../../lib/eventBus").BusEvent): void => {
      const scope = cidRef.current ?? msgScopeRef.current;
      // ── 流式草稿帧：正文的主到达通道 ──
      // 服务端按 200ms 节流推 delta（前缀续写）/快照（改口）。只认当前在飞那一轮；
      // 其它标签页/联系人的帧由它们各自的 watch 消费（服务端广播，客户端各取所需）。
      if (event.type === "draft" || event.type === "thought") {
        const tid = pendingTurnRef.current;
        if (tid === null || event.turnId !== tid || event.contactId !== scope) return;
        // 有帧就锚定本轮：与 watch 全量拍里 `if (turn.reply || turn.reasoning)` 的写入
        // 同一语义。不锚的话（总线主路下首拍通常还没内容、后续全是 lean 拍，两处都
        // 写不进），草稿思考面板整轮拿到受控 open=false——点开展不开，自动展开的
        // effect 也因为没有 turnId 而空转（「思考时打不开」的根因）。
        if (draftTurnRef.current !== tid) draftTurnRef.current = tid;
        const ref = event.type === "draft" ? draftStreamRef : thoughtStreamRef;
        const cur = ref.current;
        if (event.seq <= cur.seq) return; // 迟到/重复帧
        let next: string;
        if (event.text !== undefined) {
          next = event.text; // 快照：首帧或工具轮改口，整段替换
        } else if (event.seq === cur.seq + 1 && cur.text !== null) {
          next = cur.text + (event.delta ?? ""); // 连续增量
        } else {
          // 断档（重连丢帧）：本地不猜，标记回源并立刻拍一拍对齐。
          cur.seq = event.seq;
          cur.text = null;
          streamResyncRef.current = true;
          wakeWatchRef.current?.();
          return;
        }
        cur.text = next;
        cur.seq = event.seq;
        if (event.type === "draft") setStreamText(next);
        else setStreamReasoning(next);
        return;
      }
      // ── 收尾事件插队：done/failed/cancelled 立即收尾拍，不等轮询间隔 ──
      if (event.type === "turn" && event.turnId === pendingTurnRef.current) {
        if (event.status !== "running" && event.status !== "queued") wakeWatchRef.current?.();
        return;
      }
      if (event.type === "sync") {
        // 重连对齐帧：在飞轮的流式帧可能断了几帧，标记回源并立即拍；
        // 空闲时整段拉一次补齐推送前漏掉的。
        if (pendingTurnRef.current !== null) {
          streamResyncRef.current = true;
          wakeWatchRef.current?.();
          return;
        }
        if (!asleep()) void pullRef.current?.();
        return;
      }
      if ("contactId" in event && event.contactId !== scope) return;
      if (pendingTurnRef.current !== null) return; // 在飞轮交给 watch
      if (asleep()) return;
      idleTicksRef.current = 0; // 有动静：让下一拍轮询回到最快档
      void pullRef.current?.();
    };
    return onBusEvent(onEvent);
  }, []);

  // 滚动跟随：只在用户本来贴着底部时才自动滚
  useLayoutEffect(() => {
    if (stickRef.current) scrollDown(true);
  }, [nodes, typing, notices, editingId, streamReasoning, scrollDown]);

  // 草稿逐字那一档必须**瞬时**落底：走 smooth 的话动画被 30 次/秒重启，永远追不完，
  // 整页看着在慢慢往上爬——这就是用户报的「一直把气泡向上顶」。
  useLayoutEffect(() => {
    if (stickRef.current) scrollDown(true, true);
  }, [draftShown, scrollDown]);

  // 用户一碰就放手：滚轮 / 触摸拖动。键盘 ↑↓ 不用管——那本来就会把焦点行推出 120px 宽限，
  // onScroll 自己就不贴住了。
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const takeOver = (): void => { userHoldRef.current = true; stickRef.current = false; };
    el.addEventListener("wheel", takeOver, { passive: true });
    el.addEventListener("touchmove", takeOver, { passive: true });
    return () => {
      el.removeEventListener("wheel", takeOver);
      el.removeEventListener("touchmove", takeOver);
    };
  }, []);

  // 消息里的图片是异步解码的：落底那一帧它还没占位，撑大之后 scrollTop 就离底了。
  // load 不冒泡，用捕获阶段接住 #log 内任何一张图的解码完成；贴着底就补一跳。
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onLoad = (): void => { if (stickRef.current) scrollDown(true); };
    el.addEventListener("load", onLoad, true);
    return () => el.removeEventListener("load", onLoad, true);
  }, [scrollDown]);

  // 链接卡/展开详情是异步长高的，不会触发上面那条 load。卡片自己用 ResizeObserver
  // 广播 CHAT_RESIZE_EVENT；这里按同一口径补一跳，避免最新内容被顶到视口外。
  useEffect(() => {
    const onResize = (): void => { if (stickRef.current) scrollDown(true); };
    window.addEventListener(CHAT_RESIZE_EVENT, onResize);
    return () => window.removeEventListener(CHAT_RESIZE_EVENT, onResize);
  }, [scrollDown]);

  // ── 消息菜单的关闭时机（点别处 / Esc / 滚动 / 改窗口尺寸） ──
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest(".msgmenu")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setMenu(null); };
    // 菜单按视口坐标定位，一滚就飘 → 收起。但"开菜单"这个动作本身可能带一次滚动
    // （贴底跟随、长按置顶），那一发不算用户滚的，给它一帧多的余量。
    const onScroll = (): void => { if (Date.now() - menuOpenedAt.current > 300) setMenu(null); };
    const onResize = (): void => setMenu(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [menu]);

  // Ctrl/Cmd+F 在会话里优先打开“会话内搜索”；联系人列表页仍走 App 的 Ctrl+F。
  useEffect(() => {
    const open = (): void => setSearchOpen(true);
    window.addEventListener("xiaomo:chat-search", open);
    return () => window.removeEventListener("xiaomo:chat-search", open);
  }, []);

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
    else { setSearchQ(""); setSearchHits([]); setSearchIdx(0); setSearchErr(""); }
  }, [searchOpen]);

  useEffect(() => {
    const q = searchQ.trim();
    if (!searchOpen || q === "") {
      setSearchHits([]); setSearchIdx(0); setSearchBusy(false); setSearchErr("");
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearchBusy(true);
    const timer = window.setTimeout(() => {
      void chatApi.searchMessages(q, cid, conversationId)
        .then((d) => {
          if (seq !== searchSeqRef.current) return;
          setSearchHits(d.messages);
          setSearchIdx(0);
          setSearchErr("");
          const first = d.messages[0];
          if (first) window.setTimeout(() => searchJumpRef.current(first), 0);
        })
        .catch((error: Error) => {
          if (seq !== searchSeqRef.current) return;
          setSearchHits([]);
          setSearchErr(error.message);
        })
        .finally(() => { if (seq === searchSeqRef.current) setSearchBusy(false); });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [cid, searchOpen, searchQ]);

  const mapNodes = useMemo<ChatMapNode[]>(() => msgs.flatMap((m) => {
    if (m.superseded_at !== null || m.kind === "tool") return [];
    const text = String(m.text || "").replace(/\s+/g, " ").trim();
    const hasImage = (m.attachments?.length ?? 0) > 0;
    const preview = text || (hasImage ? "图片" : "");
    if (!preview) return [];
    return [{
      id: m.id,
      role: m.role === "user" ? "user" as const : "assistant" as const,
      preview: preview.length > 34 ? preview.slice(0, 34) + "…" : preview,
      day: dayLabel(m.created_at),
      kind: m.kind,
      hasImage,
    }];
  }).slice(-400), [msgs]);

  const focusMessage = useCallback((id: number): boolean => {
    const row = logRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!row) return false;
    stickRef.current = false;
    userHoldRef.current = true;
    scrollSeqRef.current += 1;         // 「去别处」的显式滚动：叫停正在跑的落底收敛
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    pulseHitRow(row);
    return true;
  }, [pulseHitRow]);

  const jumpToSearchHit = useCallback((hit: MessageRow): void => {
    if (focusMessage(hit.id)) return;
    setSearchBusy(true);
    void chatApi.fetchMessagesAround(hit.id, cid, conversationId)
      .then((d) => {
        // 按 id 合并，不是整表替换：命中很早的一条时窗口装不下整段会话，替换会把
        // 窗口外已加载的消息全丢掉——增量拉取只认 id > 水位，永远补不回来，
        // 看起来就是"后面的聊天记录没了"。合并保住已加载的所有页，窗口行照常落位。
        setMsgs((prev) => mergeRows(prev, d.messages));
        setOlderLeft(d.olderRemaining);
        stickRef.current = false;
        userHoldRef.current = true;
        setAtBottom(false);
        setSearchFocusId(hit.id);
      })
      .catch((error: Error) => setSearchErr("跳转失败：" + error.message))
      .finally(() => setSearchBusy(false));
  }, [cid, focusMessage]);
  searchJumpRef.current = jumpToSearchHit;

  useEffect(() => {
    if (searchFocusId === null || !loaded) return;
    const timer = window.setTimeout(() => {
      if (focusMessage(searchFocusId)) setSearchFocusId(null);
    }, 30);
    return () => window.clearTimeout(timer);
  }, [searchFocusId, loaded, msgs, focusMessage]);

  useEffect(() => {
    if (!mapOpen) return;
    const update = (): void => {
      if (mapRafRef.current !== null) return;
      mapRafRef.current = requestAnimationFrame(() => {
        mapRafRef.current = null;
        const log = logRef.current;
        if (!log) return;
        const rect = log.getBoundingClientRect();
        const anchor = rect.top + rect.height * 0.38;
        const rows = [...log.querySelectorAll<HTMLElement>("[data-id]")];
        // 行按时间升序，直接二分找第一条跨过视口锚点的消息；滚动到底也不会线性扫 500 行。
        let lo = 0;
        let hi = rows.length - 1;
        let id: number | null = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const row = rows[mid];
          if (!row) break;
          if (row.getBoundingClientRect().bottom < anchor) lo = mid + 1;
          else {
            const next = Number(row.dataset.id);
            if (Number.isFinite(next)) id = next;
            hi = mid - 1;
          }
        }
        if (id !== null) setMapActiveId(id);
      });
    };
    update();
    const log = logRef.current;
    log?.addEventListener("scroll", update, { passive: true });
    return () => {
      log?.removeEventListener("scroll", update);
      if (mapRafRef.current !== null) cancelAnimationFrame(mapRafRef.current);
      mapRafRef.current = null;
    };
  }, [mapOpen, msgs.length]);

  const stepSearch = useCallback((delta: number): void => {
    if (searchHits.length === 0) return;
    const next = (searchIdx + delta + searchHits.length) % searchHits.length;
    const hit = searchHits[next];
    if (!hit) return;
    setSearchIdx(next);
    jumpToSearchHit(hit);
  }, [jumpToSearchHit, searchHits, searchIdx]);

  const openMenu = useCallback((m: MessageRow, x: number, y: number): void => {
    menuOpenedAt.current = Date.now();
    // 锚定到气泡本体：菜单悬在它上方、箭头指着它（微信式），拿不到矩形才退回点击点。
    const row = logRef.current?.querySelector(`[data-id="${m.id}"]`);
    const b = (row?.querySelector(".bubble") ?? row) as HTMLElement | null;
    const r = b?.getBoundingClientRect();
    const anchor = r && r.width > 0
      ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 }
      : null;
    setMenu({ m, x, y, anchor });
  }, []);

  const [proactiveBusy, setProactiveBusy] = useState(false);
  const proactivePullTimer = useRef<number | null>(null);
  const runProactive = useCallback((): void => {
    if (proactiveBusy) return;
    setProactiveBusy(true);
    proactiveApi.runProactiveCheck()
      .then(() => addNotice(`已触发主动检查，${characterName}说完话会出现在这里`, { info: true }))
      .catch((error: Error) => addNotice("触发失败：" + error.message, { info: true }))
      .then(() => {
        setProactiveBusy(false);
        // 检查在后台跑：立刻拉一次，3 秒后再拉一次兜住落库的主动消息。
        void pullRef.current?.();
        if (proactivePullTimer.current !== null) clearTimeout(proactivePullTimer.current);
        proactivePullTimer.current = window.setTimeout(() => {
          proactivePullTimer.current = null;
          void pullRef.current?.();
        }, 3000);
      });
  }, [addNotice, proactiveBusy]);

  // 卸载时把那个 3 秒兜底拉取掐掉：不然它会对着已经不存在的实例再发一次请求。
  useEffect(() => () => { if (proactivePullTimer.current !== null) clearTimeout(proactivePullTimer.current); }, []);

  /** 把 textarea 撑到刚好包住内容。上限一律交给 CSS 的 max-height：
      这里再写一个数字就会和样式里那个打架，两处都改不动的时候，超出的部分
      被 overflow 截掉，长文本的尾巴根本摸不到。 */
  const autoGrow = useCallback((el: HTMLTextAreaElement | null): void => {
    // 拖动过输入区上边框之后不再干预：否则下一次按键就把拖出来的高度按回内容高度，
    // 拖了也白拖。
    if (!el || manualHRef.current) return;
    // 交回 CSS 那道 max-height：手动拖的时候它被内联放开过（见 onGripMove），
    // 复位时不擦掉的话，自动撑高就再也没有上限了。
    el.style.maxHeight = "";
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
    // 顺手把把手的 ARIA 值也报准（自动撑高时它也变）。编辑框是另一棵 textarea，
    // 那条不归这个把手管，别拿它的高度去写。
    if (el === iptRef.current) syncGripAria(el.offsetHeight);
  }, []);

  // 恢复出来的草稿可能是好几行，而 textarea 的 rows 只是初值：挂载时撑一次，
  // 否则换人回来看到的是"草稿只剩一行半，其余在框里滚着"。
  useLayoutEffect(() => { autoGrow(iptRef.current); }, [autoGrow]);

  // 进入编辑态时：把已有内容撑开、光标落到末尾。textarea 的 rows 只是初值，
  // 不主动撑一次，长消息一进来就被截成三行，看着像内容少了。
  const editBoxRef = useCallback((el: HTMLTextAreaElement | null): void => {
    if (!el) return;
    autoGrow(el);
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoGrow]);

  /** 输入区上边框被拖动过：此后的高度归用户，autoGrow 收手（见 onGripDown）。
      拖一次就定住，不随草稿清空而复位——那是面板该有的样子。 */
  const manualHRef = useRef(false);
  /** 拖动把手那个 div：ARIA 值要命令式往上写（见 syncGripAria）。 */
  const gripElRef = useRef<HTMLDivElement | null>(null);
  /** 拖动把手改输入区高度。指针往下走 = 变高，夹在 CSS 的 min-height 与
      「视口留一半给消息流」之间；后者比 CSS 那道 max-height（自动撑高的闸）
      宽一档，专门伺候"我想写长一点"的场合。 */
  const gripRef = useRef<{ y0: number; h0: number } | null>(null);

  const clampComposerH = (h: number): number => {
    const el = iptRef.current;
    if (!el) return h;
    const cs = getComputedStyle(el);
    const min = parseFloat(cs.minHeight) || 64;
    const max = Math.round(Math.min(420, window.innerHeight * 0.55));
    return Math.min(max, Math.max(min, Math.round(h)));
  };

  /** 把当前高度写进把手的 ARIA 值。用命令式而不是 state：拖动时每帧都改，
     走 state 会连带着整个 ChatView 重渲染，消息流白白抖一遍。 */
  const syncGripAria = (h: number): void => {
    const g = gripElRef.current;
    if (!g) return;
    const cs = getComputedStyle(iptRef.current!);
    const min = parseFloat(cs.minHeight) || 64;
    const max = Math.round(Math.min(420, window.innerHeight * 0.55));
    g.setAttribute("aria-valuenow", String(h));
    g.setAttribute("aria-valuemin", String(min));
    g.setAttribute("aria-valuemax", String(max));
  };

  const applyComposerH = (h: number): void => {
    const el = iptRef.current;
    if (!el) return;
    const v = clampComposerH(h);
    // max-height 一并内联放开：CSS 那道 160px 是给自动撑高设的闸，
    // 手动拖的时候让它继续生效，拖柄就会在 160px 处"打滑"。
    el.style.maxHeight = v + "px";
    el.style.height = v + "px";
    syncGripAria(v);
  };

  const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = iptRef.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gripRef.current = { y0: e.clientY, h0: el.offsetHeight };
    manualHRef.current = true;
  };

  const onGripMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = gripRef.current;
    const el = iptRef.current;
    if (!d || !el) return;
    // 把手压的是输入区的**上**边框：往上拖 = 顶边上移 = 输入区变高。
    // 别写成 (clientY - y0)——那是下边框的算法，用在这儿方向整个是反的。
    const h = clampComposerH(d.h0 + (d.y0 - e.clientY));
    // max-height 一并内联放开：CSS 那道 160px 是给自动撑高设的闸，
    // 手动拖的时候让它继续生效，拖柄就会在 160px 处"打滑"。
    applyComposerH(h);
  };

  const onGripUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (gripRef.current === null) return;
    gripRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // 键盘也能调：↑↓ 跟着拖动走——↑ 把上边框往上推（变高），↓ 往下拉（变矮）。
  // Home/End 顶到两头，Enter/空格 交回自动。
  const onGripKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = iptRef.current;
    if (!el) return;
    const step = e.shiftKey ? 32 : 8;
    let next: number | null = null;
    if (e.key === "ArrowUp") next = el.offsetHeight + step;
    else if (e.key === "ArrowDown") next = el.offsetHeight - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 9999;
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); manualHRef.current = false; autoGrow(el); return; }
    else return;
    e.preventDefault();
    manualHRef.current = true;
    applyComposerH(next);
  };

  // ── 多媒体动作 ───────────────────────────────────────────
  // 拉不到就保持保守值（入口不显示）：这与之前的行为一致，只是不再每个会话实例各拉一份。
  useEffect(() => {
    loadCaps().then(setCaps).catch(() => {});
  }, []);

  /** 图片入附件条：选择器与剪贴板粘贴共用。最多 6 张，超出的静默丢弃并提示。 */
  const uploadFiles = (files: File[]): void => {
    const room = MAX_CHAT_IMAGES - imgsRef.current.length;
    if (files.length === 0) return;
    if (!canModelSeeImages) {
      addNotice("当前模型看不到图片内容；图片仍会保存在聊天记录里", { info: true });
    }
    if (room <= 0) { addNotice(`一条消息最多 ${MAX_CHAT_IMAGES} 张图片`, { info: true }); return; }
    setUploading(true);
    void Promise.all(files.slice(0, room).map(async (file) => {
      const blob = await fileToImageBlob(file);
      const { url } = await chatApi.uploadImage(blob);
      return url;
    }))
      .then((urls) => {
        imgsRef.current = [...imgsRef.current, ...urls].slice(0, MAX_CHAT_IMAGES);
        setImgs([...imgsRef.current]);
      })
      .catch(() => addNotice("图片没传上去，稍后再试", { info: true }))
      .finally(() => setUploading(false));
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    uploadFiles(files);
  };

  /** 编辑态里换图：与发送前的附件同一套上传流程，只是落到 editImgs。 */
  const uploadEditFiles = (files: File[]): void => {
    if (files.length === 0) return;
    if (!canModelSeeImages) {
      addNotice("当前模型看不到图片内容；图片仍会保存在聊天记录里", { info: true });
    }
    const room = MAX_CHAT_IMAGES - editImgs.length;
    if (room <= 0) { addNotice(`一条消息最多 ${MAX_CHAT_IMAGES} 张图片`, { info: true }); return; }
    void Promise.all(files.slice(0, room).map(async (file) => {
      const blob = await fileToImageBlob(file);
      const { url } = await chatApi.uploadImage(blob);
      return url;
    }))
      .then((urls) => setEditImgs((prev) => [...prev, ...urls].slice(0, MAX_CHAT_IMAGES)))
      .catch(() => addNotice("图片没传上去，稍后再试", { info: true }));
  };

  /** 编辑框里粘贴图片：与输入框同一条上传链路，落到 editImgs。粘贴是编辑态唯一的加图入口。 */
  const onPasteEditFiles = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    uploadEditFiles(files);
  };

  const onPasteFiles = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    uploadFiles(files);
  };

  const removeImg = (url: string): void => {
    imgsRef.current = imgsRef.current.filter((u) => u !== url);
    setImgs([...imgsRef.current]);
  };

  const stopAudio = useCallback((): void => {
    stopExclusiveAudio();
    setPlayingId(null);
  }, []);

  /** 合成请求的代次：连点两条时只认最后一次，早先那份音频直接丢弃。 */
  const ttsSeqRef = useRef(0);
  const playTts = useCallback((m: MessageRow): void => {
    if (playingId === m.id) { stopAudio(); return; }
    stopAudio();
    const seq = ++ttsSeqRef.current;
    setTtsBusyId(m.id);
    chatApi.synthesize(m.text)
      .then((d) => {
        // 合成要一两秒，期间点了别条：这一份必须丢。不然两段语音叠着播，
        // 而 audioRef 只指得到后一段，前一段再也停不下来。
        if (seq !== ttsSeqRef.current) return;
        setTtsBusyId(null);
        stopAudio();
        setPlayingId(m.id);
        const audio = playExclusiveAudio(d.dataUrl, {
          onEnded: () => setPlayingId(null),
          onError: () => { setPlayingId(null); addNotice("音频播放失败", { info: true }); },
        });
        audio.onpause = () => setPlayingId(null);
      })
      .catch(() => {
        if (seq !== ttsSeqRef.current) return;
        setTtsBusyId(null);
        addNotice("没合成语音，稍后再试", { info: true });
      });
  }, [addNotice, playingId, stopAudio]);

  const clearRecTimers = (): void => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    if (waveTimerRef.current) { clearInterval(waveTimerRef.current); waveTimerRef.current = null; }
  };

  const stopWaveMeter = (): void => {
    if (waveTimerRef.current) { clearInterval(waveTimerRef.current); waveTimerRef.current = null; }
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => { /* 浏览器回收时忽略 */ });
  };

  const finishRecording = (action: "cancel" | "voice" | "transcribe"): void => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    recActionRef.current = action;
    rec.stop();
  };

  const startRecording = useCallback(async () => {
    if (recorderRef.current || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      addNotice("当前浏览器不支持录音", { info: true });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      addNotice("用不了麦克风，请在浏览器里允许录音", { info: true });
      return;
    }
    const rec = new MediaRecorder(stream);
    recChunksRef.current = [];
    recWaveRef.current = [];
    recStartedRef.current = Date.now();
    rec.ondataavailable = (e): void => { if (e.data.size > 0) recChunksRef.current.push(e.data); };
    rec.onstop = (): void => {
      clearRecTimers();
      stopWaveMeter();
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      setRecSec(null);
      const action = recActionRef.current;
      recActionRef.current = "voice";
      if (action === "cancel") return;
      const blob = new Blob(recChunksRef.current, { type: rec.mimeType || "audio/webm" });
      if (blob.size === 0) { addNotice("录音是空的", { info: true }); return; }
      const owner = cidRef.current;
      if (action === "transcribe") {
        setTranscribing(true);
        blobToDataUrl(blob)
          .then((dataUrl) => chatApi.transcribe(dataUrl))
          .then((d) => {
            if (cidRef.current !== owner) return;
            setDraft((prev) => (prev && d.text ? prev + " " + d.text : d.text || prev));
            if (d.text) addNotice("转文字完成，可编辑后发送", { info: true });
            else addNotice("没听清内容", { info: true });
            autoGrow(iptRef.current);
          })
          .catch((error: Error) => addNotice("识别失败：" + error.message, { info: true }))
          .finally(() => setTranscribing(false));
        return;
      }

      // 发送语音：先上传原始录音，再并行做转写。转写失败不影响“语音已经发出去”这件事。
      setVoiceBusy(true);
      const durationMs = Math.max(500, Math.min(60_000, Date.now() - recStartedRef.current));
      const samples = recWaveRef.current.filter((n) => Number.isFinite(n)).slice(-48);
      const waveform = samples.length >= 8 ? samples : Array.from({ length: 28 }, (_, i) => 0.2 + Math.abs(Math.sin(i * 1.37)) * 0.55);
      const transcriptTask = caps.speechToText
        ? blobToDataUrl(blob).then((dataUrl) => chatApi.transcribe(dataUrl)).catch(() => ({ text: "" }))
        : Promise.resolve({ text: "" });
      Promise.all([chatApi.uploadVoice(blob), transcriptTask])
        .then(([uploaded, recognized]) => {
          if (cidRef.current !== owner) return;
          const transcript = recognized.text.trim();
          const meta: MessageAttachmentMeta = {
            url: uploaded.url,
            kind: "audio",
            mime: uploaded.mime,
            durationMs,
            waveform,
            ...(transcript ? { transcript } : {}),
            source: "recorded",
          };
          send(transcript || "（用户发来一条语音消息）", {
            attachments: [uploaded.url],
            attachmentMeta: [meta],
            voice: meta,
          });
          if (caps.speechToText && !transcript) addNotice("语音已发送，这次没转成文字", { info: true });
        })
        .catch((error: Error) => addNotice("语音没发出去：" + error.message, { info: true }))
        .finally(() => setVoiceBusy(false));
    };
    recorderRef.current = rec;
    rec.start();
    setRecSec(0);
    clearRecTimers();
    recTimerRef.current = setInterval(() => {
      const sec = Math.round((Date.now() - recStartedRef.current) / 1000);
      setRecSec(sec);
      if (sec >= 60) finishRecording("voice");
    }, 500);

    // 真实波形：从 MediaStream 取时域 RMS，不额外播放声音。失败时退回装饰波形。
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.fftSize);
      waveTimerRef.current = setInterval(() => {
        const current = analyserRef.current;
        if (!current) return;
        current.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) { const x = (value - 128) / 128; sum += x * x; }
        const rms = Math.sqrt(sum / data.length);
        recWaveRef.current.push(Math.min(1, Math.max(0.1, rms * 4.2)));
      }, 120);
    } catch { /* 波形只是增强，拿不到不影响录音 */ }
  }, [addNotice, autoGrow, caps.speechToText, send]);

  useEffect(() => () => {
    finishRecording("cancel");
    clearRecTimers();
    stopWaveMeter();
    // 先作废在飞的合成代次：卸载时 audioRef 还是 null（音频尚未创建），stopAudio 停不到东西，
    // 随后返回的 dataUrl 会照样 new Audio().play() —— 变成没有 UI 能停的孤儿语音。
    ttsSeqRef.current += 1;
    stopAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 助手弹窗收起（paused）时 ChatView 并不卸载，上面那条卸载清理也就不会跑：
   * 正在播的语音和还没回来的合成都得在这里作废，否则弹窗藏起来了声音还在放，
   * 而「停止」按钮已经够不到了。
   */
  useEffect(() => {
    if (!paused) return;
    ttsSeqRef.current += 1;
    stopAudio();
  }, [paused, stopAudio]);

  /** 每次渲染新建的函数/对象会直接把子组件的 memo 击穿。 */
  const openZoom = useCallback((url: string): void => { setZoom(url); }, []);

  /**
   * 消息流的键盘走位：整个 #log 只占**一个** Tab 停靠点，↑↓ 在消息行之间移动，
   * Enter/空格打开当前这条的菜单。
   * 从前是每条气泡各自 tabIndex=0（首屏 500 条 = 按 500 次 Tab 才到输入框，
   * 而那些 div 既没有 role 也没有可访问名，读屏只会念 500 次「未命名」）。
   */
  const rowNav = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const box = e.currentTarget;
    // 焦点落在气泡里的按钮/链接/思考折叠条上时，方向键与回车归那个控件自己管
    const target = e.target as HTMLElement;
    if (target !== box && target.closest("summary, button, a, input, textarea, [role=\"textbox\"]")) return;
    const rows = [...box.querySelectorAll<HTMLElement>("[data-id]")];
    if (rows.length === 0) return;
    const current = target === box ? null : target.closest<HTMLElement>("[data-id]");
    const at = current ? rows.indexOf(current) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (at < 0 && target !== box) return;
      e.preventDefault();
      const next = at < 0
        ? (e.key === "ArrowDown" ? 0 : rows.length - 1)
        : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
      scrollSeqRef.current += 1; // 键盘走位也是「去别处」：focus 会自动滚，别让落底收敛跟它抢
      rows[next]?.focus({ preventScroll: false });
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && at >= 0 && current) {
      const m = msgs.find((x) => x.id === Number(current.dataset.id));
      if (!m) return;
      e.preventDefault();
      const r = current.getBoundingClientRect();
      openMenu(m, r.left + r.width / 2, r.top + r.height / 2);
    }
  }, [msgs, openMenu]);

  const renderNode = (n: ListNode): JSX.Element | null => {
    switch (n.t) {
      case "daysep": return <div key={"d" + n.day} className="daysep">{n.label}</div>;
      case "stale": return (
        <details key={"s" + (n.items[0]?.id ?? 0)} className="staleGroup">
          <summary>{n.items.length} 条已被编辑取代 · 展开</summary>
          <div className="body">
            {n.items.map((m) => (
              <div key={m.id} className={"msg-row " + (m.role === "user" ? "me" : "contact") + " gap"}>
                <div className="bubble">{m.text}</div>
              </div>
            ))}
          </div>
        </details>
      );
      /* 联系人正在写的这一句。按纯文本渲染、不走 Markdown：半截的 ** 或代码围栏解析出来
         就是乱码，定稿那一拍由真气泡按 Markdown 重画。光标一直在：轮询是一跳一跳的，
         没有它每次跳完就是 1 秒死区，看着像卡住。本轮气泡一上屏（draftRetired）草稿就
         退场，剩下的"还有话要来"回到三个点。位置见 nodes：跟着它那一轮走。 */
      case "draft": return (
        <div key="draft" className="msg-row contact gap" id="typingRow">
          <Avatar className="msg-ava" src={contactAvatar || undefined} name={characterName} style={avatarToneStyle(characterName)} />
          <div className="bubble">
            {streamReasoning !== "" && (
              <ThinkingBlock reasoning={streamReasoning} live={draftShown === ""} persistKey={draftTurnRef.current ?? undefined}
                open={draftTurnRef.current ? (thinkingOpenTurns[draftTurnRef.current] ?? true) : false}
                onOpenChange={(open) => { const turnId = draftTurnRef.current; if (turnId) setThinkingOpen(turnId, open); }} />
            )}
            {streamReveal && draftShown !== ""
              ? <span className="draft-text">{draftShown}{(typing || !reveal.done) && <span className="draft-caret" aria-hidden="true" />}</span>
              : streamReasoning === "" && thinkingLive
                ? <ThinkingLive />
                : streamReasoning === ""
                  ? <span className="typing"><i /><i /><i /></span>
                  : null}
          </div>
        </div>
      );
      case "pending": return (
        /* 乐观气泡就是"我刚发出去"那一下的入场，补上 .msg-enter 让点按与上屏连成一拍。 */
        <div key={"p" + n.id} className="msg-row me gap msg-enter">
          <div className={"bubble" + (n.voice ? " voice-only" : n.imgs.length > 0 && !n.text ? " img-only" : "") + (n.failed ? " pend-failed" : "") + (!n.failed && !n.queued ? " pend-going" : "")}>
            {/* 在途指示：已发出、回执未到的几秒里气泡不该是视觉真空。与「待发送
                （离线队列，黄字整行）」「失败（红叹号 + 重试）」是三种语义——它只说
                "在路上"，不代表任何问题，所以只是一颗呼吸圆点，不出现在前两种态里。 */}
            {!n.failed && !n.queued && <span className="pend-flight" aria-hidden="true" title="发送中" />}
            {n.voice && (
              <VoiceMessageBubble url={n.voice.url} durationMs={n.voice.durationMs}
                waveform={n.voice.waveform} transcript={n.voice.transcript} />
            )}
            {!n.voice && n.imgs.length > 0 && (
              <div className={"msg-imgs" + (n.imgs.length === 1 ? " single" : "")}>
                {n.imgs.map((url) => <img key={url} src={url} alt="" />)}
              </div>
            )}
            {!n.voice && n.text && <div className="msg-text">{n.text}</div>}
            {n.queued && (
              <div className="pend-queue">
                <span>待发送 · 联网后自动发出</span>
                <button type="button" className="retry" onClick={(e) => { e.stopPropagation(); retryPending(n.id); }}>立即重试</button>
              </div>
            )}
            {n.failed && (
              <div className="pend-fail">
                <span>没发出去</span>
                <button type="button" className="retry" onClick={(e) => { e.stopPropagation(); retryPending(n.id); }}>重试</button>
              </div>
            )}
          </div>
          <Avatar className="msg-ava mine" src={ownerAvatar || undefined} name={ownerName || "我"} />
        </div>
      );
      // 空会话才给欢迎语；「还没拉到消息」不是空会话，先渲染它等于自己制造一次闪换
      case "intro": return loaded ? (
        <div key="intro" id="intro">
          <div className="hi">{characterName}</div>
          {cid ? (
            <div>不会的尽管问我。</div>
          ) : (
            <div>发第一条消息开始，聊过的联系人都会记得。</div>
          )}
          {!onboardingDone && (
            <OnboardingChecklist ownerName={ownerName} modelReady={modelReady === true} caps={caps}
              personaIsDefault={personaIsDefault} onOpen={onOpenOnboarding}
              onFinished={() => setOnboardingDone(true)} />
          )}
          <div className="chips">
            {(cid
              ? [introChip ?? "怎么开始用？", "我还需要设置什么？", "给新联系人配好模型"]
              : ["我今天加班到很晚", "周末想去看电影", "你还记得我上次说过什么吗"]
            ).map((chip) => (
              <button key={chip} type="button" className="chip" title="填入输入框，可先改再发"
                onClick={() => { setDraft(chip); iptRef.current?.focus(); }}>{chip}</button>
            ))}
          </div>
          {!cid && onOpenSection && (
            <div className="linkline">
              <button type="button" onClick={() => onOpenSection("memory")}>查看记忆 →</button>
            </div>
          )}
        </div>
      ) : null;
      case "tool":
        return <ToolCard key={n.m.id} m={n.m} imagesOnly={!showTools}
          contactAvatar={contactAvatar} contactName={characterName} onImageClick={openZoom} />;
      case "msg": {
        const m = n.m;
        // 单条逐字期间，同轮定稿气泡已经在库里/列表里了，但必须等草稿打完再露出来。
        if (draftTyping && m.role === "assistant" && m.kind === "chat" && m.turn_id === draftTurnRef.current) return null;
        if (editingId === m.id) {
          const mine = m.role === "user";
          return (
            /* 头像列照常渲染：编辑框是「顶替这一条气泡」的，缺了头像列就会
               比周围气泡横移半个头像宽，看起来像跳了一格。
               data-id 也不能少——进入编辑态要靠它把这一条滚进视口。 */
            <div key={m.id} className={"msg-row editing gap " + (mine ? "me" : "contact")} data-id={m.id}>
              {!mine && <Avatar className="msg-ava" src={contactAvatar || undefined} name={characterName} style={avatarToneStyle(characterName)} />}
              <div className="editbox">
                <div className="editbox-head">
                  <div className="editbox-heading">
                    <span className="editbox-title"><Pencil size={13} strokeWidth={1.9} />编辑{mine ? "我的消息" : "这条回复"}</span>
                    <span className="editbox-mode">{editTextOnly ? "仅改文字 · 后续保留" : mine ? "保存后重答这一轮 · 旧回答留成版本" : "仅修改文本 · 不重新生成"}</span>
                  </div>
                  <button type="button" className="editbox-close" title="取消编辑" aria-label="取消编辑" onClick={cancelEdit}>
                    <X size={15} />
                  </button>
                </div>
                {editImgs.length > 0 && (
                  /* 与气泡同序：图在上、文字在下（MessageRow 就是先 msg-imgs 后 msg-text）。
                     不设"添加图片"按钮——粘贴是编辑态唯一的加图入口。
                     只改文字模式下图片原样不动，所以不给移除按钮：能点却保存不了更坑人。 */
                  <div className="attach-strip">
                    {editImgs.map((u) => (
                      <div key={u} className="attach-item">
                        <img src={u} alt="" />
                        {!editTextOnly && (
                          <button type="button" aria-label="移除图片"
                            onClick={() => setEditImgs((prev) => prev.filter((x) => x !== u))}><X size={12} /></button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {editTextOnly && (
                  <div className="edit-note">只改这句文字，后面的对话和图片都原样保留。</div>
                )}
                <textarea
                  rows={3} autoFocus value={editDraft} ref={editBoxRef}
                  placeholder="编辑消息内容…"
                  onChange={(e) => { setEditDraft(e.target.value); autoGrow(e.target); }}
                  onPaste={onPasteEditFiles}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelEdit();
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitEdit();
                  }}
                />
                <div className="editbox-foot">
                  <span className="editbox-hint">
                    {mine
                      ? (editTextOnly ? "保存后不会重新生成回复。" : "保存后重答这一轮，旧回答留成版本；后面的对话保留。图片可直接粘贴。")
                      : "只修改这条回复的文字，不会重新生成。"}
                  </span>
                  <span className="editbox-count" aria-label={`${editDraft.length} 个字符`}>{editDraft.length}</span>
                  <span className="kbd-only editbox-kbd">Ctrl+Enter</span>
                </div>
                <div className="editbox-actions">
                  <button type="button" className="btn sm" onClick={cancelEdit}>取消</button>
                  <button type="button" className="primary sm" onClick={submitEdit}
                    disabled={(editDraft.trim() === "" && editImgs.length === 0)}>
                    <Check size={13} strokeWidth={2.3} />
                    {mine && !editTextOnly ? "保存并重新回复" : "保存修改"}
                  </button>
                </div>
              </div>
              {mine && <Avatar className="msg-ava mine" src={ownerAvatar || undefined} name={ownerName || "我"} />}
            </div>
          );
        }
        return (
          <MessageRowItem key={m.id} m={m} gap={n.gap} time={n.clock} showSpeed={speedOn}
            enter={enterIdsRef.current.has(m.id)} enterDelay={enterIdsRef.current.get(m.id) ?? 0}
            characterName={characterName} ownerName={ownerName}
            ownerAvatar={ownerAvatar} contactAvatar={contactAvatar}
            onContextMenu={openMenu} onLongPress={openMenu}
            onImageClick={openZoom}
            failed={failure && m.role === "user" && m.turn_id === failure.id ? failure : null}
            onRetry={retry}
            ttsOn={caps.textToSpeech && ttsBtnOn} onPlayTts={playTts}
            ttsPlaying={playingId === m.id} ttsBusy={ttsBusyId === m.id}
            showThinking={showThinking}
            thinkingOpen={m.turn_id ? thinkingOpenTurns[m.turn_id] : undefined}
            onThinkingOpenChange={setThinkingOpen}
            showSenderName={isGroupChat}
            variantCount={m.variant_count ?? 0}
            variantIndex={m.variant_index ?? 0}
            onVariantChange={changeVariant}
            onVariantGenerate={requestVariantGenerate}
            demo={globalModelEcho}
            highlight={searchOpen && searchHitIds.has(m.id) ? searchQ.trim() : ""} />
        );
      }
    }
  };

  return (
    <div id="chat">
      <div id="bar">
        {onBack ? (
          <button type="button" className="bar-back" onClick={onBack} aria-label="返回会话列表">
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
        ) : null}
        <div className="who-wrap">
          {onEditProfile ? (
            <button type="button" className="who-ava-btn" title="查看联系人资料" aria-label={`查看${characterName}的资料`} onClick={onEditProfile}>
              <Avatar className="who-ava" src={contactAvatar || undefined} name={characterName} style={avatarToneStyle(characterName)} />
            </button>
          ) : (
            <Avatar className="who-ava" src={contactAvatar || undefined} name={characterName} style={avatarToneStyle(characterName)} />
          )}
          <div className="who-copy">
            <div className="who">{characterName}</div>
            <div className="sub">
              <span className={"dot " + chatStatus.tone} id="dot" />
              {/* 演示模式是首启用户第一眼看到的状态——不给出口，用户就只能去翻文档。
                  who-wrap 整块是 pointer-events:none（居中标题不吃点击），所以这里单独放开这一行。 */}
              {modelReady === false && onOpenModelSettings ? (
                <button type="button" className="ctx-link stat-link" id="stat" onClick={() => onOpenModelSettings()}>
                  还没接入模型 · 去设置
                </button>
              ) : (
                <span id="stat">{chatStatus.text}</span>
              )}
              {onOpenConversation && hasGroupSources && (
                <>
                  <span className="sub-sep" aria-hidden="true">·</span>
                  <ConversationSwitcher conversations={conversations} currentId={conversationId ?? null} onSelect={onOpenConversation} />
                </>
              )}
            </div>
          </div>
        </div>
        <div className="right">
          <button type="button" className="bar-btn chat-map-toggle" aria-label="对话地图" title="对话地图"
            onClick={() => { setSearchOpen(false); setMapOpen(true); }}>
            <MapIcon size={17} />
          </button>
          {!cid && (
            <button type="button" className="bar-btn" id="proactiveBtn" disabled={proactiveBusy} aria-busy={proactiveBusy}
              aria-label="看看要不要主动开口"
              title={proactiveBusy ? "正在看…" : `现在让${characterName}看看要不要主动开口`}
              onClick={runProactive}>
              {proactiveBusy ? <Loader2 size={15} className="spin" /> : <BellRing size={15} />}
            </button>
          )}
        {onEditProfile && (
            <button type="button" data-keep-menu ref={headBtnRef}
              className={"bar-btn" + (headMenu ? " on" : "")}
              title="聊天选项" aria-label="聊天选项" aria-haspopup="menu" aria-expanded={headMenu}
              onClick={() => setHeadMenu((o) => !o)}>
              <MoreHorizontal size={17} />
            </button>
          )}
          </div>
      </div>

      {searchOpen && (
        <div className="chat-search" role="search">
          <Search size={15} strokeWidth={1.9} />
          <input
            ref={searchInputRef}
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchOpen(false);
              if (e.key === "Enter") { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
            }}
            placeholder="搜索当前会话"
            aria-label="搜索当前会话"
          />
          <span className="chat-search-count" aria-live="polite">
            {searchBusy ? "…" : searchErr ? "失败" : searchHits.length === 0 ? (searchQ.trim() ? "0" : "") : `${searchIdx + 1}/${searchHits.length}`}
          </span>
          <button type="button" className="bar-btn" disabled={searchHits.length === 0} aria-label="上一条" onClick={() => stepSearch(-1)}>
            <ChevronUp size={15} />
          </button>
          <button type="button" className="bar-btn" disabled={searchHits.length === 0} aria-label="下一条" onClick={() => stepSearch(1)}>
            <ChevronDown size={15} />
          </button>
          <button type="button" className="bar-btn" aria-label="关闭搜索" onClick={() => setSearchOpen(false)}>
            <X size={15} />
          </button>
          {searchErr && <span className="chat-search-err">{searchErr}</span>}
        </div>
      )}

      {headMenuExit.visible && onEditProfile && (
        <div className="msgmenu chatmenu-pop" data-keep-menu
          data-closing={headMenuExit.closing || undefined}
          aria-hidden={headMenuExit.closing || undefined}
          onAnimationEnd={headMenuExit.onAnimationEnd}>
          <button type="button" tabIndex={headMenuExit.closing ? -1 : undefined} onClick={() => { setHeadMenu(false); onEditProfile(); }}>
            <span className="lb"><Pencil size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />编辑资料</span>
            <span className="nt">头像 / 昵称 / 人格 / 模型</span>
          </button>
          {onOpenSection && (
            <>
              <button type="button" tabIndex={headMenuExit.closing ? -1 : undefined} onClick={() => { setHeadMenu(false); onOpenSection("memory"); }}>
                <span className="lb"><BookOpen size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />记忆</span>
                <span className="nt">联系人记得的事，可纠正可删</span>
              </button>
              <button type="button" tabIndex={headMenuExit.closing ? -1 : undefined} onClick={() => { setHeadMenu(false); onOpenSection("proactive"); }}>
                <span className="lb"><CalendarCheck size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />主动找你</span>
                <span className="nt">联系人惦记的计划</span>
              </button>
            </>
          )}
          <button type="button" tabIndex={headMenuExit.closing ? -1 : undefined} onClick={() => {
            setHeadMenu(false);
            const scope = cid ?? msgScope ?? "";
            void contactsApi.fetchContact(scope)
              .then((d) => {
                const c = d?.contact;
                if (!c) throw new Error("联系人数据读取异常");
                return exportPersonaMd(c.name, {
                  name: c.name,
                  background: c.card?.background ?? "",
                  identity: c.card?.identity ?? "",
                  relationship: c.card?.relationship ?? "",
                });
              })
              .catch(() => addNotice("没导出成，稍后再试"));
          }}>
            <span className="lb"><FileDown size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />导出人格文档</span>
            <span className="nt">导出一个文件</span>
          </button>
          {/* 内置小茉也能归档（联系人要删得先走这一步冷却期）；只有助手的工作区不该出现这个入口——
              后端也拒，但那是一句点了才看得到的报错。 */}
          {!(String(msgScope ?? "").startsWith("assistant")) && (
            <button type="button" className="danger" tabIndex={headMenuExit.closing ? -1 : undefined} onClick={(e) => {
              e.stopPropagation();
              setHeadMenu(false);
              archiveNow();
            }}>
              <span className="lb"><Archive size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />归档</span>
              <span className="nt">数据保留，做完可立刻撤销</span>
            </button>
          )}
        </div>
      )}

      {/* .empty 只服务一件事：把欢迎语垂直居中。首屏拉取期间别挂它——
          挂上就把已有缓存的行推到中间，拉到后又跳回顶部，看着就是「文字先居中再变气泡」。 */}
      {/* 包一层只为给「回到底部」那颗钮一个不随内容滚走的定位参照：
          #log 自己是滚动容器，绝对定位的子孙会跟着内容一起滚。 */}
      <div className="log-wrap">
      <div id="log" className={loaded && nodes[0]?.t === "intro" ? "empty" : ""} ref={logRef}
        role="log"
        tabIndex={0}
        aria-label="消息记录：用上下箭头在消息之间移动，回车打开这条消息的操作菜单"
        onKeyDown={rowNav}
        onScroll={() => {
          const el = logRef.current;
          const at = nearBottom();
          // 交还自动跟随只认"真正贴死在底部"（±2px）：120px 那个宽限是给我们自己的写
          // 和未读提示用的，拿它当重新贴住的判据会让用户永远拖不动。
          const pinned = !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
          if (pinned) userHoldRef.current = false;
          stickRef.current = at && !userHoldRef.current;
          setAtBottom(at);
          if (at) bottomIdRef.current = lastIdRef.current;
        }}>
        {olderLeft > 0 && msgs.length > 0 && (
          // 专用窄条控件（.load-earlier，样式在 experience.css 末尾）：此前借用建议 chip 的样式，
          // 弱可供性——悬在消息流顶部像个静态标签，点不点没把握。行为不动：仍走
          // fetchEarlierMessages + 服务端报剩余数，滚动锚定逻辑也不变。
          <div className="load-earlier-row">
            <button type="button" className="load-earlier" disabled={earlierBusy} onClick={() => {
              const first = msgs[0];
              if (!first) return;
              setEarlierBusy(true);
              void chatApi.fetchEarlierMessages(first.id, cid, conversationId).then((d) => {
                if (d.messages.length > 0) setMsgs((prev) => [...d.messages, ...prev]);
                // 还剩多少条由服务端报：从前这里用 `行数 >= 200` 反推，
                // 那个 200 与后端页大小各写一遍，改一边就悄悄翻不到底。
                setOlderLeft(d.olderRemaining ?? 0);
              }).catch(() => { addNotice("没读到更早的消息，稍后再试"); })
                .finally(() => { setEarlierBusy(false); });
            }}>{earlierBusy ? "读取中…" : `载入更早的消息（还有 ${olderLeft} 条）`}</button>
          </div>
        )}
        {/* 翻到顶了说一句总数：长会话里"上面还有没有"这件事，从前只能靠一直点按钮试。
            加载量过 EARLIEST_HINT_MIN_ROWS 才显示——短会话/新会话没翻过页，不挂这句。 */}
        {olderLeft === 0 && msgs.length >= EARLIEST_HINT_MIN_ROWS && (
          <div className="hint" style={{ textAlign: "center", margin: "2px 0 8px" }}>
            已经到最早了
          </div>
        )}
        {nodes.map(renderNode)}

        {failure && (
          <div className="notice chat-failure" role="alert">
            <span className="chat-failure-icon" aria-hidden="true">
              <AlertTriangle size={18} strokeWidth={1.9} />
            </span>
            <div className="chat-failure-copy">
              <b>{failure.empty ? "这次没有生成回复" : "这次回复没有完成"}</b>
              <span>{failure.empty ? "模型返回了空内容，可以重新生成一次。" : "可能是模型超时、网络中断或服务商限流；消息已经保留。"}</span>
            </div>
            <button type="button" className="retry"
              onClick={() => (failure.empty ? regenerateEmpty(failure.id) : retry(failure.id))}>
              <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
              {failure.empty ? "重新生成" : "重试"}
            </button>
            {failure.error && (
              <details className="notice-detail">
                <summary>技术详情</summary>
                {failure.error}
              </details>
            )}
          </div>
        )}
      </div>

      {/* 回到消息底部：往上翻历史时联系人回了一句，从前没有任何信号——人得自己滚下来找。
          带条数就是微信那个「↓ 1 条新消息」的手感。 */}
      {!atBottom && loaded && msgs.length > 0 && (
        <button type="button" className="to-bottom" aria-label="回到最新消息" title="回到最新消息"
          onClick={() => {
            stickRef.current = true;
            userHoldRef.current = false;
            bottomIdRef.current = lastIdRef.current;
            setAtBottom(true);
            scrollDown(true);
          }}>
          <ArrowDown size={17} strokeWidth={2.2} />
          {newBelow > 0 && <span className="n">{newBelow > 99 ? "99+" : newBelow}</span>}
        </button>
      )}
      </div>

      {bootErr !== "" && (
        /* 首屏拉取失败：整片空白对用户的解释力为零，必须原地给一句话 + 重试 */
        <div className="notice chat-failure" role="alert">
          <div className="chat-failure-copy"><b>会话没有载入</b><span>本地服务可能暂时不可达，或连接刚刚中断。</span></div>
          <button type="button" className="retry" onClick={boot}>重新载入</button>
          <details className="notice-detail">
            <summary>技术详情</summary>
            {bootErr}
          </details>
        </div>
      )}

      <div id="composer" className={readOnly ? "readonly" : undefined}>
        {readOnly ? (
          <div className="composer-readonly">
            <span>QQ 群 · {conversationTitle || "群聊"} · 只读</span>
            <small>群消息只能查看；要回复请在 QQ 群里直接 @机器人。</small>
            {onOpenLocal && <button type="button" className="pf-ghost" onClick={onOpenLocal}>回到私聊</button>}
          </div>
        ) : (
        <>
        {/* 输入区的上边框：一根可拖的分隔线。放在这儿而不是 textarea 自带的右下角柄——
            那个角紧挨着「发送」，容易点歪，而且离正在打字的地方最远。 */}
        <div
          className="composer-grip"
          ref={gripElRef}
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整输入区高度"
          tabIndex={0}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onKeyDown={onGripKey}
        />
        {imgs.length > 0 && (
          <div className="attach-strip">
            {imgs.map((url) => (
              <div key={url} className="attach-item">
                <img src={url} alt="" />
                <button type="button" aria-label="移除图片" onClick={() => removeImg(url)}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {drawArmed && (
          <div className="draw-armed">
            <span>下一条会让{characterName}画一张（要等一会儿）</span>
            <button type="button" onClick={() => setDrawArmed(false)}>取消</button>
          </div>
        )}
        <textarea
          id="ipt"
          aria-label={"给" + characterName + "发消息"}
          ref={iptRef}
          rows={1}
          placeholder={recSec !== null ? "正在录音…"
            : voiceBusy ? "正在准备语音消息…"
            : drawArmed ? `画什么？Enter 就发，留空${characterName}来定` : "输入消息…"}
          autoComplete="off"
          enterKeyHint="send"
          disabled={recSec !== null}
          value={draft}
          onPaste={onPasteFiles}
          onChange={(e) => { setDraft(e.target.value); autoGrow(e.target); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              // 与「发送」按钮同一道闸门（disabled={busy || transcribing}）：撤回/删除/编辑
              // 进行中不该并发再发一条，转写没回来时也不该把草稿清掉。
              // 注意这里**故意不管 typing**：联系人还在回话时按 Enter = barge-in 打断重来，
              // 那是设计好的行为（见 send() 里 pendingTurnRef 那段），别顺手加进来把它杀掉。
              if (busy || transcribing || voiceBusy) return;
              submitDraft();
            }
          }}
        />
        {recSec !== null ? (
          <div className="composer-bar recording">
            <span className="rec-state"><i className="rec-dot" /> 录音中 {recSec} 秒（最长 1 分钟）</span>
            {/* 实时波形与「N 秒 + 红点」并存：秒数管时长，波形管音量，各答一件事。 */}
            <RecWaveMeter active samplesRef={recWaveRef} />
            <div className="rec-actions">
              <button type="button" className="btn sm" onClick={() => finishRecording("cancel")}>取消</button>
              {caps.speechToText && (
                <button type="button" className="btn sm" onClick={() => finishRecording("transcribe")}>转文字</button>
              )}
              <button type="button" className="primary sm" onClick={() => finishRecording("voice")}>
                发送语音
              </button>
            </div>
          </div>
        ) : (
          <div className="composer-bar">
            <div className="composer-tools">
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
              <button type="button" className="tool-btn" title="发送图片" aria-label="发送图片"
                disabled={uploading || imgs.length >= MAX_CHAT_IMAGES} onClick={() => fileInputRef.current?.click()}>
                {uploading ? <Loader2 size={17} className="spin" /> : <ImagePlus size={17} />}
              </button>
              {typeof MediaRecorder !== "undefined" && (
                <button type="button" className="tool-btn" title="发送语音" aria-label="发送语音"
                  disabled={transcribing || voiceBusy} onClick={() => void startRecording()}>
                  {transcribing || voiceBusy ? <Loader2 size={17} className="spin" /> : <Mic size={17} />}
                </button>
              )}
              {caps.imageGeneration && imageGenOn && (
                // 勾选而不是即发：点一下=给下一条消息挂上"要配图"，输入框里写什么就画什么，
                // Enter / 发送 才真出去（发完自动摘勾，见 submitDraft）。
                <button type="button" className="tool-btn" aria-pressed={drawArmed}
                  aria-label="画一张"
                  title={drawArmed
                    ? `下一条会画一张（要点时间）· 再点取消`
                    : `下一条让${characterName}画一张`}
                  onClick={() => setDrawArmed((v) => !v)}>
                  <Palette size={17} />
                </button>
              )}
              <div className="emote-wrap" ref={emoteWrapRef}>
                <button type="button" ref={emoteBtnRef} className="tool-btn" aria-haspopup="dialog"
                  aria-expanded={emoteOpen} aria-label="发送表情" title="发送表情"
                  onClick={() => setEmoteOpen((v) => !v)}>
                  <Smile size={17} />
                </button>
              </div>
            </div>
            <span className="tip">
              <span className="kbd-only">Enter 发送 · Shift+Enter 换行</span>
              <span className="touch-only">长按消息可复制 / 编辑 / 撤回</span>
            </span>
            {composerAccessory}
            {modelSwitchable && (
              <div className="model-wrap" ref={modelWrapRef}>
                <button type="button" ref={modelTriggerRef} className="model-trigger" aria-haspopup="dialog"
                  aria-expanded={modelOpen} aria-label="切换聊天模型" title={currentModelLabel}
                  onClick={toggleModel}>
                  <Cpu size={14} strokeWidth={1.9} />
                  <span className="model-trigger-label">{currentModelLabel}</span>
                  {reasoningAvailable && (
                    <span className="model-trigger-think">{thinkingSummary}</span>
                  )}
                  <ChevronDown size={12} strokeWidth={2} className={modelOpen ? "flip" : ""} />
                </button>
                {modelExit.visible && createPortal(
                  <div className="model-pop" role="dialog" aria-label="聊天模型" data-keep-menu
                    data-closing={modelExit.closing || undefined}
                    aria-hidden={modelExit.closing || undefined}
                    onAnimationEnd={modelExit.onAnimationEnd}
                    style={modelPopPos ? { left: modelPopPos.left, bottom: modelPopPos.bottom, width: modelPopPos.width } : { visibility: "hidden" }}>
                    <div className="model-pop-head">
                      <span>模型与推理</span>
                      <small>只影响这位联系人 · 下一条生效</small>
                    </div>
                    <div className="model-current">
                      <div className="model-current-row">
                        <span className="model-current-label">模型</span>
                        <b title={currentModelLabel}>{currentModelLabel}</b>
                      </div>
                      <button type="button" className="model-current-row model-current-action"
                        disabled={!reasoningAvailable} aria-expanded={modelPane === "think"}
                        tabIndex={modelExit.closing ? -1 : undefined}
                        onClick={() => setModelPane((prev) => prev === "think" ? "models" : "think")}>
                        <span className="model-current-label">推理等级</span>
                        <span className="model-current-value">{reasoningAvailable ? thinkingSummary : "模型未启用思考"}</span>
                        <ChevronDown size={14} strokeWidth={2.2}
                          className={modelPane === "think" ? "model-current-chev up" : "model-current-chev"} />
                      </button>
                    </div>

                    {modelPane === "think" && thinking ? (
                      <div className="model-pane">
                        <div className="model-section-head">
                          <span>选择推理等级</span>
                          <button type="button" className="model-back" tabIndex={modelExit.closing ? -1 : undefined} onClick={() => setModelPane("models")}>
                            <ChevronLeft size={13} strokeWidth={2.2} /> 返回模型
                          </button>
                        </div>
                        <p className="reason-hint">默认「跟随模型」就好；只有觉得它答得太浅或太慢时才需要调。</p>
                        <div className="reason-options" role="radiogroup" aria-label="选择推理等级">
                          <button type="button" role="radio"
                            aria-checked={thinking.thinking.mode === "auto" || (thinking.thinking.param === "effort" && thinking.thinking.mode === "off") || (thinking.thinking.param !== "effort" && thinking.thinking.mode === "")}
                            className={"reason-option" + (thinking.thinking.mode === "auto" || (thinking.thinking.param === "effort" && thinking.thinking.mode === "off") || (thinking.thinking.param !== "effort" && thinking.thinking.mode === "") ? " on" : "")}
                            disabled={thinkBusy} tabIndex={modelExit.closing ? -1 : undefined} onClick={() => chooseThinking("auto")}>
                            <span className="reason-option-copy">
                              <b>跟随模型</b>
                              <small>不发送推理强度，由服务商决定</small>
                            </span>
                            {(thinking.thinking.mode === "auto" || (thinking.thinking.param === "effort" && thinking.thinking.mode === "off") || (thinking.thinking.param !== "effort" && thinking.thinking.mode === "")) && <Check size={15} strokeWidth={2.4} />}
                          </button>
                          {thinking.thinking.param === "effort" ? thinking.thinking.levels.map((level) => (
                            <button key={level} type="button" role="radio"
                              aria-checked={thinking.thinking.mode !== "off" && thinking.thinking.mode !== "auto" && thinking.thinking.level === level}
                              className={"reason-option" + (thinking.thinking.mode !== "off" && thinking.thinking.mode !== "auto" && thinking.thinking.level === level ? " on" : "")}
                              disabled={thinkBusy} tabIndex={modelExit.closing ? -1 : undefined} onClick={() => chooseThinking(level)}>
                              <span className="reason-option-copy">
                                <b>{THINKING_LEVEL_LABELS[level]}</b>
                                <small>{level === "max" ? "最深、最慢，适合复杂问题" : level === "high" || level === "xhigh" ? "更深入，耗时更长" : level === "low" ? "更快，适合简单问题" : "平衡速度与深度"}</small>
                              </span>
                              {thinking.thinking.mode !== "off" && thinking.thinking.mode !== "auto" && thinking.thinking.level === level && <Check size={15} strokeWidth={2.4} />}
                            </button>
                          )) : (
                            <>
                              <button type="button" role="radio"
                                aria-checked={thinking.thinking.mode === "on"}
                                className={"reason-option" + (thinking.thinking.mode === "on" ? " on" : "")}
                                disabled={thinkBusy} tabIndex={modelExit.closing ? -1 : undefined} onClick={() => chooseThinking("on")}>
                                <span className="reason-option-copy"><b>开启思考</b><small>显式向服务商发送开启字段</small></span>
                                {thinking.thinking.mode === "on" && <Check size={15} strokeWidth={2.4} />}
                              </button>
                              <button type="button" role="radio"
                                aria-checked={thinking.thinking.mode === "off"}
                                className={"reason-option" + (thinking.thinking.mode === "off" ? " on" : "")}
                                disabled={thinkBusy} tabIndex={modelExit.closing ? -1 : undefined} onClick={() => chooseThinking("off")}>
                                <span className="reason-option-copy"><b>关闭思考</b><small>显式向服务商发送关闭字段</small></span>
                                {thinking.thinking.mode === "off" && <Check size={15} strokeWidth={2.4} />}
                              </button>
                            </>
                          )}
                        </div>
                        <div className="think-pop-note">
                          {thinking.thinking.param === "effort"
                            ? "强度越高想得越久，也更慢。跟随模型不会发送强度字段；有些服务商仍会按自己的默认思考。"
                            : "这类模型只有开关。跟随模型不发送字段；开/关会显式覆盖服务商默认。"}
                          下一条回复起生效。
                        </div>
                      </div>
                    ) : modelError !== "" ? (
                      <div className="model-pane">
                        <div className="model-pop-empty">模型列表没读到：{modelError}</div>
                      </div>
                    ) : (
                      <div className="model-pane">
                        <div className="model-section-head">
                          <span>选择聊天模型</span>
                          {globalModelEcho && <small>当前为演示模式</small>}
                        </div>
                        {modelOptions.length > 6 && (
                          <label className="model-filter">
                            <Search size={14} strokeWidth={2} />
                            <input value={modelQuery} onChange={(event) => setModelQuery(event.currentTarget.value)}
                              tabIndex={modelExit.closing ? -1 : undefined}
                              placeholder="搜索模型或供应商" aria-label="搜索模型" />
                            {modelQuery !== "" && (
                              <button type="button" aria-label="清空搜索" tabIndex={modelExit.closing ? -1 : undefined} onClick={() => setModelQuery("")}><X size={13} /></button>
                            )}
                          </label>
                        )}
                        <div className="model-options" role="radiogroup" aria-label="选择聊天模型">
                          {(modelQueryText === "" || "跟随全局".includes(modelQueryText)) && (
                            <button type="button" role="radio" aria-checked={modelProfileId === ""}
                              className={"model-option" + (modelProfileId === "" ? " on" : "")}
                              disabled={modelBusy} tabIndex={modelExit.closing ? -1 : undefined} onClick={() => chooseModel("")}>
                              <span className="model-option-copy">
                                <b>跟随全局</b>
                                <small>全局模型 · {globalModelStatus}</small>
                              </span>
                              {modelProfileId === "" && <Check size={15} strokeWidth={2.4} />}
                            </button>
                          )}
                          {showModelGroups ? visibleModelGroups.map((group) => (
                            <div className="model-group" key={group.provider}>
                              <div className="model-group-head">
                                <span>{group.provider}</span>
                                <small>{group.items.length} 个模型</small>
                              </div>
                              {group.items.map(modelOptionRow)}
                            </div>
                          )) : visibleModels.map(modelOptionRow)}
                        </div>
                        {modelOptions.length === 0 && (
                          <div className="model-pop-empty">还没有可切换的模型档。先在设置里添加并保存一份。</div>
                        )}
                        {modelOptions.length > 0 && visibleModels.length === 0 && modelQueryText !== "" && (
                          <div className="model-pop-empty">没有匹配的模型。</div>
                        )}
                        {onOpenModelSettings && (
                          <button type="button" className="model-manage" tabIndex={modelExit.closing ? -1 : undefined}
                            onClick={() => { setModelOpen(false); onOpenModelSettings(); }}>
                            管理模型档
                          </button>
                        )}
                      </div>
                    )}
                  </div>,
                  document.body
                )}
              </div>
            )}
            <div className="ctx-wrap">
              <button type="button" ref={ctxBtnRef} className="ctx-btn" id="ctxBtn" data-keep-menu onClick={toggleCtx}
                title={ctx
                  ? `联系人记得的范围：已用 ${Math.round((ctx.used / ctx.limit) * 100)}%（${fmtTokens(ctx.used)} / ${fmtTokens(ctx.limit)}）· 一共聊了 ${ctx.totalTurns ?? "?"} 轮、带上最近 ${ctx.turns ?? "?"} 轮`
                    + ((ctx.droppedByBudget ?? 0) > 0 ? ` · 更早的没带上 ${ctx.droppedByBudget} 轮` : "")
                  : ctxErr !== "" ? "读取失败" : "联系人记得的范围（估算）"}>
                <svg className={"ctx-ring" + (ctx && (ctx.used / ctx.limit > 0.8 || (ctx.overflowTurns ?? 0) > 0 || (ctx.droppedByBudget ?? 0) > 0) ? " hot" : "")}
                  viewBox="0 0 14 14" aria-hidden="true">
                  <circle className="ctx-ring-bg" cx="7" cy="7" r="5.5" />
                  <circle className="ctx-ring-fg" cx="7" cy="7" r="5.5"
                    strokeDasharray={ctx ? ((ctx.used / ctx.limit) * 34.56).toFixed(2) + " 34.56" : "0 34.56"}
                    transform="rotate(-90 7 7)" />
                </svg>
                {/* 常驻只给结论；完整用量在悬浮提示和点击后的浮层里。 */}
                {ctx
                  ? (
                    <>
                      <span className="ctx-pct">{Math.round((ctx.used / ctx.limit) * 100)}%</span>
                    </>
                  )
                  : "—"}
              </button>
              {ctxExit.visible && ctx && (() => { const c = ctx; return createPortal(
                <>
                  {/* 背板跟着一起退场：CSS 在 [data-closing] 上放开 pointer-events，淡出帧不挡下一发点击 */}
                  <div className="ctx-backdrop" data-closing={ctxExit.closing || undefined} onClick={() => setCtxOpen(false)} />
                  <div className="ctx-pop" id="ctxPop" data-keep-menu
                    data-closing={ctxExit.closing || undefined}
                    aria-hidden={ctxExit.closing || undefined}
                    onAnimationEnd={ctxExit.onAnimationEnd}
                    style={ctxPopPos ? { left: ctxPopPos.left, bottom: ctxPopPos.bottom, width: ctxPopPos.width } : { visibility: "hidden" }}>
                    <div className="ctx-pop-head">
                      <span>联系人记得的范围</span>
                      <button type="button" aria-label="关闭" tabIndex={ctxExit.closing ? -1 : undefined} onClick={() => setCtxOpen(false)}><X size={14} /></button>
                    </div>
                    <div className="ctx-pop-total">
                      <b>{Math.round((c.used / c.limit) * 100)}%</b>
                      <span>已使用 {fmtTokens(c.used)} / {fmtTokens(c.limit)}</span>
                    </div>
                    {/* 轮不是条：一轮 = 用户问一次 + 联系人答一次（可能分好几条气泡）。
                        总量与"当前带入"分开给，截断/丢弃才看得明白。 */}
                    <div className="ctx-pop-turns">
                      一共聊了 {c.totalTurns ?? "—"} 轮 · 带上最近 {c.turns ?? "—"} 轮
                    </div>
                    {(c.visionMode !== undefined || (c.imageCount ?? 0) > 0) && (
                      <div className="ctx-pop-turns">
                        图片：
                        {c.visionMode === "inline" ? "主模型直接看图"
                          : c.visionMode === "describe" ? "视觉卡识别后注入描述"
                          : c.visionMode === "none" ? "当前模型看不到内容"
                          : "未知"}
                        {(c.imageCount ?? 0) > 0 ? ` · 本轮 ${c.imageCount} 张` : ""}
                      </div>
                    )}
                    <div className="ctx-bar">
                      {c.parts.map((p) => (
                        <i key={p.key} data-k={p.key} style={{ width: (p.tokens / c.limit) * 100 + "%" }} title={p.label} />
                      ))}
                    </div>
                    {c.parts.map((p) => (
                      <div key={p.key} className="ctx-row">
                        <i className="ctx-legend" data-k={p.key} />
                        <span>{CTX_PART_LABEL[p.key] ?? p.label}</span>
                        <span className="num">{fmtTokens(p.tokens)} · {(p.tokens / c.limit * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                    {(c.overflowTurns ?? 0) > 0 && (
                      <div className="ctx-row">
                        <span className="ctx-warn">更早的没带上，只保留最近 {c.recentTurnsSetting ?? c.turns} 轮 · 想多带，去 编辑资料 → 回放轮数 调大</span>
                      </div>
                    )}
                    {/* 预算截断单独一行：成因不是回放轮数，引导也就不是"调大轮数"。
                        上限没填时挡住它的是我们的 32K 保守估算，不是模型的真实天花板——必须说破。 */}
                    {(c.droppedByBudget ?? 0) > 0 && (
                      <div className="ctx-row">
                        <span className="ctx-warn">
                          更早的没带上，还差 {c.droppedByBudget} 轮 · 想多带，去 编辑资料 → 回放轮数 调大
                          {c.limitIsFallback
                            ? <>，或先<button type="button" className="ctx-link" tabIndex={ctxExit.closing ? -1 : undefined} onClick={() => { setCtxOpen(false); onOpenModelSettings?.(c.profile?.id); }}>去设置</button>给{c.profile ? `「${c.profile.label}」` : "这一档"}填上输入上限</>
                            : "，或换个能记更多的模型"}
                          。
                        </span>
                      </div>
                    )}
                    {/* 分母是按哪一档算的必须点名：档很多，其中同名的也不少（hy3 / 本地中转 · agent2api/hy3），
                        只说「去设置」用户会改到另一档，回来圆环分毫不动。 */}
                    <div className="ctx-foot">
                      数字是估算 · 模型 {c.model || "未配置"}
                      {c.profile ? ` · 档「${c.profile.label}」` : ""}
                      {c.limitIsFallback ? `（输入上限没填，分母按 ${fmtTokens(c.limit)} 估）` : ""}
                    </div>
                  </div>
                </>,
                document.body
              ); })()}
              {ctxExit.visible && !ctx && createPortal(
                <>
                  <div className="ctx-backdrop" data-closing={ctxExit.closing || undefined} onClick={() => setCtxOpen(false)} />
                  <div className="ctx-pop" data-keep-menu
                    data-closing={ctxExit.closing || undefined}
                    aria-hidden={ctxExit.closing || undefined}
                    onAnimationEnd={ctxExit.onAnimationEnd}
                    style={ctxPopPos ? { left: ctxPopPos.left, bottom: ctxPopPos.bottom, width: ctxPopPos.width } : { visibility: "hidden" }}>
                    <div className="ctx-foot">{ctxErr !== ""
                      ? <>没读到，<button type="button" className="ctx-link" tabIndex={ctxExit.closing ? -1 : undefined} onClick={loadCtx}>重试</button></>
                      : "读取中…"}</div>
                  </div>
                </>,
                document.body
              )}
            </div>
            {/* 发送槽只有一个按钮位，按状态换脸、位置永不移动（对齐 iMessage/ChatGPT 的收敛做法）：
                回合在飞（typing/busy 且有 pendingTurn）→ ■ 停止，点它=不要这次回答了；
                本地操作收尾（撤回/删除/编辑/重试共用的 busy，没有 pendingTurn）→ 小 spinner。
                spinner 只说「在忙」不说「发送中」——send() 是即时的，写文案会说谎，图形不会。
                不再出现「停止 + 请稍候…」两个按钮描述同一个 busy。 */}
            <div className="composer-actions">
              {(typing || busy) && pendingTurnRef.current !== null ? (
                <button type="button" id="send" className="stopping" title="不要这次回答了" onClick={stopTurn}>
                  <Square size={14} strokeWidth={0} fill="currentColor" aria-hidden />
                </button>
              ) : (
                <button type="button" id="send" title={busy ? "有别的操作还在收尾，稍等一下" : "发送"}
                  disabled={busy || transcribing || voiceBusy}
                  className={busy ? "busy" : ""} onClick={submitDraft}>
                  {busy ? <Loader2 size={16} className="spin" aria-hidden /> : "发送"}
                </button>
              )}
            </div>
          </div>
        )}
        </>
        )}
      </div>

      {/* MessageMenu 常驻：menu 置 null 时它自己播 menuOut 淡出、走完再摘 portal */}
      <MessageMenu menu={menu} setMenu={setMenu} addNotice={addNotice}
        onEdit={startEdit} onReedit={reeditRetracted}
        onRetract={(mm) => { setMenu(null); setPendingConfirm({ kind: "retract", m: mm }); }}
        onRequestDelete={(mm) => { setMenu(null); setDelTarget(mm); }}
        onRegenerate={(mm) => { setMenu(null); setPendingConfirm({ kind: "regenerate", m: mm }); }}
        onRemember={rememberMessage} />

      {pendingConfirm && (
        <Modal label="操作确认" placement="center" onClose={() => setPendingConfirm(null)}>
          <div className="del-title">
            {pendingConfirm.kind === "edit-switch" ? "切换编辑到这条消息？"
              : pendingConfirm.kind === "regenerate" ? "重新生成这条回复？"
                : "撤回这条消息？"}
          </div>
          <div className="del-note">
            {pendingConfirm.kind === "edit-switch"
              ? "当前正在编辑的内容还没保存，切换后会丢弃；新打开的这一条不会立即改动。"
              : pendingConfirm.kind === "regenerate"
                ? "会生成一个新的回答，原来的留成旧版本（最多留 5 个），可以在气泡下方左右切换。重新生成期间不能发送其他消息。"
                : `撤回后${characterName}不会再记得这句，但会留下一条“已撤回”记录。`}
          </div>
          <div className="del-row">
            <button type="button" onClick={() => setPendingConfirm(null)}>取消</button>
            <button type="button" className={pendingConfirm.kind === "retract" ? "danger" : "primary"}
              onClick={acceptPendingConfirm}>
              {pendingConfirm.kind === "edit-switch" ? "切换编辑"
                : pendingConfirm.kind === "regenerate" ? "重新生成" : "撤回"}
            </button>
          </div>
        </Modal>
      )}

      {delTarget && (
        <Modal label="删除确认" placement="center" onClose={() => setDelTarget(null)}>
          <div className="del-title">{delTarget.superseded_kind === "retract" ? "同时删除撤回记录？" : "删除这段对话？"}</div>
          <div className="del-note">
            {delTarget.superseded_kind === "retract"
              ? "删掉就找不回来了。"
              : "这条和联系人的回答会一起删掉。只想让联系人忘了这句，用「撤回」。"}
          </div>
          <div className="del-row">
            <button type="button" onClick={() => setDelTarget(null)}>取消</button>
            <button type="button" className="danger"
              onClick={() => { const t = delTarget; setDelTarget(null); doDelete(t); }}>删除</button>
          </div>
        </Modal>
      )}

      {/* 归档确认：与删消息同一套居中弹窗；菜单里只留短标签，不再原地换「确认？」文案 */}
      {/* 操作反馈：轻提示（toast）浮层，不再混排进消息流底部 */}
      {/* 这两层必须 portal 到 body：助手弹窗本体带 transform（居中用），
          transform 会把自己变成 position:fixed 后代的包含块——留在原地时
          「全屏大图」只会盖住弹窗那一块、关闭钮跑到弹窗角上，轻提示也按弹窗定位。 */}
      {notices.length > 0 && createPortal(
        <div className="toast-layer" role="status" aria-live="polite">
          {notices.map((n) => (
            <div key={n.id} className={"toast" + (n.info ? "" : " warn")}>
              {n.text}
              {n.retryTurnId && <button type="button" className="retry" onClick={() => retry(n.retryTurnId!)}>重试</button>}
            </div>
          ))}
        </div>,
        document.body,
      )}

      <ChatMap open={mapOpen} nodes={mapNodes} activeId={mapActiveId}
        onJump={(id) => { setMapActiveId(id); focusMessage(id); }}
        onClose={() => setMapOpen(false)}
        onOpenSearch={() => setSearchOpen(true)} />

      {zoom && createPortal(
        <div className="img-zoom" onClick={() => setZoom(null)} role="dialog" aria-modal="true"
          aria-label="图片大图" data-keep-menu>
          <img src={zoom} alt="消息图片大图" onClick={(e) => e.stopPropagation()} />
          <button type="button" aria-label="关闭" onClick={() => setZoom(null)}><X size={18} /></button>
        </div>,
        document.body,
      )}

      {emoteExit.visible && createPortal(
        <EmotePicker pos={emotePopPos} onPick={sendEmote}
          closing={emoteExit.closing} onAnimationEnd={emoteExit.onAnimationEnd} />,
        document.body,
      )}
    </div>
  );
}


