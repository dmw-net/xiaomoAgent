/**
 * 「吃白饭」的米饭层：掉落、落体循环、飞向嘴边、空碗与分数气泡。
 * 移植自 dsh-pet（MIT，baifan/scene.ts），宿主层换成小茉自己的浮层（调用方挂到 body，
 * fixed inset:0，z 压在桌宠之上、pointer-events:none——米饭不接点击，全自动演出）。
 * 自持 DOM 与 rAF（落体只在有东西还在天上时才跑），不碰演出相位——相位归 game.ts。
 * @module 桌宠吃白饭场景
 */
import { GROUND_OFFSET } from "./constants";
import { PET_BAIFAN_PIC } from "../petAssets";

/** 场上的一份饭。 */
export interface RiceItem {
  /** 元素。 */
  el: HTMLImageElement;
  /** 视口中心 x。 */
  x: number;
  /** 底边 y。 */
  y: number;
  /** 渲染宽。 */
  w: number;
  /** 渲染高。 */
  h: number;
  /** 碗饭还是饭团。 */
  type: "bowl" | "ball";
  /** 下落速度（像素/秒）。 */
  vy: number;
  /** 当前旋转角（度）。 */
  rot: number;
  /** 旋转速度（度/秒）。 */
  spin: number;
  /** 状态：还在落 / 已落地。 */
  state: "falling" | "ground";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

/** 地面线：视口底往上一点。 */
function groundLine(): number {
  return window.innerHeight - GROUND_OFFSET;
}

/**
 * 造米饭层。
 *
 * @param layer - 覆盖层根节点（所有米饭/分数都挂它下面）。
 * @param toastEl - 提示条节点；toast() 直接写它。
 * @returns 生成、落体、飞行、计分与清理的方法。
 */
export function createScene(layer: HTMLDivElement, toastEl: HTMLDivElement) {
  /** 场上的饭。 */
  let items: RiceItem[] = [];
  /** 落体循环的 rAF 句柄；0 = 没在跑。 */
  let frame = 0;
  /** 上一帧时间戳（毫秒）。 */
  let lastMs = 0;
  /** 提示条的淡出定时器。 */
  let toastTimer = 0;

  /** 底部居中提示条，1.8 秒后自己淡掉。 */
  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  /** 按当前坐标写样式。 */
  function layout(item: RiceItem): void {
    item.el.style.left = item.x - item.w / 2 + "px";
    item.el.style.top = item.y - item.h + "px";
    item.el.style.transform = "rotate(" + item.rot + "deg)";
  }

  /** 从天上掉一份饭：位置视口内随机（左右各留 70px），尺寸按精灵缩放。 */
  function spawn(scale: number): RiceItem | null {
    if (items.length >= 2) return null;
    const isBowl = Math.random() < 0.38;
    const w = Math.round((isBowl ? 124 : 110) * scale);
    const img = el("img");
    img.className = "bf-rice";
    img.src = isBowl ? PET_BAIFAN_PIC.bowlFull : PET_BAIFAN_PIC.riceBall;
    img.alt = "";
    img.draggable = false;
    img.style.width = w + "px";
    img.style.height = w + "px";
    const item: RiceItem = {
      el: img,
      x: 70 + Math.random() * Math.max(10, window.innerWidth - 140),
      y: -w - 20,
      w,
      h: w,
      type: isBowl ? "bowl" : "ball",
      vy: 170 + Math.random() * 60,
      rot: 0,
      spin: isBowl ? 0 : (Math.random() < 0.5 ? -1 : 1) * 90,
      state: "falling",
    };
    layer.appendChild(img);
    items.push(item);
    layout(item);
    return item;
  }

  /** 落体循环：只在还有东西在天上时才跑 rAF，落地后自然停下来。 */
  function fallTick(ts: number): void {
    frame = 0;
    if (!lastMs) lastMs = ts;
    const dt = Math.min((ts - lastMs) / 1000, 0.05);
    lastMs = ts;

    let falling = false;
    const line = groundLine();
    for (const item of items) {
      if (item.state !== "falling") {
        if (item.rot !== 0) {
          item.rot = 0;
          layout(item);
        }
        continue;
      }
      falling = true;
      item.y += item.vy * dt;
      item.rot += item.spin * dt;
      if (item.y >= line) {
        item.y = line;
        item.state = "ground";
        item.el.animate(
          [{ transform: "scaleY(1)" }, { transform: "scaleY(.92)" }, { transform: "scaleY(1)" }],
          { duration: 160, easing: "ease-out" },
        );
      }
      layout(item);
    }
    if (falling && frame === 0) frame = window.requestAnimationFrame(fallTick);
  }

  /** 按需拉起落体循环。 */
  function kick(): void {
    if (frame === 0) frame = window.requestAnimationFrame(fallTick);
  }

  /** 场上离得最近的、已落地的饭；身后的那份距离打折（换朝向要重开跑步动画，能不换就不换）。 */
  function nearest(petPx: number, facing: "left" | "right"): RiceItem | null {
    let best: RiceItem | null = null;
    let bestScore = Infinity;
    for (const item of items) {
      if (item.state !== "ground") continue;
      const distance = Math.abs(item.x - petPx);
      const ahead = facing === "right" ? item.x > petPx : item.x < petPx;
      const score = ahead ? distance : distance * 1.8;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  /** 把一份饭从场上摘掉（元素交给调用方决定什么时候删）。 */
  function detach(item: RiceItem): void {
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
  }

  /** 吃掉一份：飞到嘴边，随咀嚼缩小，到点自己删元素。 */
  function flyToMouth(item: RiceItem, mouthX: number, mouthY: number, durationMs: number): void {
    const dx = mouthX - item.x;
    const dy = mouthY - (item.y - item.h / 2);
    item.el.style.zIndex = "5";
    item.el.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 1, offset: 0 },
        { transform: `translate(${dx}px,${dy}px) scale(.72)`, opacity: 1, offset: 0.16 },
        { transform: `translate(${dx}px,${dy}px) scale(.68)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px,${dy}px) scale(.12)`, opacity: 0, offset: 1 },
      ],
      { duration: durationMs, easing: "ease-in-out", fill: "forwards" },
    );
    window.setTimeout(() => item.el.remove(), durationMs + 80);
  }

  /** 空碗：从嘴边掉到地上，弹两下，然后淡出。 */
  function dropEmptyBowl(x: number, fromY: number, scale: number): void {
    const w = Math.round(124 * scale);
    const img = el("img");
    img.className = "bf-rice";
    img.src = PET_BAIFAN_PIC.bowlEmpty;
    img.alt = "";
    img.draggable = false;
    img.style.width = w + "px";
    img.style.height = w + "px";
    img.style.left = x - w / 2 + "px";
    img.style.top = fromY - w + "px";
    layer.appendChild(img);

    const drop = Math.max(0, groundLine() - fromY);
    img.animate(
      [
        { transform: "translateY(0)" },
        { transform: `translateY(${drop}px)`, offset: 0.48, easing: "ease-in" },
        { transform: `translateY(${drop - 42 * scale}px)`, offset: 0.62, easing: "ease-out" },
        { transform: `translateY(${drop}px)`, offset: 0.74, easing: "ease-in" },
        { transform: `translateY(${drop - 14 * scale}px)`, offset: 0.82, easing: "ease-out" },
        { transform: `translateY(${drop}px)`, offset: 0.9 },
        { transform: `translateY(${drop}px)`, offset: 1 },
      ],
      { duration: 820, easing: "linear", fill: "forwards" },
    );
    window.setTimeout(() => {
      img.style.transition = "opacity .9s ease";
      img.style.opacity = "0";
    }, 900);
    window.setTimeout(() => img.remove(), 1850);
  }

  /** 分数气泡：碗图 + 数字 + 「+1」，1300ms 上浮消失后摘节点。 */
  function popScore(value: number, type: "bowl" | "ball", geom: { cx: number; top: number; h: number }): void {
    const div = el("div");
    div.className = "bf-score";
    const img = el("img");
    img.className = type === "bowl" ? "bowl" : "ball";
    img.src = type === "bowl" ? PET_BAIFAN_PIC.bowlFull : PET_BAIFAN_PIC.riceBall;
    img.alt = "";
    const num = el("span");
    num.className = "num";
    num.textContent = String(value);
    const plus = el("span");
    plus.className = "plus";
    plus.textContent = "+1";
    div.append(img, num, plus);
    div.style.left = geom.cx + "px";
    div.style.top = geom.top + geom.h * 0.09 + "px";
    layer.appendChild(div);
    div.animate(
      [
        { transform: "translate(-50%,-100%) scale(.55)", opacity: 1 },
        { transform: "translate(-50%,-100%) scale(1.16)", opacity: 1, offset: 0.26 },
        { transform: "translate(-50%,-100%) scale(1)", opacity: 1, offset: 0.5 },
        { transform: "translate(-50%,-100%) scale(1)", opacity: 1, offset: 0.78 },
        { transform: "translate(-50%,-232%) scale(1)", opacity: 0, offset: 1 },
      ],
      { duration: 1300, easing: "ease-out", fill: "forwards" },
    );
    window.setTimeout(() => div.remove(), 1350);
  }

  /** 收场：停 rAF、淡掉场上所有饭、清空。 */
  function clear(): void {
    if (frame !== 0) window.cancelAnimationFrame(frame);
    frame = 0;
    lastMs = 0;
    for (const item of items) {
      item.el.style.transition = "opacity .5s ease";
      item.el.style.opacity = "0";
      window.setTimeout(() => item.el.remove(), 520);
    }
    items = [];
  }

  return { spawn, kick, nearest, detach, flyToMouth, dropEmptyBowl, popScore, toast, clear };
}
