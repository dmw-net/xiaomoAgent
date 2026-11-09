import { memo, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Volume2, Loader2 } from "lucide-react";
import Avatar from "../../components/Avatar";
import VoiceMessageBubble from "../../components/VoiceMessageBubble";
import { useLongPress } from "../../hooks/useLongPress";
import { findFirstExternalUrl, renderMd } from "../../lib/md";
import LinkPreviewCard from "./LinkPreviewCard";
import ThinkingBlock from "./ThinkingBlock";
import { avatarToneStyle } from "../../lib/avatar-tone";
import type { MessageAttachmentMeta, MessageRow } from "../../types";

/** 一条普通消息气泡（含撤回态）。编辑态不走这里——它需要编辑器状态，留在 ChatView。 */
function MessageRow({ m, gap, time, characterName, ownerName, ownerAvatar, contactAvatar, onContextMenu, onLongPress, onImageClick, failed, onRetry, ttsOn, ttsPlaying, ttsBusy, onPlayTts, showThinking = true, thinkingOpen, onThinkingOpenChange, showSenderName = true, enter = false, enterDelay = 0, variantCount = 0, variantIndex = 0, onVariantChange, onVariantGenerate, demo = false, showSpeed = true, highlight = "" }: {
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
  /** 只有群聊才显示发言人昵称：私聊是 1v1，气泡上再挂一行自己的名字纯属多余。 */
  showSenderName?: boolean;
  /** 思考面板是否展开：由聊天页按 turnId 持久化，保证流式草稿与定稿交接不闪回。 */
  thinkingOpen?: boolean;
  onThinkingOpenChange?: (turnId: string, open: boolean) => void;
  ttsPlaying?: boolean;
  ttsBusy?: boolean;
  onPlayTts?: (m: MessageRow) => void;
  /** 回复版本切换（swipe）：该轮保留的版本数与当前序号。只在每轮第一条 assistant
      气泡上有值（后端只写这一条），其余行传 0，切换条自然不渲染。 */
  variantCount?: number;
  variantIndex?: number;
  onVariantChange?: (m: MessageRow, index: number) => void;
  /** 版本条右位的「再来一版」：当前已是最新版本时，右箭头换成重新生成入口
      （走 ChatView 的确认弹窗，与菜单「重新生成」同一条路）。 */
  onVariantGenerate?: (m: MessageRow) => void;
  /** 演示模式标记：气泡上挂「演示回复」角标（onboarding 的示例对话用）。 */
  demo?: boolean;
  /** 是否显示生成速度（t/s）：设置页「聊天显示」里的设备级开关，默认开。 */
  showSpeed?: boolean;
  /** 当前搜索词：非空时把正文里的命中片段包进 <mark>。只有搜索命中的行会传。 */
  highlight?: string;
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
  /** 3 张及以上先收成一张卡片（微信「合并发图」的做法）：防止一轮连发表情把气泡撑成画廊。 */
  const [imgsExpanded, setImgsExpanded] = useState(false);
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
  const imgsFolded = imgs.length >= 3 && !imgsExpanded;
  const shownImgs = imgsFolded ? imgs.slice(0, 1) : imgs;
  // 生成速度（token/秒）：≥100 收成整数（"128 t/s"），否则留一位小数（"42.5 t/s"）。
  // showSpeed 关掉只是不渲染这一截；字段本身照常下发，开关切回来不用重新生成。
  const speedLabel = showSpeed && m.role === "assistant" && m.kind === "chat"
    && typeof m.tokens_per_sec === "number" && m.tokens_per_sec > 0
    ? (m.tokens_per_sec >= 100 ? `${Math.round(m.tokens_per_sec)} t/s` : `${m.tokens_per_sec.toFixed(1)} t/s`)
    : "";
  // 版本切换条（swipe）：重答后变 2/3、3/3…左箭头回看历史版本。只有一个版本的
  // 回复不渲染「1/1」计数文字——100% 气泡都挂整条计数条是视觉噪声（评审 P3-3），
  // 收成一颗「再来一版」（↻）；真有多版本了才展开完整计数条。挂在底部元信息行的
  // 左位（与时间同一行），键盘可达性不变：原生 <button>，走消息区的 ↑↓/回车通道。
  const variantBar = variantCount >= 1 && m.role === "assistant" && m.kind === "chat" && m.superseded_at === null ? (
    <div className={"variant-bar" + (variantCount <= 1 ? " solo" : "")} role="group" aria-label="回复版本切换"
      onContextMenu={(e) => e.stopPropagation()}>
      {variantCount > 1 && (
        <>
          <button type="button" className="v-btn" title="上一个版本"
            aria-label="上一个版本" disabled={variantIndex <= 0}
            onClick={(e) => { e.stopPropagation(); onVariantChange?.(m, variantIndex - 1); }}>
            <ChevronLeft size={13} />
          </button>
          <span className="v-idx">{variantIndex + 1}/{variantCount}</span>
        </>
      )}
      {variantIndex >= variantCount - 1 ? (
        /* 已是最新版本：右位不再灰着，改成「再来一版」的入口——
           点击走重新生成的确认弹窗，新回答追加为下一个版本。 */
        <button type="button" className="v-btn generate" title="重新生成一个新版本"
          aria-label="重新生成一个新版本"
          onClick={(e) => { e.stopPropagation(); onVariantGenerate?.(m); }}>
          <RefreshCw size={12} />
        </button>
      ) : (
        <button type="button" className="v-btn" title="下一个版本"
          aria-label="下一个版本"
          onClick={(e) => { e.stopPropagation(); onVariantChange?.(m, variantIndex + 1); }}>
          <ChevronRight size={13} />
        </button>
      )}
    </div>
  ) : null;

  const bubble = (
    <div className={"bubble" + (voiceMeta ? " voice-only" : imgs.length > 0 && m.text === "" ? " img-only" : "")}>
      {m.role === "user" && showSenderName && m.sender_name && <div className="msg-sender">{m.sender_name}</div>}
      {thinking}
      {voiceMeta && (
        <VoiceMessageBubble url={voiceMeta.url} durationMs={voiceMeta.durationMs}
          waveform={voiceMeta.waveform} transcript={voiceMeta.transcript} />
      )}
      {imgs.length > 0 && (
        <>
          <div className={"msg-imgs" + (shownImgs.length === 1 ? " single" : "")}>
            {shownImgs.map((url) => (
              <img key={url} src={url} alt={m.role === "user" ? "我发送的图片" : characterName + "发来的图片"} loading="lazy"
                onClick={(e) => {
                  e.stopPropagation();
                  // 折叠态点图先展开，展开后才走灯箱放大。
                  if (imgsFolded) setImgsExpanded(true);
                  else onImageClick?.(url);
                }}
                onContextMenu={(e) => e.stopPropagation()} />
            ))}
          </div>
          {imgs.length >= 3 && (
            <button type="button" className="msg-img-fold-btn"
              onClick={(e) => { e.stopPropagation(); setImgsExpanded((v) => !v); }}>
              {imgsFolded ? `共 ${imgs.length} 张 · 点开看全部` : "收起"}
            </button>
          )}
        </>
      )}
      {!voiceMeta && m.text && <div className="msg-text">{renderMd(m.text, highlight)}</div>}
      {demo && m.role === "assistant" && m.kind === "chat" && (
        <div className="msg-demo-tag">演示回复 · 接模型后它会真的回你</div>
      )}
      {/* key 用地址本身：编辑消息换了链接时强制重挂载，避免新链接下还显示旧卡的标题/域名。 */}
      {previewUrl !== "" && <LinkPreviewCard key={previewUrl} url={previewUrl} />}
      {/* 底部元信息行：版本条靠左、时间与速度靠右，合成一行——原先版本条独占一行，
          与时间行叠成两行，气泡尾部显高。时间贴右靠 margin-left:auto 而不是
          space-between（只有时间时也要贴右）。三者全缺省则整行不渲染。 */}
      {(time || speedLabel || variantBar !== null) && (
        <div className="msg-meta">
          {variantBar}
          {(time || speedLabel) && (
            <div className="msg-time">
              {time}
              {time && speedLabel ? " · " : ""}
              {speedLabel && <span title="生成速度（token/秒，含思考与首字等待）">{speedLabel}</span>}
            </div>
          )}
        </div>
      )}
      {/* TTS 播放按钮：绝对定位悬浮右下角，不占排版空间；同一行时在时间右侧 */}
      {!voiceMeta && ttsOn && m.role === "assistant" && m.kind === "chat" && m.text !== "" && (
        <button type="button" className={"tts-btn" + (ttsPlaying ? " playing" : "")} title="播放语音"
          aria-label="播放语音" disabled={ttsBusy}
          onClick={(e) => { e.stopPropagation(); onPlayTts?.(m); }}
          onContextMenu={(e) => e.stopPropagation()}>
          {ttsBusy ? <Loader2 size={15} className="spin" /> : <Volume2 size={15} />}
        </button>
      )}
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
      {m.role === "user" && (
        <Avatar className={"msg-ava mine" + (gap ? "" : " ava-hidden")} src={ownerAvatar || undefined} name={ownerName || "我"} />
      )}
    </div>
  );
}

/** 整屏最多 500 条气泡，每条都要跑一遍 renderMd 拆行。输入框每敲一个字符
    就重渲染全部气泡，是这套 UI 最贵的一次空转——用 memo 挡住。 */
export default memo(MessageRow);
