// 卸载钩子的端到端测试：在 %TEMP% 里造一个隔离的 NSIS 包，静默装 → 静默卸 → 断言 result.log。
//
//   node scripts/test-uninstall-hooks.mjs
//
// 为什么值得单独立一个：这个钩子的失败模式是"把用户全部聊天记录删了"或"勾了却没删"，
// 两种都只能靠真跑卸载器才看得见。夹具全在 %TEMP%\xiaomo-hooktest 下，
// 测试用的 BUNDLEID 是 xiaomo-hooktest，真实 %APPDATA%\app.xiaomo.ai 不参与。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const nsisDir = process.env.NSIS_DIR ?? path.join(os.homedir(), "AppData", "Local", "tauri", "NSIS");
const makensis = path.join(nsisDir, "Bin", "makensis.exe");
if (!existsSync(makensis)) {
  console.error(`✗ 找不到 makensis：${makensis}\n   （先跑一次 npm run desktop:build，让 tauri 把 NSIS 工具拉下来）`);
  process.exit(1);
}

const work = mkdtempSync(path.join(os.tmpdir(), "xm-hooktest-"));
const script = path.join(root, "src-tauri", "nsis", "hooktest.nsi");
const exe = path.join(work, "hooktest.exe");
const installDir = path.join(os.tmpdir(), "xiaomo-hooktest", "install");

// 上一次的夹具与日志先清干净，免得"文件还在"被当成"没删"
rmSync(path.join(os.tmpdir(), "xiaomo-hooktest"), { recursive: true, force: true });

// -WX：把警告当错误。BUNDLEID 之类"定义晚了"的问题会以 warning 6000 出现，放过就等于没测。
// -XOutFile：脚本里的 OutFile 是相对**脚本所在目录**解析的（实测会把 exe 吐进 src-tauri/nsis/），
// 这里强制指到临时目录，仓库里不留构建产物。
const build = spawnSync(makensis, ["-WX", `/DHOOKTEST_OUT=${exe}`, script], { encoding: "utf8", cwd: work });
if (build.status !== 0) {
  console.error("✗ makensis 失败：\n" + (build.stdout ?? "") + (build.stderr ?? ""));
  process.exit(1);
}
if (!existsSync(exe)) {
  console.error(`✗ 编译说成功，但 ${exe} 不在（别信退出码，信文件）`);
  process.exit(1);
}
console.log("· 测试包已编译");

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
run(exe, ["/S"]);
const uninst = path.join(installDir, "uninst-test.exe");
if (!existsSync(uninst)) {
  console.error(`✗ 静默安装后没生成卸载器：${uninst}`);
  process.exit(1);
}
run(uninst, ["/S"]);

// NSIS 卸载器会把自己复制到临时目录后台跑，父进程立刻返回 → 只能等日志写满 5 行
const logPath = path.join(installDir, "result.log");
let text = "";
for (let i = 0; i < 60; i++) {
  if (existsSync(logPath)) {
    text = readFileSync(logPath, "utf8");
    if (text.includes("c5-fallback-delete")) break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
const lines = text.split(/\r?\n/);
if (lines.length < 5) {
  console.error(`✗ 日志太少（${lines.length} 行），卸载器可能根本没跑到用例。原文：\n${text}`);
  process.exit(1);
}

const want = [
  ["c1-update-keep", "更新覆盖装必须不删"],
  ["c2-checked-delete", "勾选且非更新必须删"],
  ["c3-unchecked-keep", "未勾选必须不删"],
  ["c4-guard-reject", "护栏不认的目录必须不删"],
  ["c5-fallback-delete", "指针缺失必须回退默认位置并删"],
];
let bad = 0;
for (const [tag, why] of want) {
  // 判定行形如 "c2-checked-delete OK|dir=..."（结论在竖线前，别按 "tag|" 前缀找）
  const line = lines.find((l) => l.startsWith(tag + " ") || l.startsWith(tag + "|"));
  if (!line) { console.log(`  ✗ 缺用例 ${tag} —— ${why}`); bad += 1; continue; }
  const ok = line.includes("OK");
  console.log(`${ok ? "  ✓" : "  ✗"} ${tag.padEnd(22)} ${why}${ok ? "" : " ← " + line}`);
  if (!ok) bad += 1;
}
// 反证：护栏那条必须真的报出拒绝码（日志里的 reason 是 ASCII 短码，中文原因只弹给用户看——
// NSIS 写文件按系统代码页落盘，外部读回来是乱码，断言不能靠它）
const spoke = /reason=no-db/.test(text);
console.log(`  ${spoke ? "✓" : "✗"} c4 的拒绝码可见：${(text.match(/reason=[^\r\n]*/g) ?? ["（没有 reason 行）"]).join(" ")}`);
if (!spoke) bad += 1;

rmSync(work, { recursive: true, force: true });
rmSync(path.join(os.tmpdir(), "xiaomo-hooktest"), { recursive: true, force: true });
console.log(bad === 0 ? "\n卸载钩子：全部通过 ✅" : `\n卸载钩子：${bad} 项失败 ❌`);
process.exit(bad === 0 ? 0 : 1);
