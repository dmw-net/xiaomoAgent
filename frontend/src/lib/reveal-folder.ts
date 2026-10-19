// 在系统文件管理器里露出一个目录：设置 → 技能 的「打开技能目录」。
// 照 open-external.ts 的守卫写法：__TAURI_INTERNALS__ 由 Tauri 在 webview 里注入，浏览器里没有。
//
// 用 revealItemInDir 而不是 openPath：前者只需要"在资源管理器里定位这一个路径"，
// 后者是"用任意程序打开任意路径"，权限面大得多。Windows 上它的效果是打开父目录并选中
// skills 文件夹——一步到位，且不会因为用户把 .md 关联到某个编辑器而打开错东西。

/** 打开结果：失败必须能被界面看见，不能只留在 console。 */
export type OpenResult = { ok: true } | { ok: false; error: string };

export async function revealInFolder(path: string): Promise<OpenResult> {
  if (!("__TAURI_INTERNALS__" in window)) {
    // 纯浏览器 dev 下没有外壳：路径就摆在界面上，这句话把人指回去。
    return { ok: false, error: "只有在桌面端应用里才能直接打开文件夹；浏览器里请照上面那个路径手动过去" };
  }
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `没能打开文件夹（${message}）` };
  }
}
