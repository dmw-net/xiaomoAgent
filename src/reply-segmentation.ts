// 回复分条：把一段完整回复切成多个聊天气泡，像人一句一条地发消息。
//
// 「陪伴应用该把长回复拆成短句气泡发」是借鉴来的设计思路；实现为独立编写，
// 与任何既有分条代码无关。策略上只有三条纪律：
//   1. 带 Markdown 结构的内容（列表/表格/代码块/链接/加粗…）整条发——
//      把列表或代码块拆进几个气泡是灾难性阅读体验；
//   2. 其余文本按「句末标点 + 收尾引号/括号」切，一行之内多句也照切；
//   3. 条数有上限（默认 5），超出的句子并进最后一条——连发十几条气泡同样灾难。

/** Markdown 结构信号（行首列表/标题/引用/表格、代码围栏、行内格式、链接、裸 URL）。 */
const MARKDOWN_HINT =
  /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|[>|`]|\|)|```|~~~|\*\*|__|~~|\[[^\]]*\]\(|https?:\/\/|www\./m;

/**
 * 句末分隔符（捕获组用于 split 后回填）：
 * 连续句末标点（。！？…、!?、英文省略号 …/...）、
 * 或后随空白的英文句号；连同其后的收尾引号/括号一起归入本句。
 */
const SENTENCE_SPLIT =
  /((?:[。！？…]+|[!?]{2,}|\.{3}|(?<=\S)\.(?=\s|$))["'”’）)』」]*)/u;

/** 按行扫描：行内以句末标点断句；换行本身也是软边界，行尾残句独立成条。 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const chunks = line.split(SENTENCE_SPLIT);
    let carry = "";
    for (let i = 0; i < chunks.length; i += 2) {
      carry += chunks[i] ?? "";
      const delim = chunks[i + 1];
      if (delim === undefined) continue;
      carry += delim;
      const sentence = carry.trim();
      if (sentence !== "") out.push(sentence);
      carry = "";
    }
    const tail = carry.trim();
    if (tail !== "") out.push(tail);
  }
  return out;
}

/**
 * 把回复切成气泡序列；空白输入回落为单条（调用方按普通消息处理）。
 * max 为气泡数上限，超出部分合并成最后一条。
 */
export function segmentReply(value: string, max = 5): string[] {
  const text = String(value ?? "").replace(/\r\n?/g, "\n");
  if (MARKDOWN_HINT.test(text)) {
    const whole = text.trim();
    return [whole === "" ? text : whole];
  }
  const bubbles = splitSentences(text);
  if (bubbles.length === 0) return [text.trim()];
  if (bubbles.length <= max) return bubbles;
  return [...bubbles.slice(0, max - 1), bubbles.slice(max - 1).join(" ")];
}
