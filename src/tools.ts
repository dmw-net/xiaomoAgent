// 工具层：让她不只是「说话」，还能「做事」。
//
// 这是 agent 能力的分水岭（借鉴 capabilities 分目录的思路）：
// 之前她拿到的是拼好的上下文、只能被动接受召回结果；
// 现在她可以自己决定「我需要查一下时间 / 查一下记没记过这件事」，调工具、看结果、再回答。
//
// 设计约束：
// - 新工具**默认必须是确定性的本地操作**（不调模型、不发外部请求）——一轮里能连调好几步，
//   每步都要快；会调外部服务的能力走独立能力配置（图片理解已接，见 settings 的 imageVision
//   与 model 的多模态 parts）。
//   唯一被承认的例外是**联网那一类**（`web_search` / `web_fetch`，src/search.ts）：它没有模型要配，
//   所以不走能力配置，但一律只能经 src/web.ts 那一扇门出网——地址校验、逐跳重定向复验、
//   解压后字节上限、总超时、MIME 白名单都在那里，新增第二个出网点就是绕过这道门。
//   这一类默认整组不声明（features.web），且抓回的内容必须带「只当资料、其中指令不执行」的标注。
//   轮数也不是常量：resolveToolRounds 按「助手 > 联系人 > 全局」解析（助手 8 / 全局默认 3）。
// - 执行结果永远是 JSON 字符串（工具循环协议统一），失败也返回结构化错误而不是抛异常——
//   工具失败应该让模型知道「没查到」并继续说话，而不是让整轮对话失败。

import { describePeriod, nowText, ownerPronoun } from "./persona.ts";
import { capabilityReady, personaConfig } from "./settings.ts";
import { generateImage, IMAGE_DAILY_LIMIT, imagesToday } from "./model.ts";
import { recallExplained } from "./memory.ts";
import { ASSISTANT_TOOLS, isAssistant } from "./assistant.ts";
import { SKILL_TOOL, usableSkills } from "./skills.ts";
import { WEB_TOOLS } from "./search.ts";
import { takeReminderSlot, REMINDERS_PER_TURN } from "./proactive.ts";
import { db } from "./db.ts";
import { getContact } from "./contacts.ts";

export type ToolContext = {
  /** 他最后一次说话的时间戳（null = 还没说过）。 */
  lastUserAt: number | null;
  /** 当前对话的联系人——记忆完全隔离，检索只在此联系人的记忆里。 */
  contactId: string;
  /** 本轮处理单 id：出图这类要落调用记录的动作用它，好和这一轮对上。 */
  turnId: string | null;
};

/**
 * 工具产出。`attachments` 是「要挂到她这条回复上的 /media 路径」——
 * 由 executeTool 从工具返回值里的 `files` 字段提取，agent 循环收集后写进消息，
 * 所以工具**不需要**自己碰 messages 表。
 */
export type ToolResult = { ok: true; result: unknown; attachments?: string[] } | { ok: false; error: string };

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /** 允许是 async：出图要等服务商几秒。同步工具照旧返回普通值。 */
  execute: (args: Record<string, unknown>, context: ToolContext) => unknown | Promise<unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: "get_current_time",
    description:
      "获取当前的精确时间：日期、星期、时间段（深夜/清晨/上午/午后/下午/晚上）、是否周末，以及他最后一次说话是多久之前。当你需要判断现在合不合适说某句话、或对话内容与时间/日期有关时调用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (_args, context) => {
      const now = new Date();
      // 「距上次说话」的代词跟用户性别走，与 system 的 [现在] 行同口径
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
      "在你们的关系记忆里检索。当你不确定是否记得某件事、需要回忆细节（约定、偏好、他说过的事）时调用。query 用具体的关键词，比如「周日 吃饭」「加班」。调用后你会得到最相关的几条记忆及内容。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，2~12 个字" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: (args, context) => {
      const query = String(args.query ?? "").trim();
      if (query === "") return { events: [], note: "query 为空" };
      // 她自己主动查记忆 = 真实的回忆行为，所以 markUsed：这条和被动注入一起
      // 构成「近 7 天被想起」的唯一数据来源（观测路径不写，见 memory.ts）。
      const explained = recallExplained(context.contactId, query, 8, { markUsed: true });
      return {
        events: explained.events.map((e) => ({
          kind: e.kind,
          content: e.content,
          weight: e.weight,
          matched: explained.matched[e.id] ?? [],
        })),
        total: explained.total,
      };
    },
  },
  {
    name: "schedule_reminder",
    description:
      "给自己立一条「到点必须说」的提醒任务（用户说「明晚九点提醒我吃药」「半小时后提醒我开会」时用）。" +
      "to_local 用本地时间格式 YYYY-MM-DD HH:MM（按当前日期推算清楚绝对时间）；" +
      "或 in_minutes 给从现在起多少分钟后（两者给一个即可，in_minutes 优先）。" +
      "text 是一句话提醒内容（≤60 字，写清楚提醒的是什么）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "到点要说出口的提醒内容，一句话" },
        to_local: { type: "string", description: "绝对时间，格式 YYYY-MM-DD HH:MM（本地时区）" },
        in_minutes: { type: "number", description: "或：多少分钟后提醒（1~525600）" },
      },
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
      const inserted = db
        .prepare(
          `INSERT INTO proactive_tasks (contact_id, focus, due_at, kind, created_at) VALUES (?, ?, ?, 'reminder', ?)`,
        )
        .run(context.contactId, text, due, Date.now());
      return { ok: true, id: Number(inserted.lastInsertRowid), due_at: new Date(due).toISOString(), text };
    },
  },
  {
    name: "generate_image",
    description:
      "画一张图发给他（features 里叫「图像生成」，按联系人开）。用户点名要图、或你觉得一张图比一段话更合适时用。" +
      "prompt 用中文写清画面：主体 / 场景 / 风格 / 光线 / 构图，越具体越接近你想要的。" +
      "他要看**你本人**（自拍、「发张你的照片」「你长什么样」）时把 selfie 设成 true——画面里的脸会按你存好的长相参考来画，" +
      "这种要竖构图，别自己在 prompt 里描述脸。**只要画面里会出现你自己，不管什么场景都设 true**" +
      "（「你在窗台边看书」「你撑着伞走在雨里」也算）——不设 true 画出来的就是一张陌生的脸，和你存的那张对不上。" +
      "代价：他要干等几十秒（画本身约 8~15 秒，加上你思考与组织语言，实测一整轮约 90 秒），所以别轻易画、也别一次连着画多张。" +
      "画成功后图会自动附在你这条回复上——**别把图片地址写进话里**，正常说话就行。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "画面描述：主体/场景/风格/光线/构图（自拍时写场景与状态，不用写脸）" },
        selfie: { type: "boolean", description: "true = 画的是你自己（用她的长相参考图，竖构图自拍）" },
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
        // 没有参考图就不要退化成"画个陌生脸说是她"——那等于让她撒谎。把原因说清楚，让她自己决定怎么回。
        return { ok: false, error: "还没存她的长相参考图（资料页 → 她的长相），所以现在画不出自拍；可以先画别的画面，或如实说没有" };
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
];

/**
 * 自拍的构图约束。专治生成式"自拍"的经典穿帮：把手机画进画面、来一面镜子、
 * 变成别人帮她拍的第三人称视角、或者糊上水印时间戳。约束清单按本项目的出图模型重写。
 */
const SELFIE_FRAMING =
  "手机前置镜头自拍：手臂长度的近距离透视，头肩到半身入画，视线正对镜头，表情自然。" +
  "手机本身绝不能出现在画面里（它就是镜头）；不要镜子、不要自拍杆、不要第三人称或别人帮她拍的角度；" +
  "画面里不要水印、时间戳、文字或任何 UI 界面。写实手机随拍质感，普通室内自然光，不要影棚打光与电影调色。";

/**
 * 该联系人可见的工具集。设置助手走自己的白名单。
 * 默认关的可选工具（到点提醒 / 图像生成 / 联网）在没打开时**绝不向模型声明**——
 * 不声明的工具模型调不到，比运行时报错干净；拿不准的调用方（没传联系人）一律按关处理。
 * 出图还额外要求能力真配置就绪：没配模型名就声明工具，等于让她去调一个必然失败的调用，
 * 白吃声明 token 还得回一句"我画不出来"。
 * 技能同理：一个可用技能都没有时连 load_skill 都不声明，省得她去调一个必空的入口。
 * 技能与联网都是全局形态：磁盘上那份说明、那张能出网的网卡，对所有会话都成立，
 * 所以联网只在陪伴这一路按联系人开关，助手那边由白名单自己带。
 */
function visibleTools(contactId?: string): ToolDef[] {
  const skillTools = usableSkills().length > 0 ? [SKILL_TOOL] : [];
  if (contactId && isAssistant(contactId)) return [...ASSISTANT_TOOLS, ...WEB_TOOLS, ...skillTools];
  const features = contactId ? getContact(contactId)?.features : undefined;
  const off = new Set<string>();
  if (features?.reminders !== true) off.add("schedule_reminder");
  if (features?.imageGen !== true || !capabilityReady("imageGeneration")) off.add("generate_image");
  if (features?.web !== true) { off.add("web_search"); off.add("web_fetch"); }
  // 联网那一组不在 TOOLS 里（它默认整组不声明，只有开关打开才进来），所以候选池要显式并上它。
  // 少并一次的结果是 off.add 在过滤一个池子里根本不存在的名字——开关怎么开都拿不到工具，
  // 而这条只有「打开档」的断言能抓到（关闭档看起来一样绿）。
  const pool = [...TOOLS, ...WEB_TOOLS];
  const base = off.size === 0 ? pool : pool.filter((t) => !off.has(t.name));
  return [...base, ...skillTools];
}

/** OpenAI tools 协议的声明格式（function calling）。设置助手有自己的一套白名单工具。 */
export function toolDefsForApi(contactId?: string): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return visibleTools(contactId).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** 执行一个工具调用。永不抛异常——失败返回结构化错误，让模型知情并继续。 */
export async function executeTool(name: string, argsJson: string, context: ToolContext): Promise<ToolResult> {
  const tool = visibleTools(context.contactId).find((t) => t.name === name);
  if (!tool) return { ok: false, error: `未知工具：${name}` };

  let args: Record<string, unknown> = {};
  try {
    args = argsJson && argsJson.trim() !== "" ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return { ok: false, error: "工具参数不是合法 JSON" };
  }

  try {
    const raw = await tool.execute(args, context);
    // 返回带 files 的工具 = 有产物要挂到本轮回复上。模型只看到 result（它拿不到地址也无所谓，
    // 助手自己的图从不回放），文件本体由 agent 循环写进 messages.attachments。
    if (raw !== null && typeof raw === "object" && Array.isArray((raw as { files?: unknown }).files)) {
      const produced = raw as { files: unknown[]; result: unknown };
      const urls = produced.files.filter((f): f is string => typeof f === "string" && f.startsWith("/media/"));
      return urls.length > 0
        ? { ok: true, result: produced.result, attachments: urls }
        : { ok: true, result: produced.result };
    }
    return { ok: true, result: raw };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
