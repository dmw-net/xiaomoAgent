// 根错误边界：兜住整棵 React 树的渲染期崩溃。
//
// 为什么要这一道：项目里没有任何 error boundary——任何组件 render 抛错
// （比如某次数据没到就调 `.find`/`.map`，见 ThreadChip 白屏那次）都会把
// 整棵 React 树拖垮，界面直接白屏，用户只看到"打不开了"，无从下手。
// 有了它：崩了只显示一张卡片 + 两个按钮（重试 / 刷新），并保留最近一份
// 错误打到 console，既不再白屏，也给排障留了线索。
//
// 只做两件事：捕获、降级。不静默吞——控制台一定留痕，方便"顶级"级别地定位。

import { Component, type ErrorInfo, type ReactNode } from "react";

/** 最近一次被兜住的错误（模块级单例），状态页/诊断可再取。 */
export interface LastCaughtError {
  message: string;
  stack: string;
  at: string;
}
let lastCaught: LastCaughtError | null = null;
export function getLastCaughtError(): LastCaughtError | null {
  return lastCaught;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}
interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 兜住子树渲染期异常的根级边界。
 * "重试"= 清掉错误态、让子树重新挂载；仍崩则再次被兜住（并保留最近一份）。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    lastCaught = { message: error.message, stack: info.componentStack ?? "", at: new Date().toISOString() };
    console.error("[ErrorBoundary] 界面渲染崩了，已降级：", error, info.componentStack);
  }

  private retry = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    const shortStack = lastCaught?.stack ?? "";
    // 降级卡片同样只消费主题令牌，明暗两主题下底色、阴影、文字都成立。
    // 字号走 --text-* 档位。
    return (
      <div
        role="alert"
        style={{
          position: "fixed", inset: 0, zIndex: "var(--z-error, 200)", display: "flex", alignItems: "center",
          justifyContent: "center", padding: "8%", boxSizing: "border-box",
          background: "var(--bg, #f4f2ed)", color: "var(--text, #201d18)",
          fontFamily: "var(--font-body, sans-serif)",
        }}
      >
        <div style={{
          maxWidth: 460, width: "100%", padding: "var(--space-10, 24px) var(--space-8, 20px)", borderRadius: "var(--radius-xl, 16px)",
          background: "var(--bg-elevated, #fffefb)", border: "1px solid var(--border, #dfdad0)",
          boxShadow: "var(--shadow-card)", textAlign: "center",
        }}>
          <div style={{ fontSize: "var(--text-lg, 15px)", fontWeight: 600, marginBottom: "var(--space-2, 8px)" }}>
            界面出了点小状况
          </div>
          <div style={{ fontSize: "var(--text-note, 13px)", color: "var(--text-muted)", lineHeight: 1.6, marginBottom: "var(--space-6, 16px)" }}>
            渲染中途崩了，已为你降级到这张卡片。先点「重试」，不行就「刷新页面」。
          </div>
          <div style={{ display: "flex", gap: "var(--space-3, 8px)", justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={this.retry}
              style={{
                padding: "var(--space-2, 8px) var(--space-6, 16px)", borderRadius: "var(--radius-md, 10px)",
                border: "none", cursor: "pointer", minHeight: "var(--tap-min, 32px)",
                background: "var(--accent, #a64b2f)", color: "var(--accent-text, #fff)", fontSize: "var(--text-base, 13px)", fontWeight: 600,
              }}
            >
              重试
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "var(--space-2, 8px) var(--space-6, 16px)", borderRadius: "var(--radius-md, 10px)",
                border: "1px solid var(--border, #dfdad0)", cursor: "pointer", minHeight: "var(--tap-min, 32px)",
                background: "transparent", color: "var(--text, #201d18)", fontSize: "var(--text-base, 13px)", fontWeight: 600,
              }}
            >
              刷新页面
            </button>
          </div>
          <details style={{ marginTop: "var(--space-8, 20px)", textAlign: "left", color: "var(--text-muted)" }}>
            <summary style={{ fontSize: "var(--text-sm, 12px)", cursor: "pointer", userSelect: "none" }}>出错详情（排障用）</summary>
            <pre style={{
              margin: "var(--space-3, 8px) 0 0", padding: "var(--space-3, 8px)", borderRadius: "var(--radius-sm, 6px)",
              fontSize: "var(--text-xs, 11px)", lineHeight: 1.5,
              background: "var(--bg-sunken, #ebe8e1)", border: "1px solid var(--border, #dfdad0)",
              whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 180, overflow: "auto",
            }}>{`message: ${message}${shortStack ? `\n\ncomponentStack:\n${shortStack}` : ""}`}</pre>
          </details>
        </div>
      </div>
    );
  }
}
