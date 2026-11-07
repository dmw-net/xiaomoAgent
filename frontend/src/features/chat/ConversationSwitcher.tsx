import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LockKeyhole, MessageSquareText, Search, UsersRound, X } from "lucide-react";
import { useDismiss } from "../../hooks/useDismiss";
import { useExitVisible } from "../../hooks/useExitVisible";
import { usePopPosition } from "../../hooks/usePopPosition";
import { shortTimeLabel } from "../../lib/datetime";
import type { ContactConversationItem } from "../../types";

const POP_W = 300;
const ROW_H = 54;

/**
 * 聊天页内的会话切换器。
 *
 * 一对一私聊在应用、微信和 QQ 之间共用同一段上下文，所以这里的主项叫
 * “私聊”；只有 QQ 群因为参与者与上下文不同才需要单独切换。触发器是
 * 标题下方的一行轻量文本，不再做成有边框的胶囊，避免抢头像和名字的层级。
 */
export default function ConversationSwitcher({ conversations, currentId, onSelect }: {
  conversations: ContactConversationItem[];
  /** null = 联系人主私聊；字符串 = 当前 QQ 群。 */
  currentId: string | null;
  onSelect: (conversationId: string | null, title?: string, readOnly?: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 下拉退场：open 置假先播 menuOut 淡出（与 menuIn 互为镜像），走完再摘 portal。
  const exit = useExitVisible(open, "menuOut");
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { setRef, pos, place } = usePopPosition(POP_W, 430);
  // 只负责收起；清查询词统一交给上面那条 effect（退场帧播完再清，淡出不变脸）。
  useDismiss(open, () => setOpen(false));

  const local = conversations.find((conv) => conv.channel === "web" && conv.kind === "private");
  const groups = conversations.filter((conv) => conv.channel === "qq" && conv.kind === "group");
  const orderedGroups = [
    ...groups.filter((conv) => conv.leftAt === null),
    ...groups.filter((conv) => conv.leftAt !== null),
  ];
  const searchable = groups.length > 6;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = normalizedQuery === ""
    ? orderedGroups
    : orderedGroups.filter((conv) => conv.title.toLocaleLowerCase().includes(normalizedQuery));
  const leftGroups = groups.filter((conv) => conv.leftAt !== null).length;
  // 查询词等退场帧播完再清：清早了，淡出中的搜索框会当着用户的面突然变空。
  useEffect(() => { if (!exit.visible) setQuery(""); }, [exit.visible]);
  // 群多时当前会话可能不在列表顶部，打开后先把它滚进可视区。
  useEffect(() => {
    if (!open || currentId === null) return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(currentId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, currentId]);
  if (groups.length === 0) return <></>;

  const currentGroup = currentId ? groups.find((conv) => conv.id === currentId) : undefined;
  // 主状态永远是“在线/正在回复”，这里只承担次级上下文：
  // 私聊时提示有几个群可切，进群后直接显示当前群名。
  const currentLeft = currentGroup !== undefined && currentGroup.leftAt !== null;
  const currentLabel = currentId
    ? `${currentGroup?.title || "QQ 群"}${currentLeft ? " · 已离群" : ""}`
    : `群聊 ${groups.length}`;

  const toggle = (): void => {
    if (!open) place(Math.min(groups.length + 3, 9), ROW_H);
    setOpen(!open);
    if (open) setQuery("");
  };

  const pickLocal = (): void => {
    setOpen(false); setQuery("");
    if (currentId !== null) onSelect(null);
  };

  const pickGroup = (conv: ContactConversationItem): void => {
    setOpen(false); setQuery("");
    if (conv.id !== currentId) onSelect(conv.id, conv.title, true);
  };

  return (
    <span className="conv-switch-wrap" ref={setRef} data-keep-menu="">
      <button type="button" className={"conv-switch" + (open ? " on" : "")}
        aria-haspopup="listbox" aria-expanded={open}
        aria-label={currentId ? `当前群 ${currentLabel}，切换会话` : `当前私聊，有 ${groups.length} 个 QQ 群可切换`}
        title={currentId ? `当前群：${currentLabel} · 点击切换私聊或群` : `切换 QQ 群（${groups.length}）`}
        onClick={toggle}>
        <UsersRound size={11} strokeWidth={1.9} className="conv-switch-glyph" />
        <span className="conv-switch-label">{currentLabel}</span>
        <ChevronDown size={11} strokeWidth={2} className={"conv-switch-arrow" + (open ? " up" : "")} />
      </button>
      {exit.visible && createPortal(
        <div className="conv-switch-pop" data-keep-menu="" role="listbox" aria-label="选择会话来源"
          data-closing={exit.closing || undefined} aria-hidden={exit.closing || undefined}
          onAnimationEnd={exit.onAnimationEnd}
          style={{ left: pos.left, top: pos.top, width: `min(${POP_W}px, calc(100vw - 24px))`, transform: pos.flip ? "translateY(-100%)" : undefined }}>
          <div className="conv-switch-head">
            <span className="conv-switch-title-main">切换会话</span>
            <span className="conv-switch-count">
              {groups.length} 个群{leftGroups > 0 ? ` · ${leftGroups} 已离群` : " · 1 段私聊"}
            </span>
          </div>
          {searchable && (
            <div className="conv-switch-search">
              <Search size={13} strokeWidth={2} />
              <input value={query} autoFocus placeholder="搜索 QQ 群名" tabIndex={exit.closing ? -1 : undefined}
                aria-label="搜索 QQ 群名" onChange={(e) => setQuery(e.target.value)} />
              {query !== "" && (
                <button type="button" aria-label="清除搜索" title="清除搜索" tabIndex={exit.closing ? -1 : undefined} onClick={() => setQuery("")}>
                  <X size={13} strokeWidth={2} />
                </button>
              )}
            </div>
          )}
          <div className="conv-switch-section">主对话</div>
          <button type="button" role="option" aria-selected={currentId === null}
            tabIndex={exit.closing ? -1 : undefined}
            className={"conv-switch-row" + (currentId === null ? " on" : "")} onClick={pickLocal}>
            <span className="conv-switch-icon local"><MessageSquareText size={15} strokeWidth={1.9} /></span>
            <span className="conv-switch-copy">
              <span className="conv-switch-row-title">私聊</span>
              <span className="conv-switch-row-meta">应用、微信、QQ 共用这一段对话</span>
            </span>
            {local && local.unread > 0 && <span className="conv-switch-badge">{local.unread > 99 ? "99+" : local.unread}</span>}
            {currentId === null && <Check size={15} strokeWidth={2.2} className="conv-switch-check" />}
          </button>
          <div className="conv-switch-section qq">
            <span>QQ 群</span>
            {normalizedQuery !== "" && <span>{visibleGroups.length} / {groups.length}</span>}
          </div>
          <div className="conv-switch-scroll" ref={scrollRef}>
            {visibleGroups.map((conv) => (
              <button key={conv.id} type="button" role="option" aria-selected={conv.id === currentId}
                tabIndex={exit.closing ? -1 : undefined}
                data-conversation-id={conv.id}
                className={"conv-switch-row" + (conv.id === currentId ? " on" : "") + (conv.enabled ? "" : " off")}
                title={`QQ 群 · ${conv.title}`}
                onClick={() => pickGroup(conv)}>
                <span className="conv-switch-icon group"><UsersRound size={15} strokeWidth={1.9} /></span>
                <span className="conv-switch-copy">
                  <span className="conv-switch-row-title">{conv.title}</span>
                  <span className="conv-switch-row-meta">
                    {conv.leftAt !== null ? "已离群 · 仅保留历史" : `群聊 · 只读${conv.enabled ? "" : " · 已停用"}`}
                  </span>
                </span>
                <span className="conv-switch-side">
                  <span className="conv-switch-time">{shortTimeLabel(conv.lastAt)}</span>
                  {conv.unread > 0 && <span className="conv-switch-badge">{conv.unread > 99 ? "99+" : conv.unread}</span>}
                </span>
                {conv.id === currentId && <Check size={15} strokeWidth={2.2} className="conv-switch-check" />}
              </button>
            ))}
            {visibleGroups.length === 0 && (
              <div className="conv-switch-empty">没有匹配的群名</div>
            )}
          </div>
          <div className="conv-switch-foot">
            <LockKeyhole size={11} strokeWidth={2} />群聊只读；回复请在 QQ 群里 @机器人。
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
