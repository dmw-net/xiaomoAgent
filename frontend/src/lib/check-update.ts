/**
 * 应用内检查更新。只在 Tauri 外壳里有意义：浏览器打开的是别人部署的服务端，
 * 升级由部署方决定，端上没有任何东西可以"安装"。
 *
 * 整个模块对 @tauri-apps/plugin-updater 用**动态 import**（照 open-external.ts 的做法）：
 * 浏览器主包只多一个懒加载 chunk，不该让手机用户跟着下一遍桌面更新器的代码。
 * 浏览器里连入口都不给（AboutBody 按 origin 判），所以这里不必再防"被浏览器调用"。
 */

/** 检查这一步的结果。"发现新版本"不在此自动装——装了会退出应用，必须让用户先点头。 */
export type UpdateCheck =
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "error"; error: string };

/** 下载/安装进度，交给调用方原样显示。拿不到总长时 percent 为 null，只显示"下载中"。 */
export type UpdateProgress =
  | { kind: "downloading"; percent: number | null }
  | { kind: "installing" };

type UpdateHandle = import("@tauri-apps/plugin-updater").Update;

// 检查到的那份更新留在模块级：组件侧不 import 插件类型，也就拿不到实例，
// 只靠这个变量在 check 与 install 两步之间传话。再检查一次会覆盖它。
let pending: UpdateHandle | null = null;

export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return { kind: "current" };
    pending?.close();
    pending = update;
    return { kind: "available", version: update.version, notes: update.body ?? "" };
  } catch (error) {
    return { kind: "error", error: messageOf(error) };
  }
}

/**
 * 下载并安装。**Windows 上 install() 成功后应用会直接退出**（外壳拉起安装程序），
 * 所以"能返回"分两种：安装程序接手了（launched，应用正在退场），或者中途失败（error）。
 */
export type InstallResult = { kind: "launched" } | { kind: "error"; error: string };

export async function installUpdate(
  onProgress: (p: UpdateProgress) => void,
): Promise<InstallResult> {
  const update = pending;
  if (!update) return { kind: "error", error: "还没检查到可用的新版本，先点一次「检查更新」。" };
  try {
    let total = 0;
    let got = 0;
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        onProgress({ kind: "downloading", percent: null });
      } else if (event.event === "Progress") {
        // Progress 每次给的是**这一块**的字节数，不累加就永远算不出进度。
        got += event.data.chunkLength;
        onProgress({ kind: "downloading", percent: total > 0 ? Math.min(99, Math.round((got / total) * 100)) : null });
      } else {
        onProgress({ kind: "downloading", percent: 100 });
      }
    });
    onProgress({ kind: "installing" });
    await update.install({ restartAfterInstall: true });
    return { kind: "launched" };
  } catch (error) {
    pending = null;
    return { kind: "error", error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
