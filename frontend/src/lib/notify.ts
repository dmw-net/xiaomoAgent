/** 系统通知与任务栏角标：浏览器用 Web Notification，Tauri 用原生通知插件。 */

const PREF_KEY = "xiaomo.notify";
let tauriActionBound = false;

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function notificationSupported(): boolean {
  return inTauri() || typeof Notification !== "undefined";
}

export function getNotifyPref(): boolean {
  try { return localStorage.getItem(PREF_KEY) === "1"; } catch { return false; }
}

export function setNotifyPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, "1");
    else localStorage.removeItem(PREF_KEY);
  } catch { /* 无痕模式禁写也不该炸 */ }
}

function openContact(contactId: string): void {
  window.dispatchEvent(new CustomEvent("xiaomo:open-contact", { detail: { contactId } }));
}

async function bindTauriAction(): Promise<void> {
  if (tauriActionBound) return;
  tauriActionBound = true;
  try {
    const { onAction } = await import("@tauri-apps/plugin-notification");
    await onAction((event) => {
      const extra = event.notification?.extra as Record<string, unknown> | undefined;
      const contactId = typeof extra?.contactId === "string" ? extra.contactId : "";
      if (contactId) openContact(contactId);
    });
  } catch {
    tauriActionBound = false;
  }
}

/** 申请权限；只有真正拿到权限才把偏好打开。 */
export async function enableNotifications(): Promise<{ ok: boolean; error?: string }> {
  if (!notificationSupported()) return { ok: false, error: "当前环境不支持系统通知" };
  try {
    if (inTauri()) {
      const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (!granted) return { ok: false, error: "系统通知权限没有开启" };
      await bindTauriAction();
    } else {
      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") return { ok: false, error: "浏览器通知权限没有开启" };
    }
    setNotifyPref(true);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function disableNotifications(): void {
  setNotifyPref(false);
}

export async function showMessageNotification(input: { title: string; body: string; contactId: string }): Promise<void> {
  if (!getNotifyPref() || !notificationSupported()) return;
  const body = input.body.trim().slice(0, 120);
  try {
    if (inTauri()) {
      await bindTauriAction();
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      await sendNotification({
        title: input.title,
        body,
        extra: { contactId: input.contactId },
        autoCancel: true,
        group: "xiaomo-messages",
      });
      return;
    }
    if (Notification.permission !== "granted") return;
    const n = new Notification(input.title, { body, tag: "xiaomo-" + input.contactId });
    n.onclick = () => {
      window.focus();
      openContact(input.contactId);
      n.close();
    };
  } catch { /* 通知失败不影响消息本身 */ }
}

/** 任务栏 / Dock / 标签页角标统一由未读数驱动。 */
export function syncAppBadge(count: number): void {
  document.title = count > 0 ? `(${count > 99 ? "99+" : count}) 小茉` : "小茉";
  const nav = navigator as Navigator & {
    setAppBadge?: (value?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch { /* 不支持角标的环境忽略 */ }
}
