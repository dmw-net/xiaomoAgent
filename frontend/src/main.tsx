import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { watchKeyboard } from "./lib/keyboard";
import { startNativeWindowThemeSync } from "./lib/window-theme";
import "./styles/legacy.css";
import "./styles/app.css";

watchKeyboard();
startNativeWindowThemeSync();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
