// 工具往返的命令行入口：看现在占多少、以及把历史载荷清掉。
//
// 为什么要一个 CLI：回放窗口（TOOL_HISTORY_TURNS，默认 4）是自动闸门，日常不用管；
// 但有两件事需要人来拍板——想立刻把上下文里那部分清干净（purge），
// 或者想知道自己这段对话到底被工具结果占了多大一块（默认的统计输出）。
// 不放到设置页：这是运维动作，不是聊天时会调的开关。
//
// 用法：
//   npm run tool-history                    # 统计（按联系人 / 会话）
//   npm run tool-history -- purge           # 清空所有联系人的工具载荷（卡片保留）
//   npm run tool-history -- purge <contact> # 只清一个联系人
//   npm run tool-history -- trim            # 只按存档窗口（TOOL_STORE_TURNS 轮）清
//
// 清的是 tool_args / tool_result / tool_detail 三列：界面上「查过什么」的卡片还在，
// 只是不再回放给模型、也点不开详情。这一步不可逆，但丢的是载荷不是对话。

import { q } from "../src/db.ts";
import { getContact, listContacts } from "../src/contacts.ts";
import { purgeToolHistory, trimToolStore, TOOL_STORE_TURNS } from "../src/tool-history.ts";
import { config } from "../src/config.ts";

const args = process.argv.slice(2);
const command = args[0] ?? "stats";
const contactArg = args[1] ?? "";

type StatRow = { conversation_id: string | null; calls: number; chars: number; payload_calls: number };

function statsOf(contactId: string): StatRow[] {
  return q(
    `SELECT conversation_id,
            COUNT(*) AS calls,
            COALESCE(SUM(LENGTH(tool_args) + LENGTH(tool_result)), 0) AS chars,
            SUM(CASE WHEN tool_result IS NOT NULL THEN 1 ELSE 0 END) AS payload_calls
       FROM messages
      WHERE contact_id = ? AND kind = 'tool' AND tool_call_id IS NOT NULL
      GROUP BY conversation_id
      ORDER BY chars DESC`,
  ).all(contactId) as StatRow[];
}

if (command === "stats") {
  // 按**库里实际有工具行的** contact_id 遍历，而不是按联系人表：
  // 被删掉的联系人、或老数据里归属为空的那些行同样占着上下文，统计不能把它们漏掉。
  const owners = q(
    `SELECT DISTINCT contact_id FROM messages
      WHERE kind = 'tool' AND tool_call_id IS NOT NULL AND contact_id IS NOT NULL`,
  ).all() as Array<{ contact_id: string }>;
  let totalCalls = 0;
  let totalChars = 0;
  for (const owner of owners) {
    const rows = statsOf(owner.contact_id);
    if (rows.length === 0) continue;
    const contact = getContact(owner.contact_id);
    console.log(`\n${contact?.name ?? "（联系人已不在）"}（${owner.contact_id}）`);
    for (const row of rows) {
      const conv = row.conversation_id === null ? "（未分会话）" : row.conversation_id;
      console.log(
        `  ${conv}: ${row.calls} 次调用，${row.payload_calls} 条还留着载荷，约 ${row.chars.toLocaleString()} 字符`
        + `（≈ ${Math.round(row.chars / 2).toLocaleString()} token）`,
      );
      totalCalls += row.calls;
      totalChars += row.chars;
    }
  }
  if (totalCalls === 0) {
    console.log("没有工具往返记录。");
  } else {
    console.log(`\n合计 ${totalCalls} 次调用、约 ${Math.round(totalChars / 2).toLocaleString()} token 的载荷。`);
    console.log(
      `当前回放窗口：最近 ${config.toolHistoryTurns} 轮原生回放，更早的折成一行备注；`
      + `存档窗口：最近 ${TOOL_STORE_TURNS} 轮（想更省就 purge，或把 TOOL_HISTORY_TURNS 调小/设 0）。`,
    );
  }
} else if (command === "purge") {
  const targets = contactArg === "" ? listContacts({ includeArchived: true }).map((c) => c.id) : [contactArg];
  let total = 0;
  for (const contactId of targets) {
    total += purgeToolHistory(contactId);
  }
  console.log(`已清空 ${total} 条工具载荷（卡片保留）。下一轮起上下文里不会再出现这些往返。`);
} else if (command === "trim") {
  let total = 0;
  for (const contact of listContacts({ includeArchived: true })) {
    total += trimToolStore(contact.id);
  }
  console.log(`按存档窗口（${TOOL_STORE_TURNS} 轮）清理了 ${total} 条载荷。`);
} else {
  console.log("用法：npm run tool-history [stats|purge|trim] [contactId]");
  process.exitCode = 1;
}
