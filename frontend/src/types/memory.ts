/** 记忆页的数据形态（/api/memory/* 下发）。 */

export type MemoryEvent = {
  id: number;
  kind: string;
  subject: string;
  content: string;
  created_at: number;
  last_used_at: number | null;
  /** global=跨所有对话；conversation=只属于某一段会话（主私聊或某个群）。 */
  scope_kind?: "global" | "conversation";
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

/**
 * 记忆空间：一条记忆归属的对话范围，只有两层——跨所有对话的全局，或某一段会话
 * （主私聊 / 某个群）。清单按**归属分区**切（一条只落在一个空间里），与召回的
 * 可见范围不同：全局记忆在任何会话都能被想起，但它在清单里只出现在「全局」那一栏。
 */
export type MemorySpaceSelection =
  | { kind: "all" }
  | { kind: "global" }
  | { kind: "conversation"; conversationId: string };

export type MemorySpaceGroupCount = {
  conversationId: string;
  title: string;
  count: number;
  left: boolean;
};

/** GET /api/memory/spaces 的返回：这位联系人的记忆按空间盘一遍。 */
export type MemorySpaceInventory = {
  global: number;
  private: { conversationId: string; title: string; count: number };
  groups: MemorySpaceGroupCount[];
};
