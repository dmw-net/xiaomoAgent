import { memo, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import Avatar from "../../components/Avatar";
import type { MessageRow } from "../../types";
import { renderLinkedText } from "../../lib/md";

/** 工具卡 text 的结构（agent.ts 落库时写入）。 */
type ToolPayload = { tool?: string; ok?: boolean; summary?: string; elapsedMs?: number };

const TOOL_LABEL: Record<string, string> = {
  get_current_time: "看了下时间",
  search_memory: "翻了翻记忆",
  schedule_reminder: "记了条提醒",
  generate_image: "画了张图",
  web_search: "联网搜了一下",
  web_fetch: "读了个网页",
  load_skill: "翻出技能做法",
  app_status: "读了当前配置",
  configure_model: "配了模型",
  activate_model: "切了模型",
  create_contact: "建了联系人",
  update_contact: "改了联系人",
  bind_contact_model: "绑了模型",
  set_contact_avatar: "设了头像",
};

/** 工具调用卡：紧凑一行，展示"她在查什么"而不是甩 JSON；有详情时可点开回看。 */
function ToolCard({ m, contactAvatar, contactName = "小茉", onImageClick }: {
  m: MessageRow; contactAvatar?: string; contactName?: string;
  /** 点图放大：搜到的候选图跟气泡里的图走同一条灯箱通道（ChatView 的 openZoom）。 */
  onImageClick?: (url: string) => void;
}): JSX.Element {
  const p = useMemo((): ToolPayload => {
    try { return JSON.parse(m.text) as ToolPayload; } catch { return {}; /* 旧数据或解析失败走回退 */ }
  }, [m.text]);
  const [open, setOpen] = useState(false);
  const ok = p.ok !== false;
  // 未登记的工具不露原始函数名（get_current_time 之类）——兜一句人话。
  const label = TOOL_LABEL[p.tool ?? ""] ?? "做了点事";
  const summary = p.summary || (ok ? "完成" : "失败");
  const detail = m.tool_detail ?? "";
  const expandable = detail !== "";
  /** 搜到的候选图（目前只有图片搜索会带）：直接摆在卡片下面，点一下看大图。 */
  const imgs = m.attachments ?? [];

  const head = (
    <>
      <span className="tool-ico">{ok ? <Check size={11} strokeWidth={2.4} /> : <X size={11} strokeWidth={2.4} />}</span>
      <span className="tool-label">{label}</span>
      <span className="tool-sep">·</span>
      <span className="tool-summary">{summary}</span>
      {expandable && (open
        ? <ChevronDown size={12} strokeWidth={2} className="tool-caret" />
        : <ChevronRight size={12} strokeWidth={2} className="tool-caret" />)}
    </>
  );

  return (
    <div className={"msg-row her gap"} data-id={m.id} data-tool={p.tool ?? ""} tabIndex={-1}>
      <Avatar className="msg-ava" src={contactAvatar || undefined} name={contactName} alt={contactName + "的头像"} />
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
          <div className="tool-detail" aria-label="工具返回详情">{renderLinkedText(detail)}</div>
        )}
      </div>
    </div>
  );
}

export default memo(ToolCard);
