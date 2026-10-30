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
    return (
      <div
        role="alert"
        style={{
          position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center",
          justifyContent: "center", padding: "8%", boxSizing: "border-box",
          background: "var(--bg)", color: "var(--text)",
          fontFamily: "var(--font-body, sans-serif)",
        }}
      >
        <div style={{
          maxWidth: 460, width: "100%", padding: "24px 28px", borderRadius: 14,
          background: "var(--bg)", border: "1px solid var(--border)",
          boxShadow: "0 8px 40px rgba(0,0,0,.18)", textAlign: "center",
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            界面出了点小状况
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 18 }}>
            渲染中途崩了，已为你降级到这张卡片。先点「重试」，不行就「刷新页面」。
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={this.retry}
              style={{
                padding: "8px 18px", borderRadius: 9, border: "none", cursor: "pointer",
                background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 550,
              }}
            >
              重试
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 18px", borderRadius: 9, border: "1px solid var(--border)", cursor: "pointer",
                background: "transparent", color: "var(--text)", fontSize: 13, fontWeight: 550,
              }}
            >
              刷新页面
            </button>
          </div>
          <details style={{ marginTop: 20, textAlign: "left", color: "var(--text-muted)" }}>
            <summary style={{ fontSize: 12, cursor: "pointer", userSelect: "none" }}>出错详情（排障用）</summary>
            <pre style={{
              margin: "10px 0 0", padding: 10, borderRadius: 8, fontSize: 11, lineHeight: 1.5,
              background: "rgba(0,0,0,.06)", border: "1px solid var(--border)",
              whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 180, overflow: "auto",
            }}>{`message: ${message}${shortStack ? `\n\ncomponentStack:\n${shortStack}` : ""}`}</pre>
          </details>
        </div>
      </div>
    );
  }
}
