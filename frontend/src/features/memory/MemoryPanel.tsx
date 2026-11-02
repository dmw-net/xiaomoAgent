import { useCallback, useEffect, useRef, useState } from "react";
import { memoryApi } from "../../api";
import MemoryCard from "./MemoryCard";
import MemorySpaceSelect, { spaceKey } from "./MemorySpaceSelect";
import Modal from "../../components/Modal";
import ListPager from "../../components/ListPager";
import { offerUndo } from "../../lib/undo";
import { usePagedList } from "../../hooks/usePagedList";
import type { PanelAria } from "../../components/Tabs";
import { KIND_ORDER, kindLabel } from "./constants";
import type { MemoryEvent, MemorySpaceInventory, MemorySpaceSelection, MemoryStats } from "../../types";

/** 一条记忆当前归属哪个空间——编辑弹窗与筛选判断都用这一个口径。 */
function eventSpace(e: MemoryEvent): MemorySpaceSelection {
  if (e.scope_kind === "conversation" && e.scope_conversation_id) {
    return { kind: "conversation", conversationId: e.scope_conversation_id };
  }
  return { kind: "global" };
}

/**
 * 记忆面板（内嵌在联系人资料页）：该联系人的长期记忆清单——
 * 统计、分类过滤、空间过滤、分页加载、纠正与删除。召回测试不在这里，它在「状态」页。
 */
export default function MemoryPanel({ active = true, contactId, who = "联系人", panel, space = { kind: "all" }, onSpaceChange, spaceInventory = null, onSpacesChanged }: {
  active?: boolean;
  panel: PanelAria;
  contactId: string;
  who?: string;
  /** 当前记忆空间；不传就是全部（状态页那套独立试验台沿用旧行为）。 */
  space?: MemorySpaceSelection;
  onSpaceChange?: (space: MemorySpaceSelection) => void;
  spaceInventory?: MemorySpaceInventory | null;
  onSpacesChanged?: () => void;
}): JSX.Element {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [statsErr, setStatsErr] = useState("");
  const [activeKind, setActiveKind] = useState("");
  const [editing, setEditing] = useState<MemoryEvent | null>(null);
  const [draft, setDraft] = useState("");
  /** 编辑弹窗里的归属草稿；打开时按这条记忆当前的空间初始化，改了才提交。 */
  const [spaceDraft, setSpaceDraft] = useState<MemorySpaceSelection>({ kind: "all" });
  const [actErr, setActErr] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [saving, setSaving] = useState(false);

  const loadStats = useCallback((): void => {
    void memoryApi.fetchMemoryStats(contactId)
      .then((s) => { setStats(s); setStatsErr(""); })
      .catch((e: Error) => setStatsErr(e.message));
  }, [contactId]);

  const fetchEvents = useCallback((limit: number, offset: number) =>
    memoryApi.fetchMemoryEvents(activeKind, offset, limit, contactId, space)
      .then((d) => ({ rows: d.events, total: d.total })), [activeKind, contactId, space]);
  // 翻页与「上一页在飞时切分类」的代次守卫都在 hook 里：手写过一遍，漏守卫时
  // 旧分类那一页会被追加进新分类、total 也被过期响应改写。
  const list = usePagedList<MemoryEvent>(fetchEvents, { key: contactId + "|" + activeKind + "|" + spaceKey(space) });
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

  /** 打开纠正弹窗：归属草稿按这条记忆当前的空间初始化，用户不动它就只改内容。 */
  const openEdit = (e: MemoryEvent): void => {
    setEditing(e);
    setDraft(e.content);
    setSpaceDraft(eventSpace(e));
    setActErr("");
  };

  const saveEdit = useCallback((): void => {
    if (!editing || saving) return;
    const content = draft.trim();
    if (content === "" || content.length > 60) { setActErr("内容要在 1~60 字之间"); return; }
    // 「全部」不是一个可归属的空间：没动过就不发 space，避免把条目误挪出它原来的位置。
    const moved = spaceInventory !== null && spaceDraft.kind !== "all" && spaceKey(spaceDraft) !== spaceKey(eventSpace(editing));
    setSaving(true);
    void memoryApi.editMemoryEvent(editing.id, { content, ...(moved ? { space: spaceDraft } : {}) }, contactId)
      .then((d) => {
        setEditing(null);
        setActErr("");
        const next = d.event ?? null;
        // 转移后若已不在当前筛选的空间里，就地摘掉这一行；留着就是"它还在这儿"的假象。
        if (next !== null && space.kind !== "all" && spaceKey(space) !== spaceKey(eventSpace(next))) {
          list.drop(editing.id);
        } else {
          list.patch(editing.id, next === null
            ? { content }
            : { content: next.content, scope_kind: next.scope_kind, scope_conversation_id: next.scope_conversation_id, subject_id: next.subject_id, subject_name: next.subject_name });
        }
        onSpacesChanged?.();
        loadStats();
      })
      .catch((e: Error) => setActErr(e.message))
      .finally(() => setSaving(false));
  }, [editing, draft, saving, space, spaceDraft, spaceInventory, contactId, list, loadStats, onSpacesChanged]);

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
        onSpacesChanged?.();
        setRowErr("");
        offerUndo("已删掉这条记忆", () => {
          void memoryApi.restoreMemoryEvent(e.id, contactId)
            .then(() => { list.insertAt(index < 0 ? 0 : index, e); loadStats(); onSpacesChanged?.(); })
            .catch((err: Error) => setRowErr("撤销失败：" + err.message));
        });
      })
      .catch((err: Error) => setRowErr("删除失败：" + err.message));
  };

  const doPromote = (e: MemoryEvent): void => {
    void memoryApi.promoteMemoryEvent(e.id, contactId)
      .then(() => {
        // 提升 = 这条搬出当前空间。筛的是某个群/某个人时它还留在列表里就是假象，得摘掉；
        // 只有筛「全局」时它本来就该在，就地改字段即可。
        if (space.kind === "all" || space.kind === "global") {
          list.patch(e.id, { scope_kind: "global", scope_conversation_id: null, subject_id: null, subject_name: null });
        } else {
          list.drop(e.id);
        }
        onSpacesChanged?.();
        setRowErr("");
      })
      .catch((err: Error) => setRowErr("提升失败：" + err.message));
  };

  const byKind = stats?.byKind ?? {};
  const emptyPct = stats && stats.emptyRate !== null ? Math.round(stats.emptyRate * 100) : null;
  // 会话 id → 名字：卡片徽标要说得出「测试群」，而不是「当前会话」。
  const spaceNames: Record<string, string> = spaceInventory === null ? {} : Object.fromEntries([
    [spaceInventory.private.conversationId, spaceInventory.private.title || "私聊"],
    ...spaceInventory.groups.map((g) => [g.conversationId, g.title]),
  ]);

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
            {emptyPct !== null && stats.extractSamples > 0 && (
              <div className="stat"><div className="n">{emptyPct}%</div><div className="t">无需记录</div></div>
            )}
            {KIND_ORDER.filter((k) => byKind[k]).length > 0 && (
              <div className="hint" style={{ gridColumn: "1 / -1" }}>
                构成：{KIND_ORDER.filter((k) => byKind[k]).map((k) => kindLabel(k) + " " + byKind[k]).join(" · ")}
              </div>
            )}
            {emptyPct !== null && stats.extractSamples > 0 && (
              <div className="hint" style={{ gridColumn: "1 / -1" }}>
                最近 {stats.extractSamples} 次抽取里，{emptyPct}% 没有需要长期记住的内容。空结果是正常状态，只有调用或返回格式出错才算失败。
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
        {/* 空间筛选与分类筛选是两条正交的轴，可以同时在 */}
        {onSpaceChange && (
          <MemorySpaceSelect inventory={spaceInventory} value={space} onChange={onSpaceChange} />
        )}
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
            {activeKind
              ? "这个分类下还没有记录。"
              : space.kind === "all" ? "还没有记忆，聊完天会自己记。" : "这个空间里还没有单独记下的事——全局的记忆在所有对话里都能被想起，切回「全部空间」看。"}
          </div>
        ) : (
          events.map((e) => (
            <MemoryCard key={e.id} event={e} who={who} spaceNames={spaceNames}
              onPromote={e.scope_kind && e.scope_kind !== "global" ? () => doPromote(e) : undefined}
              onEdit={() => openEdit(e)}
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
            {spaceInventory !== null && (
              <div className="field">
                <label>归属空间</label>
                <MemorySpaceSelect inventory={spaceInventory} value={spaceDraft} onChange={setSpaceDraft} mode="target" />
                <div className="hint">转移只改「哪些对话能想起它」——内容、来源、记下时间都不动。</div>
              </div>
            )}
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
