// 内置设置助手的界面：召唤式居中弹窗。
// 它是一次召唤的工具而不是一个去处，所以不占顶层导航；工作区降级为弹窗头部的切换芯片。
// 每个工作区是一条独立会话（派生联系人 assistant:<id>），上下文互不串台。

import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Settings2, X } from "lucide-react";
import ChatView from "../chat/ChatView";
import ThreadChip from "./ThreadChip";
import { useDismiss } from "../../hooks/useDismiss";
import { useNarrow } from "../../hooks/useNarrow";
import { contactsApi, threadContactId, assistantApi, type AssistantThread } from "../../api";
import Modal from "../../components/Modal";

const DEFAULT_ASSISTANT_NAME = "设置助手";
const LS_THREAD = "xiaomo.assistantThread";

/** 助手设置复用联系人资料页（那套表单的唯一真源），但要**留在弹窗里**：
 *  助手只有这一个去处，把它甩成身后那张整页资料，再让人自己摸回来，等于迷路一次。
 *  lazy 与 App 那份同源，产物还是同一个 chunk。 */
const ProfileView = lazy(() => import("../profile/ProfileView"));

type ModalState =
  | { kind: "create"; title: string; err: string }
  | { kind: "rename"; id: string; title: string; err: string }
  | { kind: "delete"; thread: AssistantThread }
  | { kind: "clear"; thread: AssistantThread; busy: boolean; err: string };

/** 模块级缓存：助手弹窗每次打开都要等工作区列表回来，先用上次数据秒渲染，
    避免「空列表 → 数据到达 → 整体下移」的闪跳；请求回来后台刷新。 */
let cachedThreads: AssistantThread[] | null = null;
let cachedAvatar = "";
let cachedName = "";

export default function AssistantDialog({ open, onClose, ownerName, ownerAvatar }: {
  /** 关闭只是隐藏：ChatView 不卸载，流式回复与输入框草稿原样留着。 */
  open: boolean;
  onClose: () => void;
  ownerName: string;
  ownerAvatar: string;
}): JSX.Element {
  const narrow = useNarrow();
  const [threads, setThreads] = useState<AssistantThread[]>(() => cachedThreads ?? []);
  const [sel, setSel] = useState<string>(() => localStorage.getItem(LS_THREAD) ?? "");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [avatar, setAvatar] = useState(cachedAvatar);
  const [asstName, setAsstName] = useState(cachedName || DEFAULT_ASSISTANT_NAME);
  const [listErr, setListErr] = useState("");
  /** 弹窗里的第二屏：助手设置（头像 / 名字 / 模型与上下文）。false = 聊天那一屏。 */
  const [showSettings, setShowSettings] = useState(false);
  /** 会话状态由 ChatView 回吐，名字与它一起进弹窗头部（弹窗里不再显示聊天自带的居中标题栏）。 */
  const [status, setStatus] = useState({ text: "", tone: "" });
  const reportStatus = useCallback((text: string, tone: string): void => { setStatus({ text, tone }); }, []);
  /** 桌面端可拖动：drag 是相对屏幕中心的偏移，null 表示回到居中。窄屏整屏不需要。 */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const gesture = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  useEffect(() => { cachedThreads = threads; }, [threads]);
  useEffect(() => { if (avatar !== "") cachedAvatar = avatar; }, [avatar]);
  useEffect(() => { cachedName = asstName; }, [asstName]);

  const reload = useCallback((): void => {
    assistantApi.listThreads()
      .then((d) => setThreads(d.threads))
      .catch((error: Error) => setListErr(error.message));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // 每次打开刷一次：工作区标题可能被首条消息自动改过名。
  useEffect(() => { if (open) reload(); }, [open, reload]);
  // 关闭只是隐藏整层；portal 到 body 的工作区管理弹窗（新建/改名/删除）不在其中，
  // 不显式收就会留在屏幕上。弹窗一收就把内层确认框一起归零。
  useEffect(() => { if (!open) setModal(null); }, [open]);

  // 助手的头像与名字来自保留联系人（它已不在会话列表里，单独拉一次）。
  // 在弹窗里改完名字/换完头像也要重新拉一次——否则保存成功了，头部还挂着旧的那份。
  const loadIdentity = useCallback((): void => {
    void contactsApi.fetchContact("assistant").then((d) => {
      setAvatar(d.contact.avatar || "");
      setAsstName(d.contact.name || DEFAULT_ASSISTANT_NAME);
    }).catch(() => {});
  }, []);
  useEffect(() => { loadIdentity(); }, [loadIdentity]);

  // 选中的工作区被（其它入口）删掉了：回落「通用」
  useEffect(() => {
    if (threads.length > 0 && sel !== "" && !threads.some((t) => t.id === sel)) {
      setSel("");
      localStorage.setItem(LS_THREAD, "");
    }
  }, [threads, sel]);

  // 点弹窗外（含遮罩）或按 Esc 关闭——判定全在 useDismiss 里，按下的那一发比监听器早，
  // 所以不会出现"点开即关"，也就不需要任何时间宽限。
  // 工作区管理弹窗开着时让位：它的遮罩盖住整层，点遮罩只该关掉那个确认框，
  // 不该把身后的助手弹窗一起收掉（确认框 portal 到 body，其遮罩不在 dialogRef 子树里）。
  useDismiss(open && modal === null, onClose, dialogRef);

  // 焦点管理：打开时把焦点收进弹窗（记住召唤前的焦点元素），关闭时归还；Tab 在弹窗内成环，
  // 键盘用户不会 Tab 到遮罩身后的外壳控件（如全局 UndoBar）。
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      lastFocused.current = document.activeElement as HTMLElement | null;
      const id = requestAnimationFrame(() => dialogRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    lastFocused.current?.focus?.();
    lastFocused.current = null;
  }, [open]);
  const trapTab = (e: React.KeyboardEvent): void => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const f = dialogRef.current.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])');
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const pick = (id: string): void => {
    setSel(id);
    localStorage.setItem(LS_THREAD, id);
  };

  /** 拖窗口：按住头部空白处拖；落在按钮或下拉上时不劫持点击。偏移以「不超出屏幕」为界。 */
  const clampOffset = (x: number, y: number): { x: number; y: number } => {
    const el = dialogRef.current;
    if (!el) return { x, y };
    const maxX = Math.max(0, window.innerWidth / 2 - el.offsetWidth / 2);
    const maxY = Math.max(0, window.innerHeight / 2 - el.offsetHeight / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };

  const onHeadDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (narrow) return;
    if ((e.target as Element).closest("button, a, input, textarea, select, .switcher-wrap")) return;
    gesture.current = { sx: e.clientX, sy: e.clientY, ox: drag?.x ?? 0, oy: drag?.y ?? 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onHeadMove = (e: React.PointerEvent<HTMLElement>): void => {
    const g = gesture.current;
    if (g) setDrag(clampOffset(g.ox + e.clientX - g.sx, g.oy + e.clientY - g.sy));
  };

  const onHeadUp = (): void => { gesture.current = null; };

  const submitCreate = (): void => {
    if (modal?.kind !== "create") return;
    void assistantApi.createThread(modal.title)
      .then((d) => {
        // 乐观更新 + 选中放在同一个批里：若先 reload 再 pick，
        // 回落保护 effect 会在旧列表里看不到新 id 而把选中踢回「通用」。
        setThreads((prev) => [...prev, { ...d.thread, builtin: false, messages: 0, images: 0 }]);
        setSel(d.thread.id);
        localStorage.setItem(LS_THREAD, d.thread.id);
        setModal(null);
      })
      .catch((error: Error) => setModal({ ...modal, err: error.message }));
  };

  const submitRename = (): void => {
    if (modal?.kind !== "rename") return;
    const title = modal.title.trim();
    if (title === "") { setModal({ ...modal, err: "名称不能为空" }); return; }
    void assistantApi.renameThread(modal.id, title)
      .then(() => {
        setThreads((prev) => prev.map((t) => (t.id === modal.id ? { ...t, title } : t)));
        setModal(null);
      })
      .catch((error: Error) => setModal({ ...modal, err: error.message }));
  };

  const submitDelete = (): void => {
    if (modal?.kind !== "delete") return;
    const id = modal.thread.id;
    // 先切回「通用」再发删除请求：否则 ChatView 会按刚删掉的派生 id 再轮询一次，
    // 服务端已经不认识它，控制台就是一串 /api/messages 404。
    if (sel === id) pick("");
    void assistantApi.deleteThread(id)
      .then(() => {
        setThreads((prev) => prev.filter((t) => t.id !== id));
        setModal(null);
      })
      .catch((error: Error) => { setListErr(error.message); setModal(null); });
  };

  /**
   * 清空一个工作区的消息（工作区本身留着）。
   *
   * 清完必须**主动**通知那一屏重取：ChatView 的增量轮询只收 id 更大的消息
   * （见 pullOnce），全量拉取又是按 id 合并的——两条路都不会把已经消失的行摘掉，
   * 所以不对它说一声，界面上那堆消息会一直挂到切走再切回来。
   * 只通报被清的那个工作区，别的联系人那屏不受影响。
   */
  const submitClear = (): void => {
    if (modal?.kind !== "clear" || modal.busy) return;
    const id = modal.thread.id;
    setModal({ ...modal, busy: true, err: "" });
    void assistantApi.clearThread(id)
      .then(() => {
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, messages: 0, images: 0 } : t)));
        window.dispatchEvent(new CustomEvent("xiaomo:messages-cleared", { detail: { contactId: threadContactId(id) } }));
        setModal(null);
      })
      .catch((error: Error) => setModal({ ...modal, busy: false, err: error.message }));
  };

  const modalInput = (value: string, onValue: (v: string) => void, onEnter: () => void): JSX.Element => (
    <input
      autoFocus maxLength={24} value={value} placeholder="最多 24 个字"
      onChange={(e) => onValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") onEnter(); }}
    />
  );

  return (
    <div className={"asst-layer" + (open ? " on" : "")}>
      <div className="asst-scrim" />
      {/* data-keep-menu：没传 root 的 useDismiss 靠它判"内部"；关闭由遮罩（外部按下）与 × 负责。 */}
      <section className="asst-dialog" ref={dialogRef} data-keep-menu="" role="dialog" aria-modal="true"
        tabIndex={-1} onKeyDown={trapTab}
        aria-label="问助手"
        style={drag && !narrow
          ? { transform: `translate(calc(-50% + ${drag.x}px), calc(-50% + ${drag.y}px))` }
          : undefined}>
        <header className="asst-head"
          onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadUp}>
          <div className="asst-id">
            <span className="asst-name">{asstName}</span>
            <span className="asst-sub"><i className={"dot " + status.tone} /><span className="asst-status">{status.text}</span></span>
          </div>
          <div className="asst-acts">
            <ThreadChip threads={threads} current={sel} dialogOpen={open} onPick={pick}
              onRename={(t) => setModal({ kind: "rename", id: t.id, title: t.title, err: "" })}
              onDelete={(t) => setModal({ kind: "delete", thread: t })}
              onClear={(t) => setModal({ kind: "clear", thread: t, busy: false, err: "" })} />
            <button type="button" className="ws-add" title="新建工作区" aria-label="新建工作区"
              onClick={() => setModal({ kind: "create", title: "", err: "" })}>
              <Plus size={15} />
            </button>
            <button type="button" className={"ws-add" + (showSettings ? " on" : "")}
              title={showSettings ? "回到对话" : "助手设置"}
              aria-label={showSettings ? "回到对话" : "助手设置"} aria-pressed={showSettings}
              onClick={() => setShowSettings((v) => !v)}>
              <Settings2 size={16} />
            </button>
            <button type="button" className="ws-add" title="关闭" aria-label="关闭" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
        {listErr && <div className="ws-err">{listErr}</div>}
        <div className="asst-body">
          {/* 聊天那屏**不卸载**（关闭只是隐藏，草稿与流式都在里面），设置屏是盖在它上面的一层：
              从设置返回时看到的还是原来那条会话，不重新挂一遍。 */}
          <ChatView key={sel} paused={!open} contactIdOverride={threadContactId(sel)}
            characterName={asstName} ownerName={ownerName}
            ownerAvatar={ownerAvatar} contactAvatar={avatar}
            onStatus={reportStatus}
            introChip="帮我接入一个模型" />
          {showSettings && (
            <Suspense fallback={null}>
              <div className="asst-settings">
                <ProfileView mode="edit" contactId="assistant" initialPage="settings"
                  onBack={() => setShowSettings(false)} onSaved={loadIdentity} />
              </div>
            </Suspense>
          )}
        </div>
      </section>

      {modal?.kind === "create" && (
        <ModalCard title="新建工作区" sub="工作区之间对话完全隔离，适合分开处理不同问题。留空则发送第一条消息后自动命名。"
          onClose={() => setModal(null)}
          actions={<button type="button" className="primary" onClick={submitCreate}>创建</button>}>
          {modalInput(modal.title, (v) => setModal({ ...modal, title: v, err: "" }), submitCreate)}
          {modal.err && <div className="add-err">{modal.err}</div>}
        </ModalCard>
      )}
      {modal?.kind === "rename" && (
        <ModalCard title="重命名工作区" sub=""
          onClose={() => setModal(null)}
          actions={<button type="button" className="primary" onClick={submitRename}>保存</button>}>
          {modalInput(modal.title, (v) => setModal({ ...modal, title: v, err: "" }), submitRename)}
          {modal.err && <div className="add-err">{modal.err}</div>}
        </ModalCard>
      )}
      {modal?.kind === "clear" && (
        <ModalCard title="清空消息" sub={`只清空「${modal.thread.title}」里的消息，工作区本身保留，名字与位置都不动。`}
          onClose={() => setModal(null)}
          actions={<>
            <button type="button" onClick={() => setModal(null)}>取消</button>
            <button type="button" className="primary danger" disabled={modal.busy} onClick={submitClear}>清空</button>
          </>}>
          <span className="ws-del-name">
            {modal.thread.messages === 0
              ? "这个工作区已经是空的。"
              : `将删除 ${modal.thread.messages} 条消息${modal.thread.images > 0 ? `，其中 ${modal.thread.images} 张图会一并从本地删除` : ""}。删除后无法恢复。`}
          </span>
          {modal.err !== "" && <div className="add-err">{modal.err}</div>}
        </ModalCard>
      )}
      {modal?.kind === "delete" && (
        <ModalCard title="删除工作区" sub={`「${modal.thread.title}」的对话记录将彻底删除，无法恢复。`}
          onClose={() => setModal(null)}
          actions={<>
            <button type="button" onClick={() => setModal(null)}>取消</button>
            <button type="button" className="primary danger" onClick={submitDelete}>删除</button>
          </>}>
          <span className="ws-del-name">删除后该工作区的历史消息与处理记录一并清除。</span>
        </ModalCard>
      )}
    </div>
  );
}

/** 工作区管理弹窗：portal 挂 body，才不会被助手弹窗的层叠上下文压住。 */
function ModalCard({ title, sub, onClose, actions, children }: {
  title: string; sub: string; onClose: () => void;
  actions: JSX.Element; children: React.ReactNode;
}): JSX.Element {
  return createPortal(
    <Modal onClose={onClose} label={title} className="ws-modal"
      head={<div className="ws-modal-head"><span className="modal-title">{title}</span><button type="button" aria-label="关闭" onClick={onClose}><X size={15} /></button></div>}>
      {sub && <div className="modal-sub">{sub}</div>}
      {children}
      <div className="add-row">{actions}</div>
    </Modal>,
    document.body,
  );
}
