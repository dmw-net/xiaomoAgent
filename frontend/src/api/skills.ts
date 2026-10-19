import { getJson, postJson, putJson, deleteJson } from "./client";
import type { SkillContent, SkillEntry, SkillWriteResult } from "../types";

/** /api/skills 的形状：dir 是后端真实目录，界面上要照着报出来，用户才知道往哪儿放文件。 */
export type SkillList = { dir: string; skills: SkillEntry[] };

export function listSkills(): Promise<SkillList> {
  return getJson("/api/skills");
}

/** 停用 / 启用一份技能。停用是黑名单语义，改完下一轮对话立即生效，不用重启后端。 */
export function setSkillEnabled(name: string, enabled: boolean): Promise<SkillList> {
  return postJson("/api/skills/enabled", { name, enabled });
}

/** 读一份技能的 SKILL.md 原文。 */
export function getSkillContent(name: string): Promise<SkillContent> {
  return getJson(`/api/skills/${encodeURIComponent(name)}`);
}

/** 新建。同名已存在时后端拒绝（400），不会把原来那篇覆盖成白纸。 */
export function createSkill(name: string, content: string): Promise<SkillWriteResult> {
  return postJson("/api/skills", { name, content });
}

/** 覆盖写一份（新建或改内容都走它）。整份文件替换，不做局部合并。 */
export function updateSkill(name: string, content: string): Promise<SkillWriteResult> {
  return putJson(`/api/skills/${encodeURIComponent(name)}`, { content });
}

/** 删一份技能：连目录一起删。删掉再建同名的不会"复活成停用状态"（后端一并清了名单）。 */
export function deleteSkill(name: string): Promise<SkillWriteResult> {
  return deleteJson(`/api/skills/${encodeURIComponent(name)}`);
}
