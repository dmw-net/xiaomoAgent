#!/usr/bin/env node
/**
 * CSS 令牌纪律检查（css-token-check.mjs）
 *
 * 背景：theme.css 的令牌表是这套界面的宪法（「组件只消费语义令牌，不写散落色值」），
 * 本脚本用于拦截三类静默劣化：
 *   ① 消费了从未定义的令牌，
 *      var() 无 fallback 时声明按 invalid 处理、颜色悄悄退回继承值，肉眼不可见；
 *   ② 裸 z-index 游离于 theme.css 的档位表外，弹层层级打架时无从排查；
 *   ③ 裸时长（.16s ease 之类）绕开动效三档，reduced-motion 的 .01ms 总闸罩不住它们。
 * 本脚本把这三类都变成可执行检查，接进 npm run check。
 *
 * 口径：
 *   - ERROR：var(--x) 消费了 CSS / JS（setProperty、内联 style）里都不存在的令牌；
 *   - WARN：裸 z-index 数字、transition/animation 里的裸时长。WARN 只列出，
 *     因为存量清理是分批任务，一上来就 red 会让人把整个脚本关掉——
 *     等清完一批就把对应段升成 ERROR。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesDir = join(root, "frontend", "src", "styles");
const srcDir = join(root, "frontend", "src");

// ── 收集 CSS 里的令牌定义（--x: 值）───────────────────────────────
const defined = new Set();
for (const f of readdirSync(stylesDir)) {
  if (!f.endsWith(".css")) continue;
  const css = readFileSync(join(stylesDir, f), "utf8");
  for (const m of css.matchAll(/(^|[{;\s])(--[a-z0-9-]+)\s*:/g)) defined.add(m[2]);
}

// ── 收集 JS/TSX 里运行时设置的令牌（setProperty 与内联样式键）────────
//    --ax / --kb / --wp-glass-* / --voice-width / --meteor-* 这类都是 JS 动态给值，
//    CSS 里只消费不定义，必须从源码里收上来，否则全是误报。
const jsDefined = new Set();
const collectJs = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) { collectJs(p); continue; }
    if (!/\.(ts|tsx)$/.test(name.name)) continue;
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/["'`](--[a-z0-9-]+)["'`]\s*[,:]/g)) jsDefined.add(m[1]);
    for (const m of src.matchAll(/setProperty\(\s*["'`](--[a-z0-9-]+)/g)) jsDefined.add(m[1]);
    for (const m of src.matchAll(/["'`](--[a-z0-9-]+)["'`]\s*:/g)) jsDefined.add(m[1]);
  }
};
collectJs(srcDir);
// index.html 的首帧脚本也算（adapt() 会 set --msg-time-mine 等）
const indexHtml = readFileSync(join(root, "frontend", "index.html"), "utf8");
for (const m of indexHtml.matchAll(/["'`](--[a-z0-9-]+)["'`]/g)) jsDefined.add(m[1]);

const known = new Set([...defined, ...jsDefined]);

// ── 扫 CSS：消费未定义令牌 + 裸 z-index + 裸时长 ────────────────────
// 就近注释判定：本行或向上 4 行内出现过注释就算有说明（块注释开头 /*、
// 结尾 */、中间续行 *，三者都算）。块注释通常写在规则开头、声明在规则
// 末尾，中间隔几行属正常排版，不必把同一句解释贴两遍。
const isCommentLine = (l) => l.includes("/*") || l.includes("*/") || /^\s*\*/.test(l);
const nearComment = (lines, i) => {
  for (let k = i; k >= Math.max(0, i - 4); k--) if (isCommentLine(lines[k])) return true;
  return false;
};
const errors = [];
const warns = [];
for (const f of readdirSync(stylesDir)) {
  if (!f.endsWith(".css")) continue;
  const path = join(stylesDir, f);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    const ln = i + 1;
    for (const m of line.matchAll(/var\((--[a-z0-9-]+)\s*[,)]/g)) {
      if (!known.has(m[1])) errors.push(`${f}:${ln} 消费了未定义的令牌 ${m[1]}`);
    }
    // 裸 z-index：z-index: 后跟纯数字（calc/var 都放过）。
    // 1~9 豁免：这个量级是「卡片内的局部堆叠」——徽标压住兄弟元素、删除钮盖在
    // 缩略图上、sticky 表头压过行内容——作用域不出当前组件，永远不会和弹层抢
    // 高度，进全局档位表反而稀释了表的表达力。≥10 才可能是想越出组件跟别的
    // 浮层比高低的值，必须落档。
    const z = line.match(/z-index\s*:\s*(\d+)/);
    if (z && Number(z[1]) >= 10) {
      warns.push(`${f}:${ln} 裸 z-index: ${z[1]}（应走 theme.css 的 --z-* 档位表）`);
    }
    // 裸时长：transition/animation 值里出现 .12s / 240ms 这类字面量。
    // ≥1s 的是氛围循环（骨架 pulse、呼吸、rec-dot 1Hz 闪烁、壁纸星空这类），
    // 不在三档动效体系内——三档管的是「微交互手感」，管不了循环周期——豁免，
    // 但要求就近有注释（本行向上 4 行内）说明它为什么游离于三档之外，
    // 防止将来有人照抄这个魔数到微交互上；<1s 的才是微交互时长，报警。
    // 按整行判定而不是逐个时长：animation 简写里第二段是 delay
    // （如 5.6s linear .9s infinite），把 delay 单拎出来会误报成微交互。
    if (/\b(transition|animation|animation-name)\b\s*:/.test(line)) {
      const durs = [...line.matchAll(/[\s,]((?:\d*\.)?\d+ms|(?!\d*\.?\d+px)\d*\.\d+s|\d+s)\b/g)]
        .map((m) => m[1].endsWith("ms") ? parseFloat(m[1]) : parseFloat(m[1]) * 1000);
      if (durs.length) {
        if (Math.max(...durs) >= 1000) {
          if (!nearComment(lines, i)) {
            warns.push(`${f}:${ln} ≥1s 循环/长动画（氛围类豁免，但需就近注释说明为何不走三档）`);
          }
        } else {
          warns.push(`${f}:${ln} transition/animation 含裸时长 ${durs.map((v) => v + "ms").join("/")}（微交互应走 --dur-fast/base/slow 三档）`);
        }
      }
    }
  });
}

// ── 输出 ─────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`✗ CSS 令牌检查：${errors.length} 处未定义令牌`);
  for (const e of errors) console.error("  " + e);
}
console.log(warns.length ? `⚠ 裸值警告 ${warns.length} 处（待分批清理）：` : "✓ 无裸 z-index / 裸时长");
const seen = new Set();
for (const w of warns) { if (!seen.has(w)) { seen.add(w); console.log("  " + w); } }
process.exit(errors.length ? 1 : 0);
