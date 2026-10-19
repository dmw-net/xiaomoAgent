/** 记忆页的数据形态（/api/memory/* 下发）。 */

export type MemoryEvent = {
  id: number;
  kind: string;
  subject: string;
  content: string;
  created_at: number;
  last_used_at: number | null;
};

export type MemoryStats = {
  total: number;
  byKind: Record<string, number>;
  usedRecently: number;
  extractFailures: number;
  thisWeek: number;
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
