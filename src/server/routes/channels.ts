// 平台连接域：QQ（每联系人一个独立 BotAccount）与微信（每联系人一条 iLink 绑定）。
//
// 顺序敏感：这些 /api/contacts/<id>/qq* 与 /api/contacts/<id>/wechat* 的具体 GET 子路由
// 必须先排在联系人模块的「通用 GET /api/contacts/<id> 兜底」之前——否则那条兜底会把
// /api/contacts/<id>/qq 当成「id=qq/xxx」吞掉回 404。router.ts 里 channels 排在
// contacts.detailRoutes 之前，正是为这一点（见 router.ts 的分段注释）。

import { qq } from "../../qq.ts";
import { upsertOneBotAccount } from "../../qq-onebot.ts";
import { config } from "../../config.ts";
import { wechat } from "../../wechat.ts";
import { getContact } from "../../contacts.ts";
import { readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** GET /api/qq/backend：当前 QQ 后端选型（official/onebot）+ OneBot 侧配置是否就绪。
 *  前端资料页按它分流：官方模式显示扫码/凭据，OneBot 模式显示「填真实 QQ 号」。 */
const qqBackendRoute: Route = ({ res }) => {
  const configured = config.qq.onebotHttpBase !== "";
  sendJson(res, 200, {
    ok: true,
    backend: config.qq.backend,
    /** OneBot 侧最小可运行条件：HTTP 出站地址已配。WS 入站可缺省（只出不进也能跑）。 */
    onebotReady: config.qq.backend === "onebot" && configured,
  });
  return true;
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
    if (config.qq.backend !== "onebot") {
      sendJson(res, 409, { ok: false, error: "OneBot 绑定仅在 QQ_BACKEND=onebot 时可用；当前是官方 Bot 后端" });
      return true;
    }
    const body = await readJson<Record<string, unknown>>(req);
    const qqNumber = typeof body.qqNumber === "string" ? body.qqNumber.trim() : "";
    if (qqNumber === "" || !/^\d{5,15}$/.test(qqNumber)) {
      sendJson(res, 400, { ok: false, error: "请填有效的 QQ 号（5-15 位数字）" });
      return true;
    }
    const patch: { enabled?: boolean; proactive?: boolean } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.proactive === "boolean") patch.proactive = body.proactive;
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

export const routes: Route[] = [
  qqBackendRoute,
  qqCredentialsRoute,
  qqQrRoute,
  qqQrPollRoute,
  qqContactRoute,
  wechatContactRoute,
];
