import { memo, useMemo, type CSSProperties } from "react";
import { Volume2, Loader2 } from "lucide-react";
import Avatar from "../../components/Avatar";
import VoiceMessageBubble from "../../components/VoiceMessageBubble";
import { useLongPress } from "../../hooks/useLongPress";
import { findFirstExternalUrl, renderMd } from "../../lib/md";
import LinkPreviewCard from "./LinkPreviewCard";
import ThinkingBlock from "./ThinkingBlock";
import { avatarToneStyle } from "../../lib/avatar-tone";
import type { MessageAttachmentMeta, MessageRow } from "../../types";

/** 一条普通消息气泡（含撤回态）。编辑态不走这里——它需要编辑器状态，留在 ChatView。 */
function MessageRow({ m, gap, time, characterName, ownerName, ownerAvatar, contactAvatar, onContextMenu, onLongPress, onImageClick, failed, onRetry, ttsOn, ttsPlaying, ttsBusy, onPlayTts, showThinking = true, thinkingOpen, onThinkingOpenChange, enter = false, enterDelay = 0 }: {
  m: MessageRow;
  gap: boolean;
  /** 本条是「刚追加进来」的新消息，挂一次入场动效（判定见 ChatView 的 enterIds）。 */
  enter?: boolean;
  /** 连续分条的错峰延迟，避免整组气泡同时出现。 */
  enterDelay?: number;
  /** 气泡右下角的时间；缺省不显示。 */
  time?: string;
  characterName: string;
  ownerName: string;
  ownerAvatar: string;
  contactAvatar: string;
  onContextMenu: (m: MessageRow, x: number, y: number) => void;
  onLongPress: (m: MessageRow, x: number, y: number) => void;
  onImageClick?: (url: string) => void;
  /** 这一轮失败了：气泡旁挂红叹号，点击原地重试（微信式）。 */
  failed?: { id: string; error: string | null } | null;
  onRetry?: (turnId: string) => void;
  /** 语音合成：能力开关与本条播放态拆成原始值。合成一个对象字面量传进来，
      整屏气泡就每敲一个字符换一次引用，memo 形同没有。 */
  ttsOn?: boolean;
  /** 该联系人是否在聊天框显示思考过程（资料页「对话设置」里的开关）。 */
  showThinking?: boolean;
  /** 思考面板是否展开：由聊天页按 turnId 持久化，保证流式草稿与定稿交接不闪回。 */
  thinkingOpen?: boolean;
  onThinkingOpenChange?: (turnId: string, open: boolean) => void;
  ttsPlaying?: boolean;
  ttsBusy?: boolean;
  onPlayTts?: (m: MessageRow) => void;
}): JSX.Element {
  const cls = "msg-row " + (m.role === "user" ? "me" : "contact") + (m.kind === "proactive" ? " proactive" : "")
    + (gap ? " gap" : "") + (enter ? " msg-enter" : "");
  const touch = useLongPress((x, y) => onLongPress(m, x, y));
  // 键盘通道不在每一行上：整个消息区只占一个 Tab 停靠点，↑↓ 走位 + 回车开菜单
  // （见 ChatView 的 rowNav）。每条气泡各自 tabIndex=0 时，首屏 500 条要把 Tab 按 500 次。
  const handlers = {
    // -1：能被 ↑↓ 编程式聚焦，但不占 Tab 序列（停靠点只有消息区那一个）
    tabIndex: -1,
    onContextMenu: (e: React.MouseEvent): void => {
      e.preventDefault();
      onContextMenu(m, e.clientX, e.clientY);
    },
    ...touch,
  };

  const allAttachments = m.attachments ?? [];
  const audioMeta = m.attachment_meta?.find((item) => item.kind === "audio" && allAttachments.includes(item.url));
  const fallbackVoiceUrl = allAttachments.find((url) => /\.(mp3|wav|m4a|ogg|opus|weba)$/i.test(url));
  const voiceMeta: MessageAttachmentMeta | null = audioMeta ?? (fallbackVoiceUrl ? { url: fallbackVoiceUrl, kind: "audio" } : null);
  const imgs = voiceMeta ? allAttachments.filter((url) => url !== voiceMeta.url) : allAttachments;
  // 一次渲染只在 text 变化时重扫；长回复里正则扫描不该跟着 TTS/主题等无关 props 重跑。
  const previewUrl = useMemo(() => (m.text ? findFirstExternalUrl(m.text) : ""), [m.text]);
  // 这一条必须放在所有 Hook 之后：撤回会让同一行从普通气泡切成“已撤回”，
  // 若提前 return 跳过 useMemo，React 会看到 Hook 数量变化并整页白屏（error #300）。
  if (m.superseded_kind === "retract") {
    return (
      <div className={cls + " retracted"} data-id={m.id} {...handlers}>
        <div className="retracted-tip">{m.role === "user" ? "你撤回了一条消息" : "一条消息已撤回"}</div>
      </div>
    );
  }
  // 思考只属于联系人的回答；默认收起，展开后由面板自己承接长文本滚动，不把正文顶出屏幕。
  const thinking = showThinking && m.role === "assistant" && typeof m.reasoning === "string" && m.reasoning !== ""
    ? <ThinkingBlock reasoning={m.reasoning} open={thinkingOpen} persistKey={m.turn_id ?? undefined}
        onOpenChange={(open) => { if (m.turn_id) onThinkingOpenChange?.(m.turn_id, open); }} />
    : null;
  const failMark = failed ? (
    <button
      type="button"
      className="msg-fail"
      title="回复失败了，点这里重试"
      aria-label="回复失败了，点击重试"
      onClick={(e) => { e.stopPropagation(); onRetry?.(failed.id); }}
    >!</button>
  ) : null;
  const bubble = (
    <div className={"bubble" + (voiceMeta ? " voice-only" : imgs.length > 0 && m.text === "" ? " img-only" : "")}>
      {m.role === "user" && m.sender_name && <div className="msg-sender">{m.sender_name}</div>}
      {thinking}
      {voiceMeta && (
        <VoiceMessageBubble url={voiceMeta.url} durationMs={voiceMeta.durationMs}
          waveform={voiceMeta.waveform} transcript={voiceMeta.transcript} />
      )}
      {imgs.length > 0 && (
        <div className={"msg-imgs" + (imgs.length === 1 ? " single" : "")}>
          {imgs.map((url) => (
            <img key={url} src={url} alt={m.role === "user" ? "我发送的图片" : characterName + "发来的图片"} loading="lazy"
              onClick={(e) => { e.stopPropagation(); onImageClick?.(url); }}
              onContextMenu={(e) => e.stopPropagation()} />
          ))}
        </div>
      )}
      {!voiceMeta && m.text && <div className="msg-text">{renderMd(m.text)}</div>}
      {/* key 用地址本身：编辑消息换了链接时强制重挂载，避免新链接下还显示旧卡的标题/域名。 */}
      {previewUrl !== "" && <LinkPreviewCard key={previewUrl} url={previewUrl} />}
      {time && <div className="msg-time">{time}</div>}
    </div>
  );

  const enterStyle = enter ? ({ "--enter-delay": `${enterDelay}ms` } as CSSProperties) : undefined;

  return (
    <div className={cls} data-id={m.id} style={enterStyle} {...handlers}>
      {failMark}
      {/* 主动消息也是"联系人说的话：给头像、用常规气泡，只在角落挂一个「主动」小徽标。 */}
      {m.role !== "user" && (
        <Avatar className={"msg-ava" + (gap ? "" : " ava-hidden")} src={contactAvatar || undefined} name={characterName}
          style={avatarToneStyle(characterName)} />
      )}
      {bubble}
      {!voiceMeta && ttsOn && m.role === "assistant" && m.kind === "chat" && m.text !== "" && (
        <button type="button" className={"tts-btn" + (ttsPlaying ? " playing" : "")} title="播放语音"
          aria-label="播放语音" disabled={ttsBusy}
          onClick={(e) => { e.stopPropagation(); onPlayTts?.(m); }}
          onContextMenu={(e) => e.stopPropagation()}>
          {ttsBusy ? <Loader2 size={15} className="spin" /> : <Volume2 size={15} />}
        </button>
      )}
      {m.role === "user" && (
        <Avatar className={"msg-ava mine" + (gap ? "" : " ava-hidden")} src={ownerAvatar || undefined} name={ownerName || "我"} />
      )}
    </div>
  );
}

/** 整屏最多 500 条气泡，每条都要跑一遍 renderMd 拆行。输入框每敲一个字符
    就重渲染全部气泡，是这套 UI 最贵的一次空转——用 memo 挡住。 */
export default memo(MessageRow);
