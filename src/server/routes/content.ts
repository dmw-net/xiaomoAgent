// 联系人的画：生成产物台账。内容库的读视图已经并到 /api/assets（src/server/routes/assets.ts）。

import {
  deleteArtifact,
  getArtifact,
  listArtifacts,
  setArtifactStarred,
} from "../../artifacts.ts";
import { updateContact } from "../../contacts.ts";
import {
  clampInt,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  readJson,
  sendJson,
} from "../http.ts";
import { strictContactId } from "../context.ts";
import type { Route } from "../types.ts";


const artifactsListRoute: Route = ({ res, url, path, method }) => {
  // 联系人的画：生成产物台账。按联系人隔离，翻页口径与调用记录/记忆清单一致。
  if (!(method === "GET" && path === "/api/artifacts")) return false;
  const contactId = strictContactId(url, res);
  if (contactId === null) return true;
  const limit = clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const { items, total } = listArtifacts(contactId, limit, offset);
  sendJson(res, 200, { ok: true, artifacts: items, total, limit, offset });
  return true;
};

const artifactsActionRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/artifacts")) return false;
  const body = await readJson<{ op?: unknown; id?: unknown; contactId?: unknown }>(req);
  const id = typeof body.id === "string" ? body.id : "";
  const artifact = id === "" ? null : getArtifact(id);
  if (!artifact) {
    sendJson(res, 404, { ok: false, error: "这张画不存在（可能已经被删掉了）" });
    return true;
  }
  const op = body.op;
  // 户主校验对**每一个** op 生效，不只 setFaceRef：artifacts 表按 contact_id 隔离，
  // 而 getArtifact 只按 id 查。少了这一行，看着 A 的界面就能 star/delete B 的画——
  // delete 还会连文件一起释放，那是不可恢复的跨联系人破坏。
  // 判据用请求带的 contactId（界面从来都带），不认"当前选中谁"——服务端不该猜。
  const contactId = typeof body.contactId === "string" ? body.contactId : "";
  if (contactId === "" || artifact.contactId !== contactId) {
    sendJson(res, 403, { ok: false, error: "这张画不属于这个联系人" });
    return true;
  }
  if (op === "star") {
    sendJson(res, 200, { ok: true, starred: setArtifactStarred(id, !artifact.starred) });
    return true;
  }
  if (op === "delete") {
    // 唯一会让画消失的路径：删行 + 释放文件。删聊天消息不会走到这里。
    deleteArtifact(id);
    sendJson(res, 200, { ok: true, deleted: true });
    return true;
  }
  if (op === "setFaceRef") {
    const updated = updateContact(contactId, { faceRef: artifact.url });
    if (!updated) {
      sendJson(res, 404, { ok: false, error: "联系人不存在" });
      return true;
    }
    sendJson(res, 200, { ok: true, faceRef: updated.faceRef });
    return true;
  }
  sendJson(res, 400, { ok: false, error: "op 只支持 star / delete / setFaceRef" });
  return true;
};

export const routes: Route[] = [artifactsListRoute, artifactsActionRoute];
