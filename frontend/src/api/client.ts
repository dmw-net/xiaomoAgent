/** 与后端约定的通用响应包装：ok=false 时 error 必有；code 可选（机器可读，界面按它分支引导）。 */

export class ApiError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** 普通请求超时上限：后端挂起时不该永远卡着（AbortController 兜底）。 */
const FETCH_TIMEOUT_MS = 10_000;

async function requestJson<T>(method: string, url: string, body?: unknown, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data: { ok?: boolean; error?: string; code?: string };
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new ApiError(error instanceof Error ? error.message : String(error), "NETWORK");
  } finally {
    clearTimeout(timer);
  }
  if (!data.ok) throw new ApiError(data.error || "请求失败", data.code);
  return data as T;
}

export async function getJson<T = Record<string, unknown>>(url: string): Promise<T> {
  return requestJson<T>("GET", url);
}

export async function postJson<T = Record<string, unknown>>(url: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return requestJson<T>("POST", url, body, timeoutMs);
}

export async function putJson<T = Record<string, unknown>>(url: string, body?: unknown): Promise<T> {
  return requestJson<T>("PUT", url, body);
}

export async function patchJson<T = Record<string, unknown>>(url: string, body?: unknown): Promise<T> {
  return requestJson<T>("PATCH", url, body);
}

export async function deleteJson<T = Record<string, unknown>>(url: string): Promise<T> {
  return requestJson<T>("DELETE", url);
}

// ── 多联系人的当前 id（localStorage），API 调用统一携带 ──

export function contactId(): string {
  return localStorage.getItem("xiaomo.contact") || "default";
}

export function setContactId(id: string): void {
  localStorage.setItem("xiaomo.contact", id);
}

/** 给 API 路径带上联系人参数；不传就用全局当前联系人。 */
export function cq(base: string, asContactId?: string): string {
  return base + (base.includes("?") ? "&" : "?") + "contactId=" + encodeURIComponent(asContactId || contactId());
}
