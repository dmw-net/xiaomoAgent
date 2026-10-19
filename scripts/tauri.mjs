// tauri CLI 的包装脚本：让 `npm run desktop:build` 之类不依赖 tauri 命令在 PATH 里。
//
// 【为什么需要这个脚本】
// 这台机器的 tauri CLI 是 `cargo install tauri-cli` 装的，落在
// %USERPROFILE%\.cargo\bin\cargo-tauri.exe —— 它**没有**注册进系统/用户 PATH，
// 也没有独立的 `tauri.exe`。于是 npm scripts 里裸写 `tauri build` 会报
// "'tauri' 不是内部或外部命令"，而且换一台机器症状可能又不一样。
//
// 这个脚本按固定顺序探测 CLI 位置，找到后**直接作为独立进程调用**
// （cargo-tauri.exe 本身就是完整 CLI，不需要 cargo 在场）。
// 找不到时给人话提示，而不是让用户去猜 PATH 出了什么问题。

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, delimiter, sep } from "node:path";
import { homedir, platform } from "node:os";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("用法：node scripts/tauri.mjs <tauri 子命令>，例如 build / dev / android build");
  process.exit(1);
}

function findTauriCli() {
  if (platform() === "win32") {
    // cargo install tauri-cli 的默认落点
    const candidate = join(homedir(), ".cargo", "bin", "cargo-tauri.exe");
    if (existsSync(candidate)) return candidate;
  } else {
    const candidate = join(homedir(), ".cargo", "bin", "cargo-tauri");
    if (existsSync(candidate)) return candidate;
  }

  // 兜底：PATH 里能找到 tauri 或 cargo tauri 也行
  const probe = platform() === "win32" ? "where" : "which";
  for (const name of ["tauri", "cargo-tauri"]) {
    const result = spawnSync(probe, [name], { encoding: "utf8" });
    const first = result.stdout?.trim().split(/\r?\n/)[0];
    if (first) return first;
  }
  return null;
}

const cli = findTauriCli();
if (!cli) {
  console.error("找不到 tauri CLI。两种装法任选其一：");
  console.error("  1. cargo install tauri-cli --version ^2   （推荐，装完重跑本命令）");
  console.error("  2. npm install -D @tauri-apps/cli         （会引入 node_modules）");
  process.exit(1);
}

if (args[0] === "--version" || args[0] === "-V") {
  console.log(`[tauri.ts] 使用 CLI：${cli}`);
}

// cargo-tauri build 内部还要 spawn `cargo` 来编译 Rust，而 cargo.exe 通常和
// CLI 在同一个 .cargo/bin 里、也同样不在 PATH。把 CLI 所在目录塞进子进程 PATH，
// 一并解决「cargo 不存在」的问题。
const childEnv = {
  ...process.env,
  PATH: `${dirname(cli)}${delimiter}${process.env.PATH ?? ""}`,
};

// 只在 build 时改 RUSTFLAGS：dev 也改的话，本地增量编译会因指纹变化白重编一次。
// 目的：把构建机路径从 panic / 调试字符串里抹掉。不 remap 时，exe 里能直接读到
//   C:\Users\<用户名>\.cargo\registry\src\...\<crate>-<ver>\src\...   ← 泄漏用户名与依赖版本
//   D:\...\<工程名>\src-tauri\src\lib.rs                              ← 泄漏工程绝对路径与目录结构
// 注意边界：remap 只作用于 file!() / panic location 这类编译器生成的路径串，
// 管不到 env!("CARGO_MANIFEST_DIR") 展开出的字面量（Tauri 生成的 loading.html 绝对路径
// 就属于后者）。要连那条也消掉，只能把出包机换到中性目录（如 C:\build\xiaomo）。
if (args.includes("build")) {
  const withSep = (p) => (p.endsWith(sep) ? p : p + sep);
  const remap = [
    `--remap-path-prefix=${withSep(join(homedir(), ".cargo"))}=/cargo/`,
    `--remap-path-prefix=${withSep(root)}=/src/`,
  ];
  childEnv.RUSTFLAGS = [process.env.RUSTFLAGS ?? "", ...remap].filter(Boolean).join(" ").trim();
}

const result = spawnSync(cli, args, { stdio: "inherit", env: childEnv });
process.exit(result.status ?? 1);
