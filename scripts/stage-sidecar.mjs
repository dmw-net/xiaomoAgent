// 桌面端构建前置：把 Node 二进制按 Tauri 要求的命名放进 src-tauri/binaries/。
//
// 为什么需要这个脚本：Tauri 的 externalBin 要求文件名带目标三元组后缀
// （node-sidecar-x86_64-pc-windows-msvc.exe），而且要放在固定目录。
// 手动复制很容易忘后缀或放错地方，报错信息又不直观（"program not found"）。
// 所以做成脚本，任何机器上跑一遍就对了。

import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";

// 版本守卫：sidecar 就是「跑本脚本的这个 node」——用低版本 Node 打包，
// 会把一个跑不动 .ts 后端的 node.exe 静默塞进安装包（装出来白屏且极难排查）。
// 所以必须在第一步就拦住。
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`[stage-sidecar] ✗ 当前 Node 是 ${process.versions.node}，打包 sidecar 需要 ≥ 22`);
  console.error("  先切换版本再打包：nvm use 24.14.1");
  process.exit(1);
}
console.log(`[stage-sidecar] Node ${process.versions.node} ✓`);
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, arch } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const binariesDir = join(projectRoot, "src-tauri", "binaries");

/** 目标三元组：和 Rust 的 host triple 必须完全一致，否则 Tauri 找不到二进制。 */
function hostTriple() {
  const p = platform();
  const a = arch();
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`未支持的目标平台：${p}/${a}`);
}

/** 找 Node 可执行文件：优先用当前跑这个脚本的 node，保证版本一致。 */
function nodeBinary() {
  // process.execPath 就是当前 Node 的绝对路径，最可靠。
  return process.execPath;
}

const triple = hostTriple();
const ext = platform() === "win32" ? ".exe" : "";
const dest = join(binariesDir, `node-sidecar-${triple}${ext}`);

mkdirSync(binariesDir, { recursive: true });
const src = nodeBinary();

if (existsSync(dest)) {
  const same = statSync(dest).size === statSync(src).size;
  if (same) {
    console.log(`[stage-sidecar] 已是最新：${dest}`);
    process.exit(0);
  }
}

copyFileSync(src, dest);
console.log(`[stage-sidecar] 已复制 ${src}`);
console.log(`              → ${dest}`);
console.log(`[stage-sidecar] 版本：${execFileSync(src, ["--version"], { encoding: "utf8" }).trim()}`);

// Android 目标需要额外一份 aarch64 的二进制。
// 这里只提示，不自动下载（下载要联网，可能很慢，让用户自己决定）。
if (process.argv.includes("--android")) {
  const androidDest = join(binariesDir, "node-sidecar-aarch64-linux-android");
  if (!existsSync(androidDest)) {
    console.log(`\n[stage-sidecar] 提示：Android 构建还需要 ${androidDest}`);
    console.log(`  需要一份 Linux arm64 的 node 二进制（Android 用的是 Linux 内核）。`);
    console.log(`  下载后重命名成上面那个名字即可。`);
    console.log(`  参考：https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-arm64.tar.xz`);
  } else {
    console.log(`[stage-sidecar] Android 二进制已就绪：${androidDest}`);
  }
}

// 顺手提醒一下磁盘占用，避免用户以为是脚本卡住了。
const sizeMb = Math.round(statSync(dest).size / 1024 / 1024);
console.log(`[stage-sidecar] 单份体积：${sizeMb} MB`);
void homedir;
