// 用户自定义技能：磁盘目录就是真源，但用户不必为此去翻文件管理器——这一组接口让用户能在应用里
// 新建 / 改内容 / 删除，写下去的仍是同一批文件、过的仍是 inspect() 那一道闸门。
// 改完立即生效（每轮现扫，不用重启后端）。
//
// 顺序敏感：/api/skills/enabled 必须先于 /api/skills/<name> 匹配——"enabled" 也长得像一个
// 技能名，顺序一反，停用/启用就再也调不到一个叫 enabled 的技能（后端也拒建这个名字）。

import {
  deleteSkill,
  listSkills,
  MAX_SKILL_FILE_BYTES,
  readSkill,
  saveSkill,
  setSkillEnabled,
  skillsDir,
} from "../../mind/skills.ts";
import { readJson, sendJson } from "../http.ts";
import type { Route } from "../types.ts";

/** 列表：设置页「技能」分区的数据源。 */
const skillsListRoute: Route = ({ res, path, method }) => {
  if (!(method === "GET" && path === "/api/skills")) return false;
  sendJson(res, 200, { ok: true, dir: skillsDir(), skills: listSkills() });
  return true;
};

/** 停用 / 启用一个技能。 */
const skillsEnabledRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/skills/enabled")) return false;
  const body = await readJson<{ name?: unknown; enabled?: unknown }>(req);
  const name = typeof body.name === "string" ? body.name : "";
  if (name.trim() === "") {
    sendJson(res, 400, { ok: false, error: "技能名不能为空" });
    return true;
  }
  if (!setSkillEnabled(name.trim(), body.enabled === true)) {
    // 目录在这之后被删掉/改名时会落到这里：报错而不是假装改成功了。
    sendJson(res, 404, { ok: false, error: `没有这个技能「${name.trim()}」，列表可能已经变了，重新载入看看` });
    return true;
  }
  sendJson(res, 200, { ok: true, dir: skillsDir(), skills: listSkills() });
  return true;
};

/** /api/skills/<name>：按名字寻址的三件事（读原文 / 覆盖写 / 删目录）。
 *  名字寻址先按形态筛一遍：技能名就是目录名，只用小写字母数字_-，对不上的路径不值得为它跑一次解码。 */
const skillByNameRoute: Route = async ({ req, res, path, method }) => {
  const m = /^\/api\/skills\/([a-z0-9][a-z0-9_-]{0,39})$/.exec(path);
  if (m === null) return false;
  const [, encoded = ""] = m;
  const name = decodeURIComponent(encoded);
  if (method === "GET") {
    const read = readSkill(name);
    if (!read.ok) {
      sendJson(res, 404, { ok: false, error: read.error });
      return true;
    }
    sendJson(res, 200, { ok: true, name: read.name, content: read.content });
    return true;
  }
  if (method === "PUT") {
    // 一篇技能最多 24000 字，汉字 3 字节一字 → 通用 32KB 上限会在校验前就误杀，
    // 所以这里显式放大到 MAX_SKILL_FILE_BYTES（skills.ts 里有这道数字的来历）。
    const body = await readJson<{ content?: unknown }>(req, MAX_SKILL_FILE_BYTES);
    const content = typeof body.content === "string" ? body.content : "";
    if (content.trim() === "") {
      sendJson(res, 400, { ok: false, error: "技能内容不能为空" });
      return true;
    }
    const saved = saveSkill(name, content, "overwrite");
    if (!saved.ok) {
      sendJson(res, 400, { ok: false, error: saved.error });
      return true;
    }
    // 落盘成功 ≠ 生效：闸门的结论在 saved 里，界面据此决定是收起编辑器还是接着改。
    sendJson(res, 200, { ok: true, dir: skillsDir(), skills: listSkills(), saved: saved.saved });
    return true;
  }
  if (method === "DELETE") {
    const gone = deleteSkill(name);
    if (!gone.ok) {
      sendJson(res, 404, { ok: false, error: gone.error });
      return true;
    }
    sendJson(res, 200, { ok: true, dir: skillsDir(), skills: listSkills(), deleted: gone.name });
    return true;
  }
  // 未知方法落在技能名路径上：不接住，留给 404（与原顺序 if 链落空同形）。
  return false;
};

/** 新建一篇技能：create 而不是 overwrite——已存在同名目录时拒绝，别把用户改好的那篇换成白纸。 */
const skillsCreateRoute: Route = async ({ req, res, path, method }) => {
  if (!(method === "POST" && path === "/api/skills")) return false;
  const body = await readJson<{ name?: unknown; content?: unknown }>(req, MAX_SKILL_FILE_BYTES);
  const name = typeof body.name === "string" ? body.name : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (name.trim() === "") {
    sendJson(res, 400, { ok: false, error: "技能名不能为空" });
    return true;
  }
  if (content.trim() === "") {
    sendJson(res, 400, { ok: false, error: "技能内容不能为空" });
    return true;
  }
  const saved = saveSkill(name, content, "create");
  if (!saved.ok) {
    sendJson(res, 400, { ok: false, error: saved.error });
    return true;
  }
  sendJson(res, 200, { ok: true, dir: skillsDir(), skills: listSkills(), saved: saved.saved });
  return true;
};

export const routes: Route[] = [
  skillsListRoute,
  skillsEnabledRoute,
  skillByNameRoute,
  skillsCreateRoute,
];
