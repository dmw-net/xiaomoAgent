// 表情包管理域：素材库（图片表情）的增删查、目录导入、单图上传、采集开关，
// 以及渠道能力探测与内置表情词表。
//
// 为什么放 media 域之后：它消费的是媒体库（/media 图片），语义上紧贴媒体；
// 又属于"能力管理"，与设置页其它能力分区同层。路由只插表不改序（见 router.ts 顶部）。
//
// 纪律（与全表一致）：用 Ctx.path（不含 query）匹配、url.searchParams 取参数；
// 所有 /api/* 返回 JSON 且永远带 ok 字段，前端只靠 ok 判断成败。

import { MAX_IMAGE_BYTES, saveImage, sniffImageMime } from "../../media.ts";
import {
  emoteAutoCapture,
  emoteCapabilities,
  emoteStats,
  faceKeywords,
  importEmoteDir,
  listEmoteAssets,
  registerEmoteAsset,
  removeEmoteAsset,
  setEmoteAutoCapture,
} from "../../qq-emote.ts";
import { readBinary, readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** GET /api/emotes：素材库总览——列表 + 统计 + 渠道能力 + 采集开关，前端"表情"分区一次拉齐。 */
const emotesListRoute: Route = ({ res, path, method }) => {
  if (!(path === "/api/emotes" && method === "GET")) return false;
  sendJson(res, 200, {
    ok: true,
    assets: listEmoteAssets(),
    stats: emoteStats(),
    capabilities: emoteCapabilities(),
    autoCapture: emoteAutoCapture(),
  });
  return true;
};

/** GET /api/emotes/faces：内置表情词表（可发词 + 降级 emoji + face id），给用户/模型当"可选清单"。 */
const emotesFacesRoute: Route = ({ res, path, method }) => {
  if (!(path === "/api/emotes/faces" && method === "GET")) return false;
  sendJson(res, 200, { ok: true, faces: faceKeywords() });
  return true;
};

type EmoteBody = { url?: unknown; label?: unknown; tags?: unknown };
/** POST /api/emotes：登记一张已存在的 /media 图片进素材库（前端先传 /api/media 拿 url 再登记）。
 *  同 url 覆盖，带上限。 */
const emotesAddRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/emotes" && method === "POST")) return false;
  let body: EmoteBody;
  try {
    body = await readJson<EmoteBody>(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
    return true;
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (url === "" || !url.startsWith("/media/")) {
    sendJson(res, 400, { ok: false, error: "url 必须是本地 /media 图片路径（先上传再登记，或用 /api/emotes/upload）" });
    return true;
  }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string").slice(0, 8) : [];
  registerEmoteAsset(url, label, tags);
  sendJson(res, 200, { ok: true, ...emoteStats() });
  return true;
};

/** POST /api/emotes/upload：请求体是图片二进制（content-type 标 mime），落媒体库并登记成素材，一步到位。
 *  label 走查询参数（上传接口吃二进制，正文不能再当 JSON）。 */
const emotesUploadRoute: Route = async ({ req, res, path, method, url }) => {
  if (!(path === "/api/emotes/upload" && method === "POST")) return false;
  const mime = ((req.headers["content-type"] ?? "").split(";")[0] ?? "").trim().toLowerCase();
  const buffer = await readBinary(req, MAX_IMAGE_BYTES + 1024);
  try {
    const sniffed = sniffImageMime(buffer) || mime;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(sniffed)) {
      throw new Error("不是支持的图片格式（仅 png / jpg / webp / gif）");
    }
    const saved = saveImage(buffer, sniffed);
    const label = (url.searchParams.get("label") ?? "").trim();
    registerEmoteAsset(saved.url, label);
    sendJson(res, 200, { ok: true, url: saved.url, ...emoteStats() });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** POST /api/emotes/import：把本地文件夹里的图片一键入库（按内容 md5 去重，重扫不重复）。 */
const emotesImportRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/emotes/import" && method === "POST")) return false;
  let body: { dir?: unknown; tag?: unknown };
  try {
    body = await readJson<{ dir?: unknown; tag?: unknown }>(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
    return true;
  }
  const dir = typeof body.dir === "string" ? body.dir.trim() : "";
  if (dir === "") {
    sendJson(res, 400, { ok: false, error: "缺少 dir（要导入的本地文件夹路径）" });
    return true;
  }
  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  const result = importEmoteDir(dir, tag !== "" ? { tag } : undefined);
  if ("error" in result) {
    sendJson(res, 400, { ok: false, error: result.error });
    return true;
  }
  sendJson(res, 200, { ok: true, ...result, ...emoteStats() });
  return true;
};

type EmotePrefsBody = { autoCapture?: unknown };
/** POST /api/emotes/preferences：自动采集开关——他发来的图片是否顺手入库。默认关（见 config）。 */
const emotesPrefsRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/emotes/preferences" && method === "POST")) return false;
  let body: EmotePrefsBody;
  try {
    body = await readJson<EmotePrefsBody>(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
    return true;
  }
  if (body.autoCapture === undefined) {
    sendJson(res, 400, { ok: false, error: "缺少 autoCapture（true/false）" });
    return true;
  }
  setEmoteAutoCapture(body.autoCapture === true);
  sendJson(res, 200, { ok: true, autoCapture: emoteAutoCapture() });
  return true;
};

/** DELETE /api/emotes?url=：摘掉一个素材登记。文件本体有自己的回收通道，这里只动素材库。 */
const emotesDeleteRoute: Route = ({ res, path, method, url }) => {
  if (!(path === "/api/emotes" && method === "DELETE")) return false;
  const target = url.searchParams.get("url") ?? "";
  const removed = target !== "" && removeEmoteAsset(target);
  sendJson(res, 200, { ok: true, removed, ...emoteStats() });
  return true;
};

export const routes: Route[] = [
  emotesListRoute,
  emotesFacesRoute,
  emotesAddRoute,
  emotesUploadRoute,
  emotesImportRoute,
  emotesPrefsRoute,
  emotesDeleteRoute,
];
