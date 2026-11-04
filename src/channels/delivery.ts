// 通道出站的公共零件：微信与 QQ 两条 IM 链路共用。
//
// 为什么单独抽一层：两条链路的差别全在「协议怎么说」——iLink 要 context_token、
// QQ 要 msg_id + msg_seq；而「一句话怎么安全地送到对方那里」是同一件事：
// 按上限切段、挡住重复入站、按顺序发、失败留下能读的原因。这一层只放与平台无关的部分，
// 任何认识 ilink / QQBot 字段名的东西留在各自文件里。

/** 外部输入统一从这里过一遍：先转字符串再比。数字型 id 只认 string 会塌成空串。 */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value.trim() : String(value).trim();
}

/** 脱敏显示：界面只需要认出「是哪一个」，不留全量 id。 */
export function redact(value: string): string {
  return value.length <= 8 ? "••••" : "••••" + value.slice(-4);
}

/** 把服务商原始报文挂在错误上：deliverOutbound 的 log 回调会取 error.raw 落进日志全文，
 *  详情弹窗的「服务商返回」才有东西可看（只靠 message 摘要排不动平台侧的怪问题）。 */
export function withRaw(error: Error, raw: string): Error {
  if (raw !== "") (error as { raw?: string }).raw = raw;
  return error;
}

/**
 * 按上限切段。先按空行切（自然边界），段内还超就按字符硬切。
 * 数的是 Unicode 码点不是 UTF-16 单元——否则 emoji 会被从中间劈开。
 */
export function chunkText(text: string, maxUnits: number): string[] {
  const body = text.trim();
  if (body === "") return [];
  const paragraphs = body
    .split(/\r?\n[\t ]*\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  const out: string[] = [];
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [body]) {
    const units = [...paragraph];
    if (units.length <= maxUnits) {
      out.push(paragraph);
      continue;
    }
    for (let start = 0; start < units.length; start += maxUnits) {
      out.push(units.slice(start, start + maxUnits).join(""));
    }
  }
  return out;
}

/**
 * 出站内容 → 平台消息序列。字符串按上限切；数组则一个元素就是一条消息
 * （分条气泡靠它保证「本地几颗气泡、对方几条消息」），元素自身超长再切。
 */
export function chunkSegments(value: string | string[], maxUnits: number): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => chunkText(item, maxUnits));
}

/**
 * 入站幂等窗口：平台都会重投递，同一个键不能进对话两次。
 * 有界 FIFO——记满挤掉最旧的，不能让它一个人长到天上去（它是要落进绑定记录的）。
 */
export class SeenKeys {
  readonly limit: number;
  private readonly order: string[] = [];
  private readonly lookup = new Set<string>();

  constructor(limit: number, initial: string[] = []) {
    this.limit = Math.max(1, limit);
    for (const key of initial) this.remember(key);
  }

  has(key: string): boolean {
    return key !== "" && this.lookup.has(key);
  }

  /** 记下一个键；返回 true 表示它是新的（没记过）。 */
  remember(key: string): boolean {
    if (key === "" || this.lookup.has(key)) return false;
    this.lookup.add(key);
    this.order.push(key);
    while (this.order.length > this.limit) {
      const dropped = this.order.shift();
      if (dropped !== undefined) this.lookup.delete(dropped);
    }
    return true;
  }

  toArray(): string[] {
    return [...this.order];
  }
}

/**
 * 单飞 + TTL 缓存：同一时刻只跑一次取凭证，成功后按有效期复用。
 * 两条链路都要它——界面连点、网关重连、轮询与投递同时抢同一把凭证。
 * force 会绕开缓存与在途请求另起一次（换凭据之后必须重取）。
 */
export class SingleFlight<T> {
  private readonly load: () => Promise<T>;
  private readonly lifetime: (value: T) => number;
  private readonly clock: () => number;
  private held: { value: T; expiresAt: number } | null = null;
  private inFlight: Promise<T> | null = null;

  constructor(load: () => Promise<T>, lifetime: (value: T) => number, clock: () => number) {
    this.load = load;
    this.lifetime = lifetime;
    this.clock = clock;
  }

  async get(force = false): Promise<T> {
    if (!force) {
      if (this.held !== null && this.clock() < this.held.expiresAt) return this.held.value;
      if (this.inFlight !== null) return this.inFlight;
    }
    const attempt = this.load().then((value) => {
      this.held = { value, expiresAt: this.clock() + this.lifetime(value) };
      return value;
    });
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.inFlight === attempt) this.inFlight = null;
    }
  }

  invalidate(): void {
    this.held = null;
    this.inFlight = null;
  }
}

/**
 * 带键的凭证缓存：SingleFlight 管「一把凭证」，这个管「一批可复用的平台侧句柄」——
 * 典型是富媒体上传拿回来的 file_info / media_id：重取一次要好几趟往返，而同一份内容
 * 会被反复发，所以业内都按内容缓存、到期前复用。
 *
 * 键由调用方拼（平台各自的隔离维度不同，例如 QQ 的凭证不能跨私聊/群复用），这里只负责
 * 有效期、主动作废和条数上限。lifetime <= 0 直接不缓存——比平台给的余量还短的凭证不值得占位。
 */
export class CredentialCache<T> {
  readonly limit: number;
  private readonly clock: () => number;
  private readonly held = new Map<string, { value: T; expiresAt: number }>();

  constructor(limit: number, clock: () => number) {
    this.limit = Math.max(1, limit);
    this.clock = clock;
  }

  /** 命中给值；没有或已过期给 undefined（过期的顺手丢掉，不让它占着上限）。 */
  get(key: string): T | undefined {
    const hit = this.held.get(key);
    if (hit === undefined) return undefined;
    if (this.clock() >= hit.expiresAt) {
      this.held.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, lifetimeMs: number): void {
    if (key === "" || lifetimeMs <= 0) return;
    this.held.delete(key); // 先删再插：Map 的迭代序就是插入序，淘汰时才不误伤最近用过的
    this.held.set(key, { value, expiresAt: this.clock() + lifetimeMs });
    while (this.held.size > this.limit) {
      const oldest = this.held.keys().next();
      if (oldest.done === true) break;
      this.held.delete(oldest.value);
    }
  }

  /** 平台说这个凭证已经不作数了（发送失败）：立刻作废，下次调用重取。 */
  invalidate(key: string): void {
    this.held.delete(key);
  }

  get size(): number {
    return this.held.size;
  }
}

/** 出站前的三道闸：有绑定、绑定启用、主动消息要绑定自己同意。 */
export function deliveryAllowed(
  target: { enabled: boolean; proactive: boolean } | null | undefined,
  wantsProactive: boolean,
): boolean {
  if (target === null || target === undefined || !target.enabled) return false;
  return !wantsProactive || target.proactive;
}

export type DeliveryResult = {
  ok: boolean;
  error: string;
};

/**
 * 一次出站投递的完整流程：分段 → 顺序发送 → 成/败都落到调用方手里。
 * 一段失败就停（后面的段没必要再试），并把第一处错误原样交出去——"哪句话没送出去、为什么"
 * 必须能写进 lastError。这个函数自己不抛错：调用方按通道的规矩决定怎么记账。
 */
export async function deliverOutbound(args: {
  segments: string[];
  send: (segment: string, index: number) => Promise<void>;
  elapsed: () => number;
  onDelivered: () => void;
  onFailed: (message: string) => void;
  /** raw：发送层挂在错误上的原始响应报文（error.raw），详情弹窗靠它展示"服务商到底回了什么"。 */
  log: (ok: boolean, message: string, elapsedMs: number, raw?: string) => void;
}): Promise<DeliveryResult> {
  let sent = 0;
  try {
    for (const segment of args.segments) {
      await args.send(segment, sent);
      sent += 1;
    }
    args.onDelivered();
    args.log(true, "", args.elapsed());
    return { ok: true, error: "" };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    const raw = (error as { raw?: unknown }).raw;
    args.onFailed(message);
    args.log(false, message, args.elapsed(), typeof raw === "string" ? raw.slice(0, 2000) : undefined);
    return { ok: false, error: message };
  }
}