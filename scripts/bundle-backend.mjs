// 桌面打包前置：把整个后端捆成【一个压缩 + 中文编码过的 ESM 文件】。
//
// 为什么要这一步：Tauri 的 resources 会把文件原样装进安装包，
// 之前直接打包 src/*.ts 源码——任何人解压安装目录就能读全部后端源码。
// 捆成单文件 + minify 后，安装包里只有机器友好的压缩产物，
// 读源码的成本从「打开文件」变成「逆向压缩 JS」。（诚实边界：
// JS 产物无法真正加密，这只抬门槛、不是防弹。）
//
// 这一层把「解压 + 一次 unescape」抬成「先读懂产物里那个小解码器」，并且让**任何文本
// 搜索都摸不到提示词**（minify 完全没做到这点）。仍然不是加密，有心人能还原，别当 DRM。
//
// 产物位置刻意保持 backend/src/server.mjs（与旧源码目录同构）：
// server.ts 用 import.meta.dirname 找 ../frontend/dist，同构布局让它零改动。
//
// 五道门（任何一道不过就 exit 1，绝不产出「看着成功」的包）：
//   A) 最终产物里再扫一遍，不该还剩够长的中文字面量；
//   B) 编码前认定的每条资产串（>=24 汉字）必须从产物明文里消失——不依赖扫描器，专抓
//      扫描器瞎掉的静默失效；
//   C) 编码条数 > 0，否则 A/B 可能只是空转；
//   D) 改写后的文本必须还能被 esbuild 解析（扫坏语法在这里停下，而不是装出白屏）；
//   E) 按「段」口径再量一遍（容忍中文标点与空白，同样不依赖扫描器）——实测靠它揪出过
//      插值里再嵌模板、被扫描器整批漏编的 48 段中文。
// 门之外还有一条**运行期实证**：npm run verify:bundle 起两个隔离实例（源码版 / 捆包版），
// 比对同一份输入拼出的系统提示词必须逐字节相同——上面五道门全绿的包也曾经一启动就崩
// （esbuild inject 把解码器缩名成 `c`，撞上产物里已有的顶层 `c`），只有真跑才抓得到。
//
// 用法：node scripts/bundle-backend.mjs   （desktop / desktop:build 会自动先跑）

import { createRequire } from "node:module";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCjk, planCjkEncoding, totalCjk, remainingCjkRuns, DEFAULT_MIN_CJK } from "./cjk-encode.mjs";

const require = createRequire(join(import.meta.dirname, "..", "frontend", "noop.cjs"));
const root = join(import.meta.dirname, "..");

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  console.error("[bundle-backend] ✗ 找不到 esbuild——先跑 npm --prefix frontend install");
  process.exit(1);
}

const out = join(root, "dist-desktop", "server.mjs");
const entry = join(root, "src", "desktop.ts");
if (!existsSync(entry)) {
  console.error("[bundle-backend] ✗ 入口不存在：" + entry);
  process.exit(1);
}

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  logLevel: "warning",
  write: false,
};

// 1) 捆包 + 压缩（先不编码：注释在 minify 后已不存在，扫描器面对的是最简形态）。
const first = await esbuild.build({ ...common, entryPoints: [entry] });
const plain = first.outputFiles[0].text;

// 3) 给产物挂上解码器。
//    ⚠️ 刻意**不用** esbuild 的 inject + 第二遍打包：实测它会把注入的 `xm` 缩成 `c`，
//    而 pass-1 的顶层作用域里已经有一个 `c`（agent.ts 里标记消息归属的那个函数），
//    于是解码调用打到 SQL 上，捆包一起来就 `no such table: messages`。
//    也不用「先插 `xm(` 再全文替换成别的名字」：pass-1 产物里本来就有 `function xm(...)`，
//    替换会连它的声明一起改，和解码器撞成重复声明。
//    做法：先挑一个**在 pass-1 产物里一次都没出现过**的长专名，编码时直接按这个名字发调用。
const decoderName = (() => {
  for (const name of ["xmAssetText", "xmCjkText", "xmDecodeText", "xmTextBlob"]) {
    if (!new RegExp(`\\b${name}\\b`).test(plain)) return name;
  }
  throw new Error("[bundle-backend] 找不到不冲突的解码器名字");
})();

const { js: encoded, values } = encodeCjk(plain, { minCjk: DEFAULT_MIN_CJK, callName: decoderName });
const encodedChars = values.reduce((sum, v) => sum + v.length, 0);
const decoder =
  `const ${decoderName}=(m=>b=>{const h=m.get(b);if(h!==void 0)return h;` +
  `const t=Buffer.from(b,"base64").toString("utf8");m.set(b,t);return t;})(new Map());`;
const final = decoder + "\n" + encoded;

// 语法门：能解析才算产物成立（只解析，不改写产物）。
await esbuild.transform(final, { loader: "js" });

const plainCjk = totalCjk(plain);
const finalCjk = totalCjk(final);
const leftovers = planCjkEncoding(final, { minCjk: DEFAULT_MIN_CJK });
// 资产清单：编码前那条“够长中文”的名单（>=24 汉字 = 提示词段落，不是界面标签）。
// 门 B 逐个验证它们**不再以明文出现在最终产物里**——这条判定式只依赖字符串包含，
// 不依赖扫描器还能认出字面量，所以扫描器瞎掉时它一定报红（互为反证）。
const ASSET_MIN_CJK = 24;
const assets = planCjkEncoding(plain, { minCjk: ASSET_MIN_CJK }).flatMap((p) => p.values);
const unescapedFinal = final.replace(/\\u([0-9a-fA-F]{4})/g,
  (_, h) => String.fromCharCode(parseInt(h, 16)));
const survived = assets.filter((v) => unescapedFinal.includes(v));

// 4) 清掉资源暂存目录 target/{debug,release}/backend/。
//    整个 backend/ 都是 Tauri 的资源暂存区，不是只 src/：
//      - src/            上一代打包方式残留的 .ts 源码。NSIS 的文件清单早已不含它们
//                        （实测 installer.nsi 只装 server.mjs），但 cargo 只增量重建、
//                        Tauri 拷资源也不删多余文件——谁把 resources 改成「整目录拷 backend/」
//                        就会静默泄漏。
//      - frontend/dist/  Tauri 拷资源时**只增量、从不删除**。实测累积到 81 个文件，
//                        其中 SettingsView-*.js 有 8 个历史版本，一路打进安装包
//                        （包体浪费 + 把版本演进白送出去）。
//    删掉后 tauri build 会按 tauri.conf.json 的 resources 重新拷一份干净的。
let swept = 0;
for (const profile of ["debug", "release"]) {
  const dir = join(root, "src-tauri", "target", profile, "backend");
  if (!existsSync(dir)) continue;
  rmSync(dir, { recursive: true, force: true });
  swept++;
}

writeFileSync(out, final, "utf8");
writeFileSync(
  join(root, "dist-desktop", "bundle-report.json"),
  JSON.stringify({
    builtAt: new Date().toISOString(),
    bytes: final.length,
    encodedLiterals: values.length,
    encodedChars,
    cjkBefore: plainCjk,
    cjkAfter: finalCjk,
    residualRuns: remainingCjkRuns(final, DEFAULT_MIN_CJK).length,
    sweptBackendDirs: swept,
  }, null, 2),
  "utf8",
);

// ── 门 ────────────────────────────────────────────────────
// A：够长的中文字面量在最终产物里必须一条不剩（扫描器自己再扫一遍）。
// B：编码前认定的每条**资产串**必须从产物明文里消失——只依赖字符串包含，不依赖扫描器，
//    专抓「扫描器瞎掉但产物看着干净」的静默失效（第一版吞掉代码就是靠解析门才发现的）。
// C：编码条数 > 0，否则 A/B 可能只是空转。
// D：第二遍 esbuild 能解析（解析不了在上面就 throw 了）——扫坏语法绝不产出包。
const fails = [];
if (values.length === 0) fails.push("编码条数 = 0：扫描器没找到任何成段中文，这层等于没生效");
if (leftovers.length > 0) {
  const leaked = leftovers.flatMap((p) => p.values);
  fails.push(`门 A：产物里仍有 ${leftovers.length} 段够长中文，例如：\n  ${leaked.slice(0, 3).join("\n  ")}`);
}
if (assets.length === 0) fails.push(`门 B 无样本：编码前找不到任何 >=${ASSET_MIN_CJK} 字的资产串，判定式会空转`);
if (survived.length > 0) {
  fails.push(`门 B：${survived.length}/${assets.length} 条资产串仍以明文存在于产物，例如：\n  ${survived.slice(0, 3).join("\n  ")}`);
}
// E：段（segment）口径再量一遍——这条**不是**扫描器，是「按中文标点切段数汉字」，
//    专抓扫描器够不到的角落（实测就是它揪出过插值里再嵌模板漏掉的 2 段）。
const residual = remainingCjkRuns(final, DEFAULT_MIN_CJK);
if (residual.length > 0) {
  fails.push(`门 E：按段口径仍有 ${residual.length} 段成中文未被编码，例如：\n  ${residual.slice(0, 3).join("\n  ")}`);
}

if (fails.length > 0) {
  console.error("[bundle-backend] ✗ 门没过：\n" + fails.map((f) => "  · " + f).join("\n"));
  process.exit(1);
}

const kb = Math.round(statSync(out).size / 1024);
console.log(
  `[bundle-backend] src/desktop.ts → dist-desktop/server.mjs（${kb} KB）：` +
  `压缩混淆 + ${values.length} 段中文资产已编码（${encodedChars} 字，含 ${assets.length} 条 >=${ASSET_MIN_CJK} 字提示词）；` +
  `产物汉字 ${plainCjk}→${finalCjk}，明文残留 0 段` +
  (swept ? `；顺带清掉 ${swept} 处资源暂存目录（含旧 .ts 与陈旧前端产物）` : ""),
);
