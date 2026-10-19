// 构建后等价门：证明「清单里哈希的字节」==「真正被打进安装包的字节」。
//
// 为什么必须有这道门：manifest 必须在 tauri build **之前**生成（它自己也是一项 resource），
// 而资源暂存区 target/release/backend/ 是 build 过程中才被填的——所以"直接对暂存区算哈希"
// 在时序上做不到。只能反过来：build 完回头验一次，把"拷贝不改字节"从假设变成事实。
//
// 实测 Tauri 的资源拷贝是 fs::copy、字节精确（server.mjs 两侧 sha256 一致）。
// 这道门防的就是这个前提哪天被 pipeline 改动破坏——那时运行期会全量报"文件被修改"，
// 而那种症状极难从用户反馈里定位，必须在构建时就红。
//
// 用法：node scripts/verify-staged.mjs   （desktop:build 在 tauri build 之后自动跑）

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const manifestPath = join(root, "dist-desktop", "manifest.json");
const stagedRoot = join(root, "src-tauri", "target", "release", "backend");

// 这两项自己也是 resource，但它们不在清单的 files 里（清单不能包含自己的签名）。
const ALLOWED_EXTRA = new Set(["backend/manifest.json", "backend/manifest.json.sig"]);

const fails = [];
const fail = (m) => fails.push(m);

if (!existsSync(manifestPath)) {
  console.error("[verify-staged] ✗ 没有 dist-desktop/manifest.json——先跑 npm run manifest");
  process.exit(1);
}
if (!existsSync(stagedRoot)) {
  console.error(`[verify-staged] ✗ 暂存区不存在：${stagedRoot}\n  说明 tauri build 没跑，或 resources 映射改过`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.signed !== true) {
  fail("清单未签名（signed != true）：release 包不能带未签名清单，会被端上拒绝启动");
}
const files = manifest.files ?? {};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// 1) 清单里每一条都必须落盘且字节一致
let checked = 0;
for (const [rel, want] of Object.entries(files)) {
  const abs = join(root, "src-tauri", "target", "release", rel.split("/").join(sep));
  if (!existsSync(abs)) {
    fail(`暂存区缺文件：${rel}（清单里有、包里没有 → 运行期会报"安装文件缺失"）`);
    continue;
  }
  const got = createHash("sha256").update(readFileSync(abs)).digest("hex");
  if (got !== want) {
    fail(`暂存区字节与清单不一致：${rel}\n  清单 ${want.slice(0, 16)}…  实际 ${got.slice(0, 16)}…`
      + `\n  → 说明拷贝过程改过字节，或清单是上一次构建的（manifest 必须紧挨着 tauri build 生成）`);
    continue;
  }
  checked++;
}

// 2) 暂存区不能有多余文件：多余 = 被打进包、但没被任何哈希覆盖
const known = new Set(Object.keys(files));
const extras = [];
for (const abs of walk(stagedRoot)) {
  const rel = "backend/" + relative(stagedRoot, abs).split(sep).join("/");
  if (known.has(rel) || ALLOWED_EXTRA.has(rel)) continue;
  extras.push(rel);
}
if (extras.length > 0) {
  // 实测一次能冒出几十条（旧产物累积），全列出来反而看不清根因——只给样本 + 总数。
  const sample = extras.slice(0, 5).map((r) => "    " + r).join("\n");
  fail(`暂存区有 ${extras.length} 个多余文件（会被打进包，但不在清单里 → 未经校验）：\n${sample}`
    + (extras.length > 5 ? `\n    …还有 ${extras.length - 5} 个` : "")
    + `\n  → 通常是 target/ 里的旧产物没清（bundle-backend 的 sweep 应已覆盖），重跑一次 desktop:build`);
}

if (fails.length > 0) {
  console.error("[verify-staged] ✗ 门没过：\n" + fails.map((f) => "  · " + f).join("\n"));
  process.exit(1);
}

console.log(`[verify-staged] ✓ ${checked} 个文件：清单哈希 == 暂存区字节，无多余文件`);
