import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImageOff, Loader2, RefreshCw, Smile } from "lucide-react";
import EmptyState from "./EmptyState";
import { assetsApi } from "../api";
import type { AnchoredPopPos } from "../hooks/useAnchoredPop";

/** 一张可发送的表情：发送路径只需要 /media 地址与展示名（label 随消息入库）。 */
export type EmotePick = { url: string; label: string };

/** 拉取清单的页大小：选择器是「挑一张就发」的场景，不提供翻页；120 张覆盖绝大多数库。 */
const PICK_LIMIT = 120;

/**
 * composer 的表情选择弹层（portal 到 body，锚在触发钮上方）。
 *
 * 视觉与 model-pop / switch-pop 一族同语言：elevated 底、--radius-2xl、--shadow-menu、
 * menuIn 入场；定位交给宿主的 useAnchoredPop，这里只按传入坐标渲染（坐标未就绪时隐藏，
 * 避免首帧闪现在左下角）。退场（menuOut，与 menuIn 互为镜像）由宿主用 useExitVisible
 * 接管计时：本组件只消费 closing / onAnimationEnd 两个透传 prop 挂标记、防误触。
 *
 * 数据即表情库本身：view=emote 拉 /api/assets，失效项（missing）在发送层本来就会被拒，
 * 这里直接不列。拉取失败给 EmptyState 风格的空态 + 重试，不静默白板。
 *
 * 键盘：打开即聚焦第一格，↑↓←→ 在格间移动（列数按第一行的真实排布数从 DOM 数出来，
 * 网格是 auto-fill 自适应列，自己算宽度迟早和视觉错位）；Enter/空格原生触发点击即发送；
 * Esc 与点外部由宿主的 useDismiss 统一收口。Tab 顺序不拦——格子本来就该在 Tab 流里。
 */
export default function EmotePicker({ pos, onPick, closing = false, onAnimationEnd }: {
  pos: AnchoredPopPos | null;
  onPick: (pick: EmotePick) => void;
  /** 退场帧标记（宿主的 useExitVisible）：挂 data-closing 播 menuOut，并顺带防误触。 */
  closing?: boolean;
  /** 宿主透传的 animationend：menuOut 播完提前摘 portal，不等 240ms 兜底。 */
  onAnimationEnd?: (e: React.AnimationEvent<HTMLDivElement>) => void;
}): JSX.Element {
  /** null = 首拉进行中；[] 且 error 非空 = 失败；[] 且 error 为空 = 库真的是空的。 */
  const [items, setItems] = useState<EmotePick[] | null>(null);
  const [error, setError] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);

  const load = useCallback((): void => {
    setItems(null);
    setError("");
    assetsApi.listAssets({ view: "emote", kind: "image", limit: PICK_LIMIT, offset: 0 })
      .then((d) => {
        setItems(d.items
          .filter((a) => !a.missing)
          .map((a) => ({
            url: a.url,
            // 没认过名的图退回文件名：发出去总得有个说法，历史标记也不该是空串。
            label: a.emoteLabel !== "" ? a.emoteLabel : a.relPath.split("/").pop() ?? "表情",
          })));
      })
      .catch((e: Error) => {
        setError(e.message || "网络请求失败");
        setItems([]);
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  const ready = items !== null;
  useEffect(() => {
    if (!ready) return;
    // 焦点进弹层，方向键立刻可用；等一帧让网格先完成布局。
    const frame = requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const grid = gridRef.current;
    if (!grid) return;
    const btns = [...grid.querySelectorAll<HTMLButtonElement>("button")];
    const first = btns[0];
    if (!first) return;
    const at = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const cols = btns.findIndex((b) => b.offsetTop !== first.offsetTop);
    const colCount = Math.max(1, cols === -1 ? btns.length : cols);
    let next = at;
    if (e.key === "ArrowRight") next = at + 1;
    else if (e.key === "ArrowLeft") next = at - 1;
    else if (e.key === "ArrowDown") next = at + colCount;
    else if (e.key === "ArrowUp") next = at - colCount;
    else return;
    e.preventDefault();
    btns[Math.min(btns.length - 1, Math.max(0, next))]?.focus({ preventScroll: false });
  };

  return createPortal(
    <div className="emote-pop" role="dialog" aria-label="选择表情" data-keep-menu
      data-closing={closing || undefined} aria-hidden={closing || undefined}
      onAnimationEnd={onAnimationEnd}
      style={pos ? { left: pos.left, bottom: pos.bottom, width: pos.width } : { visibility: "hidden" }}>
      <div className="emote-pop-head">
        <span>表情</span>
        <small>点选即发送</small>
      </div>
      {items === null ? (
        <div className="emote-pop-state" role="status">
          <Loader2 size={15} className="spin" aria-hidden="true" />
          正在翻表情库…
        </div>
      ) : error !== "" ? (
        <EmptyState compact icon={<ImageOff size={20} strokeWidth={1.8} />}
          title="表情库没读到" hint={error}>
          <button type="button" className="btn sm" onClick={load}>
            <RefreshCw size={13} aria-hidden="true" /> 重试
          </button>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState compact icon={<Smile size={20} strokeWidth={1.8} />}
          title="表情库还是空的"
          hint="在 设置 → 媒体与表情 里导入几张并标记为表情，就能在这里直接发。" />
      ) : (
        <div ref={gridRef} className="emote-grid" onKeyDown={onGridKeyDown}>
          {items.map((it) => (
            <button key={it.url} type="button" className="emote-cell"
              title={it.label} aria-label={`发送表情：${it.label}`}
              tabIndex={closing ? -1 : undefined}
              onClick={() => onPick(it)}>
              <img src={it.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
