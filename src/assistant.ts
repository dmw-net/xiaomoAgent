// 内置「设置助手」：一个保留联系人 + 一组白名单配置工具。
//
// 设计（借鉴参考产品的内置软件助手，按其思路做了适合单机应用的裁剪）：
// - 固定会话：id="assistant" 的保留联系人，不走陪伴人设、不抽记忆、不主动发言；
// - 每轮注入实时产品状态（密钥永不出快照），助手基于真实配置回答而不是猜；
// - 所有写操作走登记白名单工具：只有工具明确返回成功才允许宣称完成；
// - 目标有歧义（同名联系人/档）时工具返回候选清单，让助手先跟用户确认。

import { activateProfile,
  capabilitiesStatus,
  activeProfileId,
  capabilityReady,
  listProfiles,
  modelConfig,
  saveProfile,
} from "./settings.ts";
import { ASSISTANT_CONTACT_ID, createContact, getContact, listContacts, updateContact, type Contact } from "./contacts.ts";
import { skillCatalogSection, skillsStatus } from "./skills.ts";
import { downloadImageToMedia, describeWebFailure } from "./search.ts";
import { generateImage } from "./model.ts";
import { mediaUrlExists, releaseMediaFiles } from "./media.ts";
import { db, kvGet, kvSet, withTx } from "./db.ts";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "./tools.ts";

export { ASSISTANT_CONTACT_ID };
export const ASSISTANT_CONTACT_NAME = "设置助手";

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
  // 消息与图片走清空那条路：它负责回收本轮里那些 /media（从前这里是裸 DELETE，
  // 图片只靠 24 小时后的全量对账兜着——删了工作区，磁盘要过一天才真的还回来）。
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

/** 启动时确保保留联系人存在（幂等；已存在不覆盖用户改过的资料）。 */
export function ensureAssistantContact(): void {
  if (getContact(ASSISTANT_CONTACT_ID)) return;
  createContact({
    id: ASSISTANT_CONTACT_ID,
    name: ASSISTANT_CONTACT_NAME,
    card: {
      name: ASSISTANT_CONTACT_NAME,
      identity: "我是小茉应用的内置设置助手：帮你接入模型、创建和配置联系人、排查能力设置。",
      background: "我运行在应用内部，能读取真实配置状态并直接执行配置操作。",
    },
  });
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

function statusSnapshot(): Record<string, unknown> {
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
    profiles: listProfiles().map((p) => ({
      id: p.id, label: p.label, name: p.name, baseUrl: p.baseUrl, active: p.id === aid,
    })),
    contacts: contacts.map((c) => ({
      id: c.id, name: c.name, modelProfile: c.model_profile || "",
      cardFilled: { background: c.card.background !== "", identity: c.card.identity !== "", relationship: c.card.relationship !== "" },
    })),
    capabilitiesReady: capabilitiesStatus(),
    // 技能是磁盘上的外部文件，坏掉的形态五花八门（缺文件、名字不合法、正文超长）。
    // 快照里带上 blocked 的原因，用户问「我那个技能怎么没生效」时她能答上来，
    // 而不是只会说"我没看到技能"把人送去重启。
    skills: skillsStatus(),
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
 * 头肩居中、方图、脸是画面主体——她会被显示在 32~48px 的圆里，全身构图进去就是一团糊。
 */
const AVATAR_FRAMING =
  "人物头像：方形构图，头肩到胸口入画，脸部为画面主体并居中，视线看向镜头。" +
  "背景简洁不抢主体；画面里不要文字、水印、签名、边框或任何 UI。单人居中，不要出现第二个人。";

export const ASSISTANT_TOOLS: ToolDef[] = [
  {
    name: "app_status",
    description:
      "读取小茉应用当前的真实配置状态：生效模型（不含密钥）、模型档列表、联系人列表与各自的模型绑定、图片/语音能力是否就绪。回答任何与配置相关的问题或动手改配置之前，先调用它拿事实，不要凭记忆猜。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => statusSnapshot(),
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
      "创建一个新联系人。用户说「帮我建一个XX」时调用；background/identity/relationship 三个设定可以先给一句合理的占位描述，让用户之后在「编辑资料」里细化。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "联系人名字，≤20 字" },
        background: { type: "string", description: "背景设定（可选）" },
        identity: { type: "string", description: "人设（可选）" },
        relationship: { type: "string", description: "与用户的关系（可选）" },
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
      const created = createContact({ name, card });
      return { ok: true, contactId: created.id, name: created.name, note: "已创建。设定可以在侧栏「编辑资料」里继续细化" };
    },
  },
  {
    name: "update_contact",
    description:
      "修改已有联系人的设定文本（background/identity/relationship/name 任传其一或多项，只覆盖传了的字段）。contact 传名字或 id。",
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
      const updated = updateContact(r.contact.id, patch as Parameters<typeof updateContact>[1]);
      return { ok: true, contactId: r.contact.id, name: updated?.name ?? r.contact.name, updatedFields: Object.keys({ ...patch, ...card }) };
    },
  },
  {
    name: "set_contact_avatar",
    description:
      "给某位联系人设头像。image_url 与 draw_prompt 二选一：\n" +
      "· image_url：抓一张现成的图。可以给网图地址（配合 web_search 的结果用；原图也行，不再受内联体积限制），" +
      "也可以是应用里已有的 /media 路径（比如 web_search 图片结果里的 preview——用户挑中的那张就是它，" +
      "本来就是本地文件、不用再下一遍；或者她刚画出来的那张画）。\n" +
      "· draw_prompt：让她画一张。给一句画面描述即可（角色是谁、什么气质、发色衣着），构图由程序补。\n" +
      "两种来源最后都落成本地 /media 文件，图不再依赖外部站点，也不会因为对方换域名而裂图。\n" +
      "用户说「给XX换个头像」「建一个XX并配好头像」时，先确认这位联系人存在（不存在先 create_contact），再设。",
    parameters: {
      type: "object",
      properties: {
        contact: { type: "string", description: "联系人名字或 id" },
        image_url: { type: "string", description: "http(s) 图片地址，或应用里已有的 /media 路径" },
        page_url: { type: "string", description: "可选：图所在页面，个别站点按来源页防盗链时才用得上" },
        draw_prompt: { type: "string", description: "或：让她画一张头像，给一句画面描述" },
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
      "给某个联系人单独绑定一个模型档（该联系人的对话与记忆用它来跑）。model 传空字符串表示解除绑定、回到跟随全局默认。",
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
        return { ok: true, contact: r.contact.name, bound: null, note: "已解除绑定，回到跟随全局默认" };
      }
      const p = resolveProfile(model);
      if (!p.id) return { ok: false, error: p.error };
      updateContact(r.contact.id, { modelProfile: p.id });
      return { ok: true, contact: r.contact.name, bound: p.label, note: "该联系人的对话已改用这个模型" };
    },
  },
];

/** 助手的系统提示词：身份 + 纪律 + 每轮注入的实时状态。 */
export function buildAssistantSystemPrompt(): string {
  const s = statusSnapshot();
  const skills = skillCatalogSection();
  return [
    "你是「小茉」应用内置的设置助手，不是陪伴角色。说话简洁、专业、友好，用中文。",
    "你能做的事：接入/切换模型、创建与配置联系人、给联系人绑定模型与头像、排查图片/语音能力的配置问题、排查技能目录。",
    "纪律：",
    "- 动手改配置前先调 app_status 拿真实状态；改完后如果合适再拿一次确认结果。",
    "- 只有工具返回 ok:true 才能说操作成功；失败就原样说明原因和下一步建议。",
    // 一句话建好一个带头像的角色是**多步流水**：这类活最容易在中间某步失败后仍然往下说，
    // 所以把顺序与"每步看回执"写死在这里，而不是指望模型自己安排。
    "- 用户要「建一个XX并配好角色和头像」时按这个顺序走：create_contact（可带人设三段）→ " +
      "配头像走 set_contact_avatar：要用现成的图就先 web_search（kind 传 image）——" +
      "搜到的图会直接显示在界面上，你只要按序号请用户挑（别把地址念给他），他说第几张就用那一条的 preview 传进去；" +
      "想让她自己画一张就直接传 draw_prompt。抓来的图会先存成本地文件再设，不依赖外部站点长期可用。" +
      "每一步都要看它的回执，中间任何一步失败就停下来把话说清停在哪一步、为什么，" +
      "不要接着往下报「已经建好了」——这几步没有回滚，联系人建了就是建了。",
    // 「列几张让我看看」是**看图**这一步本身，不是让她去描述图。缺了这条纪律，模型会
    // 很自然地退回它训练里那套「我没法渲染图片，你自己点链接看」——而图就在界面上摆着。
    "- 用户只是说「列几张XX的图 / 头像，让我看看」时：web_search（kind 传 image）之后图会自己显示在界面上，" +
      "你按序号说清这批图都是什么、请他挑即可。**不要**说「我没法把图片渲染在这里」，也不要贴一串网址。",
    "- 用户贴出 API 密钥时直接用于 configure_model，不要在回复里复述密钥（最多提前 6 个字符）。",
    "- 目标有歧义（同名、找不到）时，把工具给的候选列出来请用户确认，不要乱选。",
    "- 建议用户去界面操作时给出准确路径：设置 → 主模型接入 / 能力模型 / 技能；侧栏联系人 → 编辑资料。",
    "- 技能放在应用数据目录的 skills/ 里，一个目录一份 SKILL.md。用户问「我那个技能怎么没生效」时，" +
      "看 app_status 返回的 skills：blocked 里带了不合规的原因，照着说明白要改哪一项；" +
      "目录路径也在 skills.dir 里，直接报给用户。技能改了不用重启，重新扫描即生效。",
    skills === "" ? "" : "- 用户要办的事落在下面「[技能]」清单里时，先 load_skill 取完整做法再照着说或照着做。",
    "- 你自己的模型绑定由用户在「编辑资料 → 模型」手动维护，不受全局切换影响；如果用户把你启用的新模型配坏了，他仍能在设置页手动切回。",
    ...(skills === "" ? [] : [skills]),
    "",
    "当前应用状态（本轮实时快照）：",
    JSON.stringify(s, null, 1),
  ].join("\n");
}
