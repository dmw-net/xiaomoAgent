import { useEffect, useState } from "react";
import { MessageCircleMore, Sparkles, Activity, Settings, Menu } from "lucide-react";
import { useDismiss } from "../hooks/useDismiss";
import type { ThemeMode, ViewKey } from "../types";

const NAV: Array<{ key: ViewKey; label: string; icon: JSX.Element }> = [
  { key: "chat", label: "对话", icon: <MessageCircleMore size={20} strokeWidth={1.8} /> },
  { key: "status", label: "状态", icon: <Activity size={20} strokeWidth={1.8} /> },
  { key: "settings", label: "设置", icon: <Settings size={20} strokeWidth={1.8} /> },
];

/** 当前主题档（供菜单高亮）。 */
function currentMode(): ThemeMode {
  return (document.documentElement.getAttribute("data-theme-mode") as ThemeMode) || "system";
}

export default function Rail({ active, onNavigate, onPrefetch, ownerName, ownerAvatar, onAbout, onOnboarding, onOpenProfilePage, onOpenAssistant, unreadChat = 0 }: {
  active: string;
  onNavigate: (key: ViewKey) => void;
  /** 鼠标悬停或键盘聚焦时提前取回懒加载页面，正式点击不再等 chunk。 */
  onPrefetch?: (key: ViewKey) => void;
  ownerName: string;
  ownerAvatar: string;
  onAbout: () => void;
  /** 重新打开首次设置：弹过一次「稍后设置」之后必须还有门，不然引导只有一条命。 */
  onOnboarding: () => void;
  /** 点自己的头像：直达设置页「全局用户资料」tab（微信式——点头像进个人资料）。 */
  onOpenProfilePage: () => void;
  /** 召唤内置设置助手；窄屏复用同一颗按钮放进底部导航，不另做悬浮入口。 */
  onOpenAssistant: () => void;
  /** 全应用未读消息数：>0 时「对话」图标挂红点。 */
  unreadChat?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(currentMode);

  // 跟随系统时监听系统切换，保持高亮正确（与旧 theme-switch.js 行为一致）
  useDismiss(open, () => setOpen(false));
  useEffect(() => {
    const paint = (): void => setMode(currentMode());
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
      return () => window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", paint);
    } catch { return undefined; }
  }, []);

  const pick = (m: ThemeMode): void => {
    window.__setThemeMode?.(m);
    setMode(currentMode());
  };

  const initial = (ownerName || "我").slice(0, 1);

  return (
    <nav id="rail">
      {/* 微信式：点头像直达个人资料页（头像上传也在那里） */}
      <button
        type="button"
        className={"brand" + (ownerAvatar ? " has-img" : "")}
        id="myAvatar"
        title={(ownerName || "我") + " · 我的资料"}
        aria-label="我的资料"
        onClick={() => { onOpenProfilePage(); setOpen(false); }}
      >
        {ownerAvatar ? <img src={ownerAvatar} alt="" /> : initial}
      </button>
      {NAV.map((item) => (
        <button
          key={item.key}
          type="button"
          className={"rbtn" + (active === item.key ? " active" : "")}
          data-view={item.key}
          title={item.label}
          aria-label={item.label}
          aria-current={active === item.key ? "true" : undefined}
          onClick={() => { onNavigate(item.key); }}
          onMouseEnter={() => onPrefetch?.(item.key)}
          onFocus={() => onPrefetch?.(item.key)}
        >
          {item.icon}
          {item.key === "chat" && unreadChat > 0 && <span className="rbtn-dot" aria-label={unreadChat + " 条未读"}>{unreadChat > 99 ? "99+" : unreadChat}</span>}
        </button>
      ))}
      <div className="spacer" />
      <button type="button" className="rbtn rail-asst" id="railAsstBtn"
        title="问助手 · 配置与排查" aria-label="问助手" aria-haspopup="dialog"
        onClick={() => { onOpenAssistant(); }}>
        <Sparkles size={20} strokeWidth={1.8} />
      </button>
      <div className="rail-menu-wrap">
        <button
          type="button"
          className="rbtn"
          id="railMenuBtn"
          title="更多"
          aria-label="更多"
          aria-haspopup="menu" aria-expanded={open ? "true" : "false"}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <Menu size={20} strokeWidth={1.8} />
        </button>
        {open && (
          <div className="rail-menu" id="railMenu" data-keep-menu>
            <div className="menu-label">主题</div>
            <div className="menu-theme" role="group" aria-label="主题">
              {(["system", "light", "dark"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m ? "true" : "false"} onClick={() => pick(m)}>
                  {m === "system" ? "跟随系统" : m === "light" ? "亮色" : "暗色"}
                </button>
              ))}
            </div>
            <div className="menu-sep" />
            <button type="button" className="menu-item" onClick={() => { setOpen(false); onOnboarding(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M14.8 9.2 13 13l-3.8 1.8L11 11z" /></svg>
              <span>首次设置</span>
            </button>
            <button type="button" className="menu-item" onClick={() => { setOpen(false); onNavigate("settings"); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>
              <span>设置</span>
            </button>
            <button type="button" className="menu-item" onClick={() => { setOpen(false); onAbout(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
              <span>关于小茉</span>
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
