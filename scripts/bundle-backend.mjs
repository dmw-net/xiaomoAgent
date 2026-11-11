// 桌面打包前置：把整个后端捆成【一个压缩 + 中文编码过的 ESM 文件】。
//
// 为什么要这一步：Tauri 的 resources 会把文件原样装进安装包——
// 直接打包 src/*.ts 源码的话，任何人解压安装目录就能读全部后端源码。
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
//   E) 按「段」口径再量一遍（容忍中文标点与空白，同样不依赖扫描器）——
//      插值里再嵌模板这类会被扫描器整批漏编，这道门兜住。
// 门之外还有一条**运行期实证**：npm run verify:bundle 起两个隔离实例（源码版 / 捆包版），
// 比对同一份输入拼出的系统提示词必须逐字节相同——五道门全是静态检查，
// 只有真跑才抓得到运行期问题。
//
// 用法：node scripts/bundle-backend.mjs   （desktop / desktop:build 会自动先跑）

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync, readFileSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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
  // sharp 必须留在外面：它的 JS 内联进单文件后，运行时仍要 require 平台原生包
  // （@img/sharp-win32-x64 里那个 .node 与 libvips 的 dll），而那些东西没法内联。
  // 半内联是最坏组合——模块看着在、实际取不到。留成 external，由 stageSharpDeps()
  // 把真正的 node_modules 放进安装目录的 backend/node_modules，让 ESM 从 server.mjs
  // 往上找得到它。
  external: ["sharp"],
};

// 1) 捆包 + 压缩（先不编码：注释在 minify 后已不存在，扫描器面对的是最简形态）。
const first = await esbuild.build({ ...common, entryPoints: [entry] });
const plain = first.outputFiles[0].text;

// 3) 给产物挂上解码器。
//    ⚠️ 刻意**不用** esbuild 的 inject + 第二遍打包：注入的解码器名会被 minify 缩短，
//    撞上 pass-1 顶层作用域里已有的同名标识符（比如 agent.ts 里标记消息归属的那个），
//    解码调用就会打到别的符号上。
//    也不用「先插 `xm(` 再全文替换成别的名字」：pass-1 产物里本来就有 `function xm(...)`，
//    替换会连它的声明一起改，和解码器撞成重复声明。
//    做法：先挑一个**在 pass-1 产物里一次都没出现过**的长专名，编码时直接按这个名字发调用。
const decoderName = (() => {
  for (const name of ["xmAssetText", "xmCjkText", "xmDecodeText", "xmTextBlob"]) {
    if (!new RegExp(`\\b${name}\\b`).test(plain)) return name;
  }
  throw new Error("[bundle-backend] 找不到不冲突的解码器名字");
})();

// 3.5) 资产密钥：载荷为 XOR + 每包随机密钥（见 cjk-encode）。
//     密钥**不进** server.mjs：gen-asset-key 生成 32 字节，build.rs 烧进 exe，
//     外壳 spawn sidecar 时经 XM_ASSET_KEY 环境变量交给运行时。
//     拿到安装包的人要解提示词，得先从 exe 里把密钥挖出来。
const keyPath = join(root, "dist-desktop", "asset-key.txt");
if (!existsSync(keyPath)) {
  console.error("[bundle-backend] ✗ 找不到 dist-desktop/asset-key.txt——先跑 node scripts/gen-asset-key.mjs");
  process.exit(1);
}
const assetKey = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
if (assetKey.length < 16) {
  console.error(`[bundle-backend] ✗ asset-key.txt 解出 ${assetKey.length} 字节（<16），密钥文件损坏`);
  process.exit(1);
}

const { js: encoded, values } = encodeCjk(plain, { minCjk: DEFAULT_MIN_CJK, callName: decoderName, key: assetKey });
const encodedChars = values.reduce((sum, v) => sum + v.length, 0);
// 解码器：XOR 循环还原。密钥缺失/为空时**立即抛错**而不是解出乱码——
// 静默乱码会让用户看到满屏问号还以为数据坏了，明确报错才能一眼定位到"启动方式不对"。
// ⚠️ 外层 IIFE 必须是双参 `(m,k)=>b=>…`：写成柯里化 `m=>k=>b=>…` 的话外层只收一个实参，
// Buffer 会被静默丢掉，xmAssetText 第一次调用返回的是函数——p.exec 收到函数就是
// "The sql argument must be a string"（esbuild 语法门抓不到这种语义错）。
const decoder =
  `const ${decoderName}=((m,k)=>b=>{if(!k||!k.length)throw new Error("asset key missing (XM_ASSET_KEY)");` +
  `const h=m.get(b);if(h!==void 0)return h;` +
  `const x=Buffer.from(b,"base64");` +
  `for(let i=0;i<x.length;i++)x[i]^=k[i%k.length];` +
  `const t=x.toString("utf8");m.set(b,t);return t;})` +
  `(new Map(),Buffer.from(process.env.XM_ASSET_KEY||"","base64"));`;
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
//    整个 backend/ 都是 Tauri 的资源暂存区；cargo 只增量重建、Tauri 拷资源只增不删，
//    上一轮的残留（旧 .ts 源码、旧前端 chunk）会原样留进安装包——既浪费包体，
//    又把不在清单保护范围内的旧文件白送出去。
//    删掉后 tauri build 会按 tauri.conf.json 的 resources 重新拷一份干净的。
let swept = 0;
for (const profile of ["debug", "release"]) {
  const dir = join(root, "src-tauri", "target", profile, "backend");
  if (!existsSync(dir)) continue;
  rmSync(dir, { recursive: true, force: true });
  swept++;
}

  writeFileSync(out, final, "utf8");

/**
 * sharp 的运行期依赖闭包。
 *
 * 不能手写清单：sharp 还要 detect-libc 这类间接依赖，手写兜不全，要靠程序化递归收。
 * 顺着 package.json 的 dependencies 递归收；optionalDependencies 里那些按平台分的原生包
 * 只留本机这一个（npm 也只会装对本平台有效的那个，但仓库里可能残留别平台的目录，
 * 比如 sharp-wasm32 有 9MB，塞进安装包纯属浪费）。
 */
const FOREIGN_PLATFORM = /-(darwin|linux|win32|freebsd|android|openbsd|sunos)-(x64|arm64|arm|ia32|wasm32|loong64|ppc64|riscv64|mips)$/;
function sharpClosure() {
  const seen = new Set();
  const queue = ["sharp"];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = join(root, "node_modules", name);
    if (!existsSync(dir)) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { continue; }
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push(dep);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      if (FOREIGN_PLATFORM.test(dep) && !dep.endsWith(`${process.platform}-${process.arch}`)) continue;
      queue.push(dep);
    }
  }
  return [...seen];
}

/**
 * 把 sharp 的运行期依赖 stage 到 dist-desktop/backend-deps/node_modules。
 * tauri.conf 的 resources 把这个目录映射到安装后的 backend/node_modules，
 * 于是 backend/src/server.mjs 里的 import("sharp") 能顺着 node_modules 往上找得到。
 */
function stageSharpDeps() {
  const dest = join(root, "dist-desktop", "backend-deps", "node_modules");
  rmSync(dest, { recursive: true, force: true });
  if (!existsSync(join(root, "node_modules", "sharp"))) return { staged: [], bytes: 0, reason: "node_modules/sharp 不存在" };
  const staged = [];
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      bytes += statSync(file).size;
    }
  };
  for (const name of sharpClosure()) {
    const from = join(root, "node_modules", name);
    if (!existsSync(from)) continue;
    const to = join(dest, name);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(from, to, { recursive: true });
    walk(to);
    staged.push(name);
  }
  return { staged, bytes };
}

/**
 * 安装后目录里真的能派生吗？在仓库外搭一个和安装包同形状的目录跑一次。
 * 这条不能省：开发机上 node_modules 就在 bundle 旁边，怎么试都成功，
 * 只有把 server.mjs 挪到「backend/src + backend/node_modules」这个形状里才看得出缺什么。
 */
function verifyStagedInstall() {
  // 必须建在仓库外：留在 dist-desktop 里的话，ESM 找不到 staged 依赖时会一路向上
  // 摸到仓库自己的 node_modules 而侥幸成功，这条门就永远打不红（实测过：
  // 把依赖闭包砍成只剩 sharp、故意漏掉 detect-libc，仓库内的模拟照样通过）。
  const sim = join(tmpdir(), "xiaomo-install-sim-" + process.pid);
  rmSync(sim, { recursive: true, force: true });
  mkdirSync(join(sim, "backend", "src"), { recursive: true });
  cpSync(out, join(sim, "backend", "src", "server.mjs"));
  const deps = join(root, "dist-desktop", "backend-deps", "node_modules");
  if (!existsSync(deps)) return "没有 backend-deps/node_modules";
  cpSync(deps, join(sim, "backend", "node_modules"), { recursive: true });
  const probe = join(sim, "backend", "src", "probe.mjs");
  writeFileSync(probe, `
    const gif = Buffer.from("47494638376101000100800000FFFFFF00000021F90401000000002C00000000010001000002024401003B", "hex");
    const m = await import("sharp");
    const sharp = m.default ?? m;
    const png = await sharp(gif).png().toBuffer();
    const meta = await sharp(png).metadata();
    if ((meta.pages ?? 1) > 1) { console.error("多帧"); process.exit(1); }
    console.log("ok " + meta.width + "x" + meta.height);
  `, "utf8");
  const r = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 60_000 });
  rmSync(sim, { recursive: true, force: true });
  if (r.status !== 0) {
    // 挑得出人话的那一行，而不是 stderr 首行（首行往往是 node 的内部栈顶，读不出缺什么包）
    const text = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
    const line = text.split("\n").find((l) => /Cannot find|Cannot require|Error:|派生/.test(l))
      ?? text.split("\n").find((l) => l.trim() !== "")
      ?? "探针退出码 " + r.status;
    return line.trim();
  }
  return null;
}

const sharpDeps = stageSharpDeps();
const installProblem = sharpDeps.staged.length === 0 ? "没 stage 任何包" : verifyStagedInstall();

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
    assetKeyBytes: assetKey.length,
    assetKeyFingerprint: createHash("sha256").update(assetKey).digest("hex").slice(0, 12),
    sharpStaged: sharpDeps.staged,
    sharpStagedBytes: sharpDeps.bytes,
    installProbeOk: installProblem === null,
    installProbeError: installProblem ?? "",
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

// F：sharp 是源码里的运行期依赖，产物必须把它留成外部依赖、并且 stage 到位。
//    这条门专门防「开发机上看着一切正常、装到用户机器上 GIF 就静默发不出去」：
//    开发机上 node_modules 就在 bundle 旁边，解析永远成功，看不出 stage 有没有生效。
if (/@img\/sharp-/.test(String(final))) {
  fails.push("门 F：sharp 的 JS 被内联进产物了（产物里能看到 @img/sharp-* 包名表）——原生 .node 取不到，检查 esbuild 的 external");
}
if (sharpDeps.staged.length === 0) {
  fails.push(`门 F：没有 stage 任何 sharp 运行期包（${sharpDeps.reason ?? `缺 ${process.platform}-${process.arch} 的原生包`}），打包版派生动图静帧会不可用`);
}
// G：光 stage 了不算，得在「和安装包同形状的目录」里真跑一次派生——
//    手写依赖清单漏掉的包，只有这里能暴露。
if (installProblem !== null) {
  fails.push(`门 G：模拟安装目录里派生不出来 —— ${installProblem}`);
}

if (fails.length > 0) {
  console.error("[bundle-backend] ✗ 门没过：\n" + fails.map((f) => "  · " + f).join("\n"));
  process.exit(1);
}

const kb = Math.round(statSync(out).size / 1024);
console.log(
  `[bundle-backend] src/desktop.ts → dist-desktop/server.mjs（${kb} KB）：` +
  `压缩混淆 + ${values.length} 段中文资产已编码（${encodedChars} 字，含 ${assets.length} 条 >=${ASSET_MIN_CJK} 字提示词）；` +
  `产物汉字 ${plainCjk}→${finalCjk}，明文残留 0 段；` +
  `载荷 = base64(XOR(·, ${assetKey.length} 字节密钥))，密钥在 dist-desktop/asset-key.txt（随 exe 烧录）` +
  (swept ? `；顺带清掉 ${swept} 处资源暂存目录（含旧 .ts 与陈旧前端产物）` : ""),
);
