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

/** 可选的强调色只为“个性化”，不改变页面材质。空串代表品牌默认赤陶。 */
export const ACCENT_PRESETS = [
  { hex: "", label: "赤陶" },
  { hex: "#22c55e", label: "薄荷" },
  { hex: "#2f6fed", label: "湖蓝" },
  { hex: "#6f5bd8", label: "紫罗兰" },
  { hex: "#3b9e8e", label: "青瓷" },
  { hex: "#d9821c", label: "琥珀" },
] as const;

/** 强调色（#rrggbb；空串 = 内置默认色，见 theme.css 的 --accent）。
 *  真正的应用在 index.html 的主题引导脚本里。 */
export function getAccent(): string {
  try {
    const v = localStorage.getItem(ACCENT_KEY) || "";
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "";
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
 * 旧版“主题风格”已下线。迁移策略只保留用户当时最有感知的强调色：
 * 薄荷/夜航/和纸分别落到对应色，暖房回到品牌默认赤陶；页面材质统一。
 * 壁纸、玻璃与透明度偏好完全不在这里改动。
 */
const LEGACY_THEME_STYLE_KEY = "xiaomo.themeStyle";
const LEGACY_STYLE_ACCENT: Record<string, string> = {
  classic: "#22c55e",
  night: "#d9821c",
  paper: "#2f6fed",
};

export function migrateAppearancePrefs(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_THEME_STYLE_KEY) || "";
    if (!legacy) return;
    if (!localStorage.getItem(ACCENT_KEY) && LEGACY_STYLE_ACCENT[legacy]) {
      localStorage.setItem(ACCENT_KEY, LEGACY_STYLE_ACCENT[legacy]);
    }
    localStorage.removeItem(LEGACY_THEME_STYLE_KEY);
    document.documentElement.removeAttribute("data-theme-style");
  } catch { /* 存储不可用时保持默认外观 */ }
}

/**
 * 壁纸：设备级偏好（同主题一套逻辑）。kind 决定形态——
 * none 关闭（回到主题自带的场景光）/ preset 内置预设（纯 CSS，零素材）/ media 自定义（/media 的图或视频）。
 * 预设清单在 lib/wallpaper.ts（渲染与 CSS 都在那边），这里只管读写偏好。
 */
export type WallpaperKind = "none" | "preset" | "media";

export type WallpaperPref = {
  kind: WallpaperKind;
  preset: string;
  url: string;
  /** 界面透明度 0–80（%）：越大界面各表面越透、壁纸露得越多。0 = 完全不透明（等于看不见壁纸）。 */
  surface: number;
};

export const DEFAULT_WALLPAPER: WallpaperPref = { kind: "none", preset: "", url: "", surface: 45 };

const WALLPAPER_KEY = "xiaomo.wallpaper";

/** 壁纸偏好被改（lib/wallpaper.ts 监听它重建壁纸层，不用刷新）。 */
export const WALLPAPER_EVENT = "xiaomo:wallpaper-pref";

function clampSurface(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(80, Math.round(n))) : 26;
}

export function getWallpaper(): WallpaperPref {
  try {
    const raw = localStorage.getItem(WALLPAPER_KEY);
    if (!raw) return DEFAULT_WALLPAPER;
    const d = JSON.parse(raw) as Partial<WallpaperPref>;
    const kind: WallpaperKind = d.kind === "preset" || d.kind === "media" ? d.kind : "none";
    return {
      kind,
      preset: typeof d.preset === "string" ? d.preset : "",
      url: typeof d.url === "string" && d.url.startsWith("/media/") ? d.url : "",
      surface: clampSurface(Number(d.surface)),
    };
  } catch { return DEFAULT_WALLPAPER; }
}

export function setWallpaper(pref: WallpaperPref): void {
  const clean: WallpaperPref = {
    kind: pref.kind,
    preset: typeof pref.preset === "string" ? pref.preset : "",
    url: typeof pref.url === "string" && pref.url.startsWith("/media/") ? pref.url : "",
    surface: clampSurface(pref.surface),
  };
  try {
    if (clean.kind === "none" && !clean.preset && !clean.url && clean.surface === 45) {
      localStorage.removeItem(WALLPAPER_KEY);
    } else {
      localStorage.setItem(WALLPAPER_KEY, JSON.stringify(clean));
    }
  } catch { /* 同上 */ }
  window.dispatchEvent(new CustomEvent(WALLPAPER_EVENT));
}

/* ── 我的壁纸（收藏）────────────────────────────────────────────
   上传过的壁纸文件都留在盘上（/media 的 wp 前缀文件），收藏清单记在本设备——
   换壁纸是在收藏里切换，不是覆盖；不喜欢的再删（连文件一起删）。 */

export type WallpaperItem = { url: string; addedAt: number };

const WALLPAPER_LIB_KEY = "xiaomo.wallpaperLib";
const WALLPAPER_LIB_MAX = 20;

/** 收藏被增删（设置页自己监听即可，别的组件不关心）。 */
export const WALLPAPER_LIB_EVENT = "xiaomo:wallpaper-lib";

export function getWallpaperLibrary(): WallpaperItem[] {
  try {
    const raw = localStorage.getItem(WALLPAPER_LIB_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is WallpaperItem => {
        const it = x as WallpaperItem;
        return typeof it?.url === "string" && it.url.startsWith("/media/") && typeof it?.addedAt === "number";
      })
      .sort((a, b) => b.addedAt - a.addedAt);
  } catch { return []; }
}

export function addWallpaperLibraryItem(url: string): void {
  const clean = typeof url === "string" && url.startsWith("/media/") ? url : "";
  if (!clean) return;
  const list = getWallpaperLibrary().filter((x) => x.url !== clean);
  list.unshift({ url: clean, addedAt: Date.now() });
  try {
    localStorage.setItem(WALLPAPER_LIB_KEY, JSON.stringify(list.slice(0, WALLPAPER_LIB_MAX)));
  } catch { /* 同上 */ }
  window.dispatchEvent(new CustomEvent(WALLPAPER_LIB_EVENT));
}

export function removeWallpaperLibraryItem(url: string): void {
  try {
    const list = getWallpaperLibrary().filter((x) => x.url !== url);
    localStorage.setItem(WALLPAPER_LIB_KEY, JSON.stringify(list));
  } catch { /* 同上 */ }
  window.dispatchEvent(new CustomEvent(WALLPAPER_LIB_EVENT));
}

/* 玻璃拟态已并入壁纸适配：壁纸开着 = data-glass 自动生效（lib/wallpaper.ts 管理），
   不再是独立偏好。旧的 xiaomo.glass 键留在存储里无人读取，无副作用。 */

