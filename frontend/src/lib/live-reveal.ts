/**
 * 流式草稿的「逐字揭示」纯逻辑。
 *
 * 为什么要它：服务端按 200ms 节流写草稿，前端按 900ms 轮询取，所以界面收到的永远是
 * 一坨（实测一次跳 41 字、再跳 32 字，然后干等 1.1 秒不动）——传输节奏有多粗，
 * 打字就有多僵。解法是把**显示节奏和传输节奏解耦**：收到的只是"目标文本"，
 * 界面自己一拍一拍追上去（一拍一个字）。
 *
 * 拆成纯函数是因为这一段的坑全在边界上（换轮、工具轮改口、一次跳很多字），
 * 而界面那一侧只能在浏览器里量，逻辑在这里能单独判。
 */

/** 一拍多少毫秒。32ms ≈ 31 帧/秒的观感，又不至于每帧都重排。 */
export const REVEAL_TICK_MS = 32;
/** 匀速阶段每拍吐几个字（≈31 字/秒，接近真人打字速度）。 */
export const REVEAL_CHARS_PER_TICK = 1;
/** 落后时的追赶除数：每拍至少消化掉差距的 1/24，保证一次大跳 ≤ ~0.8 秒被吸收。 */
export const REVEAL_CATCH_UP_DIVISOR = 24;
/**
 * 系统要求「减少动效」时每拍几个字。
 * 这里刻意不是"整段直出"——一坨文本跳出来再静一秒，正是用户报的那个僵硬；
 * 逐字揭示对这个应用是内容不是装饰，关掉闪烁的光标（CSS 那侧）才是偏好要管的事。
 * 4 字/拍 ≈ 125 字/秒：两拍追平，看不出动画但也不会整段砸出来。
 */
export const REVEAL_REDUCED_CHARS = 4;

/**
 * 这一拍该显示哪一段。
 *
 * 重置的条件不是「文本变短」而是「当前显示的不再是新文本的前缀」——
 * 换了一轮、或工具轮改口重说，那就从头打，绝不做字符级 morph（那会看出拼接痕迹）。
 */
export function revealStep(
  target: string,
  shown: string,
  charsPerTick = REVEAL_CHARS_PER_TICK,
  catchUpDivisor = REVEAL_CATCH_UP_DIVISOR,
): string {
  if (shown.length > target.length || !target.startsWith(shown)) return "";
  if (shown === target) return shown;
  const gap = target.length - shown.length;
  const step = Math.max(charsPerTick, Math.ceil(gap / catchUpDivisor));
  return target.slice(0, Math.min(target.length, shown.length + step));
}
