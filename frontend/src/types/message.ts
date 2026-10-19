/** 与后端 messages / turns 表对应的行类型，以及对话页的界面态。 */

/** 消息行与处理单是 HTTP 契约，类型与后端同源：见仓库根 shared/api.ts。 */
export type { MessageRow, TurnSummary as TurnRow } from "../../../shared/api";

/** 聊天流内的临时提示条（可带重试按钮）。 */
export type Notice = {
  id: number;
  text: string;
  info?: boolean;
  retryTurnId?: string;
};

/** 上下文占用（/api/context/usage）：token 为估算值，仅用于展示占比。 */
export type ContextUsage = {
  model: string;
  limit: number;
  /** limit 来自「输入上限未填」时的保守估算，不是模型真实窗口——提示必须说破。 */
  limitIsFallback?: boolean;
  used: number;
  /** 本次纳入上下文的历史轮数（一问一答算一轮）。 */
  turns?: number;
  /** 这段关系一共聊了多少轮（活着的 user 消息数）。 */
  totalTurns?: number;
  /** 整段历史（不受回放窗口限制）的体量：资料页用它把「全部轮数」这一档的代价摆出来。 */
  fullHistory?: { turns: number; tokens: number };
  /** 当前生效的「回放最近 N 轮」设置。 */
  recentTurnsSetting?: number;
  /** 因回放轮数设置而未纳入上下文的更早轮数（截断可见化）。 */
  overflowTurns?: number;
  /** 因装不进窗口而被丢掉的历史轮数——成因与 overflowTurns 不同，提示要分开给。 */
  droppedByBudget?: number;
  parts: Array<{ key: string; label: string; tokens: number }>;
};
