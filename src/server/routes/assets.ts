// 资产：一个页面要的全部。
//
// 视角（全部 / 表情包 / 收藏 / 作品 / 聊天）是参数，不是五个功能；联系人也是参数——
// 「联系人的东西」本来就是全局库，「和某人」只是在这堆东西上多带一个条件。
// 以前这里是三套各查各源的接口（/api/content 按联系人、/api/emotes 读 kv、/api/media/maintenance 扫盘），
// 同一个动作在三处各有一份实现，删除语义也对不上。
//
// 纪律（与全表一致）：用 Ctx.path（不含 query）匹配、url.searchParams 取参数；
// 所有 /api/* 返回 JSON 且永远带 ok 字段，前端只靠 ok 判断成败。

import {
  applyEmoteSemantics, assetStats, dropMissingAsset, emoteNamingStats, getAssetById, isHumanName, listAssets, listEmotePacks,
  markMissingIfGone, setEmoteMark, setStarred,
  type AssetKindFilter, type AssetView, type EmoteNamedFilter,
} from "../../media/assets.ts";
import { removeEmoteAsset, registerEmoteAsset } from "../../emote/qq-emote.ts";
import { mediaDir } from "../../media/media.ts";
import { clampInt, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

const VIEWS: string[] = ["all", "emote", "starred", "generated", "chat"];
const KINDS: string[] = ["all", "image", "video", "audio", "file"];
const NAMED_FILTERS: string[] = ["any", "unnamed", "file", "auto", "manual"];

/**
 * GET /api/assets?view=&kind=&q=&pack=&contactId=&limit=&offset=
 * contactId 是**可选筛选**而不是必传身份：不给就是全库（「联系人的东西」本来就是全局的），
 * 给了就是「和某人」这个视角。这一点和 /api/content 的 strictContactId 不同，是刻意的。
 * pack 只在表情视角有意义：按文件夹筛（文件夹名不参与语义匹配，但可以是筛选条件）。
 */
const assetsListRoute: Route = ({ res, url, path, method }) => {
  if (!(path === "/api/assets" && method === "GET")) return false;
  const rawView = url.searchParams.get("view") ?? "all";
  const view = (VIEWS.includes(rawView) ? rawView : "all") as AssetView;
  const rawKind = url.searchParams.get("kind") ?? "all";
  const kind = (KINDS.includes(rawKind) ? rawKind : "all") as AssetKindFilter;
  const rawNamed = url.searchParams.get("named") ?? "any";
  const named = (NAMED_FILTERS.includes(rawNamed) ? rawNamed : "any") as EmoteNamedFilter;
  const data = listAssets({
    contactId: url.searchParams.get("contactId") ?? "",
    view,
    kind,
    q: url.searchParams.get("q") ?? "",
    pack: url.searchParams.get("pack") ?? "",
    named,
    missing: url.searchParams.get("missing") === "1",
    limit: clampInt(url.searchParams.get("limit"), LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX),
    offset: clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
  });
  sendJson(res, 200, {
    ok: true, view, kind, ...data, stats: assetStats(), naming: emoteNamingStats(), packs: listEmotePacks(),
    // 桌面端「在文件管理器中显示」要拼绝对路径；浏览器视角用不到，多给一个只读字符串。
    mediaDir: mediaDir(),
  });
  return true;
};

type ActionBody = {
  op?: unknown; id?: unknown; label?: unknown; tags?: unknown; caption?: unknown; pack?: unknown; alias?: unknown;
};

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : undefined;

/**
 * POST /api/assets：打/摘「表情包」标记、收藏、改一张表情的中文名与标签。
 * 只动资产自己的标记，不碰文件——文件本体有没有人用、该不该进回收站，是媒体清理那条线的判断。
 */
const assetsActionRoute: Route = async ({ req, res, path, method }) => {
  if (!(path === "/api/assets" && method === "POST")) return false;
  let body: ActionBody;
  try {
    body = await readJson<ActionBody>(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
    return true;
  }
  const op = typeof body.op === "string" ? body.op : "";
  const id = typeof body.id === "string" ? body.id : "";
  const asset = id === "" ? null : getAssetById(id);
  if (asset === null) {
    sendJson(res, 404, { ok: false, error: "资产不存在（可能已被清理）" });
    return true;
  }
  if (op === "markEmote") {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const tags = stringList(body.tags);
    if (label === "" && (tags === undefined || tags.length === 0)) {
      // 界面上那颗笑脸是开关：没带名字标签就只翻标记，别把已认好的语义洗掉。
      setEmoteMark(asset.url, true);
    } else {
      registerEmoteAsset(asset.url, { label, ...(tags !== undefined ? { tags } : {}),
        ...(isHumanName(label) ? { namedAt: Date.now(), namedBy: "manual" } : {}) });
    }
  } else if (op === "unmarkEmote") {
    removeEmoteAsset(asset.url);
  } else if (op === "editEmote") {
    // 联系人手改的名字/说法就是数据本体：写回同一批语义字段，并标成 manual——
    // 人写过的东西优先于再猜一次，界面上也要能一眼看出哪些还是机器起的。
    if (!asset.usableAsEmote) {
      sendJson(res, 400, { ok: false, error: "这张不是表情包素材，没有表情语义可改" });
      return true;
    }
    const label = typeof body.label === "string" ? body.label.trim() : undefined;
    applyEmoteSemantics(asset.url, {
      ...(label !== undefined ? { label } : {}),
      ...(stringList(body.tags) !== undefined ? { tags: stringList(body.tags)! } : {}),
      ...(typeof body.caption === "string" ? { caption: body.caption.trim() } : {}),
      ...(stringList(body.alias) !== undefined ? { alias: stringList(body.alias)! } : {}),
      ...(stringList(body.pack) !== undefined ? { pack: stringList(body.pack)! } : {}),
      namedAt: Date.now(),
      namedBy: "manual",
    });
  } else if (op === "moveEmote") {
    // 只改文件夹归属，不把“移动”误记成一次手动命名；磁盘位置由 applyEmoteSemantics 同步。
    if (!asset.usableAsEmote) {
      sendJson(res, 400, { ok: false, error: "这张不是表情包素材，不能移动表情文件夹" });
      return true;
    }
    const pack = stringList(body.pack);
    if (pack === undefined || pack.length === 0 || pack[0]!.trim() === "") {
      sendJson(res, 400, { ok: false, error: "缺少目标文件夹" });
      return true;
    }
    applyEmoteSemantics(asset.url, { pack });
  } else if (op === "star") {
    setStarred(asset.id, true);
  } else if (op === "unstar") {
    setStarred(asset.id, false);
  } else if (op === "probeMissing") {
    // 界面动作撞见「文件没了」时的就地验真：标上失效，清理按钮当场出现，不用等下一轮对账。
    const marked = markMissingIfGone(asset.id);
    sendJson(res, 200, { ok: true, marked, asset: getAssetById(asset.id), stats: assetStats(), naming: emoteNamingStats() });
    return true;
  } else if (op === "dropMissing") {
    // 用户在磁盘里删了文件 → 界面上收掉这条死账。文件还在的行删不动：删除走回收站那条线。
    if (!asset.missing) {
      sendJson(res, 400, { ok: false, error: "原图还在盘上，这条不是失效项；要删它请走媒体清理（回收站）" });
      return true;
    }
    dropMissingAsset(asset.id);
    sendJson(res, 200, { ok: true, asset: null, stats: assetStats(), naming: emoteNamingStats(), packs: listEmotePacks() });
    return true;
  } else {
    sendJson(res, 400, { ok: false, error: "op 只支持 markEmote / unmarkEmote / editEmote / moveEmote / probeMissing / dropMissing / star / unstar" });
    return true;
  }
  const next = getAssetById(asset.id);
  sendJson(res, 200, { ok: true, asset: next, stats: assetStats(), naming: emoteNamingStats() });
  return true;
};

export const routes: Route[] = [assetsListRoute, assetsActionRoute];
