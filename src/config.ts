// 所有环境变量集中在这里读取。其它模块只 import config，不直接碰 process.env。
//
// 为什么：配置项一旦散落各处，就会出现「同一件事两处配置、互相矛盾」的问题
// （参考项目的自动压缩开关就同时存在于预设和宿主设置里，默认值还不一致）。
// 一条纪律：配置只有一个真源。

import { join } from "node:path";

export type ModelMode = "echo" | "openai";

function str(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function int(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** 逗号分隔的主机名清单：去空白、转小写、丢空项、去重。用于主机名白名单这类集合。 */
function hostList(key: string): string[] {
  const raw = str(key);
  if (raw === "") return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const host = part.trim().toLowerCase();
    if (host !== "") seen.add(host);
  }
  return [...seen];
}

/**
 * 端口专用解析：**0 是合法值**（表示"让系统分配一个空闲端口"）。
 * 不能用上面的 int()，因为它要求 n > 0，会把 0 当成"没配"悄悄换成默认端口——
 * 然后外壳和 sidecar 就各连各的端口了。这是个排查起来很痛的坑，所以单独一个函数。
 */
function portOrZero(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

const modelMode: ModelMode = str("MODEL_MODE") === "openai" ? "openai" : "echo";

/** 供应商专属参数（例如方舟的 thinking、某些服务的 enable_search）。JSON 字符串，直接合并进请求体。 */
function parseExtraBody(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.freeze(parsed as Record<string, unknown>)
      : {};
  } catch {
    console.warn("[config] MODEL_EXTRA_BODY 不是合法 JSON，已忽略");
    return {};
  }
}

/**
 * 数据目录：桌面端（Tauri）下由外壳传进来，指定到用户可写的位置
 * （安装目录在 Program Files 下是不可写的，数据库绝不能放那儿）。
 * 命令行/开发时留空，退回相对当前工作目录的 ./data。
 */
const dataDir = str("DATA_DIR");

/** 相对路径按数据目录解析，绝对路径原样使用。 */
function resolveDbPath(raw: string): string {
  if (dataDir === "") return raw;
  // 已经是绝对路径（Windows 盘符或 POSIX 根）就不动它。
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\")) return raw;
  return join(dataDir, raw);
}

export const config = Object.freeze({
  /** 开发模式：置 1 后模型调用的【请求原文】（完整请求体）也会落盘并出现在状态页「查看原文」里。
   *  请求体含系统提示词/记忆/用户资料，属内部调试数据，生产默认关。响应全文不受此开关限制。 */
  devMode: bool("DEV_MODE", false),
  port: portOrZero("PORT", 8787),
  /** 监听地址。默认只绑本机回环——密钥和聊天记录都在这台机器上。
   *  确实要让手机局域网访问再显式设 HOST=0.0.0.0，并自行理解暴露面。 */
  host: str("HOST", "127.0.0.1"),
  /**
   * 公网穿透（自建或第三方的隧道服务）显式信任的主机名清单，逗号分隔、大小写不敏感。
   *
   * 隧道会把公网域名原样转发进来，这个 Host 既不是回环也不是本机网卡地址，默认被本机
   * 守卫按「外来域名」拒掉（穿透访问因此吃 403）。把隧道域名写进这里，守卫就放行该 Host，
   * 但仍要求 Origin 与它同源——别的网页借不走这个域名。留空 = 与从前完全一致。
   */
  trustedHosts: hostList("TRUSTED_HOSTS"),
  dataDir,
  dbPath: resolveDbPath(str("DB_PATH", "./data/xiaomo.db")),
  /** 图片落盘目录，留空 = 库文件同级的 media/。测试脚本用它把产物隔开：
   *  否则冒烟测试的图和真实数据混在同一个目录里，孤儿清扫会互相误伤。
   *
   *  与 skillsDir 同样**不过** resolveDbPath：那个函数对空串返回 dataDir 本身，
   *  "留空"就没了——桌面端图片会落在 xiaomo.db / desktop.json / runtime.json 旁边，
   *  而且 migrateDataDir 会把整个数据目录当成 oldMedia 拷进 <新目录>/media。
   *  原始空串留给 media.ts 判默认值（<库目录>/media）。 */
  mediaDir: str("MEDIA_DIR") === "" ? "" : resolveDbPath(str("MEDIA_DIR")),
  /** 用户自定义技能目录，留空 = 库同级的 skills/（与 media 同一个「库旁边」的位置）。
   *  这里**不过** resolveDbPath：那个函数对空串会返回 dataDir 本身，"留空"就没了，
   *  技能会散着落在数据目录根上。原始空串留给 skills.ts 判默认值。 */
  skillsDir: str("SKILLS_DIR"),
  /**
   * 端口握手文件：桌面外壳启动 sidecar 后读它拿到真实端口，
   * 避免「写死 8787 结果被别的程序占用」的问题。
   */
  runtimeFile: str("RUNTIME_FILE"),
  /** desktop.json 路径(桌面外壳传入)：改数据目录时要读回它、更新 DATA_DIR；dev/CLI 模式为空。 */
  desktopConfigFile: str("DESKTOP_CONFIG"),
  characterName: str("CHARACTER_NAME", "小茉"),
  ownerName: str("OWNER_NAME", ""),
  /** 回放最近多少【轮】对话（一问一答算一轮）。运行期可在应用内覆盖（设置 → 主模型接入 → 对话上下文）。 */
  recentTurnsInContext: int("RECENT_TURNS_IN_CONTEXT", 6),
  recallLimit: int("RECALL_LIMIT", 6),
  model: Object.freeze({
    mode: modelMode,
    baseUrl: str("MODEL_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: str("MODEL_API_KEY"),
    name: str("MODEL_NAME", "gpt-4o-mini"),
    timeoutMs: int("MODEL_TIMEOUT_MS", 90_000),
    extraBody: parseExtraBody(str("MODEL_EXTRA_BODY")),
    startupCheck: bool("MODEL_STARTUP_CHECK", true),
  }),
  proactive: Object.freeze({
    enabled: bool("PROACTIVE_ENABLED", true),
    intervalMinutes: int("PROACTIVE_INTERVAL_MINUTES", 30),
    idleMinutes: int("PROACTIVE_IDLE_MINUTES", 120),
    quietHours: str("QUIET_HOURS", "23-8"),
    /** 每联系人每天主动发言的默认上限（联系人功能开关里的 dailyLimit>0 时优先）。 */
    dailyLimit: Math.min(10, Math.max(1, int("PROACTIVE_DAILY_LIMIT", 1))),
  }),
  /** 记忆整理（合并/过期/生活线/温度计）的最小间隔天数；0 = 关闭后台整理。 */
  consolidateIntervalDays: Math.min(90, Math.max(0, int("CONSOLIDATE_INTERVAL_DAYS", 7))),
});

/**
 * 注意：这里**没有** modelReady 常量了。
 *
 * 曾经它是 `config.model.mode === "openai" && config.model.apiKey !== ""`，
 * 但模型配置现在可以在应用内改（见 settings.ts），常量那种"启动时算一次"的写法
 * 会让用户刚填好的密钥要等重启才认——那正是要消灭的问题。
 * 需要判断时请用 settings.ts 的 modelReadyNow()。
 */

/** 判断某个小时是否落在免打扰时段。支持跨零点，例如 23-8 表示 23 点到次日 8 点。 */
export function inQuietHours(hour: number, spec = config.proactive.quietHours): boolean {
  const [startRaw, endRaw] = spec.split("-");
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
