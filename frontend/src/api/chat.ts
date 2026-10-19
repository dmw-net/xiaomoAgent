import { cq, deleteJson, getJson, postJson, putJson } from "./client";
import type { ContextUsage, MessageRow, TurnRow } from "../types";

/** 上下文占用（当前联系人）：打开浮层时拉一次。 */
export function fetchContextUsage(cid?: string): Promise<ContextUsage> {
  return getJson(cq("/api/context/usage", cid));
}

/** 增量拉取：只要 since 之后的新消息。 */
export function fetchMessages(since: number, cid?: string): Promise<{
  modelReady: boolean; onboardingDone: boolean; personaIsDefault?: boolean; messages: MessageRow[];
}> {
  return getJson(cq("/api/messages?since=" + since, cid));
}

/** 全量拉取（含已失效消息）——初次加载与"整段后续都变了"的操作之后的整体重绘用。
 *  total/olderRemaining 由服务端报：界面自己数行数会与服务端页大小脱钩。 */
export function fetchAllMessages(cid?: string): Promise<{
  modelReady: boolean; onboardingDone: boolean; personaIsDefault?: boolean;
  messages: MessageRow[]; total: number; olderRemaining: number;
}> {
  return getJson(cq("/api/messages?all=1", cid));
}

/** 会话内搜索：只在当前联系人里找，返回命中消息供前后跳转。 */
export function searchMessages(q: string, cid?: string): Promise<{ q: string; messages: MessageRow[] }> {
  return getJson(cq("/api/messages/search?q=" + encodeURIComponent(q.trim()), cid));
}

/** 搜索命中不在当前窗口时，按命中消息取前后一页，直接把它带进视口。 */
export function fetchMessagesAround(id: number, cid?: string): Promise<{
  messages: MessageRow[]; total: number; olderRemaining: number;
}> {
  return getJson(cq("/api/messages/around?id=" + id, cid));
}

/** 「载入更早」：从 beforeId 往回再取一页（长对话不再被首屏那 500 条封顶闷住）。 */
export function fetchEarlierMessages(beforeId: number, cid?: string): Promise<{
  messages: MessageRow[]; total: number; olderRemaining: number;
}> {
  return getJson(cq("/api/messages?all=1&before=" + beforeId, cid));
}

/**
 * 只重取一条处理单产生的行。
 * 撤回 / 删除 / 停止 / 改一句文字都只动那一轮，为一行变化重敲整页（实测 500 行 / 250 KB）不值。
 */
export function fetchTurnMessages(turnId: string, cid?: string): Promise<{ messages: MessageRow[] }> {
  return getJson(cq("/api/messages?turn=" + encodeURIComponent(turnId), cid));
}

/** 后端返回扁平结构（无 turn 包装字段）——Phase 2 曾凭空假设 { turn } 导致轮询永远失败。
 *  reply 有两个身份：running 时是「她正在写的这一句」（流式草稿，后端按 200ms 节流写），
 *  done 后是整轮定稿。所以界面只在 running 时拿它当草稿显示，别在其它状态读它。 */
export function fetchTurn(id: string, cid?: string): Promise<{ id: string; status: string; reply: string | null; error: string | null }> {
  return getJson(cq("/api/turn/" + encodeURIComponent(id), cid));
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

/** 说一句话：立刻返回 202 + turnId，回复走轮询。attachments 为 /api/media 返回的 URL 列表。 */
export function say(text: string, attachments?: string[], cid?: string, clientId?: string): Promise<{ turnId: string }> {
  return postJson(cq("/api/say", cid), {
    text,
    ...(attachments && attachments.length ? { attachments } : {}),
    ...(clientId ? { clientId } : {}),
  });
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

/** 录音 dataURL → 文字。 */
export function transcribe(audioDataUrl: string): Promise<{ text: string }> {
  return postJson("/api/asr", { audio: audioDataUrl });
}

/** 文本 → mp3 dataURL（语音合成）。 */
export function synthesize(text: string): Promise<{ dataUrl: string }> {
  return postJson("/api/tts", { text });
}

/** 编辑自己说过的话：从这句重新开始，立刻返回 turnId。
 *  cid 必须带：服务端按它校验这条消息归不归这个联系人（消息 id 是自增整数，不校验就能改到别人的）。 */
export function editMessage(id: number, text: string, attachments?: string[], cid?: string): Promise<{ turnId: string }> {
  // attachments 不传 = 不动附件；传数组（含空数组）= 覆盖（编辑框里删图/换图）
  return postJson(cq("/api/message/" + id + "/edit", cid), { text, ...(attachments === undefined ? {} : { attachments }) });
}

/** 只改这一句的文本，不重新生成、不作废任何后续。她的回复与自己早前的话都走这条。 */
export function editMessageText(id: number, text: string, cid?: string): Promise<{ note?: string }> {
  return putJson(cq("/api/message/" + id + "/text", cid), { text });
}

/** 撤回单条（软：摘出上下文，她的回复保留）。 */
export function retractMessage(id: number, cid?: string): Promise<unknown> {
  return postJson(cq("/api/message/" + id + "/retract", cid));
}

/** 删除整轮（硬：真删行，不可恢复）。 */
export function deleteMessage(id: number, cid?: string): Promise<unknown> {
  return deleteJson(cq("/api/message/" + id, cid));
}

export function fetchRecentTurns(limit: number, cid?: string): Promise<{ turns: TurnRow[] }> {
  return getJson(cq("/api/turns/recent?limit=" + limit, cid));
}
