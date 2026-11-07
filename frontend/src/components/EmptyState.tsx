import type { ReactNode } from "react";

/**
 * 全站统一空态。此前空状态有至少 9 种写法（.art-empty / .qq-conv-empty /
 * .chat-map-empty / .ch-empty / .model-pop-empty / .s-empty……）——密度、留白、
 * 是否带图标各不相同，跨页看是「不是一个应用」的观感。收成一个组件之后：
 * 新代码一律用它；旧写法在各自的迁移点顺手替换，替换完的类名随迁随删。
 *
 * 结构：图标（可选，装饰性）→ 主文案 → 补充说明（可选）→ 动作区（可选，放按钮）。
 * role=status：空态属于界面状态通报，读屏应该能主动听到主文案。
 */
export default function EmptyState({ icon, title, hint, children, compact = false }: {
  /** 装饰性图标（lucide 等），纯视觉，读屏跳过。 */
  icon?: ReactNode;
  /** 一句话说明「这里为什么是空的」。 */
  title: ReactNode;
  /** 补充说明或下一步指引（可多行）。 */
  hint?: ReactNode;
  /** 动作区：放主行动按钮（如「新建联系人」）。 */
  children?: ReactNode;
  /** 紧凑模式：下拉、卡片内等窄空间用，去掉大留白。 */
  compact?: boolean;
}): JSX.Element {
  return (
    <div className={"empty-state" + (compact ? " empty-state-compact" : "")} role="status">
      {icon ? <div className="empty-state-icon" aria-hidden="true">{icon}</div> : null}
      <div className="empty-state-title">{title}</div>
      {hint ? <div className="empty-state-hint">{hint}</div> : null}
      {children ? <div className="empty-state-actions">{children}</div> : null}
    </div>
  );
}
