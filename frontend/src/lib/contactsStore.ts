import { fetchContacts } from "../api/contacts";
import { getNotifyPref } from "./notify";
import type { ContactItem } from "../types";

/**
 * 联系人列表的模块级缓存：全站唯一一条 10s 轮询链。
 * 此前 App 与 Sidebar 各轮各的（review P2-18 双份轮询），这里收口。
 * 后端不可达时广播 xiaomo:net-down，恢复时广播 xiaomo:net-ok——断网提示有唯一来源。
 */

const listeners = new Set<(contacts: ContactItem[]) => void>();
let cache: ContactItem[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let wasDown = false;
let loaded = false;

export function getCachedContacts(): ContactItem[] {
  return cache;
}

/** 是否已经成功拉到过至少一次。0 联系人 ≠ 还在读，两者必须能分开。 */
export function isContactsLoaded(): boolean {
  return loaded;
}

export function subscribeContacts(fn: (contacts: ContactItem[]) => void): () => void {
  listeners.add(fn);
  fn(cache);
  if (timer === null) {
    timer = setInterval(() => {
      // 默认后台不轮询省电；开启系统通知后必须继续看新消息，否则通知永远没有触发源。
      if (!document.hidden || getNotifyPref()) refreshContacts();
    }, 10_000);
  }
  return (): void => {
    listeners.delete(fn);
  };
}

export function refreshContacts(): void {
  // 只有「已经拉到过」才允许因为标签页不可见而跳过：后台重复轮询可以省，
  // 首屏不能省——否则在后台标签页里打开应用，列表会一直停在「读取中…」。
  if (refreshing || (loaded && document.hidden && !getNotifyPref())) return;
  refreshing = true;
  void fetchContacts()
    .then((d: { contacts: ContactItem[] }) => {
      cache = d.contacts;
      loaded = true;
      for (const fn of listeners) fn(cache);
      if (wasDown) {
        wasDown = false;
        window.dispatchEvent(new Event("xiaomo:net-ok"));
      }
    })
    .catch(() => {
      if (!wasDown) {
        wasDown = true;
        window.dispatchEvent(new Event("xiaomo:net-down"));
      }
    })
    .finally(() => { refreshing = false; });
}

// 聊天读掉消息、联系人增删后走同一个广播刷新
window.addEventListener("xiaomo:contacts-changed", refreshContacts);
