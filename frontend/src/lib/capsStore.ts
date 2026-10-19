import { getJson } from "../api/client";
import type { CapabilityName } from "../types";

/**
 * 能力就绪状态（/api/capabilities）的模块级缓存。
 *
 * 这份数据全局只有一份、只在设置里改模型或能力时才会变，但读它的地方有三处：
 * 聊天页每挂一个会话实例拉一次（主会话 + 助手弹窗 = 两份，切联系人还会重挂再拉），
 * 状态页总览又拉一份。收口到这里：有缓存先立刻用，同时后台核对一次。
 */

export type Caps = Record<CapabilityName, boolean>;

/** 还不知道就绪状态时的保守值：宁可少显示入口，也不要给出点了就报错的按钮。 */
export const CAPS_OFF: Caps = {
  memoryExtract: false, imageVision: false, imageGeneration: false, speechToText: false, textToSpeech: false,
};

let cache: Caps | null = null;
let flying: Promise<Caps> | null = null;

/** null = 一次都还没拉到过（界面据此显示「读取中…」，不能拿 CAPS_OFF 冒充，那会满屏假红）。 */
export function cachedCaps(): Caps | null {
  return cache;
}

export function loadCaps(): Promise<Caps> {
  // 同一时刻只允许一个在飞的请求：三个消费者同时挂载也只发一次。
  if (flying) return flying;
  flying = getJson<{ ready: Caps }>("/api/capabilities")
    .then((r) => { cache = r.ready; return r.ready; })
    .finally(() => { flying = null; });
  return flying;
}

/** 设置里改了模型或能力之后调用：下一次读到的是新值，而不是刚被自己作废的旧值。 */
export function invalidateCaps(): void {
  cache = null;
}
