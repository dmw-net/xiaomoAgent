// Android APK 补丁：把 0 字节的 native 库替换成真实产物。
//
// 【为什么需要这个脚本】
// `tauri android build` 把 Rust 编译出的 libxiaomo_ai_lib.so **符号链接**到
// gen/android/app/src/main/jniLibs/<abi>/ 下。在部分文件系统（Windows + 某些沙箱/同步盘）
// 上，这个符号链接会退化成 **0 字节的普通文件**，并被原样打进 APK。
//
// 后果很隐蔽：构建**成功**、APK **能装**，但一打开就闪退（native 库加载失败），
// 而且 `unzip -l` 看到的 Length 是 0，很容易被当成正常现象跳过。
//
// 这个脚本做的事：
//   1. 找到磁盘上真实的 libxiaomo_ai_lib.so；
//   2. 检查 APK 里对应条目的真实大小（用 zip 元数据，不是看列表）；
//   3. 如果确实是 0，就用真实内容替换掉那个条目。
//
// 用法：
//   node scripts/patch-apk-native.mjs [apk路径]
//   不给参数则自动找 gen/android/app/build/outputs/apk/universal/debug/*.apk

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

/** 真实产物：Rust 编出来的 .so（不在 jniLibs 里，那个是坏掉的副本）。 */
function findRealSo() {
  const candidates = [
    join(projectRoot, "src-tauri", "target", "aarch64-linux-android", "debug", "libxiaomo_ai_lib.so"),
    join(projectRoot, "src-tauri", "target", "aarch64-linux-android", "release", "libxiaomo_ai_lib.so"),
  ];
  for (const path of candidates) {
    if (existsSync(path) && statSync(path).size > 0) return path;
  }
  throw new Error("找不到真实的 libxiaomo_ai_lib.so，先跑一次 android:build");
}

/** 自动定位 APK：递归找，因为 Gradle 的输出层级会随 ABI 变化。 */
function findApk() {
  const base = join(projectRoot, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
  if (!existsSync(base)) throw new Error(`没有产出目录：${base}`);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".apk")) found.push(path);
    }
  };
  walk(base);
  if (found.length === 0) throw new Error("没找到 .apk，先跑一次 android:build");
  // 多个就取最新的那个。
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const apkPath = process.argv[2] || findApk();
const realSo = findRealSo();

console.log(`[patch-apk] APK      : ${apkPath}`);
console.log(`[patch-apk] 真实产物 : ${realSo}（${(statSync(realSo).size / 1024 / 1024).toFixed(1)} MB）`);

// 用 Python 的 zipfile 做替换。
// 理由：Node 没有内置改 zip 条目的能力；引第三方库又违背本项目的零依赖原则。
// Python 的 zipfile 是标准库，机器上一定有。
const script = `
import sys, zipfile, shutil, os

apk, real_so = sys.argv[1], sys.argv[2]
target_suffix = "libxiaomo_ai_lib.so"

z = zipfile.ZipFile(apk)
names = [n for n in z.namelist() if n.endswith(target_suffix) and n.startswith("lib/")]
if not names:
    print("[patch-apk] 失败：APK 里没有 " + target_suffix)
    sys.exit(2)

# 检查当前大小（用元数据，不是列表显示的近似值）
need_patch = False
for n in names:
    info = z.getinfo(n)
    print(f"[patch-apk] {n}: 当前 {info.file_size} 字节")
    if info.file_size == 0:
        need_patch = True

if not need_patch:
    print("[patch-apk] 无需修补，native 库已经正常")
    sys.exit(0)

# 重建 zip：除目标条目外全部原样复制，目标条目换成真实文件。
tmp = apk + ".patched"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
    for item in z.infolist():
        if item.filename in names:
            out.write(real_so, item.filename)
        else:
            out.writestr(item, z.read(item.filename))
z.close()

shutil.move(tmp, apk)
print("[patch-apk] 已修补完成")
`;

const py = process.env.PYTHON || "python";
try {
  const output = execFileSync(py, ["-c", script, apkPath, realSo], { encoding: "utf8" });
  process.stdout.write(output);
} catch (error) {
  console.error("[patch-apk] 修补失败：", error.message);
  process.exit(1);
}

// 修补后必须重新验证，否则等于没做。
const verify = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
size = 0
for n in z.namelist():
    if n.endswith("libxiaomo_ai_lib.so"):
        size = z.getinfo(n).file_size
print(f"[patch-apk] 验证：native 库现在 {size / 1024 / 1024:.1f} MB" + ("  ✅" if size > 0 else "  ❌ 仍然是 0"))
sys.exit(0 if size > 0 else 1)
`;
try {
  process.stdout.write(execFileSync(py, ["-c", verify, apkPath], { encoding: "utf8" }));
} catch {
  console.error("[patch-apk] 验证失败");
  process.exit(1);
}
void openSync;
void readSync;
void closeSync;
