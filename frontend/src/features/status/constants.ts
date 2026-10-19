/**
 * 状态页的固定文案表。键是 model_calls.purpose，值是人话。
 * 注意：这张表混着模型调用与通道投递两类（qq/wechat 打的不是模型，
 * 见后端 CHANNEL_PURPOSES），界面按 scope 把它们分成两套视图。
 */
export const PURPOSE_LABEL: Record<string, string> = {
  chat: "回消息",
  extract: "记忆整理",
  consolidate: "记忆归并",
  proactive: "主动判断",
  recap: "近况整理",
  imageGen: "画图",
  asr: "语音识别",
  tts: "语音合成",
  ping: "连通测试",
  wechat: "微信出站",
  qq: "QQ 出站",
};

/** 主动性「为什么没说」的四道判断，名字说人话（用户看到的是"这次为什么没开口"）。 */
export const GATE_DEFS = [
  { key: "enabled", name: "主动性开关" },
  { key: "quiet", name: "免打扰时段" },
  { key: "idle", name: "安静够久" },
  { key: "daily", name: "今天说够了" },
];

export const TURN_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  done: "已完成",
  failed: "失败",
  cancelled: "被打断",
};
