// 工具往返的历史回放（对齐 OpenAI / Anthropic 的通行做法：把 assistant.tool_calls 与
// role='tool' 的结果原样留在历史里，而不是压成一句人话）。
//
// 为什么值得单开一个模块：
// 一次工具调用在库里本来是两样东西——一张给人看的「工具卡」（kind='tool' 的 messages 行），
// 和协议要的往返（assistant.tool_calls + 工具结果）。从前只存了卡片，历史回放时整个往返被
// 压成一句正文占位符（「喏，发了。」+「[图片：这是你自己发出的图…]」）。模型在上下文里
// 从来没见过一次真正的 tool_call，学到的模式就成了「发表情 = 写一句方括号占位符」——
// 2026-11-03 那次「让它发表情，它回了一段 [表情：…] 文字」正是这么来的：
// 思考里明明打算调 send_emote，落到正文却照着历史抄了占位符。
//
// 现在按业内做法回放：最近若干轮原样回放，更早的轮次折成一行备注。
// 两道闸门控制开销——轮数（config.toolHistoryTurns）与总字符数（TOOL_REPLAY_MAX_CHARS）。
// 「更早的折成备注」而不是干脆不回放：模型需要知道「我当时确实用过工具」，
// 否则会把已经做过的事重做一遍（重复发表情、重复搜同一件事）。

import { q } from "./db.ts";
import { config } from "./config.ts";

/** 一次工具调用的完整往返。 */
export type ToolExchange = {
  /** 调用 id：assistant.tool_calls[].id 与 tool.tool_call_id 必须逐字一致，否则协议对不上。 */
  callId: string;
  name: string;
  /** 已脱敏的参数 JSON（与当时真正发给服务商的一字不差）。 */
  args: string;
  /** 工具结果原文（已按 TOOL_RESULT_MAX_CHARS 截断）；null = 载荷已被清理，只剩名字。 */
  result: string | null;
};

/** 一轮对话在历史里的工具回放方式。 */
export type ToolReplay = {
  /** 原样回放的往返；空数组 = 这一轮只给备注。 */
  native: ToolExchange[];
  /** 折成一句话的备注；null = 这一轮没有工具往来，什么都不用说。 */
  note: string | null;
};

/** SQLite 的变量上限是 999，按 400 一批查：ALL_TURNS 那种几百轮的窗口也塞得下。 */
const TOOL_ROW_CHUNK = 400;

/**
 * 取这些轮次里的工具往返（按调用顺序）。
 *
 * 只认带 tool_call_id 的行：本次改造之前落的老卡片没有调用 id，拼不出合法的往返，
 * 硬拼出来的 assistant.tool_calls 会缺 tool 结果，服务商直接 400。
 * 老数据就让它退化成「没有工具历史」——它们本来也只有一句占位符。
 */
export function loadToolExchanges(
  contactId: string,
  conversationId: string,
  turnIds: readonly (string | null | undefined)[],
): Map<string, ToolExchange[]> {
  const out = new Map<string, ToolExchange[]>();
  const ids = [...new Set(turnIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += TOOL_ROW_CHUNK) {
    const chunk = ids.slice(i, i + TOOL_ROW_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    const rows = q(
      `SELECT turn_id, tool_call_id, tool_name, tool_args, tool_result
         FROM messages
        WHERE contact_id = ? AND conversation_id = ? AND kind = 'tool'
          AND tool_call_id IS NOT NULL AND turn_id IN (${marks})
        ORDER BY id ASC`,
    ).all(contactId, conversationId, ...chunk) as Array<{
      turn_id: string | null;
      tool_call_id: string | null;
      tool_name: string | null;
      tool_args: string | null;
      tool_result: string | null;
    }>;
    for (const row of rows) {
      if (row.turn_id === null || row.tool_call_id === null) continue;
      const list = out.get(row.turn_id) ?? [];
      list.push({
        callId: row.tool_call_id,
        name: row.tool_name ?? "",
        args: row.tool_args ?? "{}",
        result: row.tool_result,
      });
      out.set(row.turn_id, list);
    }
  }
  return out;
}

/**
 * 原生回放的总字符预算：一轮里可能有好几个工具，一次 web_fetch 就能吃掉几千字。
 * 超出预算就从**最旧**的一轮开始降级成备注——方向与上下文裁剪一致（丢旧的、留新的）。
 */
export const TOOL_REPLAY_MAX_CHARS = 6_000;

/**
 * 决定每一轮怎么回放：原生往返 / 只留一行备注。
 *
 * 「最近 N 轮」按**所有**轮算（不只是有工具的轮），与 recentTurns 同一个口径。
 * 否则聊了几十轮没工具的闲天之后，半个月前那几次工具调用还会挂在原生回放里，
 * 既费上下文又给模型一个过期的示范。
 */
export function planToolReplay(
  rows: ReadonlyArray<{ role: string; turn_id?: string | null }>,
  exchanges: ReadonlyMap<string, ToolExchange[]>,
  opts: { nativeTurns?: number; maxChars?: number } = {},
): Map<string, ToolReplay> {
  const plan = new Map<string, ToolReplay>();
  if (exchanges.size === 0) return plan;
  const order: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const tid = row.turn_id ?? null;
    if (tid === null || seen.has(tid)) continue;
    seen.add(tid);
    order.push(tid);
  }
  const nativeTurns = Math.max(0, opts.nativeTurns ?? config.toolHistoryTurns);
  const maxChars = Math.max(0, opts.maxChars ?? TOOL_REPLAY_MAX_CHARS);
  const nativeSet = new Set(nativeTurns === 0 ? [] : order.slice(-nativeTurns));
  const withTools = order.filter((tid) => exchanges.has(tid));
  let budget = maxChars;
  for (let i = withTools.length - 1; i >= 0; i -= 1) {
    const tid = withTools[i];
    if (tid === undefined) continue;
    const list = exchanges.get(tid) ?? [];
    const note = noteFor(list);
    const size = list.reduce((sum, call) => sum + call.args.length + (call.result?.length ?? 0), 0);
    // 最新那一轮即使超预算也照原样回放：全折成备注就等于这次改造白做——
    // 模型连一个「怎么调工具」的范例都看不到，而范例正是这次要修的东西。
    const newest = i === withTools.length - 1;
    // 载荷被清理过的轮（result=null）拼不出合法往返，只能给备注。
    const complete = list.length > 0 && list.every((call) => call.result !== null);
    const native = complete && nativeSet.has(tid) && (newest || size <= budget);
    if (native) budget -= size;
    plan.set(tid, {
      native: native ? list.map((call) => ({ ...call, result: call.result as string })) : [],
      note,
    });
  }
  return plan;
}

/** 备注只报「用过什么」：名字去重、保持调用顺序。 */
function noteFor(list: readonly ToolExchange[]): string | null {
  if (list.length === 0) return null;
  const names: string[] = [];
  for (const call of list) {
    if (call.name !== "" && !names.includes(call.name)) names.push(call.name);
  }
  if (names.length === 0) return null;
  return `[这一轮用过工具：${names.join("、")}；结果已省略]`;
}

/**
 * 结构化往返的**存档**窗口（轮）。与回放窗口是两件事：
 *   回放窗口（config.toolHistoryTurns，默认 4）管「发给模型多少」；
 *   存档窗口（这里，40）管「库里留多久」。
 * 留宽一点，是为了用户把 toolHistoryTurns 调大之后历史立刻能用；
 * 又不至于让几个月的 web_fetch 正文把库撑起来（详情列已经有同样的教训，见 TOOL_DETAIL_WINDOW）。
 *
 * 清理只丢载荷（args / result），保留 tool_call_id 与 tool_name——
 * 名字还够拼那一行「这一轮用过什么」的备注，模型仍然知道那件事做过。
 */
export const TOOL_STORE_TURNS = 40;

/** 把滚出存档窗口的载荷置 NULL。每轮结束时调一次，幂等。返回清理的行数。 */
export function trimToolStore(contactId: string): number {
  const result = q(
    `UPDATE messages SET tool_args = NULL, tool_result = NULL
      WHERE contact_id = ? AND kind = 'tool' AND tool_result IS NOT NULL
        AND turn_id NOT IN (
          SELECT turn_id FROM messages
           WHERE contact_id = ? AND kind = 'tool' AND tool_result IS NOT NULL AND turn_id IS NOT NULL
           GROUP BY turn_id ORDER BY MAX(id) DESC LIMIT ?)`,
  ).run(contactId, contactId, TOOL_STORE_TURNS);
  return Number(result.changes);
}

/**
 * 手动清空工具往返的载荷（含回放窗口内的）：上下文占用想立刻降下来、或者数据要导出去时用。
 * 只清载荷不动卡片行——界面上的「查过什么」还在，只是不再回放、点不开细节。
 */
export function purgeToolHistory(contactId: string, conversationId?: string): number {
  const where = conversationId === undefined
    ? "contact_id = ? AND kind = 'tool' AND (tool_args IS NOT NULL OR tool_result IS NOT NULL)"
    : "contact_id = ? AND conversation_id = ? AND kind = 'tool' AND (tool_args IS NOT NULL OR tool_result IS NOT NULL)";
  const args = conversationId === undefined ? [contactId] : [contactId, conversationId];
  const result = q(`UPDATE messages SET tool_args = NULL, tool_result = NULL, tool_detail = NULL WHERE ${where}`).run(...args);
  return Number(result.changes);
}
