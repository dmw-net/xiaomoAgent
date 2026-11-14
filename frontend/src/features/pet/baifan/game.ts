/**
 * 「吃白饭」的演出导演：跑到底 → 期待开饭 → 追着吃 → 收场。
 * 移植自 dsh-pet（MIT，baifan/show.ts），原版的宿主 HTTP/占用锁换成了**注入的宠物控制面**——
 * 小茉里演出与桌宠同页同源，直接驱动自己的动画/位置/气泡，不需要抢宠物的锁。
 *
 * 单一状态机：相位、朝向都在同一份场次状态里；所有等待都问片段回执（onClipEnd），
 * 不用「素材多长」的定时器——定时器在素材加载失败时照样会走到「播完」。
 * @module 桌宠吃白饭演出
 */
import type { PetGameControl } from "./control";
import { ARRIVE_PX, BUBBLE_MS, EAT_PX, FULL_EVERY, IDLE_MS, LINES, MOUTH_DX, MOUTH_RATIO, PATROL_SPEED_RATIO, REF_WIDTH, RUN_SPEED, SPAWN_MS, TRIP_MAX_MS, TRAVEL_MS, PREP_MS, SIDE_WATCH_MS } from "./constants";
import { createScene, type RiceItem } from "./scene";

/** 相位：没开演 / 跑向底部 / 期待 / 追饭 / 吃。 */
type Phase = "idle" | "walk" | "expect" | "chase" | "eat";

/** 正常收场与用户打断都走它，不弹错误提示。 */
class Halted extends Error {}

/** 造演出导演。pet：PetView 注入的宠物控制面。 */
export function createBaifanGame(pet: PetGameControl) {

  /** 米饭/分数/toast 的浮层：首次开演时挂到 body，收场留着（空层不可见不挡点）。 */
  let scene: ReturnType<typeof createScene> | null = null;

  /** 浮层与场景按需就位；按 id 防重（StrictMode 双挂载也不出两层）。 */
  function ensureScene(): ReturnType<typeof createScene> {
    if (scene !== null) return scene;
    let host = document.getElementById("pet-baifan-layer");
    if (host === null) {
      host = document.createElement("div");
      host.id = "pet-baifan-layer";
      document.body.appendChild(host);
    }
    const div = host as HTMLDivElement;
    div.textContent = "";
    const toast = document.createElement("div");
    toast.className = "bf-toast";
    div.appendChild(toast);
    scene = createScene(div, toast);
    return scene;
  }

  /** 相位。 */
  let phase: Phase = "idle";
  /** 本场是否在跑。 */
  let running = false;
  /** 已经吃了几份。 */
  let eaten = 0;
  /** 当前朝向。 */
  let facing: "left" | "right" = "left";
  /** 没饭可追时的溜达目标（px）；null = 该重新抽一个。 */
  let patrolX: number | null = null;
  /** 这场用的五段动画名（skin.baifan 槽位：跑到底/追饭/期待/吃碗饭/吃饭团）。 */
  let anims: readonly [string, string, string, string, string] = ["", "", "", "", ""];
  /** 掉饭定时器。 */
  let spawnTimer = 0;
  /** 追饭动画看门狗。 */
  let sideWatch = 0;
  /** 收场钩子（PetView 复位模式/窗口用）。 */
  let onHalt: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
  const pickLine = (pool: readonly string[]): string => pool[Math.floor(Math.random() * pool.length)] ?? "";

  /** 几何量：全部从注入面现读（视口像素）。 */
  function geom(): { cx: number; top: number; h: number; w: number; mouthY: number; scale: number; vw: number; ground: number; groundPosY: number } {
    const p = pet.pos();
    const size = pet.petSize();
    const petH = Math.round(size * 1.2835);
    const vw = pet.viewport().w;
    const vh = pet.viewport().h;
    const ground = vh - 26;
    return {
      cx: p.x + size / 2,
      top: p.y,
      h: petH,
      w: size,
      mouthY: p.y + petH * MOUTH_RATIO,
      scale: size / REF_WIDTH,
      vw,
      ground,
      groundPosY: ground - petH,
    };
  }

  /** 等「当前片段播完」；游戏激活时 PetView 的 onAnimEnded 会派发到这边登记的回调。 */
  function clipEnd(): Promise<void> {
    return new Promise((resolve) => pet.onClipEnd(() => resolve()));
  }

  /** 开演：建米饭层、置相位、跑状态机。anims：skin.baifan 的五段槽位。 */
  function start(names: readonly [string, string, string, string, string]): void {
    if (running) return;
    anims = [...names] as [string, string, string, string, string];
    running = true;
    eaten = 0;
    patrolX = null;
    phase = "idle";
    ensureScene().toast("吃白饭 —— 开饭了");
    void runShow();
  }

  /** 收场：停一切、清干净、复位朝向；幂等。 */
  function halt(reason?: string): void {
    if (!running) return;
    running = false;
    phase = "idle";
    if (spawnTimer !== 0) {
      window.clearInterval(spawnTimer);
      spawnTimer = 0;
    }
    stopSideWatch();
    ensureScene().clear();
    patrolX = null;
    pet.setFacing("left");
    if (reason !== undefined && reason !== "") ensureScene().toast(reason);
    onHalt?.();
  }

  /** 跑完整场演出；任何相位的 Halted 都落到这里收场。 */
  async function runShow(): Promise<void> {
    try {
      pet.say(pickLine(LINES.start), 2200);
      await phaseWalk();
      await phaseExpect();
      await phaseChase();
    } catch (error) {
      if (!(error instanceof Halted)) ensureScene().toast(error instanceof Error ? error.message : String(error));
    } finally {
      halt();
    }
  }

  /** 一阶段：跑到底部。播 descend → 蓄力 → 滑行到随机落点（每次都不一样，是第一眼观感）。 */
  async function phaseWalk(): Promise<void> {
    phase = "walk";
    const g = geom();
    const margin = Math.max(60, g.w / 2);
    const targetPx = margin + Math.random() * Math.max(10, g.vw - margin * 2);
    pet.say(pickLine(LINES.down), 2400);
    pet.playAnim(anims[0], false);
    await clipEnd();
    await sleep(PREP_MS);
    if (!running) throw new Halted();
    // moveTo 的目标是「宠物中心」对齐：盒左 = 目标 - 半宽（原版 pose 即中心语义）。
    await pet.moveTo(targetPx - pet.petSize() / 2, g.groundPosY, TRAVEL_MS);
    if (!running) throw new Halted();
  }

  /** 二阶段：期待开饭（循环播，等饭落地）。 */
  async function phaseExpect(): Promise<void> {
    phase = "expect";
    pet.say(pickLine(LINES.expect), 3000);
    pet.playAnim(anims[2], true);
    if (!running) throw new Halted();
  }

  /** 吃掉一份：饭飞到嘴边 → 随咀嚼变小 → 空碗落地 → 弹分数。 */
  async function eatOne(item: RiceItem): Promise<void> {
    phase = "eat";
    ensureScene().detach(item);
    const isBowl = item.type === "bowl";
    const g = geom();
    pet.playAnim(isBowl ? anims[3] : anims[4], false);
    const flyMs = 3200; // 与吃片段的咀嚼节奏对齐的观感值
    ensureScene().flyToMouth(item, g.cx + MOUTH_DX * g.w * (facing === "right" ? -1 : 1), g.mouthY, flyMs);
    if (isBowl) window.setTimeout(() => ensureScene().dropEmptyBowl(g.cx, g.mouthY, g.scale), Math.max(0, flyMs - 120));
    await clipEnd();
    if (!running) return;

    eaten += 1;
    ensureScene().popScore(eaten, item.type, g);
    pet.say(pickLine(isBowl ? LINES.bowl : LINES.ball), BUBBLE_MS);
    // 吃到一定数量才吹牛，不然每口都来一句会烦
    if (eaten % FULL_EVERY === 0) window.setTimeout(() => pet.say(pickLine(LINES.full), 2600), 1200);
    phase = "chase";
  }

  /** 开刷：先掉一份，之后按间隔继续。 */
  function startSpawning(): void {
    if (spawnTimer !== 0) return;
    ensureScene().spawn(geom().scale);
    ensureScene().kick();
    spawnTimer = window.setInterval(() => {
      if (phase !== "chase" && phase !== "eat") return;
      ensureScene().spawn(geom().scale);
      ensureScene().kick();
    }, SPAWN_MS);
  }

  /** 追饭期间的看门狗：跑动动画停了就重新拉起（我们直接 loop，防御性兜底）。 */
  function startSideWatch(): void {
    stopSideWatch();
    sideWatch = window.setInterval(() => {
      if (!running || phase !== "chase") return;
      pet.playAnim(anims[1], true);
    }, SIDE_WATCH_MS);
  }

  function stopSideWatch(): void {
    if (sideWatch !== 0) window.clearInterval(sideWatch);
    sideWatch = 0;
  }

  /** 三阶段：追饭。一段一段地跑，跑到了才做下一个决定。 */
  async function phaseChase(): Promise<void> {
    phase = "chase";
    startSpawning();
    startSideWatch();
    pet.say(pickLine(LINES.drop), 2200);
    while (running) {
      const g = geom();
      const target = ensureScene().nearest(g.cx, facing);
      const eatPx = EAT_PX * g.scale;
      if (target !== null && Math.abs(target.x - g.cx) <= eatPx) {
        await eatOne(target);
        continue;
      }
      const goalPx = target !== null ? target.x : patrolGoal(g);
      const speed = target !== null ? RUN_SPEED : RUN_SPEED * PATROL_SPEED_RATIO;
      const distance = Math.abs(goalPx - g.cx);
      if (distance > ARRIVE_PX) {
        facing = goalPx > g.cx ? "right" : "left";
        pet.setFacing(facing);
        const durationMs = Math.min(TRIP_MAX_MS, Math.max(180, (distance / speed) * 1000));
        pet.playAnim(anims[1], true);
        await pet.moveTo(goalPx - pet.petSize() / 2, g.groundPosY, durationMs);
        await sleep(80);
      } else {
        await sleep(IDLE_MS);
      }
      if (!running) return;
    }
  }

  /** 没饭可追时随便挑个地方跑过去，到了下一拍再挑。 */
  function patrolGoal(g: { cx: number; w: number; vw: number }): number {
    const margin = Math.max(80, g.w * 0.4);
    if (patrolX === null || Math.abs(patrolX - g.cx) <= ARRIVE_PX) {
      patrolX = margin + Math.random() * Math.max(10, g.vw - margin * 2);
    }
    return patrolX;
  }

  /** 注册收场钩子（PetView 复位模式/窗口）。 */
  function setOnHalt(cb: () => void): void {
    onHalt = cb;
  }

  return { start, halt, isRunning: () => running, setOnHalt };
}

/** 演出导演的对外类型（PetView 持有引用用）。 */
export type BaifanGame = ReturnType<typeof createBaifanGame>;
