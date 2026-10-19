// 生成产物台账：她画出来的每一张图，在**文件落盘的那一刻**就被记下来。
//
// 为什么需要这张表（2026-09-28 的真实事故）：图原本只活在 `messages.attachments` 里，
// 而"画成功"和"消息落地"是两个时刻——中间只要发生打断、重试、取消、服务重启，
// 文件就留在媒体目录里没有任何人引用它，下一次维护清理直接删掉。用户端的表现是
// 「她说明画好了，但什么都没有」，而且事后无处可查。两张已经画成的自拍就是这么丢的。
//
// 三条纪律：
// 1) 记账不依赖消息：generateImage 成功即写，contact_id 允许为空（记录本身的首要职责是
//    让清理器认得这个文件，能出现在画廊里只是附带好处）。
// 2) 删图只有这一条路：删掉 artifact 行才释放文件。删消息不释放——消息是历史，
//    画是资产，两者的生命周期不该绑在一起。
// 3) 任何新增的"存 /media 路径"的字段都要同时进 media.ts 的 sweepOrphanMedia 引用集，
//    这张表也一样（见该函数里的引用源清单）。

import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { releaseMediaFiles } from "./media.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS artifacts (
  id             TEXT PRIMARY KEY,
  contact_id     TEXT NOT NULL DEFAULT '',
  turn_id        TEXT,
  kind           TEXT NOT NULL DEFAULT 'image',
  url            TEXT NOT NULL,
  prompt         TEXT NOT NULL DEFAULT '',
  revised_prompt TEXT NOT NULL DEFAULT '',
  with_reference INTEGER NOT NULL DEFAULT 0,
  shape          TEXT NOT NULL DEFAULT '',
  starred        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
-- 画廊按联系人过滤、按时间倒序翻页。id 是 uuid，排它等于随机序，所以必须走 created_at。
CREATE INDEX IF NOT EXISTS idx_artifacts_contact_time ON artifacts (contact_id, created_at DESC);
`);

export type Artifact = {
  id: string;
  contactId: string;
  turnId: string | null;
  kind: string;
  url: string;
  prompt: string;
  revisedPrompt: string;
  withReference: boolean;
  shape: string;
  starred: boolean;
  createdAt: number;
};

type Row = {
  id: string; contact_id: string; turn_id: string | null; kind: string; url: string;
  prompt: string; revised_prompt: string; with_reference: number; shape: string;
  starred: number; created_at: number;
};

const toArtifact = (r: Row): Artifact => ({
  id: r.id,
  contactId: r.contact_id,
  turnId: r.turn_id,
  kind: r.kind,
  url: r.url,
  prompt: r.prompt,
  revisedPrompt: r.revised_prompt,
  withReference: r.with_reference === 1,
  shape: r.shape,
  starred: r.starred === 1,
  createdAt: r.created_at,
});

/** 记一笔产物。返回 id；这是"文件从此有了主人"的那一刻。 */
export function recordArtifact(input: {
  url: string;
  contactId?: string | null;
  turnId?: string | null;
  prompt?: string;
  revisedPrompt?: string;
  withReference?: boolean;
  shape?: string;
  kind?: string;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO artifacts (id, contact_id, turn_id, kind, url, prompt, revised_prompt, with_reference, shape, starred, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    input.contactId ?? "",
    input.turnId ?? null,
    input.kind ?? "image",
    input.url,
    (input.prompt ?? "").slice(0, 2000),
    (input.revisedPrompt ?? "").slice(0, 2000),
    input.withReference ? 1 : 0,
    (input.shape ?? "").slice(0, 24),
    Date.now(),
  );
  return id;
}

export function getArtifact(id: string): Artifact | null {
  const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
  return row ? toArtifact(row) : null;
}

/** 按联系人列画廊：最新在前，带 total 给分页用（与调用记录/记忆清单同一口径）。 */
export function listArtifacts(contactId: string, limit: number, offset: number): { items: Artifact[]; total: number } {
  const items = (db.prepare(
    "SELECT * FROM artifacts WHERE contact_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  ).all(contactId, limit, offset) as Row[]).map(toArtifact);
  const total = (db.prepare("SELECT COUNT(*) n FROM artifacts WHERE contact_id = ?").get(contactId) as { n: number }).n;
  return { items, total };
}

export function setArtifactStarred(id: string, on: boolean): boolean {
  db.prepare("UPDATE artifacts SET starred = ? WHERE id = ?").run(on ? 1 : 0, id);
  return getArtifact(id)?.starred === true;
}

/**
 * 删掉一条资产并释放它的文件——这是唯一会让画消失的路径。
 * 返回被释放的路径，调用方好如实告诉用户"文件也删了"。
 */
export function deleteArtifact(id: string): { ok: boolean; url: string | null } {
  const row = getArtifact(id);
  if (!row) return { ok: false, url: null };
  db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  releaseMediaFiles([row.url]);
  return { ok: true, url: row.url };
}

/**
 * 这个 /media 路径是不是某张资产的原件。
 * 换长相参考时要用它把一下关：旧参考图如果本身是她画出来的（在画廊里），
 * 顺手释放文件就会让画廊里那一格变成打不开的 404——画的生死只该由"删资产"决定。
 */
export function isArtifactUrl(url: string): boolean {
  if (url === "") return false;
  return (db.prepare("SELECT COUNT(*) n FROM artifacts WHERE url = ?").get(url) as { n: number }).n > 0;
}

/** 资料页顶部那个缩略位用：这个联系人一共有几张、其中几张被标了星。 */
export function artifactSummary(contactId: string): { total: number; starred: number; withReference: number } {
  const r = db.prepare(`
    SELECT COUNT(*) total, COALESCE(SUM(starred), 0) starred, COALESCE(SUM(with_reference), 0) with_reference
    FROM artifacts WHERE contact_id = ?`).get(contactId) as { total: number; starred: number; with_reference: number };
  return { total: r.total, starred: r.starred, withReference: r.with_reference };
}
