import { useCallback, useEffect, useRef, useState } from "react";
import { File, ImageOff, MessageCircle, Shapes, Star, Trash2, User, X } from "lucide-react";
import { artifactApi, contactsApi, contentApi, type ContentAsset, type ContentFilter } from "../../api";
import ListPager from "../../components/ListPager";
import Modal from "../../components/Modal";
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
  { key: "all", label: "全部", hint: "作品与聊天图片" },
  { key: "artifacts", label: "作品", hint: "由联系人生成的内容" },
  { key: "chat", label: "聊天图片", hint: "来自对话消息" },
  { key: "starred", label: "收藏", hint: "你标记过的作品" },
  { key: "reference", label: "素材", hint: "参与过参考生成的内容" },
];

function sourceLabel(a: ContentAsset): string {
  if (a.source === "artifact") return a.withReference ? "参考作品" : "作品";
  return a.role === "user" ? "你发出的聊天图片" : "联系人发来的聊天图片";
}

/**
 * 内容库：聚合独立作品台账与聊天媒体附件。
 *
 * 作品的生命周期独立于消息；聊天图片则属于消息本身。两类东西在同一页可检索、可预览，
 * 但删除路径不同——这里只允许删作品，聊天图片要回原消息处理。将来接入语音和文件时
 * 仍复用这条聚合视图，不需要另起一套页面。
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
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<ContentAsset | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useDismiss(!!zoom, () => setZoom(null));

  const [counts, setCounts] = useState<Record<string, number>>({});
  const fetchPage = useCallback((limit: number, offset: number) =>
    contentApi.listContent(filter, limit, offset, contactId).then((d) => {
      setCounts(d.counts);
      return { rows: d.assets, total: d.total };
    }), [contactId, filter]);
  const list = usePagedList<ContentAsset>(fetchPage, { key: contactId + ":" + filter, enabled: active });
  const rows = list.page?.rows ?? [];
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wake = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (wake) list.reset();
  }, [active, list.reset]);

  const setFaceReference = async (a: ContentAsset): Promise<void> => {
    setErr("");
    setBusyId(a.id);
    try {
      if (a.artifactId) {
        await artifactApi.manageArtifact("setFaceRef", a.artifactId, contactId);
      } else {
        await contactsApi.updateContact(contactId, { faceRef: a.url });
      }
      setNotice("已设为长相参考；后续自拍会优先按这张脸生成。");
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
  const emptyCopy = filter === "starred"
    ? "还没有收藏。点作品卡片上的星标，常看的会留在这里。"
    : filter === "reference"
      ? "还没有参与参考生成的作品。带长相或素材参考生成后，会归到这里。"
      : filter === "chat"
        ? "还没有聊天图片。对话里发送或收到的图片会自动出现在这里。"
        : filter === "artifacts"
          ? `还没有作品。配置图像生成后，让${who}画一张试试。`
          : "内容库还是空的。作品与聊天图片会在这里按时间汇总。";

  return (
    <div className="card card-pad content-library" {...panel}>
      <div className="pf-set-title"><span>内容库</span></div>
      <div className="pf-set-sub">
        作品、聊天图片与生成素材集中在这里。作品独立保存；聊天图片来自消息，仍以原对话为准。
      </div>

      <div className="content-filters" role="group" aria-label="内容类型">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={"chip" + (filter === f.key ? " on" : "")}
            title={f.hint} onClick={() => setFilter(f.key)}>
            {f.label}<span className="content-count">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="content-filter-hint">{activeFilter?.hint}</div>

      {notice && <div className="pf-comp-note ok">{notice}</div>}
      {err && <div className="pf-error">{err}</div>}
      {list.error && <div className="pf-error">{list.error}</div>}

      {list.page !== null && rows.length === 0 && (
        <div className="art-empty">
          {filter === "chat" ? <MessageCircle size={26} strokeWidth={1.5} /> : <ImageOff size={26} strokeWidth={1.5} />}
          <p>{emptyCopy}</p>
        </div>
      )}

      <div className="content-grid">
        {rows.map((a) => {
          const isImage = a.kind === "image";
          const title = a.source === "artifact" ? (a.prompt || "未命名作品") : a.fileName;
          return (
            <figure key={a.id} className="content-cell">
              <button type="button" className="content-shot" disabled={!isImage}
                onClick={() => isImage && setZoom(a.url)} aria-label={isImage ? "放大查看" : a.fileName}>
                {isImage
                  ? <img src={a.url} alt={title} loading="lazy" />
                  : <span className="content-file"><File size={30} strokeWidth={1.5} /><b>{a.fileName}</b></span>}
                <span className={"content-source " + a.source}>{sourceLabel(a)}</span>
                {a.withReference && <span className="content-badge ref"><Shapes size={11} />带参考</span>}
                {faceRef !== "" && faceRef === a.url && <span className="content-badge face">长相参考</span>}
              </button>
              <figcaption>
                <span className="content-title" title={title}>{title}</span>
                <span className="content-meta">{whenOf(a.createdAt)}{a.shape ? " · " + a.shape : ""}</span>
                <span className="content-acts">
                  {a.artifactId && (
                    <button type="button" className="art-act" aria-label={a.starred ? "取消收藏" : "收藏"}
                      title={a.starred ? "取消收藏" : "收藏"} aria-pressed={a.starred} disabled={busyId === a.id}
                      onClick={() => { setNotice(""); void runArtifact(a, "star"); }}>
                      <Star size={14} strokeWidth={1.9} fill={a.starred ? "currentColor" : "none"} />
                    </button>
                  )}
                  {isImage && faceRef !== a.url && (
                    <button type="button" className="art-act" aria-label="设为长相参考" title="设为长相参考" disabled={busyId === a.id}
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
            这张作品和磁盘文件会一起删除，<b>不可恢复</b>。聊天记录里的引用也会随之失效。
          </p>
          <img className="art-confirm-shot" src={confirmDel.url} alt="将要删除的作品" />
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
