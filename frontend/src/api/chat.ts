import { cq, deleteJson, getJson, postJson, putJson, LONG_TASK_TIMEOUT_MS } from "./client";
import type { ContextUsage, MessageAttachmentMeta, MessageRow, ThinkingControl, ThinkingQuickChoice, TurnRow } from "../types";

/** 联系人作用域 + 可选会话作用域；会话 id 为空时走服务端本地默认会话。 */
function cqc(base: string, cid?: string, conversationId?: string): string {
  const withContact = cq(base, cid);
  return conversationId ? withContact + "&conversationId=" + encodeURIComponent(conversationId) : withContact;
}

/** 上下文占用（当前会话）：打开浮层时拉一次。 */
export function fetchContextUsage(cid?: string, conversationId?: string): Promise<ContextUsage> {
  return getJson(cqc("/api/context/usage", cid, conversationId));
}

/** 当前联系人的模型思考控制面：输入区的强度快捷开关用。 */
export function fetchThinkingControl(cid?: string): Promise<ThinkingControl> {
  return getJson(cq("/api/model/thinking", cid));
}

/** 切换当前模型的思考设置；auto=跟随模型，on/off=显式开关，其余=具体强度。 */
export function setThinkingLevel(level: ThinkingQuickChoice, cid?: string): Promise<ThinkingControl> {
  return postJson(cq("/api/model/thinking", cid), { level });
}

/** 增量拉取：只要 since 之后的新消息。 */
export function fetchMessages(since: number, cid?: string, conversationId?: string): Promise<{
  modelReady: boolean; onboardingDone: boolean; personaIsDefault?: boolean; messages: MessageRow[];
}> {
  return getJson(cqc("/api/messages?since=" + since, cid, conversationId));
}

/** 全量拉取（含已失效消息）——初次加载与"整段后续都变了"的操作之后的整体重绘用。
 *  total/olderRemaining 由服务端报：界面自己数行数会与服务端页大小脱钩。 */
export function fetchAllMessages(cid?: string, conversationId?: string): Promise<{
  modelReady: boolean; onboardingDone: boolean; personaIsDefault?: boolean;
  messages: MessageRow[]; total: number; olderRemaining: number;
}> {
  return getJson(cqc("/api/messages?all=1", cid, conversationId));
}

/** 会话内搜索：只在当前联系人里找，返回命中消息供前后跳转。 */
export function searchMessages(q: string, cid?: string, conversationId?: string): Promise<{ q: string; messages: MessageRow[] }> {
  return getJson(cqc("/api/messages/search?q=" + encodeURIComponent(q.trim()), cid, conversationId));
}

/** 搜索命中不在当前窗口时，按命中消息取前后一页，直接把它带进视口。 */
export function fetchMessagesAround(id: number, cid?: string, conversationId?: string): Promise<{
  messages: MessageRow[]; total: number; olderRemaining: number;
}> {
  return getJson(cqc("/api/messages/around?id=" + id, cid, conversationId));
}

/** 「载入更早」：从 beforeId 往回再取一页（长对话不再被首屏那 500 条封顶闷住）。 */
export function fetchEarlierMessages(beforeId: number, cid?: string, conversationId?: string): Promise<{
  messages: MessageRow[]; total: number; olderRemaining: number;
}> {
  return getJson(cqc("/api/messages?all=1&before=" + beforeId, cid, conversationId));
}

/**
 * 只重取一条处理单产生的行。
 * 撤回 / 删除 / 停止 / 改一句文字都只动那一轮，为一行变化重敲整页（实测 500 行 / 250 KB）不值。
 */
export function fetchTurnMessages(turnId: string, cid?: string, conversationId?: string): Promise<{ messages: MessageRow[] }> {
  return getJson(cqc("/api/messages?turn=" + encodeURIComponent(turnId), cid, conversationId));
}

/** 后端返回扁平结构（无 turn 包装字段）——Phase 2 曾凭空假设 { turn } 导致轮询永远失败。
 *  reply 有两个身份：running 时是「联系人正在写的这一句」（流式草稿，后端按 200ms 节流写），
 *  done 后是整轮定稿。所以界面只在 running 时拿它当草稿显示，别在其它状态读它。
 *  lean=1：在飞轮瘦身响应——不带 reply/reasoning 正文（它们正以 draft/thought 流式帧
 *  推过来），只带状态与 draftSeq/reasoningSeq（增量帧的续接点，断档检测用）。 */
export function fetchTurn(id: string, cid?: string, opts?: { lean?: boolean }): Promise<{
  id: string; status: string; reply: string | null; reasoning: string | null; error: string | null;
  draftSeq?: number; reasoningSeq?: number;
}> {
  return getJson(cq("/api/turn/" + encodeURIComponent(id), cid) + (opts?.lean ? "&lean=1" : ""));
}

export function retryTurn(id: string, cid?: string): Promise<unknown> {
  return postJson(cq("/api/turn/" + encodeURIComponent(id) + "/retry", cid));
}

/** 重新生成：整轮回答作废重答，仅对最新一轮开放（后端校验）。 */
/** 终止还在飞的那一轮：整轮抹掉不留痕。已结束的处理单会被后端拒成 400。 */
export function cancelTurn(id: string, cid?: string): Promise<unknown> {
  return postJson(cq("/api/turn/" + encodeURIComponent(id) + "/cancel", cid));
}

export function regenerateTurn(id: string, cid?: string): Promise<unknown> {
  return postJson(cq("/api/turn/" + encodeURIComponent(id) + "/regenerate", cid));
}

/** 切换这一轮回复的版本（swipe）：后端把选中版本写回气泡行，并把该轮的新行随响应带回。 */
export function setTurnVariant(id: string, index: number, cid?: string): Promise<{ ok: boolean; applied: boolean; index: number; messages?: MessageRow[] }> {
  return postJson(cq("/api/turn/" + encodeURIComponent(id) + "/variant", cid), { index });
}

/** 说一句话：立刻返回 202 + turnId，回复走轮询。attachments 为 /api/media 返回的 URL 列表。 */
export function say(text: string, attachments?: string[], cid?: string, clientId?: string, conversationId?: string, attachmentMeta?: MessageAttachmentMeta[]): Promise<{ turnId: string }> {
  return postJson(cqc("/api/say", cid, conversationId), {
    text,
    ...(attachments && attachments.length ? { attachments } : {}),
    ...(attachmentMeta && attachmentMeta.length ? { attachmentMeta } : {}),
    ...(clientId ? { clientId } : {}),
  }, LONG_TASK_TIMEOUT_MS);
}

/** 上传一张图片（二进制直传），返回 /media URL。 */
export async function uploadImage(blob: Blob): Promise<{ url: string }> {
  const res = await fetch("/api/media", {
    method: "POST",
    headers: { "content-type": blob.type || "image/jpeg" },
    body: blob,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as { url: string };
}

/** 上传一段原始录音，返回持久化的 /media URL。 */
export async function uploadVoice(blob: Blob): Promise<{ url: string; mime: string }> {
  const res = await fetch("/api/media/voice", {
    method: "POST",
    headers: { "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as { url: string; mime: string };
}

/** 录音 dataURL → 文字。 */
export function transcribe(audioDataUrl: string): Promise<{ text: string }> {
  return postJson("/api/asr", { audio: audioDataUrl }, LONG_TASK_TIMEOUT_MS);
}

/** 文本 → mp3 dataURL（语音合成）。 */
export function synthesize(text: string): Promise<{ dataUrl: string }> {
  return postJson("/api/tts", { text }, LONG_TASK_TIMEOUT_MS);
}

/** 编辑自己说过的话：从这句重新开始，立刻返回 turnId。
 *  cid 必须带：服务端按它校验这条消息归不归这个联系人（消息 id 是自增整数，不校验就能改到别人的）。 */
export function editMessage(id: number, text: string, attachments?: string[], cid?: string): Promise<{ turnId: string }> {
  // attachments 不传 = 不动附件；传数组（含空数组）= 覆盖（编辑框里删图/换图）
  return postJson(cq("/api/message/" + id + "/edit", cid), { text, ...(attachments === undefined ? {} : { attachments }) });
}

/** 只改这一句的文本，不重新生成、不作废任何后续。联系人的回复与自己早前的话都走这条。 */
export function editMessageText(id: number, text: string, cid?: string): Promise<{ note?: string }> {
  return putJson(cq("/api/message/" + id + "/text", cid), { text });
}

/** 撤回单条（软：摘出上下文，联系人的回复保留）。 */
export function retractMessage(id: number, cid?: string): Promise<unknown> {
  return postJson(cq("/api/message/" + id + "/retract", cid));
}

/** 删除整轮（硬：真删行，不可恢复）。 */
export function deleteMessage(id: number, cid?: string): Promise<unknown> {
  return deleteJson(cq("/api/message/" + id, cid));
}

/** 最近处理单。`active` 是还在飞（queued/running）的那一轮（按联系人查询时服务端带回）：
 *  重答**较早**轮次时那一轮排不进「最新一条」，聊天页靠它把 watch 接回来——
 *  与最新轮同一次往返带回，不必按状态再打一发。 */
export function fetchRecentTurns(limit: number, cid?: string, conversationId?: string): Promise<{ turns: TurnRow[]; active?: TurnRow | null }> {
  return getJson(cqc("/api/turns/recent?limit=" + limit, cid, conversationId));
}
