/**
 * 一条「刚做完、还能反悔」的操作。
 *
 * 为什么不是确认框：删一条记忆、归档一个人，都是**可逆**的（记忆是墓碑、归档有 unarchive），
 * 却要用户在动手前答一次"你确定吗"——微信/钉钉对可逆操作的做法是**做完给几秒反悔**，
 * 少一次打断，也不会出现"点完确认界面跑到哪去了"那种困惑。
 * 真不可逆的（删一条消息：行是真删、图片文件也回收了）仍然走确认框，别硬套这条。
 */
export type UndoItem = { id: number; text: string; run: () => void };

const WINDOW_MS = 5000;
let current: UndoItem | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();

const emit = (): void => { for (const f of subs) f(); };

export function offerUndo(text: string, run: () => void): void {
  if (timer !== null) clearTimeout(timer);
  current = { id: Date.now(), text, run };
  timer = setTimeout(() => { current = null; timer = null; emit(); }, WINDOW_MS);
  emit();
}

/** 撤销：执行逆操作并收掉这条提示。 */
export function takeUndo(): void {
  const item = current;
  current = null;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  emit();
  item?.run();
}

/** 只是把提示关掉——关掉不等于撤销，别把两件事混成一个按钮。 */
export function dismissUndo(): void {
  current = null;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  emit();
}

export function getUndo(): UndoItem | null { return current; }

export function subscribeUndo(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
