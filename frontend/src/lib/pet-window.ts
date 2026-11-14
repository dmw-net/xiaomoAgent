// 桌宠透明窗口的外壳控制：只在 Tauri 桌面外壳里可用；浏览器 dev 下静默返回 false。
// 这里只调自定义命令，不直接碰 @tauri-apps/api/window——窗口的创建/移动/尺寸都在 Rust 侧收口，
// 避免给远程 origin 开一组 core:window 权限。

import { invoke } from "@tauri-apps/api/core";

export const isPetRuntime = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type PetWindowOptions = {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  alwaysOnTop: boolean;
};

export type PetWindowShowResult = { ok: boolean; error?: string };

function invokeErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 显示桌宠窗口。失败要带原因回来：设置页的提示按原因给指引，
 * 「权限不足？」这种瞎猜文案不如把 IPC 的真实报错亮出来。
 */
export async function showPetWindow(opts: PetWindowOptions): Promise<PetWindowShowResult> {
  if (!isPetRuntime()) return { ok: false, error: "not-tauri" };
  try {
    await invoke("pet_window_show", {
      url: opts.url,
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
      alwaysOnTop: opts.alwaysOnTop,
    });
    return { ok: true };
  } catch (error) {
    const text = invokeErrorText(error);
    console.warn("[pet] 显示桌宠窗口失败", error);
    return { ok: false, error: text };
  }
}

/** 把召唤失败翻译成人话：浏览器环境、旧壳缺命令（要换仓库壳或重新出包）、其它 IPC 错误。 */
export function describePetShowFailure(error?: string): string {
  if (error === undefined) return "桌宠窗口没有打开。";
  if (error === "not-tauri") return "当前不是桌面端，浏览器里没有桌宠窗口。";
  if (error.includes("pet_window_show") || /not found|不存在|未注册|unknown/i.test(error)) {
    return `桌宠窗口没有打开：${error}。当前桌面壳里没有桌宠命令——多半是旧版安装壳：请完全退出小茉，改用仓库的 npm run desktop 启动桌面壳，或重新出包安装。`;
  }
  return `桌宠窗口没有打开：${error}`;
}

export async function hidePetWindow(): Promise<boolean> {
  if (!isPetRuntime()) return false;
  try {
    await invoke("pet_window_hide");
    return true;
  } catch (error) {
    console.warn("[pet] 隐藏桌宠窗口失败", error);
    return false;
  }
}

export async function movePetWindow(x: number, y: number): Promise<boolean> {
  if (!isPetRuntime()) return false;
  try {
    await invoke("pet_window_move", { x, y });
    return true;
  } catch {
    return false;
  }
}

export async function resizePetWindow(width: number, height: number): Promise<boolean> {
  if (!isPetRuntime()) return false;
  try {
    await invoke("pet_window_resize", { width, height });
    return true;
  } catch {
    return false;
  }
}

export async function setPetAlwaysOnTop(alwaysOnTop: boolean): Promise<boolean> {
  if (!isPetRuntime()) return false;
  try {
    await invoke("pet_window_set_always_on_top", { alwaysOnTop });
    return true;
  } catch {
    return false;
  }
}

/**
 * 上报角色头顶占比（相对窗口宽）+ 是否交互中（拖拽）。命中判定由外壳钩子按
 * 窗口矩形现场计算，坐标天然同源。失败静默——钩子没起来只是少一层穿透优化。
 */
export async function setPetHit(topFrac: number, active: boolean): Promise<boolean> {
  if (!isPetRuntime()) return false;
  try {
    await invoke("pet_window_set_hit", { topFrac, active });
    return true;
  } catch {
    return false;
  }
}


export async function showMainWindow(): Promise<boolean> {
  if (!isPetRuntime()) return false;
  try {
    await invoke("pet_window_show_main");
    return true;
  } catch (error) {
    console.warn("[pet] 显示主界面失败", error);
    return false;
  }
}

/**
 * 主窗里打开助手弹窗（桌宠菜单「找小茉聊聊」）：先唤主窗（可能藏在托盘），
 * 再 emitTo 把打开事件送到主窗——CustomEvent 不跨窗，core:event 已在
 * core:default 授权内，无需新权限/新命令（旧安装壳同样支持）。
 */
export async function openAssistantInMainWindow(): Promise<boolean> {
  if (!isPetRuntime()) return false;
  try {
    await showMainWindow();
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("main", "xiaomo:open-assistant", {});
    return true;
  } catch (error) {
    console.warn("[pet] 打开主窗助手失败", error);
    return false;
  }
}
