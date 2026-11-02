/**
 * QQ 群消息响应方式回归。
 *
 * 闸门必须 fail-closed：默认档（仅 @）下，不 @ 的群消息一条都不能进处理队列——
 * 这是升级前就有的保护，改「接受方式」时不能顺手把它放开。新增的两档只在
 * 已登记且开收件的群上生效（会话查找在 handleInbound 里，先于这里）。
 *
 * 运行：node --experimental-sqlite scripts/qq-group-trigger.test.mjs
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "qq-trigger-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.MEDIA_DIR = join(dir, "media");
process.env.DATA_DIR = dir;

const { obGroupAccepted } = await import("../src/qq-onebot.ts");
const { normalizeQQGroupTriggerKeywords } = await import("../src/conversations.ts");

try {
  // ① 默认档：不 @ 的日常 chatter 一律不放行（改完接受方式也必须保持）。
  assert.equal(obGroupAccepted("at", "", "大家早", false), false, "仅 @：普通消息不放行");
  assert.equal(obGroupAccepted("at", "", "", false), false, "仅 @：纯表情/空正文不放行");
  // @ 永远算命中，与模式无关。
  assert.equal(obGroupAccepted("at", "", "", true), true, "仅 @：@ 了就算命中");
  assert.equal(obGroupAccepted("at", "", "在吗", true), true, "仅 @：@ + 正文");

  // ② 全部消息：模式语义就是全放；陌生群由 handleInbound 先查会话挡住。
  assert.equal(obGroupAccepted("all", "", "随便聊聊", false), true, "全部消息：不 @ 也放行");

  // ③ @ 或关键词：命中才放行；大小写不敏感，逗号/顿号/空格都认。
  assert.equal(obGroupAccepted("at_keyword", "小茉,在吗", "小茉出来", false), true, "关键词命中");
  assert.equal(obGroupAccepted("at_keyword", "小茉,在吗", "今天天气不错，在吗？", false), true, "长句里包含关键词");
  assert.equal(obGroupAccepted("at_keyword", "xiaomo、在吗", "Xiaomo 在不在", false), true, "英文大小写不敏感");
  assert.equal(obGroupAccepted("at_keyword", "小茉,在吗", "今天天气不错", false), false, "没命中不放行");
  // 空关键词表不能把整个群放进来（等于误开放）。
  assert.equal(obGroupAccepted("at_keyword", "", "随便说说", false), false, "空关键词表不放行");
  assert.equal(obGroupAccepted("at_keyword", " ,、", "随便说说", false), false, "只有分隔符的关键词表不放行");
  assert.equal(obGroupAccepted("at_keyword", "", "", true), true, "关键词模式下 @ 仍有效");

  // ④ 库里读到不认识的模式：按 fail-closed 处理，不能当成「全部消息」。
  assert.equal(obGroupAccepted("garbage", "", "随便说说", false), false, "未知模式不放行");
  assert.equal(obGroupAccepted("", "", "随便说说", false), false, "空模式不放行");

  // ⑤ 关键词落库归一：切分、去空、去重、截断，回显统一用逗号。
  assert.equal(normalizeQQGroupTriggerKeywords(" 小茉，在吗、在吗  出来 "), "小茉,在吗,出来", "切分去重");
  assert.equal(normalizeQQGroupTriggerKeywords("a,b;c\nd"), "a,b,c,d", "分号/换行也认");
  assert.equal(normalizeQQGroupTriggerKeywords(""), "", "空串保持空");
  assert.equal(normalizeQQGroupTriggerKeywords(" ,、; "), "", "只有分隔符归一为空");
  const many = normalizeQQGroupTriggerKeywords(Array.from({ length: 20 }, (_, i) => `k${i}`).join(" ")).split(",");
  assert.equal(many.length, 12, "关键词上限 12 个");
  assert.equal(normalizeQQGroupTriggerKeywords("长".repeat(50)), "长".repeat(30), "单个关键词截到 30 字");

  console.log("QQ 群响应方式回归：通过");
} finally {
  // Windows 上 sqlite 句柄要到进程退出才释放，删不掉不算失败（目录在系统临时区）。
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
}
