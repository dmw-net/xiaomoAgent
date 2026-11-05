// ── NapCat 本机托管：安装 → 启动 → 配置 → 登录，一条龙 ───────────────
//
// 为什么存在这一层：OneBot 渠道的唯一缺口是"协议端从哪来"。以前答案是"用户自己去
// 下载 NapCat、开两个端口、回小茉填地址"——把集成工作原样丢给用户。现在小茉自己托管：
//   1. install：从官方 release 下载 NapCat.Shell 到数据目录，解压即用（免安装）；
//   2. start：拉起 launcher（挂本机已装的 QQ NT），等 WebUI 起来；
//   3. configure：用 WebUI API 热写 OneBot 网络配置（HTTP 3000 发件 / WS 3001 收件）、
//      记住 autoLoginAccount——重启不再要扫码；
//   4. login：已记录过账号就自动登录；首次登录把二维码链接交还给界面让用户扫。
//
// 与用户自备 NapCat 完全兼容：这套只管"小茉托管的那一份"（在数据目录的 napcat/ 下），
// 用户自己装的、手动填地址的那份不受影响。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { applyOnebotSettings } from "./qq-onebot.ts";
import { qq, qqUsesBackend } from "./qq.ts";
import { logModelCall } from "../core/logs.ts";

/** 托管目录：数据目录下的 napcat/（迁移数据目录时会跟着走）。 */
export const napcatDir = (): string => join(dirname(config.dbPath), "napcat");
const shellFile = (...parts: string[]): string => join(napcatDir(), ...parts);
const zipPath = (): string => join(napcatDir(), "NapCat.Shell.zip");

const WEBUI_PORT = 6099;
const WEBUI_ORIGIN = `http://127.0.0.1:${WEBUI_PORT}`;
/** 小茉要 NapCat 开出来的两条通道（与连接面板的默认值一致）。 */
export const NAPCAT_HTTP_PORT = 3000;
export const NAPCAT_WS_PORT = 3001;
const DOWNLOAD_URL = "https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip";

export type NapcatStatus = {
  installed: boolean;
  running: boolean;
  loggedIn: boolean;
  /** 登录阶段（waiting_qrcode / ready 等），界面决定显示二维码还是账号卡。 */
  phase: string;
  /** 首次登录用的二维码链接（txz.qq.com…），前端渲染成图。 */
  qrUrl: string;
  uin: string;
  nickname: string;
  error: string;
};

/** WebUI 的访问令牌：首启时 NapCat 生成，落在 webui.json。 */
function readWebuiToken(): string {
  try {
    const raw = JSON.parse(readFileSync(shellFile("config", "webui.json"), "utf8")) as { token?: unknown };
    return typeof raw.token === "string" ? raw.token : "";
  } catch { return ""; }
}

/** WebUI API 调用：登录拿 Credential，其余带 Bearer。失败返回 null（不抛，状态探测不兴炸）。 */
async function webuiApi(path: string, body: unknown, credential?: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(WEBUI_ORIGIN + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(credential !== undefined && credential !== "" ? { authorization: `Bearer ${credential}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await response.json()) as { code?: number; data?: unknown };
    if (data.code !== 0) return null;
    return (data.data ?? {}) as Record<string, unknown>;
  } catch { return null; }
}

/** OneBot HTTP API 直连（3000 端口），验证发件通道真的通了。 */
async function obLoginInfo(): Promise<{ uin: string; nickname: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${NAPCAT_HTTP_PORT}/get_login_info`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(4000),
    });
    const data = (await response.json()) as { data?: { user_id?: unknown; nickname?: unknown } };
    return {
      uin: String(data.data?.user_id ?? ""),
      nickname: String(data.data?.nickname ?? ""),
    };
  } catch { return { uin: "", nickname: "" }; }
}

/** 综合状态：安装了吗 / 起来了吗 / 登录了吗 / 卡在哪一步。界面 4 秒轮一次。
 *  托管目录之外跑着的 NapCat 也要认：3000 端口有应答就算"已连接"——
 *  用户自己装的那份是合法形态，别逼用户再装一份托管的。 */
export async function napcatStatus(): Promise<NapcatStatus> {
  const out: NapcatStatus = {
    installed: existsSync(shellFile("napcat.mjs")),
    running: false, loggedIn: false, phase: "", qrUrl: "", uin: "", nickname: "", error: "",
  };
  // 先探 OneBot 通道：通了就什么都不用做（自备/托管都算数）。
  const viaOb = await obLoginInfo();
  if (viaOb.uin !== "") {
    out.running = true; out.loggedIn = true;
    out.uin = viaOb.uin; out.nickname = viaOb.nickname;
    // 扫码完成后 HTTP 通道会先恢复，状态探测走这条快路径；仍要把新号落成自动登录。
    if (readAutoLoginAccount() !== out.uin) {
      const managedToken = readWebuiToken();
      if (managedToken !== "") {
        const managedCredential = await napcatCredential(managedToken);
        if (managedCredential !== null) await rememberNapcatLogin(out.uin, managedCredential);
      }
    }
    return out;
  }
  const token = readWebuiToken();
  if (token === "") return out;
  const cred = await napcatCredential(token);
  if (cred === null) return out;
  out.running = true;
  const status = await webuiApi("/QQLogin/CheckLoginStatus", {}, cred);
  if (status === null) return out;
  out.phase = String(status.loginPhase ?? "");
  out.loggedIn = status.isLogin === true && status.coreReady === true;
  if (status.isLogin === false && typeof status.qrcodeurl === "string" && status.qrcodeurl !== "") {
    out.qrUrl = status.qrcodeurl;
  }
  if (out.loggedIn) {
    const info = await obLoginInfo();
    out.uin = info.uin; out.nickname = info.nickname;
    // 首次扫码或切换账号后，状态轮询会先于启动请求看到登录成功。
    await rememberNapcatLogin(info.uin, cred);
  }
  return out;
}

/** 把当前登录号写成 NapCat 的自动登录账号；否则下次启动又会退回扫码页。 */
async function rememberNapcatLogin(uin: string, credential: string): Promise<void> {
  if (uin === "" || readAutoLoginAccount() === uin) return;
  await webuiApi("/QQLogin/SetQuickLoginQQ", { uin }, credential);
  persistAutoLoginAccount(uin);
}

/** 登录 WebUI（token 的 SHA256 + ".napcat" 后缀是它的鉴权约定），失败返回 null。 */
async function napcatCredential(token: string): Promise<string | null> {
  const hash = createHash("sha256").update(token + ".napcat").digest("hex");
  const data = await webuiApi("/auth/login", { hash });
  const credential = data === null ? undefined : data.Credential;
  return typeof credential === "string" ? credential : null;
}

/** 下载 NapCat.Shell 并解压到数据目录。解压用系统自带的 Expand-Archive（Windows 保证有）。 */
export async function installNapcat(): Promise<{ ok: boolean; error: string }> {
  if (!existsSync(napcatDir())) mkdirSync(napcatDir(), { recursive: true });
  try {
    const started = Date.now();
    const response = await fetch(DOWNLOAD_URL, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 1_000_000) throw new Error(`下载不完整（${body.length} 字节），稍后再试`);
    writeFileSync(zipPath(), body);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -LiteralPath '${zipPath()}' -DestinationPath '${napcatDir()}' -Force`,
      ], { stdio: "ignore" });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`解压失败（exit ${code}）`)));
      child.on("error", reject);
    });
    logModelCall({ purpose: "qq", ok: true, model: "onebot", url: "napcat/install", elapsedMs: Date.now() - started, message: `NapCat.Shell 已装到 ${napcatDir()}` });
    return { ok: true, error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logModelCall({ purpose: "qq", ok: false, code: "NAPCAT_INSTALL", model: "onebot", url: "napcat/install", elapsedMs: 0, message });
    return { ok: false, error: message };
  }
}

/**
 * 拉起 NapCat 并把它调教成小茉要的样子（配置 + 自动登录），整个流程最多约 3 分钟：
 *   spawn launcher → 轮询 WebUI 就绪 → 登录 WebUI → 热写 OB11 网络配置 → 记 autoLoginAccount
 *   → 等登录完成（已记录过账号则自动登录；首次则返回二维码链接让界面展示）。
 * 返回终态：needsQr=true 时调用方展示 qrUrl 轮询 napcatStatus 直到 loggedIn。
 */
export async function startNapcat(): Promise<{ ok: boolean; needsQr: boolean; error: string }> {
  const started = Date.now();
  try {
    if (!existsSync(shellFile("launcher.bat"))) return { ok: false, needsQr: false, error: "NapCat 还没安装，先点「安装 NapCat」" };
    // 起进程：detached + unref，让 NapCat 独立于小茉活着（用户关小茉不影响协议端）。
    const child = spawn("cmd", ["/c", "launcher.bat"], { cwd: napcatDir(), detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    // 等 WebUI 就绪（首启要拉起整个 QQ NT，慢）。
    let token = "";
    for (let waited = 0; waited < 90_000; waited += 3000) {
      await new Promise((r) => setTimeout(r, 3000));
      token = readWebuiToken();
      if (token !== "") break;
    }
    if (token === "") return { ok: false, needsQr: false, error: "NapCat 起来了但 WebUI 没就绪，稍后点「重试」再看" };
    const credential = await napcatCredential(token);
    if (credential === null) return { ok: false, needsQr: false, error: "WebUI 起来了但登录失败，检查端口 6099 是否被占用" };

    // 记住自动登录账号：第一次是空（要扫码），用户扫过一次后这里持久化，重启免扫。
    const savedAccount = readAutoLoginAccount();

    // 热写 OneBot 网络配置：HTTP 3000 发件 + WS 3001 收件（与连接面板默认值一致）。
    const ob11 = {
      network: {
        httpServers: [{ name: "xiaomo-out", enable: true, port: NAPCAT_HTTP_PORT, host: "127.0.0.1", enableCors: true, enableWebsocket: true, messagePostFormat: "array", token: "", debug: false }],
        httpSseServers: [], httpClients: [], httpClientsPost: [],
        websocketServers: [{ name: "xiaomo-in", enable: true, port: NAPCAT_WS_PORT, host: "127.0.0.1", messagePostFormat: "array", reportSelfMessage: false, token: "", enableForce: false, debug: false }],
        websocketClients: [], plugins: [],
      },
      musicSignUrl: "", enableLocalFile2Url: false, parseMultMsg: false, imageDownloadProxy: "",
      timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
    };
    await webuiApi("/OB11Config/SetConfig", { config: JSON.stringify(ob11) }, credential);
    if (savedAccount !== "") await webuiApi("/WebUIConfig/UpdateConfig", { autoLoginAccount: savedAccount }, credential);

    // 等登录：已记录账号 → NapCat 自动登录；首次 → 卡在 waiting_qrcode，把二维码交出去。
    for (let waited = 0; waited < 90_000; waited += 4000) {
      const status = await webuiApi("/QQLogin/CheckLoginStatus", {}, credential);
      if (status === null) continue;
      if (status.isLogin === true && status.coreReady === true) {
        // 登录后把当前号记成自动登录，下次启动免扫码。
        const info = await obLoginInfo();
        if (info.uin !== "") {
          await webuiApi("/WebUIConfig/UpdateConfig", { autoLoginAccount: info.uin }, credential);
          persistAutoLoginAccount(info.uin);
        }
        // 一键流的最后一环：把刚配好的两条通道回写进小茉自己的连接设置并热连——
        // 否则发件通了、收件的 forward WS 却没人去连，"投递成功但收不到消息"就是这么来的。
        applyOnebotSettings({
          httpBase: `http://127.0.0.1:${NAPCAT_HTTP_PORT}`,
          wsUrl: `ws://127.0.0.1:${NAPCAT_WS_PORT}`,
        });
        if (qqUsesBackend("onebot")) { qq.stopAll(); qq.startAll(); }
        logModelCall({ purpose: "qq", ok: true, model: "onebot", url: "napcat/start", elapsedMs: Date.now() - started, message: `NapCat 已就绪（${info.uin} ${info.nickname}），收发通道已接回小茉` });
        return { ok: true, needsQr: false, error: "" };
      }
      if (status.loginPhase === "waiting_qrcode" && typeof status.qrcodeurl === "string") {
        persistAutoLoginAccount(savedAccount); // 没记录过就先空着，等扫码成功那轮再落
        return { ok: true, needsQr: true, error: "" };
      }
    }
    return { ok: false, needsQr: false, error: "等待登录超时：如果没弹出二维码，点「重试」再看状态" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logModelCall({ purpose: "qq", ok: false, code: "NAPCAT_START", model: "onebot", url: "napcat/start", elapsedMs: Date.now() - started, message });
    return { ok: false, needsQr: false, error: message };
  }
}


/**
 * 切换托管 NapCat 当前登录的 QQ。
 *
 * NapCat 一个进程只承载一个 QQ，也没有“退出登录”API；可行做法是清掉自动登录账号再
 * 重启进程，让它回到扫码页。重启会短暂中断所有 OneBot 收发，所以界面必须先确认。
 * 登录完成后由 napcatStatus 轮询把新号重新写回自动登录。
 */
export async function reloginNapcat(): Promise<{ ok: boolean; needsQr: boolean; error: string }> {
  const started = Date.now();
  try {
    if (!existsSync(shellFile("launcher.bat"))) {
      return { ok: false, needsQr: false, error: "只有小茉托管的 NapCat 能从界面切换 QQ" };
    }
    const token = readWebuiToken();
    if (token === "") return { ok: false, needsQr: false, error: "NapCat WebUI 还没就绪，稍后再试" };
    const credential = await napcatCredential(token);
    if (credential === null) return { ok: false, needsQr: false, error: "登录 NapCat WebUI 失败，无法切换 QQ" };

    // 本地记录和 NapCat 的自动登录都要清空，否则重启后会直接登回原账号。
    persistAutoLoginAccount("");
    const cleared = await webuiApi("/QQLogin/SetQuickLoginQQ", { uin: "" }, credential);
    if (cleared === null) return { ok: false, needsQr: false, error: "清除自动登录账号失败，稍后再试" };
    const restarted = await webuiApi("/QQLogin/RestartNapCat", {}, credential);
    if (restarted === null) return { ok: false, needsQr: false, error: "重启 NapCat 失败，稍后再试" };

    // WebUI 会随进程重启短暂不可用；持续重登并等新的扫码阶段出现。
    for (let waited = 0; waited < 120_000; waited += 3000) {
      await new Promise((r) => setTimeout(r, 3000));
      const nextToken = readWebuiToken();
      if (nextToken === "") continue;
      const nextCredential = await napcatCredential(nextToken);
      if (nextCredential === null) continue;
      const status = await webuiApi("/QQLogin/CheckLoginStatus", {}, nextCredential);
      if (status === null) continue;
      if (status.loginPhase === "waiting_qrcode" && typeof status.qrcodeurl === "string" && status.qrcodeurl !== "") {
        logModelCall({ purpose: "qq", ok: true, model: "onebot", url: "napcat/relogin", elapsedMs: Date.now() - started, message: "已清除原登录账号，等待扫码切换 QQ" });
        return { ok: true, needsQr: true, error: "" };
      }
    }
    return { ok: false, needsQr: false, error: "等待切换二维码超时，稍后再试" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logModelCall({ purpose: "qq", ok: false, code: "NAPCAT_RELOGIN", model: "onebot", url: "napcat/relogin", elapsedMs: Date.now() - started, message });
    return { ok: false, needsQr: false, error: message };
  }
}

/** 自动登录账号的本地记录（napcat.json 之外的自己的一行 KV 文件，坏档按空处理）。 */
function autoLoginFile(): string { return shellFile("config", "xiaomo-autologin.txt"); }function readAutoLoginAccount(): string {
  try { return readFileSync(autoLoginFile(), "utf8").trim(); } catch { return ""; }
}
function persistAutoLoginAccount(uin: string): void {
  try {
    if (!existsSync(shellFile("config"))) mkdirSync(shellFile("config"), { recursive: true });
    writeFileSync(autoLoginFile(), uin + "\n", "utf8");
  } catch { /* 写不进就算了，大不了下次再扫 */ }
}

// ── 开机随小茉自动拉起 ───────────────────────────────────────────
// 托管 NapCat 装好后（自动登录已记住），小茉每次启动顺带把它拉起来——
// 用户关机重开不应该再点一次「启动 NapCat」。已在跑就什么都不做。
export function autostartNapcatIfInstalled(): void {
  if (!existsSync(shellFile("launcher.bat"))) return;
  void (async () => {
    try {
      const response = await fetch(`${WEBUI_ORIGIN}/api/base/GetNapCatVersion`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { console.log("[napcat] 已在运行，跳过自动拉起"); return; }
    } catch { /* 连不上 = 没在跑，继续拉起 */ }
    try {
      const child = spawn("cmd", ["/c", "launcher.bat"], { cwd: napcatDir(), detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      console.log("[napcat] 已随小茉自动拉起（自动登录会在几秒后接管）");
    } catch (error) {
      console.warn("[napcat] 自动拉起失败：", error instanceof Error ? error.message : String(error));
    }
  })();
}
