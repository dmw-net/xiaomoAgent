import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PetApp from "./features/pet/PetApp";
import { PET_HEIGHT_RATIO } from "./features/pet/petAssets";
import { settingsApi } from "./api";
import { showPetWindow } from "./lib/pet-window";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { watchKeyboard } from "./lib/keyboard";
import { startNativeWindowThemeSync } from "./lib/window-theme";
import { startWallpaperLayer } from "./lib/wallpaper";
import { migrateAppearancePrefs } from "./lib/ui-prefs";
import "./styles/theme.css";
import "./styles/foundation.css";
import "./styles/components.css";
import "./styles/experience.css";
import "./styles/tools.css";
import "./styles/pet.css";

// 桌宠是独立透明窗口：不跑主界面的主题/壁纸/快捷键初始化，避免把壁纸铺进宠物层。
const isPetWindow = location.hash.startsWith("#/pet");
if (isPetWindow) {
  // 首帧前就把 body 标成宠物层，避免 WebView 先用白底闪一下。
  document.body.dataset.pet = "1";
}
if (!isPetWindow) {
  migrateAppearancePrefs();
  watchKeyboard();
  startNativeWindowThemeSync();
  startWallpaperLayer();

  // 主界面起来后按设置召唤桌宠；桌宠窗口自己不重复拉这一趟。
  // 「桌面端内」形态不开外壳窗口：App 里的 PetHost 会挂内嵌浮层。
  void settingsApi.fetchSettings().then((snap) => {
    const pet = snap.pet;
    if (!pet?.enabled || pet.displayMode === "in-app") return;
    const size = pet.size;
    const height = Math.round(size * PET_HEIGHT_RATIO);
    // screen.availWidth/Height 已是逻辑像素（DIP），与 LogicalPosition 同单位，别再除 dpr。
    const screenWidth = window.screen?.availWidth || window.innerWidth || 1920;
    const screenHeight = window.screen?.availHeight || window.innerHeight || 1080;
    const x = typeof pet.x === "number" ? pet.x : Math.max(12, screenWidth - size - 24);
    const y = typeof pet.y === "number" ? pet.y : Math.max(12, screenHeight - height - 24);
    void showPetWindow({
      url: location.origin + "/#/pet",
      x,
      y,
      width: size,
      height,
      alwaysOnTop: pet.alwaysOnTop,
    }).then((r) => {
      if (!r.ok) console.warn("[pet] 召唤桌宠窗口失败：", r.error);
    }).catch(() => undefined);
  }).catch(() => undefined);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isPetWindow ? <PetApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
