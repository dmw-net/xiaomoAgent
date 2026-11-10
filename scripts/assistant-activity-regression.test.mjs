/**
 * 设置助手「活动记录」回归测试。
 *
 * 运行：node --experimental-sqlite scripts/assistant-activity-regression.test.mjs
 *
 * 覆盖的真实问题：「完全自主」档没有任何确认卡片可看，助手改了什么全靠翻会话流。
 * 后端给写工具统一包了一层活动记录（src/mind/assistant.ts 的 withActivityLogging），
 * 助手设置屏的「最近的配置变更」靠它做事后可见性。这条测试钉住四件事：
 *   1. 权限档切换、写工具执行、确认卡拒绝/放行都会入账，人话标题可读；
 *   2. 读动作（app_status、manage_extensions 的 list/probe）不构成变更，不入账；
 *   3. 经确认卡放行的写必须带 confirmed 标记——审计要能区分"直接执行"与"用户点过卡"；
 *   4. 最新在前；记录失败不影响工具主流程（包装器吞掉记录异常）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "xiaomo-assistant-activity-test-"));
process.env.DB_PATH = join(root, "xiaomo.db");
process.env.MEDIA_DIR = join(root, "media");
process.env.SKILLS_DIR = join(root, "skills");
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.MODEL_MODE = "echo";
process.env.PROACTIVE_ENABLED = "false";
delete process.env.DATA_DIR;

const { createHttpServer } = await import("../src/server.ts");
// 测试环境不注册 Web 通道（decline/confirm 的合成续跑消息需要它），
// 确认卡的决定走同一个生产函数 resolvePendingAction，只跳过"合成消息"这最后一步。
const { ASSISTANT_TOOLS, resolvePendingAction } = await import("../src/mind/assistant.ts");

const server = createHttpServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object", "测试服务器没有拿到端口");
const base = `http://127.0.0.1:${address.port}`;

const getJson = async (path) => (await fetch(base + path)).json();
const postJson = async (path, body) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** 每次直接读后端真相，避免缓存干扰断言。 */
const readActivity = async () => (await getJson("/api/assistant/activity")).items;
const findEntry = (items, re) => items.find((x) => re.test(x.title));

try {
  // 初始为空：没有写动作就没有记录，审计面不预填噪音。
  assert.deepEqual(await readActivity(), [], "初始活动记录应为空");

  // ── 权限档切换入账 ──
  const perm = await postJson("/api/assistant/permission", { permission: "readonly" });
  assert.equal(perm.status, 200);
  const permEntry = findEntry(await readActivity(), /权限档切到「只读」/);
  assert.ok(permEntry, "权限切换必须入账");
  assert.equal(permEntry.tier, "readonly", "记录的 tier 是切换后的档");
  // 重复设置同一档不入账（没有变更就没有记录）。
  await postJson("/api/assistant/permission", { permission: "readonly" });
  assert.equal((await readActivity()).filter((x) => x.tool === "permission").length, 1,
    "切到同一档不算变更，不应重复入账");
  await postJson("/api/assistant/permission", { permission: "confirm" });

  // ── 读动作不入账 ──
  const before = (await readActivity()).length;
  const ctx = { lastUserAt: null, contactId: "assistant", turnId: null, assistantPermission: "confirm" };
  const status = await ASSISTANT_TOOLS.find((t) => t.name === "app_status").execute({}, ctx);
  assert.equal(status.ok, true);
  // 补齐后的快照：全量字段要在，密钥一律不能出现。
  assert.ok(status.capabilities && typeof status.capabilities.imageVision === "object", "快照要带六张能力卡的生效值");
  assert.ok(status.settings && typeof status.settings.onboardingDone === "boolean", "快照要带引导完成度与全局设置");
  assert.ok(status.media && typeof status.media.emotes === "number", "快照要带媒体库计数");
  assert.ok(status.channels && typeof status.channels === "object", "快照要带渠道状态（未装配时为空对象）");
  assert.ok(!/"apiKey"/.test(JSON.stringify(status)), "app_status 快照不得出现 apiKey 字段");
  await ASSISTANT_TOOLS.find((t) => t.name === "manage_extensions").execute({ action: "list" }, ctx);
  assert.equal((await readActivity()).length, before, "读状态/列扩展不构成变更，不应入账");

  // ── 写工具执行入账（成功与失败都记） ──
  const created = await ASSISTANT_TOOLS.find((t) => t.name === "create_contact")
    .execute({ name: "活动记录测试角色" }, ctx);
  assert.equal(created.ok, true);
  const createEntry = findEntry(await readActivity(), /创建联系人「活动记录测试角色」/);
  assert.ok(createEntry, "创建联系人必须以人话标题入账");
  assert.equal(createEntry.ok, true);
  assert.equal(createEntry.tool, "create_contact");

  const badSave = await ASSISTANT_TOOLS.find((t) => t.name === "configure_model")
    .execute({ label: "坏档", baseUrl: "不是地址", model: "x" }, ctx);
  assert.equal(badSave.ok, false);
  const badEntry = findEntry(await readActivity(), /保存模型档「坏档」/);
  assert.ok(badEntry, "失败的写也必须入账（用户要能看见助手试过什么）");
  assert.equal(badEntry.ok, false);
  assert.ok(badEntry.detail && badEntry.detail.length > 0, "失败记录必须带原因");

  const saved = await ASSISTANT_TOOLS.find((t) => t.name === "configure_model")
    .execute({ label: "测试档", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "test-model" }, ctx);
  assert.equal(saved.ok, true);

  // ── 确认卡：拒绝入账且不执行 ──
  const delGuard = ASSISTANT_TOOLS.find((t) => t.name === "manage_extensions");
  const ask = await delGuard.execute({ action: "delete", id: "never-existed" }, ctx);
  assert.ok(ask.needsConfirmation, "confirm 档下删除扩展必须先挂卡");
  const declined = await resolvePendingAction(ask.needsConfirmation.actionId, false);
  assert.equal(declined.executed, false);
  const declineEntry = findEntry(await readActivity(), /用户拒绝了「删除扩展「never-existed」」/);
  assert.ok(declineEntry, "拒绝决定必须入账（用户要能看见自己拦下了什么）");

  // ── 确认卡：同意放行的写必须带 confirmed 标记 ──
  // 清单校验要求 mcp / tools 至少有其一；给一个最小的 webhook 工具让导入真正落库。
  const manifest = {
    formatVersion: 1,
    id: "activity-test-ext",
    name: "活动记录测试扩展",
    version: "1.0.0",
    description: "只为确认卡路径准备的最小清单",
    tools: [{ name: "echo_ping", description: "测试用 webhook 工具", handler: { kind: "webhook", url: "https://example.com/ping" } }],
  };
  const importGuard = ASSISTANT_TOOLS.find((t) => t.name === "import_extension");
  const askImport = await importGuard.execute({ manifest }, ctx);
  assert.ok(askImport.needsConfirmation, "confirm 档下导入扩展必须先挂卡");
  const resolved = await resolvePendingAction(askImport.needsConfirmation.actionId, true);
  assert.equal(resolved.executed, true);
  const importEntry = findEntry(await readActivity(), /导入扩展「activity-test-ext」/);
  assert.ok(importEntry, "经确认卡放行的写必须入账");
  assert.equal(importEntry.confirmed, true, "审计必须能区分「直接执行」与「用户点过卡」");
  assert.equal(importEntry.tier, "confirm");

  // ── 顺序：最新在前 ──
  const items = await readActivity();
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].ts >= items[i].ts, "活动记录必须最新在前");
  }
  // 最新的一条是刚才经确认卡放行的导入；权限切换在它之前。
  assert.equal(items[0].tool, "import_extension");
  assert.equal(items[0].confirmed, true);

  // ── 能力补齐：新写工具自动入账，且保存过密钥后快照仍然脱敏 ──
  const afterSave = await ASSISTANT_TOOLS.find((t) => t.name === "app_status").execute({}, ctx);
  const afterText = JSON.stringify(afterSave);
  assert.ok(!afterText.includes("sk-test") && !/"apiKey"/.test(afterText), "保存过模型密钥后 app_status 仍必须脱敏");

  const pref = await ASSISTANT_TOOLS.find((t) => t.name === "set_preference")
    .execute({ emoteFrequency: "rare", toolLoopTurns: 6 }, ctx);
  assert.equal(pref.ok, true);
  assert.equal(pref.emoteFrequency, "rare");
  assert.equal(pref.toolLoopTurns, 6);
  assert.ok(findEntry(await readActivity(), /调整全局偏好/), "新写工具必须自动入账（白名单包装器）");

  const cap = await ASSISTANT_TOOLS.find((t) => t.name === "configure_capability")
    .execute({ capability: "imageVision", label: "测试视觉档", baseUrl: "https://api.example.com/v1", name: "test-vl", apiKey: "sk-cap-test" }, ctx);
  assert.equal(cap.ok, true, `配置能力端点失败：${cap.error ?? ""}`);
  assert.ok(findEntry(await readActivity(), /配置能力模型/), "能力端点写入必须自动入账");
  const capStatus = JSON.stringify(await ASSISTANT_TOOLS.find((t) => t.name === "app_status").execute({}, ctx));
  assert.ok(!capStatus.includes("sk-cap-test") && !/"apiKey"/.test(capStatus), "能力端点密钥同样不得出现在快照里");

  console.log("✅ assistant-activity 回归通过");
} finally {
  await new Promise((resolve) => server.close(resolve));
  // Windows 上不先关掉数据库句柄，rmSync 删临时目录会 EPERM。
  try { (await import("../src/core/db.ts")).db.close(); } catch { /* 可能已关闭 */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
