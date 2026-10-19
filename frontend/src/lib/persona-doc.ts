/** 人格文档的构建/解析/导出——分栏编辑器与 Markdown 视图共用同一套标题，round-trip 安全。 */

export type PersonaDraft = {
  name: string;
  background: string;
  identity: string;
  relationship: string;
};

/** 书写约定：以「我」（用户）的口吻写，「你」指这位联系人（对齐原项目的 user.md「关于我」）。 */
export const TEMPLATE: Omit<PersonaDraft, "name"> = {
  background: "你们认识有一段时间了，关系熟悉、放松。常见场景：下班后的闲聊、加班吐槽、周末吃饭计划。",
  identity: "你是小茉，我从大学社团认识的学姐。比我大两岁，说话不紧不慢，偶尔毒舌但心软。\n\n说话：短句为主，一次说一两件事；不用 emoji，不说教，不端着。\n\n相处约束：\n- 记得住事：我提过的偏好、答应过的事，你都会自然地带出来。\n- 不装懂：不确定就说不确定，不要编。",
  relationship: "认识三年了，现在是无话不谈的朋友。我忙起来会消失几天，但回来一定找你聊。平时叫我「阿樟」。",
};

const SECTIONS: Array<{ key: "background" | "identity" | "relationship"; title: string }> = [
  { key: "background", title: "背景" },
  { key: "identity", title: "人设" },
  { key: "relationship", title: "与用户关系" },
];

export function buildMd(draft: PersonaDraft): string {
  const lines = ["# " + (draft.name || "联系人") + " · 人格文档", ""];
  for (const { key, title } of SECTIONS) {
    lines.push("## " + title, "", draft[key].trim() || "（待补充）", "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function parseMd(md: string): Omit<PersonaDraft, "name"> {
  const next = { background: "", identity: "", relationship: "" };
  for (let i = 0; i < SECTIONS.length; i++) {
    const sec = SECTIONS[i];
    if (!sec) continue;
    const start = md.indexOf("## " + sec.title);
    if (start < 0) continue;
    const bodyStart = start + sec.title.length + 3;
    let end = md.length;
    for (let j = i + 1; j < SECTIONS.length; j++) {
      const other = SECTIONS[j];
      const e = other ? md.indexOf("## " + other.title, bodyStart) : -1;
      if (e >= 0) { end = e; break; }
    }
    const body = md.slice(bodyStart, end).trim();
    next[sec.key] = body === "（待补充）" ? "" : body;
  }
  return next;
}

/** 从导出的 md 首行（"# 名字 · 人格文档"）提取联系人名；解析不出返回空串。 */
export function parseNameFromMd(md: string): string {
  const m = md.match(/^#\s*(.+?)\s*(?:·\s*人格文档)?\s*$/m);
  if (!m) return "";
  const raw = m[1] ?? "";
  return raw.trim() === "联系人" ? "" : raw.replace(/\s*·\s*人格文档$/, "").trim();
}

export function exportPersonaMd(name: string, draft: PersonaDraft): void {
  const md = [
    "# " + (name || "联系人") + " · 人格文档",
    "",
    buildMd(draft).split("\n").slice(1).join("\n"),
    "---",
    "导出自小茉 · " + new Date().toLocaleString("zh-CN"),
  ].join("\n");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (name || "联系人") + "-人格文档.md";
  a.click();
  URL.revokeObjectURL(a.href);
}
