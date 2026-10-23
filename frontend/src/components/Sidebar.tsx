import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, Pencil, FileDown, Archive, ArchiveRestore, FileUp, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { contactsApi, searchApi } from "../api";
import type { MessageHit, MemoryHit } from "../types/search";
import { getCachedContacts, isContactsLoaded, refreshContacts, subscribeContacts } from "../lib/contactsStore";
import { exportPersonaMd, parseMd, parseNameFromMd } from "../lib/persona-doc";
import { shortTimeLabel } from "../lib/datetime";
import { offerUndo } from "../lib/undo";
import { avatarToneStyle } from "../lib/avatar-tone";
import { useDismiss } from "../hooks/useDismiss";
import Splitter from "./Splitter";
import Modal from "./Modal";
import type { ContactItem } from "../types";
import type { PersonaDraft } from "../lib/persona-doc";

type ItemMenu = { contact: ContactItem; x: number; y: number };
/** 只有「彻底删除」弹确认窗——那一步真清库。归档是可逆的，按 undo.ts 定的口径直接做掉给 5 秒反悔，
 *  和聊天页「⋯→归档」同一套；从前两个入口一个问一句不问，还能反悔的只有其中一个。 */
type ConfirmState = { contact: ContactItem };

export default function Sidebar({ current, onPick, onLeaveCurrent, onContactsChanged, onOpenProfile, onOpenHit }: {
  current: string;
  onPick: (id: string) => void;
  /** 归档/删掉的正好是当前打开的那位：会话区退回空态，别顺手打开小茉的对话。 */
  onLeaveCurrent: () => void;
  onContactsChanged: () => void;
  onOpenProfile: (mode: "create" | "edit", id: string, draft?: PersonaDraft) => void;
  /** 全局搜索的点一条命中：消息命中要跳到那句话，记忆命中要跳到那位的记忆分区。
   *  从前两者都只做"切到这个人"，于是搜索号称能查全历史，点进去却还得自己翻。 */
  onOpenHit: (kind: "message" | "memory", contactId: string, id: number) => void;
}): JSX.Element {
  const [contacts, setContacts] = useState<ContactItem[]>(getCachedContacts());
  const [archived, setArchived] = useState<ContactItem[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** 全局搜索（回车触发）：消息 + 记忆，跨联系人。 */
  const [hits, setHits] = useState<{ q: string; messages: MessageHit[]; memories: MemoryHit[] } | null>(null);
  const [menu, setMenu] = useState<ItemMenu | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  /** 右上角「＋」下拉：添加 / 导入——微信把它放页头，不放列表末尾。 */
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const mdRef = useRef<HTMLInputElement>(null);
  const addBtnRef = useRef<HTMLDivElement>(null);
  /** 全局搜索的代次：只有最后一次请求的结果允许落地。 */
  const searchSeq = useRef(0);
  /** 列表搜索自己一个代次计数器——和全局搜索共用会互相把对方的结果判成过期。 */
  const listSeq = useRef(0);
  const [searchHits, setSearchHits] = useState<ContactItem[] | null>(null);

  // 活跃列表走全站唯一轮询（contactsStore）；归档列表只属于这里，自己拉。
  const [loaded, setLoaded] = useState(() => isContactsLoaded());
  const onContacts = useCallback((c: ContactItem[]): void => {
    setContacts(c);
    setLoaded(isContactsLoaded());
  }, []);
  useEffect(() => subscribeContacts(onContacts), [onContacts]);
  const loadArchived = useCallback((): void => {
    void contactsApi.fetchArchivedContacts()
      .then((d) => setArchived(d.contacts))
      .catch(() => setArchived([]));
  }, []);

  const load = useCallback((): void => {
    refreshContacts();
    loadArchived();
    onContactsChanged();
  }, [loadArchived, onContactsChanged]);

  useEffect(() => { loadArchived(); }, [loadArchived]);

  // 归档也可能从聊天页顶栏菜单发生（不只侧栏右键）。活跃列表经 store 订阅自动刷新，
  // 「已归档」分组却没人通知——刚归档的人要等切视图重挂才出现。
  useEffect(() => {
    const onChanged = (): void => loadArchived();
    window.addEventListener("xiaomo:contacts-changed", onChanged);
    return () => window.removeEventListener("xiaomo:contacts-changed", onChanged);
  }, [loadArchived]);

  useDismiss(menu !== null, () => setMenu(null));
  useDismiss(menuOpen && menu === null, () => setMenuOpen(false));

  // 搜索改到后端筛：人设正文不再随列表下发（它曾占列表响应体的 48%，而这份列表
  // 前台每 10 秒整份重拉一次且 no-store），本地那份 identity 也随之没有了。
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      // 清空输入也要作废在飞的旧查询：否则它回来时 seq 仍然匹配，
      // 会把上一个关键词的结果写回 searchHits，列表显示与输入框对不上。
      listSeq.current += 1;
      setSearchHits(null);
      return;
    }
    const seq = ++listSeq.current;
    const timer = setTimeout(() => {
      void contactsApi.fetchContacts(q)
        .then((d) => { if (listSeq.current === seq) setSearchHits(d.contacts); })
        .catch(() => { if (listSeq.current === seq) setSearchHits([]); });
    }, 250);
    return () => { clearTimeout(timer); };
  }, [query]);

  const shown = useMemo((): ContactItem[] => {
    if (searchHits !== null) return searchHits;
    const q = query.trim().toLowerCase();
    // 服务端结果没回来的那两三百毫秒，先用列表里已有的字段筛一遍：
    // 否则输入后列表纹丝不动，看起来像搜索没生效。
    if (q === "") return contacts;
    return contacts.filter((c) =>
      c.name.toLowerCase().includes(q) || (c.preview || "").toLowerCase().includes(q));
  }, [contacts, query, searchHits]);

  const nameOf = (id: string): string => contacts.find((c) => c.id === id)?.name ?? "联系人";
  /** 截断要说清楚：硬切 40 字会让「我下周去北」看起来就是那句话的全部内容。 */
  const clip = (s: string): string => (s.length > 40 ? s.slice(0, 40) + "…" : s);

  // ── 导出 / 归档 / 恢复 ──
  const exportMd = (contact: ContactItem): void => {
    void contactsApi
      .fetchContact(contact.id)
      .then((d) => exportPersonaMd(d.contact.name, {
        name: d.contact.name,
        background: d.contact.card.background ?? "",
        identity: d.contact.card.identity ?? "",
        relationship: d.contact.card.relationship ?? "",
      }))
      .catch((e: Error) => setError("导出失败：" + e.message));
  };

  const archive = (contact: ContactItem): void => {
    void contactsApi
      .archiveContact(contact.id)
      .then(() => {
        setMenu(null);
        load();
        if (contact.id === current) onLeaveCurrent();
        offerUndo(`已归档「${contact.name}」`, () => {
          void contactsApi.unarchiveContact(contact.id)
            .then(() => load())
            .catch((e: Error) => setError("撤销归档失败：" + e.message));
        });
      })
      .catch((e: Error) => setError("归档失败：" + e.message));
  };

  const unarchive = (contact: ContactItem): void => {
    void contactsApi
      .unarchiveContact(contact.id)
      .then(() => load())
      .catch((e: Error) => setError("恢复失败：" + e.message));
  };

  /** 彻底删除：后端只接受已归档的联系人；对话/记忆/任务/图片全清，不可恢复。 */
  const hardDelete = (contact: ContactItem): void => {
    void contactsApi
      .deleteContact(contact.id)
      .then(() => {
        load();
        onContactsChanged();
        if (contact.id === current) onLeaveCurrent();
      })
      .catch((e: Error) => setError("删除失败：" + e.message));
  };

  // ── 导入 .md：解析三段 → 预填新建资料页 ──
  const onMdFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    file.text()
      .then((text) => {
        const sections = parseMd(text);
        const name = parseNameFromMd(text);
        if (!sections.background && !sections.identity && !sections.relationship && !name) {
          setError("没解析出内容：需要「## 背景 / ## 人设 / ## 与用户关系」三段标题");
          return;
        }
        onOpenProfile("create", "", { name, ...sections });
      })
      .catch((err: Error) => setError("读取失败：" + err.message));
  };

  const renderRow = (c: ContactItem, isArchived: boolean): JSX.Element => (
    <div
      key={c.id}
      className={"s-item" + (c.id === current && !isArchived ? " active" : "") + (isArchived ? " s-archived" : "")}
      role="button"
      tabIndex={0}
      aria-current={c.id === current && !isArchived ? "true" : undefined}
      onClick={() => { if (!isArchived) onPick(c.id); }}
      onKeyDown={(e) => { if (!isArchived && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(c.id); } }}
      onContextMenu={isArchived ? undefined : (e) => { e.preventDefault(); setMenu({ contact: c, x: e.clientX, y: e.clientY }); }}
    >
      <div
        className={"s-ava" + (c.avatar ? " has-img" : "")}
        style={avatarToneStyle(c.name)}
        title={isArchived ? "已归档" : c.name}
      >
        {c.avatar ? <img src={c.avatar} alt={c.name + "的头像"} /> : (c.name || "?").slice(0, 1)}
      </div>
      <div className="s-meta">
        <div className="s-r1">
          <span className="s-name">{c.name}</span>
          {!isArchived && <span className="s-time">{shortTimeLabel(c.lastAt)}</span>}
        </div>
        <div className="s-r2">
          {isArchived
            ? "已归档 · 对话与记忆保留"
            : c.preview || "还没说过话"}
        </div>
      </div>
      {c.unread > 0 && (
        <span className="s-badge" title={`${c.unread} 条未读`} aria-label={`${c.unread} 条未读`}>
          {c.unread > 99 ? "99+" : c.unread}
        </span>
      )}
      {isArchived && (
        <button type="button" className="s-restore" title="恢复到列表"
          onClick={(e) => { e.stopPropagation(); unarchive(c); }}>
          <ArchiveRestore size={14} strokeWidth={1.8} />恢复
        </button>
      )}
      {isArchived && (
        <button type="button" className="s-del" title="彻底删除（不可恢复）"
          onClick={(e) => { e.stopPropagation(); setConfirm({ contact: c }); }}>
          <Trash2 size={14} strokeWidth={1.8} />删除
        </button>
      )}
    </div>
  );

  return (
    <aside id="side">
      {/* 页头 = 联系人列表页标题：标题居左、右侧「＋」（添加联系人 / 导入 .md）。
          整屏列表页亮标题；抽屉/宽屏只留右上角的「＋」。 */}
      <div className="s-listhead" ref={addBtnRef}>
        <span className="lt">对话</span>
        <button type="button" data-keep-menu className="s-add-btn" title="添加联系人 / 导入 .md" aria-label="添加联系人或导入人格文档" aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}>
          <Plus size={19} strokeWidth={2} />
        </button>
      </div>
      <div className="s-search">
        <Search size={15} strokeWidth={1.8} />
        <input
          id="sideSearch"
          aria-label="搜索联系人；回车搜全部聊天记录与记忆"
          placeholder="搜索联系人，回车搜全历史"
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (!e.target.value.trim()) setHits(null); }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const q = query.trim();
            if (q === "") { setHits(null); return; }
            // 连按两次回车时旧响应可能后到，按代次丢弃；失败要说一声——
            // 静默清空会让人以为「没搜到」，其实是没搜成。
            const seq = ++searchSeq.current;
            setError("");
            void searchApi.globalSearch(q)
              .then((d) => { if (seq === searchSeq.current) setHits(d); })
              .catch((err: Error) => { if (seq === searchSeq.current) setError("搜索失败：" + err.message); });
          }}
        />
      </div>
      <div className="s-list" id="s-list">
        {shown.length === 0 && !hits && (
          <div className="s-empty">
            {query ? "没有匹配的联系人" : loaded ? "还没有联系人 · 点右上角「＋」新建，或从 .md 导入" : "读取中…"}
          </div>
        )}
        {shown.map((c) => renderRow(c, false))}
        {hits && (
          <div className="s-gsearch">
            <div className="s-sec">全历史「{hits.q}」：消息 {hits.messages.length} 条 · 记忆 {hits.memories.length} 条
              <button type="button" className="s-clear" onClick={() => setHits(null)}>收起</button>
            </div>
            {hits.messages.map((h) => (
              <div key={"m" + h.id} className="s-item s-hit" role="button" tabIndex={0}
                title="跳到这句话"
                onClick={() => { onOpenHit("message", h.contact_id, h.id); setHits(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenHit("message", h.contact_id, h.id); setHits(null); } }}>
                <div className="s-meta"><div className="s-r1">{nameOf(h.contact_id)}<span className="s-time">{shortTimeLabel(h.created_at)}</span></div>
                  <div className="s-r2">{(h.role === "user" ? "我：" : "对方：") + clip(h.text)}</div></div>
              </div>
            ))}
            {hits.memories.map((h) => (
              <div key={"e" + h.id} className="s-item s-hit" role="button" tabIndex={0}
                title="打开这位的记忆分区"
                onClick={() => { onOpenHit("memory", h.contact_id, h.id); setHits(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenHit("memory", h.contact_id, h.id); setHits(null); } }}>
                <div className="s-meta"><div className="s-r1">{nameOf(h.contact_id)}<span className="s-time">记忆</span></div>
                  <div className="s-r2">{clip(h.content)}</div></div>
              </div>
            ))}
            {hits.messages.length + hits.memories.length === 0 && <div className="s-empty">什么都没搜到</div>}
          </div>
        )}

        {/* 添加 / 导入已收进页头右上角「＋」，联系人再多也不用滑到列表末尾 */}
        {error && <div className="s-hint">{error}</div>}

        {archived.length > 0 && (
          <>
            <button type="button" className="s-archived-toggle" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)}>
              {archivedOpen ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />}
              已归档（{archived.length}）
            </button>
            {archivedOpen && archived.map((c) => renderRow(c, true))}
          </>
        )}
        {/* 只写真正接了的入口：这一行只有 onContextMenu，没有长按（useLongPress 只用在消息气泡上）。
            手机上要从会话页右上角「⋯」进——那句话必须在这里说清，否则触屏用户找不到入口。 */}
        <div className="s-hint">
          各联系人记忆相互隔离。
          <span className="kbd-only">右键联系人可编辑资料、导出、归档。</span>
          <span className="touch-only">打开联系人会话后，从右上角「⋯」编辑资料、导出或归档。</span>
        </div>
      </div>
      <input ref={mdRef} type="file" accept=".md,text/markdown" hidden onChange={onMdFile} />
      <Splitter left="calc(64px + var(--side-w, 248px) - 3px)" />

      {/* 右键菜单：编辑资料 / 导出人格文档 / 归档 */}
      {menu && (
        <div className="msgmenu" style={{ left: menu.x, top: menu.y }} data-keep-menu
          onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => { onOpenProfile("edit", menu.contact.id); setMenu(null); }}>
            <span className="lb"><Pencil size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />编辑资料</span>
            <span className="nt">人格三段 + 头像</span>
          </button>
          <button type="button" onClick={() => { exportMd(menu.contact); setMenu(null); }}>
            <span className="lb"><FileDown size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />导出人格文档</span>
            <span className="nt">导出一个文件</span>
          </button>
          {/* 内置小茉也可以归档（归档→删除那套冷却期对她一样生效）；
              助手根本不在会话列表里（后端已过滤），这里不用再点名排除谁。 */}
          <button type="button" className="danger" onClick={() => { archive(menu.contact); }}>
            <span className="lb"><Archive size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />归档</span>
            <span className="nt">数据保留，做完可立刻撤销</span>
          </button>
        </div>
      )}

      {/* 右上角「＋」下拉：微信把它放页头，联系人再多也不用滑到列表末尾 */}
      {menuOpen && (
        <div className="msgmenu s-add-pop" data-keep-menu>
          <button type="button" onClick={() => { setMenuOpen(false); onOpenProfile("create", ""); }}>
            <span className="lb"><Plus size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />添加联系人</span>
            <span className="nt">新建联系人，填人格与模型</span>
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); mdRef.current?.click(); }} title="导入导出的 .md 人格文档">
            <span className="lb"><FileUp size={13} strokeWidth={1.8} style={{ verticalAlign: "-2px", marginRight: 6 }} />导入 .md</span>
            <span className="nt">从 .md 文件导入</span>
          </button>
        </div>
      )}

      {/* 彻底删除的确认窗：与删消息同一套微信式居中弹窗。归档不弹（可逆，见上）。 */}
      {confirm && (
        <Modal label="删除确认" onClose={() => setConfirm(null)}>
          <div className="del-title">
            {`彻底删除「${confirm.contact.name}」？`}
          </div>
          <div className="del-note">
            对话、记忆、计划和图片全部清除，不可恢复。想留一份人格就先导出。
          </div>
          <div className="del-row">
            <button type="button" onClick={() => setConfirm(null)}>取消</button>
            <button type="button" className="danger" onClick={() => {
              const t = confirm;
              setConfirm(null);
              hardDelete(t.contact);
            }}>彻底删除</button>
          </div>
        </Modal>
      )}

    </aside>
  );
}
