import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice } from "../types";

/**
 * 聊天流内的提示条队列：最多同时留 5 条，id 自增。
 * 所有提示都会自动消失：信息类 2.6 秒，错误类留 8 秒给用户读清楚与点重试。
 * 错误不能永久挂在底部——需要长期保留的失败状态由消息气泡/失败横幅承担。
 */
const INFO_NOTICE_TTL_MS = 2600;
const ERROR_NOTICE_TTL_MS = 8000;
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
    // 触发后把自己从数组里摘掉，否则一个长会话里这项只增不减。
    // 错误提示也走同一套，只是停留更久；重试按钮在这段时间内仍可点。
    const ttl = opts?.info && !opts.retryTurnId ? INFO_NOTICE_TTL_MS : ERROR_NOTICE_TTL_MS;
    const t = setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== t);
      setNotices((prev) => prev.filter((x) => x.id !== n.id));
    }, ttl);
    timers.current.push(t);
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
