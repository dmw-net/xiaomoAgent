// 生成资产加密密钥：dist-desktop/asset-key.txt（32 字节随机数的 base64）。
//
// 为什么需要：cjk-encode 那层原来是纯 base64——一条 `Buffer.from(b,"base64")`
// 就能解回明文（2026-10-19 实测 5 行 python 全解）。现在改成 XOR + 每包随机密钥：
// 密钥不进 server.mjs，而是被 build.rs 烧进 exe，sidecar 启动时经环境变量拿到。
// 拿到安装包的人要解提示词，必须先从 exe 里把密钥挖出来——从「5 分钟」抬到「得逆向」。
//
// 幂等：文件已存在就不动。同一台机器反复出包用同一把钥匙，密钥只在首次生成；
// 要轮换就删掉 asset-key.txt 再跑（会触发 Rust 全量重编译，属预期）。
//
// 用法：node scripts/gen-asset-key.mjs   （npm run desktop 与 desktop:build 自动先跑）

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "dist-desktop", "asset-key.txt");

if (existsSync(out)) {
  const buf = Buffer.from(readFileSync(out, "utf8").trim(), "base64");
  if (buf.length >= 16) {
    console.log("[gen-asset-key] 密钥已存在，沿用（要轮换请删除 dist-desktop/asset-key.txt）");
    process.exit(0);
  }
  console.error("[gen-asset-key] ✗ asset-key.txt 存在但不是合法密钥（解出 <16 字节）——删掉它重新生成");
  process.exit(1);
}

mkdirSync(join(root, "dist-desktop"), { recursive: true });
writeFileSync(out, randomBytes(32).toString("base64") + "\n", "utf8");
console.log("[gen-asset-key] 已生成 32 字节资产密钥 → dist-desktop/asset-key.txt");
console.log("[gen-asset-key] ⚠️ 这把钥匙只活在构建机上，别提交进 git");
