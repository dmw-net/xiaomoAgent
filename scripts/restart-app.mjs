// 一键重启桌面端（安装版）：`npm run restart` 一条命令覆盖前后端日常更新，不用 pack:dev 重装。
//
// 为什么不用重装：安装的壳是 --debug 构建，lib.rs 的 resource_script_path 在
// debug 构建下优先跑仓库里的 src/desktop.ts 源码，前端也从项目的 frontend/dist
// 按请求读盘。所以本脚本做三件事：
//   1. 前端源码比 dist 新（或 --force）→ 自动 `fe:build`（--no-build 可跳过）；
//   2. 杀壳与 sidecar（强杀后 sidecar 可能残留，两个都点名的）；
//   3. 拉起并轮询 runtime.json 握手，直到 /healthz 就绪。
// 后端没有构建步骤（sidecar 直接跑 TS 源码）。pack:dev 只在改壳（src-tauri）、
// 发布或换机器时才需要。
//
// exe 定位顺序：正在运行的进程（最准）→ XIAOMO_APP_EXE 环境变量 → 常见安装位。
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_DATA = join(process.env.APPDATA ?? "", "app.xiaomo.ai");
const SKIP_BUILD = process.argv.includes("--no-build");
const FORCE_BUILD = process.argv.includes("--force");

function exeFromRunningProcess() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='xiaomo-ai.exe'\\" | Select-Object -First 1 -ExpandProperty ExecutablePath)"`,
      { encoding: "utf8", timeout: 15_000 },
    ).trim();
    return out !== "" && existsSync(out) ? out : null;
  } catch { return null; }
}

function guessExePaths() {
  const candidates = [];
  if (process.env.XIAOMO_APP_EXE) candidates.push(process.env.XIAOMO_APP_EXE);
  // 常见安装位：盘符根/软件目录的自定义安装。找不到再让用户用环境变量指路。
  for (const drive of ["D:", "E:", "F:", "C:"]) {
    candidates.push(join(drive, "\\software\\小茉\\xiaomo-ai.exe"));
    candidates.push(join(drive, "\\Program Files\\小茉\\xiaomo-ai.exe"));
    candidates.push(join(drive, "\\Program Files\\xiaomo\\xiaomo-ai.exe"));
  }
  candidates.push(join(process.env.LOCALAPPDATA ?? "", "Programs", "xiaomo", "xiaomo-ai.exe"));
  return candidates.filter((p) => existsSync(p));
}

function newestMtimeUnder(dir, acc) {
  let latest = acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) latest = newestMtimeUnder(full, latest);
    else if (st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return latest;
}

// 前端是否需要构建：源码（含根 index.html）里最新的 mtime 比 dist/index.html 新就算需要。
// 留 2s 容差吸收 git 操作 / 拷贝带来的 mtime 抖动。
function frontendStale() {
  const root = join(import.meta.dirname ?? ".", "..");
  const src = join(root, "frontend", "src");
  const srcHtml = join(root, "frontend", "index.html");
  const distHtml = join(root, "frontend", "dist", "index.html");
  if (!existsSync(src) || !existsSync(distHtml)) return false;
  const srcNewest = Math.max(newestMtimeUnder(src, 0), existsSync(srcHtml) ? statSync(srcHtml).mtimeMs : 0);
  return srcNewest > statSync(distHtml).mtimeMs + 2_000;
}

// 前端构建是重启的一部分：源码有变（或 --force）就重建，失败立刻停——
// 带着旧界面重启，用户会以为改的代码没生效，比失败难排查得多。
function buildFrontendIfNeeded() {
  if (SKIP_BUILD) {
    console.log("（--no-build：跳过前端构建）");
    return;
  }
  if (!FORCE_BUILD && !frontendStale()) {
    console.log("前端 dist 已是最新，跳过构建。");
    return;
  }
  console.log("构建前端（frontend/dist）…");
  try {
    execSync("npm --prefix frontend run build", {
      cwd: join(import.meta.dirname ?? ".", ".."),
      stdio: "inherit",
      timeout: 300_000,
    });
  } catch (error) {
    console.error("❌ 前端构建失败，已取消重启（避免拿旧界面掩盖问题）：");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function killApp() {
  for (const name of ["xiaomo-ai.exe", "node-sidecar.exe"]) {
    try { execSync(`taskkill /IM ${name} /F /T`, { stdio: "ignore", timeout: 15_000 }); } catch { /* 本来就没在跑 */ }
  }
  // 强杀后端口释放可能滞后半拍，等干净再拉起。
  execSync("ping -n 3 127.0.0.1 > nul", { stdio: "ignore" });
}

function main() {
  buildFrontendIfNeeded();
  const exe = exeFromRunningProcess() ?? guessExePaths()[0] ?? null;
  if (exe === null) {
    console.error("找不到 xiaomo-ai.exe：应用没在跑、常见安装位也没有。");
    console.error("用环境变量指路再跑一次：XIAOMO_APP_EXE=\"D:\\path\\to\\xiaomo-ai.exe\" npm run restart");
    process.exit(1);
  }
  console.log("重启桌面端：", exe);
  killApp();
  // 分离启动：脱离本进程，关掉终端也不影响应用。
  spawn("cmd", ["/c", "start", "", exe], { detached: true, stdio: "ignore" }).unref();

  // 等握手：sidecar 起来后会把端口写进 runtime.json，healthz 通了才算真就绪。
  const runtimeFile = join(APP_DATA, "runtime.json");
  const deadline = Date.now() + 45_000;
  const tick = () => {
    try {
      const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
      if (typeof runtime.port === "number") {
        const health = execSync(
          `curl -s -m 2 http://127.0.0.1:${runtime.port}/healthz`,
          { encoding: "utf8", timeout: 5_000 },
        );
        if (health.includes("\"ok\":true")) {
          console.log(`✅ 已就绪：http://127.0.0.1:${runtime.port}（sidecar pid ${runtime.pid}）`);
          return;
        }
      }
    } catch { /* 还没起来，继续等 */ }
    if (Date.now() > deadline) {
      console.error("❌ 45 秒内没等到 healthz 就绪——看应用数据目录里的 backend.log 排查。");
      process.exit(1);
    }
    setTimeout(tick, 1_000);
  };
  tick();
}

main();
