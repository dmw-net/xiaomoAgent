// 前后端 HTTP 契约的唯一真源。
// 两端都只用 `import type` 引用：Node 的 type-stripping 与 esbuild 都会把这些
// 导入完全擦除，运行时不存在跨目录加载。
// 为什么要有这个文件：Phase 2 时前端手工猜过 `/api/say` 的返回结构（{turn} vs
// {turnId}），轮询整条链路静默挂掉。契约对齐不该靠两边注释互相指认。

/** messages 表对 HTTP 暴露的行形状（/api/messages 系列原样下发）。 */
export type MessageRow = {
  id: number;
  role: string;
  text: string;
  kind: string;
  contact_id: string | null;
  created_at: number;
  superseded_at: number | null;
  /** 'edit' 被编辑取代 | 'retract' 被撤回 | null 仍在对话里 */
  superseded_kind: string | null;
  /** 图片附件（"/media/…" 数组），无附件时为 null */
  attachments?: string[] | null;
  /** 归属处理单：占位认领与失败标记都靠它 */
  turn_id?: string | null;
  /**
   * 模型这一轮的思考原文（开了思考才有）。只用于气泡上的折叠回看：
   * 不进上下文回放、不进记忆抽取，且每联系人只保留最近若干条（滚出即 NULL）。
   */
  reasoning?: string | null;
  /**
   * 工具卡的可展开详情（仅 kind=tool）：这次搜到的条目 / 抓到的正文摘要 / 技能正文。
   * 只给界面点开回看，不进上下文回放，且每联系人只保留最近若干轮（滚出即 null）。
   */
  tool_detail?: string | null;
};

/** 处理单在 HTTP 面上的最小形状；/api/turns/recent 实际返回超集（含 text/reply）。 */
export type TurnSummary = {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
};

/**
 * 一份用户自定义技能在 HTTP 面上的形状（/api/skills 下发的就是扫描结果）。
 * 技能的真源是磁盘目录不是数据库，所以这里没有 id/created_at 这类行字段：
 * name 就是目录名，也是模型调 load_skill 用的参数。
 */
export type SkillEntry = {
  name: string;
  /** frontmatter 的 description；校验不过时可能为空。 */
  description: string;
  /** SKILL.md 所在目录（界面报位置用）。 */
  dir: string;
  /** 正文字数（不含 frontmatter）。 */
  chars: number;
  /** frontmatter 与文件都合规，能进模型可见的清单。 */
  valid: boolean;
  /** 被用户显式停用（与 valid 相互独立：一个坏技能也能被停用）。 */
  disabled: boolean;
  /** 不合规的原因，逐条说清；valid 时为空数组。 */
  problems: string[];
};
