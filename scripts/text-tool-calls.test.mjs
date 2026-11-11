/**
 * 正文形式工具调用的解析回归。
 *
 * 运行：node scripts/text-tool-calls.test.mjs
 *
 * 背景：agnes-3.0-flash（以及一批 Hermes / Qwen 模板的中转端点）不填 OpenAI 的 tool_calls 字段，
 * 而是把调用写进正文。真实出现过的一次是「帮我给大肥鱼换个头像」→ 模型回了
 * <tool_call><function=web_search>…</function></tool_call>，应用不认，搜图一次没跑，
 * 界面上没有工具卡也没有候选图，模型却接着说「找到了 6 张图，已经显示在界面上啦」。
 * 所以这里要盯住三件事：解析得出来、正文里的调用块要剥干净、认不出来的块不能被吃掉。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { parseTextToolCalls, trimDraftBeforeToolCall } from "../src/core/text-tool-calls.ts";

// 1) Hermes 模板：<function=name> + <parameter=k>v</parameter>（本机真实抓到的原文）
const hermes = `好的，我来搜一下“deepseek 大肥鱼 鲸鱼娘”相关的图片，你挑一张满意的就行。

<tool_call>
<function=web_search>
<parameter=kind>
image
</parameter>
<parameter=query>
deepseek 大肥鱼 鲸鱼娘
</parameter>
</function>
</tool_call>`;
const h = parseTextToolCalls(hermes);
assert.equal(h.calls.length, 1, "Hermes 格式应解析出 1 个调用");
assert.equal(h.calls[0].name, "web_search", "函数名应被读出来");
assert.deepEqual(JSON.parse(h.calls[0].args), { kind: "image", query: "deepseek 大肥鱼 鲸鱼娘" }, "参数应按 JSON 还原，值去掉首尾换行");
assert.equal(h.content, "好的，我来搜一下“deepseek 大肥鱼 鲸鱼娘”相关的图片，你挑一张满意的就行。", "调用块必须从正文里剥掉，前言保留");
assert(!h.content.includes("<tool_call>") && !h.content.includes("<parameter"), "正文里不能残留调用标记");

// 2) Qwen2.5 模板：块内是 JSON，arguments 允许是对象或字符串
const jsonBlock = parseTextToolCalls('<tool_call>{"name":"web_search","arguments":{"query":"小茉","limit":3}}</tool_call>');
assert.equal(jsonBlock.calls.length, 1, "JSON 形式也应认");
assert.deepEqual(JSON.parse(jsonBlock.calls[0].args), { query: "小茉", limit: 3 });
assert.equal(jsonBlock.content, "", "整条回复都是调用块时，正文应为空而不是留下一段空白");

const stringArgs = parseTextToolCalls('<tool_call>{"name":"get_current_time","arguments":"{}"}</tool_call>');
assert.equal(stringArgs.calls.length, 1, "arguments 是 JSON 字符串时也要认");
assert.deepEqual(JSON.parse(stringArgs.calls[0].args), {});

// 3) 一轮多个调用：id 必须互不相同，否则第二轮工具结果回传会撞车
const multi = parseTextToolCalls(`<tool_call><function=get_current_time></function></tool_call>
<tool_call><function=search_memory><parameter=query>头像</parameter></function></tool_call>`);
assert.equal(multi.calls.length, 2, "多个调用块应逐个解析");
assert.notEqual(multi.calls[0].id, multi.calls[1].id, "同一轮的多个调用 id 不能重复");
assert.deepEqual(JSON.parse(multi.calls[1].args), { query: "头像" });

// 4) 数字与布尔：模板里只有文本，工具声明里 limit 是 number、开关是 boolean
const typed = parseTextToolCalls("<tool_call><function=web_search><parameter=limit>8</parameter><parameter=force>true</parameter></function></tool_call>");
assert.deepEqual(JSON.parse(typed.calls[0].args), { limit: 8, force: true }, "数字/布尔参数应还原成真类型，而不是字符串");

// 5) 没有块、或块认不出来：原样返回，绝不能把用户看得懂的话吃掉
const plain = "我把头像换好了。";
assert.deepEqual(parseTextToolCalls(plain), { content: plain, calls: [] }, "普通正文应原样返回");

const broken = "看这段示例：<tool_call>这里没有函数名</tool_call> 就是这样。";
const brokenOut = parseTextToolCalls(broken);
assert.equal(brokenOut.calls.length, 0, "认不出的块不应被当成工具调用");
assert.equal(brokenOut.content, broken, "认不出的块必须原样留着，不能静默删除");

// 6) 流式草稿：调用块不该在「她正在写」的实时文本里闪出来
assert.equal(trimDraftBeforeToolCall("好的，我来搜<tool_call><function=web"), "好的，我来搜", "草稿应截在 <tool_call> 之前");
assert.equal(trimDraftBeforeToolCall("<tool_call><function=web_search>"), "", "整条都是调用块时草稿应为空");
assert.equal(trimDraftBeforeToolCall("没有调用块的正文"), "没有调用块的正文", "没有调用块时草稿原样返回");

// 7) 接线：解析必须同时接在「有 tools 的路径」和「端点没启用 tools 的路径」上。
// 端点没启用 tools 时请求里根本没有 tools 字段，只接一处等于什么都没修。
const modelSource = readFileSync("src/settings/model.ts", "utf8");
assert.equal(
  (modelSource.match(/parseTextToolCalls\(/g) ?? []).length,
  2,
  "model.ts 的两个返回点都要接兼容解析：原生 tool_calls 路径 + 未启用 tools 的路径",
);
assert(
  /if \(tools\.length === 0 \|\| toolSettings\.caps\.tools !== true/.test(modelSource),
  "tools 为空也必须走无工具分支：agent 在没有可声明工具时仍会进循环认正文调用，而给端点发 tools: [] 有些服务商直接 400",
);
const agentSource = readFileSync("src/chat/agent.ts", "utf8");
assert(/trimDraftBeforeToolCall\(text\)/.test(agentSource), "流式草稿写入前要截掉正文里的调用块，不能实时闪一段 XML");
// 门控不许在 runAgentLoop 里又短路一次：`declaredTools.length === 0` 若
// 直接 return callModel，callModelWithTools 里的兼容解析根本轮不到执行。
assert(
  !/\|\|\s*declaredTools\.length === 0[\s\S]{0,120}?callModel\(base, options\)\)/.test(agentSource),
  "「没有可声明工具」不能短路成一次 callModel：那条路会跳过正文形式工具调用的解析",
);
assert(
  /if \(!modelReadyNow\(effective\)\) \{\s*\n\s*return guardOverflow\(base, \(\) => callModel\(base, options\)\);/.test(agentSource),
  "只有模型没就绪时才允许退回 callModel（演示模式那句提示由它负责）",
);

console.log("正文形式工具调用解析：全部通过");
