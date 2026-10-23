import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { linkPreviewApi, type LinkPreview } from "../../api";
import { linkDomain } from "../../lib/md";
import { openExternal } from "../../lib/open-external";

type State =
  | { phase: "idle" | "loading" }
  | { phase: "ready"; data: LinkPreview }
  | { phase: "none" };

/** 会话级缓存：同一条链接在滚动、切联系人、重渲染时只抓一次。 */
const cache = new Map<string, LinkPreview | null>();
const pending = new Map<string, Promise<LinkPreview | null>>();

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
    if (!cache.has(url)) return { phase: "idle" };
    const hit = cache.get(url);
    return hit ? { phase: "ready", data: hit } : { phase: "none" };
  });
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    let started = false;

    const load = (): void => {
      if (started) return;
      started = true;
      if (cache.has(url)) {
        const hit = cache.get(url);
        setState(hit ? { phase: "ready", data: hit } : { phase: "none" });
        return;
      }
      setState({ phase: "loading" });
      let request = pending.get(url);
      if (!request) {
        request = linkPreviewApi.preview(url)
          .then((data) => {
            cache.set(url, data);
            return data;
          })
          .catch(() => {
            cache.set(url, null);
            return null;
          })
          .finally(() => { pending.delete(url); });
        pending.set(url, request);
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
      let copied = false;
      try { await navigator.clipboard.writeText(url); copied = true; } catch { copied = false; }
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
