// 本地打包（Windows 安装包）：把签名材料找齐，再跑 desktop:build。
//
// 为什么要单独一层：desktop:build 要求签名（未签名清单的包装上起不来），而签名要
// 「私钥 + 口令」两样东西。每次命令前手打 env 是最容易漏的一步，而漏了会等到构建末尾
// 才炸——白等一趟前端加 Rust 编译。这一层把"找材料"提前，找不到就立刻说清楚缺什么。
//
// 找材料的顺序（路径都不写死在仓库里，公开仓库不该带机器专属路径）：
//   私钥：TAURI_SIGNING_PRIVATE_KEY（内容）→ TAURI_SIGNING_PRIVATE_KEY_PATH（路径）
//         → %USERPROFILE%\.tauri\xiaomo-updater.key
//   口令：TAURI_SIGNING_PRIVATE_KEY_PASSWORD → TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE
//         → %USERPROFILE%\.tauri\xiaomo-updater.pass
//
// 这两样都没有时明确报错退出，**不会**拿空口令去试——空口令签不出东西，只会白跑一遍构建。
//
// 用法：npm run pack   （等价于 node scripts/pack.mjs）

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const readText = (path) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), ".tauri", "xiaomo-updater.key");
let key = (process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim();
let keyFrom = "环境变量 TAURI_SIGNING_PRIVATE_KEY";
if (key === "" && existsSync(keyPath)) {
  key = readText(keyPath);
  keyFrom = keyPath;
}

const passPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE ?? join(homedir(), ".tauri", "xiaomo-updater.pass");
let pass = (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "").trim();
let passFrom = "环境变量 TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
if (pass === "" && existsSync(passPath)) {
  pass = readText(passPath);
  passFrom = passPath;
}

if (key === "") {
  console.error("\n✗ 找不到更新签名私钥。三选一：");
  console.error("   · 设 TAURI_SIGNING_PRIVATE_KEY（私钥文件的内容）");
  console.error("   · 设 TAURI_SIGNING_PRIVATE_KEY_PATH 指向私钥文件");
  console.error(`   · 把私钥放到 ${keyPath}`);
  console.error("   私钥丢了只能重新生成，已装老版本的用户要手动重装——别当它可丢。\n");
  process.exit(1);
}
if (pass === "") {
  console.error("\n✗ 找不到私钥口令。三选一：");
  console.error("   · 设 TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  console.error("   · 设 TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE 指向口令文件");
  console.error(`   · 把口令放到 ${passPath}\n`);
  process.exit(1);
}

console.log(`[pack] 私钥：${keyFrom}`);
console.log(`[pack] 口令：${passFrom}`);
console.log("[pack] 开始出包（前端 + Rust 全量构建，几分钟）…\n");

// 注入内容之后必须把 PATH / FILE 两个变体从子进程环境里**摘掉**：
// Tauri CLI 认这两个环境变量，同时看到「内容」和「路径」就会报
// "the argument --private-key cannot be used with --private-key-path"。
const childEnv = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: pass };
delete childEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
delete childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE;

// Windows 上 npm 是 npm.cmd，不开 shell 起不来（与 publish-release.mjs 同一处理）。
const result = spawnSync("npm", ["run", "desktop:build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: childEnv,
});
process.exit(result.status ?? 1);