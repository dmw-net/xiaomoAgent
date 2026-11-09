import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImageOff, Loader2, RefreshCw, Smile } from "lucide-react";
import EmptyState from "./EmptyState";
import { assetsApi, type EmotePackCount } from "../api";
import type { AnchoredPopPos } from "../hooks/useAnchoredPop";

/** 一张可发送的表情：发送路径只需要 /media 地址与展示名（label 随消息入库）。 */
export type EmotePick = { url: string; label: string };

/** 拉取清单的页大小：选择器是「挑一张就发」的场景，不提供翻页；120 张覆盖绝大多数库。 */
const PICK_LIMIT = 120;

/** 记住上次逛的文件夹（设备级偏好）。文件夹被删/改名时拉到清单后校验回退，不持久化脏值。 */
const LS_PACK = "xiaomo.emotePack";

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
 * 文件夹分类：库里多于一个文件夹时，头行下出一排 chip（全部 + 各文件夹 + 计数），点选带 pack=
 * 重拉——后端本来就认这个参数（设置页媒体库同款），列表永远全量返回 packs，chip 行不随筛选变。
 * 上次逛的文件夹记进 localStorage（LS_PACK），下次打开直接落在那；文件夹没了就回「全部」。
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
  /** 文件夹清单（全库口径，不随当前筛选变）：chip 行从这渲染，被删的文件夹也在这认出来。 */
  const [packs, setPacks] = useState<EmotePackCount[]>([]);
  /** 当前文件夹（"" = 全部）。上次的选择从 localStorage 起步，拉到清单后校验。 */
  const [pack, setPack] = useState(() => localStorage.getItem(LS_PACK) ?? "");
  const gridRef = useRef<HTMLDivElement>(null);
  /** 请求序号：连着点两个文件夹时，先发的慢响应不许盖掉后发的。 */
  const seqRef = useRef(0);

  const load = useCallback((): void => {
    const seq = ++seqRef.current;
    setItems(null);
    setError("");
    assetsApi.listAssets({ view: "emote", kind: "image", pack, limit: PICK_LIMIT, offset: 0 })
      .then((d) => {
        if (seq !== seqRef.current) return;
        setPacks(d.packs);
        // 起步时恢复的文件夹可能已经不在库里（被删/改名）：退回「全部」并清掉脏值，
        // items 留在 null（转圈），effect 会带着新 pack 重拉一次。
        if (pack !== "" && !d.packs.some((p) => p.pack === pack)) {
          localStorage.removeItem(LS_PACK);
          setPack("");
          return;
        }
        setItems(d.items
          .filter((a) => !a.missing)
          .map((a) => ({
            url: a.url,
            // 没认过名的图退回文件名：发出去总得有个说法，历史标记也不该是空串。
            label: a.emoteLabel !== "" ? a.emoteLabel : a.relPath.split("/").pop() ?? "表情",
          })));
      })
      .catch((e: Error) => {
        if (seq !== seqRef.current) return;
        setError(e.message || "网络请求失败");
        setItems([]);
      });
  }, [pack]);
  useEffect(() => { load(); }, [load]);

  /** 换文件夹：选中即请求 + 记住选择；连点同一个不动（也免了一次多余请求）。 */
  const pickPack = (next: string): void => {
    if (next === pack) return;
    if (next === "") localStorage.removeItem(LS_PACK);
    else localStorage.setItem(LS_PACK, next);
    setPack(next);
  };

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
      {/* 文件夹分类：只有一个桶（全是「默认」）时整行不渲染——单包用户不需要在「全部/默认」里二选一。
          交互与用量页维度 chips 同语言（radiogroup + aria-checked），计数是全库口径，不随筛选变。 */}
      {packs.length > 1 && (
        <div className="emote-pop-packs" role="radiogroup" aria-label="表情文件夹">
          <button type="button" role="radio" aria-checked={pack === ""}
            className={"emote-pack-chip" + (pack === "" ? " on" : "")}
            tabIndex={closing ? -1 : undefined}
            title={`全部：${packs.reduce((n, p) => n + p.total, 0)} 张`}
            onClick={() => pickPack("")}>
            全部
            <span className="emote-chip-count">{packs.reduce((n, p) => n + p.total, 0)}</span>
          </button>
          {packs.map((p) => (
            <button key={p.pack} type="button" role="radio" aria-checked={pack === p.pack}
              className={"emote-pack-chip" + (pack === p.pack ? " on" : "")}
              tabIndex={closing ? -1 : undefined}
              title={`${p.pack}：${p.total} 张`}
              onClick={() => pickPack(p.pack)}>
              {p.pack}
              <span className="emote-chip-count">{p.total}</span>
            </button>
          ))}
        </div>
      )}
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
        pack === "" ? (
          <EmptyState compact icon={<Smile size={20} strokeWidth={1.8} />}
            title="表情库还是空的"
            hint="在 设置 → 媒体与表情 里导入几张并标记为表情，就能在这里直接发。" />
        ) : (
          // 走到这说明文件夹还在、只是没有可发的（图都失效了或确实还没导进来）；
          // 「文件夹被删」的情况在响应校验那已经自动退回「全部」了。
          <EmptyState compact icon={<Smile size={20} strokeWidth={1.8} />}
            title="这个文件夹没有可发的"
            hint="图片可能已失效，或者还没往这一夹导东西。">
            <button type="button" className="btn sm" onClick={() => pickPack("")}>
              看全部
            </button>
          </EmptyState>
        )
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
