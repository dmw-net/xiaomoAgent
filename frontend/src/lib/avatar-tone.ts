import type { CSSProperties } from "react";

/**
 * 联系人首字母头像落到暖陶瓷色阶的哪一档。
 *
 * 按名字算而不是按 id：做到'同一个人在任何界面都是同一支颜色'——侧栏、气泡、
 * 资料页、切换芯片四处都拿得到名字，但只有侧栏拿得到 id。名字改了颜色会跟着变，
 * 这个代价换来的是四个组件不必相互传色。
 * 六档色值定义在 legacy.css 的 --ava-c1..c6，明暗各一套。
 */
export function avatarTone(seed: string): number {
  // FNV-1a 再走一遍雪崩混合。裸的 "h*31+c" 在中文名上会明显扎堆——
  // 六个联系人里能有四个落在同一档，一屏看下来像同一个人的四个副本。
  let h = 0x811c9dc5;
  for (const ch of seed || "?") {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) % 6;
}

/** 给头像容器挂的 inline 变量：CSS 里只用 var(--s-ava-bg, var(--accent)) 一个出口。 */
export function avatarToneStyle(seed: string): CSSProperties {
  return { ["--s-ava-bg"]: `var(--ava-c${avatarTone(seed) + 1})` } as CSSProperties;
}
