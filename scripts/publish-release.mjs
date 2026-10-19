// 发版：把当前代码打成 Windows 安装包，发布到公开发布仓（只放附件，不含源码）。
//
//   node scripts/publish-release.mjs [--dry-run] [--skip-build] [--notes 文本]
//
// 三道门是刻意的，都对应真出过的事故：
//   1. 三处版本号必须完全一致（根 package.json / tauri.conf.json / Cargo.toml）。
//      不一致时"检查更新"会拿系统报告的版本和 latest.json 比，界面显示旧版却装新版，反复重装。
//   2. 只发非 draft、非 prerelease：GitHub 的 releases/latest 不认 prerelease，
//      标错一下等于对所有用户关闭更新。
//   3. 传完必须匿名拉回来验：latest.json 解析得出、版本号对得上、里面的 url 能下到手。
//      上传成功不等于用户拿得到——路径编码、重名资产、仓被改私有都会在这一步露出来。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_REPO = "dmw-net/xiaomoAgent";
// 上传用的资产一律 ASCII 名：productName 保持「小茉」（装了以后快捷方式/注册表键都认它），
// 只有 GitHub 上的文件名换成 xiaomo，免得中文路径在备用源/下载工具里出岔子。
const ASSET_STEM = "xiaomo";
// 定义在这儿而不是下面：--verify-only 那条路会在打包之前就用它（挪在后面会撞 TDZ，实测踩过）。
const LATEST_JSON = `https://github.com/${RELEASE_REPO}/releases/latest/download/latest.json`;
// 端上取清单里哪个键由 Rust 侧 target() 决定：`{os}-{arch}`，Windows x64 → windows-x86_64。
// 写成 windows-x64 是我第一次发版踩的坑，而且当时的自检读的是同一个错键（自证式检查，测不出东西），
// 所以这里把它提成常量，清单与自检都从这一处取，并在自检里额外断言"线上清单的键必须包含它"。
const PLATFORM_KEY = "windows-x86_64";

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readJson(relative) {
  const file = path.join(root, relative);
  if (!existsSync(file)) die(`找不到 ${relative}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Cargo.toml 里 [package] 段那一行 version。按段切，别用第一个中括号前的内容——那是注释。 */
function cargoVersion() {
  const text = readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
  const block = /\[package\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(text);
  if (!block) die("Cargo.toml 里没有 [package] 段");
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(block[1]);
  if (!m) die("Cargo.toml 的 [package] 段里没有 version");
  return m[1];
}

/**
 * shell 只在调 npm 时开（Windows 上 npm 是 npm.cmd，不开 shell 起不来）。
 * gh 是 .exe，走 shell:false——开 shell 会把参数拼成一行交给 cmd.exe，中文参数就会按
 * 控制台代码页重编码，那是这台机上反复咬过人的坑（见 docs/packaging.md 末尾）。
 */
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root, encoding: "utf8", shell: cmd === "npm", ...options,
  });
  if (r.error) die(`${cmd} 起不来：${r.error.message}`);
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skipBuild = argv.includes("--skip-build");
const verifyOnly = argv.includes("--verify-only");
const notesIdx = argv.indexOf("--notes");

// ── 门 1：三处版本一致 ────────────────────────────────────────────
const versions = {
  "package.json": readJson("package.json").version,
  "tauri.conf.json": readJson("src-tauri/tauri.conf.json").version,
  "Cargo.toml": cargoVersion(),
};
const unique = [...new Set(Object.values(versions))];
if (unique.length !== 1) {
  die(`三处版本号不一致，改齐再来：\n${Object.entries(versions).map(([k, v]) => `   ${k} = ${v}`).join("\n")}`);
}
const version = unique[0];
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`版本号 ${version} 不是 x.y.z 形式`);
const tag = `v${version}`;
console.log(`· 版本 ${version}（三处一致）→ 发布 ${RELEASE_REPO} 的 ${tag}`);

// 不传 --notes 也给一句：release 正文空着，README 里"去 Releases 页看每个版本的更新说明"就落空了
// （首发那次实测就是空的）。定义放在版本门之后——之前放上面会撞 TDZ。
const notes = notesIdx >= 0 ? (argv[notesIdx + 1] ?? "") : `小茉 v${version} 更新。`;

// ── 门 2：更新端点与公钥必须在配置里 ─────────────────────────────
const conf = readJson("src-tauri/tauri.conf.json");
if (conf.bundle?.createUpdaterArtifacts !== true) die("tauri.conf.json 没开 bundle.createUpdaterArtifacts，打出来的包不会有 .sig");
const updater = conf.plugins?.updater;
if (!updater?.pubkey || !Array.isArray(updater.endpoints) || updater.endpoints.length === 0) {
  die("tauri.conf.json 的 plugins.updater 缺 pubkey 或 endpoints");
}
console.log(`· 更新端点 ${updater.endpoints.length} 条：${updater.endpoints.join(" , ")}`);

// 签名密钥：默认取 %USERPROFILE%\.tauri\xiaomo-updater.key（不进仓、不进包）。
const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
  ?? path.join(os.homedir(), ".tauri", "xiaomo-updater.key");
if (!existsSync(keyPath)) die(`找不到更新签名私钥：${keyPath}\n   新生成（交互式输入口令，别把口令写进命令行或聊天）：\n   cargo tauri signer generate -w "${keyPath}" -f`);

if (dryRun) {
  console.log("✓ 预检通过（--dry-run：不打包、不上传）");
  process.exit(0);
}

if (verifyOnly) {
  const v = await verifyRelease(version, stageSignature(version));
  if (!v.ok && v.definitive) die(`自检未通过：${v.why}`);
  if (!v.ok) console.log(`⚠ 仓侧四条资产齐，但用户侧这台机没法判：${v.why}\n   开代理重跑：npm run release -- --verify-only`);
  else console.log(`✓ 自检通过：安装包可下载 ${(v.bytes / 1048576).toFixed(1)} MB`);
  process.exit(0);
}

// 口令两条来源（与 npm run pack 同一约定）：
//   1) 环境变量 TAURI_SIGNING_PRIVATE_KEY_PASSWORD（CI / 临时用）
//   2) TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE，或同目录的 xiaomo-updater.pass
// 都不给也不默认成空串：这把私钥带口令，让签名那步如实报错，而不是拿空口令去解。
const passPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE
  ?? path.join(os.homedir(), ".tauri", "xiaomo-updater.pass");
let pass = (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "").trim();
let passFrom = "环境变量 TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
if (pass === "" && existsSync(passPath)) {
  pass = readFileSync(passPath, "utf8").trim();
  passFrom = passPath;
}
console.log(`· 口令来源：${passFrom}`);

// 门 0：花两秒先试签一次。首发实测过——私钥或口令不对时，它会把三分钟构建全跑完，
// 只在最后一步报 "no private key"，包打出来了却没有 .sig（等于白跑一趟还得再来一次）。
const sigProbe = path.join(os.tmpdir(), `xiaomo-sigcheck-${process.pid}.bin`);
writeFileSync(sigProbe, "xiaomo publish preflight");
const sign = run(process.execPath, [path.join("scripts", "tauri.mjs"), "signer", "sign",
  "-f", keyPath, "-p", pass, sigProbe]);
rmSync(sigProbe, { force: true });
rmSync(`${sigProbe}.sig`, { force: true });
if (sign.code !== 0) die(`签名预检失败（退出码 ${sign.code}）：私钥 ${keyPath} 配当前口令签不出东西。\n`
  + `   CLI 的原始输出打在上方：口令缺失/不对是 "Wrong password for that key"，\n`
  + `   看到 "Usage: cargo-tauri signer sign ..." 则是参数冲突（-f 与环境里的 TAURI_SIGNING_PRIVATE_KEY 不能同给）。\n`
  + `   带上口令重跑：设 TAURI_SIGNING_PRIVATE_KEY_PASSWORD，或把口令写到 ${passPath}`);
console.log("✓ 门 0：私钥能签（口令正确）");

// 预检过了才注入给构建用。tauri 的打包签名只读 TAURI_SIGNING_PRIVATE_KEY，而且要的是
// **私钥文件内容**本身；`signer generate` 提示里的 _PATH 只给独立签名命令用——实测踩过：
// 设了 _PATH 照样报 "A public key has been found, but no private key"，包打完了却没 .sig。
// 顺序也不能反：这一经 env 之后，再拿 -f 去调 signer sign 会撞 clap 的 Usage 错。
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8");
// 口令同样要交给构建链：desktop:build 里的 make-manifest 也从环境变量拿它。
// 不写回去的话——预检过了、构建到签名那一步照样失败（实测踩过）。
if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = pass;

// ── 打包 ─────────────────────────────────────────────────────────
if (!skipBuild) {
  console.log("· 打包（desktop:build，几分钟）");
  const r = run("npm", ["run", "desktop:build"], { stdio: "inherit" });
  if (r.code !== 0) die(`desktop:build 退出码 ${r.code}`);
}

const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
if (!existsSync(nsisDir)) die(`没有产物目录：${nsisDir}`);
// 按版本后缀认，不认前缀——前缀是 productName，中文，随人改。
const built = readdirSync(nsisDir).filter((f) => f.endsWith(`_${version}_x64-setup.exe`));
if (built.length !== 1) die(`预期恰好一个 ${version} 的 x64 安装包，实际 ${built.length} 个：${built.join(", ")}`);
const sigFile = `${built[0]}.sig`;
if (!existsSync(path.join(nsisDir, sigFile))) die(`安装包没有配套的 ${sigFile}——私钥没生效？`);

// ── 换 ASCII 名 + 生成 latest.json ────────────────────────────────
const stage = path.join(root, "src-tauri", "target", "release", "publish");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const asciiName = `${ASSET_STEM}_${version}_x64-setup.exe`;
const stableName = `${ASSET_STEM}-latest-win-x64.exe`;
copyFileSync(path.join(nsisDir, built[0]), path.join(stage, asciiName));
copyFileSync(path.join(nsisDir, sigFile), path.join(stage, `${asciiName}.sig`));
copyFileSync(path.join(nsisDir, built[0]), path.join(stage, stableName));

const signature = readFileSync(path.join(nsisDir, sigFile), "utf8").trim();
const downloadUrl = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${asciiName}`;
const manifest = {
  // 写 x.y.z 或带 v 都行——端上用 `Version::from_str(s.trim_start_matches('v'))` 解析
  // （updater.rs:1889）。这里跟 git tag 区分开：tag 带 v，清单里的值是纯版本号。
  version,
  // 字段名是 pub_date（不是 date），且必须 RFC3339，否则整个清单解析失败：updater.rs:1840-1846。
  pub_date: new Date().toISOString(),
  // 平台键 = `{os}-{arch}`，Windows x64 是 windows-x86_64（updater.rs:1748-1777 的 target()）。
  // 写成 windows-x64 的话端上会走到"该版本比我新，但这个平台没有条目"→ 报错，更新永远到不了。
  platforms: { [PLATFORM_KEY]: { signature, url: downloadUrl } },
};
manifest.notes = notes;
writeFileSync(path.join(stage, "latest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
writeFileSync(path.join(stage, "NOTES.md"), notes + "\n", "utf8");
console.log(`· 暂存 ${stage}：${asciiName} / .sig / ${stableName} / latest.json`);

// ── 上传 ─────────────────────────────────────────────────────────
const assets = [
  path.join(stage, asciiName),
  path.join(stage, `${asciiName}.sig`),
  path.join(stage, stableName),
  path.join(stage, "latest.json"),
];
const has = run("gh", ["release", "view", tag, "--repo", RELEASE_REPO]);
const args = has.code === 0
  ? ["release", "upload", tag, ...assets, "--repo", RELEASE_REPO, "--clobber"]
  : ["release", "create", tag, ...assets, "--repo", RELEASE_REPO, "--title", tag];
if (has.code === 0) console.log(`· ${tag} 已存在，覆盖同名资产`);
if (notes !== "" && has.code !== 0) args.push("--notes-file", path.join(stage, "NOTES.md"));
const up = run("gh", args);
if (up.code !== 0) die(`gh 上传失败（退出码 ${up.code}）：\n${up.out}`);
console.log(`· 已发布 ${tag}`);
// 改了已在版本号的 latest.json 时别指望立刻生效：GitHub 对 `releases/download/<tag>/<name>`
// 有边缘缓存（实测 Age 477 秒，删掉资产重传也不 bust——缓存键是 release+资产名，不是资产 id）。
// 所以"自检拉到旧内容"是等一等再 `--verify-only`，不是重复发布。

// ── 门 3：发布后自检，分两层 ───────────────────────────────────────
// 仓侧走 api.github.com（这台机上稳，gh 一直是通的）：四条资产齐不齐、有没有被标成 draft/prerelease。
// 用户侧走 github.com 的下载端点，而 node 的 fetch **不读系统代理**、本机直连它时通时不通，
// 所以"拉不到"分两种：拿到 HTTP 状态码 = 真坏了（判红）；连接层失败 = 本机没法判（判黄）。
// 混成一个红绿灯会让人重复发布，或者把"资产名打错"这种真故障当成网络问题放过去。
function stageSignature(v) {
  const f = path.join(root, "src-tauri", "target", "release", "publish", `${ASSET_STEM}_${v}_x64-setup.exe.sig`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
}

async function verifyRelease(expected, localSignature) {
  const rv = run("gh", ["release", "view", `v${expected}`, "--repo", RELEASE_REPO,
    "--json", "tagName,isDraft,isPrerelease,assets"]);
  if (rv.code !== 0) return { ok: false, definitive: true, why: `gh 读不回 v${expected}：${rv.out.trim()}` };
  let info;
  try {
    info = JSON.parse(rv.out);
  } catch {
    return { ok: false, definitive: true, why: `gh 返回的不是 JSON：${rv.out.slice(0, 120)}` };
  }
  const names = (info.assets ?? []).map((a) => a?.name ?? "");
  const need = [`${ASSET_STEM}_${expected}_x64-setup.exe`, `${ASSET_STEM}_${expected}_x64-setup.exe.sig`,
    `${ASSET_STEM}-latest-win-x64.exe`, "latest.json"];
  const missing = need.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    return { ok: false, definitive: true, why: `release 缺资产 ${missing.join(" / ")}（实际 ${names.join(", ") || "一条都没有"}）` };
  }
  if (info.isDraft) return { ok: false, definitive: true, why: "release 是 draft：releases/latest 不认，所有用户收不到更新" };
  if (info.isPrerelease) return { ok: false, definitive: true, why: "release 被标成 prerelease：releases/latest 不认" };
  console.log(`✓ 仓侧：v${expected} 四条资产齐、非 draft、非 prerelease`);

  let last = { verdict: "unknown", why: "没有重试机会" };
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(LATEST_JSON, { redirect: "follow", headers: { "User-Agent": "xiaomo-publish-check" } });
      if (res.ok) last = { verdict: "ok", got: JSON.parse(await res.text()) };
      else last = { verdict: "bad", why: `latest.json HTTP ${res.status}` };
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message;
      last = { verdict: "unknown", why: cause ? `${error.message}（${cause}）` : String(error) };
    }
    if (last.verdict !== "ok" && i < 2) {
      console.log(`· 用户侧第 ${i + 1} 次没拉到（${last.why}），4 秒后重试`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  if (last.verdict !== "ok") return { ok: false, definitive: last.verdict === "bad", why: last.why };

  const got = last.got;
  if (got.version !== expected) {
    return { ok: false, definitive: true, why: `releases/latest 指的是 ${got.version}，不是 ${expected}` };
  }
  const keys = Object.keys(got?.platforms ?? {});
  if (!keys.includes(PLATFORM_KEY)) {
    return { ok: false, definitive: true, why: `清单里的平台键是 ${keys.join(",") || "空"}，端上要的是 ${PLATFORM_KEY}（target() 拼出来的那个）` };
  }
  const entry = got.platforms[PLATFORM_KEY];
  if (localSignature !== null && (entry.signature ?? "") !== localSignature) {
    return { ok: false, definitive: true, why: "线上清单里的签名与本地 .sig 不一致" };
  }
  const exe = await fetch(entry.url ?? "about:blank", {
    redirect: "follow", method: "HEAD", headers: { "User-Agent": "xiaomo-publish-check" },
  });
  if (!exe.ok) return { ok: false, definitive: true, why: `清单能拉到，但安装包 url 是 HTTP ${exe.status}：${entry.url}` };
  return { ok: true, bytes: Number(exe.headers.get("content-length") ?? 0), url: entry.url };
}

const probe = await verifyRelease(version, signature);
if (probe.ok) {
  console.log(`✓ 用户侧：匿名拉到清单，安装包可下载 ${(probe.bytes / 1048576).toFixed(1)} MB → ${probe.url}`);
} else if (probe.definitive) {
  die(`包已上传到 ${tag}，但自检判定失败：${probe.why}\n`
    + `   这一步才是"用户拿不拿得到"的裁判；先修它，别重复发布。`);
} else {
  console.log(`⚠ 用户侧本机没法判（直连 github.com 不通：${probe.why}）。仓侧四条资产已确认。\n`
    + `   开代理单独重验：npm run release -- --verify-only`);
}
console.log(`\n下一步：装一份旧版本点「检查更新」验链路；私钥备份在 ${keyPath}，丢了就只能让用户手动重装。`);
