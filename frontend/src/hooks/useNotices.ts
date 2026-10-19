import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice } from "../types";

/**
 * 聊天流内的提示条队列：最多同时留 5 条，id 自增。
 * 纯信息类（无重试按钮）2.6 秒自动消失——「已复制」这类提示不该一直挂在消息流底部。
 */
export function useNotices(): {
  notices: Notice[];
  addNotice: (text: string, opts?: { info?: boolean; retryTurnId?: string }) => void;
  /** 按条件移除提示（如：某轮跑完了，把它留下的「可重试」提示收掉）。 */
  dropNotices: (pred: (n: Notice) => boolean) => void;
} {
  const [notices, setNotices] = useState<Notice[]>([]);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const addNotice = useCallback((text: string, opts?: { info?: boolean; retryTurnId?: string }): void => {
    seq.current += 1;
    const n: Notice = { id: seq.current, text, info: opts?.info, retryTurnId: opts?.retryTurnId };
    setNotices((prev) => [...prev.slice(-4), n]);
    if (opts?.info && !opts.retryTurnId) {
      // 触发后把自己从数组里摘掉，否则一个长会话里这项只增不减
      const t = setTimeout(() => {
        timers.current = timers.current.filter((x) => x !== t);
        setNotices((prev) => prev.filter((x) => x.id !== n.id));
      }, 2600);
      timers.current.push(t);
    }
  }, []);

  const dropNotices = useCallback((pred: (n: Notice) => boolean): void => {
    setNotices((prev) => {
      const kept = prev.filter((x) => !pred(x));
      return kept.length === prev.length ? prev : kept;
    });
  }, []);

  useEffect(() => () => {
    for (const t of timers.current) clearTimeout(t);
  }, []);

  return { notices, addNotice, dropNotices };
}
