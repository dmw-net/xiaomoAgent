// 表情包管理域：素材库（图片表情）的增删查、目录导入、单图上传、采集开关，
// 渠道能力探测与内置表情词表，以及「智能识别」的整库/单张语义作业。
//
// 为什么放 media 域之后：它消费的是媒体库（/media 图片），语义上紧贴媒体；
// 又属于"能力管理"，与设置页其它能力分区同层。路由只插表不改序（见 router.ts 顶部）。
//
// 纪律（与全表一致）：用 Ctx.path（不含 query）匹配、url.searchParams 取参数；
// 所有 /api/* 返回 JSON 且永远带 ok 字段，前端只靠 ok 判断成败。

import { emoteNamingStats, isHumanName } from "../../assets.ts";
import { namingJobStatus, renameEmoteById, startNamingJob } from "../../emote-naming.ts";
import { MAX_IMAGE_BYTES, saveImage, sniffImageMime } from "../../media.ts";
import {
  emoteAutoCapture,
  emoteCapabilities,
  emoteStats,
  faceKeywords,
  importEmoteDir,
  registerEmoteAsset,
  removeEmoteAsset,
  setEmoteAutoCapture,
} from "../../qq-emote.ts";
import { readBinary, readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** GET /api/emotes：渠道能力探测 + 采集开关 + 张数。
 *  库里的东西本身走 /api/assets（媒体库那一页），这里不再列第二份清单——
 *  两处都能列，就早晚会出现「一边显中文名一边显句柄」那种对不上。 */
const emotesListRoute: Route = ({ res, path, method }) => {
  if (!(path === "/api/emotes" && method === "GET")) return false;
  sendJson(res, 200, {
    ok: true,
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
  registerEmoteAsset(url, { label, tags, ...(isHumanName(label) ? { namedAt: Date.now() } : {}) }, "upload");
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
    // 上传时给的是中文名就算认过图了（不必再让视觉模型猜一次她刚说过的话）；
    // 没给或给的是英文句柄就留空，等「智能识别」。
    registerEmoteAsset(saved.url, label === "" ? {}
      : { label, tags: [label], ...(isHumanName(label) ? { namedAt: Date.now() } : {}) }, "upload");
    sendJson(res, 200, { ok: true, url: saved.url, ...emoteStats() });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** POST /api/emotes/import：把本地文件夹里的图片一键入库（按内容 md5 去重，重扫不重复）。 */
const emotesImportRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/emotes/import" && method === "POST")) return false;
  let body: { dir?: unknown };
  try {
    body = await readJson<{ dir?: unknown }>(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
    return true;
  }
  const dir = typeof body.dir === "string" ? body.dir.trim() : "";
  if (dir === "") {
    sendJson(res, 400, { ok: false, error: "缺少 dir（要导入的本地文件夹路径）" });
    return true;
  }
  const result = importEmoteDir(dir);
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

/** GET /api/emotes/naming：认图作业进度。界面轮询这一个，不重复起作业。 */
const emoteNamingStatusRoute: Route = ({ res, path, method }) => {
  if (!(path === "/api/emotes/naming" && method === "GET")) return false;
  sendJson(res, 200, { ok: true, job: namingJobStatus(), naming: emoteNamingStats() });
  return true;
};

/**
 * POST /api/emotes/naming：让她把未命名的表情逐张看一遍，补上中文名与用法。
 * 作业在后台跑，这个请求立刻返回（跑完 200 张要几分钟，让 HTTP 挂着的收益是零）。
 * `force=true` 才重认已经认过的——那是「整库重命名」，会盖掉她手改过的名字，所以默认不给。
 */
const emoteNamingStartRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/emotes/naming" && method === "POST")) return false;
  let body: { force?: unknown; only?: unknown };
  try {
    body = await readJson<{ force?: unknown; only?: unknown }>(req);
  } catch {
    body = {};
  }
  const only = Array.isArray(body.only) ? body.only.filter((v): v is string => typeof v === "string") : undefined;
  const result = startNamingJob({ force: body.force === true, ...(only !== undefined ? { only } : {}) });
  sendJson(res, 200, { ok: true, ...result, job: namingJobStatus(), naming: emoteNamingStats() });
  return true;
};

/** POST /api/emotes/naming/one：识别这一张（弹窗里那颗「智能识别」）。成功时把写回的字段整个带回，弹窗原地展示结果。 */
const emoteNamingOneRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/emotes/naming/one" && method === "POST")) return false;
  let body: { id?: unknown };
  try {
    body = await readJson<{ id?: unknown }>(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
    return true;
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (id === "") {
    sendJson(res, 400, { ok: false, error: "缺少 id（要重认的那一张）" });
    return true;
  }
  const result = await renameEmoteById(id);
  sendJson(res, 200, result.ok
    ? { ok: true, id, name: result.name, caption: result.caption, tags: result.tags, naming: emoteNamingStats() }
    : { ok: false, error: result.error });
  return true;
};

export const routes: Route[] = [
  emotesListRoute,
  emotesFacesRoute,
  emotesAddRoute,
  emotesUploadRoute,
  emotesImportRoute,
  emotesPrefsRoute,
  emoteNamingStatusRoute,
  emoteNamingStartRoute,
  emoteNamingOneRoute,
  emotesDeleteRoute,
];
