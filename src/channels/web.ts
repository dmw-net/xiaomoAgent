// 内置 Web 通道：既是 MVP 的正式入口（手机浏览器打开即可用），也是本地测试台。
//
// 「先 ack、再异步」在这里落地：
//   receive() 只做两件事——建处理单、把处理丢到后台，然后立刻返回。
//   所以 HTTP 请求不会因为等模型而超时，这跟 IM 平台的回调要求是同一个道理。

import { randomUUID } from "node:crypto";
import { getTurn, getTurnByClientId, createTurn, insertMessage, respondToTurn, retryTurn } from "../chat/agent.ts";
import type { Channel, ReceiveOptions } from "./types.ts";

export const webChannel: Channel = {
  id: "web",

  receive(text: string, contactId: string, attachments?: string[], source?: string, clientId?: string, options?: ReceiveOptions): { turnId: string } {
    // 离线发件箱会带着同一个 clientId 重试：已经建过就返回原处理单，不重复落用户消息。
    if (clientId) {
      const existing = getTurnByClientId(contactId, clientId);
      if (existing) {
        // 幂等重放只该保证「不重复落一条用户消息」，不该保证「失败了也不重来」：
        // failed/cancelled 的旧单光回个 turnId，客户端"重发"之后永远等不到回复。
        // 重新点火一次；在跑/已成功的单仍按幂等原样返回。
        if (existing.status === "failed" || existing.status === "cancelled") {
          void retryTurn(existing.id).catch(() => { /* 失败已写进 turns.error */ });
        }
        return { turnId: existing.id };
      }
    }
    const turnId = randomUUID();
    try {
      createTurn({
        id: turnId,
        channel: source ?? "web",
        text,
        contactId,
        conversationId: options?.conversationId,
        attachments,
        attachmentMeta: options?.attachmentMeta,
        triggerMessageId: options?.sourceMessageId,
        clientId,
      });
      // 平台入站必须带着发送者/平台消息 id 落库；turnHasUserMessage 会据此避免
      // respondToTurn 再插一条没有发送者信息的重复用户消息。
      if (options?.conversationId) {
        insertMessage({
          channel: source ?? "web",
          role: "user",
          text,
          turnId,
          contactId,
          conversationId: options.conversationId,
          senderId: options.senderId ?? null,
          senderName: options.senderName ?? null,
          sourceMessageId: options.sourceMessageId ?? null,
          replyToMessageId: options.replyToMessageId ?? null,
          atBot: options.atBot === true,
          sourceMeta: options.sourceMeta ?? null,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(options?.attachmentMeta && options.attachmentMeta.length > 0 ? { attachmentMeta: options.attachmentMeta } : {}),
        });
      }
    } catch (error) {
      // 两个离线重发同一刻撞上唯一索引：输的一方认领赢家那张单，别把 500 透给用户。
      const existing = clientId ? getTurnByClientId(contactId, clientId) : null;
      if (existing) return { turnId: existing.id };
      throw error;
    }

    // 故意不 await：这一步是"后台异步处理"，处理多久都不影响上面的 202 返回。
    // 失败已在 respondToTurn 里写到 turns.error，前端轮询能看到。
    void (async () => {
      const turn = getTurn(turnId);
      if (!turn) return;
      try {
        await respondToTurn(turn);
      } catch {
        // 已记录到处理单，这里不再重复处理。
      }
    })();

    return { turnId };
  },

  async deliver(message): Promise<void> {
    // Web 通道的"发送"就是写库：前端轮询 /api/messages 会把它渲染出来。
    // IM 通道在这里应该调平台的发消息接口。
    insertMessage({
      channel: "web",
      role: "assistant",
      text: message.text,
      kind: message.kind,
      contactId: message.contactId,
      // 主动性也能带图（联系人画的那张）。空数组不落列，保持"绝大多数消息没有附件"的 NULL。
      ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      ...(message.attachmentMeta && message.attachmentMeta.length > 0 ? { attachmentMeta: message.attachmentMeta } : {}),
    });
  },
};
