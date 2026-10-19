import { useCallback, useEffect, useRef, useState } from "react";
import { getListPageSize, LIST_PAGE_EVENT } from "../lib/ui-prefs";

export type Page<T> = { rows: T[]; total: number };

/**
 * 管理面列表的翻页：offset 追加、代次守卫、换查询条件回到第一页。
 *
 * 为什么收在这儿：调用记录/处理单/记忆/主动性打算四张表各自实现过一遍同一件事，
 * 只有前两张带「已显示 X / 共 Y」，主动性那张连 total 都没有——后端只发 LIMIT，
 * 于是它写死取 40 条、把小茉 91 条里的后一半永久藏起来，一句提示都没有。
 * 代次守卫也不是装饰：MemoryPanel 实测过「上一页在飞时切分类」会把旧分类的那一页
 * 追加进新列表、total 也被过期响应改写。
 *
 * **刷新期间绝不清空行**：从前 reset() 与换条件都先 setPage(null)，列表那一块整块消失、
 * 容器高度塌下去，浏览器随即把 scrollTop 夹到 0——实测删一条记忆 1400→0、切分类 1400→0，
 * 人正看着的位置就这么没了。现在旧行留着顶住高度，新页到了就地换掉。
 */
export function usePagedList<T>(
  fetchPage: (limit: number, offset: number) => Promise<Page<T>>,
  opts: { key: string; enabled?: boolean; pageSize?: number },
): {
  page: Page<T> | null;
  busy: boolean;
  refreshing: boolean;
  error: string;
  reset: () => void;
  more: () => void;
  drop: (id: number) => void;
  patch: (id: number, part: Partial<T>) => void;
  insertAt: (index: number, row: T) => void;
} {
  const { key, enabled = true } = opts;
  // 页大小走「界面」tab 那个全局档位；没显式传就用它，改档时整表回到第一页。
  const pageSize = opts.pageSize ?? getListPageSize();
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const sizeRef = useRef(pageSize);
  sizeRef.current = pageSize;

  const [page, setPage] = useState<Page<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const seqRef = useRef(0);
  const lenRef = useRef(0);
  /** 在飞的请求数（计数而非布尔）：被作废的那一拍也必须把「在飞」让出来，
   *  否则它结束时不再看待办，期间被催的那次 reset() 就永远等不到执行。 */
  const inflightRef = useRef(0);
  /** 待重拉第一页的标志：由 reset() / 换查询 / 改页档置上，下面的 effect 负责执行。 */
  const needRef = useRef(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => { lenRef.current = page?.rows.length ?? 0; }, [page]);

  const loadRef = useRef<(mode: "first" | "append") => Promise<void>>(() => Promise.resolve());
  const load = useCallback((mode: "first" | "append"): Promise<void> => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    inflightRef.current += 1;
    if (mode === "first") setRefreshing(true); else setBusy(true);
    return Promise.resolve(fetchRef.current(sizeRef.current, mode === "append" ? lenRef.current : 0))
      .then((d) => {
        if (seq !== seqRef.current) return;      // 过期响应：不改行，也不改 total
        setPage((prev) => (mode === "append" && prev
          ? { rows: [...prev.rows, ...d.rows], total: d.total }
          : { rows: d.rows, total: d.total }));
        setError("");
      })
      .catch((e: Error) => {
        if (seq !== seqRef.current) return;
        setError(e.message);
        // 首屏失败也要撑起一个空页：否则界面永远卡在「读取中…」，连重试入口都没有
        setPage((prev) => prev ?? { rows: [], total: 0 });
      })
      .finally(() => {
        inflightRef.current -= 1;
        if (seq === seqRef.current) {
          setBusy(false);
          setRefreshing(false);
        }
        // 这一拍收尾时有待办（期间被 reset() 或换了条件）：补一拍，别把它丢了
        if (needRef.current && inflightRef.current === 0) {
          needRef.current = false;
          void loadRef.current("first");
        }
      });
  }, []);
  loadRef.current = load;

  /** 催一次「重拉第一页」：作废在飞那拍；有空位就立刻走，否则留成待办等它收尾。 */
  const requestFirst = useCallback((): void => {
    seqRef.current += 1;          // 作废在飞的那一页，别让它在换条件后追加进来
    lenRef.current = 0;
    needRef.current = true;
    if (inflightRef.current === 0) {
      needRef.current = false;
      void load("first");
    }
  }, [load]);

  // 查询条件（含页大小）变了 = 换另一张表：重拉第一页（行先留着顶住高度）。
  const query = key + "|" + pageSize;
  const lastQueryRef = useRef("\u0000");
  useEffect(() => {
    if (lastQueryRef.current !== query) {
      lastQueryRef.current = query;
      requestFirst();
    }
    if (!enabled) return;
    if (needRef.current && inflightRef.current === 0) {
      needRef.current = false;
      void load("first");
    }
  }, [enabled, query, nonce, requestFirst, load]);

  // 「列表每页」在别的界面改的：跟着回第一页重拉。
  useEffect(() => {
    const on = (): void => { needRef.current = true; setNonce((n) => n + 1); };
    window.addEventListener(LIST_PAGE_EVENT, on);
    return () => window.removeEventListener(LIST_PAGE_EVENT, on);
  }, []);

  const idOf = (r: T): number | undefined => (r as { id?: number }).id;

  return {
    page,
    busy,
    refreshing,
    error,
    reset: requestFirst,
    more: useCallback((): void => { void load("append"); }, [load]),
    /** 服务端已确认删掉：本地摘这一行就够了。整表重拉既跳顶又换掉邻行。 */
    drop: useCallback((id: number): void => {
      setPage((prev) => (prev
        ? { rows: prev.rows.filter((r) => idOf(r) !== id), total: Math.max(0, prev.total - 1) }
        : prev));
    }, []),
    /** 就地改一行：改了内容不必为此重拉整表。 */
    patch: useCallback((id: number, part: Partial<T>): void => {
      setPage((prev) => (prev
        ? { ...prev, rows: prev.rows.map((r) => (idOf(r) === id ? { ...r, ...part } : r)) }
        : prev));
    }, []),
    /**
     * 把一行放回原来的位置（撤销删除要用它）。
     * 排序是各表自己的事（记忆按时间倒序、调用记录按 id 倒序），hook 猜不到，
     * 所以由摘掉它的那一方记住下标、原样放回来——总比重拉一整页准。
     */
    insertAt: useCallback((index: number, row: T): void => {
      setPage((prev) => {
        if (prev === null) return prev;
        const at = Math.max(0, Math.min(index, prev.rows.length));
        if (prev.rows.some((r) => idOf(r) === idOf(row))) return prev;   // 已经在表里就别塞第二份
        const rows = [...prev.rows];
        rows.splice(at, 0, row);
        return { rows, total: prev.total + 1 };
      });
    }, []),
  };
}
