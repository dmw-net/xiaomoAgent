import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, AudioLines, FileImage, Film, Image as ImageIcon, Loader2, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import Modal from "./Modal";
import VoiceMessageBubble from "./VoiceMessageBubble";
import { mediaApi } from "../api";
import type { MediaMaintenanceItem, MediaMaintenanceSnapshot, MediaTrashItem, MediaTypeKey } from "../types";

type Tab = "all" | "orphans" | "trash";
type TypeFilter = "all" | MediaTypeKey;
type ConfirmState = { op: "trash" | "purge" | "delete-message"; names: string[] } | null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function itemLabel(item: MediaMaintenanceItem): string {
  if (item.mediaType === "audio") return "语音消息";
  if (item.mediaType === "video") return item.mediaKind === "wallpaper" ? "视频壁纸" : "聊天视频";
  if (item.mediaKind === "wallpaper") return "图片壁纸";
  return "聊天图片";
}

function voiceMessageIds(item: MediaMaintenanceItem): number[] {
  return [...new Set(item.sources.map((source) => source.messageId).filter((id): id is number => typeof id === "number" && id > 0))];
}

function typeIcon(type: MediaTypeKey): JSX.Element {
  if (type === "audio") return <AudioLines size={15} />;
  if (type === "video") return <Film size={15} />;
  if (type === "image") return <ImageIcon size={15} />;
  return <FileImage size={15} />;
}

/** 媒体与存储：按图片/视频/语音统一查看，清理与聊天语义始终一致。 */
export default function MediaMaintenanceDialog({ onBack, onClose, onChanged, initialTab = "all" }: {
  onBack: () => void;
  onClose: () => void;
  onChanged: () => void;
  initialTab?: Tab;
}): JSX.Element {
  const [data, setData] = useState<MediaMaintenanceSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<"load" | "trash" | "restore" | "purge" | "delete-message" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const load = useCallback((): void => {
    setBusy("load");
    setError("");
    mediaApi.inspect()
      .then((next) => {
        setData(next);
        setSelected(new Set());
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(""));
  }, []);

  useEffect(() => { load(); }, [load]);

  const baseItems: MediaMaintenanceItem[] = tab === "all"
    ? data?.all ?? []
    : tab === "orphans"
      ? data?.items ?? []
      : data?.trash ?? [];
  const items = typeFilter === "all" ? baseItems : baseItems.filter((item) => item.mediaType === typeFilter);
  const selectable = tab !== "all";
  const selectedNames = selectable
    ? items.filter((item) => selected.has(item.name)).map((item) => item.name)
    : [];
  const allSelected = selectable && items.length > 0 && selectedNames.length === items.length;

  const typeStats = useMemo(() => (["image", "video", "audio"] as const).map((type) => ({
    type,
    files: baseItems.filter((item) => item.mediaType === type).length,
    bytes: baseItems.filter((item) => item.mediaType === type).reduce((sum, item) => sum + item.size, 0),
  })), [baseItems]);

  const switchTab = (next: Tab): void => {
    setTab(next);
    setSelected(new Set());
    setError("");
    setNotice("");
  };

  const switchType = (next: TypeFilter): void => {
    setTypeFilter(next);
    setSelected(new Set());
  };

  const toggle = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(items.map((item) => item.name)));
  };

  const operate = (op: "trash" | "restore" | "purge" | "delete-message", names: string[]): void => {
    if (names.length === 0) {
      setError("请先选择文件");
      return;
    }
    setBusy(op);
    setError("");
    setNotice("");
    mediaApi.operate(op, names)
      .then((result) => {
        setData(result);
        setSelected(new Set());
        setConfirm(null);
        const tail = result.skipped > 0 ? `，${result.skipped} 项因状态变化或存在多重引用而跳过` : "";
        if (op === "trash") setNotice(`已将 ${result.changed} 个文件移到回收站${tail}。`);
        else if (op === "restore") setNotice(`已恢复 ${result.changed} 个文件${tail}。`);
        else if (op === "delete-message") setNotice(`已删除 ${result.changed} 条语音消息及其对应聊天轮次${tail}。`);
        else setNotice(`已永久删除 ${result.changed} 个文件，释放 ${formatBytes(result.bytes)}${tail}。`);
        onChanged();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(""));
  };

  return (
    <>
      <Modal label="媒体与存储" className="media-cleanup-modal" onClose={onClose}>
        <div className="media-cleanup-head">
          <div className="media-cleanup-heading">
            <button type="button" className="ml-btn" aria-label="返回" title="返回" onClick={onBack}>
              <ArrowLeft size={17} />
            </button>
            <div>
              <div className="modal-title">媒体与存储</div>
              <div className="modal-sub">聊天里的图片、视频和语音都会保留在这里；未引用文件超过 {data?.orphanGraceHours ?? 24} 小时才可清理。</div>
            </div>
          </div>
          <button type="button" className="ml-btn" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        {busy === "load" && data === null && (
          <div className="diagnostics-loading"><Loader2 size={18} className="spin" /> 正在整理媒体文件…</div>
        )}

        {error !== "" && <div className="banner show bad" role="alert"><div className="body">{error}</div></div>}
        {notice !== "" && <div className="banner show ok" role="status"><div className="body">{notice}</div></div>}

        {data !== null && (
          <>
            <div className="media-cleanup-summary">
              <div><b>{data.files}</b><span>全部文件</span><small>{formatBytes(data.allBytes)}</small></div>
              <div><b>{data.cleanable}</b><span>可安全清理</span><small>{formatBytes(data.totalBytes)}</small></div>
              <div><b>{data.trash.length}</b><span>回收站</span><small>{formatBytes(data.trashBytes)}</small></div>
              <p>有引用 {data.referenced} 个 · 保护期内 {data.pending} 个 · 语音消息随聊天记录一起备份</p>
            </div>

            <div className="media-cleanup-tabs" role="tablist" aria-label="媒体范围">
              <button type="button" role="tab" aria-selected={tab === "all"}
                className={tab === "all" ? "active" : ""} onClick={() => switchTab("all")}>
                全部 <span>{data.all.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={tab === "orphans"}
                className={tab === "orphans" ? "active" : ""} onClick={() => switchTab("orphans")}>
                可清理 <span>{data.items.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={tab === "trash"}
                className={tab === "trash" ? "active" : ""} onClick={() => switchTab("trash")}>
                回收站 <span>{data.trash.length}</span>
              </button>
              <button type="button" className="media-cleanup-refresh" aria-label="重新扫描" title="重新扫描" disabled={busy !== ""} onClick={load}>
                <RefreshCw size={14} className={busy === "load" ? "spin" : ""} />
              </button>
            </div>

            <div className="media-type-filter" role="toolbar" aria-label="按类型筛选">
              <button type="button" className={typeFilter === "all" ? "active" : ""} onClick={() => switchType("all")}>
                全部类型 <span>{baseItems.length}</span>
              </button>
              {typeStats.map((entry) => (
                <button type="button" key={entry.type} className={typeFilter === entry.type ? "active" : ""}
                  disabled={entry.files === 0} onClick={() => switchType(entry.type)}>
                  {typeIcon(entry.type)}
                  {{ image: "图片", video: "视频", audio: "语音" }[entry.type]} <span>{entry.files}</span>
                </button>
              ))}
            </div>

            {items.length === 0 ? (
              <div className="media-cleanup-empty">
                <FileImage size={22} />
                <b>{tab === "all" ? "这里还没有媒体" : tab === "orphans" ? "没有可清理的文件" : "回收站是空的"}</b>
                <span>{tab === "all" ? "从聊天里发送图片或语音，它们会出现在这里。" : tab === "orphans" ? "被消息、头像、作品或设置引用的文件不会被误清理。" : `移入回收站的文件会保留 ${data.trashRetentionDays} 天。`}</span>
              </div>
            ) : (
              <>
                <div className="media-cleanup-toolbar">
                  {selectable ? (
                    <label>
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={busy !== ""} />
                      全选
                    </label>
                  ) : (
                    <span>可直接删除语音消息；其他文件请在「可清理」中处理</span>
                  )}
                  <span>{selectable
                    ? `已选 ${selectedNames.length} / ${items.length} · ${formatBytes(items.filter((item) => selected.has(item.name)).reduce((sum, item) => sum + item.size, 0))}`
                    : `${items.length} 个 · ${formatBytes(items.reduce((sum, item) => sum + item.size, 0))}`}</span>
                </div>
                <div className="media-cleanup-list">
                  {items.map((item) => {
                    const trashItem = tab === "trash" ? item as MediaTrashItem : null;
                    const deletableVoice = tab !== "trash" && item.mediaType === "audio" && voiceMessageIds(item).length === 1;
                    return (
                      <div className={`media-file-row${selectable ? "" : " is-all"}`} key={item.name}>
                        {selectable && (
                          <input type="checkbox" aria-label={`选择 ${itemLabel(item)}`} checked={selected.has(item.name)}
                            onChange={() => toggle(item.name)} disabled={busy !== ""} />
                        )}
                        <div className={`media-file-thumb type-${item.mediaType}`}>
                          {item.mediaType === "image" && tab !== "trash"
                            ? <img src={item.url} alt="" loading="lazy" />
                            : item.mediaType === "video" && tab !== "trash"
                              ? <video src={item.url} muted playsInline preload="metadata" aria-hidden="true" />
                              : item.mediaType === "audio"
                                ? <AudioLines size={20} />
                                : <FileImage size={20} />}
                        </div>
                        <div className="media-file-copy">
                          <b>{itemLabel(item)}</b>
                          <span>{formatBytes(item.size)} · 修改于 {formatTime(item.modifiedAt)}</span>
                          {item.mediaType === "audio" && (
                            <VoiceMessageBubble compact url={item.url} durationMs={item.durationMs} transcript={item.transcript} />
                          )}
                          <div className="media-source-list">
                            {item.sources.map((source) => (
                              <span className={`media-source ${source.kind}`} key={`${source.kind}-${source.messageId ?? ""}-${source.detail ?? ""}`}
                                title={source.detail || source.label}>
                                {source.label}{source.detail ? ` · ${source.detail}` : ""}
                              </span>
                            ))}
                            {item.cleanable && <span className="media-source cleanable">可清理</span>}
                          </div>
                          {trashItem && (
                            <span className="media-trash-expiry">移入于 {formatTime(trashItem.trashedAt)} · {formatTime(trashItem.expiresAt)} 后自动删除</span>
                          )}
                        </div>
                        {tab === "trash" && (
                          <button type="button" className="btn sm ghost" disabled={busy !== ""}
                            onClick={() => operate("restore", [item.name])}>
                            <RotateCcw size={13} /> 恢复
                          </button>
                        )}
                        {deletableVoice && (
                          <button type="button" className="btn sm ghost danger-text" disabled={busy !== ""}
                            onClick={() => setConfirm({ op: "delete-message", names: [item.name] })}>
                            <Trash2 size={13} /> 删除消息
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className="actions media-cleanup-actions">
              <button type="button" className="btn" onClick={onBack} disabled={busy !== ""}>返回</button>
              {tab === "all" ? (
                data.items.length > 0 ? (
                  <button type="button" className="primary" onClick={() => switchTab("orphans")}>
                    查看可清理（{data.items.length}）
                  </button>
                ) : null
              ) : tab === "orphans" ? (
                <button type="button" className="primary" disabled={selectedNames.length === 0 || busy !== ""}
                  onClick={() => setConfirm({ op: "trash", names: selectedNames })}>
                  <Trash2 size={14} /> 移到回收站{selectedNames.length > 0 ? `（${selectedNames.length}）` : ""}
                </button>
              ) : (
                <>
                  <button type="button" className="btn" disabled={selectedNames.length === 0 || busy !== ""}
                    onClick={() => operate("restore", selectedNames)}>
                    <RotateCcw size={14} /> 恢复{selectedNames.length > 0 ? `（${selectedNames.length}）` : ""}
                  </button>
                  <button type="button" className="danger" disabled={selectedNames.length === 0 || busy !== ""}
                    onClick={() => setConfirm({ op: "purge", names: selectedNames })}>
                    <Trash2 size={14} /> 永久删除
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </Modal>

      {confirm !== null && (
        <Modal label={confirm.op === "trash" ? "移到回收站" : confirm.op === "delete-message" ? "删除语音消息" : "永久删除媒体"}
          className="media-confirm-modal" placement="center" onClose={() => { if (busy === "") setConfirm(null); }}>
          <div className="media-confirm-icon"><AlertTriangle size={20} /></div>
          <div className="modal-title">{confirm.op === "trash" ? "移到回收站？" : confirm.op === "delete-message" ? "删除语音消息？" : "永久删除这些文件？"}</div>
          <p className="modal-sub">
            {confirm.op === "trash"
              ? `将移动 ${confirm.names.length} 个文件。它们会保留 ${data?.trashRetentionDays ?? 7} 天，期间可以从回收站恢复。`
              : confirm.op === "delete-message"
                ? "这会从聊天中删除这条语音消息及对应的一轮对话，无法恢复。"
                : `将永久删除 ${confirm.names.length} 个文件，无法恢复。`}
          </p>
          <div className="actions">
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => setConfirm(null)}>取消</button>
            <button type="button" className={confirm.op === "trash" ? "primary" : "primary danger"} disabled={busy !== ""}
              onClick={() => operate(confirm.op, confirm.names)}>
              {busy === confirm.op ? "处理中…" : confirm.op === "trash" ? "确认移到回收站" : confirm.op === "delete-message" ? "删除语音消息" : "永久删除"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
