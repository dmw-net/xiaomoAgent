/**
 * 壁纸层：一个 position:fixed 的全屏 div，压在所有界面之下。
 * 首帧那份由 index.html 的引导脚本建（防闪变）；React 起来后这里接管重建，
 * 之后偏好一变就整层重画，不需要任何组件参与。
 *
 * 内置预设只有一款「星空流星」，全是 CSS：星空是两层视差点阵闪烁，
 * 流星是独立子层的多道渐变光痕（transform 动画，不进主合成树反复光栅化）。
 * 自定义走 /media 的 wp 前缀文件（图片 <img>、视频 <video>），加载失败静默回退无壁纸——
 * 换设备恢复备份后文件可能不在了，不能因此白屏。
 *
 * 壁纸模式（第三种形态）：壁纸开着 = 界面自动进入壁纸适配——
 * 玻璃表面常开（data-glass 跟着壁纸走，不再是独立开关）、
 * 明暗固定为壁纸专属的暗色基底（index.html 的 apply 里裁决，浅色/深色偏好原样保留）。
 * 关掉壁纸，两样都自动还原。
 */

import { getWallpaper, WALLPAPER_EVENT, type WallpaperPref } from "./ui-prefs";

export type WallpaperPreset = {
  id: string;
  label: string;
  /** 选择器缩略图兜底色（星空的动图预览由 CSS 按	id 画，其他预设先用色斑）。 */
  swatch: string;
};

export const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  { id: "starry", label: "星空流星", swatch: "linear-gradient(180deg,#0b1026,#25224e 60%,#3d3564)" },
];

export function wallpaperPreset(id: string): WallpaperPreset | null {
  return WALLPAPER_PRESETS.find((p) => p.id === id) ?? null;
}

const LAYER_ID = "wp-layer";
/** 流星数量与 foundation.css 的 nth-child 规格、index.html 的首帧副本保持一致。 */
const STARRY_METEOR_COUNT = 14;
/** 当前壁纸里的视频（若有）：页面藏进后台时暂停，回前台继续——别让用户看不见的动画吃电。 */
let activeVideo: HTMLVideoElement | null = null;
const DEFAULT_TINT = "hsl(250 12% 15%)";
const PRESET_TINTS: Record<string, string> = {
  starry: "hsl(250 26% 16%)",
};
/** 异步取色时用它丢弃已经切走的那张壁纸的结果。 */
let tintToken = 0;

function removeLayer(): void {
  document.getElementById(LAYER_ID)?.remove();
  activeVideo = null;
}

function setWallpaperTint(color: string): void {
  document.documentElement.style.setProperty("--wp-tint", color);
}

/**
 * 从壁纸里取一个「低饱和深色」作为玻璃底色。
 * 不是做完整调色板：只保留色相，把亮度压到适合白字的范围，所以结果稳定、可预测，
 * 也不会因为壁纸里恰好有一块高饱和图案而把整个界面染花。
 */
function sampleWallpaperTint(source: CanvasImageSource): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, 32, 32);
    const { data } = ctx.getImageData(0, 0, 32, 32);
    let x = 0;
    let y = 0;
    let weight = 0;
    let luma = 0;
    let saturation = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // 跳过纯白/纯黑；给有彩色像素更高权重，避免大面积白底把色相拉回灰色。
      if (max < 20 || min > 245) continue;
      const sat = max === 0 ? 0 : (max - min) / max;
      const w = 0.15 + sat * sat;
      let hue = 0;
      if (max === min) hue = 0;
      else if (max === r) hue = (60 * (g - b)) / (max - min);
      else if (max === g) hue = 60 * (b - r) / (max - min) + 120;
      else hue = 60 * (r - g) / (max - min) + 240;
      const rad = hue * Math.PI / 180;
      x += Math.cos(rad) * w;
      y += Math.sin(rad) * w;
      luma += (0.2126 * r + 0.7152 * g + 0.0722 * b) * w;
      saturation += sat * w;
      weight += w;
    }
    if (weight < 20) return null;
    const hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const sat = Math.min(34, Math.max(10, (saturation / weight) * 85));
    const light = Math.min(19, Math.max(13, 13 + (luma / weight / 255) * 6));
    return `hsl(${Math.round(hue)} ${Math.round(sat)}% ${Math.round(light)}%)`;
  } catch {
    return null;
  }
}

function buildPreset(pref: WallpaperPref): HTMLElement {
  const layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.setAttribute("aria-hidden", "true");
  layer.dataset.wp = pref.preset;
  // 噪点：渐变在低色深屏上有可见条带，一层碎点把台阶打断
  const noise = document.createElement("div");
  noise.className = "wp-noise";
  layer.appendChild(noise);
  // 星空：两层视差点阵（::before/::after 各一层，元素本身是空壳）——与 index.html 引导脚本保持同构
  const stars = document.createElement("div");
  stars.className = "wp-stars";
  layer.appendChild(stars);
  // 流星：十四道子光痕分成近景/中景/远景，CSS 按 nth-child 给出各自的轨迹与节奏。
  const meteors = document.createElement("div");
  meteors.className = "wp-meteors";
  for (let i = 0; i < STARRY_METEOR_COUNT; i += 1) {
    const meteor = document.createElement("span");
    meteor.className = "wp-meteor";
    meteors.appendChild(meteor);
  }
  layer.appendChild(meteors);
  return layer;
}

function buildMedia(pref: WallpaperPref, token: number): HTMLElement {
  const layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.setAttribute("aria-hidden", "true");
  layer.dataset.wpMedia = "1";
  const isVideo = /\.(mp4|webm)$/i.test(pref.url);
  let video: HTMLVideoElement | null = null;
  let img: HTMLImageElement | null = null;
  let media: HTMLVideoElement | HTMLImageElement;
  if (isVideo) {
    video = document.createElement("video");
    video.src = pref.url;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.setAttribute("playsinline", "");
    activeVideo = video;
    media = video;
  } else {
    img = document.createElement("img");
    img.src = pref.url;
    img.alt = "";
    media = img;
  }
  media.className = "wp-media";
  media.setAttribute("aria-hidden", "true");
  const readTint = (): void => {
    const tint = sampleWallpaperTint(media);
    if (tint && token === tintToken) setWallpaperTint(tint);
  };
  if (video) {
    if (video.readyState >= 2) queueMicrotask(readTint);
    else video.addEventListener("loadeddata", readTint, { once: true });
  } else if (img) {
    if (img.complete && img.naturalWidth > 0) queueMicrotask(readTint);
    else img.addEventListener("load", readTint, { once: true });
  }
  // 文件没了（换设备恢复、清数据）就退回无壁纸，别留着一块黑布
  media.addEventListener("error", () => {
    removeLayer();
    delete document.documentElement.dataset.wallpaper;
    window.__setGlass?.(false);
    window.__refreshTheme?.();
  });
  layer.appendChild(media);
  return layer;
}

/**
 * 把「界面透明度」换算成玻璃模式的 CSS 变量。透明度只在壁纸开启时生效，
 * 这里算的是玻璃表面的不透明度：内容区最透、Rail/侧栏与弹窗略实、卡片略实。
 * 各档都有保底——玻璃靠 blur + 适度压暗提供对比度，底太透时文字会压在高频壁纹上救不回来。
 */
function applySurfaceVars(surface: number): void {
  const root = document.documentElement.style;
  // 0 仍然是完全不透明，45 左右刚好让壁纸参与构图，80 则接近真正的薄玻璃。
  // 从前 45 就落在 69% 左右，所有表面叠起来像深色塑料；线性下探后，默认档
  // 的 wash 约 53%，再由方向光与顶缘高光维持层级，而不是靠把底压黑。
  const gw = Math.max(42, 100 - surface * 1.05);
  const chrome = Math.min(96, Math.max(46, gw + 4));
  root.setProperty("--wp-glass-wash", `${gw}%`);
  root.setProperty("--wp-glass-chrome", `${chrome}%`);
  root.setProperty("--wp-glass-card", `${Math.min(94, Math.max(50, gw + 6))}%`);
  // 弹窗下面永远垫着遮罩（暗色 scrim）：底太透时遮罩会隔着卡片透出来，
  // 整个弹窗看着像被一起压暗——弹窗是当前唯一该"亮"的表面，保底必须比内容区高一档。
  root.setProperty("--wp-glass-modal", `${Math.min(96, Math.max(86, gw + 28))}%`);
}

function clearSurfaceVars(): void {
  const root = document.documentElement.style;
  for (const v of ["--wp-glass-wash", "--wp-glass-chrome", "--wp-glass-card", "--wp-glass-modal"]) {
    root.removeProperty(v);
  }
}

/** 按当前偏好重建壁纸层。挂到 window.__applyWallpaper 供偏好写入方调用。 */
export function applyWallpaper(): void {
  const pref = getWallpaper();
  const token = ++tintToken;
  removeLayer();
  const root = document.documentElement;
  const on = pref.kind !== "none" && (pref.kind === "media" || wallpaperPreset(pref.preset) !== null) && (pref.kind !== "media" || pref.url !== "");
  if (!on) {
    delete root.dataset.wallpaper;
    root.style.removeProperty("--wp-tint");
    clearSurfaceVars();
    window.__setGlass?.(false);
    // 壁纸关了：明暗回到用户自己的浅色/深色偏好（壁纸模式期间它只是被暂存，没被改）
    window.__refreshTheme?.();
    return;
  }
  root.dataset.wallpaper = pref.kind;
  setWallpaperTint(pref.kind === "preset" ? (PRESET_TINTS[pref.preset] ?? DEFAULT_TINT) : DEFAULT_TINT);
  applySurfaceVars(pref.surface);
  // 玻璃跟着壁纸走：壁纸模式 = 半透明玻璃表面自动生效，不再让用户补一个开关
  window.__setGlass?.(true);
  // 明暗切到壁纸专属基底（同样只是生效值变了，偏好原样保留）；
  // themechange 顺带让 Rail 菜单 / 设置页把「浅色/深色」控件换成壁纸适配状态。
  window.__refreshTheme?.();
  root.appendChild(pref.kind === "preset" ? buildPreset(pref) : buildMedia(pref, token));
}

/** main.tsx 启动时调用一次：接管引导脚本建的首帧层，并监听后续偏好变化。 */
export function startWallpaperLayer(): void {
  applyWallpaper();
  window.__applyWallpaper = applyWallpaper;
  window.addEventListener(WALLPAPER_EVENT, applyWallpaper);
  // 页面不可见就停掉动效：CSS 动画统一 paused，视频壁纸直接 pause()。
  // 回前台原样恢复——看不见的动画一帧都不该画。
  document.addEventListener("visibilitychange", () => {
    const paused = document.visibilityState !== "visible";
    if (paused) document.documentElement.setAttribute("data-wp-paused", "");
    else document.documentElement.removeAttribute("data-wp-paused");
    if (!activeVideo) return;
    if (paused) void activeVideo.pause();
    else void activeVideo.play().catch(() => { /* 自动播放被拦就算了，图静 */ });
  });
}
