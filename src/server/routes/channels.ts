// 平台连接域：QQ（每联系人一个独立 BotAccount）与微信（每联系人一条 iLink 绑定）。
//
// 顺序敏感：这些 /api/contacts/<id>/qq* 与 /api/contacts/<id>/wechat* 的具体 GET 子路由
// 必须先排在联系人模块的「通用 GET /api/contacts/<id> 兜底」之前——否则那条兜底会把
// /api/contacts/<id>/qq 当成「id=qq/xxx」吞掉回 404。router.ts 里 channels 排在
// contacts.detailRoutes 之前，正是为这一点（见 router.ts 的分段注释）。

import { qq, applyQQBackend, qqBackend, qqBackendFor, qqBackendSaved, qqBackendSavedFor, qqUsesBackend, saveQQBackend, saveQQBackendForContact } from "../../channels/qq.ts";
import { upsertOneBotAccount, onebotLoginInfo, onebotSettings, applyOnebotSettings } from "../../channels/qq-onebot.ts";
import { napcatStatus, installNapcat, startNapcat, reloginNapcat } from "../../channels/napcat.ts";
import { config } from "../../core/config.ts";
import { wechat } from "../../channels/wechat.ts";
import { getContact } from "../../chat/contacts.ts";
import { readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** GET/POST /api/qq/backend：QQ 后端选型（official/onebot）。
 *  带 contactId 时只修改/读取这位联系人的活动渠道；不带时修改全局默认值。
 *  两套适配器常驻，切换不需要重启；restartRequired 只为兼容旧前端字段，恒为 false。 */
const qqBackendRoute: Route = async ({ res, url, path, method, req }) => {
  if (path === "/api/qq/backend" && method === "GET") {
    const contactId = url.searchParams.get("contactId") ?? "";
    const backend = contactId !== "" ? qqBackendFor(contactId) : qqBackend();
    const saved = contactId !== "" ? qqBackendSavedFor(contactId) : qqBackendSaved();
    sendJson(res, 200, {
      ok: true,
      backend,
      saved,
      contactId: contactId || null,
      restartPending: false,
      onebotReady: backend === "onebot" && config.qq.onebotHttpBase !== "",
    });
    return true;
  }
  if (path === "/api/qq/backend" && method === "POST") {
    const body = await readJson<Record<string, unknown>>(req).catch(() => ({}) as Record<string, unknown>);
    const backend = body.backend;
    const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
    if (backend !== "official" && backend !== "onebot") {
      sendJson(res, 400, { ok: false, error: "backend 只能是 official 或 onebot" });
      return true;
    }
    if (contactId !== "") {
      saveQQBackendForContact(contactId, backend);
      qq.startAll();
      sendJson(res, 200, { ok: true, backend, contactId, restartRequired: false, applied: true });
    } else {
      saveQQBackend(backend);
      applyQQBackend(backend);
      sendJson(res, 200, { ok: true, backend, restartRequired: false, applied: true });
    }
    return true;
  }
  return false;
};

/** /api/qq/credentials：GET 总览/按联系人快照；POST 必须带 contactId（凭据按联系人隔离）。 */
export const qqCredentialsRoute: Route = async ({ res, url, path, method, req }) => {
  if (!(path === "/api/qq/credentials")) return false;
  if (method === "GET") {
    const cid = url.searchParams.get("contactId");
    sendJson(res, 200, { ok: true, ...(cid ? qq.snapshotFor(cid) : qq.summary()) });
    return true;
  }
  if (method === "POST") {
    const body = await readJson<Record<string, unknown>>(req);
    const cid = typeof body.contactId === "string" ? body.contactId : url.searchParams.get("contactId") ?? "";
    if (cid === "" || !getContact(cid)) {
      sendJson(res, 404, { ok: false, error: "联系人不存在" });
      return true;
    }
    try {
      sendJson(res, 200, { ok: true, ...qq.setCredentials(cid, body), ...qq.snapshotFor(cid) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  return false;
};

/** /api/qq/qr：扫码拿凭据（官方推荐，不用手抄 AppID/AppSecret）。 */
export const qqQrRoute: Route = async ({ res, url, path, method, req }) => {
  if (!(path === "/api/qq/qr" && method === "POST")) return false;
  try {
    const body = await readJson<{ contactId?: unknown }>(req);
    const cid = typeof body.contactId === "string" ? body.contactId : url.searchParams.get("contactId") ?? "";
    if (cid === "" || !getContact(cid)) {
      sendJson(res, 404, { ok: false, error: "联系人不存在" });
      return true;
    }
    sendJson(res, 200, { ok: true, ...(await qq.beginCredentialQr(cid)) });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** /api/qq/qr/<id>：轮询扫码结果。 */
export const qqQrPollRoute: Route = async ({ res, url, path, method }) => {
  if (method !== "GET") return false;
  const m = /^\/api\/qq\/qr\/([^/]+)$/.exec(path);
  if (!m) return false;
  try {
    const cid = url.searchParams.get("contactId") ?? "";
    if (cid === "" || !getContact(cid)) {
      sendJson(res, 404, { ok: false, error: "联系人不存在" });
      return true;
    }
    sendJson(res, 200, { ok: true, ...(await qq.pollCredentialQr(cid, decodeURIComponent(m[1] ?? ""))) });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** /api/contacts/<id>/qq[/bind|/flags|/disconnect][/<arg>]：QQ 绑定与开关。 */
export const qqContactRoute: Route = async ({ req, res, path, method }) => {
  const m = /^\/api\/contacts\/([^/]+)\/qq(\/[^/]*)?(\/[^/]*)?$/.exec(path);
  if (!m) return false;
  const contactId = decodeURIComponent(m[1] ?? "");
  const action = m[2] ?? "";
  const arg = m[3] ? decodeURIComponent(m[3].slice(1)) : "";
  if (method === "GET" && action === "") {
    sendJson(res, 200, { ok: true, ...qq.snapshotFor(contactId) });
    return true;
  }
  if (method === "POST" && action === "/bind" && arg === "") {
    try {
      sendJson(res, 200, { ok: true, ...qq.beginBind(contactId) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (method === "POST" && action === "/onebot-bind" && arg === "") {
    // OneBot 后端专属：把「真实 QQ 号」绑到这位联系人。官方后端下调用是无效安全态。
    if (qqBackendFor(contactId) !== "onebot") {
      sendJson(res, 409, { ok: false, error: "OneBot 绑定仅在 QQ_BACKEND=onebot 时可用；当前是官方 Bot 后端" });
      return true;
    }
    const body = await readJson<Record<string, unknown>>(req);
    const qqNumber = typeof body.qqNumber === "string" ? body.qqNumber.trim() : "";
    if (qqNumber === "" || !/^\d{5,15}$/.test(qqNumber)) {
      sendJson(res, 400, { ok: false, error: "请填有效的 QQ 号（5-15 位数字）" });
      return true;
    }
    const patch: { enabled?: boolean; proactive?: boolean; ownerQq?: string } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.proactive === "boolean") patch.proactive = body.proactive;
    // 主人 QQ 号：群聊里把联系人从一众群成员里认出来的唯一依据；空串=清除。
    if (typeof body.ownerQq === "string") {
      const ownerQq = body.ownerQq.trim();
      if (ownerQq !== "" && !/^\d{5,15}$/.test(ownerQq)) {
        sendJson(res, 400, { ok: false, error: "主人 QQ 号应为 5-15 位数字，留空则不标记" });
        return true;
      }
      patch.ownerQq = ownerQq;
    }
    upsertOneBotAccount(contactId, qqNumber, patch);
    sendJson(res, 200, { ok: true, ...qq.snapshotFor(contactId) });
    return true;
  }
  if (method === "GET" && action === "/bind" && arg !== "") {
    sendJson(res, 200, { ok: true, ...qq.pollBind(contactId, arg) });
    return true;
  }
  if (method === "POST" && (action === "/flags" || action === "/disconnect")) {
    const existing = qq.snapshotFor(contactId).binding;
    if (existing === null) {
      sendJson(res, 404, { ok: false, error: "该联系人还没有 QQ 绑定" });
      return true;
    }
    if (action === "/disconnect") {
      qq.disconnect(existing.id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    const body = await readJson<Record<string, unknown>>(req);
    const patch: { enabled?: boolean; proactive?: boolean } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.proactive === "boolean") patch.proactive = body.proactive;
    if (!qq.setFlagsByContact(contactId, patch)) {
      sendJson(res, 404, { ok: false, error: "该联系人还没有 QQ 绑定" });
      return true;
    }
    sendJson(res, 200, { ok: true, binding: qq.snapshotFor(contactId).binding });
    return true;
  }
  // 子分支都没接住：落空继续（原语义）。
  return false;
};

/** /api/contacts/<id>/wechat[/bind|/flags|/disconnect][/<arg>]：微信 iLink 绑定与开关。 */
export const wechatContactRoute: Route = async ({ req, res, path, method }) => {
  const m = /^\/api\/contacts\/([^/]+)\/wechat(\/[^/]*)?(\/[^/]*)?$/.exec(path);
  if (!m) return false;
  const contactId = decodeURIComponent(m[1] ?? "");
  const action = m[2] ?? "";
  const arg = m[3] ? decodeURIComponent(m[3].slice(1)) : "";
  if (method === "GET" && action === "") {
    sendJson(res, 200, { ok: true, ...wechat.snapshotFor(contactId) });
    return true;
  }
  if (method === "POST" && action === "/bind" && arg === "") {
    try {
      sendJson(res, 200, { ok: true, ...(await wechat.beginBind(contactId)) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (method === "GET" && action === "/bind" && arg !== "") {
    sendJson(res, 200, { ok: true, ...(await wechat.pollBind(arg)) });
    return true;
  }
  if (method === "POST" && (action === "/flags" || action === "/disconnect")) {
    const existing = wechat.snapshotFor(contactId).link;
    if (!existing) {
      sendJson(res, 404, { ok: false, error: "该联系人还没有微信连接" });
      return true;
    }
    if (action === "/disconnect") {
      wechat.disconnect(existing.id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    const body = await readJson<Record<string, unknown>>(req);
    const patch: { enabled?: boolean; proactive?: boolean } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.proactive === "boolean") patch.proactive = body.proactive;
    if (!wechat.setFlags(existing.id, patch)) {
      sendJson(res, 404, { ok: false, error: "该联系人还没有微信连接" });
      return true;
    }
    sendJson(res, 200, { ok: true, link: wechat.snapshotFor(contactId).link });
    return true;
  }
  return false;
};

/** GET /api/qq/onebot/status：探测 OneBot 协议端并读出它登录的账号。
 *  绑定入口靠它把「手填 QQ 号」升级成「看到头像昵称、确认绑定」；连不上时 error 带引导原因。 */
const qqOneBotStatusRoute: Route = async ({ res, path, method }) => {
  if (!(method === "GET" && path === "/api/qq/onebot/status")) return false;
  sendJson(res, 200, { ok: true, ...(await onebotLoginInfo()) });
  return true;
};

/** GET/POST /api/qq/onebot/settings：协议端连接设置（HTTP 出站地址 / forward WS / 令牌）。
 *  界面里就地改、热生效——POST 后若 OneBot 正在跑，重启它的收发通道（WS 断开重连）。 */
const qqOneBotSettingsRoute: Route = async ({ res, path, method, req }) => {
  if (path !== "/api/qq/onebot/settings") return false;
  if (method === "GET") {
    const s = onebotSettings();
    sendJson(res, 200, { ok: true, httpBase: s.httpBase, wsUrl: s.wsUrl, hasToken: s.token !== "" });
    return true;
  }
  if (method === "POST") {
    const body = await readJson<Record<string, unknown>>(req).catch(() => ({}) as Record<string, unknown>);
    const patch: { httpBase?: string; wsUrl?: string; token?: string } = {};
    if (typeof body.httpBase === "string") patch.httpBase = body.httpBase;
    if (typeof body.wsUrl === "string") patch.wsUrl = body.wsUrl;
    // 令牌传空串 = 清掉；不传 = 保持不变。
    if (typeof body.token === "string") patch.token = body.token;
    const saved = applyOnebotSettings(patch);
    if (qqUsesBackend("onebot")) { qq.stopAll(); qq.startAll(); }
    sendJson(res, 200, { ok: true, httpBase: saved.httpBase, wsUrl: saved.wsUrl, hasToken: saved.token !== "", applied: true });
    return true;
  }
  return false;
};

/** /api/qq/napcat：小茉托管的 NapCat（本机一键安装/启动/登录）。
 *  GET status：安装/运行/登录状态 + 二维码链接（界面 4s 轮询）。
 *  POST install：下载解压（较慢，请求同步等待）。POST start：拉起+配置+等登录（最长约 3 分钟）。
 *  POST relogin：清掉自动登录并重启 NapCat，回到扫码页切换另一个 QQ。 */
const qqNapcatRoute: Route = async ({ res, path, method, req }) => {
  if (path !== "/api/qq/napcat") return false;
  if (method === "GET") {
    sendJson(res, 200, await napcatStatus().then((s) => ({ ok: true, ...s })));
    return true;
  }
  if (method === "POST") {
    const body = await readJson<Record<string, unknown>>(req).catch(() => ({}) as Record<string, unknown>);
    const action = typeof body.action === "string" ? body.action : "";
    if (action === "install") sendJson(res, 200, await installNapcat().then((r) => ({ ok: r.ok, error: r.error })));
    else if (action === "start") sendJson(res, 200, await startNapcat().then((r) => ({ ok: r.ok, error: r.error, needsQr: r.needsQr })));
    else if (action === "relogin") sendJson(res, 200, await reloginNapcat().then((r) => ({ ok: r.ok, error: r.error, needsQr: r.needsQr })));
    else sendJson(res, 400, { ok: false, error: "action 只能是 install、start 或 relogin" });
    return true;
  }
  return false;
};

export const routes: Route[] = [
  qqBackendRoute,
  qqOneBotStatusRoute,
  qqOneBotSettingsRoute,
  qqNapcatRoute,
  qqCredentialsRoute,
  qqQrRoute,
  qqQrPollRoute,
  qqContactRoute,
  wechatContactRoute,
];
