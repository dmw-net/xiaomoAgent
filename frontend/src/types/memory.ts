/** 记忆页的数据形态（/api/memory/* 下发）。 */

export type MemoryEvent = {
  id: number;
  kind: string;
  subject: string;
  content: string;
  created_at: number;
  last_used_at: number | null;
  /** global=联系人全局；conversation=当前会话；member=当前群成员。 */
  scope_kind?: "global" | "conversation" | "member";
  scope_conversation_id?: string | null;
  subject_id?: string | null;
  subject_name?: string | null;
  source_message_id?: string | null;
  source_conversation_id?: string | null;
};

export type MemoryStats = {
  total: number;
  byKind: Record<string, number>;
  usedRecently: number;
  extractFailures: number;
  thisWeek: number;
  /** 近 50 次合法抽取中，本轮无需记录的比例；0~1。null = 样本不足。 */
  emptyRate: number | null;
  /** 参与 emptyRate 统计的抽取次数。 */
  extractSamples: number;
};

/** 召回试验台的返回（err 非空表示这次查询失败）。 */
export type RecallResult = {
  events: MemoryEvent[];
  total: number;
  keywords: string[];
  scores?: Record<string, number>;
  matched?: Record<string, string[]>;
  err?: string;
};
