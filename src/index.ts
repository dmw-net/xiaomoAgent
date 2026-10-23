// 入口：注册通道 → 起 HTTP → 起定时器。
//
// 启动方式（零安装、零依赖）：
//   cp .env.example .env
//   npm run dev
// 然后浏览器打开 http://localhost:8787。默认只监听 127.0.0.1（密钥和聊天记录都在这台机器上）；
// 想让手机局域网访问，显式设 HOST=0.0.0.0——这是有意的决定，不给默认值。
// 走这条路启动时会自动补一个访问码（见下面的 listen 回调）；应用内开关是更推荐的入口。
//
// 一次性跑主动判断（不想等定时器时用）：
//   npm run proactive:once

import { config } from "./config.ts";
import { modelConfig, modelReadyNow, personaConfig } from "./settings.ts";
import { registerChannel } from "./channels/types.ts";
import { webChannel } from "./channels/web.ts";
import { createHttpServer } from "./server.ts";
import * as lan from "./lan.ts";
import { startProactiveLoop, runProactiveCheck, pruneProactiveBacklog, pruneFinishedTasks } from "./proactive.ts";
import { sweepStaleTurns } from "./agent.ts";
import { isChatModelId, listModels, pingChat } from "./model.ts";
import { writeRuntimeHandshake, clearRuntimeHandshake } from "./runtime.ts";
import { claimPrimary, isPrimary, leaseIsFreeOrOurs, primaryPid, releasePrimary, startLeaseLoop } from "./instance.ts";
import { pruneModelCalls } from "./logs.ts";
import { sweepOrphanMedia } from "./media.ts";
import { DEFAULT_CONTACT_ID, ensureDefaultContact } from "./contacts.ts";
import { wechat } from "./wechat.ts";
import { qq } from "./qq.ts";

// 兜底日志：单机应用「带病存活 + 看得见错误」好过静默崩溃。
// 崩在这里意味着代码里有违背假设的路径——把它打进日志（状态页可查最近错误），不退出。
process.on("unhandledRejection", (reason) => {
  console.error("[process] 未处理的 Promise 拒绝：", reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});
process.on("uncaughtException", (error) => {
  console.error("[process] 未捕获异常：", error.stack ?? error.message);
});

// 通道注册必须在 once 分支之前：主动性的两条投递路径都靠 getChannel("web")，
// 放在后面会让 `npm run proactive:once` 永远报「没有可用通道」，还白白烧掉一条 pending 任务。
registerChannel(webChannel);

const once = process.argv.includes("--proactive-once");

if (once) {
  // 手动触发一次：这是最方便观察"主动性"的方式，不必等 30 分钟。
  ensureDefaultContact();
  // 只有当家的进程能跑：主动性会把话真的送出去（并镜像到微信/QQ、吃每日配额）。
  // 桌面端已经在跑定时器时，这一条再打一次就是同一句话投两遍、配额翻倍。
  if (!leaseIsFreeOrOurs()) {
    console.log(`另一个实例（pid ${primaryPid() ?? "?"}）正在跑主动性，这一边不重复触发。`);
    process.exit(0);
  }
  const decision = await runProactiveCheck(DEFAULT_CONTACT_ID, "cli");
  console.log(decision.spoken ? `已发出：${decision.text}` : `没有打扰：${decision.reason}`);
  process.exit(0);
}

// 同一个库可能被多个进程打开（桌面多窗口、`npm run dev` 与桌面端并存）。
// 下面这些「全局副作用」只能由一个进程做，否则第二个进程一启动就把第一个正在跑的
// 处理单标成失败、主动消息双发、微信长轮询重复收件。协调靠库里的一份租约（instance.ts）。
const weHoldLease = claimPrimary();
if (!weHoldLease) {
  console.log(`[startup] 另一个实例（pid ${primaryPid() ?? "?"}）正在用同一个库：本进程只提供界面与接口，`);
  console.log(`          不清扫在飞的处理单、不跑主动性定时器、不恢复微信收件。`);
}

/**
 * 当家要做的事，全部可重入：租约翻转时 beginDuty/endDuty 会被反复调用
 * （主窗口关掉 → 还活着的窗口补位；自己停摆太久被抢走 → 降级）。
 * 每个都先判空再赋值，重复调用不会起出第二个定时器。
 */
const MAINTENANCE_MS = 6 * 3_600_000;
let proactiveTimer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;

function beginDuty(): void {
  if (proactiveTimer === null) proactiveTimer = startProactiveLoop();
  // 微信通道：恢复已绑定链接的收件长轮询（未绑定时无操作）。
  // 只由当家进程做——两个进程各轮一遍，对端一句话会被投递两次。
  wechat.startAll();
  // QQ 通道同理：只有当家进程连网关。两个进程各连一遍，
  // 同一条用户消息会被投递两次（官方按会话推事件，不去重）。
  qq.startAll();
  if (maintenanceTimer === null) {
    maintenance();
    maintenanceTimer = setInterval(maintenance, MAINTENANCE_MS);
    maintenanceTimer.unref();
  }
}

function endDuty(): void {
  if (proactiveTimer !== null) { clearInterval(proactiveTimer); proactiveTimer = null; }
  if (maintenanceTimer !== null) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
  wechat.stopAll();
  qq.stopAll();
}

// 心跳循环兼作状态机：在家续租（fencing 失败就降级），在外重试抢占（抢到就补位）。
const heartbeat = startLeaseLoop({ onGain: beginDuty, onLose: endDuty });
if (weHoldLease) beginDuty();

// 启动数据修复（幂等）。只在**本进程开机那一刻**当家才做：
// 中途补位的场景下前任可能只是短暂停摆，它的在飞轮次不该被我们判死。
const staleTurns = weHoldLease ? sweepStaleTurns() : 0;
if (staleTurns > 0) console.log(`[startup] 清扫 ${staleTurns} 条因重启中断的处理单（已标记失败，可重试）`);
const pruned = weHoldLease ? pruneProactiveBacklog() : { orphans: 0, deduped: 0 };
if (pruned.orphans + pruned.deduped > 0) {
  console.log(`[startup] 主动性任务修复：孤儿清理 ${pruned.orphans} 条、堆积合并 ${pruned.deduped} 条`);
}

const server = createHttpServer({ rebind: applyLanBind });

/** 换绑期间由 applyLanBind 自己处理 error，别让下面那个"出错即退出"的处理器把进程带走。 */
let rebinding = false;

// 端口被占用时给一句人话，而不是抛一堆栈。
// 桌面端固定端口被占是常见的（用户同时开了两个窗口），必须能自己看懂发生了什么。
server.on("error", (error: NodeJS.ErrnoException) => {
  if (rebinding) return;
  if (error.code === "EADDRINUSE") {
    // 显示实际要绑的那个端口：桌面端 config.port 是 0（自动分配），照它印会变成「端口 0 已被占用」。
    const wanted = lan.effectivePort();
    console.error(`\n✗ 端口 ${wanted === 0 ? "（自动分配）" : String(wanted)} 已被占用。`);
    console.error("  换个端口：桌面端在「设置 → 系统与数据 → 手机与远程访问 → 固定端口」里改；命令行用 .env 的 PORT。\n");
  } else {
    console.error(`\n✗ 服务启动失败：${error.message}\n`);
  }
  clearRuntimeHandshake();
  process.exit(1);
});

// PORT=0 时由系统分配空闲端口，实际端口从 server.address() 取。
// 桌面端走这条路，避免和其他程序抢端口。
server.listen(lan.effectivePort(), lan.bindHost(), () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  writeRuntimeHandshake(port);

  console.log("──────────────────────────────────────────");
  console.log(`  ${personaConfig().character.name} 已启动`);
  // 用 .env 的 HOST 直接绑到非回环地址时，应用内开关可能从未打开过，访问码也就还没生成。
  // 不补这一下，手机能连到端口却永远过不了登录接口（expect === "" 必拒），
  // 文档里那条“改 HOST=0.0.0.0 就能用手机访问”就是假的。
  if (!lan.isLoopbackBind() && lan.lanCode() === "") lan.ensureCode();
  const lanUrls = lan.lanUrls(port);
  console.log(`  地址：http://127.0.0.1:${port}`);
  if (!lan.isLoopbackBind()) {
    console.log(`  局域网：${lanUrls.length > 0 ? lanUrls.join("  ") : "没找到可用网卡地址"}（需输入访问码）`);
  }
  console.log(`  数据：${config.dbPath}`);
  console.log(
    `  模型：${modelReadyNow() ? modelConfig().name : "echo（未配置密钥，先跑通链路）"}`,
  );
  console.log(`  主动性：${config.proactive.enabled ? `每 ${config.proactive.intervalMinutes} 分钟判断` : "关闭"}`);
  console.log(`  设置：/settings（在应用里改模型与角色卡）`);
  console.log("──────────────────────────────────────────");
  void selfCheck();
});

/**
 * 按当前设置重新绑定监听地址（「手机访问」开关打开/关掉时调用）。
 *
 * 只能在这条响应写完之后调：closeAllConnections() 会把在途连接一起掐掉，
 * 包括刚触发这次换绑的那条响应。所以 server.ts 里是 setTimeout 之后再喊它。
 *
 * 绑不上（端口被占 / 防火墙拦）时**退回只绑本机并把开关关掉**——
 * 界面绝不能显示「已打开」而实际进不来，那比功能不存在更糟。
 */
async function applyLanBind(): Promise<{ ok: boolean; error: string }> {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  const want = lan.bindHost();
  rebinding = true;
  try {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    const result = await new Promise<{ ok: boolean; error: string }>((resolve) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        resolve({
          ok: false,
          error: error.code === "EADDRINUSE" ? `端口 ${port} 被占用` : error.message,
        });
      };
      server.once("error", onError);
      server.listen(port, want, () => {
        server.off("error", onError);
        resolve({ ok: true, error: "" });
      });
    });
    if (result.ok) {
      lan.clearBindError();
      const urls = lan.lanUrls(port);
      console.log(want === "0.0.0.0"
        ? `[lan] 已允许手机访问：${urls.length > 0 ? urls.join("  ") : "没找到可用网卡地址"}（需输入访问码）`
        : "[lan] 已关闭手机访问：恢复为只绑本机");
      return result;
    }
    lan.setBindError(result.error);
    lan.setLanEnabled(false);
    console.warn(`[lan] 打开局域网访问失败：${result.error} —— 已退回只绑本机`);
    await new Promise<void>((resolve) => {
      server.listen(port, lan.bindHost(), () => resolve());
    });
    return result;
  } finally {
    rebinding = false;
  }
}

/**
 * 启动自检：模型接不通时，用户在界面上只会看到"它不理我"。
 * 所以启动后主动探一次，把问题直接打在控制台里，并且不阻塞服务启动。
 * 关掉它：.env 里 MODEL_STARTUP_CHECK=false。
 */
async function selfCheck(): Promise<void> {
  if (!modelReadyNow()) return;
  const settings = modelConfig();
  if (!settings.startupCheck) return;

  // 先测真连通——这才是"能不能用"。从前这里第一步就拉 /models，拉不到直接 return，
  // 于是不暴露模型列表端点的服务商（火山 plan 实测 404）永远停在门口：
  // 那句「模型自检失败」一次聊天都没测过，而聊天其实是通的。
  const ping = await pingChat(settings.name, 20_000);
  if (!ping.ok) {
    console.warn(`\n⚠️  模型「${settings.name}」实测不可用：${ping.error.message}`);
    console.warn(`   运行 npm run doctor 查看替代模型\n`);
    return;
  }
  console.log(`[selfcheck] ✓ 模型可用（${ping.elapsedMs}ms）`);

  // 列表只是附加信息：拉不到不报任何警（不代表不能用）；拉到了就顺便核对模型名在不在里面，
  // 因为实测有的服务商会让"没有可用渠道的模型名"挂到超时而不是报错。
  const listed = await listModels(8_000);
  if (listed.ok) {
    const chatIds = listed.ids.filter(isChatModelId);
    if (chatIds.length > 0 && !chatIds.includes(settings.name)) {
      console.warn(`\n⚠️  所配模型「${settings.name}」不在服务商返回的可用列表里（实测有的服务商会让请求挂住而不是报错）。`);
      console.warn(`   列表里可用的对话模型：${chatIds.slice(0, 6).join(", ")}`);
    }
  }
}

/**
 * 定期维护：保留策略不能只在启动时跑一次。这是个常驻进程，跑几周不重启很正常，
 * 而 model_calls（每行带响应全文）、已结束的任务行、没人引用的图片文件都在一直长。
 */
function maintenance(): void {
  if (!isPrimary()) return;
  try {
    pruneModelCalls();
    const tasks = pruneFinishedTasks();
    const media = sweepOrphanMedia();
    if (tasks > 0 || media.removed > 0) {
      console.log(`[maintenance] 清理：主动性历史 ${tasks} 条、孤儿图片 ${media.removed} 个（${(media.bytes / 1024 / 1024).toFixed(1)}MB）`);
    }
  } catch (error) {
    console.error(`[maintenance] 清理失败：`, error instanceof Error ? error.message : String(error));
  }
}

/** 统一退出：清握手文件 → 关服务 → 退出。重复调用无副作用。 */
let shuttingDown = false;
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  endDuty();
  clearInterval(heartbeat);
  wechat.dispose();
  qq.dispose();
  releasePrimary();
  clearRuntimeHandshake();
  server.close(() => process.exit(code));
  // 兜底：连接卡住时不要永远等下去（外壳杀进程前给个干净的窗口）。
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\n正在退出…");
    shutdown(0);
  });
}

/**
 * 桌面模式（sidecar）：父进程一死，stdin 就 EOF。
 * 没有这段，Node 会变成孤儿进程一直挂着——用户关了窗口，任务管理器里却还有它。
 * 这是 Tauri sidecar 的经典坑，必须在服务端解决，不能指望外壳总能杀干净。
 */
process.stdin.on("close", () => shutdown(0));
process.stdin.resume();
