// 「下一次该在什么时候醒」变了，就敲一下调度器。纯进程内一个回调，零依赖。
//
// 为什么单独一层：立提醒的路径在 tools.ts（schedule_reminder），而调度器在 proactive.ts。
// 前者直接 import 后者会形成 agent → tools → proactive → agent 的运行时环——
// 和当初把提醒额度下沉到 core/reminder-slot.ts 是同一个理由：
// 两边各自向下依赖 core，依赖方向保持单向。
//
// 没注册监听（非当家进程、`--proactive-once`、还没起定时器）时 requestWake 是空操作，
// 不会在只提供界面的进程里凭空起一个定时器。

type Listener = () => void;

let listener: Listener | null = null;

/** 由调度器在启动时注册、停止时清掉；同一时刻只允许一个。 */
export function onWakeNeeded(fn: Listener | null): void {
  listener = fn;
}

/** 有人加/改了会在将来某个时刻到期的东西，请调度器重新算一次闹钟。 */
export function requestWake(): void {
  listener?.();
}
