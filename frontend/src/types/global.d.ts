declare global {
  /** Vite define 注入：根 package.json 的版本号。 */
  const __APP_VERSION__: string;

  interface Window {
    /** index.html 内联的主题引导脚本提供：切换主题（system/light/dark）。 */
    __setThemeMode?: (mode: "system" | "light" | "dark") => void;
    /** 同上：套用自定义强调色（#rrggbb；空串 = 跟随当前主题的默认色）。 */
    __setThemeAccent?: (hex: string) => void;
    /** 同上：切换主题风格（warm / classic / night / paper）。 */
    __setThemeStyle?: (style: "warm" | "classic" | "night" | "paper") => void;
  }
}

export {};
