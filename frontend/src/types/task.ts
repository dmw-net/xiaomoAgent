/** 主动性任务（打算）：任务视图与状态页共用。 */
export type TaskRow = {
  id: number;
  focus: string;
  /** care = 到点问模型「该不该说」；reminder = 到点原样送达、不吃每日配额。 */
  kind?: "care" | "reminder" | string;
  due_at: number;
  status: "pending" | "done" | "failed" | "skipped" | "cancelled" | string;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "待执行",
  done: "完成",
  failed: "失败",
  skipped: "已放弃",
  cancelled: "已取消",
};
