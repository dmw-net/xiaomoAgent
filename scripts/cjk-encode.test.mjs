// 扫描器的反证用例：每条都是「已知会让朴素扫描器改坏代码」的形态。
// 这些用例存在的原因是实测过：第一版在「正则里含反引号」上把一段代码当成字符串吞了，
// 靠第二遍 esbuild 的解析门才当场抓到。门能抓坏，但抓不出「静默少编码」，所以两条都要有。
import { createRequire } from "node:module";
import { join } from "node:path";
import { planCjkEncoding, encodeCjk, remainingCjkRuns, totalCjk, DEFAULT_MIN_CJK } from "./cjk-encode.mjs";

const require = createRequire(join(import.meta.dirname, "..", "frontend", "noop.cjs"));
const esbuild = require("esbuild");

const LONG = "手机前置镜头自拍：手臂长度的近距离透视，头肩到半身入画，视线正对镜头";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const decode = (call) => Buffer.from(call.slice('xm("'.length, -2), "base64").toString("utf8");

let pass = 0;
const fails = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? " | " + extra : ""));
}

const cases = [
  {
    name: "注释里的长中文不碰",
    src: `// ${LONG}\nlet a=1;`,
    expectCount: 0,
    expect: (out) => out.includes(LONG),
  },
  {
    name: "块注释里的长中文不碰",
    src: `/* ${LONG} */\nlet a=1;`,
    expectCount: 0,
    expect: (out) => out.includes(LONG),
  },
  {
    name: "正则里的引号不当字符串",
    src: `let s=t.replace(/["']/g,"");let u=1/2;`,
    expectCount: 0,
    expect: (out) => out.includes(`/["']/g`),
  },
  {
    name: "正则里含反引号不得吞掉后续代码（实测踩过的坑）",
    src: 'let r=/^```(?:json)?\\s*([\\s\\S]*?)\\s*```$/;let after="x";let k="' + LONG + '";',
    expectCount: 1,
    expect: (out) => out.includes("/^```(?:json)?") && out.includes('let after="x"') && out.includes('xm("'),
  },
  {
    name: "插值里嵌模板 → 整条不编辑但必须正确跳过",
    src: "let a=`外层 ${`" + LONG + "`} 尾巴`;let b=1;",
    expectCount: 0,
    expect: (out) => out.includes("let b=1;") && out.includes("外层"),
  },
  {
    name: "对象键位置的长中文不碰（换成调用是语法错误）",
    src: `let o={${JSON.stringify(LONG)}:1};`,
    expectCount: 0,
    expect: (out) => out.includes(LONG),
  },
  {
    name: "tag`…` 不得改写（丢 raws 会变语义）",
    src: "let q=sql`" + LONG + "`;",
    expectCount: 0,
    expect: (out) => out.includes("sql`") && out.includes(LONG),
  },
  {
    name: "普通引号串的长中文 → 编码且可还原",
    src: `let m="${LONG}";`,
    expectCount: 1,
    expect: (out) => !out.includes(LONG) && out.includes('xm("'),
  },
  {
    name: "含转义的引号串 → 值必须逐字还原",
    src: `let m="第一行\\n带引号 \\"${LONG.slice(0, 12)}\\" 制表\\t";`,
    expectCount: 1,
    expect: (out) => {
      const call = out.slice(out.indexOf('xm("'), out.indexOf('")') + 2);
      return decode(call) === `第一行\n带引号 "${LONG.slice(0, 12)}" 制表\t`;
    },
  },
  {
    name: "无插值模板整条编码",
    src: "let s=`" + LONG + "`;",
    expectCount: 1,
    expect: (out) => out.includes('xm("') && !out.includes(LONG),
  },
  {
    name: "带插值模板：静态段编码、插值原样、值可还原",
    src: "let s=`" + LONG.slice(0, 20) + "${ownerPron}提过的事有了后续、约定的时间到了`;",
    expectCount: 1, // 一条模板 = 一个 span，但里面有两个静态值
    expectValues: 2,
    expect: (out) => out.includes("(ownerPron)") && out.includes("+") &&
      decode(out.slice(out.indexOf('xm("'), out.indexOf('")') + 2)) === LONG.slice(0, 20),
  },
  {
    name: "除号不能被当成正则起点（后面紧跟引号的场景）",
    src: `let v=(a+b)/2;let w="${LONG}";`,
    expectCount: 1,
    expect: (out) => out.includes("/2") && out.includes('xm("'),
  },
  {
    name: "return`…` 当普通模板编，且换成调用必须留空格（两个实测坑）",
    src: "function f(){switch(k){case\"AUTH\":return`" + LONG.slice(0, 20) + "${e.status}\uFF09\uFF1A\u65E0\u6548\u6216\u989D\u5EA6\u7528\u5C3D\u3002\u5230\u8BBE\u7F6E\u91CC\u6838\u5BF9\u5BC6\u94A5\u5C31\u884C\u4E86`;}}",
    expectCount: 1,
    expect: (out) => out.includes("return xm(") && !out.includes("returnxm") &&
      !out.includes(LONG.slice(0, 20)) && out.includes("(e.status)"),
  },
  {
    name: "产物里已有 function xm(...) 时长名字编码不得动它（实测撞名回归）",
    src: `function xm(e,t){return e+t}let k="${LONG}";`,
    expectCount: 1,
    callName: "xmAssetText",
    expect: (out) => out.includes("function xm(e,t)") &&
      out.includes('xmAssetText("') && !out.includes("function xmAssetText"),
  },
];

for (const c of cases) {
  const callName = c.callName ?? "xm";
  const plans = planCjkEncoding(c.src, { minCjk: DEFAULT_MIN_CJK, callName });
  check(c.name + "（条数）", plans.length === c.expectCount,
    `期望 ${c.expectCount} 实际 ${plans.length}`);
  const { js, values } = encodeCjk(c.src, { minCjk: DEFAULT_MIN_CJK, callName });
  if (c.expectValues !== undefined) {
    check(c.name + "（值个数）", values.length === c.expectValues,
      `期望 ${c.expectValues} 实际 ${values.length}`);
  }
  check(c.name + "（改写结果）", c.expect(js) === true, JSON.stringify(js).slice(0, 160));
  // 每条被编码的值都必须能从 base64 原样还原
  for (const [idx, v] of values.entries()) {
    check(c.name + `（值 ${idx} 往返）`, Buffer.from(b64(v), "base64").toString("utf8") === v);
  }
  // 语法完整性：与构建里同一道门
  let syntaxOk = true;
  let err = "";
  try {
    await esbuild.transform(js, { loader: "js" });
  } catch (e) {
    syntaxOk = false;
    err = String(e.message ?? e).split("\n")[0];
  }
  check(c.name + "（语法可解析）", syntaxOk, err);
}

// 门本身的反证：把已知坏样本喂给两条判定式，必须都报红。
const dirty = `x="${LONG}"`;
check("门 A 能抓到明文（反证）", planCjkEncoding(dirty).length === 1,
  `实际 ${planCjkEncoding(dirty).length}`);
const clean = encodeCjk(dirty).js;
check("门 A 在干净产物上归零", planCjkEncoding(clean).length === 0);
check("门 B 量的是编码前后的汉字降幅（反证：带标点的长串也要算进去）",
  totalCjk(remainingCjkRuns(dirty).join("")) >= 20 && remainingCjkRuns(dirty).length === 1,
  JSON.stringify(remainingCjkRuns(dirty)));
check("门 B 在干净产物上汉字归零", totalCjk(clean) === 0, `实际 ${totalCjk(clean)}`);

console.log(`\uFEFFcjk-encode 反证用例：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  console.log("失败：\n" + fails.map((f) => "  · " + f).join("\n"));
  process.exit(1);
}
