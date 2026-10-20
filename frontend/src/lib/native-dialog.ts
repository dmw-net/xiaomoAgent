// 原生对话框与应用重启：只在 Tauri 外壳里可用；纯浏览器 dev 下给出"仅桌面端"的提示。
// 照 open-external.ts 的守卫写法：__TAURI_INTERNALS__ 由 Tauri 在 webview 里注入，浏览器里没有。

import { invoke } from "@tauri-apps/api/core";
export type PickResult = { ok: true; path: string } | { ok: false; error: string };

/** 选一个文件夹，返回绝对路径。仅桌面端可用（设置 → 界面 → 数据存储位置）。 */
export async function pickDirectory(): Promise<PickResult> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return { ok: false, error: "选文件夹只在桌面端可用；浏览器里请手动敲一个路径" };
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return { ok: false, error: "没选目录" };
    return { ok: true, path: picked };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `没能打开系统选择器（${message}）` };
  }
}

/** 重启应用（迁移完数据后调它，让新数据目录生效）。仅桌面端可用。 */
export async function relaunchApp(): Promise<{ ok: boolean; error?: string }> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return { ok: false, error: "重启只在桌面端可用；请手动重启应用" };
  }
  try {
    // 直接走 Tauri IPC，避免动态加载插件 JS 分块失败时把“重启”误判成不可用。
    await invoke("plugin:process|restart");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `没能重启（${message}）` };
  }
}
