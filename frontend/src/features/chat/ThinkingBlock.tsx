import { useEffect, useId, useRef, useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import { renderMd } from "../../lib/md";

const thinkingScrollPositions = new Map<string, number>();

type ThinkingBlockProps = {
  reasoning: string;
  /** 正文尚未开始时为 true：面板展开并跟随最新推理；正文到达后只把状态改为已完成。 */
  live?: boolean;
  /** 受控展开态。聊天页用它保证草稿气泡与最终气泡交接时不会自动收起。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 轮次 id：草稿气泡切到定稿气泡时恢复思考面板的阅读位置。 */
  persistKey?: string;
};

/** 回答前展示的推理记录。思考先到先显示，正文与定稿都不会改变用户当前的展开选择。 */
export default function ThinkingBlock({ reasoning, live = false, open, onOpenChange, persistKey }: ThinkingBlockProps): JSX.Element {
  const [innerOpen, setInnerOpen] = useState(false);
  const expanded = open ?? innerOpen;
  const bodyId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const hadReasoning = useRef(reasoning !== "");
  const hasReasoning = reasoning !== "";
  const chars = reasoning.length.toLocaleString("zh-CN");

  const setExpanded = (next: boolean): void => {
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };

  // 非受控用法（历史消息）在首个 reasoning 到达时自动展开；受控用法由聊天页统一管理。
  useEffect(() => {
    if (open === undefined && live && hasReasoning && !hadReasoning.current) setInnerOpen(true);
    hadReasoning.current = hasReasoning;
  }, [hasReasoning, live, open]);

  // 首次展开：恢复这条回复上次的阅读位置；没有记录时，流式面板从最新内容开始。
  useEffect(() => {
    if (!expanded) return;
    const timer = window.setTimeout(() => {
      const body = bodyRef.current;
      if (!body) return;
      const saved = persistKey ? thinkingScrollPositions.get(persistKey) : undefined;
      if (saved !== undefined) {
        body.scrollTop = saved;
        followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
        return;
      }
      if (live) {
        body.scrollTop = body.scrollHeight;
        followRef.current = true;
        return;
      }
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      rootRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [expanded, live, persistKey]);

  // 只有用户仍停留在底部时才跟随新推理；手动上翻阅读后，不再被流式更新拽回去。
  useEffect(() => {
    if (!expanded || !live) return;
    const body = bodyRef.current;
    if (body && followRef.current) {
      body.scrollTop = body.scrollHeight;
      if (persistKey) thinkingScrollPositions.set(persistKey, body.scrollTop);
    }
  }, [expanded, live, persistKey, reasoning]);

  return (
    <section ref={rootRef} className={"think" + (expanded ? " is-open" : "") + (live ? " is-live" : "")}
      aria-label="思考过程" aria-busy={live}>
      <button
        type="button"
        className="think-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        title={expanded ? "收起思考过程" : "展开思考过程"}
        onClick={(event) => { event.stopPropagation(); setExpanded(!expanded); }}
        onContextMenu={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        <span className="think-icon" aria-hidden="true"><Brain size={13} strokeWidth={2} /></span>
        <span className="think-title">思考过程</span>
        <span className={"think-state" + (live ? " is-live" : "")}>{live ? "思考中" : "已完成"}</span>
        <span className="think-meta">{chars} 字</span>
        <ChevronDown className="think-chevron" size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="think-panel" id={bodyId} role="region" aria-label="思考过程详情">
          <div ref={bodyRef} className="think-content"
            onScroll={(event) => {
              const body = event.currentTarget;
              followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
              if (persistKey) thinkingScrollPositions.set(persistKey, body.scrollTop);
            }}>{renderMd(reasoning)}</div>
        </div>
      )}
    </section>
  );
}

/** 等待首个思考或正文片段时显示的状态，避免开启思考后只剩三个无语义的省略号。 */
export function ThinkingLive(): JSX.Element {
  return (
    <span className="think-live" role="status" aria-live="polite">
      <span className="think-live-icon" aria-hidden="true"><Brain size={13} strokeWidth={2} /></span>
      <span className="think-live-label">正在思考</span>
      <span className="think-live-dots" aria-hidden="true"><i /><i /><i /></span>
    </span>
  );
}