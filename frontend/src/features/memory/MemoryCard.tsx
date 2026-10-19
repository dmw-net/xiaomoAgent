import { Pencil, Trash2 } from "lucide-react";
import { relTime } from "../../lib/datetime";
import { kindLabel } from "./constants";
import type { MemoryEvent } from "../../types";

/** 一条记忆卡片：清单页传入 onEdit/onDelete 出现操作按钮；score/matched 只在召回试验台用（普通清单不传）。 */
export default function MemoryCard({ event, score, matched, who = "联系人", onEdit, onDelete }: {
  event: MemoryEvent;
  score?: number;
  matched?: string[];
  who?: string;
  onEdit?: () => void;
  onDelete?: () => void;
}): JSX.Element {
  return (
    <div className="mem" data-kind={event.kind || "fact"}>
      <div className="bar" />
      <div className="body">
        <div className="text">{event.content}</div>
        <div className="meta">
          <span className="tag">{kindLabel(event.kind)}</span>
          {event.subject && <span>关于{event.subject}</span>}
          <span>{relTime(event.created_at)}</span>
          {typeof score === "number" && (
            <><span className="sep">·</span><span className="score">相关度 {score.toFixed(2)}</span></>
          )}
          {event.last_used_at && (
            <><span className="sep">·</span><span>最近用到 {relTime(event.last_used_at)}</span></>
          )}
          {(onEdit || onDelete) && (
            <span className="mem-acts">
              {onEdit && <button type="button" className="mem-act" aria-label="纠正这条记忆" title="改错了就纠正它" onClick={onEdit}><Pencil size={13} /></button>}
              {onDelete && <button type="button" className="mem-act" aria-label="删除这条记忆" title={`不想让${who}记住就删掉`} onClick={onDelete}><Trash2 size={13} /></button>}
            </span>
          )}
        </div>
        {matched && matched.length > 0 && (
          <div className="why">命中：{matched.map((k, i) => <em key={i}>{k}</em>)}</div>
        )}
      </div>
    </div>
  );
}
