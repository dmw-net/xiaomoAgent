// 捆包等价性实证：同一份输入，源码版与捆包版必须给出**逐字节相同**的系统提示词。
//
// 为什么必须有这个脚本：中文编码那层（scripts/cjk-encode.mjs）改的是**运行产物**，
// 而 `npm run smoke` 跑的是 `src/*.ts` 源码——它对捆包一分钱保障都没有。
// 换句话说：改完打包链，测试全绿也可能是白屏。所以这里真的把两份后端各起一个隔离实例，
// 打同一个 /api/settings/preview，比对输出。
//
// 用法：node scripts/verify-bundle.mjs        （先 npm run bundle:backend）
// 控制组刻意留大：提示词汉字数 < MIN_CJK 直接判失败，防止「两边都空 = 相等」这种假绿。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planCjkEncoding } from "./cjk-encode.mjs";

const root = join(import.meta.dirname, "..");
const PORT_SRC = 18993;
const PORT_DSK = 18994;
const MIN_CJK = 300;            // 体量下界：低于此说明没真正拼出内容，比对无意义
const MIN_ASSETS_IN_PROMPT = 3; // 提示词里至少要有几条「被编码的资产」，否则一致也可能是空转

const failures = [];
const ok = (name) => console.log("  ✓ " + name);
const bad = (name, extra = "") => { failures.push(name + (extra ? " :: " + extra : "")); console.log("  ✗ " + name + (extra ? "\n      " + extra : "")); };

const artifact = join(root, "dist-desktop", "server.mjs");
const finalAll = readFileSync(artifact, "utf8");
if (!existsSync(artifact)) {
  console.error("✗ 没有 dist-desktop/server.mjs——先跑 npm run bundle:backend");
  process.exit(1);
}

/** 起一个隔离后端：独立 DATA_DIR / 端口 / 库文件，绝不碰开发用的 data/。 */
function startInstance({ label, entry, port, useDesktopConfig, extraArgs = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "xm-verify-"));
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: dir,
    MEDIA_DIR: join(dir, "media"),
    DB_PATH: join(dir, "xiaomo.db"),
    MODEL_MODE: "echo",
    CHARACTER_NAME: "小茉",
    OWNER_NAME: "朋友",
    PROACTIVE_ENABLED: "false",
    MODEL_STARTUP_CHECK: "false",
    LOG_LEVEL: "warn",
  };
  let args;
  if (useDesktopConfig) {
    // 与真机同一入口：src/desktop.ts 捆包后的 server.mjs，配置走 desktop.json
    const cfg = join(dir, "desktop.json");
    writeFileSync(cfg, JSON.stringify({
      PORT: port, DATA_DIR: dir, RUNTIME_FILE: join(dir, "runtime.json"),
      DB_PATH: "xiaomo.db", MEDIA_DIR: env.MEDIA_DIR, MODEL_MODE: "echo",
      CHARACTER_NAME: "小茉", OWNER_NAME: "朋友", PROACTIVE_ENABLED: "false",
      MODEL_STARTUP_CHECK: "false",
    }), "utf8");
    args = ["--experimental-sqlite", entry, "--config", cfg, ...extraArgs];
    delete env.PORT; delete env.DATA_DIR; delete env.DB_PATH; delete env.MEDIA_DIR;
    delete env.MODEL_MODE; delete env.CHARACTER_NAME; delete env.OWNER_NAME;
    delete env.PROACTIVE_ENABLED; delete env.MODEL_STARTUP_CHECK;
    delete env.HOST;
  } else {
    args = ["--experimental-sqlite", entry, ...extraArgs];
  }
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  return { label, child, dir, log, port };
}

async function waitReady(inst, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inst.child.exitCode !== null) {
      throw new Error(`${inst.label} 进程已退出（code=${inst.child.exitCode}）：\n${inst.log.join("").slice(0, 1200)}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${inst.port}/api/status`);
      if (r.ok) return;
    } catch { /* 还没起 */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`${inst.label} 25 秒内没就绪：\n${inst.log.join("").slice(0, 1200)}`);
}

/** SIGKILL 只是投递信号：等到 exit 事件才说明进程真的没了、句柄开始回收。超时也放行，交给调用方的重试。 */
function waitExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function preview(inst, body) {
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/settings/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok || json.ok !== true) throw new Error(`${inst.label} 预览失败 ${r.status}：${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

const cjk = (s) => (s.match(/[一-鿿]/g) ?? []).length;

const src = startInstance({ label: "源码版", entry: "src/index.ts", port: PORT_SRC, useDesktopConfig: false });
const dsk = startInstance({ label: "捆包版", entry: "dist-desktop/server.mjs", port: PORT_DSK, useDesktopConfig: true });

try {
  await Promise.all([waitReady(src), waitReady(dsk)]);
  ok("两个隔离实例都起来了（捆包版走的是真机同一入口 desktop.ts → server.mjs）");

  const card = {
    name: "测试角色",
    identity: "你是测试角色，说话短，爱用括号补一句吐槽。",
    background: "你们在同一个城市的独立书店做志愿，每周五晚上盘点书架，店长养了一只不理人的橘猫。",
    relationship: "认识两年，算不上热络，但每次见面都能聊到打烊。你搬家那次她来帮扛箱子。",
  };
  const owner = { name: "阿哲", pronoun: "他", note: "做后端，最近在赶一个迁移项目。" };

  // 两边各喂同一套种子：联系人 + 一篇技能 + 生活线/梗概/温度计 + 打开陪伴增强。
  // 只比空库的预览没有承重——那些长提示词段落根本不会出现在输出里，比对就成了空转。
  for (const inst of [src, dsk]) {
    const base = `http://127.0.0.1:${inst.port}`;
    const post = async (p, body) => {
      const r = await fetch(base + p, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(`${inst.label} ${p} 失败 ${r.status}：${JSON.stringify(j).slice(0, 200)}`);
      return j;
    };
    const created = await post("/api/contacts", card);
    const cid = created.contact?.id ?? created.id ?? created.contactId;
    if (typeof cid !== "string" || cid === "") throw new Error(`${inst.label} 拿不到联系人 id：${JSON.stringify(created).slice(0, 200)}`);
    inst.cid = cid;
    await post("/api/skills", { name: "inventory-flow", content: "---\nname: inventory-flow\ndescription: 周五盘点的顺序\n---\n先数杂志架，再数绘本架，最后补咖啡豆。" });
    const put = await fetch(`${base}/api/contacts/${encodeURIComponent(cid)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lifeline: "上周书店换了收银系统，她吐槽了两天；她答应帮我带猫粮。",
        recap: "上次聊到他赶迁移项目加班到十一点，她让他早点睡。",
        bond: { stage: "熟悉的朋友", warmth: 72, mood: "放松" },
        features: { webSearch: true, skills: true, lifeline: true, recap: true, bond: true },
      }),
    });
    if (!put.ok) throw new Error(`${inst.label} 更新联系人失败 ${put.status}：${(await put.text()).slice(0, 200)}`);
  }
  ok("两边种子写入完成（联系人 + 技能 + 生活线/梗概/温度计/功能开关）");

  const a = await preview(src, { contactId: src.cid });
  const b = await preview(dsk, { contactId: dsk.cid });

  if (cjk(b.prompt) < MIN_CJK) bad("控制组：捆包版提示词体量够大", `汉字 ${cjk(b.prompt)} < ${MIN_CJK}`);
  else ok(`控制组：捆包版提示词汉字 ${cjk(b.prompt)}（>= ${MIN_CJK}，比对不是空转）`);

  // 真正的承重判定：把产物里每个编码载荷解出来，看这条提示词里**确实装着**其中几条。
  // 没有这条，「两边一致」可能只是「两边都短到没碰到被编码的串」。
  const payloads = [...finalAll.matchAll(/xm\w+\("([A-Za-z0-9+/=]{16,})"\)/g)]
    .map((m) => Buffer.from(m[1], "base64").toString("utf8"));
  const hit = payloads.filter((p) => p.length > 6 && b.prompt.includes(p));
  if (payloads.length === 0) bad("产物里解不出任何编码载荷：编码层没进文件");
  else if (hit.length < MIN_ASSETS_IN_PROMPT) {
    bad(`提示词里只命中 ${hit.length} 条被编码资产（要求 >= ${MIN_ASSETS_IN_PROMPT}）`,
      `产物共解出 ${payloads.length} 条`);
  } else {
    ok(`提示词里命中 ${hit.length} 条被编码资产（产物共 ${payloads.length} 条），例：${JSON.stringify(hit[0]).slice(0, 60)}`);
  }

  if (a.prompt === b.prompt) ok(`系统提示词逐字节相同（源码版 vs 捆包版，${b.prompt.length} 字符）`);
  else {
    const n = Math.min(a.prompt.length, b.prompt.length);
    let i = 0;
    while (i < n && a.prompt[i] === b.prompt[i]) i++;
    bad("系统提示词逐字节相同", `第 ${i} 字符起分叉\n      源码版: ${JSON.stringify(a.prompt.slice(i, i + 160))}\n      捆包版: ${JSON.stringify(b.prompt.slice(i, i + 160))}`);
  }

  for (const key of ["memoryNote"]) {
    if (a[key] === b[key]) ok(`${key} 一致`);
    else bad(`${key} 不一致`, `${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}`);
  }

  // 再抽一条会命中被编码串的接口：设置读接口。
  // 两边各自的临时目录与随机生成的配置档 id 必然不同，比对前统一掩码——
  // 这里要比的是**文案与结构**，不是这两个随机量。
  const norm = (inst, text) => text
    .split(inst.dir).join("<DIR>")
    // 服务返回的路径是 Windows 反斜杠形态，和 mkdtemp 给的斜杠不一样，所以按「随机临时目录名」再掩一次
    .replace(/xm-verify-[A-Za-z0-9]+/g, "<TMP>")
    .replace(/:"[A-Za-z0-9]{6,10}"/g, ':"<ID>"')
    // `desktop` 这一项**本来就该不一样**：捆包版跑在 desktop.json 下（有值），
    // 源码版跑在 .env 形态下（后端回 null）。先把值掩掉再比其余部分，
    // 但下面另有一条断言正面钉住这个差异，免得掩码顺手把真问题也盖掉。
    .replace(/"desktop":(?:null|\{[^{}]*\})/g, '"desktop":<DESKTOP>');
  const s1 = norm(src, await fetch(`http://127.0.0.1:${PORT_SRC}/api/settings`).then((r) => r.text()));
  const s2 = norm(dsk, await fetch(`http://127.0.0.1:${PORT_DSK}/api/settings`).then((r) => r.text()));
  if (s1 === s2 && s1.length > 20) ok("设置读接口除 desktop 一项外完全一致（差异已被显式断言钉住）");
  else {
    let i = 0;
    while (i < Math.min(s1.length, s2.length) && s1[i] === s2[i]) i++;
    bad("设置读接口除 desktop 一项外完全一致", `第 ${i} 字符起分叉\n      源码版: ${JSON.stringify(s1.slice(Math.max(0, i - 60), i + 60))}\n      捆包版: ${JSON.stringify(s2.slice(Math.max(0, i - 60), i + 60))}`);
  }
  const srcSnap = await (await fetch(`http://127.0.0.1:${PORT_SRC}/api/settings`)).json();
  const dskSnap = await (await fetch(`http://127.0.0.1:${PORT_DSK}/api/settings`)).json();
  if (srcSnap.desktop === null && dskSnap.desktop && typeof dskSnap.desktop.tray === "boolean") {
    ok("desktop 这项的差异是形态差异：源码版 null、捆包版有值");
  } else {
    bad("desktop 这项的差异不对", `源码版=${JSON.stringify(srcSnap.desktop)} 捆包版=${JSON.stringify(dskSnap.desktop)}`);
  }
  // 缺省值钉死：这份 desktop.json 里刻意没写 AUTOSTART/TRAY，快照必须回"两个都不开"。
  // 外壳侧（src-tauri/src/lib.rs 的 prefs_from_json / TrayState 初值）必须与之一致——
  // 两边漂移的后果是第一次启动"界面显示关闭、托盘却已经建起来"。
  const fresh = JSON.stringify(dskSnap.desktop);
  if (fresh === '{"autostart":false,"tray":false}') ok("两项偏好的缺省值都是关（与外壳侧同源）");
  else bad("两项偏好的缺省值应当都是关", fresh);

  // 桌面两项偏好的**真链路**（捆包版才有 desktop.json）：写文件 + 通过 stdout 通知外壳。
  // 外壳那半段（读标记 → 写注册表/改关窗行为）只有真窗口能验，这里验到"标记确实发出去了"为止。
  const desktopWrite = await fetch(`http://127.0.0.1:${PORT_DSK}/api/settings/desktop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autostart: true, tray: false }),
  });
  const desktopBody = await desktopWrite.json();
  if (desktopWrite.ok && desktopBody.ok === true) ok("桌面偏好写接口在捆包版返回 ok");
  else bad("桌面偏好写接口在捆包版返回 ok", `${desktopWrite.status} ${JSON.stringify(desktopBody).slice(0, 200)}`);

  const cfgText = readFileSync(join(dsk.dir, "desktop.json"), "utf8");
  const cfgJson = JSON.parse(cfgText);
  if (cfgJson.AUTOSTART === true && cfgJson.TRAY === false) ok("desktop.json 存下了 AUTOSTART/TRAY");
  else bad("desktop.json 没存下两项偏好", cfgText.slice(0, 200));
  if (typeof cfgJson.DATA_DIR === "string" && cfgJson.DATA_DIR.length > 3) {
    ok("写偏好没有把外壳那几项（DATA_DIR 等）抹掉");
  } else {
    bad("写偏好把外壳的配置抹掉了", cfgText.slice(0, 200));
  }

  await new Promise((resolve) => setTimeout(resolve, 400)); // 等 stdout 汇到外壳侧
  const markerLine = dsk.log.join("").split("\n").find((l) => l.includes("XIAOMO-PREF")) ?? "";
  if (markerLine.includes('"autostart":true') && markerLine.includes('"tray":false')) {
    ok("后端确实往 stdout 发了 XIAOMO-PREF 标记（外壳靠它做到不用重启就生效）");
  } else {
    bad("没看到 XIAOMO-PREF 标记", JSON.stringify(markerLine));
  }

  // 技能清单确实进了提示词，且技能目录段落（被编码的资产）还原正确
  if (b.prompt.includes("inventory-flow") && b.prompt.includes("周五盘点的顺序")) {
    ok("技能清单出现在捆包版提示词里（解码链路真的在跑）");
  } else {
    bad("技能清单没出现在捆包版提示词里", b.prompt.slice(0, 300));
  }
} finally {
  for (const inst of [src, dsk]) {
    if (inst.child.exitCode === null) inst.child.kill("SIGKILL");
    // 2026-10-17 实测：刚被 SIGKILL 的子进程还攥着 xiaomo.db / -wal / -shm（目录里就剩这三个
    // 文件），这时 rmSync 立刻报 EPERM——实测 1ms 就返回，带上 maxRetries: 20 / retryDelay: 300
    // 也没用（这个耗时说明那 20 次重试根本就没发生）。等 exit 只解决一半：句柄还会晚一拍才回收，
    // 所以自己带节奏重试。实测等 100ms 就能删掉，这里给到 ~2 秒再认输。
    await waitExit(inst.child);
    let lastErr = null;
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(inst.dir, { recursive: true, force: true });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // 认输时打全量 message：以前截断了 60 字符，正好把「到底是哪个文件被占」切掉，
    // 看上去像是 Temp 根目录被拒——其实那只是 \\?\ 前缀的长路径开头。
    if (lastErr) console.log(`（临时目录没删掉，可手动清理：${inst.dir} —— ${lastErr.code} ${lastErr.message}）`);
  }
}

// 反证：拿最终产物再跑一遍资产判定，必须一条够长中文都找不到（与构建期同一把尺子）。
const final = readFileSync(artifact, "utf8");
const unescaped = final.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const leftoverRuns = planCjkEncoding(final, { minCjk: 12 }).flatMap((p) => p.values);
if (leftoverRuns.length === 0) ok("产物里够长中文字面量 = 0 段");
else bad("产物里够长中文字面量 = 0 段", `仍有 ${leftoverRuns.length} 段：${leftoverRuns.slice(0, 2).join(" | ")}`);
const known = "手机前置镜头自拍：手臂长度的近距离透视";
if (!unescaped.includes(known)) ok("已知的自拍构图提示词在产物里查不到（明文）");
else bad("已知的自拍构图提示词仍在产物明文里");

console.log(`\nverify-bundle：${failures.length === 0 ? "全部通过" : failures.length + " 项失败"}`);
process.exit(failures.length === 0 ? 0 : 1);
