/** 设备级界面偏好（localStorage 即存即生效，不进数据库——换设备不影响别人）。 */

export type ClockPref = "auto" | "always" | "off";

const CLOCK_KEY = "xiaomo.chatClock";

/** ChatView 监听它重建时间分隔（改偏好立刻重排，不用刷新）。 */
export const CLOCK_EVENT = "xiaomo:clock-pref";

/** 全局设置被"不进 useSettingsForm 快照的入口"改过（目前：导入模型档）。
 *  设置页自己的快照和资料页里那句「当前全局默认 N 轮」都听它，否则改完两处都停在旧值。 */
export const SETTINGS_CHANGED_EVENT = "xiaomo:settings-changed";
/** 数据被整库清空（恢复出厂设置 / 彻底删除联系人）：所有消息种子缓存当场作废。
 *  库是 DELETE 清的、AUTOINCREMENT 不复位，所以没有任何 id 变化能提示"这些行已经没了"。 */
export const DATA_WIPED_EVENT = "xiaomo:data-wiped";

export function getClockPref(): ClockPref {
  try {
    const v = localStorage.getItem(CLOCK_KEY);
    return v === "always" || v === "off" ? v : "auto";
  } catch { return "auto"; }
}

export function setClockPref(v: ClockPref): void {
  try {
    if (v === "auto") localStorage.removeItem(CLOCK_KEY);
    else localStorage.setItem(CLOCK_KEY, v);
  } catch { /* 无痕模式下存不进也不该炸 */ }
  window.dispatchEvent(new CustomEvent(CLOCK_EVENT));
}

const ACCENT_KEY = "xiaomo.accent";

/** 强调色（#rrggbb；空串 = 内置默认色，见 legacy.css 的 --accent）。
 *  真正的应用在 index.html 的主题引导脚本里。 */
export function getAccent(): string {
  try {
    const v = localStorage.getItem(ACCENT_KEY) || "";
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : "";
  } catch { return ""; }
}

export function setAccent(hex: string): void {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : "";
  try {
    if (clean) localStorage.setItem(ACCENT_KEY, clean);
    else localStorage.removeItem(ACCENT_KEY);
  } catch { /* 同上 */ }
  window.__setThemeAccent?.(clean);
}

/**
 * 管理面列表每页多少条：调用记录 / 处理单 / 记忆 / 主动性打算四处共用一个值。
 * 从前是 25、15、200、40 各写各的（还和后端默认值不一致），改一处要在四个界面里找。
 * 聊天的首屏窗口不在这里——那是"渲染多少条"不是"翻一页"，由服务端定。
 */
export const LIST_PAGE_SIZES = [25, 50, 100] as const;
export const LIST_PAGE_LABEL: Record<number, string> = { 25: "紧凑 25", 50: "标准 50", 100: "宽松 100" };

const LIST_PAGE_KEY = "xiaomo.listPage";

/** 翻列表的界面监听它重拉第一页（改完立刻换档，不用刷新）。 */
export const LIST_PAGE_EVENT = "xiaomo:list-page";

export function getListPageSize(): number {
  try {
    const n = Number(localStorage.getItem(LIST_PAGE_KEY));
    return (LIST_PAGE_SIZES as readonly number[]).includes(n) ? n : LIST_PAGE_SIZES[0];
  } catch { return LIST_PAGE_SIZES[0]; }
}

export function setListPageSize(n: number): void {
  const v = (LIST_PAGE_SIZES as readonly number[]).includes(n) ? n : LIST_PAGE_SIZES[0];
  try {
    if (v === LIST_PAGE_SIZES[0]) localStorage.removeItem(LIST_PAGE_KEY);
    else localStorage.setItem(LIST_PAGE_KEY, String(v));
  } catch { /* 同上 */ }
  window.dispatchEvent(new CustomEvent(LIST_PAGE_EVENT));
}

/**
 * 资料页「最近看的是哪个分区」，按联系人记：刚在「记忆」里删完几条，
 * 退出再进来不必重新点两下才回到那一屏。调用方（ProfileView）决定默认值。
 */
const PROFILE_PAGE_KEY = "xiaomo.profilePage";
const PROFILE_PAGES = ["persona", "settings", "memory", "proactive", "gallery"] as const;

export function getProfilePage(cid: string): string | null {
  try {
    const raw = localStorage.getItem(PROFILE_PAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    const v = map[cid];
    return v && (PROFILE_PAGES as readonly string[]).includes(v) ? v : null;
  } catch { return null; }
}

export function setProfilePage(cid: string, page: string): void {
  try {
    if (!(PROFILE_PAGES as readonly string[]).includes(page)) return;
    const map = JSON.parse(localStorage.getItem(PROFILE_PAGE_KEY) || "{}") as Record<string, string>;
    map[cid] = page;
    // 联系人可以删，条目不能只增：留下的是最近 40 位
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete map[k];
    localStorage.setItem(PROFILE_PAGE_KEY, JSON.stringify(map));
  } catch { /* 同上 */ }
}




/**
 * 主题风格：同一套骨架下的四套材质与配色。
 * warm 暖房（默认，赤陶 + 暖纸）/ classic 薄荷（旧观感）/ night 夜航 / paper 和纸。
 * 深浅色仍由 data-theme 单独管，两者正交——风格决定"什么材质"，明暗决定"开不开灯"。
 * 真正的应用在 index.html 的主题引导脚本里（首帧前），这里只管读写偏好。
 */
export type ThemeStyle = "warm" | "classic" | "night" | "paper";
export const THEME_STYLES: readonly ThemeStyle[] = ["warm", "classic", "night", "paper"];

const THEME_STYLE_KEY = "xiaomo.themeStyle";

export function getThemeStyle(): ThemeStyle {
  try {
    const v = localStorage.getItem(THEME_STYLE_KEY) || "";
    return (THEME_STYLES as readonly string[]).includes(v) ? (v as ThemeStyle) : "warm";
  } catch { return "warm"; }
}

export function setThemeStyle(style: ThemeStyle): void {
  try {
    if (style === "warm") localStorage.removeItem(THEME_STYLE_KEY);
    else localStorage.setItem(THEME_STYLE_KEY, style);
  } catch { /* 无痕模式下存不进也不该炸 */ }
  window.__setThemeStyle?.(style);
}
