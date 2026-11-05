// 端口握手：把「服务实际监听在哪个端口」写到一个文件里。
//
// 为什么需要它：桌面外壳（Tauri）要先启动 Node 子进程、再打开 WebView 指向它。
// 端口如果写死 8787，用户机器上被别的程序占了就直接白屏——而且用户完全看不出原因。
// 这里的做法是：端口让系统分配（PORT=0），启动后把真实端口写进 RUNTIME_FILE，
// 外壳只认这个文件。这就是「一份事实、一个真源」在进程间通信上的用法。
//
// 文件内容是一行 JSON：
//   {"pid":1234,"port":51234,"url":"http://127.0.0.1:51234","startedAt":"..."}

import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

export type RuntimeHandshake = {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
};

/** 把握手信息落盘，供外壳读取。未配置 RUNTIME_FILE 时是空操作（命令行模式）。 */
export function writeRuntimeHandshake(port: number): void {
  if (config.runtimeFile === "") return;
  const payload: RuntimeHandshake = {
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(config.runtimeFile), { recursive: true });
  writeFileSync(config.runtimeFile, JSON.stringify(payload), "utf8");
}

/**
 * 退出时删掉握手文件。
 * 留着它会让外壳以为「服务还在」，下次启动读到过期端口 → 连不上 → 白屏。
 */
export function clearRuntimeHandshake(): void {
  if (config.runtimeFile === "") return;
  try {
    rmSync(config.runtimeFile, { force: true });
  } catch {
    // 文件可能已被外壳清理过，忽略。
  }
}
