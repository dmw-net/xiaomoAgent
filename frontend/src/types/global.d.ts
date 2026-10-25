declare global {
  /** Vite define 注入：根 package.json 的版本号。 */
  const __APP_VERSION__: string;

  interface Window {
    /** index.html 内联的主题引导脚本提供：切换主题（system/light/dark）。 */
    __setThemeMode?: (mode: "system" | "light" | "dark") => void;
    /** 同上：套用自定义强调色（#rrggbb；空串 = 跟随当前主题的默认色）。 */
    __setThemeAccent?: (hex: string) => void;
    /** 同上：按持久化偏好重算明暗（壁纸开/关后由 lib/wallpaper.ts 调用，壁纸模式强制暗底）。 */
    __refreshTheme?: () => void;
    /** 同上：玻璃表面开关（挂/摘 html[data-glass]）——壁纸适配的一部分，跟着壁纸走。 */
    __setGlass?: (on: boolean) => void;
    /** lib/wallpaper.ts 提供：按最新偏好重建壁纸层（引导脚本只做首帧那份）。 */
    __applyWallpaper?: () => void;
  }
}

export {};
