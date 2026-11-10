import { memo, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import Avatar from "../../components/Avatar";
import { avatarToneStyle } from "../../lib/avatar-tone";
import { chatLabelsOf } from "../../lib/toolsStore";
import { useToolState } from "../../hooks/useToolState";
import type { MessageRow } from "../../types";
import { renderLinkedText } from "../../lib/md";

/** 工具卡 text 的结构（agent.ts 落库时写入）。 */
type ToolPayload = { tool?: string; ok?: boolean; summary?: string; elapsedMs?: number };

/** 工具调用卡：紧凑一行，展示"联系人在查什么"而不是甩 JSON；有详情时可点开回看。 */
function ToolCard({ m, contactAvatar, contactName = "小茉", onImageClick, imagesOnly = false, grouped = false }: {
  m: MessageRow; contactAvatar?: string; contactName?: string;
  /** 点图放大：搜到的候选图跟气泡里的图走同一条灯箱通道（ChatView 的 openZoom）。 */
  onImageClick?: (url: string) => void;
  /** 「工具调用过程」关掉时只留候选图：图是用户要的产出，不该被这条显示开关一起吞掉。 */
  imagesOnly?: boolean;
  /** 在工具折叠组里：隐藏头像（组本身已有一个），避免每张卡都挂一个。 */
  grouped?: boolean;
}): JSX.Element {
  const p = useMemo((): ToolPayload => {
    try { return JSON.parse(m.text) as ToolPayload; } catch { return {}; /* 旧数据或解析失败走回退 */ }
  }, [m.text]);
  const [open, setOpen] = useState(false);
  const ok = p.ok !== false;
  // 动作短语由后端 TOOL_META 的 chat 字段下发（toolsStore 缓存，App 启动预热），
  // 前端不再复刻一份工具名 → 短语映射——那份复刻漏登记时会把原始函数名兜成「做了点事」。
  const toolState = useToolState();
  const labels = useMemo(() => chatLabelsOf(toolState), [toolState]);
  const label = labels[p.tool ?? ""] ?? "做了点事";
  const rawSummary = p.summary || (ok ? "完成" : "失败");
  // 早期版本把工具结果的原始 JSON 当摘要落过库（send_emote 没登记时整串
  // {"via":"native",...} 直接显示在卡片上）。这类历史卡不能把调试载荷再甩给用户；
  // 新数据由 agent.toolSummary 保证是人话，这里只做兼容兜底。
  const summary = /^\s*[{[]/.test(rawSummary) ? (ok ? "完成" : "失败") : rawSummary;
  const detail = m.tool_detail ?? "";
  const expandable = detail !== "";
  /** 搜到的候选图（目前只有图片搜索会带）：直接摆在卡片下面，点一下看大图。 */
  const imgs = m.attachments ?? [];

  // 耗时数据落库时早就带上了（elapsedMs），只是界面一直没渲染——搜索/生图恰恰是
  // 用户最关心「等了多久」的动作。≥1s 显示秒（人读 1.2s 不读 1200ms），不到 1s
  // 显示毫秒；旧数据没有这个字段就不渲染，不留一个空档。
  const elapsed = typeof p.elapsedMs === "number" && p.elapsedMs >= 0
    ? (p.elapsedMs >= 1000 ? `${(p.elapsedMs / 1000).toFixed(1)}s` : `${Math.round(p.elapsedMs)}ms`)
    : null;

  const head = (
    <>
      <span className="tool-ico">{ok ? <Check size={11} strokeWidth={2.4} /> : <X size={11} strokeWidth={2.4} />}</span>
      <span className="tool-label">{label}</span>
      <span className="tool-sep">·</span>
      <span className="tool-summary">{summary}</span>
      {elapsed !== null && (
        <>
          <span className="tool-sep">·</span>
          <span className="tool-ms">{elapsed}</span>
        </>
      )}
      {expandable && (open
        ? <ChevronDown size={12} strokeWidth={2} className="tool-caret" />
        : <ChevronRight size={12} strokeWidth={2} className="tool-caret" />)}
    </>
  );

  // 只留候选图：不加头像列，也不给卡片留空壳，图本身就是这一行的全部内容。
  if (imagesOnly) {
    return (
      <div className="msg-row contact gap" data-id={m.id} data-tool={p.tool ?? ""} tabIndex={-1}>
        <Avatar className={"msg-ava" + (grouped ? " ava-hidden" : "")} src={contactAvatar || undefined} name={contactName} alt={contactName + "的头像"} style={avatarToneStyle(contactName)} />
        <div className="tool-wrap">
          <div className="tool-imgs">
            {imgs.map((url, index) => (
              <img key={`${index}-${url}`} src={url} alt={`${contactName}搜到的第 ${index + 1} 张候选图`}
                title={`第 ${index + 1} 张候选图`} decoding="async"
                onClick={() => onImageClick?.(url)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={"msg-row contact gap"} data-id={m.id} data-tool={p.tool ?? ""} tabIndex={-1}>
      <Avatar className={"msg-ava" + (grouped ? " ava-hidden" : "")} src={contactAvatar || undefined} name={contactName} alt={contactName + "的头像"} style={avatarToneStyle(contactName)} />
      <div className={"tool-wrap" + (ok ? "" : " bad")}>
        {expandable ? (
          <button
            type="button"
            className={"tool-card clickable" + (ok ? "" : " bad") + (open ? " open" : "")}
            aria-expanded={open}
            title={`${label} · ${summary}`}
            onClick={() => setOpen((v) => !v)}
          >
            {head}
          </button>
        ) : (
          <div className={"tool-card" + (ok ? "" : " bad")} title={`${label} · ${summary}`}>{head}</div>
        )}
        {imgs.length > 0 && (
          /* 候选图按 hits 的顺序排，详情里的 #1/#2 指的就是这里第几张——用户说"第 3 张"时两边对得上。 */
          <div className="tool-imgs">
            {imgs.map((url, index) => (
              <img key={`${index}-${url}`} src={url} alt={`${contactName}搜到的第 ${index + 1} 张候选图`}
                title={`第 ${index + 1} 张候选图`} decoding="async"
                onClick={() => onImageClick?.(url)} />
            ))}
          </div>
        )}
        {expandable && open && (
          // 保留 <pre>：.tool-detail 只设了 pre-wrap，等宽字体来自 pre 的默认样式；
          // 换成 div 会让 JSON / 搜索结果变成正文字体。<a> 放在 pre 里是合法的。
          <pre className="tool-detail" aria-label="工具返回详情">{renderLinkedText(detail)}</pre>
        )}
      </div>
    </div>
  );
}

/** 同一轮连续工具调用的折叠组：默认收起成一行「工具调用 · N 个 · 总耗时」，展开才看每张卡。
 *  工具过程是正文的附注，散成多行会把对话流切碎；组本身只收起文字卡，
 *  有候选图的仍单独露出来（图是用户要的产出，不能被收起一起藏掉）。 */
function ToolGroup({ items, contactAvatar, contactName = "小茉", onImageClick }: {
  items: MessageRow[]; contactAvatar?: string; contactName?: string;
  onImageClick?: (url: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  let totalMs = 0;
  let allOk = true;
  for (const m of items) {
    try {
      const p = JSON.parse(m.text) as ToolPayload;
      if (typeof p.elapsedMs === "number" && p.elapsedMs > 0) totalMs += p.elapsedMs;
      if (p.ok === false) allOk = false;
    } catch { /* 旧数据 */ }
  }
  const time = totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${Math.round(totalMs)}ms`;
  return (
    <div className="msg-row contact gap" data-id={items[0]?.id ?? 0} data-tool-group tabIndex={-1}>
      <Avatar className="msg-ava" src={contactAvatar || undefined} name={contactName} alt={contactName + "的头像"} style={avatarToneStyle(contactName)} />
      <div className="tool-wrap">
        <button type="button" className={"tool-group-card" + (allOk ? "" : " bad") + (open ? " open" : "")}
          aria-expanded={open} title={`展开 ${items.length} 个工具调用`}
          onClick={() => setOpen((v) => !v)}>
          <span className="tool-ico">{allOk ? <Check size={11} strokeWidth={2.4} /> : <X size={11} strokeWidth={2.4} />}</span>
          <span className="tool-group-label">工具调用</span>
          <span className="tool-sep">·</span>
          <span className="tool-group-count">{items.length} 个</span>
          {totalMs > 0 && (<><span className="tool-sep">·</span><span className="tool-ms">{time}</span></>)}
          <span className="tool-caret" aria-hidden="true">{open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}</span>
        </button>
        {open && (
          <div className="tool-group-body">
            {items.map((m) => (
              <ToolCard key={m.id} m={m} grouped contactAvatar={contactAvatar} contactName={contactName} onImageClick={onImageClick} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ToolCard);
export { ToolGroup };
