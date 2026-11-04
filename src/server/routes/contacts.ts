// 联系人域：列表（含侧栏搜索/会话快照/未读）、已读记账、按 id 读/建/改/归档/删除、
// 人设换回出厂、记忆整理，以及「系统与数据」五个口（出厂重置 / 一键导出导入 /
// 换数据目录 / 桌面外壳偏好）。
//
// 顺序敏感（与原 handle() 一致，表序在 router.ts）：
// GET /api/contacts → POST /api/contacts/read → [channels 的 qq/wechat 路由] →
// GET/POST /api/contacts → PUT/子动作 → DELETE → factory-reset → data-* → desktop → consolidate。

import {
  ALL_TURNS,
  archiveContact,
  ASSISTANT_CONTACT_ID,
  contactExists,
  createContact,
  deleteContact,
  ensureDefaultContact,
  factoryReset,
  getContact,
  listContacts,
  markContactRead,
  markConversationRead,
  MAX_TURNS,
  restoreDefaultCard,
  sanitizeAvatar,
  sanitizeFaceRef,
  unarchiveContact,
  updateContact,
  type BondState,
  type CompanionFeatures,
  type ContactGender,
} from "../../contacts.ts";
import { buildContactListSnapshots } from "../../contact-list.ts";
import { pendingSoonByContact } from "../../proactive.ts";
import { ensureDefaultConversations, ensureLocalConversation, getConversation } from "../../conversations.ts";
import { ensureAssistantContact, isAssistantThreadContactId } from "../../assistant.ts";
import { consolidateContact } from "../../consolidate.ts";
import { wechat } from "../../wechat.ts";
import { qq } from "../../qq.ts";
import { listProfiles } from "../../settings.ts";
import { resetToolsUnsupported } from "../../model.ts";
import { writeDataExport, importDataArchive } from "../../data-transfer.ts";
import { migrateDataDir } from "../../data-dir.ts";
import { setDesktopPrefs } from "../../desktop-prefs.ts";
import { avatarForDisplay, currentContactId, humanPreview, snapshotResponse } from "../context.ts";
import { MAX_CARD_BODY_BYTES, readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** GET /api/contacts：会话列表（侧栏 + 页头切换器共用）。 */
export const contactsListRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "GET" && path === "/api/contacts")) return false;
  const archivedOnly = url.searchParams.get("archived") === "1";
  // 侧栏搜索词：过滤挪到后端——人设正文一个字都不出接口（它曾占列表响应体 48%）。
  const needle = (url.searchParams.get("q") ?? "").trim().slice(0, 40).toLowerCase();
  // 列表每 10 秒整份重拉：会话、预览、未读和临近任务都按整批联系人一次查。
  const rows = listContacts({ includeArchived: archivedOnly })
    .filter((ct) => (archivedOnly ? ct.archived_at !== null : ct.archived_at === null))
    // 内置「设置助手」不属于会话列表——它只活在助手视图里（资料仍走 /api/contacts/:id）。
    .filter((ct) => ct.id !== ASSISTANT_CONTACT_ID);
  const snapshots = buildContactListSnapshots(rows.map((contact) => contact.id));
  const pendingSoon = pendingSoonByContact();
  const projected = rows.map((contact) => {
      const snapshot = snapshots.get(contact.id);
      const last = snapshot?.latest ?? null;
      const conversationItems = (snapshot?.conversations ?? []).map((conv) => ({
        id: conv.id,
        channel: conv.channel,
        kind: conv.kind,
        title: conv.title,
        enabled: conv.enabled,
        leftAt: conv.leftAt,
        readOnly: conv.channel !== "web",
        preview: conv.latest ? (conv.latest.role === "user" ? "我：" : "") + humanPreview(conv.latest.text).slice(0, 40) : "还没有消息",
        lastAt: conv.latest?.at ?? conv.createdAt,
        unread: conv.unread,
      }));
      const pending = pendingSoon.get(contact.id);
      const item = {
        id: contact.id,
        name: contact.name,
        type: contact.type,
        avatar: avatarForDisplay(contact),
        gender: contact.gender,
        recentTurns: contact.recent_turns,
        showThinking: contact.features.showThinking,
        showTools: contact.features.showTools,
        streamReveal: !contact.features.splitReply,
        imageGen: contact.features.imageGen,
        createdAt: contact.created_at,
        preview: last ? (last.role === "user" ? "我：" : "") + humanPreview(last.text).slice(0, 40) : "打过招呼就能开始聊",
        previewChannel: last?.messageChannel ?? "",
        conversationId: last?.conversationId ?? null,
        conversationTitle: last?.title ?? "",
        conversationReadOnly: last?.channel !== null && last?.channel !== undefined && last.channel !== "web",
        conversations: conversationItems,
        lastAt: last?.at ?? contact.created_at,
        pendingSoon: pending ? 1 : 0,
        pendingFocus: pending?.focus ?? "",
        pendingKind: pending?.kind ?? "",
        archivedAt: contact.archived_at,
        unread: snapshot?.unread ?? 0,
      };
      // 可搜文本只用来筛，绝不进响应：里面装的是人设正文。
      const haystack = needle === "" ? ""
        : [contact.name, contact.card.identity, contact.card.background, contact.card.relationship, item.preview]
          .join("\n").toLowerCase();
      return { item, hit: needle === "" || haystack.includes(needle) };
    });
  const contacts = projected.filter((row) => row.hit).map((row) => row.item);
  // 会话列表按「最后一条消息」倒序（微信口径）；归档分组不排（管理面要稳定顺序）。
  if (!archivedOnly) contacts.sort((a, b) => b.lastAt - a.lastAt || a.createdAt - b.createdAt);
  sendJson(res, 200, { ok: true, contacts });
  return true;
};

/** POST /api/contacts/read：已读记账（红点熄灭）。 */
export const contactReadRoute: Route = async ({ req, res, url, path, method }) => {
  if (!(method === "POST" && path === "/api/contacts/read")) return false;
  const body = await readJson<Record<string, unknown>>(req);
  const cid = typeof body.contactId === "string" ? body.contactId : "";
  const target = cid || currentContactId(url);
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  const messageId = Number(body.messageId);
  // 不校验就会把任意字符串写进 kv 的已读表（那一行是 JSON，能被外部无限撑大）。
  // 助手工作区的派生 id（assistant:<线程>）不在 contacts 表里，但它是合法作用域。
  if ((!contactExists(target) && !isAssistantThreadContactId(target)) || !Number.isFinite(messageId) || messageId <= 0) {
    sendJson(res, 400, { ok: false, error: "已读上报的联系人或消息 id 不合法" });
    return true;
  }
  markContactRead(target, messageId);
  // 新客户端都会带 conversationId；旧客户端/不带会话的调用至少要把本地会话记到已读。
  const conv = conversationId !== "" ? getConversation(conversationId) : ensureLocalConversation(target);
  if (conv !== null && conv.contact_id === target) markConversationRead(conv.id, messageId);
  sendJson(res, 200, { ok: true });
  return true;
};

/** GET /api/contacts/<id>：资料页数据源（含头像展示口径映射）。 */
export const contactGetRoute: Route = ({ res, path, method }) => {
  if (!(method === "GET" && path.startsWith("/api/contacts/"))) return false;
  const id = decodeURIComponent(path.slice("/api/contacts/".length));
  const contact = getContact(id);
  if (!contact) {
    sendJson(res, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true, contact: { ...contact, avatar: avatarForDisplay(contact) } });
  return true;
};

/** POST /api/contacts：新建联系人。 */
export const contactCreateRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/contacts")) return false;
  const body = await readJson<Record<string, unknown>>(req, MAX_CARD_BODY_BYTES);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > 20) {
    sendJson(res, 400, { ok: false, error: "给联系人起个名字（最多 20 个字）" });
    return true;
  }
  const card: Record<string, string> = {};
  for (const key of ["identity", "background", "relationship"] as const) {
    if (typeof body[key] === "string" && (body[key] as string).trim() !== "") card[key] = (body[key] as string).trim();
  }
  let createAvatar: string | undefined;
  if (body.avatar !== undefined) {
    const clean = sanitizeAvatar(body.avatar);
    if (body.avatar !== "" && clean === undefined) {
      sendJson(res, 400, { ok: false, error: "头像只支持 png/jpg/webp 图片（≤150KB）" });
      return true;
    }
    createAvatar = clean;
  }
  let createGender: ContactGender | undefined;
  if (body.gender !== undefined) {
    if (body.gender !== "female" && body.gender !== "male" && body.gender !== "other") {
      sendJson(res, 400, { ok: false, error: "指代方式只能是 female / male / other" });
      return true;
    }
    createGender = body.gender;
  }
  const contact = createContact({ name, card, avatar: createAvatar, gender: createGender });
  sendJson(res, 200, { ok: true, contact, note: "新联系人已创建，记忆从零开始" });
  return true;
};

/** PUT /api/contacts/<id>：资料页保存（头像/人设/绑定/能力/回放轮数/指代方式/生活线/温度计）。 */
export const contactUpdateRoute: Route = async ({ req, res, path, method }) => {
  const m = method === "PUT" ? path.match(/^\/api\/contacts\/([^/]+)$/) : null;
  if (!m) return false;
  const id = decodeURIComponent(m[1] ?? "");
  // 这条收头像 dataURL（≤150KB）加三段合计 30000 字的人设：通用 32KB 会先于字段校验挡掉合法请求。
  const body = await readJson<Record<string, unknown>>(req, MAX_CARD_BODY_BYTES);
  let avatar: string | undefined;
  if (body.avatar !== undefined) {
    const clean = sanitizeAvatar(body.avatar);
    if (body.avatar !== "" && clean === undefined) {
      sendJson(res, 400, { ok: false, error: "头像只支持 png/jpg/webp 图片（≤150KB）" });
      return true;
    }
    avatar = clean;
  }
  let faceRef: string | undefined;
  if (body.faceRef !== undefined) {
    const clean = sanitizeFaceRef(body.faceRef);
    if (body.faceRef !== "" && clean === undefined) {
      sendJson(res, 400, { ok: false, error: "自拍参考图得是已上传到本机的 /media 图片" });
      return true;
    }
    faceRef = clean;
  }
  const card: Record<string, string> = {};
  for (const key of ["identity", "background", "relationship"] as const) {
    if (typeof body[key] === "string") card[key] = (body[key] as string).trim();
  }
  // 模型绑定：空串 = 跟随全局；给了档 id 就必须真实存在，宁挡错不放过悬空引用
  let modelProfile: string | undefined;
  if (body.modelProfile !== undefined) {
    modelProfile = typeof body.modelProfile === "string" ? body.modelProfile.trim() : "";
    if (modelProfile !== "" && !listProfiles().some((p) => p.id === modelProfile)) {
      sendJson(res, 400, { ok: false, error: "绑定的模型档不存在，可能已被删除" });
      return true;
    }
  }
  let features: Partial<CompanionFeatures> | undefined;
  if (body.features !== undefined) {
    if (body.features === null || typeof body.features !== "object" || Array.isArray(body.features)) {
      sendJson(res, 400, { ok: false, error: "features 必须是对象" });
      return true;
    }
    features = body.features as Partial<CompanionFeatures>;
  }
  let recentTurns: number | undefined;
  if (body.recentTurns !== undefined) {
    const t = body.recentTurns;
    if (typeof t !== "number" || !Number.isInteger(t) || (t !== ALL_TURNS && (t < 0 || t > MAX_TURNS))) {
      sendJson(res, 400, { ok: false, error: `回放轮数只能是 0（跟随全局）、-1（全部）或 1~${MAX_TURNS} 的整数` });
      return true;
    }
    recentTurns = t;
  }
  let gender: ContactGender | undefined;
  if (body.gender !== undefined) {
    if (body.gender !== "female" && body.gender !== "male" && body.gender !== "other") {
      sendJson(res, 400, { ok: false, error: "指代方式只能是 female / male / other" });
      return true;
    }
    gender = body.gender;
  }
  const lifeline = typeof body.lifeline === "string" ? body.lifeline : undefined;
  const recap = typeof body.recap === "string" ? body.recap : undefined;
  const bond = body.bond !== undefined && body.bond !== null && typeof body.bond === "object" && !Array.isArray(body.bond)
    ? (body.bond as Partial<BondState>)
    : undefined;
  const contact = updateContact(id, {
    name: typeof body.name === "string" ? body.name : undefined,
    card,
    avatar,
    faceRef,
    modelProfile,
    recentTurns,
    gender,
    features,
    lifeline,
    recap,
    bond,
  });
  if (!contact) {
    sendJson(res, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true, contact: { ...contact, avatar: avatarForDisplay(contact) } });
  return true;
};

/** POST /api/contacts/<id>/unarchive：归档冷却期结束，恢复到列表。 */
export const contactUnarchiveRoute: Route = ({ res, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/unarchive$/) : null;
  if (!m) return false;
  const ok = unarchiveContact(decodeURIComponent(m[1] ?? ""));
  if (!ok) {
    sendJson(res, 400, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "已恢复到列表，对话与记忆原样" });
  return true;
};

/** POST /api/contacts/<id>/archive：归档（数据保留，人格不可再生）。 */
export const contactArchiveRoute: Route = ({ res, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/archive$/) : null;
  if (!m) return false;
  const ok = archiveContact(decodeURIComponent(m[1] ?? ""));
  if (!ok) {
    sendJson(res, 400, { ok: false, error: "联系人不存在，或那是内置的设置助手（助手不属于会话，删不掉）" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "已归档（数据保留，人格不可再生）" });
  return true;
};

/** POST /api/contacts/<id>/reset-card：人格三段换回出厂那份。 */
export const contactResetCardRoute: Route = ({ res, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/reset-card$/) : null;
  if (!m) return false;
  const restored = restoreDefaultCard(decodeURIComponent(m[1] ?? ""));
  if (!restored) {
    sendJson(res, 404, { ok: false, error: "联系人不存在，可能已被删除" });
    return true;
  }
  sendJson(res, 200, { ok: true, note: "人设已换回出厂那份，其余设置没动" });
  return true;
};

/** DELETE /api/contacts/<id>：彻底删除（只接受已归档的；对话/记忆/任务/用量/图片全清）。 */
export const contactDeleteRoute: Route = ({ res, path, method }) => {
  const m = method === "DELETE" ? path.match(/^\/api\/contacts\/([^/]+)$/) : null;
  if (!m) return false;
  try {
    const id = decodeURIComponent(m[1] ?? "");
    const result = deleteContact(id);
    // 微信/QQ 绑定不在 deleteContact 事务范围内：不主动解绑，对端一句话就会给已不存在的
    // contact_id 建轮次写消息（界面看不到、也删不掉）。
    const unbound = wechat.disconnectByContact(id);
    const qqUnbound = qq.disconnectByContact(id);
    sendJson(res, 200, { ok: true, removedMedia: result.removedMedia, unbound, qqUnbound, note: "已彻底删除，不可恢复" });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** POST /api/settings/factory-reset：全应用唯一的「抹掉重来」，要显式 confirm=FACTORY。 */
export const factoryResetRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/factory-reset")) return false;
  const body = await readJson<{ confirm?: unknown }>(req);
  if (body.confirm !== "FACTORY") {
    sendJson(res, 400, { ok: false, error: "这个操作要显式确认（confirm=FACTORY）：它会清掉全部对话、记忆、画作与所有设置" });
    return true;
  }
  // 收件循环与内存里那份绑定缓存一起抹：只清 kv 的话 store 还在，
  // 而重新种子出来的小茉 id 仍是 default，旧绑定会把新会话镜像出去。
  wechat.clearAll();
  qq.clearAll();
  const cleared = factoryReset();
  ensureDefaultContact();
  ensureDefaultConversations();
  ensureAssistantContact();
  resetToolsUnsupported(); // 模型档全没了：工具支持探测重新来一遍，别拿旧结论说话
  console.log(`[factory-reset] 清掉 ${cleared.contacts} 位联系人与 ${cleared.mediaRemoved} 个图片文件，已重新种子`);
  sendJson(res, 200, {
    ok: true, ...snapshotResponse(),
    note: `已回到初始状态：${cleared.contacts} 位联系人的对话与记忆、全部设置与绑定、${cleared.mediaRemoved} 个图片文件都已清除`,
  });
  return true;
};

/** GET /api/settings/data-export：一键导出（gzip tar 文件流）。 */
export const dataExportRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "GET" && path === "/api/settings/data-export")) return false;
  try {
    await writeDataExport(res);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    res.destroy();
  }
  return true;
};

/** POST /api/settings/data-import：导入 .tar.gz 备份（校验临时解包目录，替换数据并要求重启）。 */
export const dataImportRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/data-import")) return false;
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/gzip" && contentType !== "application/x-gzip" && contentType !== "application/octet-stream") {
    sendJson(res, 400, { ok: false, error: "请上传小茉导出的 .tar.gz 备份文件" });
    return true;
  }
  try {
    const result = await importDataArchive(req);
    sendJson(res, 200, { ok: true, ...result, restartRequired: true });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** POST /api/settings/data-dir：换数据存储位置（迁完必须重启才走新位置）。 */
export const dataDirRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/data-dir")) return false;
  const body = await readJson<{ path?: unknown }>(req);
  const target = typeof body.path === "string" ? body.path.trim() : "";
  if (target === "") {
    sendJson(res, 400, { ok: false, error: "要给出新的数据目录路径" });
    return true;
  }
  try {
    const moved = await migrateDataDir(target);
    sendJson(res, 200, {
      ok: true, ...snapshotResponse(),
      note: `已把数据迁到 ${moved.newDir}：库 1 个、图片 ${moved.media} 个、技能 ${moved.skills} 个。重启应用后生效。`,
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** POST /api/settings/desktop：桌面外壳偏好（开机自启 / 关窗留托盘），XIAOMO-PREF 当场生效。 */
export const desktopPrefsRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/settings/desktop")) return false;
  const body = await readJson<{ autostart?: unknown; tray?: unknown }>(req);
  const patch: { autostart?: boolean; tray?: boolean } = {};
  if (typeof body.autostart === "boolean") patch.autostart = body.autostart;
  if (typeof body.tray === "boolean") patch.tray = body.tray;
  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { ok: false, error: "要改的项得是 true 或 false" });
    return true;
  }
  try {
    const saved = setDesktopPrefs(patch);
    sendJson(res, 200, { ok: true, ...snapshotResponse(), desktop: saved });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** POST /api/contacts/<id>/consolidate：手动触发一次记忆整理（同刻每联系人只跑一份）。 */
export const contactConsolidateRoute: Route = async ({ res, path, method }) => {
  const m = method === "POST" ? path.match(/^\/api\/contacts\/([^/]+)\/consolidate$/) : null;
  if (!m) return false;
  const id = decodeURIComponent(m[1] ?? "");
  if (!getContact(id)) {
    sendJson(res, 404, { ok: false, code: "CONTACT_NOT_FOUND", error: "联系人不存在" });
    return true;
  }
  try {
    // ConsolidationResult 自带 ok（echo/并发跳过是 ok:false + note），不额外包一层。
    sendJson(res, 200, await consolidateContact(id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, error: `整理失败：${message}` });
  }
  return true;
};

export const routes: Route[] = [
  contactsListRoute,
  contactReadRoute,
  contactGetRoute,
  contactCreateRoute,
  contactUpdateRoute,
  contactUnarchiveRoute,
  contactArchiveRoute,
  contactResetCardRoute,
  contactDeleteRoute,
  factoryResetRoute,
  dataExportRoute,
  dataImportRoute,
  dataDirRoute,
  desktopPrefsRoute,
  contactConsolidateRoute,
];
