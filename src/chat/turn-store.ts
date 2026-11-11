// 轮次表的只读查询：零业务依赖，通道层可以直接问「这一轮结束了吗」。
//
// 为什么单独一层：微信通道的"正在输入"看护只需要读 turns.status，若为它动态
// import 整个 agent.ts，就会形成 outbound → wechat → agent → outbound 的运行时环
// （agent 也要经过出站队列、出站队列又要调微信投递）。把这个纯查询下沉到这里，
// 通道层不认识 Agent 层，依赖保持单向。

import { q } from "../core/db.ts";

export type TurnRow = {
  id: string;
  channel: string;
  text: string;
  contact_id: string | null;
  conversation_id?: string | null;
  trigger_message_id?: string | null;
  trigger_ids?: string | null;
  context_start_id?: number | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  reply: string | null;
  /** 流式思考的累计草稿；只走 /api/turn 给界面看，不参与上下文。 */
  reasoning_draft?: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  /** 附件 URL 的 JSON 数组字符串（"/media/…"），可为 null。 */
  attachments?: string | null;
  /** 附件元信息 JSON；语音消息的时长、转写与波形都在这里。 */
  attachment_meta?: string | null;
  /** 旧数据可能带的作废时间戳（来自已被版本切换取代的「编辑后作废后续」机制）。
   *  非空 = 这一轮已不属于当前对话；现行写入路径不产生它，编辑时仍会清掉它。 */
  superseded_at?: number | null;
  /**
   * 回复版本存档（swipe）：JSON 数组，index 0 = 最初版本，重答追加、封顶 5。
   * 只在服务端内部流转（写入/切换），HTTP 面不下发全量载荷。
   */
  variants?: string | null;
  /** 当前选中的版本序号（0 = 最初版本）。 */
  variant_index?: number | null;
};

export function getTurn(id: string): TurnRow | null {
  const row = q("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | undefined;
  return row ?? null;
}

export function getTurnByClientId(contactId: string, clientId: string): TurnRow | null {
  const row = q("SELECT * FROM turns WHERE contact_id = ? AND client_id = ?").get(contactId, clientId) as TurnRow | undefined;
  return row ?? null;
}
