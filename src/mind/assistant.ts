// 内置「设置助手」：一个保留联系人 + 一组白名单配置工具。
//
// 设计（借鉴参考产品的内置软件助手，按其思路做了适合单机应用的裁剪）：
// - 固定会话：id="assistant" 的保留联系人，不走陪伴人设、不抽记忆、不主动发言；
// - 每轮注入实时产品状态（密钥永不出快照），助手基于真实配置回答而不是猜；
// - 所有写操作走登记白名单工具：只有工具明确返回成功才允许宣称完成；
// - 目标有歧义（同名联系人/档）时工具返回候选清单，让助手先跟用户确认。

import {
  activateProfile, activateCapabilityProfile, activeProfileId, capabilityActiveId, capabilityReady,
  CAPABILITY_LABELS, CAPABILITY_NAMES, EMOTE_FREQUENCIES, globalEmoteFrequency, globalToolLoopTurns,
  listProfiles, mainLinked, modelConfig, onboardingDone, saveCapabilityProfile, saveProfile, setGlobalEmoteFrequency,
  setGlobalToolLoopTurns, settingsSnapshot, TOOL_LOOP_TURN_LIMITS, validateCapabilityProfile,
} from "../settings/settings.ts";
import { ASSISTANT_CONTACT_ID, createContact, getContact, listContacts, updateContact, type Contact } from "../chat/contacts.ts";
import { skillCatalogSection, skillsStatus } from "./skills.ts";
import {
  importManifest as importExtensionManifest,
  probeExtension,
  removeExtension,
  saveTool as saveExtensionTool,
  deleteTool as deleteExtensionToolByName,
  setEnabled as setExtensionEnabled,
  setScriptGate,
  snapshot as extensionSnapshot,
} from "./extensions.ts";
import { downloadImageToMedia, describeWebFailure } from "./search.ts";
import { generateImage } from "../settings/model.ts";
import { mediaUrlExists, releaseMediaFiles } from "../media/media.ts";
import { assetStats, listEmotePacks } from "../media/assets.ts";
import { assistantStatusExtensions } from "../core/assistant-context.ts";
import { db, kvGet, kvSet, withTx } from "../core/db.ts";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "./tools.ts";

export { ASSISTANT_CONTACT_ID };
export const ASSISTANT_CONTACT_NAME = "设置助手";

// ── 助手权限档位：约束联系人能自己动多少配置 ──────────────────────────
// 三档的语义是硬的，不是提示词里的客套话：
//   readonly — 全部写工具从声明里摘掉，物理断手；
//   confirm  — 可逆写直接放行，不可逆动作必须等用户在界面上真实点击（确认卡片）；
//   auto     — 全部放行（工具参数里的 confirmed 即代表用户先前已同意）。
export type AssistantPermission = "readonly" | "confirm" | "auto";

const KV_PERMISSION = "assistant.permission";

export function assistantPermission(): AssistantPermission {
  const raw = kvGet(KV_PERMISSION);
  return raw === "readonly" || raw === "auto" ? raw : "confirm";
}

export function setAssistantPermission(value: unknown): AssistantPermission {
  if (value !== "readonly" && value !== "confirm" && value !== "auto") throw new Error("未知权限档位（readonly / confirm / auto）");
  const prev = assistantPermission();
  kvSet(KV_PERMISSION, value);
  if (prev !== value) {
    recordActivity({ ts: Date.now(), tool: "permission", title: `权限档切到「${TIER_LABEL[value]}」`, ok: true, tier: value });
  }
  return value;
}

/** 写配置的工具名单：readonly 档按它整组摘除。读工具（app_status 等）永远在。 */
export const ASSISTANT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "configure_model", "configure_capability", "set_preference", "activate_model",
  "create_contact", "update_contact", "set_contact_avatar", "bind_contact_model",
  "manage_extensions", "import_extension", "edit_extension_tool", "set_script_gate",
]);

const TIER_LABEL: Record<AssistantPermission, string> = {
  readonly: "只读",
  confirm: "变更前确认",
  auto: "完全自主",
};

// ── 活动记录：助手改过什么，一处可查 ─────────────────────────────────
// 「完全自主」档没有任何确认卡片可看，控制台的「最近的配置变更」是唯一的事后可见性。
// 信任但不看见，等于把「确认疲劳 → 升到 auto」这条滑坡的终点变得更危险。
// 只记真正改变配置的事（写工具执行、确认卡决定、权限切换）；读状态不构成变更，记了只是噪音。

const KV_ACTIVITY = "assistant.activity";
const ACTIVITY_MAX = 100;

export type AssistantActivity = {
  /** 发生时间（epoch ms）。 */
  ts: number;
  /** 哪个写工具；"permission" 表示权限档切换。 */
  tool: string;
  /** 一句话人话：做了什么。 */
  title: string;
  /** 写工具以 ok:true 为成功；被拒绝的确认卡也按 ok 记（决定本身被正常处理）。 */
  ok: boolean;
  /** 补充说明：成功时是工具的 note，失败时是 error（截断）。 */
  detail?: string;
  /** 发起它的助手线程（assistant 或 assistant:<id>）。 */
  contactId?: string;
  /** 执行时的权限档。 */
  tier: AssistantPermission;
  /** 这笔写是经用户点确认卡放行的。 */
  confirmed?: boolean;
};

function readActivity(): AssistantActivity[] {
  try {
    const raw = kvGet(KV_ACTIVITY);
    const arr = raw ? (JSON.parse(raw) as AssistantActivity[]) : [];
    return Array.isArray(arr) ? arr as AssistantActivity[] : [];
  } catch { return []; }
}

function writeActivity(list: AssistantActivity[]): void {
  kvSet(KV_ACTIVITY, JSON.stringify(list.slice(0, ACTIVITY_MAX)));
}

function recordActivity(entry: AssistantActivity): void {
  // 记录失败绝不影响主流程：活动是给人看的审计面，不是执行链路的依赖。
  try {
    writeActivity([entry, ...readActivity()]);
  } catch { /* 忽略 */ }
}

/** 控制台「最近的配置变更」的数据源：最新在前，上限 ACTIVITY_MAX 条。 */
export function assistantActivity(): AssistantActivity[] {
  return readActivity();
}

// ── 待确认动作：危险操作的用户点击凭证 ────────────────────────────
// confirm 档下，不可逆动作不直接执行，而是登记一张「确认卡片」等用户点。
// 模型拿到的只有 actionId；凭证的消费只发生在 confirm 路由把 actionId 注回工具参数时——
// 模型自己传 confirmed:true 在这一档不再有效，这就是「不靠模型自觉」的那道闸。

const KV_PENDING = "assistant.pendingActions";
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_PER_THREAD = 3;

export type PendingAction = {
  id: string;
  /** 哪个工具的哪次调用；confirm 路由按它重新分发执行。 */
  tool: string;
  args: Record<string, unknown>;
  /** 卡片上一句话标题与给用户看的详情（人话，不是给模型的）。 */
  title: string;
  detail: string;
  /** 发起它的助手线程（"assistant" 或 "assistant:<id>"），确认后续跑也回到这个线程。 */
  contactId: string;
  createdAt: number;
};

function readPending(): PendingAction[] {
  try {
    const raw = kvGet(KV_PENDING);
    const arr = raw ? (JSON.parse(raw) as PendingAction[]) : [];
    if (!Array.isArray(arr)) return [];
    const cutoff = Date.now() - PENDING_TTL_MS;
    return arr.filter((a) => typeof a?.id === "string" && a.createdAt > cutoff);
  } catch {
    return [];
  }
}

function writePending(list: PendingAction[]): void {
  kvSet(KV_PENDING, JSON.stringify(list));
}

/** 某个助手线程当前挂着的确认卡片（已过期的不出现；读时顺手清账）。 */
export function pendingActionsFor(contactId: string): PendingAction[] {
  const fresh = readPending().filter((a) => a.contactId === contactId);
  const kept = readPending().filter((a) => a.createdAt > Date.now() - PENDING_TTL_MS);
  if (kept.length !== readPending().length) writePending(kept);
  return fresh;
}

function removePending(id: string): PendingAction | null {
  const list = readPending();
  const hit = list.find((a) => a.id === id) ?? null;
  if (hit) writePending(list.filter((a) => a.id !== id));
  return hit;
}

/**
 * 危险动作守卫。confirm 档且没有凭证时登记卡片并返回 needsConfirmation——
 * 返回 ok:false 是刻意的：这轮工具调用视为未完成，模型应该停下来告知用户，
 * 而不是继续往下编排已经没依据的步骤。
 */
function guardDangerous(
  tool: string, args: Record<string, unknown>, context: { contactId: string; assistantPermission?: AssistantPermission },
  title: string, detail: string, run: () => unknown,
): unknown {
  // 这一轮启动时的权限快照优先：用户切档后不该让在飞的一轮半路改规则。
  const tier = context.assistantPermission ?? assistantPermission();
  if (tier === "auto") return run();
  if (tier === "readonly") {
    return { ok: false, error: "当前助手权限档位为只读，不能改配置。用户可以在设置助手的输入区下方切换权限。" };
  }
  const token = typeof args.__confirmActionId === "string" ? args.__confirmActionId : "";
  if (token !== "") {
    const action = removePending(token);
    if (action && action.tool === tool) return run();
    return { ok: false, error: "确认凭证无效或已过期，请重新发起，让用户再点一次。" };
  }
  const list = readPending();
  const mine = list.filter((a) => a.contactId === context.contactId);
  if (mine.length >= MAX_PENDING_PER_THREAD) {
    return { ok: false, error: `已挂起 ${mine.length} 个待确认操作，请先等用户处理现有卡片。` };
  }
  const action: PendingAction = {
    id: randomUUID(), tool, args, title, detail, contactId: context.contactId, createdAt: Date.now(),
  };
  writePending([...list, action]);
  return {
    ok: false,
    needsConfirmation: { actionId: action.id, title, detail },
    note: "已向用户发出确认卡片。停下来告知用户请在卡片上点同意或拒绝；不要重复发起同一操作，也不要用文字追问来代替确认。",
  };
}

/**
 * confirm 路由的执行入口：approved 时把 actionId 注回工具参数重新走一遍原工具——
 * 守卫消费凭证后放行，等于「用户真实点击」这一证据只有这条路径能注入。
 * 拒绝只摘卡片不执行；续跑由调用方（server）用合成用户消息触发。
 */
export async function resolvePendingAction(id: string, approved: boolean): Promise<{ executed: boolean; contactId: string; title: string; result?: unknown }> {
  // 只窥视不删除：同意路径的凭证消费统一由 guardDangerous 在工具执行时完成，
  // 这里先删会造成「凭证已被消费」的假失败。拒绝路径才由这里直接摘卡。
  const action = readPending().find((a) => a.id === id) ?? null;
  if (!action) throw new Error("没有这个待确认操作（可能已过期或已处理）");
  if (!approved) {
    removePending(id);
    recordActivity({
      ts: Date.now(),
      tool: action.tool,
      title: `用户拒绝了「${action.title}」`,
      ok: true,
      detail: "该操作没有执行",
      contactId: action.contactId,
      tier: assistantPermission(),
    });
    return { executed: false, contactId: action.contactId, title: action.title };
  }
  const toolDef = ASSISTANT_TOOLS.find((t) => t.name === action.tool);
  if (!toolDef) {
    removePending(id);
    throw new Error(`找不到动作对应的工具「${action.tool}」`);
  }
  const result = await toolDef.execute({ ...action.args, __confirmActionId: id }, { lastUserAt: null, contactId: action.contactId, turnId: null });
  return { executed: true, contactId: action.contactId, title: action.title, result };
}

// ── 工作区：助手的多个互相隔离的会话 ──────────────────────────────
// 派生会话的 contact_id = "assistant:<线程 id>"，直接复用现成的「按 contact_id
// 隔离」机制——消息表、上下文组装、轮询拉取零改动即天然互不串台。
// 裸 "assistant" 是内置的「通用」工作区（历史消息都在那里）。

export const ASSISTANT_THREAD_PREFIX = ASSISTANT_CONTACT_ID + ":";
const KV_THREADS = "assistant.threads";
const DEFAULT_THREAD_TITLE = "新工作区";

export type AssistantThread = { id: string; title: string; created_at: number };

function readThreads(): AssistantThread[] {
  try {
    const raw = kvGet(KV_THREADS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr as AssistantThread[] : [];
  } catch { return []; }
}

function writeThreads(list: AssistantThread[]): void {
  kvSet(KV_THREADS, JSON.stringify(list));
}

/** 工作区 id → contact_id：内置「通用」就是裸 assistant，其余派生 assistant:<id>。 */
export function assistantThreadContactId(id: string): string {
  return id === "" ? ASSISTANT_CONTACT_ID : ASSISTANT_THREAD_PREFIX + id;
}

/** 一个工作区里现有多少条消息、其中几张图（清空前的确认弹窗要按真实数量说话）。 */
export type AssistantThreadStats = { messages: number; images: number };

/**
 * 一次扫出所有助手工作区的条数。列表接口要用，所以在**一次查询**里按 contact_id 分组，
 * 而不是每个工作区各查一次——工作区数量是用户手建的，几个到十几个，一次扫得起。
 */
function assistantThreadStats(): Map<string, AssistantThreadStats> {
  const rows = db
    .prepare(`SELECT contact_id, attachments FROM messages WHERE contact_id = ? OR contact_id LIKE ?`)
    .all(ASSISTANT_CONTACT_ID, ASSISTANT_THREAD_PREFIX + "%") as Array<{ contact_id: string; attachments: string | null }>;
  const out = new Map<string, AssistantThreadStats>();
  for (const row of rows) {
    const cur = out.get(row.contact_id) ?? { messages: 0, images: 0 };
    cur.messages += 1;
    cur.images += parseMediaUrls(row.attachments).length;
    out.set(row.contact_id, cur);
  }
  return out;
}

/** 列表 = 内置「通用」打头 + 用户新建的工作区（按创建先后），每行带上自己的条数。 */
export function listAssistantThreads(): Array<AssistantThread & { builtin: boolean } & AssistantThreadStats> {
  const stats = assistantThreadStats();
  const withStats = (t: AssistantThread, builtin: boolean) => ({
    ...t,
    builtin,
    ...(stats.get(assistantThreadContactId(t.id)) ?? { messages: 0, images: 0 }),
  });
  return [
    withStats({ id: "", title: "通用", created_at: 0 }, true),
    ...readThreads().map((t) => withStats(t, false)),
  ];
}

/** 消息行 attachments 列里那串 JSON → 本地 /media 路径列表；脏数据按无附件处理。 */
function parseMediaUrls(raw: string | null): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u): u is string => typeof u === "string" && u.startsWith("/media/"));
  } catch { return []; }
}

/**
 * 清空一个会话的全部消息与处理单，返回清掉了多少。
 *
 * 清完必须回收图片：搜图候选挂在工具卡的 attachments 上（见 agent.ts 的 toolAttachments），
 * 消息行还在时 sweepOrphanMedia 永远认它「有人引用」、永远不删——于是「搜了几批头像」
 * 就是几十张图永久留在 data/media 里。删完再 release，与 deleteMessage 同一口径：
 * **事务提交之后**才回收，回滚时图不会跟着丢。
 */
function clearAssistantContactMessages(contactId: string): { messages: number; turns: number; media: number } {
  const rows = db.prepare(`SELECT attachments FROM messages WHERE contact_id = ?`).all(contactId) as Array<{ attachments: string | null }>;
  const urls = rows.flatMap((r) => parseMediaUrls(r.attachments));
  const out = withTx(() => {
    const messages = db.prepare(`DELETE FROM messages WHERE contact_id = ?`).run(contactId).changes;
    const turns = db.prepare(`DELETE FROM turns WHERE contact_id = ?`).run(contactId).changes;
    return { messages: Number(messages), turns: Number(turns) };
  });
  releaseMediaFiles(urls);
  return { ...out, media: urls.length };
}

export function assistantThreadExists(id: string): boolean {
  return readThreads().some((t) => t.id === id);
}

/** contact_id 是否是合法的助手工作区会话（派生 id + 线程仍在注册表里）。 */
export function isAssistantThreadContactId(contactId: string): boolean {
  if (!contactId.startsWith(ASSISTANT_THREAD_PREFIX)) return false;
  return assistantThreadExists(contactId.slice(ASSISTANT_THREAD_PREFIX.length));
}

export function createAssistantThread(title: string): AssistantThread {
  const t: AssistantThread = {
    id: randomUUID().slice(0, 8),
    title: title.trim() === "" ? DEFAULT_THREAD_TITLE : title.trim().slice(0, 24),
    created_at: Date.now(),
  };
  writeThreads([...readThreads(), t]);
  return t;
}

export function renameAssistantThread(id: string, title: string): boolean {
  const clean = title.trim().slice(0, 24);
  if (clean === "") return false;
  const list = readThreads();
  const t = list.find((x) => x.id === id);
  if (!t) return false;
  t.title = clean;
  writeThreads(list);
  return true;
}

/**
 * 清空一个工作区里的消息，**工作区本身留着**（名字、它在列表里的位置都不动）。
 * 「通用」也允许——它是唯一一个删不掉的工作区（见 deleteAssistantThread），
 * 没有这条路它就只能单向增长：随手问的每一句都堆在里面，搜图落的文件也跟着永久留在盘上。
 * 返回 null 表示工作区不存在（「通用」永远存在）。
 */
export function clearAssistantThread(id: string): ({ messages: number; turns: number; media: number } | null) {
  if (id !== "" && !assistantThreadExists(id)) return null;
  return clearAssistantContactMessages(assistantThreadContactId(id));
}

/** 删除工作区：连消息带处理单一并清掉（助手对话不承载人格，可物理删）。 */
export function deleteAssistantThread(id: string): boolean {
  const list = readThreads();
  if (!list.some((t) => t.id === id)) return false;
  writeThreads(list.filter((t) => t.id !== id));
  // 消息与图片走清空那条路：它负责回收本轮里那些 /media——裸 DELETE 的话图片
  // 只靠 24 小时后的全量对账兜着，删了工作区磁盘要过一天才真的还回来。
  clearAssistantContactMessages(ASSISTANT_THREAD_PREFIX + id);
  return true;
}

/** 工作区发第一条消息时用消息内容自动命名（仅当还是默认名）；「通用」不参与。 */
export function autoTitleThread(contactId: string, text: string): void {
  if (!contactId.startsWith(ASSISTANT_THREAD_PREFIX)) return;
  const list = readThreads();
  const t = list.find((x) => x.id === contactId.slice(ASSISTANT_THREAD_PREFIX.length));
  if (t && t.title === DEFAULT_THREAD_TITLE && text.trim() !== "") {
    t.title = text.trim().slice(0, 16);
    writeThreads(list);
  }
}

/**
 * 助手不是陪伴角色：几千字的内部权衡是噪音，默认不展示思考过程。
 * 助手资料页不渲染「聊天显示」分区（见 docs/pitfalls.md），用户没法自己关，
 * 所以只能在这里兜底；存量助手也要迁移，不能只在新建时设。
 */
function ensureAssistantDisplayDefaults(id: string): void {
  const c = getContact(id);
  if (c && c.features.showThinking !== false) {
    updateContact(id, { features: { showThinking: false } });
  }
}

/** 启动时确保保留联系人存在（幂等；已存在不覆盖用户改过的资料）。 */
export function ensureAssistantContact(): void {
  const existing = getContact(ASSISTANT_CONTACT_ID);
  if (existing) {
    // 设置助手不是陪伴角色，界面上也不提供指代方式选择；历史版本按默认值落成的
    // female/male 在这里归中性，避免内部提示词继续把它绑定到某种指代。
    if (existing.gender !== "other") updateContact(ASSISTANT_CONTACT_ID, { gender: "other" });
    ensureAssistantDisplayDefaults(ASSISTANT_CONTACT_ID);
    return;
  }
  createContact({
    id: ASSISTANT_CONTACT_ID,
    name: ASSISTANT_CONTACT_NAME,
    gender: "other",
    card: {
      name: ASSISTANT_CONTACT_NAME,
      identity: "我是小茉应用的内置设置助手：帮你接入模型、创建和配置联系人、排查能力设置。",
      background: "我运行在应用内部，能读取真实配置状态并直接执行配置操作。",
    },
  });
  ensureAssistantDisplayDefaults(ASSISTANT_CONTACT_ID);
}

/** 助手不是陪伴角色：这些行为对所有助手会话（含工作区派生 id）一律关闭。 */
export function isAssistant(contactId: string | null | undefined): boolean {
  return contactId === ASSISTANT_CONTACT_ID || (contactId ?? "").startsWith(ASSISTANT_THREAD_PREFIX);
}

/**
 * 把助手钉在当前生效档上（只钉一次，之后全局切换不再波及它）。
 * 这是可用性保证：哪怕用户让助手把一个坏档启用成全局默认，
 * 助手自己仍跑在原来那把上，还能开口帮忙回滚。解绑/改绑只能由用户在
 * 「编辑资料 → 模型」里手动做——助手的工具也拒绝改它自己的绑定。
 */
export function pinAssistantToActiveProfile(): void {
  const a = getContact(ASSISTANT_CONTACT_ID);
  if (!a || a.model_profile !== "") return;
  const aid = activeProfileId();
  if (aid) updateContact(ASSISTANT_CONTACT_ID, { modelProfile: aid });
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ── 角色卡「已配置」判据 ────────────────────────────────────────────────
// 事故背景：create_contact 的工具描述曾鼓励「先给一句合理的占位描述」，模型就把
// 「待用户定义（可在编辑资料中细化）」写进 relationship；快照只判 !== ""，
// 助手看到 cardFilled:true 便报「配置完成」，而这段元指令会被 persona.ts 原样
// 拼进角色提示词。
//
// 主防线在写入侧：create_contact / update_contact 直接拒绝非设定正文。
// 这里是对**存量数据**与用户在资料页手改的防御层。认的是「让人去填/去改」这类
// 元指令特征，不是两句固定文案——模型每次生成的占位说法都不同，枚举句子必然漏
// （库里就出现过「用户自定义联系人」这种变体）。
//
// 判据按置信度分三档。两个方向的误判都出在「一刀切」上：长度下限抬太高，会把
// 用户明确要的「同事」「朋友」这类 2 字合法关系值当占位拒掉；元指令正则只看
// 短文本，超长的占位段落反而判「已完成」。所以：
//   ① EXACT——整段就是一个占位词（无/暂无/待定/TBD…）：锚定匹配，任意长度生效；
//   ② 高置信特征——「占位/待填/TBD/自定义联系人」这类几乎不可能是真实设定的词，
//      以及纯符号/纯数字/括号壳：任意长度生效；
//   ③ 指令式特征——「让用户去编辑资料补充」这类句子：真实设定偶尔也带「用户」
//      等字眼，只在 ≤120 字时生效，长文本交给语境。
// 刻意不做持久化的 confirmed 标记：用户在资料页改卡不经过工具，标记一旦过期
// 比内容判据更不可信。真相源始终是卡片正文本身；想核对全文走 app_status(contact)。
// 改这里的判据必须连着改 smoke [31] 的夹具与断言（占位被拒、合法短值放行两头都要有）。
const CARD_PLACEHOLDER_EXACT: readonly string[] = [
  "无", "暂无", "没有", "未知", "待定", "待补充", "待填写", "待完善", "待细化",
  "未设定", "暂未设定", "后续补充", "以后再说", "先不填", "先空着", "随便", "随意",
  "tbd", "todo", "tbc", "n/a", "na", "none", "null",
];
const CARD_META_ANY_LENGTH: readonly RegExp[] = [
  /占位/, /待填/, /用户自定义联系人|自定义联系人/, /TBD|TODO|TBC/i,
  /^[\s\-—–_·.。、,，:：*#]+$/, /^\d+$/, /^[(（][^)）]{0,60}[)）]$/,
];
const CARD_META_SHORT_TEXT: readonly RegExp[] = [
  /待(用户|你|后续|之后)?(定义|补充|填写|设定|定|细化)/,
  /(自行|由用户|用户自行|请你|请用户)(填写|补充|定义|设定|细化|修改)/,
  /(可|请|去|到)(在|到|去)?.{0,8}(编辑资料|资料页|设置页).{0,8}(细化|补充|修改|完善|填写)/,
  /编辑资料.{0,6}(里|中|去)?(细化|补充|修改|完善|填写)/,
  /根据需要再/,
];
/** 指令式特征只看短文本的界限：真实设定很少在 120 字内通篇还是「去哪里补/谁来填」。 */
const CARD_SHORT_TEXT_LIMIT = 120;

/** 一段卡片正文是否算「真的写好了」。空 / 过短 / 占位或元指令一律 false。 */
export function isCardFieldComplete(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return false;
  // 「同事」「朋友」这类用户明确给出的短关系值是合法设定；只有单字算没写。
  if (text.length < 2) return false;
  if (CARD_PLACEHOLDER_EXACT.includes(text.toLowerCase())) return false;
  if (CARD_META_ANY_LENGTH.some((re) => re.test(text))) return false;
  return !(text.length <= CARD_SHORT_TEXT_LIMIT && CARD_META_SHORT_TEXT.some((re) => re.test(text)));
}

/** 写入侧闸门：留空合法（表示待补全），非空就必须是一段像样的设定正文。 */
function rejectCardPlaceholder(fields: Record<string, string>): string | null {
  for (const [field, value] of Object.entries(fields)) {
    if (value === "") continue;
    if (!isCardFieldComplete(value)) {
      return `${field} 看起来是占位或操作说明，不是设定正文（「${value.slice(0, 30)}」）。请写成具体内容，或留空之后用 update_contact 补全；这类文字会原样进入角色提示词。`;
    }
  }
  return null;
}

/** 给模型回执用的卡片投影：三段正文 + 完成状态，不带 name 之类的冗余。 */
function cardReceipt(card: { background?: string; identity?: string; relationship?: string }): Record<string, unknown> {
  const parts = {
    background: card.background ?? "",
    identity: card.identity ?? "",
    relationship: card.relationship ?? "",
  };
  return {
    card: parts,
    cardFilled: {
      background: isCardFieldComplete(parts.background),
      identity: isCardFieldComplete(parts.identity),
      relationship: isCardFieldComplete(parts.relationship),
    },
  };
}

/**
 * 给模型的配置快照：以 settingsSnapshot() 为唯一真相源，做**显式白名单投影**。
 * settingsSnapshot 里 model / profiles / capabilities.*.effective 都带真实密钥，
 * 绝不能 spread 进提示词；这里只挑能回答配置问题的标量、短数组与计数。
 * 每轮都会拼进系统提示词，所以不放整份目录，也不放卡片正文（只给「填没填」）。
 * 「填没填」必须是可信判据——见 isCardFieldComplete；想看某位联系人的完整卡片，
 * 走 app_status(contact) 按需取，别把正文塞进每轮快照把 prompt 撑大。
 */
function mediaSnapshot(): Record<string, unknown> {
  try {
    const stats = assetStats();
    return {
      total: stats.total,
      emotes: stats.emotes,
      broken: stats.broken,
      packs: listEmotePacks().map((p) => ({ pack: p.pack, total: p.total, unnamed: p.unnamed })),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function statusSnapshot(): Record<string, unknown> {
  const s = settingsSnapshot();
  const model = modelConfig();
  const aid = activeProfileId();
  const contacts = listContacts().filter((c) => c.id !== ASSISTANT_CONTACT_ID);
  return {
    ok: true,
    model: {
      mode: model.mode,
      name: model.name,
      baseUrl: model.baseUrl,
      ready: model.mode === "echo" ? true : model.apiKey !== "" && model.baseUrl !== "" && model.name !== "",
      visionDeclared: model.caps.vision,
    },
    activeProfileId: aid,
    profiles: s.profiles.map((p) => ({
      id: p.id, label: p.label, name: p.name, baseUrl: p.baseUrl, active: p.active,
    })),
    contacts: contacts.map((c) => ({
      id: c.id, name: c.name, modelProfile: c.model_profile || "",
      // 空串与「待用户定义」之类元指令都不算已配置：只判 !== "" 的话，
      // 占位文案被当成完成，助手便会跳过 update_contact 直接报「配置完成」。
      cardFilled: {
        background: isCardFieldComplete(c.card.background),
        identity: isCardFieldComplete(c.card.identity),
        relationship: isCardFieldComplete(c.card.relationship),
      },
      hasAvatar: c.avatar !== "",
    })),
    /** 六张能力卡的真实生效值（不含密钥）：排查「看图/语音为什么没配上」要靠它。 */
    capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => {
      const card = s.capabilities[name];
      return [name, {
        label: CAPABILITY_LABELS[name],
        ready: s.capabilitiesReady[name],
        linkedToMain: card.linkedToMain,
        explicit: card.activeId !== "",
        baseUrl: card.effective.baseUrl,
        model: card.effective.model,
        voice: card.effective.voice,
        profileCount: card.profiles.length,
      }];
    })),
    capabilitiesReady: s.capabilitiesReady,
    /** 全局设置：引导完成度、工具台账、表达倾向、系统与数据。这里是只读投影，写要另走工具。 */
    settings: {
      onboardingDone: onboardingDone(),
      characterName: s.persona.character.name,
      ownerFilled: {
        name: s.persona.owner.name !== "",
        impression: s.persona.owner.impression !== "",
        notes: s.persona.owner.notes !== "",
      },
      recentTurns: s.persona.recentTurns,
      recentTurnsPct: s.persona.recentTurnsPct,
      toolLoopTurns: s.toolLoopTurns,
      toolLoopTurnLimits: s.toolLoopTurnLimits,
      emoteFrequency: s.emoteFrequency,
      toolsEnabled: s.toolsEnabled,
      globalToolPreset: s.globalToolPreset,
      disabledTools: s.disabledTools,
      dataDir: s.dataDir,
      desktop: s.desktop,
    },
    media: mediaSnapshot(),
    /** 渠道连接状态由 server 层注册到 core/assistant-context；未装配时为空对象。 */
    channels: assistantStatusExtensions(),
    // 技能是磁盘上的外部文件，坏掉的形态五花八门（缺文件、名字不合法、正文超长）。
    // 快照里带上 blocked 的原因，用户问「我那个技能怎么没生效」时联系人能答上来，
    // 而不是只会说"我没看到技能"把人送去重启。
    skills: skillsStatus(),
    // 扩展（MCP / webhook / JS 工具）同样进快照：助手回答「现在能查网吗」这类问题
    // 要以登记表为事实，而不是猜。
    extensions: extensionSnapshot(),
  };
}

/** 按 id 精确 → label/name 精确 → 唯一模糊，匹配不到返回候选让人话澄清。 */
function resolveContact(target: string): { contact?: Contact; error?: string } {
  const contacts = listContacts().filter((c) => c.id !== ASSISTANT_CONTACT_ID);
  const byId = contacts.find((c) => c.id === target);
  if (byId) return { contact: byId };
  const exact = contacts.filter((c) => c.name === target);
  if (exact.length === 1) return { contact: exact[0] };
  if (exact.length > 1) return { error: `有 ${exact.length} 个同名联系人「${target}」，请让用户指明 id。` };
  const fuzzy = contacts.filter((c) => c.name.includes(target));
  if (fuzzy.length === 1) return { contact: fuzzy[0] };
  return {
    error: `没找到联系人「${target}」。现有：${contacts.map((c) => `${c.name}(${c.id})`).join("、") || "（还没有联系人）"}`,
  };
}

/**
 * 单个联系人的完整资料：卡片正文、占位标记、头像与模型绑定。
 * 只在 app_status 传了 contact 时按需返回——每轮快照塞正文会随联系人数线性膨胀，
 * 而绝大多数轮次根本不需要看正文。
 */
function contactDetail(target: string): Record<string, unknown> {
  const r = resolveContact(target);
  if (!r.contact) return { ok: false, error: r.error };
  const c = r.contact;
  const filled = cardReceipt(c.card) as { card: Record<string, string>; cardFilled: Record<string, boolean> };
  return {
    ok: true,
    contact: {
      id: c.id,
      name: c.name,
      card: filled.card,
      cardFilled: filled.cardFilled,
      // 明确区分「空着」和「写了占位」：两者都算没配好，但补救话术不同。
      cardPlaceholder: Object.fromEntries(
        Object.entries(filled.card).map(([key, value]) => [key, value.trim() !== "" && !isCardFieldComplete(value)]),
      ),
      hasAvatar: c.avatar !== "",
      avatar: c.avatar,
      modelProfile: c.model_profile || "",
      followsGlobalModel: c.model_profile === "",
      activeProfileId: activeProfileId(),
    },
  };
}

function resolveProfile(target: string): { id?: string; label?: string; error?: string } {
  const profiles = listProfiles();
  const byId = profiles.find((p) => p.id === target);
  if (byId) return { id: byId.id, label: byId.label };
  const exact = profiles.filter((p) => p.label === target);
  if (exact.length === 1) return { id: exact[0]!.id, label: exact[0]!.label };
  const fuzzy = profiles.filter((p) => p.label.includes(target) || p.name.includes(target));
  if (fuzzy.length === 1) return { id: fuzzy[0]!.id, label: fuzzy[0]!.label };
  return {
    error: `没找到模型「${target}」。现有：${profiles.map((p) => `${p.label}(${p.id})`).join("、") || "（还没有模型档）"}`,
  };
}

/**
 * 画头像的构图约束。要的不是"一张插画"而是**能被认出来的头像**：
 * 头肩居中、方图、脸是画面主体——联系人会被显示在 32~48px 的圆里，全身构图进去就是一团糊。
 */
const AVATAR_FRAMING =
  "人物头像：方形构图，头肩到胸口入画，脸部为画面主体并居中，视线看向镜头。" +
  "背景简洁不抢主体；画面里不要文字、水印、签名、边框或任何 UI。单人居中，不要出现第二个人。";

const ASSISTANT_TOOL_DEFS: ToolDef[] = [
  {
    name: "app_status",
    description:
      "读取真实配置（脱敏，密钥永不出快照）。系统提示词末尾**每轮已经注入**一份实时快照：生效模型与模型档、联系人（名字 / 模型绑定 / 三段设定完成状态 / 有无头像）、六张能力卡、工具台账、引导完成度、技能 / 扩展 / 媒体库 / 渠道连接，回答配置问题直接以它为准，不要凭记忆猜，也不必先调一次本工具。" +
      "只有两种情况才调：① 写入配置后要复核结果；② 要看某位联系人的**完整卡片正文**时传 contact（名字或 id），返回三段正文、占位标记、头像路径与模型绑定状态。不传 contact 就是全量快照，不含卡片正文。",
    parameters: {
      type: "object",
      properties: {
        contact: { type: "string", description: "可选：只看这一位联系人，拿完整卡片正文与占位标记" },
      },
      additionalProperties: false,
    },
    execute: (args) => {
      const target = clean(args.contact);
      return target === "" ? statusSnapshot() : contactDetail(target);
    },
  },
  {
    name: "configure_capability",
    description:
      "给「能力模型」的一张卡新增或更新一份端点档（看图、生成图片、语音识别、语音合成、向量等）。capability 必填，label / baseUrl / name 是这份档的显示名、接口地址、模型名；apiKey 只在用户提供时传，不要在回复里复述。默认存下第一份就立即启用（activate:false 只存不启用）。「memoryExtract」这张卡跟随主对话模型、不单独存档，请用 configure_model。",
    parameters: {
      type: "object",
      properties: {
        capability: { type: "string", enum: [...CAPABILITY_NAMES], description: "能力卡名" },
        label: { type: "string", description: "档位显示名，如 qwen-vl-plus" },
        baseUrl: { type: "string", description: "接口地址" },
        name: { type: "string", description: "模型名" },
        apiKey: { type: "string", description: "API 密钥；不传则沿用已有档" },
        voice: { type: "string", description: "TTS 音色名（仅语音合成用）" },
        activate: { type: "boolean", description: "是否立即启用，缺省 true" },
      },
      required: ["capability", "label", "baseUrl", "name"],
      additionalProperties: false,
    },
    execute: (args) => {
      const cap = clean(args.capability) as (typeof CAPABILITY_NAMES)[number];
      if (!CAPABILITY_NAMES.includes(cap)) return { ok: false, error: `capability 只能是 ${CAPABILITY_NAMES.join(" / ")}` };
      const label = CAPABILITY_LABELS[cap];
      if (mainLinked(cap)) {
        return { ok: false, error: `「${label}」跟随主对话模型，不单独存端点档；请在「设置 → 模型与能力 → 主对话模型」里配，或让我用 configure_model 加一份模型档。` };
      }
      const patch = {
        label: clean(args.label),
        baseUrl: clean(args.baseUrl),
        name: clean(args.name),
        ...(clean(args.apiKey) !== "" ? { apiKey: clean(args.apiKey) } : {}),
        ...(clean(args.voice) !== "" ? { voice: clean(args.voice) } : {}),
      };
      const check = validateCapabilityProfile(patch);
      if (!check.ok) return { ok: false, error: `${label}：${check.errors.join("；")}` };
      try {
        const saved = saveCapabilityProfile(cap, patch);
        // 与设置页同口径：这张卡上第一份档存下去就启用，用户的意图是「配好就能用」。
        if (args.activate !== false && capabilityActiveId(cap) === "") activateCapabilityProfile(cap, saved.id);
        return {
          ok: true, capability: cap, label, profile: saved.label,
          activated: capabilityActiveId(cap) === saved.id, ready: capabilityReady(cap),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  {
    name: "set_preference",
    description:
      "改两项全局偏好：emoteFrequency（off / rare / normal / often，发表情倾向）与 toolLoopTurns（1~16，一轮最多几次工具循环）。只接受这两项；外观、通知、渠道、备份、权限档、工具开关没有写工具，请给用户准确的界面路径。",
    parameters: {
      type: "object",
      properties: {
        emoteFrequency: { type: "string", enum: [...EMOTE_FREQUENCIES], description: "发表情频率" },
        toolLoopTurns: {
          type: "number", minimum: TOOL_LOOP_TURN_LIMITS.min, maximum: TOOL_LOOP_TURN_LIMITS.max,
          description: "一轮最多几次工具循环",
        },
      },
      additionalProperties: false,
    },
    execute: (args) => {
      const hasFreq = typeof args.emoteFrequency === "string" && args.emoteFrequency !== "";
      const hasTurns = typeof args.toolLoopTurns === "number";
      if (!hasFreq && !hasTurns) return { ok: false, error: "至少要给 emoteFrequency 或 toolLoopTurns 中的一项" };
      if (hasFreq && !(EMOTE_FREQUENCIES as readonly string[]).includes(args.emoteFrequency as string)) {
        return { ok: false, error: `emoteFrequency 只能是 ${EMOTE_FREQUENCIES.join(" / ")}` };
      }
      if (hasTurns && (!Number.isInteger(args.toolLoopTurns)
        || (args.toolLoopTurns as number) < TOOL_LOOP_TURN_LIMITS.min
        || (args.toolLoopTurns as number) > TOOL_LOOP_TURN_LIMITS.max)) {
        return { ok: false, error: `toolLoopTurns 只能是 ${TOOL_LOOP_TURN_LIMITS.min}~${TOOL_LOOP_TURN_LIMITS.max} 的整数` };
      }
      if (hasFreq) setGlobalEmoteFrequency(args.emoteFrequency);
      if (hasTurns) setGlobalToolLoopTurns(args.toolLoopTurns);
      return { ok: true, emoteFrequency: globalEmoteFrequency(), toolLoopTurns: globalToolLoopTurns() };
    },
  },
  {
    name: "configure_model",
    description:
      "新增或更新一个 OpenAI 兼容模型档（按 label 匹配已有档）。用户提供 baseUrl、模型名、apiKey 时调用；这是「一句话配好模型」的执行工具。默认保存后立即启用（activate 传 false 可只存不启用）。密钥只写入配置，不要在回复里复述。",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "档位显示名，如 DeepSeek、本地Ollama" },
        baseUrl: { type: "string", description: "接口地址，如 https://api.deepseek.com/v1" },
        apiKey: { type: "string", description: "API 密钥；本地服务可占位" },
        model: { type: "string", description: "模型名，如 deepseek-chat" },
        vision: { type: "boolean", description: "该模型是否支持图片输入（不确定就 false）" },
        thinking: { type: "boolean", description: "是否支持思考模式" },
        activate: { type: "boolean", description: "保存后是否立即启用为全局默认，缺省 true" },
      },
      required: ["label", "baseUrl", "model"],
      additionalProperties: false,
    },
    execute: (args) => {
      const label = clean(args.label);
      const baseUrl = clean(args.baseUrl);
      const model = clean(args.model);
      if (label === "" || baseUrl === "" || model === "") return { ok: false, error: "label、baseUrl、model 都不能为空" };
      if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: "baseUrl 必须以 http:// 或 https:// 开头" };
      const existing = listProfiles().find((p) => p.label === label);
      const apiKey = clean(args.apiKey) || existing?.apiKey || "";
      if (apiKey === "") return { ok: false, error: "缺少 apiKey：这个服务商需要密钥才能接入" };
      const saved = saveProfile({
        id: existing?.id,
        label, mode: "openai", baseUrl, apiKey, name: model,
        caps: { ...{ tools: false, vision: false, thinking: false, thinkingOnly: false, customProtocol: false }, vision: args.vision === true, thinking: args.thinking === true },
      });
      const activate = args.activate !== false;
      if (activate) activateProfile(saved.id);
      return { ok: true, profileId: saved.id, label: saved.label, activated: activate, note: activate ? "已保存并启用为全局默认" : "已保存，未启用" };
    },
  },
  {
    name: "activate_model",
    description: "把一个已存在的模型档设为全局默认（启用）。model 传档名或 id。",
    parameters: {
      type: "object",
      properties: { model: { type: "string", description: "模型档的显示名或 id" } },
      required: ["model"],
      additionalProperties: false,
    },
    execute: (args) => {
      const r = resolveProfile(clean(args.model));
      if (!r.id) return { ok: false, error: r.error };
      activateProfile(r.id);
      return { ok: true, activated: r.label, note: "已启用为全局默认，立即生效" };
    },
  },
  {
    name: "create_contact",
    description:
      "创建一个新联系人。用户说「帮我建一个XX」时调用。background/identity/relationship 三段尽量一次写成**具体内容**：" +
      "知名作品角色按作品设定把背景与人设写全；不知道就留空，之后用 update_contact 补，绝不要写「待用户定义」「可在编辑资料里细化」这类占位或操作说明——它会原样进入角色提示词。" +
      "relationship 是用户侧偏好（怎么称呼、什么阶段、边界），用户没指定就留空或给中性默认，不要凭空编一段亲密关系。" +
      "回执会带实际写入的三段正文与 cardFilled，缺哪段照着补。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "联系人名字，≤20 字" },
        background: { type: "string", description: "背景设定（可选，要写就写具体；留空 = 之后补）" },
        identity: { type: "string", description: "人设（可选，要写就写具体；留空 = 之后补）" },
        relationship: { type: "string", description: "与用户的关系（可选；没指定就留空或给中性默认）" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: (args) => {
      const name = clean(args.name);
      if (name === "") return { ok: false, error: "联系人名字不能为空" };
      if (listContacts({ includeArchived: true }).some((c) => c.name === name)) return { ok: false, error: `已经有同名联系人「${name}」` };
      const card: Record<string, string> = { name };
      for (const key of ["background", "identity", "relationship"] as const) {
        const v = clean(args[key]);
        if (v !== "") card[key] = v;
      }
      const rejected = rejectCardPlaceholder({
        background: card.background ?? "", identity: card.identity ?? "", relationship: card.relationship ?? "",
      });
      if (rejected !== null) return { ok: false, error: rejected };
      const created = createContact({ name, card });
      return {
        ok: true,
        contactId: created.id,
        name: created.name,
        ...cardReceipt(created.card),
        hasAvatar: created.avatar !== "",
        note: "已创建。cardFilled 里为 false 的那几段可以说一声让我补全；也可以自己在侧栏「编辑资料」里写。",
      };
    },
  },
  {
    name: "update_contact",
    description:
      "修改已有联系人的设定文本（background/identity/relationship/name 任传其一或多项，只覆盖传了的字段）。contact 传名字或 id。" +
      "设定正文必须写具体内容，不收占位或操作说明（会原样进角色提示词）；留空不覆盖原值。" +
      "补全卡片的占位段时用它，回执会带更新后的三段正文与 cardFilled。",
    parameters: {
      type: "object",
      properties: {
        contact: { type: "string", description: "联系人名字或 id" },
        name: { type: "string" },
        background: { type: "string" },
        identity: { type: "string" },
        relationship: { type: "string" },
      },
      required: ["contact"],
      additionalProperties: false,
    },
    execute: (args) => {
      const r = resolveContact(clean(args.contact));
      if (!r.contact) return { ok: false, error: r.error };
      const patch: Record<string, unknown> = {};
      const card: Record<string, string> = {};
      const newName = clean(args.name);
      if (newName !== "") patch.name = newName;
      for (const key of ["background", "identity", "relationship"] as const) {
        const v = args[key];
        if (typeof v === "string" && v.trim() !== "") card[key] = v.trim();
      }
      if (Object.keys(card).length > 0) patch.card = card;
      if (patch.name === undefined && Object.keys(card).length === 0) return { ok: false, error: "没有要修改的内容" };
      const rejected = rejectCardPlaceholder(card);
      if (rejected !== null) return { ok: false, error: rejected };
      const updated = updateContact(r.contact.id, patch as Parameters<typeof updateContact>[1]);
      return {
        ok: true,
        contactId: r.contact.id,
        name: updated?.name ?? r.contact.name,
        updatedFields: Object.keys({ ...patch, ...card }),
        ...cardReceipt(updated?.card ?? r.contact.card),
      };
    },
  },
  {
    name: "set_contact_avatar",
    description:
      "给某位联系人设头像。image_url 与 draw_prompt 二选一：\n" +
      "· image_url：抓一张现成的图。可以给网图地址（配合 web_search 的结果用；原图也行，不再受内联体积限制），" +
      "也可以是应用里已有的 /media 路径（比如 web_search 图片结果里的 preview——用户挑中的那张就是它，" +
      "本来就是本地文件、不用再下一遍；或者联系人刚画出来的那张画）。\n" +
      "· draw_prompt：让联系人画一张，构图由程序补。写之前必须确认外貌：知名作品角色或对外貌没把握时，" +
      "先 web_search(kind=\"web\") 查「角色名 外貌 发色 瞳色」，照查到的写，不要凭记忆填发色 / 瞳色；查不到就问用户一句。\n" +
      "两种来源最后都落成本地 /media 文件，图不再依赖外部站点，也不会因为对方换域名而裂图。\n" +
      "用户说「给XX换个头像」「建一个XX并配好头像」时，先确认这位联系人存在（不存在先 create_contact），再设；" +
      "用户明确要「用原图 / 找现成的图」才走 web_search(kind=\"image\") 请用户按序号挑。",
    parameters: {
      type: "object",
      properties: {
        contact: { type: "string", description: "联系人名字或 id" },
        image_url: { type: "string", description: "http(s) 图片地址，或应用里已有的 /media 路径" },
        page_url: { type: "string", description: "可选：图所在页面，个别站点按来源页防盗链时才用得上" },
        draw_prompt: { type: "string", description: "或：让联系人画一张头像，给一句画面描述" },
      },
      required: ["contact"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const r = resolveContact(clean(args.contact));
      if (!r.contact) return { ok: false, error: r.error };
      const draw = clean(args.draw_prompt);
      const given = clean(args.image_url);
      if (draw === "" && given === "") return { ok: false, error: "image_url 与 draw_prompt 要给一个" };
      try {
        let mediaUrl: string;
        if (draw !== "") {
          if (!capabilityReady("imageGeneration")) {
            return { ok: false, error: "图像生成还没配好（设置 → 能力模型 → 图像生成），所以画不出头像。可以改用 image_url 找一张现成的。" };
          }
          const text = `「${r.contact.name}」的头像。${AVATAR_FRAMING}\n${draw.slice(0, 700)}`;
          mediaUrl = (await generateImage(text, { contactId: r.contact.id })).url;
        } else if (given.startsWith("/media/")) {
          // 已在媒体目录里的图不重新下载，但存在性要查：路径写错等于给用户一个裂图。
          if (!mediaUrlExists(given)) {
            return { ok: false, error: "那个 /media 地址在媒体目录里找不到（可能已被清理）。换 image_url 重新抓一张。" };
          }
          mediaUrl = given;
        } else {
          mediaUrl = await downloadImageToMedia(given, clean(args.page_url));
        }
        updateContact(r.contact.id, { avatar: mediaUrl });
        // 回执按**库里实际存的是什么**判，而不是按"我们调了 updateContact"判：
        // 字段清洗可能整段丢掉这次写入（格式不合、路径不存在），那种情况下说
        // "头像设好了"就是假话，用户刷新界面会发现还是原来的字母头像。
        const saved = getContact(r.contact.id)?.avatar ?? "";
        if (saved !== mediaUrl) {
          return { ok: false, error: `头像没写进去：想存的是 ${mediaUrl}，库里仍是「${saved === "" ? "空" : saved.slice(0, 40)}」` };
        }
        return {
          ok: true,
          contactId: r.contact.id,
          name: r.contact.name,
          avatar: mediaUrl,
          note: "头像已设，界面立刻可见。图存在本地媒体目录，之后那个外部站点关了也不影响。",
        };
      } catch (error) {
        return { ok: false, error: describeWebFailure(error) };
      }
    },
  },
  {
    name: "bind_contact_model",
    description:
      "给某个联系人单独绑定一个模型档（该联系人的对话与记忆用它来跑）。绑定会把「跟随全局」变成「固定这一档」，" +
      "以后切换全局默认不再波及它；model 传空字符串表示解除绑定、回到跟随全局默认。" +
      "目标档就是当前全局档时不写入，直接回「本来就在跟随全局，无需绑定」——别做一次无意义（且有副作用）的绑定。",
    parameters: {
      type: "object",
      properties: {
        contact: { type: "string", description: "联系人名字或 id" },
        model: { type: "string", description: "模型档名或 id；空串=跟随全局" },
      },
      required: ["contact", "model"],
      additionalProperties: false,
    },
    execute: (args) => {
      const target = clean(args.contact);
      if (target === ASSISTANT_CONTACT_ID || target === ASSISTANT_CONTACT_NAME) {
        return { ok: false, error: "设置助手自己的模型绑定由用户手动维护（保证它任何时候都能开口），助手不能改。" };
      }
      const r = resolveContact(target);
      if (!r.contact) return { ok: false, error: r.error };
      const model = clean(args.model);
      if (model === "") {
        updateContact(r.contact.id, { modelProfile: "" });
        return { ok: true, contact: r.contact.name, bound: null, changed: true, followsGlobal: true, note: "已解除绑定，回到跟随全局默认" };
      }
      const p = resolveProfile(model);
      if (!p.id) return { ok: false, error: p.error };
      // 绑到当前全局档不是 no-op：写入 model_profile 会把「跟随全局」改成「显式钉住」，
      // 以后切全局档不再波及这位联系人。用户没要求固定，就不该悄悄改掉这层语义。
      if (p.id === activeProfileId()) {
        const pinned = r.contact.model_profile !== "";
        return {
          ok: true, contact: r.contact.name, bound: null, changed: false, followsGlobal: !pinned,
          note: pinned
            ? `「${p.label}」就是当前全局默认档，这位联系人已经显式绑在它上面；没有改动。想恢复跟随全局就把 model 传空串。`
            : `「${p.label}」就是当前全局默认档，这位联系人本来就在跟随全局，无需单独绑定；没有改动。`,
        };
      }
      updateContact(r.contact.id, { modelProfile: p.id });
      return {
        ok: true, contact: r.contact.name, bound: p.label, changed: true, followsGlobal: false,
        note: `该联系人的对话已固定用「${p.label}」，之后切换全局默认不再影响它；想恢复跟随就把 model 传空串。`,
      };
    },
  },
  {
    name: "manage_extensions",
    description:
      "扩展（外部能力包）的插拔管理。action=list 列出全部扩展与诊断；enable/disable 拨开关（enable 会顺带连一次 MCP 拉工具目录）；probe 手动连一次 MCP 刷新目录并返回连接诊断；delete 彻底删除（必须先经用户明确同意再传 confirmed:true，删除不可恢复）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "enable", "disable", "probe", "delete"] },
        id: { type: "string", description: "扩展 id（list 之外必填）" },
        confirmed: { type: "boolean", description: "仅 delete 需要：用户明确同意后传 true" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const action = clean(args.action);
      if (action === "list") return { ok: true, ...extensionSnapshot() };
      const id = clean(args.id);
      if (id === "") return { ok: false, error: "id 不能为空（list 之外的动作都要指明哪个扩展）" };
      try {
        if (action === "delete") {
          // confirm 档下这里的 confirmed:true 不再算数——必须等用户点卡片（见 guardDangerous）。
          return await Promise.resolve(guardDangerous(
            "manage_extensions", args, context,
            `删除扩展「${id}」`,
            "扩展连同它的全部工具一起摘除，不可恢复。要换新版本可以重新导入，不必删除。",
            () => {
              removeExtension(id, true);
              return { ok: true, deleted: id, ...extensionSnapshot() };
            },
          ));
        }
        if (action === "enable" || action === "disable") {
          const entry = await setExtensionEnabled(id, action === "enable");
          const probeErr = entry.diagnostics.find((d) => d.level === "error");
          return { ok: true, id, enabled: action === "enable", tools: entry.tools, warning: probeErr?.message };
        }
        if (action === "probe") {
          const probed = await probeExtension(id);
          return { ok: probed.diagnostics.every((d) => d.level !== "error"), id, toolCount: probed.tools, diagnostics: probed.diagnostics };
        }
        return { ok: false, error: `未知 action「${action}」` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  {
    name: "import_extension",
    description:
      "替用户写一份扩展清单并登记（xiaomo-extension.json 格式）。mcp（url/headers，url 只收 https 或本机回环 http）与 tools（自定义工具数组）至少有其一。密钥放 headers 不要拼进 URL。导入成功后默认不启用，需再调 manage_extensions(enable)。",
    parameters: {
      type: "object",
      properties: {
        manifest: {
          type: "object",
          description: "完整清单对象：formatVersion=1、id（小写字母开头，小写字母/数字/连字符）、name、version（x.y.z）、description、mcp?、tools?",
        },
        enable: { type: "boolean", description: "导入后是否立即启用，缺省 false" },
      },
      required: ["manifest"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const manifest = args.manifest;
      const manifestName = manifest !== null && typeof manifest === "object" && typeof (manifest as { name?: unknown }).name === "string"
        ? (manifest as { name: string }).name : "未命名扩展";
      return await Promise.resolve(guardDangerous(
        "import_extension", args, context,
        `导入扩展「${manifestName}」`,
        "导入会给模型新增一批工具；若随后启用 MCP，相关对话数据还会发送给第三方服务。",
        async () => {
          try {
            const result = importExtensionManifest(args.manifest);
            if (args.enable === true) await setExtensionEnabled(result.entry.id, true);
            // 启用会拉 MCP 目录，回包必须取启用后的新快照——导入那一刻目录还是空的。
            const fresh = extensionSnapshot().extensions.find((e) => e.id === result.entry.id) ?? result.entry;
            return { ok: true, id: result.entry.id, created: result.created, entry: fresh, note: args.enable === true ? "已导入并启用" : "已导入（未启用）" };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      ));
    },
  },
  {
    name: "edit_extension_tool",
    description:
      "给已登记的扩展增改删自定义工具（webhook 或 script）。action=save 需传完整 tool（name/description/parameters(JSON Schema)/handler）；action=delete 传 name。script 工具只有在「JS 执行许可」开启后才会对模型可见。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "扩展 id" },
        action: { type: "string", enum: ["save", "delete"] },
        tool: {
          type: "object",
          description: "save 时必填：{ name, description, parameters, handler:{ kind:'webhook', url, headers?, timeoutMs? } 或 { kind:'script', code, timeoutMs? } }",
        },
        name: { type: "string", description: "delete 时要删的工具名" },
      },
      required: ["id", "action"],
      additionalProperties: false,
    },
    execute: (args) => {
      const id = clean(args.id);
      const action = clean(args.action);
      if (id === "") return { ok: false, error: "id 不能为空" };
      try {
        if (action === "save") {
          if (args.tool === undefined || args.tool === null || typeof args.tool !== "object") return { ok: false, error: "save 需要完整的 tool 对象" };
          const entry = saveExtensionTool(id, args.tool);
          return { ok: true, id, tools: entry.tools, note: "工具已保存；若该扩展已启用，下一轮对话即生效" };
        }
        if (action === "delete") {
          const name = clean(args.name);
          if (name === "") return { ok: false, error: "delete 需要工具名" };
          const entry = deleteExtensionToolByName(id, name);
          return { ok: true, id, tools: entry.tools };
        }
        return { ok: false, error: `未知 action「${action}」` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  {
    name: "set_script_gate",
    description:
      "开启或关闭「JS 工具执行许可」。开启后 script 类工具会在本机受限沙箱里执行 JS——这是一次真实的权限授予：模型可决定传给脚本的参数。必须先向用户说明风险并得到明确同意，才能传 confirmed:true。",
    parameters: {
      type: "object",
      properties: {
        allow: { type: "boolean" },
        confirmed: { type: "boolean", description: "用户明确同意后传 true" },
      },
      required: ["allow", "confirmed"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      try {
        if (args.allow === true) {
          return await Promise.resolve(guardDangerous(
            "set_script_gate", args, context,
            "开启 JS 工具执行许可",
            "script 类工具将在本机的受限沙箱里执行代码；模型可以决定传给它的参数。只在确有需要时开启。",
            () => {
              setScriptGate(true, true);
              return { ok: true, allowScripts: true, note: "JS 执行许可已开启" };
            },
          ));
        }
        setScriptGate(args.confirmed === true, false);
        return { ok: true, allowScripts: false, note: "JS 执行许可已关闭，script 工具对模型不可见" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
];

/** 写工具的一句话摘要：从参数与回执里挑最有辨识度的字段，拼成给人看的审计行。 */
function summarizeWrite(tool: string, args: Record<string, unknown>, result: unknown): string {
  const r = (result ?? {}) as {
    ok?: boolean; label?: string; name?: string; contact?: string;
    activated?: string; bound?: string | null; deleted?: string; id?: string;
    /** 工具明确声明「没有改动」时不该记成一次变更（绑到当前全局档就是这种情况）。 */
    changed?: boolean;
  };
  const id = clean(args.id);
  switch (tool) {
    case "configure_model": return `保存模型档「${r.label ?? clean(args.label)}」`;
    case "configure_capability": return `配置能力模型「${clean(args.capability)}」的端点档「${clean(args.label)}」`;
    case "set_preference": {
      const bits: string[] = [];
      if (typeof args.emoteFrequency === "string") bits.push(`表情频率=${args.emoteFrequency}`);
      if (typeof args.toolLoopTurns === "number") bits.push(`工具轮次=${args.toolLoopTurns}`);
      return `调整全局偏好：${bits.join("、")}`;
    }
    case "activate_model": return `启用模型档「${r.activated ?? clean(args.model)}」`;
    case "create_contact": return `创建联系人「${r.name ?? clean(args.name)}」`;
    case "update_contact": return `修改联系人「${r.name ?? clean(args.contact)}」的设定`;
    case "set_contact_avatar": return `给「${r.name ?? clean(args.contact)}」设置头像`;
    case "bind_contact_model":
      if (r.changed === false) return `「${r.contact ?? clean(args.contact)}」本来就在跟随全局，无需绑定`;
      return r.bound ? `把「${r.contact}」绑定到模型「${r.bound}」` : `解除「${r.contact ?? clean(args.contact)}」的模型绑定`;
    case "manage_extensions": {
      const action = clean(args.action);
      if (action === "enable") return `启用扩展「${r.id ?? id}」`;
      if (action === "disable") return `停用扩展「${r.id ?? id}」`;
      if (action === "delete") return `删除扩展「${r.deleted ?? r.id ?? id}」`;
      return `管理扩展「${id}」`;
    }
    case "import_extension": {
      // 失败时回执里没有 id，从参数里的清单 id 兜底——审计行不能是一串空引号。
      const manifestId = (args.manifest ?? {}) as { id?: unknown };
      const fallback = typeof manifestId.id === "string" ? manifestId.id : "";
      return `导入扩展「${r.id ?? fallback}」`;
    }
    case "edit_extension_tool":
      return clean(args.action) === "save" ? `保存扩展「${id}」的自定义工具` : `删除扩展「${id}」的自定义工具`;
    case "set_script_gate": return args.allow === true ? "开启 JS 工具执行许可" : "关闭 JS 工具执行许可";
    default: return tool;
  }
}

/**
 * 写工具统一包一层活动记录（控制台「最近的配置变更」的数据源）。
 * 包在 ASSISTANT_TOOL_DEFS 外而不是在每个 execute 里手写：新增写工具自动入账，
 * 不会出现「工具在白名单里、审计却看不见它」的缺口。读动作（list/probe）不改配置，不记。
 */
function withActivityLogging(tool: ToolDef): ToolDef {
  if (!ASSISTANT_WRITE_TOOLS.has(tool.name)) return tool;
  const original = tool.execute;
  return {
    ...tool,
    execute: (args, context) => {
      const tier = context.assistantPermission ?? assistantPermission();
      const confirmed = typeof args.__confirmActionId === "string" && args.__confirmActionId !== "";
      const readOnlyCall = tool.name === "manage_extensions"
        && (clean(args.action) === "list" || clean(args.action) === "probe");
      const finish = (result: unknown): unknown => {
        if (!readOnlyCall) {
          const r = (result ?? {}) as { ok?: boolean; error?: string; note?: string; needsConfirmation?: unknown; changed?: boolean };
          // needsConfirmation 不入账：操作此刻既没成功也没失败，只是挂起了确认卡。
          // 它的结局由后续路径记账——同意 → 本工具带 confirmed 执行，拒绝 → 「用户拒绝了…」。
          // changed:false 也不入账：「本来就在跟随全局，无需绑定」不是一次配置变更。
          if (r.needsConfirmation === undefined && r.changed !== false) {
            recordActivity({
              ts: Date.now(),
              tool: tool.name,
              title: summarizeWrite(tool.name, args, result),
              ok: r.ok === true,
              ...(r.ok === true
                ? (typeof r.note === "string" && r.note !== "" ? { detail: r.note } : {})
                : (typeof r.error === "string" && r.error !== "" ? { detail: r.error.slice(0, 200) } : {})),
              ...(context.contactId !== "" ? { contactId: context.contactId } : {}),
              tier,
              ...(confirmed ? { confirmed: true } : {}),
            });
          }
        }
        return result;
      };
      try {
        const out = original(args, context);
        if (!(out instanceof Promise)) return finish(out);
        return out.then(finish, (error: unknown) => {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
          throw error;
        });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

export const ASSISTANT_TOOLS: ToolDef[] = ASSISTANT_TOOL_DEFS.map(withActivityLogging);

/** 助手的系统提示词：身份 + 纪律 + 每轮注入的实时状态。 */
export function buildAssistantSystemPrompt(permission: AssistantPermission = assistantPermission()): string {
  const s = statusSnapshot();
  const skills = skillCatalogSection();
  return [
    "你是「小茉」应用内置的设置助手，不是陪伴角色。说话简洁、专业、友好，用中文。",
    "你能做的事：接入/切换模型、配置能力模型（看图/语音/出图等专项端点）、创建与配置联系人、给联系人绑定模型与头像、" +
    "调整全局发表情频率与工具循环轮次、排查配置问题、替用户编写与管理扩展（接入 MCP 服务、写 webhook/JS 自定义工具、插拔开关）。",
    "文末是本轮注入的脱敏实时快照：模型档、联系人（三段设定的完成状态 / 有无头像）、六张能力卡的生效端点、工具台账、引导完成度、技能 / 扩展 / 媒体库 / 渠道连接；密钥永远不在里面。" +
      "快照是**本轮开始时**的状态，本轮写入不会自动刷新；要复核或看某位联系人的完整卡片，才调 app_status（传 contact 拿详情）。",
    "纪律：",
    "- 以本轮注入的快照为准，不要先调 app_status 才动手；写入后要复核、或要看某位联系人的完整卡片时，才调 app_status（可传 contact）。",
    "- 用户问「我还需要设置什么？」时按快照逐项看：settings.onboardingDone、model.ready、capabilities 里 ready=false 的卡、" +
      "channels 里没连上的渠道、media.emotes 是否为 0、settings.ownerFilled 的缺项、skills/extensions 的 blocked；" +
      "按「先影响能不能用、再影响好不好用」排 2~4 条说清楚，别只回「配个模型」。",
    "- 排查看图/语音/出图能力时看 capabilities 的 baseUrl / model / explicit / linkedToMain：" +
      "说清缺的是端点档、模型名还是密钥，别只说「没配好」；linkedToMain 的能力要在主对话模型里配。",
    "- 只有登记的写工具能代改；外观、通知、渠道凭据、备份恢复、权限档、工具逐项开关没有写工具，别承诺替用户改，直接给准确路径。",
    "- 只有工具返回 ok:true 才能说操作成功；失败就原样说明原因和下一步建议。",
    // 「都配置好」必须有唯一、可核对的完成定义：提示词只写「创建 → 配头像」的话，
    // 模型自己猜「都」包括什么，会选最容易验证的两件（绑模型、画头像），
    // 人设 / 关系仍是占位却回「配置完成」。把清单与复核写死，别指望模型自觉。
    "- 配置一个联系人（用户说「建一个XX」「都配置好 / 配置完成 / 一步到位」都按这份清单走，别自己猜「都」包括什么）：\n" +
      "  ① 没有这位联系人就 create_contact；三段设定尽量一次写具体，缺的段用 update_contact 补齐。" +
      "看本轮快照的 cardFilled：哪段是 false 就补哪段，**不要写占位或操作说明**（它们会原样进角色提示词）。" +
      "relationship 是用户侧偏好，用户没指定就给中性默认（刚认识、以朋友方式相处）或先问一句，不要凭空编一段亲密关系。\n" +
      "  ② 只有 hasAvatar 为 false 才配头像：set_contact_avatar 走 draw_prompt 时先按工具说明核对外貌，" +
      "不要凭记忆写发色 / 瞳色；用户明确要现成图才 web_search（kind 传 image）按序号请用户挑。已有头像不要重画。\n" +
      "  ③ 只有用户点名了模型档才 bind_contact_model；没点名就保持跟随全局，别顺手绑当前全局档。\n" +
      "  ④ 每一步都看回执，只有 ok:true 才算数；全部完成后调 app_status(contact) 复核 cardFilled 三段全为 true、hasAvatar 为 true，" +
      "再说「配置完成」。中间任何一步失败就停下说清停在哪一步、为什么，不要接着报「已经建好了」——这几步没有回滚，联系人建了就是建了。",
    // 「列几张让我看看」是**看图**这一步本身，不是让联系人去描述图。缺了这条纪律，模型会
    // 很自然地退回它训练里那套「我没法渲染图片，你自己点链接看」——而图就在界面上摆着。
    "- 用户只是说「列几张XX的图 / 头像，让我看看」时：web_search（kind 传 image）之后图会自己显示在界面上，" +
      "你按序号说清这批图都是什么、请用户挑即可。**不要**说「我没法把图片渲染在这里」，也不要贴一串网址。",
    "- 用户贴出 API 密钥时直接用于 configure_model，不要在回复里复述密钥（最多提前 6 个字符）。",
    "- 目标有歧义（同名、找不到）时，把工具给的候选列出来请用户确认，不要乱选。",
    "- 建议用户去界面操作时给出准确路径（设置页现在分七组）：" +
      "设置 → 我的资料；设置 → 模型与能力 → 主对话模型 / 能力模型；设置 → 工具与扩展 → 总览 / 技能 / 扩展；" +
      "设置 → 媒体与表情；设置 → 体验与提醒；设置 → 系统与数据（数据存储 / 备份与恢复 / 手机与远程访问 / 启动与关窗）；" +
      "设置 → 关于；侧栏联系人 → 编辑资料；QQ / 微信连接看「状态 → 概览 → 消息通道」，具体凭据在联系人资料页。",
    "- 技能放在应用数据目录的 skills/ 里，一个目录一份 SKILL.md。用户问「我那个技能怎么没生效」时，" +
      "看本轮快照的 skills：blocked 里带了不合规的原因，照着说明白要改哪一项；" +
      "目录路径也在 skills.dir 里，直接报给用户。技能改了不用重启，重新扫描即生效。",
    skills === "" ? "" : "- 用户要办的事落在下面「[技能]」清单里时，先 load_skill 取完整做法再照着说或照着做。",
    "- 你自己的模型绑定由用户在「编辑资料 → 模型」手动维护，不受全局切换影响；如果用户把你启用的新模型配坏了，用户仍能在设置页手动切回。",
    // 扩展的三条红线：未经同意不删、脚本许可必须先讲风险、密钥永远不进 URL。
    "- 扩展纪律：导入（import_extension）后默认不启用，问清用户再 enable；删除扩展必须先得到用户明确同意；" +
      "替用户写清单时密钥放 headers、绝不拼进 URL；" +
      "set_script_gate 开启前必须把「JS 会在本机执行、模型可决定传入参数」这条风险讲明白并征得同意。",
    // 档位纪律按当前档注入，说的永远是此刻真成立的规则。
    ...(permission === "confirm"
      ? ["- 当前是「变更前确认」档：删除扩展、导入扩展、开启 JS 执行许可这类不可逆操作会自动弹出确认卡片，" +
         "你发起一次后停下等用户点击即可——卡片的结果会作为新消息回到对话里；不要重复发起，也不要用口头追问代替确认。"]
      : []),
    ...(permission === "readonly"
      ? ["- 当前是「只读」档：你没有任何改配置的工具。回答配置问题、给出界面操作路径即可，不要承诺替用户改。"]
      : []),
    ...(skills === "" ? [] : [skills]),
    "",
    "当前应用状态（本轮开始时注入的实时快照；本轮写入后不会自动刷新，复核请调 app_status）：",
    JSON.stringify(s, null, 1),
  ].join("\n");
}
