import { contactId as activeContactId, deleteJson, getJson, postJson, putJson } from "./client";
import type { ContactItem } from "../types";

/** 联系人级可插拔陪伴能力（与后端 CompanionFeatures 对齐；缺键按后端 FEATURE_DEFAULTS 解析，
 *  除 memoryExtract/splitReply/showThinking/showTools 默认开外，其余默认关）。 */
export type CompanionFeatures = {
  /** 记忆提取：每次回复后把新发生的事记进记忆库。默认开（历史行为，关掉才是变更）；温度计随它的刷新绑在这一项上。 */
  memoryExtract: boolean;
  lifeline: boolean;
  /** 窗口边缘梗概：被挤出回放窗口的对话压成「上次说到」继续带着。 */
  recap: boolean;
  consolidate: boolean;
  reminders: boolean;
  /** 图像生成：她能画一张发回来（要 设置 → 能力模型 → 图像生成 配好才真生效）。默认关。 */
  imageGen: boolean;
  /**
   * 联网：web_search / web_fetch 两个工具对她可见。默认关——这是唯一会主动向外发请求的能力，
   * 且抓回的网页文字会进她的上下文（结果里已强制标注"只当资料"）。设置助手不受这一项影响。
   */
  web: boolean;
  /** 一轮里最多调几次工具；0 = 跟随全局（默认 3），1~8。助手自己固定放开到 8。 */
  toolRounds: number;
  bond: boolean;
  /** 分多条回复：按句子切气泡 + 打字节奏。默认开（既有行为），关掉=整条一个气泡。 */
  splitReply: boolean;
  /** 按会话比例回放：>0 时优先于 recent_turns，带「总轮数 × 百分比」的最近轮。 */
  turnPct: number;
  /** 历史占比上限：对话历史最多占输入窗口的百分比，0 = 不设这一维。 */
  tokenPct: number;
  /** 聊天框里显不显示「思考过程」折叠条 / 工具调用过程卡片（纯显示，不影响落库）。 */
  showThinking: boolean;
  showTools: boolean;
  /** 0 = 跟随全局默认；1~10 为每联系人每日主动上限。 */
  dailyLimit: number;
  /** 采样温度：-1 = 跟随全局（0.8），0~2 = 这一位单独设。0 是合法值，所以用 -1 当"跟随"。 */
  temperature: number;
  /** 禁用词：她的回复里不该出现的词，逗号/顿号/换行分隔（最多 10 个）。 */
  bannedWords: string;
  schedule: string;
  lastConsolidatedAt: number | null;
};

export type BondState = { stage: string; warmth: number; mood: string; updated_at: number | null };

export type ContactDetail = {
  id: string;
  name: string;
  avatar: string;
  /** 长相参考图：/media 路径（不是 dataURL）。她画自拍时按这张脸来画。空 = 没存。 */
  faceRef?: string;
  model_profile?: string;
  /** 回放轮数覆盖；0/缺省 = 跟随全局。 */
  recent_turns?: number;
  /** 角色性别：female/male/other，驱动界面代词。 */
  gender?: string;
  card: Record<string, string>;
  features?: CompanionFeatures;
  lifeline?: string;
  lifeline_at?: number | null;
  /** 窗口边缘梗概正文（系统维护，可手改）。 */
  recap?: string;
  bond?: BondState;
};

/**
 * 会话列表。带 q 时由**后端**按「名字 / 人设三段 / 预览」筛（人设正文不下发——
 * 它曾占掉列表响应体的 48%，而这份列表前台每 10 秒整份重拉）。
 */
export function fetchContacts(q = ""): Promise<{ contacts: ContactItem[] }> {
  return getJson(q.trim() === "" ? "/api/contacts" : "/api/contacts?q=" + encodeURIComponent(q.trim().slice(0, 40)));
}

export function fetchContact(id: string): Promise<{ contact: ContactDetail }> {
  return getJson("/api/contacts/" + encodeURIComponent(id));
}

export function createContact(payload: Record<string, unknown>): Promise<{ contact: { id: string } }> {
  return postJson("/api/contacts", payload);
}

/** 上报某联系人已读到哪条消息（清红点）。cid 省略时用当前联系人。 */
export function markRead(cid: string | undefined, messageId: number): Promise<unknown> {
  return postJson("/api/contacts/read", { contactId: cid || activeContactId(), messageId });
}

export function updateContact(id: string, payload: Record<string, unknown>): Promise<{ contact: { id: string } }> {
  return putJson("/api/contacts/" + encodeURIComponent(id), payload);
}

export function archiveContact(id: string): Promise<unknown> {
  return postJson("/api/contacts/" + encodeURIComponent(id) + "/archive");
}

/** 人格三段换回出厂那份（名字/头像/性别/能力开关都不动）。 */
export function resetContactCard(id: string): Promise<{ contact: ContactDetail; note?: string }> {
  return postJson("/api/contacts/" + encodeURIComponent(id) + "/reset-card");
}

/**
 * 出厂那份人格三段。新建联系人时「换回默认人设」用它填表单——
 * 那一刻还没有 contact id，resetContactCard 会拼出 /api/contacts//reset-card。
 * 真源在后端的 defaultPersona()，前端不抄一份。
 */
export function fetchDefaultCard(): Promise<{ card: { identity: string; background: string; relationship: string } }> {
  return getJson("/api/persona/default-card");
}

/** 手动触发一次记忆整理。跳过（echo/并发）是 ok:true + skipped:true 的诚实状态，不是错误。 */
export function consolidateContact(id: string): Promise<{
  ok: true;
  skipped: boolean;
  note: string;
  events?: number;
  merged?: number;
  expired?: number;
  lifelineUpdated?: boolean;
  bondUpdated?: boolean;
}> {
  return postJson("/api/contacts/" + encodeURIComponent(id) + "/consolidate");
}

/** 已归档联系人（含 archivedAt；用于侧栏「已归档」分组）。 */
export function fetchArchivedContacts(): Promise<{ contacts: Array<ContactItem & { archivedAt: number }> }> {
  return getJson("/api/contacts?archived=1");
}

/** 恢复归档：回到列表，对话与记忆原样。 */
export function unarchiveContact(id: string): Promise<unknown> {
  return postJson("/api/contacts/" + encodeURIComponent(id) + "/unarchive");
}

/** 彻底删除已归档联系人：对话/记忆/任务/图片全清，不可恢复。未归档会被后端拒。 */
export function deleteContact(id: string): Promise<{ removedMedia?: number }> {
  return deleteJson("/api/contacts/" + encodeURIComponent(id));
}
