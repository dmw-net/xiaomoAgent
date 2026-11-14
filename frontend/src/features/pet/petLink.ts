import { onBusEvent, startEventBus } from "../../lib/eventBus";
import { getCachedContacts, refreshContacts, subscribeContacts } from "../../lib/contactsStore";

/**
 * 桌宠 × 联系人联动：把总线上的会话动静仲裁成桌宠能演的三种信号。
 *
 * 纪律：
 * - 总线是提示通道：这里只取 role/channel/status 这类元数据分流；气泡里的
 *   名字与预览一律从 contactsStore 的缓存取（总线事件本身就会触发它刷新）。
 * - 「主人自己发的」不反应：/api/say 落库 channel=web；联系人来的（QQ 等
 *   通道入站）channel 是通道名。assistant 行由轮次联动覆盖，这里跳过。
 * - 生成中的新消息不再叠加提示（回复途中自打岔）。
 * - 每页一个实例：桌宠窗口页与主窗口各自起一条 SSE（服务端多连接无假设），
 *   返回的 stop 负责全部退订（StrictMode 双挂载安全）。
 */

export type PetLinkHandlers = {
  /** 小茉开始回复某位联系人（含排队中）：桌宠进工作状态。 */
  onGeneratingStart: (contactId: string, name: string) => void;
  /** 全部在飞回复收尾：ok = 全部 done，false = 有失败/取消。 */
  onGeneratingEnd: (ok: boolean) => void;
  /** 联系人来了新消息（主人在应用里自己发的除外）。 */
  onIncomingMessage: (contactId: string, name: string, preview: string) => void;
};

export function startPetLink(handlers: PetLinkHandlers): () => void {
  startEventBus();
  // 联系人名单：名字 / 消息预览给气泡用；引用计数轮询（最后一个退订者清定时器）。
  const stopContacts = subscribeContacts(() => undefined);
  refreshContacts();

  const generating = new Set<string>();

  const nameOf = (contactId: string): string =>
    getCachedContacts().find((c) => c.id === contactId)?.name ?? "联系人";

  const previewOf = (contactId: string): string =>
    getCachedContacts().find((c) => c.id === contactId)?.preview ?? "";

  // 页面刚加载时接上已在飞的回复（对齐 ChatView 切回联系人时的接管配方）。
  void (async () => {
    try {
      const r = await fetch("/api/turns/recent?status=active&limit=10");
      if (!r.ok) return;
      const d = (await r.json()) as { turns?: Array<{ contact_id?: string | null; status?: string }> };
      for (const t of d.turns ?? []) {
        if (t.status !== "queued" && t.status !== "running") continue;
        const id = t.contact_id;
        if (!id || generating.has(id)) continue;
        generating.add(id);
        handlers.onGeneratingStart(id, nameOf(id));
      }
    } catch { /* 联动是锦上添花，拉不到就等下一条事件 */ }
  })();

  const offBus = onBusEvent((e) => {
    if (e.type === "turn") {
      if (e.status === "running" || e.status === "queued") {
        if (!generating.has(e.contactId)) {
          generating.add(e.contactId);
          handlers.onGeneratingStart(e.contactId, nameOf(e.contactId));
        }
        return;
      }
      // done/failed/cancelled：这一轮收尾。还有别的联系人在飞就继续工作。
      if (!generating.delete(e.contactId)) return;
      if (generating.size === 0) handlers.onGeneratingEnd(e.status === "done");
      return;
    }
    if (e.type === "message") {
      // 只对「联系人来的用户行」反应：主人自己发的（web）与 assistant 行跳过；
      // 生成途中不叠加（回复自己的消息时又弹「来了新消息」）。
      if (e.role !== "user" || e.channel === "web") return;
      if (generating.size > 0) return;
      const id = e.contactId;
      const name = nameOf(id);
      const preview = previewOf(id);
      // 名单可能还没到位（缓存被事件触发刷新中）：下一拍再报一次准确的。
      if (name === "联系人") {
        refreshContacts();
        window.setTimeout(() => handlers.onIncomingMessage(id, nameOf(id), previewOf(id)), 600);
        return;
      }
      handlers.onIncomingMessage(id, name, preview);
    }
  });

  return (): void => {
    offBus();
    stopContacts();
    generating.clear();
  };
}
