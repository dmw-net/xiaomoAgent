// 设置域：角色卡快照读写、模型配置档（收藏/应用/试连/删除）、供应商、能力端点档、
// 提示词预览、模型思考开关。
//
// ⚠️ 本模块的路由**不是**一个连续块：原 handle() 里它们与其它域交错排布
// （/api/model/ping 在日志之后、/api/capabilities 在技能之前、思考开关在上下文用量之后、
// 能力测试在媒体上传之前、预览在会话列表之前）。router.ts 的有序总表按原顺序引用这里的
// 各个命名路由——本文件只负责定义，不负责排布。

import {
  activateCapabilityProfile,
  activateProfile,
  CAPABILITY_LABELS,
  CAPABILITY_NAMES,
  capabilityActiveId,
  capabilityConfig,
  capabilitiesStatus,
  capabilityReady,
  deleteCapabilityProfile,
  saveCapabilityProfile,
  deleteProfile,
  contactsBoundToProfile,
  listProfiles,
  modelConfig,
  personaConfig,
  providerLabel,
  renameProvider,
  resetAll,
  saveProfile,
  setOnboardingDone,
  syncProviderConnection,
  updateModel,
  updatePersona,
  validateCapabilityProfile,
  validateModel,
  validatePersona,
  type CharacterCard,
  type ModelSettings,
  type OwnerProfile,
  type CapabilityName,
} from "../../settings.ts";
import {
  contactModelSettings,
  embedTexts,
  isChatModelId,
  listModels,
  pingChat,
  resetToolsUnsupported,
} from "../../model.ts";
import { backfillMemoryEmbeddings } from "../../memory.ts";
import { localConversationId } from "../../conversations.ts";
import { logModelCall } from "../../logs.ts";
import { previewSystemPrompt } from "../../persona.ts";
import {
  companionPromptExtras,
  contactCard,
  contactExists,
  contactModelProfile,
  countContactsBoundToProfile,
  DEFAULT_CONTACT_ID,
  getContact,
  ASSISTANT_CONTACT_ID,
} from "../../contacts.ts";
import {
  imageProxiedHistory,
  lastUserMessageAt,
  recentMessages,
  selectReplayImages,
} from "../../agent.ts";
import { recallExplained } from "../../memory.ts";
import { activeProfileId } from "../../settings.ts";
import {
  MAX_CARD_BODY_BYTES,
  readJson,
  sendJson,
} from "../http.ts";
import {
  defaultCardForResponse,
  modelThinkingControl,
  normalizeModelPatch,
  pickStrings,
  snapshotResponse,
  strictContactId,
} from "../context.ts";
import { THINKING_LEVELS } from "../../settings.ts";
import type { Route } from "../types.ts";

export const personaDefaultCardRoute: Route = ({ res, path, method }) => {
  // 出厂那份角色卡。新建联系人时「换回默认人设」要把三段填进表单，而那一刻还没有 contact id
  // ——走 /api/contacts/:id/reset-card 会拼成 /api/contacts//reset-card（未知路径）。
  // 真源在后端 defaultPersona()，前端不抄一份：抄一份迟早跟提示词那边漂移。
  if (!(method === "GET" && path === "/api/persona/default-card")) return false;
  sendJson(res, 200, { ok: true, card: defaultCardForResponse().card });
  return true;
};

export const settingsGetRoute: Route = ({ res, path, method }) => {
  if (!(method === "GET" && path === "/api/settings")) return false;
  sendJson(res, 200, { ok: true, ...snapshotResponse() });
  return true;
};

export const settingsPostRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings")) return false;
  const body = await readJson<{
    model?: Partial<ModelSettings>;
    character?: Record<string, unknown>;
    owner?: Record<string, unknown>;
    recentTurns?: unknown;
    reset?: unknown;
    onboarding?: { completed?: boolean };
  }>(req, MAX_CARD_BODY_BYTES);

  if (body.reset === true) {
    resetAll();
    sendJson(res, 200, { ok: true, ...snapshotResponse() });
    return true;
  }

  // 首次设置的完成标记走单独一条：它没有要校验的字段，也不该被卷进「合并后统一报错」。
  if (body.onboarding !== undefined) {
    setOnboardingDone(body.onboarding?.completed === true);
    sendJson(res, 200, { ok: true, ...snapshotResponse() });
    return true;
  }

  const errors: string[] = [];

  if (body.model !== undefined) {
    const patch = normalizeModelPatch(body.model);
    const check = validateModel(patch);
    if (!check.ok) errors.push(...check.errors);
  }

  const personaPatch: { character?: Partial<CharacterCard>; owner?: Partial<OwnerProfile>; recentTurns?: unknown } = {};
  if (body.character !== undefined) {
    personaPatch.character = pickStrings(body.character) as Partial<CharacterCard>;
  }
  if (body.owner !== undefined) {
    personaPatch.owner = pickStrings(body.owner) as Partial<OwnerProfile>;
  }
  if (body.recentTurns !== undefined) personaPatch.recentTurns = body.recentTurns;
  if (body.character !== undefined || body.owner !== undefined || body.recentTurns !== undefined) {
    const check = validatePersona(personaPatch);
    if (!check.ok) errors.push(...check.errors);
  }

  if (errors.length > 0) {
    sendJson(res, 400, { ok: false, error: errors[0], errors });
    return true;
  }

  if (body.model !== undefined) updateModel(normalizeModelPatch(body.model));
  if (body.character !== undefined || body.owner !== undefined || body.recentTurns !== undefined) {
    updatePersona({
      character: personaPatch.character,
      owner: personaPatch.owner,
      ...(typeof body.recentTurns === "number" ? { recentTurns: body.recentTurns } : {}),
    });
  }

  resetToolsUnsupported(); // 配置变了：旧的「不支持 tools」探测结论作废，下次调用重新试错
  sendJson(res, 200, {
    ok: true,
    ...snapshotResponse(),
    note: "已保存并立即生效，不需要重启",
  });
  return true;
};

/** 试连：可以带"还没保存的参数"，让用户先在设置页试通了再保存。 */
export const modelPingRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/model/ping")) return false;
  const body = await readJson<{
    model?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    timeoutMs?: unknown;
    /** 要测什么：chat（默认）/ list / both。 */
    want?: unknown;
  }>(req);

  const override: Partial<ModelSettings> = {};
  // 地址语义：没传 baseUrl = 用已保存的配置测（状态页「实测模型连通」走这条）；
  // 显式传空串 = 用户在表单里清空了地址栏，这时如实报"还缺地址"，
  // 绝不能回落到 .env 默认值替他白测一个无关地址。
  if (typeof body.baseUrl === "string") {
    override.baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
  }
  // 密钥特例：前端传掩码（含 ••••）或空串时，表示"沿用已保存的密钥"，不覆盖。
  // 只有明确给了新密钥才替换——这样用户不碰那一栏就等于没改。
  if (typeof body.apiKey === "string" && body.apiKey.trim() !== "" && !body.apiKey.includes("••")) {
    override.apiKey = body.apiKey.trim();
  }
  const settings = { ...modelConfig(), ...override };

  /*
   * 注意这里用的是"地址+密钥齐了没"，而不是 modelReadyNow()。
   * 原因：用户点「测试连接」的意图就是"验证这组参数能不能用"，
   * 不该被"当前运行模式是 echo"挡住——否则用户会陷入"想试连 → 被要求先切模式 →
   * 切了模式又想先把参数试通"的死循环。mode 只影响真实对话走不走模型。
   */
  if (settings.baseUrl === "" || settings.apiKey === "") {
    const missing = [
      settings.baseUrl === "" ? "接口地址" : "",
      settings.apiKey === "" ? "密钥" : "",
    ].filter((part) => part !== "");
    sendJson(res, 200, {
      ok: true,
      modelReady: false,
      hint: `还缺：${missing.join("、")}。填上就能测。`,
    });
    return true;
  }

  // 「这组参数能不能用」和「服务商有哪些模型」是两件事。各要各的：
  // 不暴露 /models 的服务商（火山 plan 端点实测 404）不该让拉列表失败混进测试结论。
  const want = body.want === "list" || body.want === "both" ? body.want : "chat";
  const model =
    typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : settings.name;
  const result: Record<string, unknown> = {
    ok: true, modelReady: true, baseUrl: settings.baseUrl, model, want,
    // 测的是"这一家"，回执就该说这一家的名字——只有地址时得自己对着地址想是谁
    provider: providerLabel(settings.baseUrl),
  };
  if (want !== "chat") {
    const listed = await listModels(10_000, settings);
    result.list = listed.ok
      ? { ok: true, elapsedMs: listed.elapsedMs, ids: listed.ids, chatIds: listed.ids.filter(isChatModelId) }
      : { ok: false, code: listed.error.code, message: listed.error.message };
  }
  if (want !== "list") {
    const pinged = await pingChat(model, 25_000, settings);
    // 连通测试也落一条记录，体检的「最近一次调用」才反映刚测的结果
    logModelCall({
      purpose: "ping", ok: pinged.ok,
      code: pinged.ok ? null : pinged.error.code,
      status: pinged.ok ? null : pinged.error.status,
      model, url: settings.baseUrl + "/chat/completions",
      elapsedMs: pinged.ok ? pinged.elapsedMs : pinged.error.elapsedMs,
      message: pinged.ok ? null : pinged.error.message,
      profileId: activeProfileId(),
    });
    result.ping = pinged.ok
      ? { ok: true, elapsedMs: pinged.elapsedMs, text: pinged.text }
      : { ok: false, code: pinged.error.code, message: pinged.error.message, elapsedMs: pinged.error.elapsedMs };
  }
  sendJson(res, 200, result);
  return true;
};

/** 模型配置档：收藏多份 OpenAI 兼容接口配置，一键切换。语义：档是收藏，settings.model 是当前生效。 */
export const profilesSaveRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/profiles")) return false;
  const body = await readJson<Record<string, unknown>>(req);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label === "") {
    sendJson(res, 400, { ok: false, error: "给配置档起个名字（最多 24 个字）" });
    return true;
  }
  if (label.length > 24) {
    sendJson(res, 400, { ok: false, error: "配置档名字最多 24 个字" });
    return true;
  }
  const patch = normalizeModelPatch(body);
  const check = validateModel(patch);
  if (!check.ok) {
    sendJson(res, 400, { ok: false, error: check.errors[0], errors: check.errors });
    return true;
  }
  saveProfile({
    ...(patch as Partial<ModelSettings>),
    id: typeof body.id === "string" && body.id !== "" ? body.id : undefined,
    label,
  } as Parameters<typeof saveProfile>[0]);
  sendJson(res, 200, {
    ok: true,
    ...snapshotResponse(),
    note: "配置档已保存（只是收藏，要生效请点「应用」）",
  });
  return true;
};

export const profilesActivateRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/profiles/activate")) return false;
  const body = await readJson<{ id?: unknown }>(req);
  if (typeof body.id !== "string" || body.id === "") {
    sendJson(res, 400, { ok: false, error: "缺少要应用的配置档 id" });
    return true;
  }
  try {
    activateProfile(body.id);
  } catch (error) {
    sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  resetToolsUnsupported(); // 应用了新档：重新探测工具支持
  sendJson(res, 200, { ok: true, ...snapshotResponse(), note: "已应用这份配置档，立即生效" });
  return true;
};

// 快速测一个已存的档：发一条最小指令，报告可用性与延迟（列表行的「测试」按钮）。
export const profilesTestRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/profiles/test")) return false;
  const body = await readJson<{ id?: unknown }>(req);
  const profile = listProfiles().find((p) => p.id === body.id);
  if (!profile) {
    sendJson(res, 404, { ok: false, code: "PROFILE_NOT_FOUND", error: "配置档不存在，可能已被删除" });
    return true;
  }
  if (profile.baseUrl === "" || profile.apiKey === "") {
    sendJson(res, 200, { ok: true, pass: false, error: "这个档缺接口地址或密钥" });
    return true;
  }
  const override: Partial<ModelSettings> = {
    mode: "openai",
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    name: profile.name,
    timeoutMs: profile.timeoutMs,
  };
  // 测试这一击把超时夹到 30s：真挂的模型早点回一句"连不上"，别让前端的圈照 90s 转。
  const pinged = await pingChat(profile.name, Math.min(profile.timeoutMs, 30_000), override);
  // 测试也要落调用记录：体检的「最近一次调用」得能看到刚测的结果
  logModelCall({
    purpose: "ping", ok: pinged.ok,
    code: pinged.ok ? null : pinged.error.code,
    status: pinged.ok ? null : pinged.error.status,
    model: profile.name, url: profile.baseUrl + "/chat/completions",
    elapsedMs: pinged.ok ? pinged.elapsedMs : pinged.error.elapsedMs,
    message: pinged.ok ? null : pinged.error.message,
    profileId: profile.id,
  });
  sendJson(res, 200, pinged.ok
    ? { ok: true, pass: true, elapsedMs: pinged.elapsedMs, text: pinged.text }
    : { ok: true, pass: false, elapsedMs: pinged.error.elapsedMs, error: pinged.error.message });
  return true;
};

export const profilesDeleteRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/profiles/delete")) return false;
  const body = await readJson<{ id?: unknown }>(req);
  if (typeof body.id !== "string" || body.id === "") {
    sendJson(res, 400, { ok: false, error: "缺少要删除的配置档 id" });
    return true;
  }
  const bound = contactsBoundToProfile(body.id);
  if (bound.length > 0) {
    // 不级联删绑定：静默把那位联系人切到全局模型（另一家、另一份计费）比拒绝删除危险得多。
    sendJson(res, 409, {
      ok: false,
      code: "PROFILE_IN_USE",
      error: `还有 ${bound.length} 位联系人绑着这份档（${bound.map((c) => c.name).join("、")}）：先到 TA 们的资料页改成「跟随全局」或换成别的档，再删`,
    });
    return true;
  }
  const removed = deleteProfile(body.id);
  if (!removed) {
    sendJson(res, 404, { ok: false, code: "PROFILE_NOT_FOUND", error: "配置档不存在，可能已被删除" });
    return true;
  }
  sendJson(res, 200, { ok: true, ...snapshotResponse(), note: "已删除这份配置档（当前生效的模型不受影响）" });
  return true;
};

/** 供应商（按接口地址从配置档派生的一层）：rename 给这一家起显示名；sync 改地址/密钥并同步所有模型档。 */
export const providersRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/providers")) return false;
  const body = await readJson<{ op?: unknown; baseUrl?: unknown; toBaseUrl?: unknown; label?: unknown; apiKey?: unknown }>(req);
  const op = typeof body.op === "string" ? body.op : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  if (baseUrl === "") {
    sendJson(res, 400, { ok: false, error: "缺少供应商的接口地址" });
    return true;
  }
  let note = "";
  try {
    if (op === "rename") {
      renameProvider(baseUrl, typeof body.label === "string" ? body.label : "");
      note = "供应商名已更新";
    } else if (op === "sync") {
      const to = typeof body.toBaseUrl === "string" && body.toBaseUrl.trim() !== "" ? body.toBaseUrl.trim() : baseUrl;
      const n = syncProviderConnection(baseUrl, to, typeof body.apiKey === "string" ? body.apiKey : "");
      resetToolsUnsupported(); // 端点变了：旧的「不支持 tools」探测结论作废
      note = `已同步到这一家的 ${n} 个模型`;
    } else {
      sendJson(res, 400, { ok: false, error: "op 只能是 rename / sync" });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  sendJson(res, 200, { ok: true, ...snapshotResponse(), note });
  return true;
};

// 能力端点档（每张卡自己存一组「一家供应商 × 一个模型」，其中一份生效）。
// 一条路由三种动作：save / activate / delete。
export const capabilitiesSaveRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/capabilities")) return false;
  const body = await readJson<Record<string, unknown>>(req);
  const cap = CAPABILITY_NAMES.find((n) => n === body.capability);
  const op = typeof body.op === "string" ? body.op : "";
  if (!cap) {
    sendJson(res, 400, { ok: false, error: "capability 只能是 " + CAPABILITY_NAMES.join(" / ") });
    return true;
  }
  const label = CAPABILITY_LABELS[cap];
  let note = "";
  try {
    if (op === "save") {
      const patch = {
        id: body.id, label: body.label, baseUrl: body.baseUrl, apiKey: body.apiKey,
        name: body.name, timeoutMs: body.timeoutMs, voice: body.voice,
      };
      const check = validateCapabilityProfile(patch);
      if (!check.ok) {
        sendJson(res, 400, { ok: false, error: `${label}：${check.errors.join("；")}`, errors: check.errors });
        return true;
      }
      const saved = saveCapabilityProfile(cap, patch);
      // 这张卡上第一份档存下去就顺手启用：用户的意图是"配好就能用"，
      // 还要再点一次启用只会让人以为没保存上。往后再存的就只存不切。
      if (capabilityActiveId(cap) === "") activateCapabilityProfile(cap, saved.id);
      note = "已保存，立即生效";
    } else if (op === "activate") {
      if (typeof body.id !== "string") {
        sendJson(res, 400, { ok: false, error: "缺少要启用的档 id（传空串表示回到跟随主模型）" });
        return true;
      }
      activateCapabilityProfile(cap, body.id);
      note = body.id.trim() === "" ? `${label}已回到跟随主模型` : `${label}已换到这一份`;
    } else if (op === "delete") {
      if (typeof body.id !== "string" || !deleteCapabilityProfile(cap, body.id)) {
        sendJson(res, 400, { ok: false, error: "那份端点档不存在，可能已被删除" });
        return true;
      }
      note = `${label}的一份端点档已删除`;
    } else {
      sendJson(res, 400, { ok: false, error: "op 只能是 save / activate / delete" });
      return true;
    }
  } catch (error) {
    // 档不存在、id 形状不对这类问题都从这里出去：界面直接贴这句话，不用猜。
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  resetToolsUnsupported(); // 能力配置变了：工具支持的探测结论作废
  // 向量化档启用/更换后当场补算存量记忆（异步、限量）：不补的话新库要等维护周期才有向量，
  // 界面上"配好了却还是词面召回"会像没生效。失手也不影响响应——下一轮维护会再来。
  if (cap === "embedding") void backfillMemoryEmbeddings().catch(() => { /* 维护周期兜底 */ });
  sendJson(res, 200, { ok: true, ...snapshotResponse(), note });
  return true;
};

// 能力就绪状态：聊天页据此显示/隐藏 发图、录音、播放 入口（不泄露任何配置内容）。
export const capabilitiesReadyRoute: Route = ({ res, path, method }) => {
  if (!(method === "GET" && path === "/api/capabilities")) return false;
  sendJson(res, 200, { ok: true, ready: capabilitiesStatus() });
  return true;
};

/** 能力连接测试：用「表单里还没保存的参数」（给了就覆盖），语义与 /api/model/ping 一致。 */
export const capabilitiesTestRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/capabilities/test")) return false;
  const body = await readJson<{ capability?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown }>(req);
  if (typeof body.capability !== "string" || !CAPABILITY_NAMES.includes(body.capability as CapabilityName)) {
    sendJson(res, 400, { ok: false, error: "capability 不是已知能力" });
    return true;
  }
  const name = body.capability as CapabilityName;
  const cap = capabilityConfig(name);
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : cap.baseUrl;
  const apiKey =
    typeof body.apiKey === "string" && body.apiKey.trim() !== "" && !body.apiKey.includes("••")
      ? body.apiKey.trim()
      : cap.apiKey;
  const model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : cap.model;

  if (baseUrl === "" || apiKey === "") {
    const missing = [baseUrl === "" ? "接口地址" : "", apiKey === "" ? "密钥" : ""].filter((p) => p !== "");
    sendJson(res, 200, { ok: true, ready: false, hint: `还缺：${missing.join("、")}。填上就能测。` });
    return true;
  }

  const override: Partial<ModelSettings> = { baseUrl, apiKey, name: model };
  // 向量化走真实调用而不是拉清单：embedding 端点常常不提供 /models，
  // 且「能不能出向量、维度多少」只有打一次才知道。
  if (name === "embedding") {
    if (model === "") {
      sendJson(res, 200, { ok: true, ready: false, hint: "还缺：模型名。填上就能测。" });
      return true;
    }
    const attempt = await embedTexts(["召回测试"], { timeoutMs: 25_000, override: { baseUrl, apiKey, model } });
    sendJson(res, 200, attempt
      ? { ok: true, ready: true, capability: name, model, note: `连上了，向量维度 ${attempt.vectors[0]?.length ?? 0}` }
      : { ok: true, ready: false, capability: name, model, hint: "没拿到向量：核对地址（一般到 /v1）、密钥与模型名，这个端点必须支持 /embeddings。" });
    return true;
  }
  const listed = await listModels(10_000, override);
  const result: Record<string, unknown> = {
    ok: true,
    ready: listed.ok,
    capability: name,
    model,
    ...(listed.ok ? { note: `连上了，模型清单共 ${listed.ids.length} 个` } : {}),
    list: listed.ok
      ? { ok: true, elapsedMs: listed.elapsedMs, count: listed.ids.length }
      : { ok: false, code: listed.error.code, message: listed.error.message },
  };
  if (name === "imageVision") {
    const pinged = await pingChat(model, 25_000, override);
    result.ping = pinged.ok
      ? { ok: true, elapsedMs: pinged.elapsedMs, text: pinged.text }
      : { ok: false, code: pinged.error.code, message: pinged.error.message };
  } else if (listed.ok) {
    const lower = model.toLowerCase();
    result.modelInList = listed.ids.some((id) => id.toLowerCase() === lower || id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase()));
  }
  sendJson(res, 200, result);
  return true;
};

export const settingsPreviewRoute: Route = async ({ req, res, path, method }) => {
  /** 预览：把当前（或正在编辑的）角色卡拼成模型真正会收到的系统提示词。
   *  带 contactId = 还原「下一轮发消息时她实际收到的请求」：
   *  联系人卡（可被 character 草稿覆盖）+ 陪伴段 + 距上次说话 + 按你最后一句话的真实召回
   *  + 按生效轮数回放的对话历史 + 与真实发送同一套的图片降级标记。助手卡内置提示词，不参与。
   *  唯一说破的差异：预览不做发送前的预算裁剪（那一刻才知道要裁多少）。 */
  if (!(method === "POST" && path === "/api/settings/preview")) return false;
  const body = await readJson<{
    character?: Record<string, unknown>;
    owner?: Record<string, unknown>;
    contactId?: unknown;
  }>(req, MAX_CARD_BODY_BYTES);
  const current = personaConfig();
  const cid = typeof body.contactId === "string" ? body.contactId : "";
  const perContact = cid !== "" && cid !== ASSISTANT_CONTACT_ID && contactExists(cid);
  const base = perContact ? contactCard(cid) : current.character;
  const character = { ...base, ...pickStrings(body.character ?? {}) };
  const owner = { ...current.owner, ...pickStrings(body.owner ?? {}) };
  if (!perContact) {
    // 全局预览也换成真实记忆，不再塞两条编造的示例：预览=精确重建是这里的标准，
    // 让用户看到"模型会收到这些"而模型其实收不到，等于把预览变成假样本。
    // 没有指定联系人时按默认联系人兜底，并在 memoryNote 里说破是按谁召回的。
    const memories = recallExplained(DEFAULT_CONTACT_ID, "", undefined, { scope: { conversationId: localConversationId(DEFAULT_CONTACT_ID) } }).events;
    sendJson(res, 200, {
      ok: true,
      prompt: previewSystemPrompt(character, owner, {
        memories,
        lastUserAt: lastUserMessageAt(DEFAULT_CONTACT_ID),
        companion: companionPromptExtras(getContact(DEFAULT_CONTACT_ID)),
        includeNow: getContact(DEFAULT_CONTACT_ID)?.features?.clock !== false,
      }),
      memoryEvents: memories.map((m) => ({ id: m.id, kind: m.kind, subject: m.subject, content: m.content })),
      memoryNote: "[记忆] 全局预览不带具体召回查询，这里显示默认联系人最近的几条记忆。要看某段关系的召回，请到该联系人的资料页预览。",
    });
    return true;
  }
  // 与 respondToTurn 同口径：真图/看不见的图走同一套选图与标记函数，
  // 不再在这里自写一个 "[发过图片]"——那和真实发出去的文案是两句话。
  const rawRows = recentMessages(cid);
  const visionOn = capabilityReady("imageVision");
  const replay = visionOn ? selectReplayImages(rawRows, []) : new Set<string>();
  const rows = imageProxiedHistory(rawRows, replay, visionOn);
  const lastUser = [...rows].reverse().find((r) => r.role === "user");
  // 预览是观测：走 recallExplained，不推进 last_used_at（同 /api/context/usage）。
  // 带主私聊的空间：上面回放的历史就是那段私聊的（recentMessages 默认它），
  // 记忆不带空间的话会把别的群、别的成员条目算进「她下次会看到」，预览就成了假样本。
  const previewScope = { scope: { conversationId: localConversationId(cid) } };
  const memories = lastUser
    ? recallExplained(cid, lastUser.text, undefined, previewScope).events
    : recallExplained(cid, "", 8, previewScope).events;
  sendJson(res, 200, {
    ok: true,
    prompt: previewSystemPrompt(character, owner, {
      companion: companionPromptExtras(getContact(cid), rows[0]?.id),
      lastUserAt: lastUserMessageAt(cid),
      memories,
      includeNow: getContact(cid)?.features?.clock !== false,
    }),
    history: rows.map((r) => ({ role: r.role, text: r.text })),
    memoryEvents: memories.map((m) => ({ id: m.id, kind: m.kind, subject: m.subject, content: m.content })),
    memoryNote: lastUser
      ? `[记忆] 按你最后一句话召回：「${String(lastUser.text).slice(0, 30)}」`
      : "[记忆] 还没有可召回的对话，这里展示的是最近的记忆",
    historyNote: `历史按生效轮数原样带全，不含真实发送时的预算裁剪；本轮若装不下会从最旧一轮开始丢。`,
  });
  return true;
};

/** 聊天输入区的「思考强度」快捷开关。强度属于模型档，不属于某条消息。
 *  联系人绑了档就改那份档；没绑就改当前生效档。响应回一份和 GET 同形的控制快照，
 *  前端据此做乐观更新后的校准。 */
export const thinkingGetRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/model/thinking")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  sendJson(res, 200, { ok: true, ...modelThinkingControl(contactId) });
  return true;
};

export const thinkingPostRoute: Route = async ({ req, res, url, path, method }) => {
  if (!(method === "POST" && path === "/api/model/thinking")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const body = await readJson<{ level?: unknown }>(req);
  const level = typeof body.level === "string" ? body.level : "";
  const auto = level === "auto";
  const off = level === "off";
  const on = level === "on";
  const named = THINKING_LEVELS.some((item) => item.id === level);
  // auto / on / off 是意图，不是档位；其余值必须是服务商支持的具体强度。
  if (!auto && !off && !on && !named) {
    sendJson(res, 400, { ok: false, error: "未知的思考设置" });
    return true;
  }
  const current = contactModelSettings(contactId) ?? modelConfig();
  // 跟随模型永远可恢复；开/关/强度要求模型档明确声明了思考能力。
  if (!auto && !current.caps.thinking) {
    sendJson(res, 400, { ok: false, error: "这个模型没有启用思考能力" });
    return true;
  }
  if (named && current.thinkingParam !== "effort") {
    sendJson(res, 400, { ok: false, error: "这个模型使用开关式思考，请选择开、关或跟随模型" });
    return true;
  }
  const supported = current.thinkingLevels.length > 0
    ? current.thinkingLevels
    : THINKING_LEVELS.map((item) => item.id);
  if (named && !supported.some((item) => item === level)) {
    sendJson(res, 400, { ok: false, error: "这个模型不支持所选强度" });
    return true;
  }
  const boundId = contactModelProfile(contactId);
  const profile = boundId !== "" ? listProfiles().find((item) => item.id === boundId) : undefined;
  // 绑档失效必须报错而不是悄悄落全局：删档入口会拒绝仍有绑定的档，这里查不到只剩
  // 导入/手工改库留下的悬空绑定——此时落笔到全局，等于改掉所有未绑定联系人的配置。
  if (boundId !== "" && !profile) {
    sendJson(res, 409, { ok: false, error: "这位联系人绑定的模型档已失效，请先在设置里重新绑定" });
    return true;
  }
  const patch = auto
    ? { thinkingLevel: "" as ModelSettings["thinkingLevel"], thinkingMode: "auto" as ModelSettings["thinkingMode"] }
    : off
      ? { thinkingLevel: "" as ModelSettings["thinkingLevel"], thinkingMode: "off" as ModelSettings["thinkingMode"] }
      : on
        ? { thinkingLevel: "" as ModelSettings["thinkingLevel"], thinkingMode: "on" as ModelSettings["thinkingMode"] }
        : { thinkingLevel: level as ModelSettings["thinkingLevel"], thinkingMode: "on" as ModelSettings["thinkingMode"] };
  let appliedTo: Record<string, unknown>;
  if (profile) {
    // saveProfile 会保留没传的字段；若这份档正在生效，它也会同步当前生效配置。
    saveProfile({ id: profile.id, label: profile.label, ...patch });
    // 档是联系人共享的：强度改在这份档上，所有绑它的人都跟着变。这里把影响面
    // 报给前端，界面据此说破，而不是让人以为只改了当前这位。
    appliedTo = { scope: "profile", label: profile.label, contacts: countContactsBoundToProfile(profile.id) };
  } else {
    updateModel(patch);
    appliedTo = { scope: "global", label: modelConfig().name, contacts: 0 };
  }
  sendJson(res, 200, { ok: true, appliedTo, ...modelThinkingControl(contactId) });
  return true;
};
