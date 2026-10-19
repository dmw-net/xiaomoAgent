// 内置 Web 通道：既是 MVP 的正式入口（手机浏览器打开即可用），也是本地测试台。
//
// 「先 ack、再异步」在这里落地：
//   receive() 只做两件事——建处理单、把处理丢到后台，然后立刻返回。
//   所以 HTTP 请求不会因为等模型而超时，这跟 IM 平台的回调要求是同一个道理。

import { randomUUID } from "node:crypto";
import { getTurn, getTurnByClientId, createTurn, insertMessage, respondToTurn } from "../agent.ts";
import type { Channel } from "./types.ts";

export const webChannel: Channel = {
  id: "web",

  receive(text: string, contactId: string, attachments?: string[], source?: string, clientId?: string): { turnId: string } {
    // 离线发件箱会带着同一个 clientId 重试：已经建过就返回原处理单，不重复落用户消息。
    if (clientId) {
      const existing = getTurnByClientId(contactId, clientId);
      if (existing) return { turnId: existing.id };
    }
    const turnId = randomUUID();
    try {
      createTurn({ id: turnId, channel: source ?? "web", text, contactId, attachments, clientId });
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
      // 主动性也能带图（她画的那张）。空数组不落列，保持"绝大多数消息没有附件"的 NULL。
      ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    });
  },
};
