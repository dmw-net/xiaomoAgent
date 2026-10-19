import type { CapabilityName } from "../../types";

/** 服务商预设：填充接口地址与常用模型名；模型名以服务商当前文档为准，可再手改。 */
export type ProviderPreset = { label: string; baseUrl: string; model?: string; voice?: string };

export const CHAT_PRESETS: ProviderPreset[] = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "火山方舟（豆包）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-1-5-pro-32k-250115" },
  { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus" },
  { label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "本地 Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b" },
];

export type CapabilityPresetGroup = {
  name: CapabilityName;
  title: string;
  desc: string;
  /** 端点形状：chat=对话补全 / asr=/audio/transcriptions / tts=/audio/speech */
  endpoint: string;
  modelHint: string;
  hasVoice?: boolean;
  /** 这份能力能不能什么都不填、直接用主模型那份档。只有纯文本的和视觉对话两类可以。 */
  followsMain: boolean;
  presets: ProviderPreset[];
};

/**
 * 顺序与后端 CAPABILITY_NAMES 严格一致：记忆提取排第一（它最常配、也最容易配错），
 * 然后按「看得见的」两张（图片理解、图像生成）再「听得到的」两张（语音识别、语音合成）——
 * 从前图像生成孤零零挂在末尾，夹在两个语音中间看着像语音的子项。
 */
export const CAPABILITY_GROUPS: CapabilityPresetGroup[] = [
  {
    name: "memoryExtract",
    title: "记忆提取与整理",
    desc: "每轮对话后把新信息整理成长期记忆。不用另配接口——从「主对话模型」存好的档里挑一个便宜快的，不挑就跟着正在用的走。",
    endpoint: "/chat/completions",
    modelHint: "如 deepseek-chat / doubao-1-5-lite-32k",
    followsMain: true,
    presets: CHAT_PRESETS,
  },
  {
    name: "imageVision",
    title: "图片理解",
    desc: "聊天收到的图片交给这个模型识别；不单独配就跟随主模型（那档需勾了「图片输入」）。",
    endpoint: "/chat/completions",
    modelHint: "如 qwen-vl-plus / glm-4v-plus / gpt-4o-mini",
    followsMain: true,
    presets: [
      { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      { label: "通义千问 VL", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-plus" },
      { label: "智谱 GLM-4V", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4v-plus" },
      { label: "火山方舟（豆包视觉）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-vision-pro-32k-250115" },
      { label: "Kimi 视觉", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k-vision-preview" },
      { label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-VL-32B-Instruct" },
    ],
  },
  {
    name: "imageGeneration",
    title: "图像生成",
    desc: "能画一张图发回来。这个要单独配一个绘图模型（和聊天用的不通用）。每个联系人每天最多 5 张；出一轮图要等一分多钟。",
    endpoint: "/images/generations",
    modelHint: "如 agnes-image-2.5-flash / doubao-seedream-4-0 / gemini-2.5-flash-image-preview",
    followsMain: false,
    presets: [
      { label: "Agnes 图像", baseUrl: "https://api.agnes-ai.cn/v1", model: "agnes-image-2.5-flash" },
      { label: "OpenAI 图像", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1" },
      { label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen-Image" },
    ],
  },
  {
    name: "speechToText",
    title: "语音识别",
    desc: "聊天里「转文字」按钮用的就是它，要单独配一个模型。",
    endpoint: "/audio/transcriptions",
    modelHint: "如 whisper-1 / whisper-large-v3",
    followsMain: false,
    presets: [
      { label: "OpenAI Whisper", baseUrl: "https://api.openai.com/v1", model: "whisper-1" },
      { label: "Groq Whisper", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3" },
      { label: "硅基流动 SenseVoice", baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" },
    ],
  },
  {
    name: "textToSpeech",
    title: "语音合成",
    desc: "回复气泡上的「播放」按钮用的就是它，要单独配一个模型。",
    endpoint: "/audio/speech",
    modelHint: "如 tts-1 / cosyvoice 系",
    hasVoice: true,
    followsMain: false,
    presets: [
      { label: "OpenAI TTS", baseUrl: "https://api.openai.com/v1", model: "tts-1", voice: "alloy" },
      { label: "硅基流动 CosyVoice", baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B" },
    ],
  },
];
