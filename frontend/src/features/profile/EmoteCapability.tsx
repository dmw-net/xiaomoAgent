import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import * as emotesApi from "../../api/emotes";
import type { EmoteCapabilities, EmoteFace } from "../../api/emotes";

/**
 * 表情能力：当前接入渠道能发哪几种表情，以及哪些中文词能命中 QQ 内置表情。
 *
 * 原来挂在 设置 → 表情 顶上。它讲的是「QQ 这条通道能做什么」，不是「她有什么」，
 * 所以跟着 QQ 连接卡走，就贴在接入渠道选择器下面——换渠道时这段话正是用户要看的。
 * 词表是参考信息，默认收起，别占着卡片。
 */
export default function EmoteCapability(): JSX.Element | null {
  const [caps, setCaps] = useState<EmoteCapabilities | null>(null);
  const [faces, setFaces] = useState<EmoteFace[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    emotesApi.overview()
      .then((d) => { if (!cancelled) setCaps(d.capabilities); })
      .catch(() => { /* 探测不到就不显示这块，别编一个 */ });
    emotesApi.faces().then((r) => { if (!cancelled) setFaces(r.faces); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (caps === null) return null;
  const official = caps.backend === "official";

  return (
    <div className="qq-emote-cap">
      <button type="button" className="qq-emote-cap-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className={"qq-emote-cap-caret" + (open ? " on" : "")} aria-hidden="true" />
        <span>表情能发成什么样</span>
      </button>
      <div className="hint">
        {official
          ? "官方机器人：图片表情能发（动图会发它的首帧），QQ 内置表情与商城动态表情发不了，会降级成一个 emoji 或一句文字。想原生发动态表情要切 OneBot 协议端。"
          : "OneBot 协议端：图片、动图、QQ 内置表情、商城动态表情都能原生发。"}
      </div>
      {open && (
        <>
          <div className="hint" style={{ marginTop: 8 }}>
            下面这些词能命中 QQ 内置表情{official ? "（官方渠道会降级成 emoji）" : ""}。聊天时提到这些，模型就知道有这张可用。
          </div>
          <div className="emote-face-chips">
            {faces.map((f) => (
              <span key={f.keyword + f.id} className="emote-face-chip" title={`${f.emoji} face #${f.id}`}>
                {f.emoji} <span>{f.keyword}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
