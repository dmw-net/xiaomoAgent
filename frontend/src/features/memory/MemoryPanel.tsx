import { useCallback, useEffect, useRef, useState } from "react";
import { memoryApi } from "../../api";
import MemoryCard from "./MemoryCard";
import Modal from "../../components/Modal";
import ListPager from "../../components/ListPager";
import { offerUndo } from "../../lib/undo";
import { usePagedList } from "../../hooks/usePagedList";
import type { PanelAria } from "../../components/Tabs";
import { KIND_ORDER, kindLabel } from "./constants";
import type { MemoryEvent, MemoryStats } from "../../types";

/**
 * 记忆面板（内嵌在联系人资料页）：该联系人的长期记忆清单——
 * 统计、分类过滤、分页加载、纠正与删除。召回测试不在这里，它在「状态」页。
 */
export default function MemoryPanel({ active = true, contactId, who = "联系人", panel }: {
  active?: boolean;
  panel: PanelAria;
  contactId: string;
  who?: string;
}): JSX.Element {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [statsErr, setStatsErr] = useState("");
  const [activeKind, setActiveKind] = useState("");
  const [editing, setEditing] = useState<MemoryEvent | null>(null);
  const [draft, setDraft] = useState("");
  const [actErr, setActErr] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [saving, setSaving] = useState(false);

  const loadStats = useCallback((): void => {
    void memoryApi.fetchMemoryStats(contactId)
      .then((s) => { setStats(s); setStatsErr(""); })
      .catch((e: Error) => setStatsErr(e.message));
  }, [contactId]);

  const fetchEvents = useCallback((limit: number, offset: number) =>
    memoryApi.fetchMemoryEvents(activeKind, offset, limit, contactId)
      .then((d) => ({ rows: d.events, total: d.total })), [activeKind, contactId]);
  // 翻页与「上一页在飞时切分类」的代次守卫都在 hook 里：手写过一遍，漏守卫时
  // 旧分类那一页会被追加进新分类、total 也被过期响应改写。
  const list = usePagedList<MemoryEvent>(fetchEvents, { key: contactId + "|" + activeKind });
  const events = list.page?.rows ?? null;
  const memTotal = list.page?.total ?? 0;
  const reload = list.reset;

  useEffect(() => { loadStats(); }, [loadStats]);
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wake = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!wake) return;
    loadStats();
    list.reset();
  }, [active, loadStats, list.reset]);

  const saveEdit = useCallback((): void => {
    if (!editing || saving) return;
    const content = draft.trim();
    if (content === "" || content.length > 60) { setActErr("内容要在 1~60 字之间"); return; }
    setSaving(true);
    void memoryApi.editMemoryEvent(editing.id, { content }, contactId)
      .then(() => { setEditing(null); setActErr(""); list.patch(editing.id, { content }); loadStats(); })
      .catch((e: Error) => setActErr(e.message))
      .finally(() => setSaving(false));
  }, [editing, draft, saving, contactId, list, loadStats]);

  /**
   * 删一条记忆：不弹"你确定吗"——删是软删（墓碑），能整条撤回，
   * 所以按微信/钉钉的做法：先做掉，再给 5 秒反悔。少一次打断，也不会出现
   * "点完确认界面跑到哪去了"。真不可逆的（删一条消息）仍然弹确认。
   */
  const doDelete = (e: MemoryEvent): void => {
    const index = events?.findIndex((x) => x.id === e.id) ?? -1;
    void memoryApi.deleteMemoryEvent(e.id, contactId)
      // 就地摘掉这一行：整表重拉会把 scrollTop 打回 0，还会把邻行换成另一批
      .then(() => {
        list.drop(e.id);
        loadStats();
        setRowErr("");
        offerUndo("已删掉这条记忆", () => {
          void memoryApi.restoreMemoryEvent(e.id, contactId)
            .then(() => { list.insertAt(index < 0 ? 0 : index, e); loadStats(); })
            .catch((err: Error) => setRowErr("撤销失败：" + err.message));
        });
      })
      .catch((err: Error) => setRowErr("删除失败：" + err.message));
  };

  const byKind = stats?.byKind ?? {};

  return (
    <div className="pnl" {...panel}>
      <div className="stats" id="stats">
        {stats === null ? (
          statsErr === ""
            ? <div className="stat"><div className="n">…</div><div className="t">读取中</div></div>
            : <div className="stat"><div className="n">—</div><div className="t">统计不可用 · 重试中会再拉</div></div>
        ) : (
          <>
            <div className="stat"><div className="n">{stats.total}</div><div className="t">关系事件总数</div></div>
            <div className="stat"><div className="n">{stats.usedRecently}</div><div className="t">近 7 天用到</div></div>
            {stats.extractFailures > 0 && (
              <div className="stat alert">
                <div className="n">{stats.extractFailures}</div><div className="t">记忆整理失败</div>
              </div>
            )}
            <div className="stat"><div className="n">{stats.thisWeek}</div><div className="t">本周新增</div></div>
            {KIND_ORDER.filter((k) => byKind[k]).length > 0 && (
              <div className="hint" style={{ gridColumn: "1 / -1" }}>
                构成：{KIND_ORDER.filter((k) => byKind[k]).map((k) => kindLabel(k) + " " + byKind[k]).join(" · ")}
              </div>
            )}
          </>
        )}
      </div>

      <div className="toolbar">
        <div className="filters">
          <button type="button" data-kind="" aria-pressed={activeKind === "" ? "true" : "false"}
            onClick={() => setActiveKind("")}>全部</button>
          {KIND_ORDER.map((k) => (
            <button key={k} type="button" data-kind={k}
              aria-pressed={activeKind === k ? "true" : "false"}
              onClick={() => setActiveKind(k)}>{kindLabel(k)}</button>
          ))}
        </div>
        {/* 报的是服务端总数，不是已加载行数——分页之后两者不等，写行数会越翻越"少" */}
        <div className="count" id="count">{list.page === null ? "" : "共 " + memTotal + " 条"}</div>
      </div>

      {rowErr !== "" && (
        <div className="hint" role="alert">{rowErr}</div>
      )}
      <div className="list" id="list">
        {events === null ? (
          <div className="empty-state">读取中…</div>
        ) : list.error !== "" ? (
          <div className="empty-state">
            读取记忆失败：{list.error}{" "}
            <button type="button" className="chip" onClick={reload}>重试</button>
          </div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            {activeKind ? "这个分类下还没有记录。" : "还没有记忆，聊完天会自己记。"}
          </div>
        ) : (
          events.map((e) => (
            <MemoryCard key={e.id} event={e} who={who}
              onEdit={() => { setEditing(e); setDraft(e.content); setActErr(""); }}
              onDelete={() => doDelete(e)} />
          ))
        )}
      </div>
      <ListPager page={list.page} busy={list.busy} refreshing={list.refreshing} onMore={list.more} />

      {editing && (
        <Modal onClose={() => setEditing(null)} label="纠正这条记忆"
          head={<div className="modal-title-row"><div className="modal-title">纠正这条记忆</div></div>}>
            <div className="field">
              <textarea
                aria-label="改成对的写法"
                value={draft}
                maxLength={60}
                rows={3}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`${who}记错了什么？改成对的（1~60 字）`}
              />
            </div>
            {actErr && <div className="hint" role="alert" style={{ color: "var(--dot-red)" }}>{actErr}</div>}
            <div className="form-row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button type="button" onClick={() => setEditing(null)}>取消</button>
              <button type="button" className="primary" disabled={saving} onClick={saveEdit}>{saving ? "保存中…" : "保存"}</button>
            </div>
        </Modal>
      )}
    </div>
  );
}
