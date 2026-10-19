// 版本号的唯一入口。
//
// 为什么要有这个：「小茉的版本号」在仓库里有七种写法，手改必然漏——
//   · package.json                        version
//   · package-lock.json                   version + packages[""].version
//   · frontend/package.json               version
//   · frontend/package-lock.json          version + packages[""].version
//   · src-tauri/tauri.conf.json           version
//   · src-tauri/Cargo.toml                [package] 段里的 version
//   · src-tauri/Cargo.lock                name = "xiaomo-ai" 那条的 version
// 漏一处的后果不是报错而是「静默不一致」：安装包文件名写着一个号、界面「关于」写着另一个号。
//
// 两种写法的文件用两种办法改，都是为了「只动 version 那一行」：
//   · 锁文件（npm 生成的）解析后原样序列化，npm 自己也是这么写的，格式stable；
//   · 手写的那几个（两份 package.json / tauri.conf.json / 两个 Cargo 文件）按行替换，
//     空行与排版一律留着——别让改个版本号顺手把别人的排版也改了。
//
// 用法：
//   node scripts/version.mjs            报告七处现值 + 是否一致（不一致退出码 1）
//   node scripts/version.mjs 0.3.0      全部设成 0.3.0
//   node scripts/version.mjs patch      0.2.1 → 0.2.2（minor / major 同理）

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 把搜索范围收在文件的一小段里：Cargo 的两个文件里 `version =` 到处都是
 * （每个依赖都有），不限定范围就会改到别人的版本号。
 */
const within = (startMarker, endPattern) => (text) => {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`找不到「${startMarker}」`);
  const rest = text.slice(start + startMarker.length);
  const end = rest.match(endPattern);
  const cut = end === null || end.index === undefined ? rest.length : end.index;
  return { head: text.slice(0, start) + startMarker, body: rest.slice(0, cut), tail: rest.slice(cut) };
};

/** 按行替换的字段：pattern 三段 = 前缀 / 值 / 后缀。 */
const lineField = (file, pattern, scope) => ({
  file, kind: "line", pattern, scope,
  read: (text) => [(scope === undefined ? text : scope(text).body).match(pattern)?.[2]],
  write: (text, version) => {
    const parts = scope === undefined
      ? { head: "", body: text, tail: "" }
      : scope(text);
    const body = parts.body;
    if (!pattern.test(body)) throw new Error(`${file} 里找不到 version 那一行`);
    return parts.head + body.replace(pattern, (_all, before, _old, after) => `${before}${version}${after}`) + parts.tail;
  },
});

/** npm 锁文件：顶部 version 与 packages[""] 那条都要跟着走。 */
const lockField = (file) => ({
  file, kind: "json",
  read: (json) => [json.version, json.packages?.[""]?.version],
  write: (json, version) => {
    json.version = version;
    if (json.packages?.[""] !== undefined) json.packages[""].version = version;
    return json;
  },
});

const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]*)(".*)$/m;
const TOML_VERSION = /^(version\s*=\s*")([^"]*)(".*)$/m;

const targets = [
  lineField("package.json", JSON_VERSION),
  lockField("package-lock.json"),
  lineField("frontend/package.json", JSON_VERSION),
  lockField("frontend/package-lock.json"),
  lineField("src-tauri/tauri.conf.json", JSON_VERSION),
  lineField("src-tauri/Cargo.toml", TOML_VERSION, within("[package]", /^\[/m)),
  lineField("src-tauri/Cargo.lock", TOML_VERSION, within('name = "xiaomo-ai"', /\n\[\[package\]\]/)),
];

/** 写回时跟着原文件的行尾走：只改该改的行，别顺手把 CRLF 换成 LF。 */
const keepEol = (text, like) => (like.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);

const load = (target) => {
  const path = join(root, target.file);
  const raw = readFileSync(path, "utf8");
  return { path, raw, value: target.kind === "json" ? JSON.parse(raw) : raw };
};

/** 现值：同一份文件里可能有两处（锁文件的顶部与 packages[""] 那条），标出来免得像重复统计。 */
const survey = () => {
  const rows = [];
  for (const target of targets) {
    const found = target.read(load(target).value).filter((entry) => entry !== undefined);
    found.forEach((version, index) => {
      rows.push({ label: index === 0 ? target.file : `${target.file} 里的第 2 处`, version });
    });
  }
  return { rows, distinct: [...new Set(rows.map((row) => row.version))] };
};

const arg = process.argv[2] ?? "";

if (arg === "") {
  const { rows, distinct } = survey();
  console.log("\n小茉 · 版本号\n");
  for (const row of rows) console.log(`  ${row.label.padEnd(28)} ${row.version ?? "(缺)"}`);
  if (distinct.length === 1) {
    console.log(`\n  七处一致：${distinct[0]}\n`);
    process.exit(0);
  }
  console.error(`\n  ⚠ 不一致，共 ${distinct.length} 个值：${distinct.join(" / ")}`);
  console.error("  修法：npm run ver <版本号>（或 npm run ver patch）\n");
  process.exit(1);
}

let version = arg;
if (arg === "major" || arg === "minor" || arg === "patch") {
  const { distinct } = survey();
  if (distinct.length > 1) console.warn(`  （现值不一致，以 ${distinct[0]} 为基准递增）`);
  const [major = 0, minor = 0, patch = 0] = (distinct[0] ?? "0.0.0").split(/[-+]/)[0].split(".").map(Number);
  version = arg === "major" ? `${major + 1}.0.0`
    : arg === "minor" ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
}

if (!SEMVER.test(version)) {
  console.error(`版本号不合规：${version}（要 x.y.z）`);
  process.exit(1);
}

let changed = 0;
for (const target of targets) {
  const { path, raw, value } = load(target);
  const next = target.write(value, version);
  const text = target.kind === "json" ? keepEol(`${JSON.stringify(next, null, 2)}\n`, raw) : next;
  if (text === raw) continue;
  writeFileSync(path, text, "utf8");
  changed += 1;
  console.log(`  写入 ${relative(root, path).replace(/\\/g, "/")}`);
}
console.log(`\n版本号 → ${version}（${changed} 个文件有改动）\n`);