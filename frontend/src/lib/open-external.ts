/** 外链打开结果：失败必须能被界面看见，不能只留在 console。 */
export type OpenResult = { ok: true } | { ok: false; error: string };

/**
 * 打开外部链接。外壳（Tauri 的 WebView）里 `target="_blank"` 不会开新窗口，
 * 点了就是没反应——必须交给 opener 插件让系统浏览器接手；纯浏览器保持原生行为。
 *
 * 失败有两种，都得让调用方拿去显示：外壳里是权限层拒绝（capability 没覆盖当前 origin
 * 时 openUrl 直接 reject），浏览器里是弹窗被拦（window.open 返回 null）。
 */
export async function openExternal(url: string): Promise<OpenResult> {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `外壳没能调用系统浏览器（${message}）` };
    }
  }
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) return { ok: false, error: "浏览器拦住了新窗口，请允许弹窗或手动打开下面的地址" };
  win.focus();
  return { ok: true };
}
