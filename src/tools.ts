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
import type { MessageAttachmentMeta } from "../shared/api.ts";
import { capabilityReady, personaConfig } from "./settings.ts";
import { generateImage, IMAGE_DAILY_LIMIT, imagesToday } from "./model.ts";
import { keywords, lastUserMessageText, queryVector, recallExplained } from "./memory.ts";
import { ASSISTANT_TOOLS, ASSISTANT_WRITE_TOOLS, assistantPermission, isAssistant, type AssistantPermission } from "./assistant.ts";
import { SKILL_TOOL, usableSkills } from "./skills.ts";
import { WEB_TOOLS } from "./search.ts";
import { extensionToolDefs } from "./extensions.ts";
import { takeReminderSlot, REMINDERS_PER_TURN } from "./proactive.ts";
import { db } from "./db.ts";
import { getContact } from "./contacts.ts";
import { emoteCapabilities, pickEmoteByKeyword, resolveFace, type QqEmoteIntent } from "./qq-emote.ts";

export type ToolContext = {
  /** 他最后一次说话的时间戳（null = 还没说过）。 */
  lastUserAt: number | null;
  /** 当前对话的联系人——记忆完全隔离，检索只在此联系人的记忆里。 */
  contactId: string;
  /** 当前会话：群聊记忆只召回本群/当前成员/全局三类。 */
  conversationId?: string;
  /** 群发言成员 openid；私聊为空。 */
  memberId?: string;
  /** 本轮处理单 id：出图这类要落调用记录的动作用它，好和这一轮对上。 */
  turnId: string | null;
  /** 设置助手这一轮启动时的权限快照；中途在界面切档不改变本轮行为。 */
  assistantPermission?: AssistantPermission;
};

/**
 * 工具产出。`attachments` 是「要挂到她这条回复上的 /media 路径」——
 * 由 executeTool 从工具返回值里的 `files` 字段提取，agent 循环收集后写进消息，
 * 所以工具**不需要**自己碰 messages 表。
 */
export type ToolResult = { ok: true; result: unknown; attachments?: string[]; attachmentMeta?: MessageAttachmentMeta[]; /** 附件已经由工具自己发进渠道（如 send_emote 的原生表情），气泡照挂、通道投递跳过，防重复发送。 */ deliveredToChannel?: boolean } | { ok: false; error: string };

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
      "在你们的关系记忆里检索。当你不确定是否记得某件事、需要回忆细节（约定、偏好、他说过的事）时调用。query 用具体的关键词（2~6 个字），比如「周日 吃饭」「加班」，优先用对方说过的原词（人名、食物、日期、地点）。" +
      "返回空结果时不要立刻断言「没有记忆」：换一组更具体的词再查一次（最多换两三次），都查不到再如实说。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，2~12 个字" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      // 空参兜底：流式聚合下模型偶发只发工具名、arguments 是空串（实测 2026-10-18 一次），
      // 直接回空等于这轮工具白跑，界面只会看到一句「没找到相关的」。
      // 退而求其次：拿他最近一句原话当查询——那是最贴近记忆库词汇的选择。
      const asked = String(args.query ?? "").trim();
      const lastText = lastUserMessageText(context.contactId, asked, context.conversationId);
      const query = asked !== "" ? asked : lastText;
      if (query === "") return { events: [], note: "没有可用的检索词" };
      // 查询向量在兜底词确定后再算，两条查询共用一个向量（端点只打一次）。
      const vector = await queryVector(query);
      const scope = { conversationId: context.conversationId, memberId: context.memberId };
      let explained = recallExplained(context.contactId, query, 8, { markUsed: true, vector, scope });
      // 一击未中再扩一次：把他的原话并进查询再筛。≤2 个关键词时第一轮已经并过（见
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
        // 空结果必须带引导，否则她的下一句话就是「未查询到相关记忆」——工具明明还能再试。
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
      "他要看**你本人**（自拍、「发张你的照片」「你长什么样」）时把 selfie 设成 true——画面里的脸会按你存好的自拍参考来画，" +
      "这种要竖构图，别自己在 prompt 里描述脸。**只要画面里会出现你自己，不管什么场景都设 true**" +
      "（「你在窗台边看书」「你撑着伞走在雨里」也算）——不设 true 画出来的就是一张陌生的脸，和你存的那张对不上。" +
      "代价：他要干等几十秒（画本身约 8~15 秒，加上你思考与组织语言，实测一整轮约 90 秒），所以别轻易画、也别一次连着画多张。" +
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
        // 没有参考图就不要退化成"画个陌生脸说是她"——那等于让她撒谎。把原因说清楚，让她自己决定怎么回。
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
    name: "send_emote",
    description:
      "发一个表情给他（表情包）。比一段话更轻、更贴气氛，用来反应、接梗、表示态度时优先用它。" +
      "用法优先级：①url（一张本地 /media 图片直接当表情发，两条渠道都最稳）；②face_id（QQ 内置表情编号，如 4=大笑，官方渠道会降级成 emoji）；" +
      "③mface_id（商城动态特效表情，仅 OneBot 渠道支持，官方渠道降级成文字）；④keyword（如「笑死」「赞」「哭」，先查表情包素材库、再查内置表情）。" +
      "表情会**立刻随这条对话发出去**，不用你再画一张图。发不出去会如实告诉你原因，别假装发成功了。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "本地 /media 图片路径，直接当表情包发（可选，优先级最高）" },
        face_id: { type: "number", description: "QQ 内置表情编号（可选，如 4=大笑、7=大哭）" },
        mface_id: { type: "string", description: "商城/动态特效表情 id（可选，仅 OneBot 渠道原生支持）" },
        keyword: { type: "string", description: "表情关键词（2~6 个字），如「笑死」「赞」「哭」，命中表情包素材或内置表情" },
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
      const faceIdRaw = args.face_id;
      const faceId = typeof faceIdRaw === "number" ? faceIdRaw : parseInt(String(faceIdRaw ?? ""), 10);
      const mfaceId = String(args.mface_id ?? "").trim();

      // ① 直接给图片 → image 意图（两渠道都稳，优先级最高）。
      let intent: QqEmoteIntent;
      if (url.startsWith("/media/") || /^https?:\/\//i.test(url)) {
        intent = { kind: "image", url, ...(label !== "" ? { label } : {}) };
      } else if (Number.isFinite(faceId) && faceId > 0) {
        // ② 直接给内置表情编号。
        intent = { kind: "face", id: faceId, ...(label !== "" ? { label } : {}) };
      } else if (mfaceId !== "") {
        // ③ 商城动态特效表情（仅 OneBot 原生；官方渠道由 deliverEmote 降级成文字）。
        intent = { kind: "mface", emojiId: mfaceId, ...(label !== "" ? { label } : {}) };
      } else if (keyword !== "") {
        // ④ 关键词：先表情包素材库（图片，最稳），命中就发图片；否则回退内置 face。
        // 官方渠道静态图优先：官方 C2C 富媒体不认 GIF（850019），素材命中多张时先挑 png/jpg。
        const asset = pickEmoteByKeyword(keyword, { preferStatic: emoteCapabilities().backend === "official" });
        if (asset !== null) {
          intent = { kind: "image", url: asset.url, label: asset.label || keyword };
        } else {
          const face = resolveFace(keyword);
          if (face === null) {
            return {
              ok: false,
              error: `找不到「${keyword}」对应的表情：素材库没有、内置表情也没这个词。换个词，或直接给我一张 /media 图片路径`,
            };
          }
          intent = { kind: "face", id: face.id, label: face.keyword };
        }
      } else {
        return { ok: false, error: "至少要给 url、face_id、mface_id 或 keyword 之一" };
      }

      // 渠道分流：QQ 会话走原生表情投递（face/mface/image 段）；
      // 应用端（web/local 频道）没有原生 QQ 表情，图片表情走 files 挂成本条回复的气泡附件
      // （跟 generate_image 出图同一条路），内置/商城表情降级成 emoji 文字。
      const { getConversation } = await import("./conversations.ts");
      const conv = getConversation(conversationId);
      const isQq = conv !== null && conv.channel === "qq";

      // 应用端：图片意图挂附件，非图片意图降级成 emoji 提示（工具没有改正文的权力，只能 hint）。
      if (!isQq) {
        if (intent.kind === "image") {
          // 气泡附件只能挂本机 /media 图片；外链 http 在应用端渲染不出来，拒掉让模型改给本地素材。
          if (!intent.url.startsWith("/media/")) {
            return { ok: false, error: `应用端发不了外链表情「${intent.url}」，换成表情包素材里的 /media 图片（用 keyword 查或让模型给本地路径）` };
          }
          return {
            files: [intent.url],
            result: {
              via: "app-attachment",
              native: false,
              note: "当前是应用端会话，表情包已作为图片附在这条回复上发出去了",
            },
          };
        }
        // face / mface 是 QQ 私有概念，应用端没有原生渲染通道。给模型一个 hint：让它在自己的回复里用 emoji 代替。
        const { faceEmoji } = await import("./qq-emote.ts");
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
      const caps = emoteCapabilities();
      const degradedNote =
        ((intent.kind === "face" && !caps.face) || (intent.kind === "mface" && !caps.mface))
          ? "（当前是官方渠道，发不了原生表情，会降级成文字/emoji）"
          : "";
      const { qq } = await import("./qq.ts");
      const result = await qq.deliverEmote(conversationId, intent);
      if (!result.ok) {
        return { ok: false, error: `表情没发出去：${result.detail || result.via}` };
      }
      // 图片表情在 QQ 侧已经原生发出去了（官方 via=media / OneBot via=native）；再带 files
      // 回来挂到气泡上，让应用端也能看见这张表情。deliveredToChannel 标记让 agent 投递时
      // 跳过它——否则回复文字会把同一张图再发一遍 QQ。meta.label 让历史标记念得出这张图
      // 是哪张（模型自己的图从不回放，label 就是它唯一的记忆）。降级成文字的没有图可挂。
      if ((result.via === "media" || result.via === "native") && intent.kind === "image") {
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
      const { synthesizeSpeech } = await import("./model.ts");
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
      const { saveAudio, audioDurationMs } = await import("./media.ts");
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
      const { getConversation } = await import("./conversations.ts");
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
      const { qq } = await import("./qq.ts");
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
function visibleTools(contactId?: string, permissionOverride?: AssistantPermission): ToolDef[] {
  const skillTools = usableSkills().length > 0 ? [SKILL_TOOL] : [];
  if (contactId && isAssistant(contactId)) {
    // 只读档把写工具整组摘掉：不声明 = 模型调不到，比运行时拦截干净。
    const base = (permissionOverride ?? assistantPermission()) === "readonly"
      ? ASSISTANT_TOOLS.filter((t) => !ASSISTANT_WRITE_TOOLS.has(t.name))
      : ASSISTANT_TOOLS;
    return [...base, ...WEB_TOOLS, ...skillTools];
  }
  const features = contactId ? getContact(contactId)?.features : undefined;
  // 联系人级总开关（资料页「工具」卡的第一行）：false = 连工具声明都不进请求、
  // executeTool 也查不到（同一个池子），这位联系人彻底没有「手」。默认开是历史行为。
  if (contactId && features?.tools === false) return [];
  const off = new Set<string>();
  // 看时间 / 翻记忆：默认开（历史行为），资料页可按联系人单独关。
  // 关 = 连工具声明都摘掉（模型调不到）；系统提示词的 [现在] 行由 persona.ts 按同一开关 gating。
  if (features?.clock === false) off.add("get_current_time");
  if (features?.memorySearch === false) off.add("search_memory");
  if (features?.reminders !== true) off.add("schedule_reminder");
  if (features?.imageGen !== true || !capabilityReady("imageGeneration")) off.add("generate_image");
  // 表情包：默认关（QQ 通道能力 + 性格开关），只有这位联系人明确开了才声明 send_emote。
  if (features?.emotes !== true) off.add("send_emote");
  // 发语音：默认关（TTS 秒级外部调用 + 性格开关），且语音合成的能力档没配好时自动消失。
  if (features?.voice !== true || !capabilityReady("textToSpeech")) off.add("send_voice");
  if (features?.web !== true) { off.add("web_search"); off.add("web_fetch"); }
  // 联网那一组不在 TOOLS 里（它默认整组不声明，只有开关打开才进来），所以候选池要显式并上它。
  // 少并一次的结果是 off.add 在过滤一个池子里根本不存在的名字——开关怎么开都拿不到工具，
  // 而这条只有「打开档」的断言能抓到（关闭档看起来一样绿）。
  const pool = [...TOOLS, ...WEB_TOOLS];
  const base = off.size === 0 ? pool : pool.filter((t) => !off.has(t.name));
  // 扩展工具（MCP / webhook / JS）跟在最后：名字自带 mcp__/ext__ 前缀，不会与内置撞名；
  // 联系人工具总开关在上面已经 return [] 了，脚本许可未开时 extensions 也不产出 script 工具，
  // 这里不用再筛一遍。
  return [...base, ...skillTools, ...extensionToolDefs()];
}

/** OpenAI tools 协议的声明格式（function calling）。设置助手有自己的一套白名单工具。 */
export function toolDefsForApi(contactId?: string, permissionOverride?: AssistantPermission): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return visibleTools(contactId, permissionOverride).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** 执行一个工具调用。永不抛异常——失败返回结构化错误，让模型知情并继续。 */
export async function executeTool(name: string, argsJson: string, context: ToolContext): Promise<ToolResult> {
  const tool = visibleTools(context.contactId, context.assistantPermission).find((t) => t.name === name);
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
      const produced = raw as { files: unknown[]; result: unknown; deliveredToChannel?: unknown; meta?: unknown };
      const urls = produced.files.filter((f): f is string => typeof f === "string" && f.startsWith("/media/"));
      if (urls.length === 0) return { ok: true, result: produced.result };
      const metas = Array.isArray(produced.meta)
        ? (produced.meta as MessageAttachmentMeta[]).filter((m): m is MessageAttachmentMeta =>
            m !== null && typeof m === "object" && typeof (m as { url?: unknown }).url === "string")
        : undefined;
      return produced.deliveredToChannel === true
        ? { ok: true, result: produced.result, attachments: urls, ...(metas !== undefined && metas.length > 0 ? { attachmentMeta: metas } : {}), deliveredToChannel: true }
        : { ok: true, result: produced.result, attachments: urls, ...(metas !== undefined && metas.length > 0 ? { attachmentMeta: metas } : {}) };
    }
    return { ok: true, result: raw };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
