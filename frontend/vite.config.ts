import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// 版本号取自根 package.json，构建时注入，避免与后端版本漂移。
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * 前端产物混淆（只在 build 生效，dev 不受影响）。
 *
 * 为什么只混淆业务 chunk、**不碰 vendor**：React 运行时被混淆后报错栈会彻底不可读，
 * 线上排障成本远超收益；而业务 chunk 才是"抄交互"的人真正要读的东西。
 *
 * 为什么用保守档：`controlFlowFlattening` / `deadCodeInjection` 会打乱执行结构，
 * 在 React 函数组件里容易把 hook 顺序改坏（表现为偶发白屏，极难定位）；
 * `selfDefending` 会让产物在严格 CSP 或二次格式化时直接失效——本应用的 CSP 就是严格的。
 *
 * 为什么固定 seed：默认每次随机，同一份源码两次构建产出不同字节。那会让
 * 「manifest 是上一次构建算的」这类问题变得极难排查，也让产物无法 diff。
 *
 * 边界（诚实版）：这是抬高成本，不是加密。认真还原的人仍能反混淆；
 * 它挡的是"打开文件就能改文案、抄接口"这一层。
 */
function obfuscate(): Plugin {
  return {
    name: "xm-obfuscate",
    apply: "build",
    enforce: "post",
    // ⚠️ 必须用 generateBundle，不能用 renderChunk。
    // renderChunk 阶段产物里还留着 Rollup 的 chunk 名占位符（形如 `./StatusView-!~{005}~.js`），
    // 要到 generateBundle 才被替换成真实文件名。如果在 renderChunk 里就把这些字符串
    // 编码进字符串数组，Rollup 之后再也找不到占位符 → 运行时动态 import 全部 404，
    // 表现是白屏 + "Failed to fetch dynamically imported module"。
    // 实测踩过：静态语法检查、跨 chunk 导入交叉校验全绿，只有真跑浏览器才暴露。
    async generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        if (!fileName.endsWith(".js")) continue;
        if (fileName.includes("vendor")) continue;
        const { default: Obfuscator } = await import("javascript-obfuscator");
        const obfuscated = Obfuscator.obfuscate(chunk.code, {
          seed: 20261017,
          compact: true,
          simplify: true,
          stringArray: true,
          // 1.0 而不是默认的 0.75：实测 0.75 会留约 3500 个汉字明文在产物里
          // （界面文案全可读 = 这一层等于白做）。代价是产物变大、首屏多几十次数组取值，
          // 对本应用这种体量（业务 chunk 合计 ~400KB）可以忽略。
          stringArrayThreshold: 1,
          stringArrayEncoding: ["base64"],
          stringArrayRotate: true,
          stringArrayShuffle: true,
          identifierNamesGenerator: "hexadecimal",
          controlFlowFlattening: false,
          deadCodeInjection: false,
          selfDefending: false,
          disableConsoleOutput: false,
        }).getObfuscatedCode();
        // 再压一遍：混淆器产出的 `_0x...` 标识符比压缩后的短名长得多，不压会白涨 ~40%。
        // 放在混淆之后是安全的（esbuild 语义等价），也让体积回到接近未混淆时的水平。
        const { transform } = await import("esbuild");
        const min = await transform(obfuscated, {
          minify: true,
          legalComments: "none",
          target: "es2021",
        });
        chunk.code = min.code;
      }
    },
  };
}

// 前端子项目：只管界面，/api 代理给 8787 的零依赖后端。
// 根目录的 npm run dev / start 会先 build 本项目部口、再由后端静态托管（打开 8787 即完整应用）；
// 只有想要 HMR 热更新时，才另开终端跑这里的 dev（5173）——它只把 /api 代理到 8787。
//
// `--mode fast` = 跳过混淆：`npm run dev`（浏览器开发）和 `npm run app`（桌面开发）都用它，
// 这两条命令每次都重新构建前端，混淆会让 5 秒变 13 秒、且产物不可读（报错栈没法看）。
// 出包链（desktop:build / pack）不传这个 mode，走默认的混淆构建。
export default defineConfig(({ mode }) => ({
  plugins: mode === "fast" ? [react()] : [react(), obfuscate()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // react 运行时单独一档：改业务代码不该让用户重下一遍 vendor
        manualChunks: { vendor: ["react", "react-dom"] },
      },
    },
  },
}));
