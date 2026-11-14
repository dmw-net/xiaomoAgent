import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { chatApi, settingsApi } from "../../api";
import type { PetSettings } from "../../types";
import { hidePetWindow, movePetWindow, openAssistantInMainWindow, resizePetWindow, setPetAlwaysOnTop, setPetHit, showMainWindow } from "../../lib/pet-window";
import { PET_BUBBLE_BOTTOM, PET_CHAR_TOP, PET_DEFAULT_SKIN, PET_HEIGHT_RATIO, PET_VIDEO_STYLE, animLabel, animUrl, pick, skinOf } from "./petAssets";
import { createSquashDriver, landingSquash } from "./motion";
import { emitPetSettingsChanged } from "./petEvents";
import { startPetLink } from "./petLink";
import { createBaifanGame, type BaifanGame } from "./baifan/game";
import type { PetGameControl } from "./baifan/control";
import { loadCaps } from "../../lib/capsStore";
import { playExclusiveAudio } from "../../lib/audioBus";
import clickPopUrl from "../../assets/pet/sounds/click-pop.wav?url";
import PetMascot, { type PetAnimSpec } from "./PetMascot";

type PetMode = "idle" | "walk" | "sleep" | "work" | "play" | "react" | "baifan";

type DragState = {
  startX: number;
  startY: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  lastTime: number;
  vx: number;
  vy: number;
};

type Bounds = { width: number; height: number };

const skin = skinOf(PET_DEFAULT_SKIN);
const PHRASES = [
  "你好呀！",
  "今天也要开心哦～",
  "我在呢。",
  "要喝水吗？",
  "别太累了。",
  "陪你一会儿。",
  "小茉在等你。",
  "休息一下眼睛吧。",
];

function randomPhrase(): string {
  return PHRASES[Math.floor(Math.random() * PHRASES.length)] ?? "你好呀！";
}

/** 睡着时的拒绝台词：打扰类菜单点了不执行，只弹一句（原版 menu-actions 闸门同款语义）。 */
const SLEEP_REFUSE_TEXTS = ["Zzz……", "呼……呼……（睡得正香）", "唔……再睡五分钟……", "（翻了个身，继续睡）"];

/** 动作点播的分类清单：label 进菜单，pool 是该类的动作名（菜单直接点播）。 */
const ANIM_CATS: ReadonlyArray<{ label: string; pool: readonly string[] }> = [
  { label: "待机", pool: skin.idle },
  { label: "移动", pool: skin.walk },
  { label: "工作", pool: skin.work },
  { label: "玩耍", pool: skin.play },
  { label: "点击回应", pool: skin.click },
  { label: "碎碎念", pool: skin.whisper },
  { label: "吃饭", pool: skin.eat },
];

function screenSize(): Bounds {
  // WebView2 的 screen.availWidth/Height 已经是逻辑像素（DIP，2560@1.5x 屏实测 = 1707），
  // 与 Tauri 的 LogicalPosition 同单位，不要再除 devicePixelRatio——除一次就把屏幕算小 1.5 倍，
  // 钳制窗口全跑偏（桌宠会飞到左上角、位置保存也错）。
  const availWidth = window.screen?.availWidth;
  const availHeight = window.screen?.availHeight;
  return {
    width: availWidth || window.innerWidth || 1920,
    height: availHeight || window.innerHeight || 1080,
  };
}

/** 内嵌形态在主窗口视口里活动：innerWidth/Height 就是视口 CSS 像素，与 inlineX/inlineY 同空间。 */
function viewportSize(): Bounds {
  return { width: window.innerWidth || 1920, height: window.innerHeight || 1080 };
}

function defaultPetPosition(size: number, bounds: Bounds): { x: number; y: number } {
  const petHeight = Math.round(size * PET_HEIGHT_RATIO);
  return {
    x: Math.max(12, bounds.width - size - 24),
    y: Math.max(12, bounds.height - petHeight - 24),
  };
}

function clampPosition(x: number, y: number, size: number, bounds: Bounds): { x: number; y: number } {
  const petHeight = Math.round(size * PET_HEIGHT_RATIO);
  return {
    x: Math.min(Math.max(0, x), Math.max(0, bounds.width - size)),
    y: Math.min(Math.max(0, y), Math.max(0, bounds.height - petHeight)),
  };
}

/**
 * 桌宠视图。variant="window"（默认）：独立透明窗，位置即窗口位置，外壳钩子管点击穿透；
 * variant="inline"：主界面内嵌浮层，位置是视口内坐标，pointer-events 分层只在角色矩形可交互。
 * 形象由透明视频驱动（petAssets 的动作池），素材加载失败时 PetMascot 回退内置 SVG。
 */
export default function PetView({ variant = "window", externalSettings }: {
  variant?: "window" | "inline";
  /** 内嵌形态由 PetHost 下发实时快照，不自己拉设置。 */
  externalSettings?: PetSettings;
}): JSX.Element {
  const inline = variant === "inline";
  const [settings, setSettings] = useState<PetSettings | null>(null);
  const [mode, setMode] = useState<PetMode>("idle");
  const [anim, setAnim] = useState<PetAnimSpec>(() => ({ name: skin.idle[0] ?? "", loop: false, seq: 0 }));
  const [videoFailed, setVideoFailed] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 动作点播子菜单：内嵌=飞出面板（贴「动作」项右侧），独立窗口=菜单内手风琴（窗口太小飞不出去）。 */
  const [animOpen, setAnimOpen] = useState(false);
  const [animCatOpen, setAnimCatOpen] = useState<string | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const animBtnRef = useRef<HTMLButtonElement | null>(null);
  /** 开关菜单的唯一入口：ref 同步置位——事件处理器里随后调用的守卫读 ref 才不吃旧值。 */
  const setMenu = useCallback((open: boolean): void => {
    menuOpenRef.current = open;
    setMenuOpen(open);
  }, []);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const settingsRef = useRef<PetSettings | null>(null);
  const modeRef = useRef<PetMode>("idle");
  const sleepStepRef = useRef<"start" | "loop" | "wake">("start");
  const lastIdleRef = useRef<string>(skin.idle[0] ?? "");
  const dragPoseRef = useRef(false);
  const posRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);
  const animRef = useRef<number | null>(null);
  const flingRef = useRef<number | null>(null);
  const velocityRef = useRef({ vx: 0, vy: 0 });
  const lastFrameRef = useRef(0);
  const stateTimerRef = useRef<number | null>(null);
  const bubbleTimerRef = useRef<number | null>(null);
  const movedRef = useRef(false);
  const lastPokeRef = useRef(0);
  const menuOpenRef = useRef(false);
  /** Q 弹挤压驱动（按原版曲线）：作用在舞台层，A/B 交换不会打断它。 */
  const squashRef = useRef<ReturnType<typeof createSquashDriver> | null>(null);
  if (squashRef.current === null) squashRef.current = createSquashDriver();
  const squash = squashRef.current;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const squashNow = useCallback((depth?: number): void => {
    const el = stageRef.current;
    if (el) squash.start(el, depth);
  }, [squash]);
  /** 联动状态：生成中标记；最近一条来消息的联系人（气泡存续期内点桌宠跳转）。 */
  const linkGeneratingRef = useRef(false);
  const linkContactRef = useRef<{ id: string; at: number } | null>(null);
  /** 吃白饭小游戏：激活时接管桌宠的动画与位置（自治/联动/拖拽都给它让路）。 */
  const gameActiveRef = useRef(false);
  const clipEndCbRef = useRef<(() => void) | null>(null);
  const gameRef = useRef<BaifanGame | null>(null);
  const [gameOn, setGameOn] = useState(false);
  /** 朝向：追饭侧身跑按它镜像；游戏收场复位。 */
  const [facing, setFacingState] = useState<"front" | "left" | "right">("front");

  useEffect(() => { menuOpenRef.current = menuOpen; }, [menuOpen]);

  /** 活动边界：独立窗口按屏幕（窗口位置是屏幕坐标），内嵌按主窗口视口。 */
  const petBounds = useCallback((): Bounds => (inline ? viewportSize() : screenSize()), [inline]);

  /** 位置唯一出口：独立窗口形态移动 OS 窗口；内嵌形态只更新状态（渲染走 transform）。 */
  const applyPos = useCallback((next: { x: number; y: number }): void => {
    posRef.current = next;
    setPos(next);
    if (!inline) void movePetWindow(next.x, next.y);
  }, [inline]);

  const say = useCallback((text: string, ms = 2600): void => {
    setBubble(text);
    if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = window.setTimeout(() => setBubble(null), ms);
  }, []);

  /** 点击音效：单例 Audio 复用；自动播放策略拒绝时静默——音效只是锦上添花。 */
  const popRef = useRef<HTMLAudioElement | null>(null);
  const playPop = useCallback((): void => {
    if (!settingsRef.current?.sound) return;
    if (popRef.current === null) {
      popRef.current = new Audio(clickPopUrl);
      popRef.current.volume = 0.35;
    }
    const audio = popRef.current;
    try { audio.currentTime = 0; } catch { /* 个别实现重置失败就让它续播 */ }
    void audio.play().catch(() => undefined);
  }, []);

  /** 桌宠语音：把短句念出来。门控 voice 设置与语音合成能力卡；合成/播放失败静默降级为纯文字。 */
  const speak = useCallback((text: string): void => {
    if (!settingsRef.current?.voice) return;
    void (async () => {
      try {
        const caps = await loadCaps();
        if (!caps.textToSpeech) return;
        const { dataUrl } = await chatApi.synthesize(text);
        playExclusiveAudio(dataUrl, { onError: () => undefined });
      } catch { /* 语音是锦上添花，文字气泡照常 */ }
    })();
  }, []);

  const cancelAnim = useCallback((): void => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }, []);

  const cancelFling = useCallback((): void => {
    if (flingRef.current !== null) cancelAnimationFrame(flingRef.current);
    flingRef.current = null;
  }, []);

  const enter = useCallback((next: PetMode): void => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const playAnim = useCallback((name: string, loop: boolean): void => {
    setAnim((a) => ({ name, loop, seq: a.seq + 1 }));
  }, []);

  const toIdle = useCallback((): void => {
    enter("idle");
    const next = pick(skin.idle, lastIdleRef.current);
    lastIdleRef.current = next;
    playAnim(next, false);
  }, [enter, playAnim]);

  /** 非循环动作的兜底定时器：只在素材回退成 SVG（没有 onEnded）时兜底。
   *  视频路径一律由 onEnded 接续——固定时长定时器会把比它长的片段拦腰砍断
   *  （「写代码」约 10s，曾被 8s 定时器切掉尾巴）。 */
  const scheduleStateBack = useCallback((ms: number, from: PetMode): void => {
    if (!videoFailed) return;
    if (stateTimerRef.current !== null) window.clearTimeout(stateTimerRef.current);
    stateTimerRef.current = window.setTimeout(() => {
      if (modeRef.current === from) toIdle();
    }, ms);
  }, [toIdle, videoFailed]);

  const savePosition = useCallback((x: number, y: number): void => {
    const pet = settingsRef.current;
    if (!pet) return;
    // 两种形态坐标空间不同：桌面存屏幕坐标 x/y，内嵌存视口坐标 inlineX/inlineY。
    const patch = inline
      ? { inlineX: Math.round(x), inlineY: Math.round(y) }
      : { x: Math.round(x), y: Math.round(y) };
    void settingsApi.saveSettings({ pet: patch }).catch(() => undefined);
  }, [inline]);

  /** 上报角色头顶占比与交互态：外壳钩子按窗口矩形现场算命中，透明区点击穿透。
   *  内嵌形态靠 pointer-events 分层（pet-hit）解决遮挡，没有外壳钩子，上报跳过。 */
  const pushHitRect = useCallback((active: boolean): void => {
    if (inline) return;
    setPetHit(PET_CHAR_TOP, active);
  }, [inline]);

  // 独立窗口形态：设置自取，窗口尺寸/位置/置顶/命中区一起同步。
  useEffect(() => {
    if (inline) return;
    let disposed = false;
    settingsApi.fetchSettings().then((snap) => {
      if (disposed) return;
      const pet = snap.pet ?? { enabled: true, displayMode: "desktop", size: 180, alwaysOnTop: true, randomActions: true, chatter: true };
      setSettings(pet);
      settingsRef.current = pet;
      document.body.dataset.pet = "1";
      const petHeight = Math.round(pet.size * PET_HEIGHT_RATIO);
      void resizePetWindow(pet.size, petHeight);
      void setPetAlwaysOnTop(pet.alwaysOnTop);
      const start = typeof pet.x === "number" && typeof pet.y === "number"
        ? { x: pet.x, y: pet.y }
        : defaultPetPosition(pet.size, screenSize());
      applyPos(clampPosition(start.x, start.y, pet.size, screenSize()));
      pushHitRect(false);
      if (snap.pet && !pet.enabled) void hidePetWindow();
    }).catch(() => { /* 设置读不到时保持静默，桌宠不抢主界面 */ });
    return () => {
      disposed = true;
      document.body.dataset.pet = "";
    };
  }, [applyPos, inline, pushHitRect]);

  // 内嵌形态：PetHost 下发快照；首次到达定初始位，之后按存档位置重钳（体型/视口变化都走这里）。
  useEffect(() => {
    if (!inline || !externalSettings) return;
    setSettings(externalSettings);
    settingsRef.current = externalSettings;
    if (dragRef.current || flingRef.current !== null) return; // 拖拽/甩抛途中不吃快照，避免中途传送
    const pet = externalSettings;
    const start = typeof pet.inlineX === "number" && typeof pet.inlineY === "number"
      ? { x: pet.inlineX, y: pet.inlineY }
      : defaultPetPosition(pet.size, viewportSize());
    applyPos(clampPosition(start.x, start.y, pet.size, viewportSize()));
  }, [applyPos, externalSettings, inline]);

  // 体型可以在设置页随时改：外壳窗口尺寸跟着变，页面的 resize 事件是唯一可靠信号
  // （set_size 必触发）。 debounce 后重拉设置，同步 --pet-size、位置与命中区，
  // 否则旧体型的画面塞在新尺寸的窗口里，角色只剩一个角。
  useEffect(() => {
    if (inline || !settings?.enabled) return;
    let timer: number | null = null;
    const onResize = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (menuOpenRef.current) return; // 菜单开着时的窗口变大是给菜单腾地方，别缩回去
        settingsApi.fetchSettings().then((snap) => {
          const pet = snap.pet;
          if (!pet) return;
          setSettings(pet);
          settingsRef.current = pet;
          const petHeight = Math.round(pet.size * PET_HEIGHT_RATIO);
          void resizePetWindow(pet.size, petHeight);
          const next = clampPosition(
            typeof pet.x === "number" ? pet.x : posRef.current.x,
            typeof pet.y === "number" ? pet.y : posRef.current.y,
            pet.size,
            screenSize(),
          );
          applyPos(next);
          pushHitRect(false);
        }).catch(() => undefined);
      }, 250);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [applyPos, inline, pushHitRect, settings?.enabled]);

  // 内嵌形态：主窗口视口变化（改尺寸、分屏）时把角色钳回视口内。
  useEffect(() => {
    if (!inline || !settings?.enabled) return;
    const onResize = (): void => {
      const pet = settingsRef.current;
      if (!pet || dragRef.current || flingRef.current !== null) return;
      applyPos(clampPosition(posRef.current.x, posRef.current.y, pet.size, viewportSize()));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyPos, inline, settings?.enabled]);

  // 预热点按反应池与待机首段：fetch 进 HTTP 缓存后，key=seq 重挂的 video 首播
  // 直接命中缓存，消除点击反应前的取片空白（首段动作最长、观感最明显）。
  // 失败静默——预热只是锦上添花，浏览器缓存策略由它自己定。
  useEffect(() => {
    const urls = [...skin.idle.slice(0, 1), ...skin.click].map((name) => animUrl(skin, name)).filter(Boolean);
    for (const url of urls) void fetch(url).catch(() => undefined);
  }, []);

  const animateTo = useCallback((target: { x: number; y: number }, duration: number, done: () => void): void => {
    cancelAnim();
    const start = { ...posRef.current };
    const startTime = performance.now();
    const step = (t: number): void => {
      const p = Math.min(1, (t - startTime) / duration);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      applyPos({
        x: start.x + (target.x - start.x) * ease,
        y: start.y + (target.y - start.y) * ease,
      });
      if (p < 1) animRef.current = requestAnimationFrame(step);
      else {
        animRef.current = null;
        done();
      }
    };
    animRef.current = requestAnimationFrame(step);
  }, [applyPos, cancelAnim]);

  const startWalk = useCallback((): void => {
    if (dragRef.current || menuOpenRef.current) return;
    const pet = settingsRef.current;
    if (!pet) return;
    const { width, height } = petBounds();
    const petHeight = Math.round(pet.size * PET_HEIGHT_RATIO);
    const target = {
      x: Math.random() * Math.max(0, width - pet.size),
      y: Math.random() * Math.max(0, height - petHeight),
    };
    enter("walk");
    playAnim(pick(skin.walk), true);
    animateTo(target, 2600, toIdle);
  }, [animateTo, dragRef, enter, menuOpenRef, petBounds, playAnim, toIdle]);

  const startSleep = useCallback((): void => {
    if (dragRef.current || menuOpenRef.current) return;
    sleepStepRef.current = "start";
    enter("sleep");
    playAnim(skin.sleepStart, false);
    say("晚安…", 2200);
  }, [dragging, enter, menuOpen, playAnim, say]);

  const wake = useCallback((): void => {
    sleepStepRef.current = "wake";
    enter("sleep");
    playAnim(skin.sleepEnd, false);
    say("醒醒！", 1600);
  }, [enter, playAnim, say]);

  const startWork = useCallback((): void => {
    if (dragRef.current || menuOpenRef.current) return;
    enter("work");
    playAnim(pick(skin.work), false);
    say("忙一下～", 1800);
    scheduleStateBack(8000, "work");
  }, [dragRef, enter, menuOpenRef, playAnim, say, scheduleStateBack]);

  const startPlay = useCallback((): void => {
    if (dragRef.current || menuOpenRef.current) return;
    enter("play");
    playAnim(pick(skin.play), false);
    say("玩一会儿！", 1600);
    scheduleStateBack(8000, "play");
  }, [dragRef, enter, menuOpenRef, playAnim, say, scheduleStateBack]);

  const toggleSleep = useCallback((): void => {
    if (modeRef.current === "sleep") {
      wake();
      return;
    }
    startSleep();
  }, [startSleep, wake]);

  /** 反应/动作播完的收尾：生成联动还挂着就继续工作循环，否则回待机。 */
  const settle = useCallback((): void => {
    if (linkGeneratingRef.current) {
      enter("work");
      playAnim(pick(skin.work), true);
      return;
    }
    toIdle();
  }, [enter, playAnim, toIdle]);

  /** 点击类反应的时长上限：部分回应片段长达 10s，戳一下就罢演十秒太拖。
   *  到点还停在 react 才收尾；片段比上限短时 onEnded 先到，这里空转一次。 */
  const capReaction = useCallback((ms: number): void => {
    if (stateTimerRef.current !== null) window.clearTimeout(stateTimerRef.current);
    stateTimerRef.current = window.setTimeout(() => {
      if (modeRef.current === "react") settle();
    }, ms);
  }, [settle]);

  // 联动联系人：小茉回复 → 工作状态；联系人来消息 → 反应 + 气泡（点桌宠跳转）。
  // 睡觉/拖拽/菜单打开时不打扰；生成途中不叠加新消息提示。
  // 位置注意：必须排在 capReaction 定义之后——依赖数组在渲染期取值，取早了就是 TDZ。
  useEffect(() => {
    if (!settings?.linkContacts) return;
    return startPetLink({
      onGeneratingStart: (_contactId, name) => {
        linkGeneratingRef.current = true;
        if (gameActiveRef.current || dragRef.current || flingRef.current !== null || menuOpenRef.current || modeRef.current === "sleep") return;
        enter("work");
        playAnim(pick(skin.work), true); // 生成中循环播；收尾由 onGeneratingEnd 接管
        say(`正在回复「${name}」…`, 8000);
      },
      onGeneratingEnd: (ok) => {
        linkGeneratingRef.current = false;
        if (modeRef.current !== "work" || dragRef.current || flingRef.current !== null || menuOpenRef.current) return;
        if (ok) {
          enter("react");
          playAnim(pick(skin.click), false);
          capReaction(3200);
          const line = "回复好了！";
          say(line, 2200);
          speak(line);
        } else {
          say("呜，回复失败了…", 2600);
          toIdle();
        }
      },
      onIncomingMessage: (contactId, name, preview) => {
        if (linkGeneratingRef.current || gameActiveRef.current || dragRef.current || flingRef.current !== null || menuOpenRef.current || modeRef.current === "sleep") return;
        linkContactRef.current = { id: contactId, at: Date.now() };
        enter("react");
        playAnim("dianji-huiying-haixiu-jingya", false); // 来消息固定用「害羞·惊讶」回应
        capReaction(3600);
        say(preview !== "" ? `「${name}」：${preview}` : `「${name}」来了新消息`, 4200);
      },
    });
  }, [capReaction, enter, playAnim, say, speak, settings?.linkContacts, toIdle]);

  // 吃白饭小游戏：激活时接管桌宠（自治/联动静默，拖拽打断收场），收场复位模式与独立窗尺寸。
  const haltGame = useCallback((): void => {
    gameActiveRef.current = false;
    setGameOn(false);
    clipEndCbRef.current = null;
    setFacingState("front");
    gameRef.current?.halt("不吃了");
    enter("idle");
    if (!inline) {
      const pet = settingsRef.current;
      if (pet) {
        const clamped = clampPosition(
          posRef.current.x,
          posRef.current.y,
          pet.size,
          screenSize(),
        );
        posRef.current = clamped;
        setPos(clamped);
        void resizePetWindow(pet.size, Math.round(pet.size * PET_HEIGHT_RATIO));
        void movePetWindow(clamped.x, clamped.y);
      }
      pushHitRect(false);
    }
  }, [enter, inline]);

  const startGame = useCallback((): void => {
    if (gameRef.current === null) {
      const control: PetGameControl = {
        playAnim: (name, loop) => { enter("baifan"); playAnim(name, loop); },
        onClipEnd: (cb) => { clipEndCbRef.current = cb; },
        moveTo: (x, y, ms) => new Promise((resolve) => animateTo({ x, y }, ms, resolve)),
        pos: () => ({ ...posRef.current }),
        viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
        say: (text, ms) => say(text, ms),
        petSize: () => settingsRef.current?.size ?? 180,
        setFacing: (dir) => setFacingState(dir),
      };
      gameRef.current = createBaifanGame(control);
      gameRef.current.setOnHalt(() => {
        gameActiveRef.current = false;
        setGameOn(false);
        setFacingState("front");
        enter("idle");
        if (!inline) {
          const pet = settingsRef.current;
          if (pet) {
            void resizePetWindow(pet.size, Math.round(pet.size * PET_HEIGHT_RATIO));
            void movePetWindow(posRef.current.x, posRef.current.y);
          }
          pushHitRect(false);
        }
      });
    }
    gameActiveRef.current = true;
    setGameOn(true);
    if (!inline) {
      // 独立窗口：向右下扩出游乐场（内容锚在窗左上角，宠物原地不动，场地向右下延伸）。
      const pet = settingsRef.current;
      if (pet) {
        const growW = Math.max(280, 600 - pet.size);
        const growH = 420;
        void resizePetWindow(pet.size + growW, Math.round(pet.size * PET_HEIGHT_RATIO) + growH);
        pushHitRect(true);
      }
    }
    enter("baifan");
    gameRef.current.start(skin.baifan);
  }, [animateTo, enter, inline, playAnim, say]);

  /** 菜单/拖拽打断游戏：开着才收场。 */
  const haltGameIfRunning = useCallback((): void => {
    if (gameRef.current?.isRunning()) haltGame();
  }, [haltGame]);

  // 飞出面板定位：贴主菜单右侧展开（右侧放不下翻到左侧），垂直对齐「动作」项并钳进视口。
  // 必须挂在 hooks 区（提前 return 之前）：放渲染段后面就是 React #310 少 hooks 崩溃。
  useEffect(() => {
    if (!animOpen || !inline) { setFlyoutPos(null); return; }
    const timer = window.setTimeout(() => {
      const menu = menuRef.current;
      const btn = animBtnRef.current;
      if (!menu || !btn) { setFlyoutPos(null); return; }
      const m = menu.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      const subW = 184;
      let left = m.right + 6;
      if (left + subW > window.innerWidth - 8) left = Math.max(8, m.left - subW - 6);
      const top = Math.max(8, Math.min(b.top, window.innerHeight - 8 - 280));
      setFlyoutPos({ left, top });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [animOpen, animCatOpen, inline]);

  /** 非循环动画播完的接续：待机链、睡觉三段链、其余 settle。 */
  const onAnimEnded = useCallback((): void => {
    if (gameActiveRef.current) {
      // 吃白饭游戏接管片段接续：它登记的回调决定下一段
      const cb = clipEndCbRef.current;
      clipEndCbRef.current = null;
      cb?.();
      return;
    }
    const m = modeRef.current;
    if (m === "idle") {
      const next = pick(skin.idle, lastIdleRef.current);
      lastIdleRef.current = next;
      playAnim(next, false);
      return;
    }
    if (m === "sleep") {
      if (sleepStepRef.current === "start") {
        sleepStepRef.current = "loop";
        playAnim(skin.sleepLoop, true);
      } else if (sleepStepRef.current === "wake") {
        settle();
      }
      return;
    }
    settle();
  }, [playAnim, settle]);

  // 素材回退成 SVG 后没有 onEnded：睡觉与即时反应靠定时器收尾，行为对齐视频路径。
  useEffect(() => {
    if (!videoFailed || (mode !== "sleep" && mode !== "react")) return;
    const ms = mode === "sleep" ? 9000 : 3200;
    const timer = window.setTimeout(() => {
      if (modeRef.current === mode) toIdle();
    }, ms);
    return () => window.clearTimeout(timer);
  }, [mode, toIdle, videoFailed]);

  useEffect(() => {
    if (!settings?.randomActions || !settings.enabled) return;
    const timer = window.setInterval(() => {
      if (dragRef.current || menuOpenRef.current || modeRef.current !== "idle") return;
      const roll = Math.random();
      // 不把「睡觉」放进随机池：睡下后要等人点醒，随机睡死不符合陪伴的直觉。
      if (roll < 0.36) startWalk();
      else if (roll < 0.66) startWork();
      else if (roll < 0.92) startPlay();
      else say(randomPhrase(), 2200);
    }, 18_000);
    return () => window.clearInterval(timer);
  }, [dragRef, menuOpenRef, mode, say, settings?.enabled, settings?.randomActions, startPlay, startWalk, startWork]);

  useEffect(() => {
    if (!settings?.chatter || !settings.enabled) return;
    const timer = window.setInterval(() => {
      if (dragRef.current || menuOpenRef.current || modeRef.current !== "idle") return;
      // 碎碎念配说话动作；正在睡时完全安静，不打扰。
      const phrase = randomPhrase();
      enter("react");
      playAnim(pick(skin.whisper), false);
      say(phrase, 2400);
      speak(phrase);
    }, 42_000);
    return () => window.clearInterval(timer);
  }, [dragRef, enter, menuOpenRef, playAnim, say, speak, settings?.chatter, settings?.enabled, mode]);

  useEffect(() => () => {
    cancelAnim();
    cancelFling();
    if (stateTimerRef.current !== null) window.clearTimeout(stateTimerRef.current);
    if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
  }, [cancelAnim, cancelFling]);

  /** 气泡存续期内点桌宠 = 去看那位来消息的联系人。内嵌精确跳会话；桌面唤起主窗。 */
  const jumpToLinkContact = (): boolean => {
    const link = linkContactRef.current;
    if (!link || Date.now() - link.at > 6_000) return false;
    if (inline) {
      window.dispatchEvent(new CustomEvent("xiaomo:open-contact", { detail: { contactId: link.id } }));
    } else {
      void showMainWindow();
    }
    linkContactRef.current = null;
    return true;
  };

  const poke = (): void => {
    if (movedRef.current) return;
    const now = performance.now();
    // 300ms 去重：连点两下只反应一次（原版没有双击手势，睡觉只在菜单里）。
    if (now - lastPokeRef.current < 300) return;
    lastPokeRef.current = now;
    // 点击（松手）一刻全套反馈一起上：Q 弹挤压 + pop 音效（原版 onClick 同款时序，
    // 压的是回应片段就位后的首帧——舞台级挤压对 A/B 交换免疫，视觉等价）。
    squashNow();
    playPop();
    if (modeRef.current === "sleep") {
      wake();
      return;
    }
    if (jumpToLinkContact()) return;
    enter("react");
    playAnim(pick(skin.click), false);
    capReaction(3200);
    const phrase = randomPhrase();
    say(phrase, 2200);
    speak(phrase);
  };

  const startFling = (vx: number, vy: number): void => {
    cancelFling();
    const pet = settingsRef.current;
    const size = pet?.size ?? 280;
    const petHeight = Math.round(size * PET_HEIGHT_RATIO);
    const { width, height } = petBounds();
    const stageEl = stageRef.current;
    const step = (t: number): void => {
      const last = lastFrameRef.current || t;
      const dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000));
      lastFrameRef.current = t;
      let { x, y } = posRef.current;
      let { vx: cvx, vy: cvy } = velocityRef.current;
      cvy += 2600 * dt;
      x += cvx * dt;
      y += cvy * dt;
      if (x < 0) { x = 0; cvx = -cvx * 0.72; }
      if (x > width - size) { x = Math.max(0, width - size); cvx = -cvx * 0.72; }
      if (y < 0) { y = 0; cvy = -cvy * 0.72; }
      if (y > height - petHeight) {
        // 落地冲击：按落速给挤压深度（原版 landingSquash——砸得越狠蹲得越扁；
        // 软着陆 depth≈1 无可见挤压，landingSquash 内部已按速度归一）。
        const impact = Math.abs(cvy);
        y = Math.max(0, height - petHeight);
        cvy = -cvy * 0.72;
        cvx *= 0.9;
        if (stageEl) squash.start(stageEl, landingSquash(impact));
      }
      applyPos({ x, y });
      velocityRef.current = { vx: cvx, vy: cvy };
      const resting = y >= height - petHeight - 1 && Math.abs(cvy) < 90 && Math.abs(cvx) < 45;
      if (resting) {
        cancelFling();
        savePosition(x, y);
        pushHitRect(false);
        // 甩抛落地：睡着的继续睡，其余回待机链（生成联动挂着就继续工作循环）。
        if (modeRef.current === "sleep") {
          sleepStepRef.current = "loop";
          playAnim(skin.sleepLoop, true);
        } else {
          settle();
        }
        return;
      }
      flingRef.current = requestAnimationFrame(step);
    };
    velocityRef.current = { vx, vy };
    lastFrameRef.current = performance.now();
    flingRef.current = requestAnimationFrame(step);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    movedRef.current = false;
    haltGameIfRunning(); // 抓桌宠 = 吃白饭收场
    cancelAnim();
    cancelFling();
    if (stateTimerRef.current !== null) window.clearTimeout(stateTimerRef.current);
    if (settingsRef.current?.lockPosition) return; // 锁定位置：不拖拽，点击反应照常
    e.currentTarget.setPointerCapture(e.pointerId);
    dragPoseRef.current = false;
    dragRef.current = {
      startX: posRef.current.x,
      startY: posRef.current.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      lastTime: performance.now(),
      vx: 0,
      vy: 0,
    };
    setDragging(true);
    setMenu(false);
    // 拖拽期间钩子不介入，窗口保持可交互；松手后再恢复穿透判定。
    pushHitRect(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastTime);
    // 指针坐标换算：独立窗口的 client 是窗口内坐标，加窗口位置才是屏幕坐标；
    // 内嵌形态的 client 就是视口坐标（元素跟着 transform 走，不影响 client 值），直接用。
    const screenX = inline ? e.clientX : posRef.current.x + e.clientX;
    const screenY = inline ? e.clientY : posRef.current.y + e.clientY;
    const startScreenX = inline ? d.startClientX : d.startX + d.startClientX;
    const startScreenY = inline ? d.startClientY : d.startY + d.startClientY;
    const pet = settingsRef.current;
    const size = pet?.size ?? 280;
    const next = clampPosition(
      d.startX + (screenX - startScreenX),
      d.startY + (screenY - startScreenY),
      size,
      petBounds(),
    );
    if (Math.hypot(next.x - d.startX, next.y - d.startY) > 4) movedRef.current = true;
    if (movedRef.current && !dragPoseRef.current && !videoFailed) {
      // 拖离原位后换「被拖拽悬空」姿势；单击不动不算拖。
      dragPoseRef.current = true;
      playAnim(pick(skin.drag), true);
    }
    const newVx = ((e.clientX - d.lastClientX) / dt) * 1000;
    const newVy = ((e.clientY - d.lastClientY) / dt) * 1000;
    d.vx = d.vx * 0.6 + newVx * 0.4;
    d.vy = d.vy * 0.6 + newVy * 0.4;
    d.lastClientX = e.clientX;
    d.lastClientY = e.clientY;
    d.lastTime = now;
    applyPos(next);
  };

  const onPointerUp = (): void => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    dragPoseRef.current = false;
    // 单击（未拖动）也必须把交互态交还钩子：命中标志残留会让整个透明窗永久可交互——
    // 点角色外的空白也触发反应、还挡住底下应用的点击。
    pushHitRect(false);
    if (!movedRef.current) {
      // pointerCancel 走到这里时不会有 click 跟进：pointerdown 已掐掉走路的滑行动画，
      // 不收尾角色就停在半空原地扑腾。睡着的别惊动，其余回待机。
      if (modeRef.current === "walk") toIdle();
      return;
    }
    // 无论快慢，松手都进物理：有速度甩出去，没速度就地自由落体砸到底部（dsh-pet 手感）。
    // 落地结算在 startFling 的 resting 分支：存位置、恢复状态、重报命中区。
    startFling(d.vx, d.vy);
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setAnimOpen(false);
    setAnimCatOpen(null);
    setFlyoutPos(null);
    setMenu(true);
    // 独立窗口：菜单比宠物窗大——向右下扩窗给菜单与飞出子面板腾地方（关菜单时复原）。
    // 扩窗期间钩子几何（按宠物盒算）失真，直接 pushHitRect(true) 全窗放行，关菜单交还。
    if (!inline) {
      const pet = settingsRef.current;
      if (pet) {
        const growW = Math.max(0, 270 - Math.round(pet.size / 2));
        void resizePetWindow(pet.size + growW, Math.round(pet.size * PET_HEIGHT_RATIO) + 240);
      }
      pushHitRect(true);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      movedRef.current = false; // 键盘戳不背上次拖拽的锅：movedRef 只在 pointerdown 里清
      poke(); // poke 内含 Q 弹挤压与音效，键盘同样有反馈
    }
  };

  const menuAction = (action: string, anim?: string): void => {
    // 睡觉闸门（原版 menu-actions 同款）：打扰类动作睡着时只弹拒绝台词不执行；
    // 放行：睡觉/起来、回到右下角、退出桌宠。叫醒交给点击（戳它一下就醒）。
    const disturbing = action !== "sleep" && action !== "home" && action !== "hide" && action !== "eat";
    if (gameOn && action !== "eat") haltGame(); // 游戏运行中点其它菜单：先收场再执行
    if (disturbing && modeRef.current === "sleep") {
      closeMenu(); // 关菜单 + 独立窗复原尺寸 + 交还钩子
      say(SLEEP_REFUSE_TEXTS[Math.floor(Math.random() * SLEEP_REFUSE_TEXTS.length)] ?? "Zzz……", 2200);
      return;
    }
    closeMenu();
    if (action === "hello") {
      enter("react");
      playAnim(pick(skin.click), false);
      capReaction(3200);
      say("你好呀！", 2200);
    } else if (action === "whisper") {
      // 手动碎碎念：不等 42s 定时器，立刻说一句（语音开着就连声音一起）。
      const phrase = randomPhrase();
      enter("react");
      playAnim(pick(skin.whisper), false);
      say(phrase, 2400);
      speak(phrase);
    } else if (action === "play-anim" && anim !== undefined) {
      // 点播：完整播完所选动作（用户特意点的，不设时长上限），播完 settle 回待机。
      enter("react");
      playAnim(anim, false);
    } else if (action === "eat") {
      // 吃白饭小游戏开关：开演 / 收场（真玩法，不是播动画）。
      if (gameOn) { haltGame(); return; }
      startGame();
      return;
    } else if (action === "sleep") {
      toggleSleep();
    } else if (action === "home") {
      const pet = settingsRef.current;
      if (!pet) return;
      applyPos(defaultPetPosition(pet.size, petBounds()));
      savePosition(posRef.current.x, posRef.current.y);
      pushHitRect(false);
      if (modeRef.current !== "sleep") toIdle();
    } else if (action === "chat") {
      // 找小茉聊聊：内嵌同页事件直达；独立窗口跨窗发 Tauri 事件 + 唤起主窗（可能藏在托盘）。
      if (inline) {
        window.dispatchEvent(new CustomEvent("xiaomo:open-assistant"));
        return;
      }
      void openAssistantInMainWindow();
    } else if (action === "main") {
      void showMainWindow();
    } else if (action === "hide") {
      if (inline) {
        // 内嵌形态没有窗口可藏：走持久开关，PetHost 收到变更信号后收起。
        void settingsApi.saveSettings({ pet: { enabled: false } })
          .then(() => emitPetSettingsChanged())
          .catch(() => undefined);
        return;
      }
      void hidePetWindow();
    }
  };

  if (!settings) {
    return <div className="pet-root pet-loading" role="status">桌宠加载中…</div>;
  }
  if (!settings.enabled) {
    return <div className="pet-root pet-off" role="status">桌宠已关闭</div>;
  }

  // 两种形态统一：交互只挂在角色矩形命中层（.pet-hit）。整个窗口可交互时
  // （旧实现 stage inset:0），点角色头顶留白与透明边角也会触发反应；外壳钩子
  // 仍负责 OS 级点击穿透，命中层只保证页面自己不误触发。
  const interactiveProps = {
    role: "button",
    tabIndex: 0,
    "aria-label": "桌宠，点击互动，右键打开菜单",
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onClick: poke,
    // 双击没有手势语义（原版睡觉只在菜单里）：连点两下由 poke 的 300ms 去重挡成一次反应。
    onContextMenu,
    onKeyDown,
  } as const;

  /** 动作点播的「分类 → 手风琴展开动画名」行组：飞出面板与窗口手风琴共用。 */
  const animCatRows = (openCat: string | null, onToggleCat: (label: string) => void, onPlay: (name: string) => void): JSX.Element => (
    <>
      {ANIM_CATS.map((cat) => (
        <div key={cat.label}>
          <button type="button" className="pet-menu-sub" role="menuitem" onClick={() => onToggleCat(cat.label)}>
            {cat.label} {openCat === cat.label ? "▾" : "▸"}
          </button>
          {openCat === cat.label && cat.pool.map((name) => (
            <button key={name} type="button" className="pet-menu-sub2" role="menuitem" onClick={() => onPlay(name)}>
              {animLabel(name)}
            </button>
          ))}
        </div>
      ))}
    </>
  );

  // 右键菜单：动作点播是**手风琴展开**（「动作」→ 分类 → 动画名逐级展开在菜单内），
  // 不整页覆盖主页——独立窗口的菜单被困在宠物窗里，飞出式子菜单会被窗沿裁掉。
  const menuItems = (
    <>
      <button type="button" role="menuitem" onClick={() => menuAction("hello")}>打个招呼</button>
      <button type="button" role="menuitem" onClick={() => menuAction("whisper")}>碎碎念</button>
      <button type="button" role="menuitem" onClick={() => menuAction("eat")}>{gameOn ? "不吃了" : "吃白饭"}</button>
      <button type="button" role="menuitem" onClick={() => menuAction("chat")}>找小茉聊聊</button>
      <button type="button" role="menuitem" onClick={() => menuAction("sleep")}>
        {mode === "sleep" ? "叫醒" : "睡觉"}
      </button>
      <button type="button" role="menuitem" ref={animBtnRef}
        onMouseEnter={() => setAnimOpen(true)}
        onClick={() => setAnimOpen(!animOpen)}>
        动作 ▸
      </button>
      {!inline && <button type="button" role="menuitem" onClick={() => menuAction("main")}>显示主界面</button>}
      <button type="button" role="menuitem" onClick={() => menuAction("home")}>回到右下角</button>
      <button type="button" role="menuitem" onClick={() => menuAction("hide")}>退出桌宠</button>
    </>
  );

  const closeMenu = (): void => {
    setMenu(false);
    setAnimOpen(false);
    setAnimCatOpen(null);
    setFlyoutPos(null);
    // 独立窗口：菜单开着时曾向右下扩窗（给菜单/飞出面板腾地方），关菜单复原回宠物盒。
    if (!inline) {
      const pet = settingsRef.current;
      if (pet) void resizePetWindow(pet.size, Math.round(pet.size * PET_HEIGHT_RATIO));
      pushHitRect(false);
    }
  };

  return (
    <div
      className={"pet-root" + (inline ? " is-inline" : "") + (dragging ? " is-dragging" : "") + (settings.lockPosition ? " is-locked" : "")}
      data-state={mode}
      style={{
        "--pet-size": `${settings.size}px`,
        "--pet-video-w": String(PET_VIDEO_STYLE.w),
        "--pet-video-left": String(PET_VIDEO_STYLE.left),
        "--pet-video-top": String(PET_VIDEO_STYLE.top),
        "--pet-char-top": String(PET_CHAR_TOP),
        "--pet-bubble-bottom": String(PET_BUBBLE_BOTTOM),
        "--pet-opacity": String((settings.opacity ?? 100) / 100),
        // 内嵌形态：盒子就是体型大小，位置经 transform 落在视口内（独立窗口位置即窗口本身）。
        ...(inline ? {
          width: `${settings.size}px`,
          height: `${Math.round(settings.size * PET_HEIGHT_RATIO)}px`,
          transform: `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`,
        } : {}),
      } as CSSProperties}
    >
      {bubble && <div className="pet-bubble" role="status">{bubble}</div>}
      <div ref={stageRef} className="pet-stage">
        <PetMascot
          skin={skin}
          anim={anim}
          videoFailed={videoFailed}
          facing={facing === "right" ? "right" : "left"}
          onEnded={onAnimEnded}
          onError={() => setVideoFailed(true)}
        />
      </div>
      <div className="pet-hit" {...interactiveProps} />
      {menuOpen && (inline ? (
        // 内嵌形态的菜单背板要盖住整个主窗口：portal 到 body，避开 fixed 在
        // transform 祖先里被当包含块的坑（与全站浮层 portal 到 body 同一规矩）。
        createPortal(
          <div className="pet-menu-backdrop is-inline" onClick={closeMenu}
            onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}>
            <div ref={menuRef} className="pet-menu is-inline" role="menu" aria-label="桌宠菜单"
              style={{ left: Math.round(pos.x + settings.size / 2), top: Math.round(pos.y + Math.round(settings.size * PET_HEIGHT_RATIO) / 2) }}
              onClick={(e) => e.stopPropagation()}>
              {menuItems}
            </div>
            {animOpen && flyoutPos && (
              <div className="pet-menu pet-menu-flyout" role="menu" aria-label="动作点播"
                style={{ left: flyoutPos.left, top: flyoutPos.top }}
                onClick={(e) => e.stopPropagation()}>
                {animCatRows(animCatOpen, (l) => setAnimCatOpen(animCatOpen === l ? null : l), (name) => menuAction("play-anim", name))}
              </div>
            )}
          </div>,
          document.body,
        )
      ) : (
        <div className="pet-menu-backdrop" onClick={closeMenu}
          onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}>
          <div ref={menuRef} className="pet-menu" role="menu" aria-label="桌宠菜单"
            style={{ left: Math.round(settings.size / 2), top: Math.max(160, Math.round(settings.size * PET_HEIGHT_RATIO / 2)) }}
            onClick={(e) => e.stopPropagation()}>
            {menuItems}
          </div>
          {animOpen && flyoutPos && (
            <div className="pet-menu pet-menu-flyout" role="menu" aria-label="动作点播"
              style={{ left: flyoutPos.left, top: flyoutPos.top }}
              onClick={(e) => e.stopPropagation()}>
              {animCatRows(animCatOpen, (l) => setAnimCatOpen(animCatOpen === l ? null : l), (name) => menuAction("play-anim", name))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
