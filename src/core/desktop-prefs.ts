// 桌面外壳的两项偏好：开机自动启动、关窗后留在托盘。
//
// 为什么存在 desktop.json 而不是数据库的 kv 表：这两个值是**外壳**在启动那一刻就要用的
// （托盘决定关窗行为、自启决定注册表），而外壳读不到 SQLite（它只负责把 node 拉起来）。
// desktop.json 是外壳与后端之间唯一的共享文件，一个真源。
//
// 为什么改完还要往 stdout 打一行标记：外壳只在启动时读一次 desktop.json，
// 用户点完开关不重启就看不到效果，是最容易被当成 bug 的那种"点了没反应"。
// 外壳本来就在把 sidecar 的 stdout 收进 backend.log（lib.rs），顺着这条现成的通道
// 带一句 `XIAOMO-PREF {...}`，它当场把注册表和托盘行为改掉——不用新开 IPC 面，
// 也不用给远程 origin 加任何权限。
//
// 标记行同时会被写进 backend.log：留着，它是"哪一次点击真的送达了外壳"的唯一凭证。

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";

export type DesktopPrefs = { autostart: boolean; tray: boolean };

const DEFAULTS: DesktopPrefs = { autostart: false, tray: false };

/** 桌面外壳模式下才有 desktop.json；dev / CLI 跑的是 .env，这里一律返回空。 */
export const desktopManaged = (): boolean => config.desktopConfigFile !== "";

/** desktop.json 里的布尔偏好：缺省按 DEFAULTS，认不出的值也按缺省（不猜）。 */
export function readDesktopPrefs(): DesktopPrefs {
  const out = { ...DEFAULTS };
  if (!desktopManaged()) return out;
  let raw: string;
  try {
    raw = readFileSync(config.desktopConfigFile, "utf8");
  } catch {
    return out; // 首次启动还没写过配置文件
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return out;
  }
  for (const key of Object.keys(DEFAULTS) as Array<keyof DesktopPrefs>) {
    // 外壳写的是大写环境变量形态（AUTOSTART），后端读写同名，保持与 DATA_DIR 一致
    const value = parsed[key.toUpperCase()];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * 落盘 + 通知外壳。返回写进去的值；非桌面模式直接抛（调用方是桌面专属的那行开关）。
 * 写失败要让界面看到——静默失败的用户以为开了，下次开机却没有，最难查。
 */
export function setDesktopPrefs(patch: Partial<DesktopPrefs>): DesktopPrefs {
  if (!desktopManaged()) throw new Error("这两项只有桌面版才有（开发模式跟随 .env 启动）");
  const current = readDesktopPrefs();
  const next: DesktopPrefs = { ...current, ...patch };
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(config.desktopConfigFile, "utf8")) as Record<string, unknown>;
  } catch { /* 没有或坏了就从空对象重建，下面的键会补齐 */ }
  for (const key of Object.keys(next) as Array<keyof DesktopPrefs>) {
    existing[key.toUpperCase()] = next[key];
  }
  // 外壳在 setup 里会重写这个文件，但它是**整份替换**的写法——这里必须一起改掉，
  // 否则用户设置的偏好活不过下一次启动（见 lib.rs 里合并写的那段）。
  const tmp = `${config.desktopConfigFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf8");
  renameSync(tmp, config.desktopConfigFile);
  process.stdout.write(`XIAOMO-PREF ${JSON.stringify({ autostart: next.autostart, tray: next.tray })}\n`);
  return next;
}

/** 给快照用：界面要能显示当前值，非桌面模式返回 null（那两行开关就不显示）。 */
export function desktopPrefsSnapshot(): DesktopPrefs | null {
  return desktopManaged() ? readDesktopPrefs() : null;
}
