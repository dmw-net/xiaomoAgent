import type { Page } from "../hooks/usePagedList";

/**
 * 列表页脚：「已显示 X / 共 Y 条 · 还剩 Z」+「加载更多」，外加刷新时的"还在动"信号。
 * 四张管理面表共用同一句口径——从前只有前两张报总数，主动性那张连 total 都没下发，
 * 于是它取满 40 条就静默到底，剩下一半永久看不见。
 *
 * refreshing 必须说出来：现在的刷新**不清空旧行**（清空会让容器塌掉、把人甩回顶部），
 * 界面看着和"卡住了"没区别。一行小字换掉整块闪烁。
 */
export default function ListPager({ page, busy, refreshing = false, onMore }: {
  page: Page<unknown> | null;
  busy: boolean;
  refreshing?: boolean;
  onMore: () => void;
}): JSX.Element | null {
  if (page === null) return null;
  if (page.rows.length === 0) {
    return refreshing ? <div className="tbl-pager"><span className="hint">刷新中…</span></div> : null;
  }
  const left = page.total - page.rows.length;
  return (
    <div className="tbl-pager">
      <span className="hint">
        {`已显示 ${page.rows.length} / 共 ${page.total} 条`}{left > 0 ? ` · 还剩 ${left} 条` : " · 已到底"}
        {refreshing ? " · 刷新中…" : ""}
      </span>
      {left > 0 && (
        <button type="button" className="btn sm ghost" disabled={busy || refreshing} onClick={onMore}>
          {busy ? "读取中…" : "加载更多"}
        </button>
      )}
    </div>
  );
}
