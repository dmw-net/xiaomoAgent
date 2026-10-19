/**
 * 禁用词：她的回复里不该出现的词。
 *
 * 做法是把约束摆在她眼前——追加到**最后一条 user 消息的尾部**，让模型自己不说。
 * 不做出站替换：事后抹 `*` 只改得了显示，改不了她其实已经说出口的那一句，
 * 而且中文里"不喜欢"被抹成"不**"还会反转语义。事前这句约束只花几十字节。
 *
 * 位置选在最后一条 user 消息而不是 system prompt：近因位置的遵循率明显高于
 * 埋在长系统提示词里；而且它跟着本轮请求走，不落库、不回放，
 * 下一轮会按当时的词表重新拼，改完立刻生效。
 */

/** 分隔符：中英文逗号、顿号、分号、换行。 */
const SEP = /[,，、;；\n\r]+/;
export const MAX_BANNED_WORDS = 10;
const MAX_WORD_LEN = 50;

/**
 * 存的是用户输入的那一行原文（和 schedule 一样存法），用时再解析成词表。
 * 判重忽略大小写（`AI` 和 `ai` 是同一个词，不能各占一个名额），存储保留原样。
 */
export function parseBannedWords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of String(raw ?? "").split(SEP)) {
    const w = piece.trim().slice(0, MAX_WORD_LEN);
    const key = w.toLowerCase();
    if (w === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= MAX_BANNED_WORDS) break;
  }
  return out;
}

/** 那句约束。词表为空就什么都不加，不给她读一句没用的 SYSTEM NOTE。 */
export function bannedWordsNote(words: string[]): string {
  if (words.length === 0) return "";
  const list = words.map((w) => `"${w}"`).join(", ");
  return `\nSYSTEM NOTE: Do not include the following words/phrases in your output under any circumstances: ${list}`;
}
