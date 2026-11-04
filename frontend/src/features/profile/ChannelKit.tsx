import type { ReactNode } from "react";
import { Check, CircleAlert, Info, TriangleAlert, CircleCheck } from "lucide-react";

/**
 * 连接卡共享件（微信 / QQ 两张卡同一套状态语言）：
 * 徽章讲「现在什么状态」、提示条讲「发生了什么」、步骤条讲「接下来点哪里」。
 * 只管呈现，不碰任何数据与轮询逻辑。
 */

/** 徽章语义色：ok=在跑、warn=要人处理、busy=过渡态（可带呼吸点）、muted=停/未配。 */
export type ChannelTone = "ok" | "warn" | "busy" | "muted";

const TONE_CLASS: Record<ChannelTone, string> = {
  ok: "ch-badge-ok",
  warn: "ch-badge-warn",
  busy: "ch-badge-busy",
  muted: "ch-badge-muted",
};

/** 状态胶囊：一枚语义色圆点 + 文案。卡头的「状态」就该一眼可辨，而不是靠读小字。 */
export function ChannelBadge({ tone, label, title }: { tone: ChannelTone; label: string; title?: string }): JSX.Element {
  return (
    <span className={"ch-badge " + TONE_CLASS[tone]} title={title}>
      <span className="ch-badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

type NoteTone = "info" | "success" | "warn" | "error";
const NOTE_ICON: Record<NoteTone, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  error: CircleAlert,
};

/**
 * 提示条：从前 wx-note / wx-error / hint 三种裸文本混排，轻重不分、来源不明。
 * 收成四种语义态，各带一枚图标——人扫一眼颜色和图标就知道这条在说什么事。
 */
export function ChannelNote({ tone = "info", children }: { tone?: NoteTone; children: ReactNode }): JSX.Element {
  const Icon = NOTE_ICON[tone];
  return (
    <div className={"ch-note ch-note-" + tone} role={tone === "error" ? "alert" : "status"}>
      <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** 步骤条单行：done=已完成（✓）、current=当前这步（实心点 + 高亮）、todo=还没到（空心圈）。 */
export type ChannelStep = { label: string; state: "done" | "current" | "todo"; hint?: string; action?: ReactNode };

/**
 * 纵向步骤条：QQ 官方（创建机器人 → 绑定你的 QQ）与 OneBot（装 → 启动 → 扫码 → 绑号）
 * 都是多步流程，从前靠条件渲染的碎片拼出来，人不知道自己走到第几步。
 */
export function ChannelSteps({ steps, label }: { steps: ChannelStep[]; label: string }): JSX.Element {
  return (
    <ol className="ch-steps" aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.label} className={"ch-step ch-step-" + s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="ch-step-rail" aria-hidden="true">
            <span className="ch-step-marker">
              {s.state === "done" ? <Check size={11} strokeWidth={2.6} /> : <span className="ch-step-core" />}
            </span>
            {i < steps.length - 1 && <span className="ch-step-line" />}
          </span>
          <span className="ch-step-copy">
            <b>{s.label}</b>
            {s.hint && <small>{s.hint}</small>}
          </span>
          {s.action && <span className="ch-step-action">{s.action}</span>}
        </li>
      ))}
    </ol>
  );
}
