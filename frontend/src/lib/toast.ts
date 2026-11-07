/**
 * 全局轻提示（toast）store：一处 store 一个出口（同 lib/undo.ts 的模式）。
 *
 * 为什么要有它：设置域的保存反馈原来全是就地 banner——modelBanner 绑在模型分区、
 * tool note 绑在台账卡。用户点完「保存」立刻切分组，成功/失败提示就跟着分区一起
 * 卸载了，只能靠猜（useSettingsForm 的 resetBanner 注释里「按钮在系统页、提示也要
 * 落在系统页」就是这类事故的补丁记录）。banner 补丁一个页面一个页面地堵不完，
 * 收敛成一个跨视图的出口：结果类提示统一走这里，用户切到哪个分组都看得见。
 *
 * 为什么不并掉聊天流里的 useNotices：那份提示带「重试」动作、生命周期挂在某一轮
 * 对话上，且只应出现在会话视图里；这里是纯结果的跨视图提示，两者语义不同。
 * MediaLibrary 的本地 toast 同理（挂在它自己的弹窗上下文里）。
 *
 * 为什么叫 toast.ts 而不是 notify.ts：lib/notify.ts 已经是「系统级通知」（Web /
 * Tauri 原生通知 + 角标）的真源，名字被占了；这层是应用内的轻提示，别混为一谈。
 */
export type ToastKind = "ok" | "warn" | "error";

export type ToastItem = { id: number; text: string; kind: ToastKind };

/** 成功提示一眼扫过就够；失败/警告要给足读清原因的时间（对齐聊天流 useNotices 的 8s）。 */
const OK_TTL_MS = 3200;
const BAD_TTL_MS = 8000;
/** 同时最多留 3 条：再多的会被顶掉——提示是打断，堆成一面墙就没人看了。 */
const MAX_VISIBLE = 3;

let items: ToastItem[] = [];
let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const subs = new Set<() => void>();

const emit = (): void => { for (const f of subs) f(); };

/** 压入一条提示；相同文案的活跃提示不重复压（连点两次保存不要叠两条一样的）。 */
export function offerToast(text: string, kind: ToastKind = "ok"): void {
  if (items.some((n) => n.text === text && n.kind === kind)) return;
  seq += 1;
  const item: ToastItem = { id: seq, text, kind };
  items = [...items.slice(-(MAX_VISIBLE - 1)), item];
  const ttl = kind === "ok" ? OK_TTL_MS : BAD_TTL_MS;
  timers.set(item.id, setTimeout(() => dismissToast(item.id), ttl));
  emit();
}

/** 只是把这条提示收走。 */
export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) { clearTimeout(t); timers.delete(id); }
  const next = items.filter((n) => n.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function getToasts(): ToastItem[] { return items; }

export function subscribeToasts(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
