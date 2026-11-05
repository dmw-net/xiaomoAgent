// 路由共享的领域辅助：联系人/会话解析、设置快照、头像展示映射、模型补丁净化。
//
// 这些函数被多个领域模块共用（strictContactId 全表 30+ 处、snapshotResponse 8+ 处），
// 收在这里保证「一处改、处处同步」；领域模块只 import 自己用到的那部分，
// 业务动作（saveProfile/validateModel/…）仍直接从 settings.ts 等域模块取，不从这里转手。

import type { ServerResponse } from "node:http";
import {
  THINKING_LEVELS,
  modelConfig,
  modelReadyNow,
  onboardingDone,
  providerLabel,
  sanitizeModelCaps,
  sanitizeThinkingMode,
  sanitizeThinkingParam,
  settingsSnapshot,
  defaultPersona,
  type ModelSettings,
} from "../settings/settings.ts";
import {
  DEFAULT_CONTACT_ID,
  ASSISTANT_CONTACT_ID,
  defaultPersonaIsDefault,
  getContact,
} from "../chat/contacts.ts";
import { isAssistantThreadContactId } from "../mind/assistant.ts";
import { contactModelSettings } from "../settings/model.ts";
import { ensureLocalConversation, getConversation } from "../chat/conversations.ts";
import { SettingsBodyError, sendJson } from "./http.ts";
import type { MessageAttachmentMeta } from "../../shared/api.ts";
import { MAX_CHAT_IMAGES } from "../../shared/limits.ts";
import { mediaTypeOfUrl } from "../media/media.ts";

/** 从 query 取联系人：不存在或没传一律回落默认联系人（无状态 API，前端负责记住当前选中）。
 *  助手工作区的派生 id（assistant:<线程>）不是联系人，按注册表放行。 */
export function currentContactId(url: URL): string {
  const requested = url.searchParams.get("contactId");
  if (!requested) return DEFAULT_CONTACT_ID;
  if (getContact(requested) || isAssistantThreadContactId(requested)) return requested;
  return DEFAULT_CONTACT_ID;
}

/**
 * 严格版联系人解析：未知 id 直接 404，不静默回落。
 * localStorage 里的陈旧 id（联系人已删除）拿到「另一个人的数据」比报错危险得多——
 * 与消息路由的 `404 联系人不存在` 保持同一语义。
 * 返回 null 表示响应已发完，调用方直接 return false（这条路由没接住，继续往后试）。
 */
export function strictContactId(url: URL, response: ServerResponse): string | null {
  const requested = url.searchParams.get("contactId");
  if (!requested) return DEFAULT_CONTACT_ID;
  if (getContact(requested) || isAssistantThreadContactId(requested)) return requested;
  sendJson(response, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在，可能已被删除" });
  return null;
}

/** 当前联系人的思考控制面：只暴露聊天快捷切换真正需要的最小信息。 */
export function modelThinkingControl(contactId: string): Record<string, unknown> {
  const settings = contactModelSettings(contactId) ?? modelConfig();
  const supported = settings.thinkingLevels.length > 0
    ? settings.thinkingLevels
    : THINKING_LEVELS.map((item) => item.id);
  const levels = [...new Set<string>([
    ...supported,
    ...(settings.thinkingLevel === "" ? [] : [settings.thinkingLevel]),
  ])] as ModelSettings["thinkingLevels"];
  const effort = settings.thinkingParam === "effort" && settings.caps.thinking;
  const switchable = settings.caps.thinking && (!effort || levels.length > 0);
  return {
    model: settings.name,
    provider: providerLabel(settings.baseUrl),
    // 生效档的工具硬闸状态：资料页「工具」卡用它提示「总开关开了也没用」的情形。
    tools: settings.caps.tools === true,
    thinking: {
      // 强度形态和纯开关形态都值得在聊天里暴露；开关型不再被 UI 整体隐藏。
      switchable,
      param: settings.thinkingParam,
      mode: settings.thinkingMode,
      off: settings.thinkingMode === "off",
      level: settings.thinkingLevel,
      levels: effort ? levels : [],
    },
  };
}

/** settingsSnapshot + 三个高频派生字段：原先 8 处响应样板收成一个口。 */
export function snapshotResponse(): Record<string, unknown> {
  return {
    ...settingsSnapshot(),
    /** 密钥是否已配置——前端用它决定要不要提示"请填密钥"，而不是看到掩码瞎猜。 */
    hasKey: modelConfig().apiKey !== "",
    modelReady: modelReadyNow(),
    /** 首次设置走完没有（没走完时界面留着那张清单）。 */
    onboardingDone: onboardingDone(),
    /** 默认联系人的人设还是出厂那份（首启引导据此决定要不要问「改改人设」那一步）。
     *  比较的是**真正生效的那份**：聊天吃的是 contacts.card，不是 settings.persona.character。 */
    personaIsDefault: defaultPersonaIsDefault(),
  };
}

/**
 * 内置联系人没自己设过头像时，各回一张出厂默认图（库里始终存空串，只有发给界面时才换成静态路径；
 * 用户换成自己的图照旧覆盖）。小茉 → /xiaomo.png，设置助手 → /assistant.png。
 *
 * 为什么不把默认头像内联成 dataURL 存进库里：会话列表是几秒一轮的轮询，那份几十 KB 的图会变成
 * 每轮多带几十 KB——刚把列表压回 KB 级，不该又顶回去。静态路径由 Vite 拷进 dist 根、白名单路由发出。
 *
 * 与「应用图标」的分工：/icon.png（花朵气泡）仍是任务栏 / favicon / 关于页那一份；小茉头像已从
 * 应用图标解耦出来单独用 /xiaomo.png，花朵图另存一份 /assistant.png 给助手当默认头像。
 */
export function avatarForDisplay(contact: { id: string; avatar: string }): string {
  if (contact.avatar !== "") return contact.avatar;
  if (contact.id === DEFAULT_CONTACT_ID) return "/xiaomo.png";
  if (contact.id === ASSISTANT_CONTACT_ID) return "/assistant.png";
  return contact.avatar;
}

/** 侧栏预览只展示人能读懂的最近内容，内部指令与动作标签不直接裸露。 */
export function humanPreview(text: string): string {
  const cleaned = String(text ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[-*#]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const withoutMeta = cleaned.replace(/^\[[^\]]{2,100}\]\s*/, "").trim();
  if (withoutMeta === "" || /^(系统指令|系统提示|工具调用|技能已|已收到系统)/.test(withoutMeta)) {
    return "有新消息，打开看看";
  }
  return withoutMeta;
}

/**
 * 只接受与 attachments 中真实存在的 URL 对应的元信息。
 * 语音时长/波形/转写都来自浏览器，属于展示数据；这里做边界收敛，避免把任意 JSON 落库。
 */
export function normalizeAttachmentMeta(raw: unknown, attachments: string[]): MessageAttachmentMeta[] {
  if (!Array.isArray(raw) || attachments.length === 0) return [];
  const allowed = new Set(attachments);
  const out: MessageAttachmentMeta[] = [];
  for (const item of raw.slice(0, MAX_CHAT_IMAGES)) {
    if (item === null || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const url = typeof v.url === "string" ? v.url : "";
    if (!allowed.has(url)) continue;
    const actualKind = mediaTypeOfUrl(url);
    const requested = v.kind === "image" || v.kind === "video" || v.kind === "audio" || v.kind === "file" ? v.kind : actualKind;
    const kind = actualKind === "file" ? requested : actualKind;
    const durationMs = typeof v.durationMs === "number" && Number.isFinite(v.durationMs)
      ? Math.min(120_000, Math.max(0, Math.round(v.durationMs))) : undefined;
    const transcript = typeof v.transcript === "string" ? v.transcript.trim().slice(0, 4000) : undefined;
    const waveform = Array.isArray(v.waveform)
      ? v.waveform.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
          .slice(0, 64).map((n) => Math.min(1, Math.max(0, n)))
      : undefined;
    out.push({
      url, kind,
      ...(typeof v.mime === "string" ? { mime: v.mime.slice(0, 100) } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(transcript ? { transcript } : {}),
      ...(waveform && waveform.length > 0 ? { waveform } : {}),
      ...(v.source === "recorded" || v.source === "synthesized" ? { source: v.source } : {}),
    });
  }
  return out;
}

/**
 * 把请求体里的模型补丁收窄成允许改的字段。
 * 白名单写法：前端多传什么都不会被存进库——这是防"客户端塞任意字段污染配置"的基本功。
 * 「额外参数不是合法 JSON」仍抛 SettingsBodyError：最外层把它转成 400（是输入问题不是服务端故障）。
 */
export function normalizeModelPatch(input: { [K in keyof ModelSettings]?: unknown }): Partial<ModelSettings> {
  const patch: Partial<ModelSettings> = {};

  if (typeof input.mode === "string") patch.mode = input.mode === "openai" ? "openai" : "echo";
  if (typeof input.baseUrl === "string") patch.baseUrl = input.baseUrl.trim();
  if (typeof input.name === "string") patch.name = input.name.trim();
  if (typeof input.startupCheck === "boolean") patch.startupCheck = input.startupCheck;

  // 能力元数据（勾选组/思考强度/token 上限）：一律过 settings 侧的净化器，脏字段静默丢弃。
  if (input.caps !== undefined) patch.caps = sanitizeModelCaps(input.caps);
  if (input.thinkingLevel !== undefined) {
    const lvl = typeof input.thinkingLevel === "string" && THINKING_LEVELS.some((l) => l.id === input.thinkingLevel)
      ? input.thinkingLevel
      : "";
    patch.thinkingLevel = lvl as ModelSettings["thinkingLevel"];
  }
  // 思考参数形态与开关意图：和档位保存那条路共用同一份净化器，不再各写一份字面量
  if (input.thinkingParam !== undefined) patch.thinkingParam = sanitizeThinkingParam(input.thinkingParam);
  if (input.thinkingMode !== undefined) patch.thinkingMode = sanitizeThinkingMode(input.thinkingMode);
  if (Array.isArray(input.thinkingLevels)) {
    patch.thinkingLevels = input.thinkingLevels.filter(
      (x): x is ModelSettings["thinkingLevels"][number] =>
        typeof x === "string" && THINKING_LEVELS.some((l) => l.id === x),
    );
  }
  if (input.maxInputTokens !== undefined) {
    const n = Number(input.maxInputTokens);
    patch.maxInputTokens = Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.trunc(n) : 0;
  }
  if (input.maxOutputTokens !== undefined) {
    const n = Number(input.maxOutputTokens);
    patch.maxOutputTokens = Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.trunc(n) : 0;
  }

  if (input.timeoutMs !== undefined) {
    const n = Number(input.timeoutMs);
    if (Number.isFinite(n)) patch.timeoutMs = Math.trunc(n);
  }

  if (input.extraBody !== undefined) {
    if (typeof input.extraBody === "string") {
      // 前端用文本框编辑 JSON，这里负责解析成人话错误。
      const raw = input.extraBody.trim();
      if (raw === "") patch.extraBody = {};
      else {
        try {
          const parsed = JSON.parse(raw) as unknown;
          patch.extraBody =
            parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
        } catch {
          patch.extraBody = undefined;
          throw new SettingsBodyError("额外参数不是合法 JSON");
        }
      }
    } else if (input.extraBody !== null && typeof input.extraBody === "object") {
      patch.extraBody = input.extraBody as Record<string, unknown>;
    }
  }

  // 密钥特例：掩码表示"没改"，空串表示"清掉"，其它才是真新密钥。
  if (typeof input.apiKey === "string") {
    const key = input.apiKey.trim();
    if (!key.includes("••")) patch.apiKey = key;
  }

  return patch;
}

/** 只挑字符串字段，其余一律忽略。 */
export function pickStrings(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** 出厂那份角色卡：真源在后端 defaultPersona()，前端不抄一份（抄一份迟早跟提示词那边漂移）。 */
export function defaultCardForResponse(): { card: Record<string, string> } {
  const { identity, background, relationship } = defaultPersona().character;
  return { card: { identity, background, relationship } };
}

/**
 * 严格版会话解析：query 里的 conversationId 必须真实存在且属于该联系人，否则 404。
 * 空串 = 该联系人的本地主会话（缺省语义）。返回 null 表示响应已发完。
 */
export function strictConversationId(url: URL, response: ServerResponse, contactId: string): string | null {
  const raw = (url.searchParams.get("conversationId") ?? "").trim();
  if (raw === "") return ensureLocalConversation(contactId).id;
  const conv = getConversation(raw);
  if (conv === null || conv.contact_id !== contactId) {
    sendJson(response, 404, { ok: false, code: "CONVERSATION_NOT_FOUND", error: "会话不存在或不属于当前联系人" });
    return null;
  }
  return conv.id;
}
