/**
 * Q 弹挤压：前台画面贴地压扁再回弹（「压缩下蹲」手感）。
 * 曲线与驱动改编自 dsh-pet（MIT，src/client/pet/motion/squash.ts + shared/physics）：
 * 前 45% 二次缓入压到 depth，其余时间 easeOutBack 回弹（约 4% 过冲，上限 1.12）；
 * 220ms 一条，rAF 驱动 + 世代号丢弃迟到帧，避免两次挤压互相抢 transform；
 * 尊重系统的「减少动效」：命中时不挤压，界面照常。
 *
 * 作用对象是**舞台层**而不是单路视频：A/B 交换时挤压不会被换台打断。
 */

/** 点击挤压深度：压到 55% 高度（下蹲感）。 */
export const SQ_SQUASH = 0.55;
/** 一次挤压的总时长（ms）。 */
export const SQ_DURATION_MS = 220;
/** 落地冲击的两个标定速度（px/s）：软着陆 / 硬砸地。 */
export const SQ_SOFT_SPEED = 300;
export const SQ_HARD_SPEED = 1500;
/** 挤压深度下限（最扁 0.55）。 */
export const SQ_MAX_SQUASH = 0.55;
/** 回弹过冲上限。 */
export const SQ_OVERSHOOT_MAX = 1.12;

const EASE_OUT_BACK_C1 = 1.70158;
const EASE_OUT_BACK_C3 = EASE_OUT_BACK_C1 + 1;

/** 进度 u∈[0,1] → 该时刻的 scaleY：前 45% 二次压入，之后 easeOutBack 回弹过冲。 */
export function squashScale(u: number, squash: number = SQ_SQUASH): number {
  if (u < 0.45) {
    const p = u / 0.45;
    return 1 - (1 - squash) * p * p;
  }
  const p = (u - 0.45) / 0.55;
  const f = 1 + EASE_OUT_BACK_C3 * Math.pow(p - 1, 3) + EASE_OUT_BACK_C1 * Math.pow(p - 1, 2);
  return Math.min(SQ_OVERSHOOT_MAX, squash + (1 - squash) * Math.max(f, 0));
}

/** 落地冲击速度 → 挤压深度：软着陆 1（不压），硬砸地压到 SQ_MAX_SQUASH。结果钳在 ≤0.8。 */
export function landingSquash(impactSpeed: number): number {
  const span = SQ_HARD_SPEED - SQ_SOFT_SPEED;
  const u = Math.min(1, Math.max(0, (impactSpeed - SQ_SOFT_SPEED) / span));
  return Math.min(1 - u * (1 - SQ_MAX_SQUASH), 0.8);
}

/** 挤压驱动：一个宠物一个实例。 */
export interface SquashDriver {
  /** 挤压一次；depth 缺省为点击档（落地冲击按落速给更深的值）。 */
  start: (el: HTMLElement, depth?: number) => void;
  /** 立刻复位并放弃进行中的一次。 */
  stop: () => void;
}

/** 造挤压驱动。rAF 直接写 transform，元素上不要挂 transform 过渡（会跟帧抢）。 */
export function createSquashDriver(): SquashDriver {
  /** 进行中的 rAF；null = 没有挤压在跑。 */
  let frame: number | null = null;
  /** 世代号：每次开始或停止都 +1，迟到的帧据此自弃。 */
  let token = 0;

  const stop = (): void => {
    token += 1;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };

  const start = (el: HTMLElement, depth: number = SQ_SQUASH): void => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    token += 1;
    const current = token;
    if (frame !== null) cancelAnimationFrame(frame);
    // 贴地压扁：原点钉在元素底缘（裁剪窗底就在角色脚边），身体朝地面坐下去。
    el.style.transformOrigin = "bottom";
    const t0 = performance.now();
    const step = (): void => {
      if (token !== current) return;
      const u = Math.min((performance.now() - t0) / SQ_DURATION_MS, 1);
      el.style.transform = `scaleY(${squashScale(u, depth)})`;
      if (u < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      frame = null;
      el.style.transformOrigin = "";
      el.style.transform = "";
    };
    frame = requestAnimationFrame(step);
  };

  return { start, stop };
}
