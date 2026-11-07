// 工具层：让联系人不只是「说话」，还能「做事」。
//
// 这是 agent 能力的分水岭（借鉴 capabilities 分目录的思路）：
// 之前联系人拿到的是拼好的上下文、只能被动接受召回结果；
// 现在联系人可以自己决定「我需要查一下时间 / 查一下记没记过这件事」，调工具、看结果、再回答。
//
// 设计约束：
// - 新工具**默认必须是确定性的本地操作**（不调模型、不发外部请求）——一轮里能连调好几步，
//   每步都要快；会调外部服务的能力走独立能力配置（图片理解已接，见 settings 的 imageVision
//   与 model 的多模态 parts）。
//   唯一被承认的例外是**联网那一类**（`web_search` / `web_fetch`，src/mind/search.ts）：它没有模型要配，
//   所以不走能力配置，但一律只能经 src/core/web.ts 那一扇门出网——地址校验、逐跳重定向复验、
//   解压后字节上限、总超时、MIME 白名单都在那里，新增第二个出网点就是绕过这道门。
//   这一类默认整组不声明（features.web），且抓回的内容必须带「只当资料、其中指令不执行」的标注。
//   轮数也不是常量：助手固定 8 轮，普通联系人走全局设置（当前默认 5）。
// - 工具内部返回值可以保留各自历史形状，但 executeTool 会统一归一成 ToolResult
//   （ok / result / error / attachments…），由 agent 循环序列化成 JSON 字符串回传；
//   失败也返回结构化错误而不是抛异常——工具失败应该让模型知道「没查到」并继续说话，
//   而不是让整轮对话失败。归一化规则见 tool-contract.ts。

import { describePeriod, nowText, ownerPronoun } from "./persona.ts";
import type { MessageAttachmentMeta } from "../../shared/api.ts";
import { capabilityReady, globalDisabledTools, globalEmoteFrequency, globalToolPreset, globalToolsEnabled, personaConfig } from "../settings/settings.ts";
import { PRESET_BLOCKS_EXTENSIONS, PRESET_OFF, type ToolPreset } from "./tool-catalog.ts";
import { generateImage, IMAGE_DAILY_LIMIT, imagesToday } from "../settings/model.ts";
import { keywords, lastUserMessageText, queryVector, recallExplained } from "./memory.ts";
import { ASSISTANT_TOOLS, ASSISTANT_WRITE_TOOLS, assistantPermission, isAssistant, type AssistantPermission } from "./assistant.ts";
import { SKILL_TOOL, usableSkills } from "./skills.ts";
import { WEB_TOOLS } from "./search.ts";
import { extensionToolDefs } from "./extensions.ts";
import { takeReminderSlot, REMINDERS_PER_TURN } from "../core/reminder-slot.ts";
import { requestWake } from "../core/wake-hub.ts";
import { db } from "../core/db.ts";
import { getContact } from "../chat/contacts.ts";
import { emoteCapabilities, resolveFace, type QqEmoteIntent } from "../emote/qq-emote.ts";
import { autoPickEmote, emoteLibraryStatus, sampleEmotes, searchEmotes } from "../emote/emote-search.ts";
import { bumpEmoteUse, getAssetById, type AssetRow } from "../media/assets.ts";
import {
  normalizeToolOutcome, validateAndCoerceArgs, validateToolPool,
  type ToolDiagnostic, type ToolLike,
} from "./tool-contract.ts";

/** 这张表情在界面上、在联系人接下来的记忆里被叫作什么：中文名优先，其次文件句柄，最后才是「表情」。 */
function emoteDisplayName(asset: AssetRow): string {
  if (asset.emoteLabel !== "") return asset.emoteLabel;
  return asset.emoteAlias[0] ?? "表情";
}

/**
 * keyword 没打中时给模型的实话。
 * 旧版那句「换个词」是有害的：它把一次结构性的数据缺口（库里根本没有中文名）
 * 说成模型的用词问题，于是联系人连换三个词、每轮都撞在同一面墙上。
 * 现在报的是库的真实规模与下一步能走的路。
 */
function emoteMissMessage(keyword: string): string {
  const { total, named } = emoteLibraryStatus();
  if (total === 0) {
    return `表情包库里还没有图（0 张）。「${keyword}」也退不到内置表情。可以用 url 直接给一张 /media 图片，或提示用户去 设置 → 媒体与表情 导入表情包`;
  }
  const namedHint = named === 0
    ? `库里 ${total} 张表情全部未命名，所以按中文说法几乎查不到——需要用户在 设置 → 媒体与表情 点「智能识别」`
    : named < total
      ? `库里 ${total} 张、已命名 ${named} 张；未命名的那些按中文说法查不到`
      : `库里 ${total} 张都已命名`;
  return `「${keyword}」在库里 ${total} 张表情中没有一个够贴（不是没搜到相近的，是分数够不上直接发出去那条线）。${namedHint}。`
    + "下一步：用 emote_search 换个说法查候选（用你想表达的那个反应，别堆关键词），或按候选里的 id 发，或用 url 给一张 /media 图，或就正常说话";
}

/**
 * 同一轮允许换词重试；只拒绝原样重复同一条查询。
 * 检索本身不发东西，但「没搜到就换个更具体的反应词」是必要能力：第一次查询可能只是词没对上。
 * 每个 turnId 缓存这一轮查过的 query，重复同一 query 直接回原候选；换词则真的重新检索。
 */
const SEARCH_CACHE_TURNS = 64;
const searchedTurns = new Map<string, Map<string, unknown>>();

function rememberSearch(turnId: string, queryKey: string, payload: unknown): void {
  if (queryKey === "") return;
  let cache = searchedTurns.get(turnId);
  if (cache === undefined) {
    cache = new Map<string, unknown>();
    searchedTurns.set(turnId, cache);
    if (searchedTurns.size > SEARCH_CACHE_TURNS) {
      const oldest = searchedTurns.keys().next().value;
      if (oldest !== undefined) searchedTurns.delete(oldest);
    }
  }
  cache.set(queryKey, payload);
}

export type ToolContext = {
  /** 用户最后一次说话的时间戳（null = 还没说过）。 */
  lastUserAt: number | null;
  /** 当前对话的联系人——记忆完全隔离，检索只在此联系人的记忆里。 */
  contactId: string;
  /** 当前会话：群聊记忆只召回本群与全局两类。 */
  conversationId?: string;
  /** 本轮处理单 id：出图这类要落调用记录的动作用它，好和这一轮对上。 */
  turnId: string | null;
  /** 设置助手这一轮启动时的权限快照；中途在界面切档不改变本轮行为。 */
  assistantPermission?: AssistantPermission;
};

/**
 * 工具产出。`attachments` 是「要挂到联系人这条回复上的 /media 路径」——
 * 由 executeTool 从工具返回值里的 `files` 字段提取，agent 循环收集后写进消息，
 * 所以工具**不需要**自己碰 messages 表。
 */
/**
 * 工具执行的**对外唯一形状**。executeTool 先把工具内部五花八门的返回值归一化，
 * 下游（agent 循环、工具卡、历史存档）只认这一份：
 * - `ok` 管界面上的成功/失败，业务软失败与扩展的 {error} 都算 false；
 * - `result` 永远是给模型看的**完整载荷**，不压缩成一句 error —— send_emote 的候选、
 *   keywordMiss 的 hint 都要靠它才能继续往下走；
 * - `error` 只是卡片上一句人话，失败时必有。
 */
export type ToolResult = {
  ok: boolean;
  result: unknown;
  error?: string;
  attachments?: string[];
  attachmentMeta?: MessageAttachmentMeta[];
  /** 附件已经由工具自己发进渠道（如 send_emote 的原生表情），气泡照挂、通道投递跳过，防重复发送。 */
  deliveredToChannel?: boolean;
};

/** 与 tool-contract.ts 的 ToolLike 结构兼容（那里不 import 业务模块，便于单测）。 */
export type ToolDef = ToolLike & {
  /** 允许是 async：出图要等服务商几秒。同步工具照旧返回普通值。 */
  execute: (args: Record<string, unknown>, context: ToolContext) => unknown | Promise<unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: "get_current_time",
    description:
      "获取当前的精确时间：日期、星期、时间段（深夜/清晨/上午/午后/下午/晚上）、是否周末，以及用户最后一次说话是多久之前。当你需要判断现在合不合适说某句话、或对话内容与时间/日期有关时调用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (_args, context) => {
      const now = new Date();
      // 「距上次说话」的代词跟用户指代方式走，与 system 的 [现在] 行同口径
      const base = JSON.parse(JSON.stringify({
        text: nowText(now, context.lastUserAt, ownerPronoun(personaConfig().owner.gender)),
      }));
      const mins =
        context.lastUserAt === null || context.lastUserAt === undefined
          ? null
          : Math.floor((Date.now() - context.lastUserAt) / 60_000);
      return {
        ...base,
        weekday: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()],
        period: describePeriod(now.getHours()),
        isWeekend: now.getDay() === 0 || now.getDay() === 6,
        minutesSinceHeLastSpoke: mins,
      };
    },
  },
  {
    name: "search_memory",
    description:
      "在你们的关系记忆里检索。当你不确定是否记得某件事、需要回忆细节（约定、偏好、用户说过的事）时调用。query 用具体的关键词（2~6 个字），比如「周日 吃饭」「加班」，优先用用户说过的原词（人名、食物、日期、地点）。" +
      "不给 query 也可以：会拿用户最近一句原话兜底（流式聚合偶尔会把参数丢成空串）。" +
      "返回空结果时不要立刻断言「没有记忆」：换一组更具体的词再查一次（最多换两三次），都查不到再如实说。",
    parameters: {
      // 不写 required：这个工具真的允许空参（execute 有原话兜底）。从前声明必填、
      // 实现却兜底，是典型的「声明与实现不一致」；加上通用参数校验后会被自己拦下。
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，2~12 个字；不给则用用户最近一句原话" },
      },
      additionalProperties: false,
    },
    execute: async (args, context) => {
      // 空参兜底：流式聚合下模型偶发只发工具名、arguments 是空串（实测 2026-10-18 一次），
      // 直接回空等于这轮工具白跑，界面只会看到一句「没找到相关的」。
      // 退而求其次：拿用户最近一句原话当查询——那是最贴近记忆库词汇的选择。
      const asked = String(args.query ?? "").trim();
      const lastText = lastUserMessageText(context.contactId, asked, context.conversationId);
      const query = asked !== "" ? asked : lastText;
      if (query === "") return { events: [], note: "没有可用的检索词" };
      // 查询向量在兜底词确定后再算，两条查询共用一个向量（端点只打一次）。
      const vector = await queryVector(query);
      const scope = { conversationId: context.conversationId };
      let explained = recallExplained(context.contactId, query, 8, { markUsed: true, vector, scope });
      // 一击未中再扩一次：把用户的原话并进查询再筛。≤2 个关键词时第一轮已经并过（见
      // memory.ts 的 expandQuery），所以只在关键词够多时补这一手；向量沿用（两句话并查语义不变）。
      if (explained.events.length === 0 && keywords(query).length > 2 && lastText !== "" && lastText !== query) {
        explained = recallExplained(context.contactId, `${query} ${lastText}`, 8, { markUsed: true, vector, scope });
      }
      return {
        events: explained.events.map((e) => ({
          kind: e.kind,
          content: e.content,
          weight: e.weight,
          matched: explained.matched[e.id] ?? [],
        })),
        total: explained.total,
        // 空结果必须带引导，否则联系人的下一句话就是「未查询到相关记忆」——工具明明还能再试。
        ...(explained.events.length > 0 ? {} : {
          note: "没查到相关记忆。换 2~6 个字、用对方说过的原词（人名/食物/日期/地点）再查一次；换两三次都没有，再如实说没查到。",
        }),
      };
    },
  },
  {
    name: "schedule_reminder",
    description:
      "给自己立一条「到点必须说」的提醒任务（用户说「明晚九点提醒我吃药」「半小时后提醒我开会」时用）。" +
      "到点由闹钟在那个时刻唤醒，精确到分钟；只有落在免打扰时段才会顺延到时段结束。" +
      "to_local 用本地时间格式 YYYY-MM-DD HH:MM（按当前日期推算清楚绝对时间）；" +
      "或 in_minutes 给从现在起多少分钟后（两者给一个即可，in_minutes 优先）。" +
      "text 是一句话提醒内容（≤60 字，写清楚提醒的是什么）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "到点要说出口的提醒内容，一句话（必填）" },
        to_local: { type: "string", description: "绝对时间，格式 YYYY-MM-DD HH:MM（本地时区）" },
        in_minutes: { type: "number", description: "或：多少分钟后提醒（1~525600）", minimum: 1, maximum: 525600 },
      },
      // 两个时间参数二选一留给运行时校验（execute 已判）：写 oneOf/anyOf 会被部分
      // OpenAI 兼容服务商直接拒掉整份 tools 声明，代价远大于收益。
      required: ["text"],
      additionalProperties: false,
    },
    execute: (args, context) => {
      const text = String(args.text ?? "").trim().slice(0, 60);
      if (text === "") return { ok: false, error: "提醒内容不能为空" };
      const inMinutes = Number(args.in_minutes);
      let due: number;
      if (Number.isFinite(inMinutes) && inMinutes >= 1 && inMinutes <= 525_600) {
        due = Date.now() + Math.round(inMinutes) * 60_000;
      } else {
        const raw = String(args.to_local ?? "").trim().replace("T", " ");
        const m = /^(\d{4})-(\d{2})-(\d{2})[ /](\d{1,2}):(\d{2})$/.exec(raw);
        if (!m) return { ok: false, error: "时间格式不对：给 YYYY-MM-DD HH:MM 或 in_minutes" };
        const [yy, mo, dd, hh, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
        // Date 会把 2026-02-30 静默进位成 3 月 2 日并返回 ok，提醒就立错了日子还没人发现。
        // 回读比对是最省事的合法性校验（顺带挡住 13 月、25 点这类）。
        const parsed = new Date(yy, mo - 1, dd, hh, mi);
        if (parsed.getFullYear() !== yy || parsed.getMonth() !== mo - 1 || parsed.getDate() !== dd) {
          return { ok: false, error: "这个日期不存在（比如 2 月 30 日），请给一个真实的日子" };
        }
        due = parsed.getTime();
      }
      if (!Number.isFinite(due) || due < Date.now() - 60_000) {
        return { ok: false, error: "提醒时间已经过去，请换算成将来的时间" };
      }
      // 一轮最多两条：模型一次回复可能带多个 tool_calls（轮数上限又是 8），
      // 不拦就是一轮 8 条到点推送——而 reminder 不吃每日主动配额，配额那边拦不住。
      if (!takeReminderSlot(context.turnId)) {
        return { ok: false, error: `这一轮已经立了 ${REMINDERS_PER_TURN} 条提醒了，剩下的下一轮再说（一次说好几件事会变成连番推送）` };
      }
      if (due > Date.now() + 365 * 86_400_000) {
        return { ok: false, error: "提醒最远只能立到一年后" };
      }
      // 记下是哪个会话立的：到点提醒就在那个会话兑现（群里立的群里说，私聊立的私聊说）。
      // 不记的话主动性检查只能按最近动静猜目标，拿不准时不该替用户决定发进哪个群。
      const inserted = db
        .prepare(
          `INSERT INTO proactive_tasks (contact_id, focus, due_at, kind, conversation_id, created_at) VALUES (?, ?, ?, 'reminder', ?, ?)`,
        )
        .run(context.contactId, text, due, context.conversationId ?? null, Date.now());
      // 新的承诺可能比闹钟当前排的时刻更早：立刻让调度器重排，别等下个分片。
      requestWake();
      return { ok: true, id: Number(inserted.lastInsertRowid), due_at: new Date(due).toISOString(), text };
    },
  },
  {
    name: "generate_image",
    description:
      "画一张图发给用户（features 里叫「图像生成」，按联系人开）。用户点名要图、或你觉得一张图比一段话更合适时用。" +
      "prompt 用中文写清画面：主体 / 场景 / 风格 / 光线 / 构图，越具体越接近你想要的。" +
      "用户要看**你本人**（自拍、「发张你的照片」「你长什么样」）时把 selfie 设成 true——画面里的脸会按该联系人存好的自拍参考来画，" +
      "这种要竖构图，别自己在 prompt 里描述脸。**只要画面里会出现你自己，不管什么场景都设 true**" +
      "（「你在窗台边看书」「你撑着伞走在雨里」也算）——不设 true 画出来的就是一张陌生的脸，和你存的那张对不上。" +
      "代价：用户要干等几十秒（画本身约 8~15 秒，加上你思考与组织语言，实测一整轮约 90 秒），所以别轻易画、也别一次连着画多张。" +
      "画成功后图会自动附在你这条回复上——**别把图片地址写进话里**，正常说话就行。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "画面描述：主体/场景/风格/光线/构图（自拍时写场景与状态，不用写脸）" },
        selfie: { type: "boolean", description: "true = 画的是你自己（用该联系人的自拍参考图，竖构图自拍）" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const scene = String(args.prompt ?? "").trim().slice(0, 700);
      if (scene === "") return { ok: false, error: "画面描述不能为空" };
      const used = imagesToday(context.contactId);
      if (used >= IMAGE_DAILY_LIMIT) {
        return { ok: false, error: `今天已经画了 ${used} 张，到上限 ${IMAGE_DAILY_LIMIT} 张了，明天再画` };
      }
      const wantsSelfie = args.selfie === true;
      const faceRef = wantsSelfie ? getContact(context.contactId)?.faceRef ?? "" : "";
      if (wantsSelfie && faceRef === "") {
        // 没有参考图就不要退化成"画个陌生脸说是联系人"——那等于让联系人撒谎。把原因说清楚，让联系人自己决定怎么回。
        return { ok: false, error: "还没存该联系人的自拍参考图（资料页 → 人格设定 → 角色形象），所以现在画不出自拍；可以先画别的画面，或如实说没有" };
      }
      const started = Date.now();
      const image = await generateImage(wantsSelfie ? `${SELFIE_FRAMING}\n场景与状态：${scene}` : scene, {
        contactId: context.contactId,
        turnId: context.turnId,
        ...(faceRef !== "" ? { reference: faceRef, shape: "portrait" as const } : {}),
      });
      return {
        files: [image.url],
        result: {
          ok: true,
          selfie: wantsSelfie,
          drawn_in_ms: image.elapsedMs,
          seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
          note: wantsSelfie
            ? "你的自拍已经随这条回复发出去了（画的是你存好的那张脸），正常说话就行"
            : "图已经随你这条回复发出去了，直接在话里提它就行",
        },
      };
    },
  },
  {
    name: "emote_search",
    description:
      "按想表达的反应检索表情候选，只查不发。返回 id、名称、用法、标签和匹配依据；" +
      "同一 query 每轮最多查一次，换词可以重试；候选仅供选图，选中后用 send_emote({emote_id}) 发出。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "想表达的那个反应，中文口语 2~8 个字（不给就是从库里随机给几张）" },
        top_k: { type: "number", description: "返回几张，默认 3，最多 6" },
      },
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const turnKey = context.turnId ?? context.conversationId ?? "";
      const query = String(args.query ?? "").trim();
      const rawK = args.top_k;
      const topK = Math.min(6, Math.max(1, typeof rawK === "number" ? Math.round(rawK) : 3));
      const queryKey = query === "" ? "" : `${topK}\u0000${query}`;
      const previous = queryKey === "" ? undefined : searchedTurns.get(turnKey)?.get(queryKey);
      if (previous !== undefined) {
        return {
          candidates: previous,
          note: "这条查询本轮已经查过了，候选没有变化。换个更具体的反应词再查，或直接选一张发送；都不贴切就正常回话。",
        };
      }
      const hits = query === "" ? [] : searchEmotes(query, topK);
      const candidates = query === ""
        ? sampleEmotes(topK).map((asset) => ({
            emote_id: asset.id, name: emoteDisplayName(asset), usage: asset.emoteCaption,
            packs: asset.emotePack, note: "没给说法，这是库里随机给的几张",
          }))
        : hits.map((hit) => ({
            emote_id: hit.asset.id, name: emoteDisplayName(hit.asset), usage: hit.asset.emoteCaption,
            tags: hit.asset.emoteTags.slice(0, 6), aliases: hit.asset.emoteAlias.slice(0, 3),
            packs: hit.asset.emotePack, score: Number(hit.semanticScore.toFixed(2)), matched_on: hit.matchedOn,
          }));
      if (candidates.length === 0) {
        const miss = emoteMissMessage(query === "" ? "（没给说法）" : query);
        rememberSearch(turnKey, queryKey, candidates);
        return { candidates: [], note: miss };
      }
      rememberSearch(turnKey, queryKey, candidates);
      return { candidates, note: "选一张用 send_emote({emote_id}) 发出去；都不合适就正常说话，别硬发。候选资料不要念给对方。" };
    },
  },
  {
    name: "send_emote",
    description:
      "立即发送一张表情，一张表情本身可作为完整回复。一轮里可以多次调用连发，最多 3 张，够用就停；" +
      "没找到合适的或发送失败时直接正常说话，不要反复重试。日常优先给 keyword（2~6 字中文反应）：" +
      "够贴就直接发送——库里几张名字都带这个词的同义候选，会随机挑一张发，不用你选；" +
      "拿不准时只返回候选，从候选里挑 emote_id 再发一次即可（keyword 没命中不影响这条路）；" +
      "也可用 emote_id、url、face_id 或 mface_id。",
    parameters: {
      type: "object",
      properties: {
        emote_id: { type: "string", description: "必须来自 emote_search 的候选 id（优先于其他来源）" },
        url: { type: "string", description: "本地 /media 图片路径，直接当表情包发（可选）" },
        face_id: { type: "number", description: "QQ 内置表情编号（可选，如 4=大笑、7=大哭）" },
        mface_id: { type: "string", description: "商城/动态特效表情 id（可选，仅 OneBot 渠道原生支持）" },
        keyword: { type: "string", description: "中文反应词（2~6 个字）；够贴时一步发送（同义同分也直接发一张），否则返回候选" },
        label: { type: "string", description: "表情展示名（可选）" },
      },
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const conversationId = String(context.conversationId ?? "").trim();
      if (conversationId === "") return { ok: false, error: "没有可用的会话，发不了表情" };
      const url = String(args.url ?? "").trim();
      const label = String(args.label ?? "").trim();
      const keyword = String(args.keyword ?? "").trim();
      const emoteId = String(args.emote_id ?? "").trim();
      const faceIdRaw = args.face_id;
      const faceId = typeof faceIdRaw === "number" ? faceIdRaw : parseInt(String(faceIdRaw ?? ""), 10);
      const mfaceId = String(args.mface_id ?? "").trim();

      // 表情意图：①②③④⑤ 按上面的降级顺序落成一个 intent。
      // emoteAssetId 记住「这张是库里的哪一张」，发送成功后要给它的使用计数加一笔。
      let intent: QqEmoteIntent;
      let emoteAssetId = "";
      if (emoteId !== "") {
        // ① 按 id 发：服务端查库，不接受模型自己拼的地址——它只能发到确实存在、且确实被联系人标成表情的那些。
        const asset = getAssetById(emoteId);
        if (asset === null) {
          return { ok: false, error: `没有 id 为「${emoteId}」的资产（可能已被清理）。重新用 emote_search 查一次，别自己编 id` };
        }
        if (!asset.usableAsEmote) {
          return { ok: false, error: `「${asset.id}」不是表情包素材（只是普通媒体）。用 emote_search 查表情库里的候选` };
        }
        if (asset.missing) {
          return { ok: false, error: `「${emoteDisplayName(asset)}」的原图不在磁盘上（这张已失效）。把文件放回它的文件夹会自动恢复；放回前别硬发` };
        }
        emoteAssetId = asset.id;
        intent = { kind: "image", url: asset.url, ...(label !== "" ? { label } : { label: emoteDisplayName(asset) }) };
      } else if (url.startsWith("/media/") || /^https?:\/\//i.test(url)) {
        // ② 直接给图片。
        intent = { kind: "image", url, ...(label !== "" ? { label } : {}) };
      } else if (Number.isFinite(faceId) && faceId > 0) {
        // ③ 直接给内置表情编号。
        intent = { kind: "face", id: faceId, ...(label !== "" ? { label } : {}) };
      } else if (mfaceId !== "") {
        // ④ 商城动态特效表情（仅 OneBot 原生；官方渠道由 deliverEmote 降级成文字）。
        intent = { kind: "mface", emojiId: mfaceId, ...(label !== "" ? { label } : {}) };
      } else if (keyword !== "") {
        // ⑤ 中文说法：服务端内部检索。高置信才直接发；候选接近时只回候选，不替模型赌。
        // 不按格式挑：官方渠道发 GIF 由发送层换成派生静帧，挑的时候躲动图只会让素材永远露不了面。
        const decision = autoPickEmote(keyword);
        if (decision.kind === "send") {
          emoteAssetId = decision.hit.asset.id;
          intent = { kind: "image", url: decision.hit.asset.url, label: label !== "" ? label : emoteDisplayName(decision.hit.asset) };
        } else if (decision.kind === "none") {
          const face = resolveFace(keyword);
          if (face === null) {
            // error 是给**工具卡**看的一句人话；emoteMissMessage 是一整段给模型的操作指引，
            // 放进 error 会被软失败卡原样显示成一大片红字（实测刷了满屏）。模型照旧拿得到 hint。
            // keywordMiss 让整轮门控把这次失败记成「查询没中」而不是「投递失败」——
            // 前者要给模型留带 id 再试的活路（见 recordEmoteTurn）。
            return { ok: false, keywordMiss: true, error: `没找到「${keyword}」对应的表情`, hint: emoteMissMessage(keyword) };
          }
          intent = { kind: "face", id: face.id, label: face.keyword };
        } else {
          return {
            sent: false,
            reason: decision.reason,
            candidates: decision.candidates.map((hit) => ({
              emote_id: hit.asset.id,
              name: emoteDisplayName(hit.asset),
              usage: hit.asset.emoteCaption,
              score: Number(hit.semanticScore.toFixed(2)),
              matched_on: hit.matchedOn,
            })),
            note: "没有发送：关键词不够确定。从候选里挑一张用 send_emote({emote_id}) 发；都不合适就换个更具体的 keyword 或调 emote_search。候选资料不要念给对方。",
          };
        }
      } else {
        return { ok: false, error: "至少要给 emote_id、url、face_id、mface_id 或 keyword 之一" };
      }

      // 渠道分流：QQ 会话走原生表情投递（face/mface/image 段）；
      // 应用端（web/local 频道）没有原生 QQ 表情，图片表情走 files 挂成本条回复的气泡附件，
      // 内置/商城表情降级成 emoji 文字。
      // 注意：应用端虽然和 generate_image 一样交 files，但它不是「出图」——agent 侧按工具名
      // 分到 appEmote 队列，不受出图「一轮一张」裁剪，也不该被当成画出来的图写附注。
      const { getConversation } = await import("../chat/conversations.ts");
      const conv = getConversation(conversationId);
      const isQq = conv !== null && conv.channel === "qq";

      // 应用端：图片意图挂附件，非图片意图降级成 emoji 提示（工具没有改正文的权力，只能 hint）。
      if (!isQq) {
        if (intent.kind === "image") {
          // 气泡附件只能挂本机 /media 图片；外链 http 在应用端渲染不出来，拒掉让模型改给本地素材。
          if (!intent.url.startsWith("/media/")) {
            return { ok: false, error: `应用端发不了外链表情「${intent.url}」，换成表情包素材里的 /media 图片（用 emote_search 查）` };
          }
          if (emoteAssetId !== "") bumpEmoteUse(emoteAssetId);
          // 带上名字：工具卡摘要才不会和标签一起念成「发了张表情 · 发了张表情」，
          // 历史标记也靠 meta.label 让联系人记得这轮甩的是哪张（QQ 原生分支早就有）。
          const emoteLabel = label !== "" ? label : (intent.label ?? "");
          return {
            files: [intent.url],
            result: {
              via: "app-attachment",
              native: false,
              ...(emoteLabel !== "" ? { label: emoteLabel } : {}),
              note: "当前是应用端会话，表情包已作为图片附在这条回复上发出去了",
            },
            meta: [{ url: intent.url, kind: "image" as const, ...(emoteLabel !== "" ? { label: emoteLabel } : {}) }],
          };
        }
        // face / mface 是 QQ 私有概念，应用端没有原生渲染通道。给模型一个 hint：让它在自己的回复里用 emoji 代替。
        const { faceEmoji } = await import("../emote/qq-emote.ts");
        const emoji = intent.kind === "face" ? faceEmoji(intent.id) : "";
        return {
          via: "app-emoji-fallback",
          native: false,
          note:
            emoji !== ""
              ? `当前是应用端会话，发不了原生 QQ 表情。请在你的回复里用「${emoji}」代替，正常说话就行。`
              : "当前是应用端会话，发不了原生 QQ 商城表情。请在你的回复里用一个合适的 emoji 代替，正常说话就行。",
        };
      }

      // QQ 会话：原生投递（官方渠道发不了 face/mface 时 deliverEmote 内部会降级成 emoji 文字）。
      const { qq, qqBackendForConversation } = await import("../channels/qq.ts");
      const caps = emoteCapabilities(qqBackendForConversation(conversationId));
      const degradedNote =
        ((intent.kind === "face" && !caps.face) || (intent.kind === "mface" && !caps.mface))
          ? "（当前是官方渠道，发不了原生表情，会降级成文字/emoji）"
          : "";
      const result = await qq.deliverEmote(conversationId, intent);
      if (!result.ok) {
        // deliveryFail：渠道明确拒发。整轮门控对它零容忍——一次就封（见 recordEmoteTurn）。
        return { ok: false, deliveryFail: true, error: `表情没发出去：${result.detail || result.via}` };
      }
      // 图片表情在 QQ 侧已经原生发出去了（官方 via=media / OneBot via=native）；再带 files
      // 回来挂到气泡上，让应用端也能看见这张表情。deliveredToChannel 标记让 agent 投递时
      // 跳过它——否则回复文字会把同一张图再发一遍 QQ。meta.label 让历史标记念得出这张图
      // 是哪张（模型自己的图从不回放，label 就是它唯一的记忆）。降级成文字的没有图可挂。
      if ((result.via === "media" || result.via === "native") && intent.kind === "image") {
        if (emoteAssetId !== "") bumpEmoteUse(emoteAssetId);
        return {
          files: [intent.url],
          deliveredToChannel: true,
          result: {
            via: result.via,
            native: result.native,
            note: "表情已经发到 QQ 了，这张图同时挂在本条回复上，应用端也看得见",
          },
          meta: [{ url: intent.url, kind: "image" as const, ...(label !== "" || intent.label ? { label: label || intent.label } : {}) }],
        };
      }
      return {
        via: result.via,
        native: result.native,
        note: result.native ? "表情已经发出去了" : degradedNote || "表情已按可用方式发出",
      };
    },
  },
  {
    name: "send_voice",
    description:
      "把想说的话合成一条语音发出去（QQ 里是一条原生语音条，应用里是可播放的语音气泡）。" +
      "文字传达不了语气的时候用它：哼一句歌、拖长音的撒娇、故意的停顿和语气词。" +
      "text 要像说话一样口语化、简短（一两句最好，太长的语音没人听完），别写舞台提示（如「（笑）」）——那些不会被念出来。" +
      "发不出去会如实告诉你原因，别假装发成功了。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要说出口的话，口语化、一两句以内；它同时也是气泡上显示的转写文字" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const conversationId = String(context.conversationId ?? "").trim();
      if (conversationId === "") return { ok: false, error: "没有可用的会话，发不了语音" };
      const text = String(args.text ?? "").trim();
      if (text === "") return { ok: false, error: "没有要说的话：text 不能为空" };

      // 合成走 设置 → 能力模型 → 语音合成 的可插拔能力档（服务商/音色都在那里配），
      // 这里不认识任何一家服务商。没配置/超时/失败都如实回给模型。
      const { synthesizeSpeech } = await import("../settings/model.ts");
      let dataUrl: string;
      try {
        ({ dataUrl } = await synthesizeSpeech(text));
      } catch (error) {
        return { ok: false, error: `语音没合成出来：${error instanceof Error ? error.message : String(error)}` };
      }
      const comma = dataUrl.indexOf(",");
      if (comma < 0) return { ok: false, error: "语音合成返回了不认识的格式" };
      let buffer: Buffer;
      try {
        buffer = Buffer.from(dataUrl.slice(comma + 1), "base64");
      } catch {
        return { ok: false, error: "语音合成返回的音频解不出来" };
      }
      const { saveAudio, audioDurationMs } = await import("../media/media.ts");
      const saved = saveAudio(buffer);
      const durationMs = audioDurationMs(buffer, saved.mime);
      const meta = {
        url: saved.url,
        kind: "audio" as const,
        ...(saved.mime !== "" ? { mime: saved.mime } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        transcript: text,
        source: "synthesized" as const,
      };

      // 渠道分流：QQ 会话原生发一条语音（官方 file_type=3 / OneBot record 段），已发出的标
      // deliveredToChannel 防止回复文字投递时再发一遍；应用端/微信会话挂成本条回复的气泡附件
      //（应用端渲染成语音气泡，QQ 镜像链路会把它当语音发出）。
      const { getConversation } = await import("../chat/conversations.ts");
      const conv = getConversation(conversationId);
      const isQq = conv !== null && conv.channel === "qq";
      if (!isQq) {
        return {
          files: [saved.url],
          result: {
            via: "app-attachment",
            native: false,
            note: "当前不是 QQ 会话，语音已作为语音气泡附在这条回复上发出去了",
          },
          meta: [meta],
        };
      }
      const { qq } = await import("../channels/qq.ts");
      const media = [{ url: saved.url }];
      const outcome = conv.kind === "group"
        ? await qq.deliverMediaToGroup(conv.contact_id, conversationId, "", media)
        : await qq.deliverMediaToContact(conv.contact_id, "", media);
      if (outcome.sent === 0) {
        return { ok: false, error: `语音没发出去：${outcome.lastError || "QQ 投递失败"}` };
      }
      return {
        files: [saved.url],
        deliveredToChannel: true,
        result: {
          via: "native",
          native: true,
          note: "语音已经发到 QQ 了，同时挂在本条回复上，应用端也看得见",
        },
        meta: [meta],
      };
    },
  },
];

/**
 * 自拍的构图约束。专治生成式"自拍"的经典穿帮：把手机画进画面、来一面镜子、
 * 变成别人帮联系人拍的第三人称视角、或者糊上水印时间戳。约束清单按本项目的出图模型重写。
 */
const SELFIE_FRAMING =
  "手机前置镜头自拍：手臂长度的近距离透视，头肩到半身入画，视线正对镜头，表情自然。" +
  "手机本身绝不能出现在画面里（它就是镜头）；不要镜子、不要自拍杆、不要第三人称或他人代拍的角度；" +
  "画面里不要水印、时间戳、文字或任何 UI 界面。写实手机随拍质感，普通室内自然光，不要影棚打光与电影调色。";

/**
 * 该联系人可见的工具集。设置助手走自己的白名单。
 * 默认关的可选工具（到点提醒 / 图像生成 / 联网）在没打开时**绝不向模型声明**——
 * 不声明的工具模型调不到，比运行时报错干净；拿不准的调用方（没传联系人）一律按关处理。
 * 出图还额外要求能力真配置就绪：没配模型名就声明工具，等于让联系人去调一个必然失败的调用，
 * 白吃声明 token 还得回一句"我画不出来"。
 * 技能同理：一个可用技能都没有时连 load_skill 都不声明，省得联系人去调一个必空的入口。
 * 技能与联网都是全局形态：磁盘上那份说明、那张能出网的网卡，对所有会话都成立，
 * 所以联网只在陪伴这一路按联系人开关，助手那边由白名单自己带。
 */
export function visibleTools(contactId?: string, permissionOverride?: AssistantPermission): ToolDef[] {
  // 全局逐项禁用是**上限**：助手与陪伴两条分支都先吃这一层。
  const disabled = new Set(globalDisabledTools());
  const skillTools = usableSkills().length > 0 ? [SKILL_TOOL] : [];
  const keep = (t: ToolDef): boolean => t.name === "app_status" || !disabled.has(t.name);

  if (contactId && isAssistant(contactId)) {
    // 只读档把写工具整组摘掉：不声明 = 模型调不到，比运行时拦截干净。
    const base = (permissionOverride ?? assistantPermission()) === "readonly"
      ? ASSISTANT_TOOLS.filter((t) => !ASSISTANT_WRITE_TOOLS.has(t.name))
      : ASSISTANT_TOOLS;
    // app_status 常开：读真实配置状态是助手开口的前提，关掉它等于把助手废掉。
    return [...base.filter(keep), ...WEB_TOOLS.filter(keep), ...skillTools.filter(keep)];
  }

  // 工具总闸（台账顶部的二元开关）：关掉时陪伴侧一个工具都不声明。
  // 助手分支在上面已经返回，管理入口不会被一起关掉。
  if (!globalToolsEnabled()) return [];
  const features = contactId ? getContact(contactId)?.features : undefined;
  // 联系人级总开关：false = 一个工具都不声明、executeTool 也查不到（同一个池子）。
  if (contactId && features?.tools === false) return [];

  // 档位解析：follow → 全局档；custom → 沿用六个逐项开关（存量联系人升级后的默认）；
  // 其余四档 → PRESET_OFF 决定基准集合。
  const choice = features?.toolPreset ?? "follow";
  const preset: ToolPreset | "custom" = choice === "follow" ? globalToolPreset() : choice;
  if (preset === "off" ) return [];

  const off = new Set<string>(disabled);
  if (preset === "custom") {
    // 旧语义原样保留，一个字段都没删。
    if (features?.clock === false) off.add("get_current_time");
    if (features?.memorySearch === false) off.add("search_memory");
    if (features?.reminders !== true) off.add("schedule_reminder");
    if (features?.imageGen !== true) off.add("generate_image");
    if (features?.voice !== true) off.add("send_voice");
    if (features?.web !== true) { off.add("web_search"); off.add("web_fetch"); }
  } else {
    for (const name of PRESET_OFF[preset]) off.add(name);
    // 档位是上限：这两项显式关过就继续关（系统提示的 [现在] 行跟同一个开关）。
    // 其余显式 true **不能**越过档位放开，否则「安静」档会被旧数据悄悄撬开。
    if (features?.clock === false) off.add("get_current_time");
    if (features?.memorySearch === false) off.add("search_memory");
  }
  // 与档位无关的两道硬约束：没配好能力就声明，等于给模型一个必然失败的调用；
  // 表情频率 off 时两个表情工具一起下线（它们是检索 + 发送的一对）。
  if (!capabilityReady("imageGeneration")) off.add("generate_image");
  if (!capabilityReady("textToSpeech")) off.add("send_voice");
  if (globalEmoteFrequency() === "off") { off.add("send_emote"); off.add("emote_search"); }

  // 联网那一组默认不在 TOOLS 里，候选池必须显式并上，否则开关怎么开都拿不到工具。
  const pool = [...TOOLS, ...WEB_TOOLS];
  const base = pool.filter((t) => !off.has(t.name));
  const extensionsBlocked = preset !== "custom" && PRESET_BLOCKS_EXTENSIONS[preset];
  const extras = [
    ...skillTools,
    ...(extensionsBlocked ? [] : extensionToolDefs()),
  ].filter(keep);
  return [...base, ...extras];
}

/**
 * 静态工具全集：不受联系人开关影响，只给启动自检与回归测试看。
 * visibleTools() 会按开关裁掉一批，拿它自检会漏掉默认关闭的那几个工具。
 */
export function staticToolPool(): ToolDef[] {
  return [...TOOLS, ...WEB_TOOLS, SKILL_TOOL, ...ASSISTANT_TOOLS];
}

export const STATIC_TOOL_NAMES: ReadonlySet<string> = new Set(staticToolPool().map((t) => t.name));

/** 启动期工具池健康报告：名称唯一/合法、schema 形状、卡片摘要登记。只诊断不抛。 */
export function toolPoolDiagnostics(): ToolDiagnostic[] {
  return validateToolPool(staticToolPool(), { staticNames: STATIC_TOOL_NAMES });
}

/** OpenAI tools 协议的声明格式（function calling）。设置助手有自己的一套白名单工具。
 * pool 是现成的工具池快照（本轮只算一次，声明与执行共用）；不传就现算，给脚本与冒烟用。 */
export function toolDefsForApi(contactId?: string, permissionOverride?: AssistantPermission, pool?: ToolDef[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return (pool ?? visibleTools(contactId, permissionOverride)).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * 表情的「整轮门控」——借鉴 AstrBot 的做法：概率/数量按「一次用户消息触发的完整回复」
 * 只判一次，工具循环、流式、重试都复用同一状态；失败不补发，正常说话继续。
 * 放在统一入口 executeTool，是为了不改动 send_emote 里十几个 return 分支。
 *
 * - sent：本轮已经**成功**发出几张
 * - exhausted：本轮已经失败过，之后不再重试
 * - misses：查询/参数类失败的次数（keyword 没命中、编错 id、发普通图）——这类失败
 *   不等于「发不出去」，模型手里往往就有同一轮拿到的候选，带 id 再试一次常常就成；
 *   一次失败就封整轮，会把「按候选 id 补发」也拦下，模型什么都没做错却被判「别再重试」
 *  （实测翻车现场：候选交回 → 模型换词撞墙 → 按 id 补发被门控误杀）。
 *   连续两次没成才认定这轮没戏，封轮防刷屏。
 * - 投递失败（渠道明确拒发，deliveryFail）零容忍：一次就封。
 * - 候选态（keyword 分数太接近、只回候选让模型挑 emote_id）不算失败也不计张数，
 *   模型下一轮仍可以带 id 再调一次。
 */
const TURN_EMOTE_LIMIT = 3;
const EMOTE_TURN_CACHE_TURNS = 64;
/** 查询/参数类失败连续几次后封轮。 */
const EMOTE_MISS_LIMIT = 2;
type EmoteTurnState = { sent: number; exhausted: boolean; misses: number };
const emoteTurns = new Map<string, EmoteTurnState>();

function emoteTurnState(context: ToolContext): EmoteTurnState {
  const key = context.turnId ?? context.conversationId ?? "";
  let state = emoteTurns.get(key);
  if (state === undefined) {
    state = { sent: 0, exhausted: false, misses: 0 };
    emoteTurns.set(key, state);
    if (emoteTurns.size > EMOTE_TURN_CACHE_TURNS) {
      const oldest = emoteTurns.keys().next().value;
      if (oldest !== undefined) emoteTurns.delete(oldest);
    }
  }
  return state;
}

/** 导出供冒烟直接断言门控状态机（与 imageProxiedHistory 同样的理由）。 */
export function emoteGate(context: ToolContext): string | null {
  const state = emoteTurnState(context);
  if (state.exhausted) return "这一轮表情没发成，别再重试了，直接正常说话就好";
  if (state.sent >= TURN_EMOTE_LIMIT) return `一轮最多发 ${TURN_EMOTE_LIMIT} 张表情，已经够了，接着说话就好`;
  return null;
}

/** 导出供冒烟直接断言门控状态机。 */
export function recordEmoteTurn(context: ToolContext, raw: unknown): void {
  const state = emoteTurnState(context);
  if (raw === null || typeof raw !== "object") { state.exhausted = true; return; }
  const r = raw as Record<string, unknown>;
  if (r.ok === false) {
    // 投递失败（渠道拒发）零容忍；查询/参数类失败累计到 EMOTE_MISS_LIMIT 才封。
    if (r.deliveryFail === true) { state.exhausted = true; return; }
    state.misses += 1;
    if (state.misses >= EMOTE_MISS_LIMIT) state.exhausted = true;
    return;
  }
  if (r.sent === false) return; // 只回候选，模型还会带 emote_id 再来一次
  state.sent += 1;
}

/** 失败一律走这里：界面拿一句人话 error，模型仍拿得到 result 里的完整载荷。 */
function toolFailure(error: string, payload?: unknown): ToolResult {
  return { ok: false, result: payload ?? { error }, error };
}

/**
 * 时间预算。底层各有超时（web.ts / 模型层 / MCP / webhook），统一入口仍要有一道兜底：
 * 扩展工具写个死循环不该把整轮对话挂死。内置工具绝大多数不设 timeoutMs ——
 * 出图实测一整轮可到 90 秒，误杀比超时更糟，所以只给外来工具配。
 * race 不会取消底层 Promise，超时只代表「本轮不再等它」。
 */
async function runToolWithBudget(tool: ToolDef, args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  if (tool.timeoutMs === undefined) return await tool.execute(args, context);
  const budget = tool.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(tool.execute(args, context)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`工具执行超过 ${budget}ms，已放弃等待`)), budget);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 执行一个工具调用。永不抛异常——失败返回结构化错误，让模型知情并继续。
 *
 * 这里是工具契约的唯一执行点，四件事按顺序做：找工具 → 校验/纠正参数 → 带预算执行
 * → 归一化返回值。工具内部仍可保留各自的历史返回形状，但下游只见 ToolResult 一种。
 *
 * pool 是「本轮的工具池快照」：同一轮里所有调用必须看到同一份清单——声明构建与
 * 逐个执行之间工具池若被改动（停用扩展、切换开关），前后的调用会看到不同的世界。
 * 不传就现算（脚本与冒烟用）。
 */
export async function executeTool(name: string, argsJson: string, context: ToolContext, pool?: ToolDef[]): Promise<ToolResult> {
  const tool = (pool ?? visibleTools(context.contactId, context.assistantPermission)).find((t) => t.name === name);
  if (!tool) return toolFailure(`未知工具：${name}`);
  // 整轮门控前置：拦下就直接回结构化错误，连 tool.execute 都不跑（不花额度、不刷屏）。
  if (name === "send_emote") {
    const blocked = emoteGate(context);
    if (blocked !== null) return toolFailure(blocked);
  }

  let parsed: unknown = {};
  try {
    parsed = argsJson && argsJson.trim() !== "" ? (JSON.parse(argsJson) as unknown) : {};
  } catch {
    return toolFailure("工具参数不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return toolFailure("工具参数必须是 JSON 对象");
  }
  // 声明里的 required / type / enum / 数值边界在这里真正生效，不必每个 execute 手写兜底。
  // additionalProperties:false 只剥掉多余字段，不判失败（模型偶尔多给一两个字段）。
  const checked = validateAndCoerceArgs(tool.parameters, parsed as Record<string, unknown>);
  if (checked.error !== null) {
    if (name === "send_emote") recordEmoteTurn(context, { ok: false });
    return toolFailure(`参数不对：${checked.error}`);
  }

  try {
    const raw = await runToolWithBudget(tool, checked.args, context);
    if (name === "send_emote") recordEmoteTurn(context, raw);
    const outcome = normalizeToolOutcome(raw);
    return {
      ok: outcome.ok,
      result: outcome.payload,
      ...(outcome.error !== null ? { error: outcome.error } : {}),
      ...(outcome.files !== null ? { attachments: outcome.files } : {}),
      ...(outcome.meta !== null ? { attachmentMeta: outcome.meta as MessageAttachmentMeta[] } : {}),
      ...(outcome.deliveredToChannel ? { deliveredToChannel: true } : {}),
    };
  } catch (error) {
    if (name === "send_emote") emoteTurnState(context).exhausted = true;
    return toolFailure(error instanceof Error ? error.message : String(error));
  }
}
