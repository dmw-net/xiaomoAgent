import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { linkPreviewApi, type LinkPreview } from "../../api";
import { copyText } from "../../lib/clipboard";
import { linkDomain } from "../../lib/md";
import { openExternal } from "../../lib/open-external";
import { useResizeSignal } from "../../hooks/useResizeSignal";

type State =
  | { phase: "idle" | "loading" }
  | { phase: "ready"; data: LinkPreview }
  | { phase: "none" };

/**
 * 会话级缓存：同一条链接在滚动、切联系人、重渲染时只抓一次。
 * 上限 + TTL 都必须有：图标是内联 data URL，几百条链接能攒到几十 MB；
 * 而失败项如果永久缓存，一次超时/断网就会让这条链接到刷新前都不再出卡。
 */
const CACHE_MAX = 80;
const CACHE_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 2 * 60 * 1000;
type CacheEntry = { value: LinkPreview | null; at: number };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<LinkPreview | null>>();

/** #hash 不影响页面内容；后端也按去掉 hash 的地址缓存，两边口径保持一致。 */
function previewKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function cacheGet(url: string): { found: boolean; value: LinkPreview | null } {
  const key = previewKey(url);
  const entry = cache.get(key);
  if (entry === undefined) return { found: false, value: null };
  const ttl = entry.value === null ? FAIL_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    cache.delete(key);
    return { found: false, value: null };
  }
  // 命中就挪到末尾：超上限时先淘汰真正最久没用的。
  cache.delete(key);
  cache.set(key, entry);
  return { found: true, value: entry.value };
}

function cacheSet(url: string, value: LinkPreview | null): void {
  const key = previewKey(url);
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function fallbackLetter(domain: string): string {
  return domain.replace(/^https?:\/\//i, "").slice(0, 1).toUpperCase() || "链";
}

/**
 * 轻量链接卡：进入视口附近才发起请求，避免历史消息里的 500 条链接一起抓。
 * 卡片失败时整块消失，正文里的普通链接仍然保留，不让预览拖累聊天。
 */
export default function LinkPreviewCard({ url }: { url: string }): JSX.Element | null {
  const holderRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>(() => {
    const hit = cacheGet(url);
    if (!hit.found) return { phase: "idle" };
    return hit.value ? { phase: "ready", data: hit.value } : { phase: "none" };
  });
  const [note, setNote] = useState("");
  useResizeSignal(holderRef);

  useEffect(() => {
    let alive = true;
    let started = false;

    const load = (): void => {
      if (started) return;
      started = true;
      const cached = cacheGet(url);
      if (cached.found) {
        setState(cached.value ? { phase: "ready", data: cached.value } : { phase: "none" });
        return;
      }
      setState({ phase: "loading" });
      const key = previewKey(url);
      let request = pending.get(key);
      if (!request) {
        request = linkPreviewApi.preview(url)
          .then((data) => {
            cacheSet(url, data);
            return data;
          })
          .catch(() => {
            cacheSet(url, null);
            return null;
          })
          .finally(() => { pending.delete(key); });
        pending.set(key, request);
      }
      void request.then((data) => {
        if (!alive) return;
        setState(data ? { phase: "ready", data } : { phase: "none" });
      });
    };

    const el = holderRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      load();
      return () => { alive = false; };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        io.disconnect();
        load();
      }
    }, { rootMargin: "320px 0px" });
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [url]);

  if (state.phase === "none") return null;
  const data = state.phase === "ready" ? state.data : null;
  const domain = data?.domain || linkDomain(url);
  const title = data?.title || (state.phase === "loading" ? "正在读取链接…" : domain);

  const open = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      const result = await openExternal(url);
      if (result.ok) return;
      // http 局域网下没有 navigator.clipboard，走带 execCommand 兜底的 copyText。
      const copied = (await copyText(url)) === "ok";
      setNote(`${result.error} · ${copied ? "链接已复制到剪贴板" : "请手动打开链接"}`);
    })();
  };

  return (
    <div className="link-preview" ref={holderRef}>
      <a className={"link-card" + (state.phase === "loading" ? " loading" : "")}
        href={url} target="_blank" rel="noreferrer" title={url} aria-busy={state.phase === "loading"}
        onClick={open} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
        <span className="link-card-icon" aria-hidden="true">
          <span>{fallbackLetter(domain)}</span>
          {data?.icon ? <img src={data.icon} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : null}
        </span>
        <span className="link-card-main">
          <span className="link-card-title">{title}</span>
          {data?.description ? <span className="link-card-desc">{data.description}</span> : null}
          <span className="link-card-domain">{domain}</span>
        </span>
        <ExternalLink className="link-card-ext" size={14} strokeWidth={1.8} aria-hidden="true" />
      </a>
      {note !== "" && <span className="link-card-note">{note}</span>}
    </div>
  );
}
