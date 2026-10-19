import { getJson, postJson } from "./client";
import { invalidateCaps } from "../lib/capsStore";
import { invalidateStatus } from "../lib/statusStore";
import type { SettingsSnapshot } from "../types";

export function fetchSettings(): Promise<SettingsSnapshot> {
  return getJson("/api/settings");
}

/**
 * 改动设置的写接口：都返回整套快照，也都让状态页总览与能力就绪两份缓存变陈旧。
 * 失效收口在这一趟里——以后新增写接口只要走它，就不会漏掉作废。
 */
function writeSnapshot(url: string, body: Record<string, unknown>): Promise<SettingsSnapshot> {
  return postJson<SettingsSnapshot>(url, body).then((snapshot) => {
    invalidateCaps();
    invalidateStatus();
    return snapshot;
  });
}

export function saveSettings(patch: Record<string, unknown>): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings", patch);
}

/** 更改数据存储位置：把现有数据迁到 path、更新配置；返回新快照。迁完要重启才生效。 */
export function changeDataDir(path: string): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/data-dir", { path });
}

/**
 * 桌面外壳的两项偏好。只传要改的那一项（另一项保持原值）。
 * 与改数据目录不同，这里**不需要重启**：后端会把新值通过 sidecar 的 stdout 送给外壳当场应用。
 */
export function setDesktopPrefs(
  patch: { autostart?: boolean; tray?: boolean },
): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/desktop", patch);
}

export function resetSettings(): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings", { reset: true });
}

/** 恢复出厂设置：清掉全部对话/记忆/画作/设置/绑定并重新种子内置联系人。要显式 confirm。 */
export function factoryReset(): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/factory-reset", { confirm: "FACTORY" });
}

/** 连通测试打的是真实接口、比普通请求慢；给足超时，免得慢模型被 10s 误杀（圈一直转）。 */
const TEST_TIMEOUT_MS = 40_000;

export function pingModel(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return postJson("/api/model/ping", body, TEST_TIMEOUT_MS);
}

/**
 * 能力端点档：op = save / activate / delete，`capability` 指明哪张卡。
 * 与主模型那三条同构；activate 传空串 id = 取消启用，回到跟随主模型。
 */
export function capabilityProfile(payload: Record<string, unknown>): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/capabilities", payload);
}

/** 能力连接测试：可带「还没保存的表单值」，后端以已存配置为底覆盖。 */
export function testCapability(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return postJson("/api/settings/capabilities/test", payload, TEST_TIMEOUT_MS);
}

/** 全局预览只回 prompt；带 contactId 的预览另回回放历史与召回口径说明。 */
export function previewPrompt(payload: Record<string, unknown>): Promise<{
  prompt: string;
  history?: Array<{ role: string; text: string }>;
  memoryNote?: string;
}> {
  return postJson("/api/settings/preview", payload);
}

export function saveProfile(payload: Record<string, unknown>): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/profiles", payload);
}

export function activateProfile(id: string): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/profiles/activate", { id });
}

/** 快速测一个档：发最小指令验证可用性 + 延迟。 */
export function testProfile(id: string): Promise<{ pass: boolean; elapsedMs?: number; text?: string; error?: string }> {
  return postJson("/api/settings/profiles/test", { id }, TEST_TIMEOUT_MS);
}

export function deleteProfile(id: string): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/profiles/delete", { id });
}

/** 供应商这一层（按接口地址从档派生）：op=rename 改名，op=sync 把地址/密钥同步给全家的模型。 */
export function provider(payload: Record<string, unknown>): Promise<SettingsSnapshot> {
  return writeSnapshot("/api/settings/providers", payload);
}
