// 一键诊断：npm run doctor
//
// 存在的理由：模型接不通时报错往往只有一句 "This operation was aborted"，
// 看不出是网络、密钥、模型名还是协议问题。这个命令把整条链路逐段测一遍，
// 并直接给出「哪个模型可用」「下一步改什么」。
//
// 实测背景：某些服务商（例如本项目在用的 Agnes）对"没有可用渠道的模型名"不返回错误，
// 而是让请求一直挂着直到超时。所以这里必须逐个模型真打一次请求，光看 /models 列表不够。

import { config } from "./config.ts";
import { db } from "./db.ts";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { modelConfig, modelReadyNow, settingsSnapshot } from "./settings.ts";
import { isChatModelId, listModels, pingChat, type ModelError } from "./model.ts";
import { modelFailureCount, recentModelCalls } from "./logs.ts";

const OK = "✓";
const WARN = "⚠";
const BAD = "✗";

function line(): void {
  console.log("──────────────────────────────────────────────");
}

function maskKey(key: string): string {
  if (key === "") return "（空）";
  if (key.length <= 8) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 6)}…${key.slice(-4)}（${key.length} 字符）`;
}

function classify(id: string): "chat" | "image" | "video" | "audio" | "other" {
  const lower = id.toLowerCase();
  if (isChatModelId(id)) return "chat";
  if (lower.includes("image") || lower.includes("dall") || lower.includes("sd")) return "image";
  if (lower.includes("video")) return "video";
  if (lower.includes("tts") || lower.includes("asr") || lower.includes("voice") || lower.includes("audio")) return "audio";
  return "other";
}

function printError(error: ModelError): void {
  console.log(`    原因：${error.message}`);
  if (error.causeDetail) console.log(`    细节：${error.causeDetail}`);
  console.log(`    耗时：${error.elapsedMs}ms`);
}

console.log("\n小茉 AI · 连接诊断");
line();

console.log("\n[1/4] 配置（应用内设置优先于 .env）");
{
  const snapshot = settingsSnapshot();
  const model = modelConfig();
  const ready = modelReadyNow(model);
  console.log(`  模式        ${model.mode}${ready ? "" : "  ← 未启用真实模型（mode=openai 且填了密钥才会启用）"}`);
  console.log(`  接口地址    ${model.baseUrl}`);
  console.log(`  模型名      ${model.name}`);
  console.log(`  密钥        ${maskKey(snapshot.model.apiKey)}`);
  console.log(`  超时        ${model.timeoutMs}ms`);
  console.log(`  额外参数    ${JSON.stringify(model.extraBody)}`);
  if (snapshot.overridden.model.length > 0) {
    console.log(`  已覆盖      ${snapshot.overridden.model.join(", ")}  ← 来自应用内设置（/settings）`);
  }
  console.log(`  角色卡      ${snapshot.persona.character.name}${snapshot.overridden.persona.length > 0 ? `（已自定义 ${snapshot.overridden.persona.length} 项）` : ""}`);

  if (!ready) {
    console.log(`\n${WARN} 当前是 echo 模式，不会真正调用模型。`);
    console.log("  两种改法：");
    console.log("    - 打开应用里的 /settings 页面填（立刻生效，推荐）");
    console.log("    - 或改 .env 的 MODEL_MODE=openai 并填好 MODEL_API_KEY");
    dataCheck();
    console.log("");
    process.exit(0);
  }
}

console.log("\n[2/4] 连通性与鉴权（GET /models，10 秒超时）");
const listed = await listModels(10_000);
if (!listed.ok) {
  console.log(`  ${BAD} 拉取模型列表失败`);
  printError(listed.error);
  console.log("\n  下一步：");
  if (listed.error.code === "AUTH") console.log("    - 密钥无效或额度用尽，检查 MODEL_API_KEY");
  else if (listed.error.code === "NETWORK") console.log("    - 网络不通：换国内可访问的服务，或把 MODEL_BASE_URL 指向代理");
  else if (listed.error.code === "TIMEOUT") console.log("    - 请求挂住：地址可能写错，或该服务不可达");
  else if (listed.error.code === "ENDPOINT_NOT_FOUND") console.log("    - 地址路径不对，检查是否需要带 /v1 前缀");
  else console.log(`    - 参考上面「原因」排查`);
  dataCheck();
  console.log("");
  process.exit(1);
}

const chatModels = listed.ids.filter((id) => classify(id) === "chat");
console.log(`  ${OK} 连通正常（${listed.elapsedMs}ms），共 ${listed.ids.length} 个模型`);
console.log(`    可做对话的：${chatModels.length > 0 ? chatModels.join(", ") : "（无）"}`);
const others = listed.ids.filter((id) => classify(id) !== "chat");
if (others.length > 0) {
  const byKind = new Map<string, string[]>();
  for (const id of others) {
    const kind = classify(id);
    byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
  }
  for (const [kind, ids] of byKind) {
    console.log(`    ${kind === "image" ? "图像模型（走 /images，不能用于聊天）" : kind === "video" ? "视频模型（走 /videos）" : kind === "audio" ? "语音模型" : "其它"}：${ids.join(", ")}`);
  }
}

console.log(`\n[3/4] 实测当前配置的模型「${modelConfig().name}」（25 秒超时）`);
const ping = await pingChat(undefined, 25_000);
if (ping.ok) {
  console.log(`  ${OK} 可用，${ping.elapsedMs}ms，返回：${ping.text.slice(0, 40)}`);
  console.log("\n[4/4] 结论");
  console.log(`  ${OK} 配置正确，可以直接用：npm run dev`);
  dataCheck();
  console.log("");
  process.exit(0);
}

console.log(`  ${BAD} 不可用`);
printError(ping.error);
if (ping.error.code === "TIMEOUT") {
  console.log(`    提示：这个服务商对"没有可用渠道的模型名"不会报错，而是让请求挂住——`);
  console.log(`          所以「挂到超时」几乎就等于「这个模型名在这里用不了」。`);
}

console.log("\n[4/4] 自动找可用的替代模型");
const candidates = chatModels.filter((id) => id !== modelConfig().name).slice(0, 4);
if (candidates.length === 0) {
  console.log(`  ${WARN} 列表里没有其它候选模型`);
} else {
  const works: string[] = [];
  for (const id of candidates) {
    const result = await pingChat(id, 20_000);
    if (result.ok) {
      works.push(id);
      console.log(`  ${OK} ${id.padEnd(26)} ${result.elapsedMs}ms`);
    } else {
      console.log(`  ${BAD} ${id.padEnd(26)} ${result.error.code} ${result.error.message.slice(0, 50)}`);
    }
  }
  if (works.length > 0) {
    console.log(`\n  两种改法（选一个）：`);
    for (const id of works) console.log(`    应用里 /settings 把模型名改成 ${id}`);
    for (const id of works) console.log(`    或 .env：MODEL_NAME=${id}`);
  } else {
    console.log(`\n  ${WARN} 没有找到可用的对话模型——可能是额度/权限问题，去服务商控制台看看。`);
  }
}

if (modelFailureCount() > 0) {
  console.log("\n最近的调用失败记录：");
  for (const row of recentModelCalls(5).filter((item) => item.ok === 0)) {
    console.log(
      `  ${new Date(row.created_at).toLocaleTimeString("zh-CN")} ${row.purpose}/${row.model} ${row.code ?? ""} ${(row.message ?? "").slice(0, 60)}`,
    );
  }
}

function dataCheck(): void {
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  console.log(`  ${integrity.integrity_check === "ok" ? OK : BAD} SQLite integrity_check：${integrity.integrity_check}`);

  const stuck = (db.prepare(`SELECT COUNT(*) AS c FROM turns WHERE status IN ('queued', 'running')`).get() as { c: number }).c;
  console.log(`  ${stuck === 0 ? OK : WARN} 卡死处理单（queued/running）：${stuck}${stuck > 0 ? "  ← 服务重启时会自动清扫为失败；现在为 0 最好" : ""}`);

  const pendingOrphan = (db.prepare(
    `SELECT COUNT(*) AS c FROM proactive_tasks WHERE status = 'pending' AND contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts)`,
  ).get() as { c: number }).c;
  console.log(`  ${pendingOrphan === 0 ? OK : WARN} 孤儿主动任务（联系人已不存在）：${pendingOrphan}`);

  const mediaDir = join(dirname(resolve(config.dbPath)), "media");
  if (!existsSync(mediaDir)) {
    console.log(`  ${OK} 媒体目录还不存在（还没发过图，正常）`);
  } else {
    const files = readdirSync(mediaDir);
    const refs = new Set<string>();
    const collect = (raw: unknown): void => {
      if (typeof raw !== "string") return;
      for (const f of files) if (raw.includes(f)) refs.add(f);
    };
    for (const row of db.prepare(`SELECT attachments FROM messages WHERE attachments IS NOT NULL`).all() as Array<{ attachments: unknown }>) collect(row.attachments);
    for (const row of db.prepare(`SELECT attachments FROM turns WHERE attachments IS NOT NULL`).all() as Array<{ attachments: unknown }>) collect(row.attachments);
    const orphans = files.filter((f) => !refs.has(f));
    console.log(`  ${orphans.length === 0 ? OK : WARN} 媒体文件：${files.length} 个，其中无引用孤儿 ${orphans.length} 个${orphans.length > 0 ? "（删除消息会回收；历史残留可手动清理）" : ""}`);
  }
}


console.log("");
