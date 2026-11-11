// 一轮内提醒条数的闸门：纯进程内计数，零依赖。
//
// 为什么单独一层：占额度的是工具层（schedule_reminder 执行时），到期兑现的是主动性层。
// 共享状态下沉到这个零依赖模块，两侧各自向下 import，依赖方向保持单向
// （proactive 与 tools 互不反向依赖）；行为与计数口径完全不变。

/** 一轮里最多立几条提醒。 */
// 模型一次回复可能带多个 tool_calls（schedule_reminder 也在内），轮数上限又是 8——
// 不设这道闸就是一轮 8 条到点推送。而 reminder 是「到点必达、不吃每日主动配额」的，
// 配额那边拦不住它，只能在这儿按轮数挡。
export const REMINDERS_PER_TURN = 2;

/** 这一轮已经立了几条提醒（进程内计数；turnId 为空 = 手动创建，不拦）。 */
const remindersThisTurn = new Map<string, number>();

/** 判断这一轮还能不能再立一条提醒；能就占一个额度。 */
export function takeReminderSlot(turnId: string | null): boolean {
  if (!turnId) return true;
  const used = remindersThisTurn.get(turnId) ?? 0;
  if (used >= REMINDERS_PER_TURN) return false;
  remindersThisTurn.set(turnId, used + 1);
  // 别让这张表跟着 turnId 无限长：一轮结束就不会再有人来取，超过一屏就整体丢掉最早的。
  if (remindersThisTurn.size > 256) {
    for (const key of [...remindersThisTurn.keys()].slice(0, 128)) remindersThisTurn.delete(key);
  }
  return true;
}
