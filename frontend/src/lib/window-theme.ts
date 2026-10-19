/**
 * 把页面主题同步给 Tauri 原生窗口。
 *
 * prefers-color-scheme / html[data-theme] 只影响 WebView 内容，Windows 原生标题栏
 * 不会自动跟着变；不显式调用 setTheme 时，应用切到深色后标题栏仍可能是白色。
 */
export function startNativeWindowThemeSync(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;

  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    const sync = (): void => {
      const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      void win.setTheme(theme).catch(() => {});
    };

    sync();
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }).catch(() => {});
}
