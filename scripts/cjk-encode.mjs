// 捆包后置编码：把产物里「成段的中文」从明文字面量换成（可选 XOR 的）base64 + 运行时解码调用。
//
// 为什么要它：esbuild 的 minify 只改标识符，字符串一字不动，而且非 ASCII 会被写成
// `\uXXXX`——看着像密文，一条正则就还原。实测一次 unescape 就能从安装包里捞走
// 12032 个中文字符（人设模板、主动性判据、出图构图约束、工具描述全套）。
// 这一层把「解压 + 一次 unescape」抬成「先读懂注入的解码器」，并且让**任何文本搜索
// 都摸不到提示词**（minify 完全没做到这点）。仍然不是加密，有心人能还原，别当 DRM。
//
// 2026-10-19 起：调用方传入 key（Buffer）时，载荷从纯 base64 升级为
// base64(XOR(utf8, key))——纯 base64 被实测 5 行 python 全解，XOR + 密钥进 exe
// 把「一条命令解码」抬成「先从二进制里挖出密钥」。不传 key 保持原行为（测试用）。
//
// 扫描器必须处理四种歧义，否则会改坏代码：
//   1) 注释里的引号不是字符串；
//   2) 正则字面量里的引号不是字符串（按「前一个有效 token 是否操作数」判除号/正则）；
//   3) 模板字面量的 `${}` 可再嵌对象与引号串，静态段要按深度切；带反引号的嵌套整条不碰；
//   4) 对象键、以及被标签修饰的模板（tag`…`）不能换成调用——换了要么语法坏，要么丢掉 tag。
// 兜底：改写后的文本必须再过一次 esbuild 解析，语法坏就 abort；并核对「被编码掉的值」
// 与「产物里残留的长中文串」两边都归零，空转的编码器比没有编码器更糟。

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;

/** 够长才算资产：短标签不值得包一层解码调用。 */
export const DEFAULT_MIN_CJK = 12;

export function countCjk(text) {
  const m = text.match(CJK);
  return m ? m.length : 0;
}

const SIMPLE_ESCAPES = {
  n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0", "\\": "\\",
  '"': '"', "'": "'", "/": "/",
};

/**
 * 解 `"…"` / `'…'` 字面量内容。遇到不认识的转义返回 null → 调用方放弃这条。
 * 宁可少编一条，不可编错一条。
 */
function decodeEscapes(body, { template }) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (next === "\n") { i += 1; continue; }
    if (next === "u") {
      if (body[i + 2] === "{") {
        const close = body.indexOf("}", i + 2);
        if (close < 0) return null;
        const hex = body.slice(i + 3, close);
        if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
        out += String.fromCodePoint(parseInt(hex, 16));
        i = close + 1;
        continue;
      }
      const hex = body.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    if (next === "x") {
      const hex = body.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 3;
      continue;
    }
    if (next in SIMPLE_ESCAPES) {
      if (template && !(next in { n: 1, r: 1, t: 1, b: 1, f: 1, v: 1, "\\": 1, "`": 1, "$": 1 })) return null;
      out += next === "`" && template ? "`" : SIMPLE_ESCAPES[next];
      i += 1;
      continue;
    }
    if (template && (next === "`" || next === "$")) {
      out += next;
      i += 1;
      continue;
    }
    return null;
  }
  return out;
}

const decodeQuoted = (body) => decodeEscapes(body, { template: false });

function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** 从 pos 的引号起读到闭合，返回 {end, body}；跨行视为判错。 */
function readQuoted(src, pos) {
  const quote = src[pos];
  for (let i = pos + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "\n") return null;
    if (ch === quote) return { end: i, body: src.slice(pos + 1, i) };
  }
  return null;
}

/**
 * 从 pos 的反引号起读模板，切出静态段；插值里再嵌模板/字符串/注释时用栈走到底。
 * 总是返回**真实结尾** end（配对不上就 end=-1，调用方据此整段放弃）——
 * 早先版本遇到嵌套反引号就放弃并从模板内部继续扫描，于是把代码当成了字符串吞掉
 * （第二遍 esbuild 的解析门当场抓到）。插值里嵌模板不影响静态段改写，所以照编。
 */
function readTemplate(src, pos) {
  const chunks = [];
  let chunkStart = pos + 1;
  let i = pos + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") {
      chunks.push({ contentStart: chunkStart, contentEnd: i });
      return { end: i, chunks };
    }
    if (ch === "$" && src[i + 1] === "{") {
      chunks.push({ contentStart: chunkStart, contentEnd: i });
      const scan = scanInterpolation(src, i + 2);
      if (!scan) return { end: -1, chunks: [] };
      chunks.push({ start: i + 2, end: scan.end });
      i = scan.close;
      chunkStart = scan.close;
      continue;
    }
    i++;
  }
  return { end: -1, chunks: [] };
}

/** 扫过一段 `${…}`：返回表达式起止与配对 `}` 之后的位置；内部模板递归处理。 */
function scanInterpolation(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = readQuoted(src, i);
      if (q) { i = q.end + 1; continue; }
    }
    if (c === "`") {
      const inner = readTemplate(src, i);
      if (inner.end < 0) return null;
      i = inner.end + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { start: from, end: i - 1, close: i };
}

/**
 * 反引号前面那个词是不是关键字：关键字结尾（`return\`…\``、`case "X":return\`…\``）
 * 说明这是**普通模板**，可以改写；只有普通标识符才是 tag`…`，那种改写会丢掉 raws。
 * 早先版本只看「前面是标识符字符」，把压缩产物里大量的 `return\`…\`` 全当成 tag 跳过了，
 * 于是友好错误文案和记忆抽取提示词整批漏在明文里（实测残留 48 段）。
 */
const KEYWORDS_BEFORE_TEMPLATE = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "do", "else", "new",
  "void", "delete", "yield", "await", "throw",
]);

/** 该反引号是不是被 tag 修饰的模板（不能改写）。 */
function isTaggedTemplate(src, pos) {
  let j = pos - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0 || !isIdentChar(src[j])) return false; // 前面是 ) ] { , = : 等 → 普通模板
  let k = j;
  while (k >= 0 && isIdentChar(src[k])) k--;
  const word = src.slice(k + 1, j + 1);
  if (KEYWORDS_BEFORE_TEMPLATE.has(word)) return false;
  // `.` 前面接标识符是成员调用（sql.raw`…`）也算 tag；关键字之后的点号极少见，保守判 tag
  return true;
}

/** `/` 是正则还是除号：看前一个有效 token 是不是操作数（关键字结尾例外）。 */
function slashIsRegex(src, pos) {
  for (let i = pos - 1; i >= 0; i--) {
    const ch = src[i];
    if (/\s/.test(ch)) continue;
    if (isIdentChar(ch)) {
      let j = i;
      while (j >= 0 && isIdentChar(src[j])) j--;
      const word = src.slice(j + 1, i + 1);
      return ["return", "typeof", "instanceof", "in", "of", "case", "do", "else",
        "new", "void", "delete", "yield", "await"].includes(word);
    }
    return !")]}".includes(ch);
  }
  return true;
}

function prevNonSpace(src, pos) {
  for (let i = pos - 1; i >= 0; i--) if (!/\s/.test(src[i])) return src[i];
  return "";
}

function nextNonSpace(src, pos) {
  for (let i = pos; i < src.length; i++) if (!/\s/.test(src[i])) return src[i];
  return "";
}

/**
 * 载荷编码：
 *   无 key → base64(utf8(value))，原行为（测试与旧产物）。
 *   有 key → base64(XOR(utf8(value), key 循环))，密钥由 Rust 侧经环境变量在运行期注入。
 * XOR 密文仍用 base64 呈现：产物形态不变（`xm("…")`），转义/引号问题不引入新变量。
 */
export function xorEncode(value, key) {
  const bytes = Buffer.from(value, "utf8");
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length];
  return bytes.toString("base64");
}

/** xorEncode 的逆运算（verify-bundle 与测试用它还原明文，与 JS 解码器同一算法）。 */
export function xorDecode(payloadB64, key) {
  const bytes = Buffer.from(payloadB64, "base64");
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length];
  return bytes.toString("utf8");
}

const enc = (value, callName, key) =>
  `${callName}("` + (key ? xorEncode(value, key) : Buffer.from(value, "utf8").toString("base64")) + '")';

/**
 * 替换点前一个字符是标识符字符时必须补空格：压缩产物里 `return\`…\`` 换成调用后会粘成
 * `returnxm(…)`——语法合法（变成一个不存在的函数名），解析门抓不到，只有跑起来才炸。
 */
const gap = (src, at) => (/[\w$]/.test(src[at - 1] ?? "") ? " " : "");

/**
 * 递归处理插值表达式里再嵌的模板：`(t?\`…中文…\` : "")` 这种，
 * 外层只换静态段会把内层的中文原样留在产物里（实测就是这么漏了 2 段）。
 */
function encodeInterpolation(expr, opts) {
  const inner = planCjkEncoding(expr, opts);
  return inner.length > 0 ? applyPlans(expr, inner) : expr;
}

/** 把替换指令按顺序落下去；span 天然不重叠（扫描器跨过一条字面量后不会再进它内部）。 */
export function applyPlans(src, plans) {
  let out = "";
  let cursor = 0;
  for (const plan of plans) {
    if (plan.start < cursor) throw new Error("[cjk-encode] 内部错误：span 重叠");
    out += src.slice(cursor, plan.start) + plan.text;
    cursor = plan.end + 1;
  }
  return out + src.slice(cursor);
}

/**
 * 扫一遍源码，返回替换指令 [{start, end, text, values}]（start/end 为待替换 span，含端点）。
 * 引号串：整条（含引号）换成调用；对象键跳过。
 * 模板：整条（含反引号）重建为 `f("b64")` 或 `f("b64") + (expr) + f("b64")`；tag`…` 跳过。
 * callName 由调用方给定，且必须是产物里不存在的长名字——早先用短名 `xm` 再做事后文本替换，
 * 把产物里本来就有的 `function xm(...)` 声明一起改了名，和解码器撞成重复声明。
 */
export function planCjkEncoding(src, { minCjk = DEFAULT_MIN_CJK, callName = "xm", key = null } = {}) {
  const plans = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    if (ch === "/" && slashIsRegex(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = readQuoted(src, i);
      if (!q) { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl + 1; continue; }
      const isKey = nextNonSpace(src, q.end + 1) === ":" && ["{", ",", ""].includes(prevNonSpace(src, i));
      if (!isKey) {
        const value = decodeQuoted(q.body);
        if (value !== null && countCjk(value) >= minCjk) {
          plans.push({ start: i, end: q.end, text: gap(src, i) + enc(value, callName, key), values: [value] });
        }
      }
      i = q.end + 1;
      continue;
    }
    if (ch === "`") {
      const t = readTemplate(src, i);
      // 配对不上（畸形输入）就整段不再往前扫；tag`…` 的静态段要交给 tag 函数，换成拼接会丢 raws。
      if (t.end < 0) { i = src.length; continue; }
      if (isTaggedTemplate(src, i)) { i = t.end + 1; continue; }
      const statics = t.chunks.filter((c) => c.contentStart !== undefined);
      const interesting = statics.some((c) => {
        const v = decodeEscapes(src.slice(c.contentStart, c.contentEnd), { template: true });
        return v !== null && countCjk(v) >= minCjk;
      });
      if (!interesting) { i = t.end + 1; continue; }
      const pieces = [];
      const values = [];
      let ok = true;
      for (let k = 0; k < t.chunks.length; k++) {
        const c = t.chunks[k];
        if (c.start !== undefined) {
          // 插值表达式里还能再嵌模板（`(t?`中文…` : "")`）——递归编，否则那段中文原样留在产物里
          pieces.push("(" + encodeInterpolation(src.slice(c.start, c.end), { minCjk, callName, key }) + ")");
          continue;
        }
        const body = src.slice(c.contentStart, c.contentEnd);
        const v = decodeEscapes(body, { template: true });
        if (v !== null && countCjk(v) >= minCjk) {
          pieces.push(enc(v, callName, key));
          values.push(v);
        } else if (v === null) {
          ok = false; // 解不出来就整条放弃，不半截替换
        } else {
          pieces.push("`" + body + "`");
        }
      }
      if (ok) plans.push({ start: i, end: t.end, text: gap(src, i) + pieces.join(" + "), values });
      i = t.end + 1;
      continue;
    }
    i++;
  }
  return plans;
}

/** 应用全部指令，并回传被编码掉的原文值（自检与报告要用）。 */
export function encodeCjk(src, { minCjk = DEFAULT_MIN_CJK, callName = "xm", key = null } = {}) {
  const plans = planCjkEncoding(src, { minCjk, callName, key });
  const values = plans.flatMap((plan) => plan.values);
  return { js: applyPlans(src, plans), values, count: plans.length };
}

/**
 * 产物里残留的「成段中文」明文串（只作报告，不当门）。
 * 段必须**容忍中文标点与空白**：提示词里到处是「：，、。」和换行，按连续汉字切段会把
 * 「手机前置镜头自拍：手臂长度的近距离透视」数成 6/4 两段而漏报——实测这就是第一版的假绿。
 */
export function remainingCjkRuns(text, minCjk = DEFAULT_MIN_CJK) {
  const plain = unescapeJs(text);
  const runs = [];
  for (const segment of plain.split(/[^\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF，。、；：“”‘’（）【】《》！？·\s]/)) {
    if (countCjk(segment) >= minCjk) runs.push(segment.trim());
  }
  return runs;
}

/** 产物里汉字总数：一条**与扫描器无关**的独立量，用来抓「扫描器自己瞎掉」的静默失效。 */
export function totalCjk(text) {
  return countCjk(unescapeJs(text));
}

function unescapeJs(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
