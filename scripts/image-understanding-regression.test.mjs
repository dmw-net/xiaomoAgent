/**
 * 图片理解分流回归：
 * - 主模型自带视觉：原图内联，视觉卡即使启用也不参与；
 * - 主模型不支持视觉、显式绑视觉卡：视觉卡只识别，聊天仍走主模型；
 * - 联系人绑定纯文本档：不能因为全局主档支持视觉就把图发给绑定档；
 * - 同一张图按内容 hash 只识一次，描述能带着群昵称注入。
 */
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/image-understanding-regression.db";
process.env.MEDIA_DIR = "./data/image-understanding-regression-media";
process.env.MODEL_MODE = "openai";
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/image-understanding-regression.db${suffix}`, { force: true });
rmSync("data/image-understanding-regression-media", { recursive: true, force: true });

const { db } = await import("../src/core/db.ts");
const { createContact, updateContact } = await import("../src/chat/contacts.ts");
const { saveImage } = await import("../src/media/media.ts");
const { toChatMessages } = await import("../src/mind/persona.ts");
const {
  activateCapabilityProfile,
  saveCapabilityProfile,
  saveProfile,
  updateModel,
} = await import("../src/settings/settings.ts");
const { callSettings } = await import("../src/settings/model.ts");
const { imageProxiedHistory, selectReplayImages } = await import("../src/chat/agent.ts");
const { MAX_CHAT_IMAGES } = await import("../shared/limits.ts");
const {
  appendImageDescriptions,
  clearImageDescriptionMemoryCache,
  describeImageForChat,
  visionHandlingFor,
} = await import("../src/mind/image-understanding.ts");

const caps = { tools: true, vision: true, thinking: true, thinkingOnly: false, customProtocol: false };
updateModel({
  mode: "openai",
  baseUrl: "https://main-image.test/v1",
  apiKey: "sk-main-image",
  name: "main-chat",
  caps,
  thinkingParam: "effort",
  thinkingMode: "on",
  thinkingLevel: "high",
  maxOutputTokens: 4096,
});

// 主模型自己支持视觉：不额外调识别模型，直接内联。
assert.equal(visionHandlingFor("default"), "inline", "主模型视觉能力应走内联");

const imageBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const image = saveImage(imageBytes, "image/png");
const duplicateSameBytes = saveImage(imageBytes, "image/png");
const visionCard = saveCapabilityProfile("imageVision", {
  label: "视觉分流卡",
  baseUrl: "https://vision-image.test/v1",
  apiKey: "sk-vision-image",
  name: "vision-model",
});
activateCapabilityProfile("imageVision", visionCard.id);

// 主模型仍能看图时，显式视觉卡也只是备用，不能抢走本轮。
assert.equal(visionHandlingFor("default"), "inline", "主模型有视觉时仍应内联，视觉卡只备份");
assert.equal(callSettings({ contactId: "default" }).name, "main-chat", "聊天调用不能被视觉卡带走");

// 模拟主模型没有图片输入能力：这时视觉卡才作为补充参与。
updateModel({ caps: { ...caps, vision: false } });
assert.equal(visionHandlingFor("default"), "describe", "主模型不能看图时才启用视觉卡识别");
assert.equal(callSettings({ contactId: "default" }).name, "main-chat", "识图补充不能改变聊天模型");

const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
  return new Response(JSON.stringify({
    choices: [{ message: { content: "画面里是一块白板，上面写着“周五”。" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const description = await describeImageForChat(image.url, { contactId: "default", turnId: null });
assert.equal(requests.length, 1, "首次识图只发一次请求");
assert.ok(requests[0].url.startsWith("https://vision-image.test/v1/"), "识图请求走视觉卡端点");
assert.equal(requests[0].body.model, "vision-model", "识图请求使用视觉卡模型");
assert.ok(requests[0].body.messages?.[0]?.content?.some((p) => p.type === "image_url"), "识图请求带原图");
assert.ok(!("reasoning_effort" in requests[0].body), "视觉卡没有思考维度时不能伪造 reasoning_effort");

await describeImageForChat(duplicateSameBytes.url, { contactId: "default", turnId: null });
assert.equal(requests.length, 1, "不同 URL、同一内容 hash 的图第二次直接命中内存缓存");
clearImageDescriptionMemoryCache();
await describeImageForChat(duplicateSameBytes.url, { contactId: "default", turnId: null });
assert.equal(requests.length, 1, "清掉内存层后仍命中 SQLite 持久缓存");
globalThis.fetch = realFetch;

const described = appendImageDescriptions(
  [{ role: "user", text: "看看这个", attachments: JSON.stringify([image.url]), attachment_meta: null }],
  new Set([image.url]),
  new Map([[image.url, description]]),
);
const chatMessages = toChatMessages([{ ...described[0], sender_name: "阿青" }]);
assert.equal(
  chatMessages[0].content,
  "[阿青] 看看这个\n[图片：画面里是一块白板，上面写着“周五”。]",
  "描述应注入聊天文本，并保留群昵称前缀",
);

// 主模型自己看图且超过 6 张时，alt 生成必须走主聊天模型，而不是显式视觉卡。
updateModel({ caps });
const altRequests = [];
globalThis.fetch = async (input, init) => {
  altRequests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
  return new Response(JSON.stringify({
    choices: [{ message: { content: "alt：白板上写着周五。" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};
await describeImageForChat(duplicateSameBytes.url, { contactId: "default", source: "chat", turnId: null });
assert.equal(altRequests.length, 1, "alt 生成只发一次请求");
assert.ok(altRequests[0].url.startsWith("https://main-image.test/v1/"), "主模型有视觉时 alt 走主聊天模型");
assert.equal(altRequests[0].body.model, "main-chat", "alt 生成使用主聊天模型");
globalThis.fetch = realFetch;
const hiddenForAlt = imageProxiedHistory(
  [{ role: "user", text: "看图", attachments: JSON.stringify([image.url]), attachment_meta: null }],
  new Set(),
  true,
);
assert.equal(hiddenForAlt[0].text, "看图", "待生成 alt 的图片不应先留“看不到”占位");

// 联系人绑定纯文本档时，即使全局主档支持视觉，也不能往绑定档塞图。
activateCapabilityProfile("imageVision", "");
updateModel({ caps });
const textOnly = saveProfile({
  label: "纯文本联系人档",
  mode: "openai",
  baseUrl: "https://text-only.test/v1",
  apiKey: "sk-text-only",
  name: "text-only",
  caps: { ...caps, vision: false },
});
const contact = createContact({ name: "图文分流联系人" });
updateContact(contact.id, { modelProfile: textOnly.id });
assert.equal(visionHandlingFor(contact.id), "none", "联系人绑定纯文本档时不能内联图片");

const eightRows = Array.from({ length: 8 }, (_, i) => ({
  role: "user",
  text: `图片 ${i}`,
  attachments: JSON.stringify([`/media/${String(i).padStart(16, "b")}.png`]),
}));
const picked = selectReplayImages(eightRows, []);
assert.equal(MAX_CHAT_IMAGES, 6, "聊天图片硬上限统一为 6");
assert.equal(picked.size, 6, "超过 6 张时只选 6 张");
assert.ok(picked.has(JSON.parse(eightRows[7].attachments)[0]), "优先选最新图片");
assert.ok(!picked.has(JSON.parse(eightRows[0].attachments)[0]), "最老图片被硬上限挡掉");

db.close();
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/image-understanding-regression.db${suffix}`, { force: true });
rmSync("data/image-understanding-regression-media", { recursive: true, force: true });
console.log("image-understanding-regression: ok");