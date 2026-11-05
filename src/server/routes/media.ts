// 媒体与语音：图片/语音/壁纸的二进制上传，语音识别（dataURL→文字），语音合成（文字→mp3）。

import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  deleteWallpaper,
  saveAudio,
  saveImage,
  saveWallpaper,
} from "../../media/media.ts";
import { friendlyModelError, synthesizeSpeech, transcribeAudio } from "../../settings/model.ts";
import {
  MAX_AUDIO_BODY_BYTES,
  readBinary,
  readJson,
  sendJson,
} from "../http.ts";
import type { Route } from "../types.ts";

/** 图片上传：请求体就是二进制（content-type 标 mime），返回 /media URL 供 /api/say 引用。
 *  单独走二进制而不是 JSON dataURL：32KB 的 JSON 上限对图片毫无意义。 */
const mediaImageRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/media")) return false;
  const mime = ((req.headers["content-type"] ?? "").split(";")[0] ?? "").trim().toLowerCase();
  const buffer = await readBinary(req, MAX_IMAGE_BYTES + 1024);
  try {
    const saved = saveImage(buffer, mime);
    sendJson(res, 200, { ok: true, ...saved });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** 语音消息上传：原始录音直接落盘，消息里只带 /media URL 与元信息。 */
const mediaVoiceRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/media/voice")) return false;
  const buffer = await readBinary(req, MAX_AUDIO_BYTES + 1024);
  try {
    const saved = saveAudio(buffer);
    sendJson(res, 200, { ok: true, ...saved });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** 壁纸上传：请求体是图片或视频二进制，落成 wp 前缀文件（引用在设备 localStorage，不在库里）。
 *  ?prev= 传旧壁纸 URL 时顺带删旧文件——换壁纸不该在盘上留一串没人认领的大视频。 */
const wallpaperUploadRoute: Route = async ({ req, res, url, path, method }) => {
  if (!(method === "POST" && path === "/api/wallpaper")) return false;
  const buffer = await readBinary(req, MAX_VIDEO_BYTES + 1024);
  try {
    const saved = saveWallpaper(buffer, "");
    const prev = url.searchParams.get("prev");
    if (prev) deleteWallpaper(decodeURIComponent(prev));
    sendJson(res, 200, { ok: true, ...saved });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

/** 壁纸删除：形状校验（wp 前缀）在 deleteWallpaper 里，普通聊天图片传进来会被直接忽略。 */
const wallpaperDeleteRoute: Route = ({ res, url, path, method }) => {
  if (!(method === "DELETE" && path === "/api/wallpaper")) return false;
  const url0 = url.searchParams.get("url");
  if (url0) deleteWallpaper(decodeURIComponent(url0));
  sendJson(res, 200, { ok: true });
  return true;
};

/** 语音识别：浏览器录音（dataURL）→ 文字。返回给输入框而不是直接发送——转错了用户还能改。 */
const asrRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/asr")) return false;
  const body = await readJson<{ audio?: unknown }>(req, MAX_AUDIO_BODY_BYTES);
  if (typeof body.audio !== "string" || body.audio === "") {
    sendJson(res, 400, { ok: false, error: "缺少 audio（dataURL）" });
    return true;
  }
  try {
    const text = await transcribeAudio(body.audio);
    sendJson(res, 200, { ok: true, text });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: friendlyModelError(error) });
  }
  return true;
};

/** 语音合成：消息文本 → mp3 dataURL。错误同样走 ok/error JSON，前端一套逻辑处理。 */
const ttsRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/tts")) return false;
  const body = await readJson<{ text?: unknown }>(req);
  try {
    const result = await synthesizeSpeech(typeof body.text === "string" ? body.text : "");
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: friendlyModelError(error) });
  }
  return true;
};

export const routes: Route[] = [
  mediaImageRoute,
  mediaVoiceRoute,
  wallpaperUploadRoute,
  wallpaperDeleteRoute,
  asrRoute,
  ttsRoute,
];
