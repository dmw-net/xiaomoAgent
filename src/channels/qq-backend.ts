// QQ 后端选择状态：全局默认 + 按联系人覆盖，全部落在 SQLite kv。
//
// 为什么单独一层：表情渲染（emote/qq-emote.ts）需要知道当前走的是官方 Bot 还是 OneBot，
// 后端选型与"通道本身怎么跑"是两件事。把这份共享状态下沉到零业务依赖的模块，
// qq / qq-onebot / qq-emote 各方都只向下依赖，没有任何一方反向 import 通道层。
//
// 这里不认识任何网关、协议端或表情字段；只回答"某个联系人该用哪个后端"。

import { kvGet, kvSet } from "../core/db.ts";
import { config } from "../core/config.ts";

export type QQBackend = "official" | "onebot";

const QQ_BACKEND_KV = "qq.backend";
const QQ_CONTACT_BACKEND_KV = "qq.backend.contacts.v1";

const savedBackend = kvGet(QQ_BACKEND_KV);
let effectiveBackend: QQBackend =
  savedBackend === "official" || savedBackend === "onebot" ? savedBackend : config.qq.backend;

/** 没有联系人覆盖时使用的默认渠道。 */
export function qqBackend(): QQBackend { return effectiveBackend; }

/** 切换进程内的默认渠道（由 applyQQBackend 调用；落库走 saveQQBackend）。 */
export function setEffectiveBackend(backend: QQBackend): void {
  effectiveBackend = backend;
}

/** 全局默认值是否由界面保存过；保留给兼容接口。 */
export function qqBackendSaved(): QQBackend | null {
  const value = kvGet(QQ_BACKEND_KV);
  return value === "official" || value === "onebot" ? value : null;
}

/** 只改全局默认值；联系人级覆盖走 saveQQBackendForContact（新界面按联系人保存）。 */
export function saveQQBackend(backend: QQBackend): void {
  kvSet(QQ_BACKEND_KV, backend);
}

let contactBackends: Record<string, QQBackend> | null = null;

function hydrateContactBackends(): void {
  if (contactBackends !== null) return;
  contactBackends = {};
  const raw = kvGet(QQ_CONTACT_BACKEND_KV);
  if (raw === null || raw === "") return;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [contactId, value] of Object.entries(parsed)) {
      if (contactId !== "" && (value === "official" || value === "onebot")) contactBackends[contactId] = value;
    }
  } catch { /* 坏档按默认渠道 */ }
}

function persistContactBackends(): void {
  if (contactBackends !== null) kvSet(QQ_CONTACT_BACKEND_KV, JSON.stringify(contactBackends));
}

/** 这位联系人实际使用的渠道；没单独选过就继承全局默认。 */
export function qqBackendFor(contactId: string): QQBackend {
  hydrateContactBackends();
  return (contactId !== "" ? contactBackends?.[contactId] : undefined) ?? effectiveBackend;
}

/** 这位联系人是否单独保存过渠道；null=继承全局默认。 */
export function qqBackendSavedFor(contactId: string): QQBackend | null {
  hydrateContactBackends();
  return contactBackends?.[contactId] ?? null;
}

/** 为单个联系人切换渠道，不影响其他联系人；两套绑定配置都会保留。 */
export function saveQQBackendForContact(contactId: string, backend: QQBackend): void {
  if (contactId === "") throw new Error("contactId 不能为空");
  hydrateContactBackends();
  contactBackends![contactId] = backend;
  persistContactBackends();
}

/** 当前是否至少有一位联系人（或默认值）在使用某个后端；NapCat 自启动/重启用。 */
export function qqUsesBackend(backend: QQBackend): boolean {
  if (effectiveBackend === backend) return true;
  hydrateContactBackends();
  return Object.values(contactBackends ?? {}).some((value) => value === backend);
}
