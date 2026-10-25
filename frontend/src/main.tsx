import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { watchKeyboard } from "./lib/keyboard";
import { startNativeWindowThemeSync } from "./lib/window-theme";
import { startWallpaperLayer } from "./lib/wallpaper";
import { migrateAppearancePrefs } from "./lib/ui-prefs";
import "./styles/theme.css";
import "./styles/foundation.css";
import "./styles/components.css";
import "./styles/experience.css";

migrateAppearancePrefs();
watchKeyboard();
startNativeWindowThemeSync();
startWallpaperLayer();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
