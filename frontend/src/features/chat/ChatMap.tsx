import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, MapPinned as MapIcon, Search, X } from "lucide-react";
import { useDismiss } from "../../hooks/useDismiss";

export type ChatMapNode = {
  id: number;
  role: "user" | "assistant";
  preview: string;
  day: string;
  kind: string;
  hasImage: boolean;
};

/** 对话地图：把长会话压成一列可跳转节点，移动端底部抽屉，桌面端右侧浮层。 */
export default function ChatMap({ open, nodes, activeId, onJump, onClose, onOpenSearch }: {
  open: boolean;
  nodes: ChatMapNode[];
  activeId: number | null;
  onJump: (id: number) => void;
  onClose: () => void;
  onOpenSearch: () => void;
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);
  useDismiss(open, onClose, panelRef);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      setCollapsed(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const timer = window.setTimeout(() => { setRendered(false); setClosing(false); }, 240);
    return () => window.clearTimeout(timer);
  }, [open, rendered]);

  useEffect(() => {
    if (!open) return;
    // 每次打开都从会话头部开始；当前所在的位置仍由 active 高亮表示，但不自动把地图拉到底。
    const frame = requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0, behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open && !rendered) return null;

  let lastDay = "";
  return createPortal(
    <div className="chat-map-layer" data-keep-menu>
      <div className="chat-map-scrim" onClick={onClose} />
      <div ref={panelRef} className={"chat-map" + (collapsed ? " collapsed" : "") + (closing ? " closing" : "")}
        role="dialog" aria-modal="false" aria-label="对话地图">
        <div className="chat-map-handle" />
        <div className="chat-map-head">
          <div className="chat-map-title"><MapIcon size={16} strokeWidth={1.9} />对话地图<span>{nodes.length} 段</span></div>
          <div className="chat-map-acts">
            <button type="button" className="bar-btn" aria-label="搜索会话" title="搜索会话"
              onClick={() => { onClose(); onOpenSearch(); }}><Search size={15} /></button>
            <button type="button" className="bar-btn" aria-label={collapsed ? "展开地图" : "收起地图"}
              title={collapsed ? "展开地图" : "收起地图"} onClick={() => setCollapsed((v) => !v)}>
              {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            <button type="button" className="bar-btn" aria-label="关闭地图" title="关闭地图" onClick={onClose}><X size={16} /></button>
          </div>
        </div>
        {!collapsed && (
          <div className="chat-map-body" ref={bodyRef}>
            {nodes.length === 0 && <div className="chat-map-empty">这段对话还没有可显示的消息。</div>}
            {nodes.map((n) => {
              const day = n.day !== lastDay ? n.day : "";
              lastDay = n.day;
              return (
                <div key={n.id} className="chat-map-row-wrap">
                  {day && <div className="chat-map-day">{day}</div>}
                  <button type="button" data-map-id={n.id}
                    className={"chat-map-row " + (n.role === "user" ? "me" : "her") + (activeId === n.id ? " active" : "")}
                    title={n.preview} onClick={() => onJump(n.id)}>
                    <span className="chat-map-bubble">
                      {n.hasImage && <span className="chat-map-media">图</span>}
                      <span className="chat-map-preview">{n.preview}</span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
