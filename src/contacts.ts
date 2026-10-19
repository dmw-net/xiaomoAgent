// 联系人：一段独立的关系。
//
// 每个联系人拥有完全隔离的人格（角色卡）、记忆和对话——这是 roadmap P0-3 定死的
// 「完全隔离」路线，不做共享记忆（陪伴场景下，A 记得的事 B 不知道才是真实的）。
//
// 存量迁移：老版本的角色卡存在 kv settings.persona 里、所有业务表没有联系人维度。
// 首次启动时把那张角色卡迁移成 id="default" 的联系人，业务表的空 contact_id 全部归到它名下
// ——老用户升级后什么都不用做，数据原样都在。

import { randomUUID } from "node:crypto";
import { db, kvGet, kvSet, withTx } from "./db.ts";
import { listMediaUrls, mediaUrlExists, releaseMediaFiles } from "./media.ts";
import { sanitizeCharacter, defaultPersona, type CharacterCard } from "./settings.ts";

export const DEFAULT_CONTACT_ID = "default";
/** 内置设置助手的保留联系人 id（实现在 assistant.ts；放这里是为了归档保护不绕圈）。 */
export const ASSISTANT_CONTACT_ID = "assistant";

/**
 * 回放轮数的哨兵值：`contacts.recent_turns = -1` 表示「全部」—— 整段历史都带上，
 * 重量交给上下文 token 预算兜底（装不下的老轮仍会被丢掉，并在界面报「更早 K 轮没带上」）。
 * 0 = 跟随全局，正数 = 具体轮数。
 */
export const ALL_TURNS = -1;
/** 轮数可填的上限：再往上就交给「历史占比上限」和 token 预算管，不设这一维没意义。 */
export const MAX_TURNS = 500;

/**
 * 每联系人的可插拔陪伴能力（借鉴功能包，存在 contacts.features）。
 * **默认全关**：这些能力会改变提示词内容或引入后台模型调用——静默改行为
 * 违背「用户主权、变更必须可见」，所以每一项都要用户在资料页主动打开。
 * 缺键按关解析也顺手消除了"老联系人存的是 {}"的升级歧义：没开过就是没开。
 * 默认开的两个例外都是**历史行为**（它不是新增能力，关掉才是变更，所以保持原样、
 * 由用户主动关）：`splitReply`（一直分气泡回复）与 `memoryExtract`（一直记记忆）。
 */
export type CompanionFeatures = {
  /**
   * 记忆提取：每次回复后把「这段对话新发生的事」蒸馏进关系事件记忆库（副通道、可走轻模型档）。
   * 默认开——它一直就有（历史行为，不是新增能力，关掉才是变更，与 splitReply 同理）。
   * 关掉 = 记忆库停止生长：[记忆] 段还能召回旧条目，但温度计的随对话刷新（withBond）
   * 随它停，只剩记忆整理（若开着）与资料页手改两条路。
   */
  memoryExtract: boolean;
  /** 生活线摘要层：每周整理生成的"我们最近发生了什么"，每轮全量注入。 */
  lifeline: boolean;
  /** 窗口边缘梗概：被回放轮数/预算丢掉的对话，压成一段"上次说到"继续带着走。 */
  recap: boolean;
  /** 记忆整理：定期合并重复、标过期、刷新生活线与温度计（主动性循环里搭车跑）。 */
  consolidate: boolean;
  /** 到点提醒：注册 schedule_reminder 工具，她说"提醒你"就能立下必达的定时任务。 */
  reminders: boolean;
  /**
   * 图像生成：注册 generate_image 工具，她可以画一张发回来。
   * 默认关——一次出图实测 7.8 秒（她那一轮会从 1 秒级变成 9 秒级），且服务商响应里没有
   * usage 字段、算不进 token 账，只能靠每日张数配额兜着，所以不该由应用替用户默认开启。
   */
  imageGen: boolean;
  /**
   * 联网：注册 web_search / web_fetch，她可以查当下的事、为用户找一张图。
   * 默认关——这是本项目里唯一会**主动向外发请求**的能力开关，另外两个面都比它小：
   * ① 抓回来的正文会进她的上下文，等于把不可信文本喂进提示词（结果里已强制标注"只当资料"，
   *    但那是缓解不是消除）；② 抓取有超时与重试，一轮会从秒级变成十秒级。
   * 所以它和图像生成一样，不该由应用替用户默认开启。
   */
  web: boolean;
  /** 关系温度计：抽取时顺手维护的阶段/亲密度/情绪，注入提示词让语气随关系起伏。 */
  bond: boolean;
  /**
   * 分多条回复：把她的答案按句子切成几个气泡、条间带 450~1200ms 的"打字节奏"。
   * 默认开（保持历史行为）。关掉 = 整条落一个气泡、不等待：长回复不再被切碎，
   * 一轮也少 3~4 次延迟落库（实测每轮约省 1.8~4.8 秒）。
   */
  splitReply: boolean;
  /**
   * 聊天框里显不显示「思考过程」折叠条。纯显示开关：数据照旧落库（窗口内），
   * 关掉只是气泡上不出现那条折叠行，状态页/调用记录不受影响。
   * 默认开——关了思考才没有内容，开了思考却看不见就是这次要修的那个 bug。
   */
  showThinking: boolean;
  /** 聊天框里显不显示工具调用过程（ToolCard）。同上是纯显示开关，工具照常调用与留痕。 */
  showTools: boolean;
  /**
   * 按会话比例回放：>0 时优先于 recent_turns —— 带「这段会话总轮数 × 这个百分比」的最近轮。
   * 1~100。轮数是"形状"，百分比是"按这段关系聊了多久来伸缩"。
   */
  turnPct: number;
  /**
   * 历史占比上限：对话历史这一块最多占输入窗口的百分之几（0 = 不按占比设限）。
   * 与「回放轮数」同时生效、取更小的那个；系统提示词/记忆/工具不受它影响。
   */
  tokenPct: number;
  /**
   * 这一位单独设「一轮最多调几次工具」；0 = 跟随全局。1~8。
   * 给"她话不多但要能办事"的角色放开、给纯聊天的收紧，代价是响应时长：
   * 每一轮工具往返都是一次完整的模型调用，8 轮就是八次。
   */
  toolRounds: number;
  /** 每日主动发言上限；0 = 跟随全局默认（PROACTIVE_DAILY_LIMIT）。1~10。 */
  dailyLimit: number;
  /**
   * 采样温度：-1 = 跟随全局（内置默认 0.8），0~2 = 这一位单独设。
   * 用 -1 而不是 0 当"跟随"，是因为 0 本身是个合法取值（要她稳定不复述时用）。
   * 只影响和她的对话，不影响记忆抽取/主动性那些后台调用——那些各有自己的小预算。
   */
  temperature: number;
  /**
   * 禁用词：她的回复里不该出现的词，逗号/顿号/换行分隔，最多 10 个。
   * 做法是把它们拼成一句约束、追加到本轮最后一条 user 消息尾部，不做出站替换——见 src/banned-words.ts。
   */
  bannedWords: string;
  /** 她的作息（几点睡/几点下班等自然语言，≤120 字），注入 [现在] 让她"有自己的生活"。 */
  schedule: string;
  /** 上次记忆整理**成功完成**的时间戳（资料页展示的就是它，不能拿来记别的）。 */
  lastConsolidatedAt: number | null;
  /** 整理失败后的退避截止时间：单独一个键，免得把"上次整理时间"改成没发生过的值。 */
  consolidateRetryAt: number | null;
};

export const FEATURE_DEFAULTS: CompanionFeatures = {
  memoryExtract: true,
  lifeline: false,
  recap: false,
  consolidate: false,
  reminders: false,
  imageGen: false,
  web: false,
  bond: false,
  splitReply: true,
  showThinking: true,
  showTools: true,
  turnPct: 0,
  tokenPct: 0,
  toolRounds: 0,
  dailyLimit: 0,
  temperature: -1,
  bannedWords: "",
  schedule: "",
  lastConsolidatedAt: null,
  consolidateRetryAt: null,
};

/** 关系温度计（阶段 / 亲密度 / 情绪三段）。空 stage = 还没建立。 */
export type BondState = {
  stage: string;
  warmth: number;
  mood: string;
  updated_at: number | null;
};

export const EMPTY_BOND: BondState = { stage: "", warmth: 50, mood: "", updated_at: null };

export function sanitizeFeatures(input: unknown): CompanionFeatures {
  const out: CompanionFeatures = { ...FEATURE_DEFAULTS };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  for (const key of ["memoryExtract", "lifeline", "recap", "consolidate", "reminders", "imageGen", "web", "bond", "splitReply", "showThinking", "showTools"] as const) {
    if (src[key] === true) out[key] = true;
    else if (src[key] === false) out[key] = false;
  }
  const limit = Number(src.dailyLimit);
  out.dailyLimit = Number.isInteger(limit) && limit >= 0 && limit <= 10 ? limit : 0;
  // 工具轮数：只有 1~8 算"这一位单独设过"，其余（含越界与没填）一律归 0 = 跟随全局。
  const rounds = Number(src.toolRounds);
  out.toolRounds = Number.isInteger(rounds) && rounds >= 1 && rounds <= 8 ? rounds : 0;
  // 温度：-1 = 跟随全局；0~2 收一位小数。脏值回 -1，不静默截断成别的取值。
  const temp = Number(src.temperature);
  out.temperature = Number.isFinite(temp) && temp >= 0 && temp <= 2 ? Math.round(temp * 10) / 10 : -1;
  out.bannedWords = typeof src.bannedWords === "string" ? src.bannedWords.trim().slice(0, 200) : "";
  // 两个百分比：0 = 不设这一维；越界一律回 0（不静默截断成别的值）
  for (const key of ["turnPct", "tokenPct"] as const) {
    const v = Number(src[key]);
    out[key] = Number.isInteger(v) && v >= 0 && v <= 100 ? v : 0;
  }
  out.schedule = typeof src.schedule === "string" ? src.schedule.trim().slice(0, 120) : "";
  const at = Number(src.lastConsolidatedAt);
  out.lastConsolidatedAt = Number.isFinite(at) && at > 0 ? Math.trunc(at) : null;
  const retry = Number(src.consolidateRetryAt);
  out.consolidateRetryAt = Number.isFinite(retry) && retry > 0 ? Math.trunc(retry) : null;
  return out;
}

export function sanitizeBond(input: unknown): BondState {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ...EMPTY_BOND };
  const src = input as Record<string, unknown>;
  const warmth = Number(src.warmth);
  return {
    stage: typeof src.stage === "string" ? src.stage.trim().slice(0, 24) : "",
    warmth: Number.isFinite(warmth) ? Math.min(100, Math.max(0, Math.round(warmth))) : 50,
    mood: typeof src.mood === "string" ? src.mood.trim().slice(0, 24) : "",
    updated_at: Number.isFinite(Number(src.updated_at)) && Number(src.updated_at) > 0 ? Math.trunc(Number(src.updated_at)) : null,
  };
}

/** 温度计的一行话（注入提示词与界面共用）。stage 空 = 还没建立，不注入。 */
export function formatBondLine(bond: BondState, pron = "她"): string {
  if (bond.stage === "") return "";
  const bits = [`阶段「${bond.stage}」`, `亲密度 ${bond.warmth}/100`];
  if (bond.mood !== "") bits.push(`${pron}此刻的情绪「${bond.mood}」`);
  return bits.join(" · ");
}

/**
 * 按功能开关取"陪伴增强"的提示词素材（agent / proactive 共用一份纪律：
 * 开关关 = 对应段落整个不出现，而不是出现空壳）。
 *
 * @param oldestKeptId 本轮真正带进上下文的最旧一条消息 id。
 *   梗概（recap）只该覆盖**已经滑出回放窗口**的那段对话；把回放轮数调大、
 *   或某轮因预算少丢了几轮之后，已折叠进梗概的消息会同时在以原文回放——
 *   那时再注入梗概，等于同一段话喂两遍（模型看到的是"她说过的往事 + 她的原话"）。
 *   省略该参数 = 调用方不掌握窗口边界，此时不做这项判断。
 */
export function companionPromptExtras(
  contact: Contact | null,
  oldestKeptId?: number,
): {
  schedule: string;
  lifeline: string;
  recap: string;
  bondLine: string;
} {
  if (!contact) return { schedule: "", lifeline: "", recap: "", bondLine: "" };
  const f = contact.features;
  // 只有"确实已经原文回放进来了"才收起梗概。recap_upto=0（用户手写、或还没折叠过任何一批）
  // 时 0 < 窗口边界 成立，照旧注入——手改的派生状态也是用户的，不能因为游标没动就当没写过。
  const recapStillOutside = oldestKeptId === undefined || contact.recap_upto < oldestKeptId;
  return {
    schedule: f.schedule,
    lifeline: f.lifeline ? contact.lifeline : "",
    recap: f.recap && recapStillOutside ? contact.recap : "",
    bondLine: f.bond ? formatBondLine(contact.bond, pronounOf(contact.gender)) : "",
  };
}

export type Contact = {
  id: string;
  type: "single" | "group";
  name: string;
  card: CharacterCard;
  /** 头像（dataURL）。空串 = 没设，界面用名字首字画一个。 */
  avatar: string;
  /**
   * 长相参考图（/media 路径，不是 dataURL——见 db.ts 那侧的说明）。
   * 她画自拍时把它作为 `image` 字段发给服务商做身份条件化；空串 = 没有，自拍画不了。
   */
  faceRef: string;
  /** 绑定的模型配置档 id；空串 = 跟随全局模型。 */
  model_profile: string;
  /** 回放最近 N 轮；0 = 跟随全局设置。 */
  recent_turns: number;
  /** 角色性别：female/male/other——界面与提示词的代词跟着它走。 */
  gender: ContactGender;
  features: CompanionFeatures;
  /** 生活线摘要正文 + 生成时间（consolidate 的产出，用户可手改）。 */
  lifeline: string;
  lifeline_at: number | null;
  /** 窗口边缘梗概：已折叠进梗概的最后一条消息 id 之前的对话摘要（系统维护，可手改）。 */
  recap: string;
  recap_upto: number;
  bond: BondState;
  created_at: number;
  archived_at: number | null;
};

const COLS = "id, type, name, card, avatar, face_ref, model_profile, recent_turns, gender, features, lifeline, lifeline_at, recap, recap_upto, bond, created_at, archived_at";

export type ContactGender = "female" | "male" | "other";

const GENDERS: readonly string[] = ["female", "male", "other"];

function normalizeGender(v: unknown): ContactGender {
  return GENDERS.includes(String(v)) ? (v as ContactGender) : "female";
}

/** 中文代词：提示词与界面共用一个真源，别各自写死「她」。 */
export function pronounOf(gender: ContactGender | string | undefined): string {
  return gender === "male" ? "他" : gender === "other" ? "TA" : "她";
}

/** 头像白名单：只收 dataURL 图片，≤150KB（客户端已压缩）。
 *  返回 undefined = 「不改这个字段」；空串 = 清除。 */
/**
 * 头像有两种合法形态，都收：
 * ① 前端 canvas 压过的内联 dataURL（≤150,000 字符）——用户在设置界面上手动传就走这条；
 * ② 已落盘的 `/media/...` 路径——画一张 1024×1536 当头像约 1.6MB 裸 base64，
 *   内联必超①的门，而零依赖后端又缩不动它（本机没有 sharp/jimp）。
 * 路径形态还顺带修掉一个更值钱的问题：头像是内联字节时，它跟着**每 10 秒一次的会话列表
 * 轮询整串重传**（`/api/contacts` 是 no-store），而 `/media` 发 `immutable`，浏览器取一次用一年。
 * 路径只收**文件真实存在**的那一种（mediaUrlExists 顺带挡掉穿越）：写错路径等于给用户一个碎图，
 * 宁可不改这个字段。
 */
export function sanitizeAvatar(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return "";
  if (typeof v !== "string") return undefined;
  if (mediaUrlExists(v)) return v;
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(v)) return undefined;
  return v.length <= 150_000 ? v : undefined;
}

/**
 * 长相参考图：只收**真实存在**的 /media 路径（形状与防穿越由 media.ts 那侧把关），
 * 空串 = 清除。返回 undefined = 「不改这个字段」，与 sanitizeAvatar 同语义。
 * 不收 dataURL：那等于允许调用方往库里塞任意大的东西（分页那轮刚把列表载荷压到 4KB）。
 */
export function sanitizeFaceRef(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return "";
  if (typeof v !== "string") return undefined;
  return mediaUrlExists(v) ? v : undefined;
}

function rowToContact(row: Record<string, unknown>): Contact {
  let card: Partial<CharacterCard> = {};
  try {
    card = JSON.parse(String(row.card ?? "{}")) as Partial<CharacterCard>;
  } catch {
    card = {};
  }
  const base = defaultPersona().character;
  return {
    id: String(row.id),
    type: (row.type as Contact["type"]) ?? "single",
    name: String(row.name ?? ""),
    card: sanitizeCharacter({ ...base, ...card, name: String(row.name ?? base.name) }),
    avatar: String(row.avatar ?? ""),
    faceRef: String(row.face_ref ?? ""),
    model_profile: String(row.model_profile ?? ""),
    // -1 = 全部，必须原样读回来；从前这里无脑 max(0,…) 会把「全部」静默抹成"跟随全局"，
    // 于是存进去是对的、每次读出来都变 0，界面上看像是设置没生效。
    recent_turns: Number(row.recent_turns ?? 0) === ALL_TURNS ? ALL_TURNS
      : Math.min(MAX_TURNS, Math.max(0, Number(row.recent_turns ?? 0) || 0)),
    gender: normalizeGender(row.gender),
    features: parseJsonColumn(row.features, sanitizeFeatures),
    lifeline: String(row.lifeline ?? "").slice(0, 800),
    lifeline_at: row.lifeline_at === null || row.lifeline_at === undefined ? null : Number(row.lifeline_at),
    recap: String(row.recap ?? "").slice(0, 400),
    recap_upto: Number(row.recap_upto ?? 0) || 0,
    bond: parseJsonColumn(row.bond, sanitizeBond),
    created_at: Number(row.created_at ?? 0),
    archived_at: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
  };
}

/** JSON 列的容错解析：空串/坏 JSON 一律回落该字段的默认值（净化函数兜形状）。 */
function parseJsonColumn<T>(raw: unknown, sanitize: (input: unknown) => T): T {
  const text = String(raw ?? "");
  if (text === "") return sanitize(null);
  try {
    return sanitize(JSON.parse(text) as unknown);
  } catch {
    return sanitize(null);
  }
}

/** 首次启动迁移：无联系人时，把 kv 里的全局角色卡变成 "default" 联系人，旧数据全部归属它。 */
export function ensureDefaultContact(): void {
  const count = (db.prepare("SELECT COUNT(*) AS c FROM contacts").get() as { c: number }).c;
  if (count > 0) return;

  const card = defaultPersona().character;
  const stored = db.prepare("SELECT v FROM kv WHERE k = 'settings.persona'").get() as { v: string } | undefined;
  if (stored) {
    try {
      const parsed = JSON.parse(stored.v) as { character?: Partial<CharacterCard> };
      Object.assign(card, parsed.character ?? {});
    } catch {
      // kv 内容损坏就退回默认角色卡
    }
  }
  db.prepare(
    `INSERT INTO contacts (id, type, name, card, created_at) VALUES (?, 'single', ?, ?, ?)`,
  ).run(DEFAULT_CONTACT_ID, card.name, JSON.stringify(card), Date.now());

  // 旧数据归属：所有空的联系人维度都归 default
  for (const table of ["messages", "turns", "memory_events", "proactive_tasks"]) {
    db.prepare(`UPDATE ${table} SET contact_id = ? WHERE contact_id IS NULL`).run(DEFAULT_CONTACT_ID);
  }
  console.log("[contacts] 已把既有数据迁移到默认联系人");
}

export function listContacts(options: { includeArchived?: boolean } = {}): Contact[] {
  const rows = options.includeArchived
    ? db.prepare(`SELECT ${COLS} FROM contacts ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>
    : db.prepare(`SELECT ${COLS} FROM contacts WHERE archived_at IS NULL ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>;
  return rows.map(rowToContact);
}

export function getContact(id: string): Contact | null {
  const row = db.prepare(`SELECT ${COLS} FROM contacts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToContact(row) : null;
}

export function createContact(input: {
  /** 缺省随机 uuid；内置保留联系人（如设置助手）需要固定 id。 */
  id?: string;
  name: string;
  card?: Partial<CharacterCard>;
  type?: "single" | "group";
  avatar?: string;
  /** 长相参考图（/media 路径）。 */
  faceRef?: string;
  gender?: ContactGender;
}): Contact {
  const base = defaultPersona().character;
  const card = sanitizeCharacter({ ...base, ...(input.card ?? {}), name: input.name });
  const id = input.id && input.id !== "" ? input.id : randomUUID();
  db.prepare(
    `INSERT INTO contacts (id, type, name, card, avatar, face_ref, gender, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.type ?? "single", input.name, JSON.stringify(card), input.avatar ?? "", input.faceRef ?? "", normalizeGender(input.gender), Date.now());
  return getContact(id)!;
}

export function updateContact(
  id: string,
  patch: {
    name?: string;
    card?: Partial<CharacterCard>;
    avatar?: string;
    /** 长相参考图（/media 路径）；空串 = 清除并释放旧文件。 */
    faceRef?: string;
    modelProfile?: string;
    /** 回放轮数覆盖；0 = 清除覆盖跟随全局。 */
    recentTurns?: number;
    gender?: ContactGender;
    /** 局部覆盖：只改传进来的开关，其余保持原样。 */
    features?: Partial<CompanionFeatures>;
    lifeline?: string;
    /** 窗口边缘梗概正文。用户手改不动游标 recap_upto——下一批照样并进这段新文字。 */
    recap?: string;
    bond?: Partial<BondState>;
  },
): Contact | null {
  const existing = getContact(id);
  if (!existing) return null;
  const name = patch.name?.trim() || existing.name;
  const card = patch.card ? sanitizeCharacter({ ...existing.card, ...patch.card, name }) : existing.card;
  const avatar = patch.avatar !== undefined ? patch.avatar : existing.avatar;
  const faceRef = patch.faceRef !== undefined ? patch.faceRef : existing.faceRef;
  // 参考图与头像换掉/清掉后要回收旧文件，但**回收必须排在 UPDATE 之后**（见本函数末尾）：
  // 判断"还有没有人引用"靠查库，而此刻这一行里写的还是旧值——先删就等于让它数到自己，
  // 结果是谁都删不掉。回收整个交给 releaseMediaFiles 的引用计数（它认消息、处理单、
  // 头像、参考图与画台账五处），调用点不再各自补 `!isArtifactUrl(...)` 那种一次性判断。
  const modelProfile = patch.modelProfile !== undefined ? patch.modelProfile.trim() : existing.model_profile;
  const recentTurns = patch.recentTurns !== undefined
    // -1 = 全部（回放整段历史，重量交给 token 预算兜底）；0 = 跟随全局；其余钳到 1~MAX_TURNS。
    ? (Math.trunc(Number(patch.recentTurns) || 0) === ALL_TURNS ? ALL_TURNS
      : Math.min(MAX_TURNS, Math.max(0, Math.trunc(Number(patch.recentTurns) || 0))))
    : existing.recent_turns;
  const gender = patch.gender !== undefined ? normalizeGender(patch.gender) : existing.gender;
  const features = patch.features !== undefined
    ? sanitizeFeatures({ ...existing.features, ...patch.features })
    : existing.features;
  const lifeline = patch.lifeline !== undefined ? patch.lifeline.trim().slice(0, 800) : existing.lifeline;
  const recap = patch.recap !== undefined ? patch.recap.trim().slice(0, 200) : existing.recap;
  const bond = patch.bond !== undefined
    ? sanitizeBond({ ...existing.bond, ...patch.bond, updated_at: Date.now() })
    : existing.bond;
  db.prepare(
    `UPDATE contacts SET name = ?, card = ?, avatar = ?, face_ref = ?, model_profile = ?, recent_turns = ?, gender = ?, features = ?, lifeline = ?, recap = ?, bond = ? WHERE id = ?`,
  ).run(
    name,
    JSON.stringify(card),
    avatar,
    faceRef,
    modelProfile,
    recentTurns,
    gender,
    JSON.stringify(features),
    lifeline,
    recap,
    bond.stage === "" && bond.mood === "" && bond.warmth === 50 && bond.updated_at === null ? "" : JSON.stringify(bond),
    id,
  );
  // 回收排在写入之后（原因见上面那段注释）：这一行已经不指着旧文件了，引用数才算得准。
  // 头像那一路不用区分内联还是路径——内联 dataURL 会被 mediaFileName 判成形状不合直接跳过。
  const stale: string[] = [];
  if (patch.faceRef !== undefined && existing.faceRef !== "" && existing.faceRef !== faceRef) stale.push(existing.faceRef);
  if (patch.avatar !== undefined && existing.avatar !== "" && existing.avatar !== avatar) stale.push(existing.avatar);
  if (stale.length > 0) releaseMediaFiles(stale);
  return getContact(id);
}

/** 梗概层专用：写梗概正文 + "已经折叠到第几条消息"。一次落齐，避免半更新。 */
export function applyRecap(contactId: string, recap: string, uptoMessageId: number): void {
  db.prepare(`UPDATE contacts SET recap = ?, recap_upto = ? WHERE id = ?`)
    .run(recap.trim().slice(0, 400), uptoMessageId, contactId);
}

/** 整理任务专用：写生活线 + 温度计 + 整理时间戳（绕过 patch 语义，一次落齐）。 */
export function applyConsolidation(
  contactId: string,
  output: { lifeline?: string; bond?: Partial<BondState> | null; consolidatedAt: number },
): void {
  const existing = getContact(contactId);
  if (!existing) return;
  const sets: string[] = [];
  const args: Array<string | number> = [];
  if (output.lifeline !== undefined && existing.features.lifeline) {
    sets.push("lifeline = ?", "lifeline_at = ?");
    args.push(output.lifeline.slice(0, 800), output.consolidatedAt);
  }
  if (output.bond && existing.features.bond) {
    sets.push("bond = ?");
    args.push(JSON.stringify(sanitizeBond({ ...existing.bond, ...output.bond, updated_at: output.consolidatedAt })));
  }
  if (sets.length === 0 && output.consolidatedAt <= 0) return;
  const features = sanitizeFeatures({ ...existing.features, lastConsolidatedAt: output.consolidatedAt, consolidateRetryAt: null });
  db.prepare(`UPDATE contacts SET features = ? WHERE id = ?`).run(JSON.stringify(features), contactId);
  if (sets.length > 0) {
    db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...args, contactId);
  }
}

/** 归档：从列表消失但数据保留。归档本身不删任何东西——彻底删除是归档之后的另一个显式动作。 */
export function archiveContact(id: string): boolean {
  const existing = getContact(id);
  // 只有内置「设置助手」删不掉（它是界面的一部分）；小茉这位默认联系人可以删，
  // 想回到出厂那份用「恢复默认人设」或「恢复出厂设置」。
  if (!existing || existing.id === ASSISTANT_CONTACT_ID) return false;
  db.prepare(`UPDATE contacts SET archived_at = ? WHERE id = ?`).run(Date.now(), id);
  return true;
}

/** 恢复归档：回到列表，对话与记忆原样。 */
export function unarchiveContact(id: string): boolean {
  const existing = getContact(id);
  if (!existing) return false;
  db.prepare(`UPDATE contacts SET archived_at = NULL WHERE id = ?`).run(id);
  return true;
}

/**
 * 彻底删除一个**已归档**的联系人：对话、记忆、任务、用量、图片一并清除，不可恢复。
 *
 * 归档是冷却期：没归档的联系人删不了——「手滑一下人就没了」必须被挡住，
 * 想删先得先归档（人会从列表消失一次，给你一次反悔的机会）。内置「设置助手」永远删不了；
 * 默认联系人小茉可以删（要回到初始状态走「恢复出厂设置」）。
 * 助手的派生工作区（assistant:<id>）不是联系人记录，但它的消息/处理单要一起清，
 * 否则删完会留下一撮没人认领的孤儿行。
 */
export function deleteContact(id: string): { removedMedia: number } {
  if (id === ASSISTANT_CONTACT_ID) throw new Error("内置助手不能删除");
  const row = db.prepare(`SELECT archived_at FROM contacts WHERE id = ?`).get(id) as { archived_at: number | null } | undefined;
  if (!row) throw new Error("联系人不存在");
  if (row.archived_at === null) throw new Error("先归档、再删除：归档是冷却期，防手滑");

  const urls: string[] = [];
  // 这位联系人自己的头像与长相参考图也要进回收清单：它们不在 messages/turns/artifacts 里，
  // 漏掉的话人删了文件还留在 media/ 目录，只有 24 小时后的孤儿清扫兜底（而且 removedMedia 少报两个）。
  // 必须在 DELETE 之前取——行没了就再也查不到这两个字段了。
  const own = db.prepare(`SELECT avatar, face_ref FROM contacts WHERE id = ?`).get(id) as { avatar: string; face_ref: string } | undefined;
  for (const value of [own?.avatar ?? "", own?.face_ref ?? ""]) {
    if (/^\/media\//.test(value)) urls.push(value);
  }
  for (const table of ["messages", "turns"] as const) {
    const rows = db.prepare(`SELECT attachments FROM ${table} WHERE contact_id = ? AND attachments IS NOT NULL`).all(id) as Array<{ attachments: string }>;
    for (const r of rows) {
      for (const m of r.attachments.matchAll(/\/media\/([a-z0-9]{16}\.(?:png|jpg|webp|gif))/g)) urls.push("/media/" + m[1]);
    }
  }
  withTx(() => {
    db.prepare(`DELETE FROM messages WHERE contact_id = ?`).run(id);
    db.prepare(`DELETE FROM turns WHERE contact_id = ?`).run(id);
    db.prepare(`DELETE FROM memory_events WHERE contact_id = ?`).run(id);
    db.prepare(`DELETE FROM proactive_tasks WHERE contact_id = ?`).run(id);
    db.prepare(`DELETE FROM model_calls WHERE contact_id = ?`).run(id);
    // 画作台账跟着人走：不删的话，人没了「她的画」那一页还在，格子里的图也再没人引用，
    // 下一轮孤儿清扫会把文件收掉——留着一排点开就 404 的缩略图。
    for (const r of db.prepare(`SELECT url FROM artifacts WHERE contact_id = ?`).all(id) as Array<{ url: string }>) {
      if (/^\/media\//.test(r.url)) urls.push(r.url);
    }
    db.prepare(`DELETE FROM artifacts WHERE contact_id = ?`).run(id);
    db.prepare(`DELETE FROM contacts WHERE id = ?`).run(id);
  });
  // 事务提交后再回收图片：别的联系人若引用同一张图，releaseMediaFiles 的引用检查会留住它。
  releaseMediaFiles(urls);
  return { removedMedia: urls.length };
}

/**
 * 把这个联系人的人格三段换回出厂那份。名字、头像、性别、能力开关都不动——
 * 那个按钮说的是「人设」，不该顺手把别的设置一起改了。
 * 与资料页的「按模板填写」也不是一回事：那是给人照着改的示例，这里是内置默认那份。
 */
export function restoreDefaultCard(id: string): Contact | null {
  if (!getContact(id)) return null;
  const base = defaultPersona().character;
  return updateContact(id, {
    card: { identity: base.identity, background: base.background, relationship: base.relationship },
  });
}

/**
 * 恢复出厂设置：清掉**全部**运行数据与设置，然后由调用方重新种子内置联系人。
 *
 * 范围按表来清而不是按 kv 键列举：模型档与供应商名、能力覆盖、人设、首启标记、已读记账、
 * 微信绑定、助手会话、主动配额……全都在 kv 里，逐键列举迟早漏一个，漏了就不能叫「初始状态」。
 * 图片文件一并回收——库空了它们就是孤儿，留着只占盘。
 * 返回清掉了几个人、回收了几个文件（界面要报数，别只说「好了」）。
 */
export function factoryReset(): { contacts: number; mediaRemoved: number } {
  const people = (db.prepare("SELECT COUNT(*) AS c FROM contacts").get() as { c: number }).c;
  const urls = new Set<string>();
  for (const table of ["messages", "turns"] as const) {
    const rows = db.prepare(`SELECT attachments FROM ${table} WHERE attachments IS NOT NULL`)
      .all() as Array<{ attachments: string }>;
    for (const r of rows) {
      for (const m of r.attachments.matchAll(/\/media\/([a-z0-9]{16}\.(?:png|jpg|webp|gif))/g)) urls.add("/media/" + m[1]);
    }
  }
  for (const r of db.prepare(`SELECT url FROM artifacts`).all() as Array<{ url: string }>) {
    if (/^\/media\//.test(r.url)) urls.add(r.url);
  }
  for (const c of listContacts()) if (c.faceRef !== "") urls.add(c.faceRef);
  // 目录里剩下的（没有任何行引用它们的）也一并收：清库之后它们同样是孤儿。
  for (const u of listMediaUrls()) urls.add(u);

  withTx(() => {
    for (const table of ["messages", "turns", "memory_events", "proactive_tasks", "model_calls", "artifacts", "contacts"]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare(`DELETE FROM kv WHERE k <> 'schema_version'`).run();
  });
  // 文件在事务外回收：清库万一回滚，引用还在，文件不该先没。
  releaseMediaFiles([...urls]);
  return { contacts: people, mediaRemoved: urls.size };
}

/** 这个联系人绑定的模型档 id（空串 = 跟随全局）。运行时解析用，不存在的联系人也返回空。 */
export function contactModelProfile(contactId: string): string {
  // 助手的派生工作区（assistant:<id>）没有自己的联系人记录，绑定跟随基础助手会话——
  // 助手的可用性由「钉在生效档」那条规则统一保证，工作区不例外。
  const base = contactId.startsWith(ASSISTANT_CONTACT_ID + ":") ? ASSISTANT_CONTACT_ID : contactId;
  const row = db.prepare("SELECT model_profile FROM contacts WHERE id = ?").get(base) as
    | { model_profile: string | null }
    | undefined;
  return String(row?.model_profile ?? "");
}

/** 每个联系人的最后一条消息（中栏会话列表的预览行）。 */
export function lastMessagePreview(contactId: string): { text: string; at: number; role: string } | null {
  const row = db
    .prepare(
      `SELECT text, created_at, role FROM messages
       WHERE contact_id = ? AND superseded_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(contactId) as { text: string; created_at: number; role: string } | undefined;
  return row ? { text: row.text, at: row.created_at, role: row.role } : null;
}

// ── 未读红点：每联系人「最后已读消息 id」（kv 存储，跨设备共用一份）────
const KV_READS = "chat.reads";

function readMap(): Record<string, number> {
  try {
    const raw: unknown = kvGet(KV_READS) ? JSON.parse(String(kvGet(KV_READS))) : {};
    const out: Record<string, number> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out[k] = n;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 记账「读到哪了」；只前进不后退。 */
export function markContactRead(contactId: string, messageId: number): void {
  const id = Number(messageId);
  if (!Number.isFinite(id) || id <= 0) return;
  const map = readMap();
  if ((map[contactId] ?? 0) >= id) return;
  map[contactId] = id;
  kvSet(KV_READS, JSON.stringify(map));
}

/** 未读数 = 该联系人还没被读过的助手消息条数。 */
export function unreadCount(contactId: string): number {
  let last = readMap()[contactId];
  if (last === undefined) {
    // 没有已读记录时从「自己最后一句话」起算：刚说完话得到的回应算没看过；
    // 老用户升级后不必为陈年记录满屏红点（旧历史里最后一条用户消息之前的全算读过）。
    const row = db
      .prepare(`SELECT MAX(id) AS m FROM messages WHERE contact_id = ? AND role = 'user'`)
      .get(contactId) as { m: number | null } | undefined;
    last = row?.m ?? 0;
  }
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE contact_id = ? AND role = 'assistant' AND superseded_at IS NULL AND id > ?`,
    )
    .get(contactId, last) as { n: number };
  return n.n;
}

/** 联系人的人格卡（找不到该联系人时回落默认角色卡，保证对话不中断）。 */
export function contactCard(id: string): CharacterCard {
  return getContact(id)?.card ?? defaultPersona().character;
}

/**
 * 默认联系人的人设还是不是出厂那份（首启引导据此决定要不要问「改改人设」这一步）。
 * 判的是 contacts.card —— 聊天真正吃的那份，不是 settings.persona.character（那只是种子与老库迁移的来源）。
 * 联系人不存在时 contactCard 回落默认卡，同样算"没动过"：删掉小茉之后这一步会重新问。
 */
export function defaultPersonaIsDefault(): boolean {
  const base = defaultPersona().character;
  const card = contactCard(DEFAULT_CONTACT_ID);
  return (["name", "identity", "background", "relationship"] as const).every((k) => card[k] === base[k]);
}

export function contactExists(id: string): boolean {
  return getContact(id) !== null;
}
