// 智能识别：把库里的表情逐张看一遍，补上「这张作为一句回复时在说什么」。
//
// 为什么必须有这一步（而不是继续加同义词表）：
// 库里的文本历史上只有两种——文件名句柄（heart-hands、juejuezi）和导入时填的批次名（鲸鱼娘·静态）。
// 实测 200 张标记素材里，中文名 0 张，经那张 65 条手写表可达的只有 34 张。
// 检索器再怎么分层打分，也变不出库里没有的中文；名字这种东西，只能从图上读出来。
//
// 提示词干的事不是「写图注」，而是还原用法：画面证据 → 梗的构成 → 说话视角（图里的人通常是在
// 替**发送者**表演，不代表被评价的对方）→ 什么样的上一句会触发它。这套四步是这条赛道上
// 被反复验证过的标注口径，这里按我们自己的字段重写了一遍。
//
// 动图采多帧而不是喂首帧：见 renditions.ts 的 sampleFrames——只看一帧会把动作描述成姿势。
//
// 一次性、可续跑、不覆盖人写过的东西：
//   emote_named_at > 0 就跳过（除非显式 force），中途关掉应用下次接着跑；
//   只写 label/caption/tags 三个语义字段，alias 与 pack 是用户的归类，作业一律不动。

import { getAssetById, listEmoteAssets, type AssetRow } from "./assets.ts";
import { mediaDataUrl } from "./media.ts";
import { callModel, ModelError } from "./model.ts";
import { applyEmoteNaming } from "./qq-emote.ts";
import { sampleFrames, needsStaticVariant } from "./renditions.ts";
import { capabilityReady } from "./settings.ts";

/** 模型必须回成这个形状；多出来的字段忽略，缺字段当作没认出来。 */
type CaptionResult = {
  name?: unknown;
  meaning?: unknown;
  tags?: unknown;
  confidence?: unknown;
};

const FRAME_COUNT = 6;
/** 一次只跑一张：视觉模型这条路上并发不会更快（限流是按分钟算的），只会更快撞墙。 */
const CONCURRENCY = 1;

export type CaptionSuccess = { name: string; caption: string; tags: string[]; retried: number };
export type CaptionFailure = { error: string; retryable: boolean };
/** 认一张图的结局。失败要带**人话原因**：界面上只写「没认出来」，用户就只剩反复点按钮这一件事可做。 */
export type CaptionOutcome = CaptionSuccess | CaptionFailure;

export function captionFailed(outcome: CaptionOutcome): outcome is CaptionFailure {
  return "error" in outcome;
}

/**
 * 哪些失败值得再试一次。
 * 实测联系人配的那家免费档跑到第 7 张就回 429「已达到免费用户的 API 速率限制」——
 * 200 张的整库作业如果不退避重试，会有一半的张数在几十毫秒里被判死。
 * 而 400/没回 JSON 是**这张图或这个提示词的问题**，重试只是白烧额度。
 */
const RETRYABLE_CODES = new Set<string>(["RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER_ERROR", "EMPTY_RESPONSE"]);

const ATTEMPTS = 3;
/** 一次尝试撞开限流后等多久再打。429 的窗口通常是按分钟算的，1.5s 那种等于白等。 */
const BACKOFF_MS = [8_000, 20_000, 45_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function promptFor(frameCount: number, referenceName = ""): string {
  return [
    "你是表情包的标注员。你的任务不是写图片说明，而是还原这张图**作为一句聊天回复时传达的意思**，",
    "让一个人能够按对话情境准确地搜索到它。",
    "",
    "先按这四步想过，再作答：",
    "1. 画面证据：图里实际有什么。后期配上的字是在替这张图「配语气」，不能当成人物原本的表情。",
    "2. 梗怎么构成的：谐音、错字、拆字、黑话、模板套图，还是纯粹的动作或表情。",
    "3. 说话视角：图里的人通常是在替**发送者**表演一个反应，并不天然代表被评价的对方。",
    "   把「说自己」「评价对方」「吐槽第三方」三种解释比较一遍，选最贴的那个。",
    "4. 真实用法：先推断「上一句什么样的话会让人甩出这张图」，再把它的情绪写成复合语气",
    "   （「惊讶里带戒备」这种，而不是「惊讶」一个词）。",
    frameCount > 1
      ? `\n（这几张图是同一段动作的连续帧：判断动作的起点、怎么变、方向和结果，不要用其中一帧概括整段动作。）`
      : "",
    referenceName !== ""
      ? `\n参考线索：这张图导入时的文件名是「${referenceName}」。它可能已经点出梗义，可用来校正识别；但不要机械照抄，最终名称仍要以画面和聊天用法为准。`
      : "",
    "",
    "只输出 JSON，不要解释：",
    `{"name":"2~8 个字，就是这张图作为回复时说出口的那个反应（例：我躺平了、被吓到、比心、求求了）；图上写着什么字可以原样带进名字（如 HED万岁）",`,
    `"meaning":"30 字内一句用法说明：什么情况下甩它、对谁甩",`,
    `"tags":["6~8 个中文标签，覆盖核心梗义、说话视角、复合语气、触发场景，以及画面上出现的文字"],`,
    `"confidence":0.8}`,
    "",
    "硬性要求：name 与 tags 用中文（图上的外文配字可以原样收进 tags）；",
    "标签不超过 8 个、每个不超过 6 个字（输出太长会被截断，宁可少而准）；",
    "不要写「一张图」「图片显示」这种旁观说法；拿不准也要给出你最好的猜测，并把 confidence 写低。",
  ].filter((line) => line !== "").join("\n");
}

function textOf(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * 认一张图的语义。失败返回带人话原因的 CaptionFailure，**不抛错**：
 * 整批作业里一张坏图不该打断剩下 199 张，但原因要能一路传到界面上——
 * 只写「没认出来」，用户就只剩反复点按钮这一件事可做。
 */
export async function captionEmote(
  asset: AssetRow,
  options: { attempts?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<CaptionOutcome> {
  const attempts = Math.max(1, options.attempts ?? ATTEMPTS);
  const wait = options.wait ?? sleep;
  let last: CaptionFailure = { error: "没跑起来", retryable: false };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const shot = await oneCaptionAttempt(asset);
    if (!("error" in shot)) {
      // 「靠退避救回来了」也是证据：服务商确实在限流。retried 让整库间隔跟着抬，
      // 只数最终失败几张是看不见这件事的。
      return { ...shot, retried: attempt };
    }
    last = shot;
    if (!shot.retryable || attempt === attempts - 1) return shot;
    // 退避而不是立刻重打：429 是「这一分钟太多」，马上重试只会再把下一张也撞死。
    await wait(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8_000);
  }
  return last;
}

/**
 * 把模型回的文本报成一个对象。
 *
 * 不直接用 callModelJson：真实跑 25 张时有几张栽在解析上——模型给的是
 * `{"name":"我划水了","tags":["划水","摸鱼","调侃",]}` 这种**带尾逗号**的对象，
 * 人眼看着没毛病，JSON.parse 直接判死，那张图就白认一次。
 * 这里只做一件诚实的事：去掉紧跟在 `]`/`}` 前的尾逗号再试一次；
 * 还不行就照实报失败，不猜内容、不硬凑一个名字出来。
 */
export function parseCaptionJson(raw: string): CaptionResult | null {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const text = fenced?.[1] ?? trimmed;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const body = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as CaptionResult;
    } catch { /* 换下一种形态 */ }
  }
  return null;
}

/** 一次真实尝试：拼请求、调模型、校验返回。失败带 retryable 让上层决定要不要退避重试。 */
async function oneCaptionAttempt(asset: AssetRow): Promise<{ name: string; caption: string; tags: string[] } | CaptionFailure> {
  if (!capabilityReady("imageVision")) {
    return { error: "图片理解还没配好（设置 → 能力模型 → 图片理解）", retryable: false };
  }
  // 线索＝导入时那个文件名：落盘名是内容哈希，登记时原样存进 alias，只有它记得这张图原本叫什么。
  // 不读 label——那是模型或用户起的名字，喂回去只会强化原有偏差。
  const referenceName = asset.emoteAlias[0] ?? "";
  const parts: Array<Record<string, unknown>> = [{
    type: "text", text: promptFor(needsStaticVariant(asset.url) ? FRAME_COUNT : 1, referenceName),
  }];
  // 动图采帧失败时要把它记下来：那既是一个降级（只认首帧），也是一个可诊断的事实。
  let frameNote = "";
  if (needsStaticVariant(asset.url)) {
    const frames = await sampleFrames(asset.url, FRAME_COUNT);
    if (frames.length === 0) {
      frameNote = "动图裁不出帧（打包里没带图像解码库，或这张 GIF 解不开）";
      // 退回内联原图：多数视觉接口收到动图只取首帧，认得糙一点也比跳过整张强。
      const single = mediaDataUrl(asset.url);
      if (single === null) return { error: "读不到这张图的文件（媒体目录里已经没有它了）", retryable: false };
      parts.push({ type: "image_url", image_url: { url: single } });
    } else {
      for (const frame of frames) {
        parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${frame.toString("base64")}` } });
      }
    }
  } else {
    const single = mediaDataUrl(asset.url);
    if (single === null) return { error: "读不到这张图的文件（媒体目录里已经没有它了）", retryable: false };
    parts.push({ type: "image_url", image_url: { url: single } });
  }
  let raw = "";
  try {
    raw = await callModel(
      [{ role: "user", content: parts as never }],
      { capability: "imageVision", temperature: 0.3, purpose: "emote_naming" },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const retryable = error instanceof ModelError && RETRYABLE_CODES.has(error.code);
    return { error: frameNote !== "" ? frameNote + "；" + detail : detail, retryable };
  }
  const parsed = parseCaptionJson(raw);
  if (parsed === null) {
    return { error: "模型回的内容解析不出对象：" + raw.trim().slice(0, 120), retryable: false };
  }
  const name = textOf(parsed.name, 24);
  if (name === "") {
    return { error: "模型回了 JSON 但没有 name（字段：" + Object.keys(parsed).join("/") + "）", retryable: false };
  }
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => textOf(t, 20)).filter((t) => t !== "").slice(0, 12)
    : [];
  return { name, caption: textOf(parsed.meaning, 120), tags };
}

// ── 作业：一条命令跑完，界面轮询进度；跑着也能往里追加 ────────────────

/** 一轮作业里每张图的结局——「哪些识别好了、哪些没成、成了的叫什么」全靠它摆在界面上。 */
export type NamingResult = {
  id: string;
  file: string;
  name: string;
  error: string;
  /** 成功时把写回的用法与标签一起留下：弹窗里那颗「智能识别」原地回填读的就是这一行，
   *  有了它就不必再为一张图单开一条查询。 */
  caption: string;
  tags: string[];
};

export type NamingJobStatus = {
  running: boolean;
  total: number;
  done: number;
  named: number;
  failed: number;
  /** 正在识别的那一张的文件名，让界面上有个「跑到哪了」的落点。 */
  current: string;
  /** 最近一次失败的人话原因——界面用它说明「为什么有三张识别失败」，而不是只报个数。 */
  lastError: string;
  /** 当前自动降速的间隔（毫秒）。>0 就是服务商在限流，界面该说一句「慢一点是在避墙」。 */
  throttleMs: number;
  finishedAt: number;
  /** 本轮逐张结果，有界；失败的一直排在前面，跑完一眼能看到该重试哪几张。 */
  results: NamingResult[];
};

const RESULTS_CAP = 240;

let job: NamingJobStatus = {
  running: false, total: 0, done: 0, named: 0, failed: 0, current: "", lastError: "", throttleMs: 0,
  finishedAt: 0, results: [],
};

/**
 * 队列里的一项：一张图，加「这张要不要覆盖已有名字」。
 * force 挂在项上而不是作业上——整库跑到一半时追加的那一张，和同批那几百张的语义不一样：
 * 那一次是人明确要求重认的。
 */
type NamingTask = { id: string; force: boolean };

/** 待办队列（含正在跑的那一张）。作业跑着也往里加，所以它是模块级的。 */
const queue: NamingTask[] = [];

export function namingJobStatus(): NamingJobStatus { return { ...job }; }

/**
 * 排进智能识别队列。
 * 没在跑就起一条作业；已经在跑就追加到当前这条后面——不另起一条，否则两条线各烧各的调用、
 * 自适应节流也各算各的，界面上还会出现两个进度。所以「单张识别」和「整库识别」共用同一个队列、
 * 同一个进度、同一份逐张结果。
 * force=false 时只认还没认过的，所以这颗按钮可以放心反复按，也是断点续跑的全部机制。
 */
export function startNamingJob(options: {
  force?: boolean;
  limit?: number;
  /** 只认这批 id（界面上「重试失败的 N 张」和弹窗里那颗「智能识别」用它）。给了就以此为准，不再看 force。 */
  only?: string[];
  /** 注入等待：测试里不真睡，同时能看清作业退避/降速了几次。 */
  wait?: (ms: number) => Promise<void>;
} = {}): { started: boolean; reason?: string; total: number; queued: number } {
  if (!capabilityReady("imageVision")) {
    return { started: false, reason: "图片理解还没配好（设置 → 能力模型 → 图片理解）", total: job.total, queued: 0 };
  }
  const only = options.only ?? [];
  const force = options.force === true;
  // 失效行不进池：原图不在盘上，认一次失败一次，白烧调用。放回文件后自然会再被看见。
  const all = listEmoteAssets().filter((a) => !a.missing);
  const wanted = only.length > 0
    ? all.filter((a) => only.includes(a.id))
    : all.filter((a) => force || a.emoteNamedAt === 0);
  const capped = typeof options.limit === "number" && options.limit > 0 ? wanted.slice(0, options.limit) : wanted;
  const fresh: NamingTask[] = [];
  for (const asset of capped) {
    // 同一张在队列里只留一项：连点两次不该烧两次调用。但后一次的 force 要赢——
    // 弹窗那颗「智能识别」明确要求覆盖，不能被前面那次的「只认没认过的」顶掉。
    const pending = queue.find((t) => t.id === asset.id);
    if (pending !== undefined) { if (force) pending.force = true; continue; }
    fresh.push({ id: asset.id, force });
  }
  queue.push(...fresh);
  if (job.running) {
    job.total += fresh.length;
    return { started: true, total: job.total, queued: fresh.length };
  }
  if (queue.length === 0) {
    return {
      started: false,
      reason: only.length > 0
        ? "这些张不在可识别的范围内（已失效，或不在联系人的表情库里）"
        : "没有要识别的图（库里的表情都已命名）",
      total: job.total,
      queued: 0,
    };
  }
  job = {
    running: true, total: queue.length, done: 0, named: 0, failed: 0,
    current: "", lastError: "", throttleMs: 0, finishedAt: 0, results: [],
  };
  void runNamingJob(options.wait ?? sleep);
  return { started: true, total: job.total, queued: fresh.length };
}

// ── 采集后自动补名 ────────────────────────────────────────────────
// 收进库的表情没有名字就等于没进候选——检索看不见它。让用户每张都记得回界面点
// 「智能识别」是靠不住的，采集成功自己排一次延时作业：连发十张也只认一轮
// （防抖），图片理解没配好安静跳过，手动作业正跑着就追加到它后面接着跑。
let captureNamingTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleCaptureNaming(delayMs = 60_000): void {
  if (captureNamingTimer !== null) clearTimeout(captureNamingTimer);
  captureNamingTimer = setTimeout(() => {
    captureNamingTimer = null;
    startNamingJob({});
  }, delayMs);
  // 到点再认，不该拖住进程退出（桌面端关应用、测试子进程都算）。
  if (typeof captureNamingTimer.unref === "function") captureNamingTimer.unref();
}

/** 撤掉待补的名（测试与关停路径用；没有排队中的就 no-op）。 */
export function cancelCaptureNaming(): void {
  if (captureNamingTimer !== null) { clearTimeout(captureNamingTimer); captureNamingTimer = null; }
}

async function runNamingJob(nap: (ms: number) => Promise<void>): Promise<void> {
  /**
   * 自适应节流：默认一张都不等（付费档跑满速），一旦看到限流就把间隔抬起来，连续成功再慢慢落回去。
   * 为什么不只靠单张的重试：重试解的是「这一张撞墙了」，节流解的是「整库都别去撞墙」——
   * 实测免费档 20 张里 8 张即使退避 3 次仍然失败，只重试不加节流的话 200 张会白烧一半的调用。
   * 为什么不做成配置项：没有人能预先知道自家服务商每分钟允许几次，让它自己试出来更准。
   */
  let gapMs = 0;
  const setGap = (ms: number): void => {
    gapMs = ms;
    job.throttleMs = ms;
  };
  /** 逐张结果：失败的排前面（那是用户下一步要处理的），总量有界不无脑长。 */
  const pushResult = (result: NamingResult): void => {
    job.results = result.error === ""
      ? [...job.results, result].slice(-RESULTS_CAP)
      : [result, ...job.results.filter((r) => r.error === "")].slice(0, RESULTS_CAP);
  };
  const line = (task: NamingTask, file: string, error: string): NamingResult =>
    ({ id: task.id, file, name: "", error, caption: "", tags: [] });
  const worker = async (): Promise<void> => {
    for (;;) {
      // 取活必须一步做完：中间只要 await，追加就可能插到「队列空了」和「作业收尾」之间。
      const task = queue.shift();
      if (task === undefined) return;
      if (gapMs > 0) await nap(gapMs);
      // 排队的这几分钟里原图可能被删、被标失效、被手改名——每次取活重新读一遍库。
      const asset = getAssetById(task.id);
      const file = asset?.url.split("/").pop() ?? task.id;
      job.current = file;
      if (asset === null || asset.missing) {
        const reason = asset === null ? "这张已经不在表情库里" : "原图不在盘上了";
        job.done += 1;
        job.failed += 1;
        job.lastError = `${file}：${reason}`;
        pushResult(line(task, file, reason));
        continue;
      }
      // 抢跑保护：另一条线刚把这张认过了就别再花一次调用；force 那一律重认。
      if (!task.force && asset.emoteNamedAt > 0) { job.done += 1; continue; }
      const outcome = await captionEmote(asset, { wait: nap });
      job.done += 1;
      if (!captionFailed(outcome)) {
        applyEmoteNaming(asset.url, outcome, Date.now());
        job.named += 1;
        pushResult({
          id: task.id, file, name: outcome.name, error: "",
          caption: outcome.caption, tags: outcome.tags,
        });
        // 这张是靠退避救回来的 → 服务商在限流，下一张开始就慢一点；
        // 干净成功才慢慢把间隔落回去。只数「最终失败几张」是看不见这件事的。
        if (outcome.retried > 0) setGap(Math.min(20_000, Math.max(gapMs, 3_000)));
        else setGap(Math.floor(gapMs / 2));
        continue;
      }
      job.failed += 1;
      job.lastError = `${file}：${outcome.error}`;
      pushResult(line(task, file, outcome.error));
      if (outcome.retryable) setGap(Math.min(20_000, Math.max(gapMs, 3_000) * 2));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  job.running = false;
  job.current = "";
  job.finishedAt = Date.now();
}
