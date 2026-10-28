import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, File, Film, Image as ImageIcon, ImageOff, MessageCircle, Shapes, Star, Trash2, User, X } from "lucide-react";
import { artifactApi, contactsApi, contentApi, type ContentAsset, type ContentFilter, type ContentMediaFilter } from "../../api";
import ListPager from "../../components/ListPager";
import Modal from "../../components/Modal";
import VoiceMessageBubble from "../../components/VoiceMessageBubble";
import { usePagedList } from "../../hooks/usePagedList";
import { useDismiss } from "../../hooks/useDismiss";
import type { PanelAria } from "../../components/Tabs";

/** 内容时间：今天只显示时分，其余给到日期——内容库按时间翻，信息要够扫。 */
function whenOf(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const FILTERS: Array<{ key: ContentFilter; label: string; hint: string }> = [
  { key: "all", label: "全部", hint: "作品与聊天中的图片、视频、语音" },
  { key: "artifacts", label: "作品", hint: "由联系人生成并独立保存的内容" },
  { key: "chat", label: "聊天媒体", hint: "来自对话消息，删除仍以原消息为准" },
  { key: "starred", label: "收藏", hint: "你标记过的作品" },
  { key: "reference", label: "素材", hint: "参与过参考生成的内容" },
];

const MEDIA_FILTERS: Array<{ key: ContentMediaFilter; label: string; hint: string }> = [
  { key: "all", label: "全部类型", hint: "不限制媒体类型" },
  { key: "image", label: "图片", hint: "聊天图片与生成作品" },
  { key: "video", label: "视频", hint: "来自聊天消息的视频" },
  { key: "audio", label: "语音", hint: "可直接播放的语音消息" },
  { key: "file", label: "文件", hint: "无法内联预览的其他附件" },
];

const KIND_LABELS: Record<ContentAsset["kind"], string> = {
  image: "图片",
  video: "视频",
  audio: "语音",
  file: "文件",
};

function sourceLabel(a: ContentAsset): string {
  if (a.source === "artifact") return a.withReference ? "参考作品" : "作品";
  return (a.role === "user" ? "你发出的" : "联系人发来的") + KIND_LABELS[a.kind];
}

function durationLabel(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(total / 60) > 0 ? Math.floor(total / 60) + "分" : ""}${total % 60}秒`;
}

/**
 * 内容库：聚合独立作品台账与聊天媒体附件。
 *
 * 作品的生命周期独立于消息；聊天媒体属于消息本身。两类东西在同一页可检索、可预览，
 * 但删除路径不同——这里只允许删作品，聊天媒体要回原消息或「媒体与存储」处理。
 */
export default function ContentLibraryPanel({ active = true, contactId, who = "联系人", faceRef, onFaceRefChanged, panel }: {
  active?: boolean;
  panel: PanelAria;
  contactId: string;
  who?: string;
  faceRef: string;
  onFaceRefChanged: (url: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState<ContentFilter>("all");
  const [mediaFilter, setMediaFilter] = useState<ContentMediaFilter>("all");
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<ContentAsset | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useDismiss(!!zoom, () => setZoom(null));

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [kindCounts, setKindCounts] = useState<Record<ContentMediaFilter, number>>({
    all: 0, image: 0, video: 0, audio: 0, file: 0,
  });
  const fetchPage = useCallback((limit: number, offset: number) =>
    contentApi.listContent(filter, mediaFilter, limit, offset, contactId).then((d) => {
      setCounts(d.counts);
      setKindCounts(d.kindCounts);
      return { rows: d.assets, total: d.total };
    }), [contactId, filter, mediaFilter]);
  const list = usePagedList<ContentAsset>(fetchPage, { key: contactId + ":" + filter + ":" + mediaFilter, enabled: active });
  const rows = list.page?.rows ?? [];
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wake = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (wake) list.reset();
  }, [active, list.reset]);

  const chooseFilter = (next: ContentFilter): void => {
    setFilter(next);
    setMediaFilter("all");
    setNotice("");
  };

  const chooseMedia = (next: ContentMediaFilter): void => {
    setMediaFilter(next);
    setNotice("");
  };

  const setFaceReference = async (a: ContentAsset): Promise<void> => {
    setErr("");
    setBusyId(a.id);
    try {
      if (a.artifactId) {
        await artifactApi.manageArtifact("setFaceRef", a.artifactId, contactId);
      } else {
        await contactsApi.updateContact(contactId, { faceRef: a.url });
      }
      setNotice("已设为自拍参考；后续自拍会优先按这张脸生成。");
      onFaceRefChanged(a.url);
      window.dispatchEvent(new Event("xiaomo:contacts-changed"));
      list.reset();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const runArtifact = async (a: ContentAsset, op: "star" | "delete"): Promise<void> => {
    if (!a.artifactId) return;
    setErr("");
    setBusyId(a.id);
    try {
      await artifactApi.manageArtifact(op, a.artifactId, contactId);
      list.reset();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const activeMedia = MEDIA_FILTERS.find((f) => f.key === mediaFilter) ?? MEDIA_FILTERS[0]!;
  let emptyCopy: string;
  if (mediaFilter !== "all") {
    emptyCopy = `当前筛选下还没有${activeMedia.label}。`;
  } else if (filter === "starred") {
    emptyCopy = "还没有收藏。点作品卡片上的星标，常看的会留在这里。";
  } else if (filter === "reference") {
    emptyCopy = "还没有参与参考生成的作品。带长相或素材参考生成后，会归到这里。";
  } else if (filter === "chat") {
    emptyCopy = "还没有聊天媒体。对话里发送或收到的图片、视频与语音会自动出现在这里。";
  } else if (filter === "artifacts") {
    emptyCopy = `还没有作品。配置图像生成后，让${who}画一张试试。`;
  } else {
    emptyCopy = "内容库还是空的。作品与聊天媒体会在这里按时间汇总。";
  }
  const EmptyIcon = mediaFilter === "audio" ? AudioLines
    : mediaFilter === "video" ? Film
      : filter === "chat" ? MessageCircle : ImageOff;

  return (
    <div className="card card-pad content-library" {...panel}>
      <div className="pf-set-title"><span>内容库</span></div>
      <div className="pf-set-sub">
        作品与聊天中的图片、视频、语音集中在这里。作品独立保存；聊天媒体来自消息，仍以原对话为准。
      </div>

      <div className="content-filters" role="group" aria-label="内容来源">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={"chip" + (filter === f.key ? " on" : "")}
            title={f.hint} onClick={() => chooseFilter(f.key)}>
            {f.label}<span className="content-count">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="content-filter-hint">{activeFilter?.hint}</div>

      <div className="content-filters content-kind-filters" role="group" aria-label="媒体类型">
        {MEDIA_FILTERS.map((f) => {
          const count = kindCounts[f.key] ?? 0;
          const disabled = f.key !== "all" && count === 0;
          return (
            <button key={f.key} type="button" className={"chip" + (mediaFilter === f.key ? " on" : "")}
              title={f.hint} disabled={disabled} onClick={() => chooseMedia(f.key)}>
              {f.key === "image" && <ImageIcon size={13} />}
              {f.key === "video" && <Film size={13} />}
              {f.key === "audio" && <AudioLines size={13} />}
              {f.key === "file" && <File size={13} />}
              {f.label}<span className="content-count">{count}</span>
            </button>
          );
        })}
      </div>

      {notice && <div className="pf-comp-note ok">{notice}</div>}
      {err && <div className="pf-error">{err}</div>}
      {list.error && <div className="pf-error">{list.error}</div>}

      {list.page !== null && rows.length === 0 && (
        <div className="art-empty">
          <EmptyIcon size={26} strokeWidth={1.5} />
          <p>{emptyCopy}</p>
        </div>
      )}

      <div className="content-grid">
        {rows.map((a) => {
          const isImage = a.kind === "image";
          const isVideo = a.kind === "video";
          const isAudio = a.kind === "audio";
          const title = a.source === "artifact" ? (a.prompt || "未命名作品") : (a.title || a.fileName);
          const duration = a.kind === "audio" ? durationLabel(a.durationMs) : "";
          return (
            <figure key={a.id} className={"content-cell kind-" + a.kind}>
              <div className={"content-shot kind-" + a.kind}>
                {isImage && (
                  <button type="button" className="content-open" onClick={() => setZoom(a.url)} aria-label={"放大查看" + title}>
                    <img src={a.url} alt={title} loading="lazy" />
                  </button>
                )}
                {isVideo && (
                  <video className="content-video" src={a.url} controls playsInline preload="metadata" aria-label={title} />
                )}
                {isAudio && (
                  <div className="content-audio">
                    <span className="content-audio-icon"><AudioLines size={22} strokeWidth={1.7} /></span>
                    <VoiceMessageBubble compact url={a.url} durationMs={a.durationMs}
                      waveform={a.waveform} transcript={a.transcript} />
                  </div>
                )}
                {!isImage && !isVideo && !isAudio && (
                  <div className="content-file"><File size={30} strokeWidth={1.5} /><b>{a.fileName}</b></div>
                )}
                <span className={"content-source " + a.source}>{sourceLabel(a)}</span>
                {a.withReference && <span className="content-badge ref"><Shapes size={11} />带参考</span>}
                {faceRef !== "" && faceRef === a.url && <span className="content-badge face">自拍参考</span>}
              </div>
              <figcaption>
                <span className="content-title" title={title}>{title}</span>
                <span className="content-meta">
                  {whenOf(a.createdAt)}{duration ? " · " + duration : ""}{a.shape ? " · " + a.shape : ""}
                </span>
                <span className="content-acts">
                  {a.artifactId && (
                    <button type="button" className="art-act" aria-label={a.starred ? "取消收藏" : "收藏"}
                      title={a.starred ? "取消收藏" : "收藏"} aria-pressed={a.starred} disabled={busyId === a.id}
                      onClick={() => { setNotice(""); void runArtifact(a, "star"); }}>
                      <Star size={14} strokeWidth={1.9} fill={a.starred ? "currentColor" : "none"} />
                    </button>
                  )}
                  {isImage && faceRef !== a.url && (
                    <button type="button" className="art-act" aria-label="设为自拍参考" title="设为自拍参考" disabled={busyId === a.id}
                      onClick={() => { setNotice(""); void setFaceReference(a); }}>
                      <User size={14} strokeWidth={1.9} />
                    </button>
                  )}
                  {a.artifactId && (
                    <button type="button" className="art-act danger" aria-label="删除作品" title="删除作品（不可恢复）" disabled={busyId === a.id}
                      onClick={() => setConfirmDel(a)}>
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  )}
                </span>
              </figcaption>
            </figure>
          );
        })}
      </div>

      <ListPager page={list.page} busy={list.busy} refreshing={list.refreshing} onMore={list.more} />

      {zoom && (
        <div className="img-zoom" onClick={() => setZoom(null)} role="dialog" aria-modal="true"
          aria-label="内容大图" data-keep-menu>
          <img src={zoom} alt="内容大图" onClick={(e) => e.stopPropagation()} />
          <button type="button" aria-label="关闭" onClick={() => setZoom(null)}><X size={18} /></button>
        </div>
      )}

      {confirmDel && (
        <Modal onClose={() => setConfirmDel(null)} label="删除作品">
          <p className="ml-lead">
            这个作品和磁盘文件会一起删除，<b>不可恢复</b>。聊天记录里的引用也会随之失效。
          </p>
          {confirmDel.kind === "image"
            ? <img className="art-confirm-shot" src={confirmDel.url} alt="将要删除的作品" />
            : confirmDel.kind === "video"
              ? <video className="art-confirm-shot" src={confirmDel.url} controls playsInline preload="metadata" />
              : confirmDel.kind === "audio"
                ? <div className="art-confirm-audio"><VoiceMessageBubble url={confirmDel.url} durationMs={confirmDel.durationMs}
                    waveform={confirmDel.waveform} transcript={confirmDel.transcript} /></div>
                : <div className="art-confirm-file"><File size={28} /><span>{confirmDel.fileName}</span></div>}
          <div className="row2">
            <button type="button" className="btn sm" onClick={() => setConfirmDel(null)}>取消</button>
            <button type="button" className="primary danger sm" disabled={busyId === confirmDel.id}
              onClick={() => { const a = confirmDel; setConfirmDel(null); void runArtifact(a, "delete"); }}>
              删除作品
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}