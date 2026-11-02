import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";
import type { MemorySpaceInventory, MemorySpaceSelection } from "../../types";

/** 同一个空间标识在控件与状态之间用字符串来回，避免对象比较带来的"看着没变却在重渲染"。 */
export function spaceKey(s: MemorySpaceSelection): string {
  if (s.kind === "conversation") return "c:" + s.conversationId;
  return s.kind;
}

function parseKey(key: string): MemorySpaceSelection {
  if (key.startsWith("c:")) return { kind: "conversation", conversationId: key.slice(2) };
  return key === "global" ? { kind: "global" } : { kind: "all" };
}

type SpaceOption = { key: string; label: string; count: number };

/** 可归属的空间：全局 / 私聊 / 每个群。「私聊」的名字由后端给，不拿联系人名冒充。 */
export function spaceOptions(inventory: MemorySpaceInventory): SpaceOption[] {
  return [
    { key: "global", label: "全局", count: inventory.global },
    {
      key: "c:" + inventory.private.conversationId,
      label: inventory.private.title || "私聊",
      count: inventory.private.count,
    },
    ...inventory.groups.map((g) => ({
      key: "c:" + g.conversationId,
      label: g.title + (g.left ? "（已离群）" : ""),
      count: g.count,
    })),
  ];
}

/**
 * 记忆空间选择器。
 *
 * mode="filter"：清单/记忆检查上方那个筛选，用一个下拉收着——群会越来越多，
 * 摊在工具栏上就是一面墙。
 * mode="target"：纠正弹窗里选目标空间。这里**不用下拉**：三五个值直接列出来，
 * 而且弹窗是 portal + 焦点陷阱，里面再叠一层绝对定位的浮层，既会被后续元素压住，
 * 也会跟着弹窗一起滚——列表就没有这些毛病，选完立刻看得见结果。
 *
 * 只有这位联系人真的有群时才出现「全局/私聊」以外的层级；一个群都没有的联系人，
 * 三个选项没有区别，摊开只会让人以为记忆真的分成了三堆。
 */
export default function MemorySpaceSelect({ inventory, value, onChange, mode = "filter" }: {
  inventory: MemorySpaceInventory | null;
  value: MemorySpaceSelection;
  onChange: (space: MemorySpaceSelection) => void;
  mode?: "filter" | "target";
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (inventory === null || inventory.groups.length === 0) return null;

  const options = spaceOptions(inventory);
  const current = spaceKey(value);

  if (mode === "target") {
    return (
      <div className="mem-space-list" role="listbox" aria-label="归属空间">
        {options.map((opt) => (
          <button key={opt.key} type="button" role="option" aria-selected={current === opt.key}
            className={"mem-space-row" + (current === opt.key ? " on" : "")}
            onClick={() => onChange(parseKey(opt.key))}>
            <Check size={13} className="mem-space-check" aria-hidden="true" />
            <span className="mem-space-name">{opt.label}</span>
            <span className="content-count">{opt.count}</span>
          </button>
        ))}
      </div>
    );
  }

  const total = options.reduce((n, o) => n + o.count, 0);
  const label = value.kind === "all" ? "全部空间" : options.find((o) => o.key === current)?.label ?? "全部空间";

  return (
    <div className="mem-space" ref={rootRef}>
      <button type="button" className={"chip mem-space-btn" + (current !== "all" ? " on" : "")}
        aria-expanded={open} aria-haspopup="listbox" aria-label="选择记忆空间"
        title="按这段对话的归属筛记忆；全局那条在所有对话里都能被想起"
        onClick={() => setOpen((v) => !v)}>
        <Layers size={13} aria-hidden="true" />
        {label}
        <span className="content-count">{total}</span>
        <ChevronDown size={12} className={"mem-space-caret" + (open ? " on" : "")} aria-hidden="true" />
      </button>
      {open && (
        <div className="mem-space-pop" role="listbox" aria-label="记忆空间列表">
          <button type="button" className={"mem-space-opt" + (current === "all" ? " on" : "")} onClick={() => { onChange({ kind: "all" }); setOpen(false); }}>
            <span className="mem-space-name">全部空间</span><span className="content-count">{total}</span>
          </button>
          {options.map((opt) => (
            <button key={opt.key} type="button" className={"mem-space-opt" + (current === opt.key ? " on" : "")}
              onClick={() => { onChange(parseKey(opt.key)); setOpen(false); }}>
              <span className="mem-space-name">{opt.label}</span>
              <span className="content-count">{opt.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
