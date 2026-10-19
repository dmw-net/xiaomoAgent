// 通道抽象：把「消息从哪来、往哪去」和「怎么处理」彻底分开。
//
// 为什么先做这一层：MVP 先用内置 Web 页当通道（立刻可测、零风险），
// Agent 与记忆层因此一行都不用改。反面教材：把平台逻辑写进业务代码，换一个平台就要动全身。
//
// 但要诚实：**真正实现 Channel 的至今只有 web**。微信（src/wechat.ts）与 QQ（src/qq.ts）
// 都已经接上了，走的却不是这个接口——各自有绑定/收件/投递一整套链路，出站时再调
// getChannel("web") 把话镜像进内置会话。所以这个接口现在的真实身份是「web 出站的抽象」，
// 不是"多通道框架"；接第三条通道时再决定要不要把它们也套进来。

export type ChannelId = string;

export type OutgoingMessage = {
  text: string;
  kind: "chat" | "proactive";
  /** 送达哪个联系人（会话按 contact_id 隔离，主动发言必须知道自己对谁说）。 */
  contactId: string;
  /** 随这条话一起出现的 /media 路径（主动性出图用）。IM 通道发不出媒体就只取 text。 */
  attachments?: string[];
};

export interface Channel {
  readonly id: ChannelId;
  /**
   * 收到一条用户消息：立刻返回处理单 id，不等待处理完成（平台回调通常要求秒级返回）。
   *
   * `source` 记这条消息**从哪个通道来**（"web" / "wechat" / "qq"），默认 web。
   * 它落进 messages.channel 与 turns.channel，于是：
   *  ① 排障时看得见"这句话是微信里说的"，不是只能看到一段 user 消息；
   *  ② 记忆抽取能按来源给不同的外壳（见 memory.ts 的 extractMemories）——
   *     第三方平台发来的文字是不可信输入，和本机界面里打的那句不是一回事。
   */
  receive(text: string, contactId: string, attachments?: string[], source?: string, clientId?: string): { turnId: string };
  /** 把助手要说的话送出去。Web = 写库等前端轮询；IM = 调平台发消息接口。 */
  deliver(message: OutgoingMessage): Promise<void>;
}

const registry = new Map<ChannelId, Channel>();

export function registerChannel(channel: Channel): void {
  registry.set(channel.id, channel);
}

export function getChannel(id: ChannelId): Channel | undefined {
  return registry.get(id);
}

export function listChannels(): ChannelId[] {
  return [...registry.keys()];
}
