// 资源清单 + 签名：让「安装包里的后端/前端资源被改过」这件事在运行期能被发现。
//
// 为什么需要：Tauri 的 resources 是原样装进安装包的，任何人解开 NSIS 就能换掉
// backend/src/server.mjs 再打一个新包——用户看到的是同一个图标、同一个版本号。
// 这里把每个资源文件的 sha256 写成清单，再用**发版那把 minisign 私钥**签一遍；
// 端上启动时用烧在 exe 里的公钥验签 + 逐文件比对哈希，对不上就走错误页。
//
// 边界（别当铁门）：拿到本地 exe 的人可以 patch 掉 verify_resources 或换掉公钥常量。
// 它挡的是「不会逆向的人改包重分发」——那些人签不出新的 manifest。
//
// 用法：
//   node scripts/make-manifest.mjs              # 签名（找不到私钥就失败，desktop:build 用这个）
//   node scripts/make-manifest.mjs --unsigned   # 只生成清单 + 占位签名（tauri dev 用）
//
// 注意：清单里哈希的是**构建源产物**，不是 resource_dir 里的副本——后者要到
// tauri build 才生成，时序上不可能先拿到。「拷贝不改字节」由 scripts/verify-staged.mjs
// 在 build 之后回头验一次，不靠口头约定。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const distDir = join(root, "frontend", "dist");
const serverMjs = join(root, "dist-desktop", "server.mjs");
const unsigned = process.argv.includes("--unsigned");

const fail = (msg) => {
  console.error("[make-manifest] ✗ " + msg);
  process.exit(1);
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync(serverMjs)) fail(`找不到 ${serverMjs}——先跑 npm run bundle:backend`);
if (!existsSync(distDir)) fail(`找不到 ${distDir}——先跑 npm --prefix frontend run build`);

// 键 = 文件在 resource_dir 里的相对路径，必须与 tauri.conf.json 的 resources 映射逐字一致。
// 刻意不含 loading.html：它由 WebviewUrl::App 从 exe 内嵌资源加载，
// resource_dir 里那份副本没人读，校验它抓不到任何篡改。
const targets = [
  ["backend/src/server.mjs", serverMjs],
  ...walk(distDir).map((f) => [
    "backend/frontend/dist/" + relative(distDir, f).split(sep).join("/"),
    f,
  ]),
];

const files = {};
for (const [rel, abs] of targets) {
  files[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
}

// 排序写盘：清单是签名对象，键序必须稳定，否则同一份内容两次构建产出不同字节。
const sorted = {};
for (const k of Object.keys(files).sort()) sorted[k] = files[k];

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist-desktop", "manifest.json");
const sigPath = `${out}.sig`;

// 先删旧签名：签名失败时不能让上一次的 .sig 留在原地冒充成功。
rmSync(sigPath, { force: true });

if (unsigned) {
  // 开发构建：Rust 侧 #[cfg(debug_assertions)] 直接跳过校验，这里只需要文件存在
  // （tauri-build 会检查 resources 是否存在，缺文件连 dev 都起不来）。
  writeFileSync(out, JSON.stringify({ version: pkg.version, signed: false, files: sorted }, null, 2), "utf8");
  writeFileSync(sigPath, "UNSIGNED\n", "utf8");
  console.log(`[make-manifest] 已生成未签名清单（${Object.keys(sorted).length} 个文件）——仅限 tauri dev`);
  process.exit(0);
}

writeFileSync(out, JSON.stringify({ version: pkg.version, signed: true, files: sorted }, null, 2), "utf8");

// 签名：复用发版那把私钥。两种调用方式不能混用——
//   · 有 TAURI_SIGNING_PRIVATE_KEY 环境变量时**只**用环境变量（CI 就是这么注入的）
//   · 没有时才用 -f 指文件，否则 clap 会报 Usage 错
const hasEnvKey = (process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim() !== "";
const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
  ?? join(homedir(), ".tauri", "xiaomo-updater.key");
const args = ["signer", "sign"];
if (!hasEnvKey) {
  if (!existsSync(keyPath)) {
    fail(`找不到更新签名私钥：${keyPath}\n`
      + `  要么把它放到默认位置，要么设 TAURI_SIGNING_PRIVATE_KEY_PATH；\n`
      + `  只想本地跑 dev 的话用 --unsigned。`);
  }
  args.push("-f", keyPath, "-p", process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "");
}
args.push(out);

const sign = spawnSync(process.execPath, [join(root, "scripts", "tauri.mjs"), ...args], {
  stdio: "inherit",
  cwd: root,
});
if (sign.status !== 0) {
  fail(`签名失败（退出码 ${sign.status}）。口令不对是 "Wrong password for that key"；\n`
    + `  看到 "Usage: cargo-tauri signer sign ..." 则是 -f 与环境里的 TAURI_SIGNING_PRIVATE_KEY 撞了。`);
}
if (!existsSync(sigPath) || statSync(sigPath).size === 0) {
  fail("签名命令返回成功，但没产出 .sig——不能当成成功，release 会带着未签名清单发出去");
}

const kb = Math.round(statSync(out).size / 1024);
console.log(
  `[make-manifest] manifest.json（${kb} KB，${Object.keys(sorted).length} 个文件）已签名`
  + ` → ${relative(root, sigPath)}`,
);
