// 桌面端（Tauri sidecar）入口。
//
// 和 src/index.ts 的区别只有一个：**不读 .env**。
//
// 为什么必须分开：
//   Node 的 --env-file 是「文件覆盖进程环境变量」。桌面外壳通过环境变量传 PORT=0
//   和 DATA_DIR 给子进程，如果同时加载了 .env（里面有 PORT=8787），外壳传的值会被
//   悄悄覆盖掉——然后外壳按 8787 去连，而用户机器上 8787 可能被别的程序占着。
//   这类 bug 极难查：日志里两行都"看起来对"。
//
//   所以桌面模式只认外壳给的环境变量 + 同目录的 desktop.json，一个真源。
//
// 用法（由 Tauri 外壳调用，参数都是绝对路径）：
//   node --experimental-sqlite src/desktop.ts --config <desktop.json>

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: "string" } },
  allowPositionals: true,
});

/**
 * 从 desktop.json 读配置并写进 process.env。
 * 必须在 import ./config.ts **之前**完成——config 在模块顶层就把值读走了。
 * 这就是为什么用动态 import：静态 import 会被提升到最前面，配置就来不及注入了。
 */
function loadDesktopConfig(): void {
  const path = values.config;
  if (!path) {
    console.error("[desktop] 缺少 --config 参数，无法启动");
    process.exit(2);
  }
  // 把配置文件路径透给后端：设置里改数据目录时要读回它、更新 DATA_DIR。
  process.env.DESKTOP_CONFIG = path;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`[desktop] 读不到配置文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error(`[desktop] 配置文件不是合法 JSON：${path}`);
    process.exit(2);
  }

  // 只接受字符串值，避免外壳传错类型时静默变成 "undefined"。
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") process.env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") process.env[key] = String(value);
  }

  // 外壳没给 PORT 时用 0（系统分配空闲端口），绝不回落到写死的值。
  process.env.PORT ??= "0";
}

loadDesktopConfig();

// 动态 import：见上面注释，顺序是关键。
await import("./index.ts");
