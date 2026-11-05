// 面向普通用户的只读运行检查。
//
// 这里刻意不暴露模型请求体、系统提示词或数据库原文：它回答的是"这台机器现在是否健康"，
// 而不是给开发者做逐帧排障。更细的调用原文仍由 DEV_MODE 控制。

import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { scanOrphanMedia } from "../media/media.ts";
import { outboundSummary } from "../channels/outbound.ts";

export type DiagnosticLevel = "ok" | "warn" | "bad";

export type DiagnosticCheck = {
  id: string;
  label: string;
  level: DiagnosticLevel;
  summary: string;
  detail?: string;
  /** 给界面决定下一步跳到哪里，不在后端拼 UI 文案。 */
  action?: "backup" | "storage" | "activity" | "settings" | "media" | "outbound";
};

export type UserDiagnostics = {
  checkedAt: number;
  level: DiagnosticLevel;
  checks: DiagnosticCheck[];
};

const worst = (a: DiagnosticLevel, b: DiagnosticLevel): DiagnosticLevel => {
  const rank: DiagnosticLevel[] = ["ok", "warn", "bad"];
  return rank[Math.max(rank.indexOf(a), rank.indexOf(b))] ?? "bad";
};

/** 显式执行；不要在页面每帧调用。检查会读目录并跑 SQLite quick_check。 */
export function runUserDiagnostics(): UserDiagnostics {
  const checks: DiagnosticCheck[] = [];
  const dbPath = resolve(config.dbPath);

  try {
    const stat = statSync(dbPath);
    accessSync(dbPath, constants.R_OK | constants.W_OK);
    const quick = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    const integrity = quick?.quick_check ?? "unknown";
    checks.push({
      id: "database",
      label: "数据库",
      level: integrity === "ok" ? "ok" : "bad",
      summary: integrity === "ok" ? `读写正常 · ${(stat.size / 1024 / 1024).toFixed(1)} MB` : "完整性检查未通过",
      detail: integrity === "ok" ? dbPath : `${dbPath}\n${integrity}`,
      action: integrity === "ok" ? undefined : "backup",
    });
  } catch (error) {
    checks.push({
      id: "database",
      label: "数据库",
      level: "bad",
      summary: "数据库无法读写",
      detail: error instanceof Error ? error.message : String(error),
      action: "storage",
    });
  }

  const stuck = (db.prepare(
    "SELECT COUNT(*) AS n FROM turns WHERE status IN ('queued', 'running') AND created_at < ?",
  ).get(Date.now() - 10 * 60_000) as { n: number }).n;
  checks.push({
    id: "stuck-turns",
    label: "回复任务",
    level: stuck === 0 ? "ok" : "warn",
    summary: stuck === 0 ? "没有卡住超过 10 分钟的任务" : `${stuck} 个任务超过 10 分钟仍未完成`,
    detail: stuck === 0 ? undefined : "服务重启时会把遗留任务标记为失败；如持续出现，请导出诊断并检查模型连通性。",
    action: stuck === 0 ? undefined : "activity",
  });

  const orphanTasks = (db.prepare(
    `SELECT COUNT(*) AS n FROM proactive_tasks
     WHERE status = 'pending' AND contact_id IS NOT NULL
       AND contact_id NOT IN (SELECT id FROM contacts)`,
  ).get() as { n: number }).n;
  checks.push({
    id: "orphan-tasks",
    label: "主动计划",
    level: orphanTasks === 0 ? "ok" : "warn",
    summary: orphanTasks === 0 ? "没有孤立计划" : `${orphanTasks} 条计划指向已删除的联系人`,
    detail: orphanTasks === 0 ? undefined : "这些计划不会执行，可安全忽略；后续清理会回收。",
  });

  const outbound = outboundSummary();
  const outboundReason = outbound.dead > 0
    ? `${outbound.dead} 条消息进入死信队列，没有送达`
    : outbound.open > 0
      ? `${outbound.open} 条消息仍在投递或等待重试`
      : "投递队列没有积压";
  checks.push({
    id: "outbound",
    label: "消息投递",
    level: outbound.dead > 0 ? "bad" : outbound.open > 0 ? "warn" : "ok",
    summary: outboundReason,
    detail: outbound.dead > 0
      ? "打开「活动记录 → 投递队列」查看失败原因；可以先重试，确认不会再发就忽略。"
      : outbound.open > 0
        ? "系统会自动重试；如果长时间没有进展，打开「活动记录 → 投递队列」查看。"
        : undefined,
    action: outbound.dead > 0 || outbound.open > 0 ? "outbound" : undefined,
  });

  try {
    const media = scanOrphanMedia();
    const orphanCount = media.items.length;
    const summary = media.files === 0
      ? "还没有媒体文件"
      : orphanCount === 0
        ? `${media.files} 个文件 · 没有可清理项`
        : `${media.files} 个文件 · ${orphanCount} 个可清理`;
    const detail = orphanCount > 0
      ? "这些文件超过 24 小时没有被聊天、头像、参考图或作品引用。查看后可以批量移到回收站，7 天内可恢复。"
      : media.pending > 0
        ? `另有 ${media.pending} 个刚上传或刚生成的文件还在保护期内，满 24 小时后才会进入可清理列表。`
        : undefined;
    checks.push({
      id: "media",
      label: "图片、视频与语音",
      level: orphanCount === 0 ? "ok" : "warn",
      summary,
      detail,
      action: orphanCount === 0 ? undefined : "media",
    });
  } catch (error) {
    checks.push({
      id: "media",
      label: "图片、视频与语音",
      level: "warn",
      summary: "媒体目录暂时无法读取",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const level = checks.reduce<DiagnosticLevel>((acc, check) => worst(acc, check.level), "ok");
  return { checkedAt: Date.now(), level, checks };
}
