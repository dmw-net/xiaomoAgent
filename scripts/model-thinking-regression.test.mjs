/**
 * 隐式视觉通道必须继承聊天档的思考配置。
 *
 * 回归背景：带图的一轮只要重放到用户图，就会给模型调用挂上 imageVision。
 * 视觉能力没有显式绑档时，端点实际回落到聊天档；但 callSettings 曾把整份
 * ModelSettings 重置成空 caps，连 reasoning_effort 一起静默丢掉。显式绑了
 * 视觉卡则不同：能力卡本来就没有思考这一维，必须继续明确不带思考参数。
 */
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/model-thinking-regression.db";
process.env.MEDIA_DIR = "./data/model-thinking-regression-media";
process.env.MODEL_MODE = "openai";
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/model-thinking-regression.db${suffix}`, { force: true });
rmSync("data/model-thinking-regression-media", { recursive: true, force: true });

const { db } = await import("../src/db.ts");
const { createContact, updateContact } = await import("../src/contacts.ts");
const {
  activateCapabilityProfile,
  deleteCapabilityProfile,
  saveCapabilityProfile,
  saveProfile,
  updateModel,
} = await import("../src/settings.ts");
const { applyThinkingParams, callSettings } = await import("../src/model.ts");

const caps = { tools: true, vision: true, thinking: true, thinkingOnly: false, customProtocol: false };
updateModel({
  mode: "openai",
  baseUrl: "https://main-thinking.test/v1",
  apiKey: "sk-main-thinking",
  name: "main-thinking",
  caps,
  thinkingParam: "effort",
  thinkingMode: "on",
  thinkingLevel: "high",
  maxOutputTokens: 4096,
});

const requestOf = (options) => {
  const settings = callSettings(options);
  const body = {};
  applyThinkingParams(body, settings);
  return { settings, body };
};

// 未显式绑视觉卡：请求仍落在聊天档，思考参数必须原样跟着聊天档走。
const implicit = requestOf({ capability: "imageVision" });
assert.equal(implicit.settings.name, "main-thinking", "隐式视觉调用仍在主聊天档");
assert.equal(implicit.settings.thinkingMode, "on", "隐式视觉调用继承思考开关");
assert.equal(implicit.body.reasoning_effort, "high", "隐式视觉请求带 reasoning_effort");

// 联系人绑定了另一份聊天档：隐式视觉调用也必须跟着这位联系人的真实端点，
// 而不是偷偷回到全局主档。
const boundProfile = saveProfile({
  label: "联系人思考档",
  mode: "openai",
  baseUrl: "https://bound-thinking.test/v1",
  apiKey: "sk-bound-thinking",
  name: "bound-thinking",
  caps,
  thinkingParam: "effort",
  thinkingMode: "on",
  thinkingLevel: "low",
  maxOutputTokens: 4096,
});
const contact = createContact({ name: "思考回归联系人" });
updateContact(contact.id, { modelProfile: boundProfile.id });
const boundImplicit = requestOf({ capability: "imageVision", contactId: contact.id });
assert.equal(boundImplicit.settings.name, "bound-thinking", "隐式视觉调用继承联系人绑定档");
assert.equal(boundImplicit.body.reasoning_effort, "low", "继承绑定档的思考强度");

// 显式绑视觉卡：能力卡没有思考维度，保持现状不发送思考字段。
const visionCard = saveCapabilityProfile("imageVision", {
  label: "视觉回归卡",
  baseUrl: "https://vision-thinking.test/v1",
  apiKey: "sk-vision-thinking",
  name: "vision-thinking",
});
activateCapabilityProfile("imageVision", visionCard.id);
const explicit = requestOf({ capability: "imageVision" });
assert.equal(explicit.settings.name, "vision-thinking", "显式视觉调用走视觉卡");
assert.equal(explicit.settings.caps.thinking, false, "视觉卡不假装继承聊天档思考能力");
assert.ok(!("reasoning_effort" in explicit.body), "显式视觉卡不发送 reasoning_effort");

deleteCapabilityProfile("imageVision", visionCard.id);
const restored = requestOf({ capability: "imageVision" });
assert.equal(restored.body.reasoning_effort, "high", "取消视觉卡后恢复继承主聊天档思考参数");

db.close();
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/model-thinking-regression.db${suffix}`, { force: true });
rmSync("data/model-thinking-regression-media", { recursive: true, force: true });
console.log("model-thinking-regression: ok");