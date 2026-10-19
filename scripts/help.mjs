// `npm run help` —— 只列你真正要记的那几条。
//
// 为什么要有：package.json 里现在有二十多个 script，`npm run` 一敲全糊在一起，
// 分不清哪个是日常用的、哪个是构建链内部调用的。这个文件就是那份"该记的清单"。
//
// 维护约定：改了 package.json 的脚本，记得同步这里；末尾会自动核对一遍，
// 清单里写了但 package.json 里不存在的命令会标出来（防止文档漂移成假的）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const GROUPS = [
  {
    title: "日常开发",
    items: [
      ["dev", "浏览器里跑（http://127.0.0.1:8787）"],
      ["app", "桌面窗口里跑（Tauri）"],
    ],
  },
  {
    title: "出包",
    items: [
      ["pack", "本地出安装包（自动找签名私钥与口令）"],
      ["desktop:build", "同上，但签名材料要自己用环境变量给"],
    ],
  },
  {
    title: "维护",
    items: [
      ["ver", "版本号：查看/校验；`npm run ver patch` 递增，`npm run ver 0.3.0` 指定"],
    ],
  },
  {
    title: "检查与诊断",
    items: [
      ["check", "类型检查（后端 + 前端）"],
      ["doctor", "环境与配置自检"],
      ["smoke", "冒烟测试（跑源码，不覆盖捆包产物）"],
    ],
  },
];

const INTERNAL = [
  "manifest", "verify:staged", "stage-sidecar", "bundle:backend", "cjk:test",
  "verify:bundle", "tauri", "fe:build", "typecheck", "start", "desktop",
  "verify-context", "hooks:test", "proactive:once",
];

const missing = [];
const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
// 终端里中文占两列，用 .length 判断换行会算错——按显示宽度算。
const width = (s) => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);

console.log("\n小茉 · 常用命令\n");

for (const g of GROUPS) {
  console.log(`  ${g.title}`);
  for (const [cmd, desc] of g.items) {
    if (!pkg.scripts[cmd]) missing.push(cmd);
    const head = `    npm run ${pad(cmd, 14)}`;
    if (width(head + desc) <= 100) {
      console.log(head + desc);
    } else {
      // 超宽就整段换到下一行，缩进对齐到描述列——别在中文里硬断
      console.log(head.trimEnd());
      console.log(`${" ".repeat(head.length)}${desc}`);
    }
  }
  console.log("");
}

console.log("  记住几条");
console.log("    · 后端零依赖：Node 22 起自带 node:sqlite，脚本要带 --experimental-sqlite");
console.log("    · 版本号散在七处，别手改：npm run ver 看现值，npm run ver patch 递增");
console.log("    · 安装包产物：src-tauri/target/release/bundle/nsis/");
console.log("");
console.log(`  内部命令（构建链自己调用，别直接跑）：${INTERNAL.join(" · ")}`);
console.log("");

if (missing.length > 0) {
  console.error(`⚠ help.mjs 里写了但 package.json 里不存在的命令：${missing.join(", ")}`);
  process.exit(1);
}