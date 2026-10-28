import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, FileImage, Loader2, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import Modal from "./Modal";
import { mediaApi } from "../api";
import type { MediaMaintenanceItem, MediaMaintenanceSnapshot, MediaTrashItem } from "../types";

type Tab = "all" | "orphans" | "trash";
type ConfirmState = { op: "trash" | "purge"; names: string[] } | null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** 媒体总览：全部文件、引用来源、可清理项和回收站都在同一个视图里。 */
export default function MediaMaintenanceDialog({ onBack, onClose, onChanged, initialTab = "all" }: {
  onBack: () => void;
  onClose: () => void;
  onChanged: () => void;
  initialTab?: Tab;
}): JSX.Element {
  const [data, setData] = useState<MediaMaintenanceSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<"load" | "trash" | "restore" | "purge" | "">("");
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

  const items: MediaMaintenanceItem[] = tab === "all"
    ? data?.all ?? []
    : tab === "orphans"
      ? data?.items ?? []
      : data?.trash ?? [];
  const selectable = tab !== "all";
  const selectedNames = selectable
    ? items.filter((item) => selected.has(item.name)).map((item) => item.name)
    : [];
  const allSelected = selectable && items.length > 0 && selectedNames.length === items.length;

  const switchTab = (next: Tab): void => {
    setTab(next);
    setSelected(new Set());
    setError("");
    setNotice("");
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

  const operate = (op: "trash" | "restore" | "purge", names: string[]): void => {
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
        const tail = result.skipped > 0 ? `，${result.skipped} 个文件因刚被引用、尚未满保护期或已被处理而跳过` : "";
        if (op === "trash") setNotice(`已将 ${result.changed} 个文件移到回收站${tail}。`);
        else if (op === "restore") setNotice(`已恢复 ${result.changed} 个文件${tail}。`);
        else setNotice(`已永久删除 ${result.changed} 个文件，释放 ${formatBytes(result.bytes)}${tail}。`);
        onChanged();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(""));
  };

  return (
    <>
      <Modal label="媒体文件" className="media-cleanup-modal" onClose={onClose}>
        <div className="media-cleanup-head">
          <div className="media-cleanup-heading">
            <button type="button" className="ml-btn" aria-label="返回" title="返回" onClick={onBack}>
              <ArrowLeft size={17} />
            </button>
            <div>
              <div className="modal-title">媒体文件</div>
              <div className="modal-sub">全部文件及引用来源；只有未引用且超过 {data?.orphanGraceHours ?? 24} 小时的图片可以清理。</div>
            </div>
          </div>
          <button type="button" className="ml-btn" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        {busy === "load" && data === null && (
          <div className="diagnostics-loading"><Loader2 size={18} className="spin" /> 正在扫描媒体文件…</div>
        )}

        {error !== "" && <div className="banner show bad" role="alert"><div className="body">{error}</div></div>}
        {notice !== "" && <div className="banner show ok" role="status"><div className="body">{notice}</div></div>}

        {data !== null && (
          <>
            <div className="media-cleanup-summary">
              <div><b>{data.files}</b><span>全部文件</span><small>{formatBytes(data.allBytes)}</small></div>
              <div><b>{data.cleanable}</b><span>可清理</span><small>{formatBytes(data.totalBytes)}</small></div>
              <div><b>{data.trash.length}</b><span>回收站</span><small>{formatBytes(data.trashBytes)}</small></div>
              <p>有来源引用 {data.referenced} 个 · 未引用且在保护期内 {data.pending} 个</p>
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
              <button type="button" className="media-cleanup-refresh" disabled={busy !== ""} onClick={load} title="重新扫描">
                <RefreshCw size={14} className={busy === "load" ? "spin" : ""} /> 重新扫描
              </button>
            </div>

            {items.length === 0 ? (
              <div className="media-cleanup-empty">
                <FileImage size={24} />
                <b>{tab === "all" ? "媒体目录还是空的" : tab === "orphans" ? "没有可清理的未引用文件" : "回收站是空的"}</b>
                <span>{tab === "all"
                  ? "上传聊天图片、设置头像或壁纸后，文件和来源会出现在这里。"
                  : tab === "orphans"
                    ? data.pending > 0 ? "最近上传的文件还在保护期，满 24 小时后才会进入这里。" : "之后如果出现，也会先列在这里供你确认。"
                    : `移入回收站的文件会保留 ${data.trashRetentionDays} 天，期间可以恢复。`}</span>
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
                    <span>只读总览 · 切到「可清理」才能移动文件</span>
                  )}
                  <span>{selectable
                    ? `已选 ${selectedNames.length} / ${items.length} · ${formatBytes(items.filter((item) => selected.has(item.name)).reduce((sum, item) => sum + item.size, 0))}`
                    : `共 ${items.length} 个 · ${formatBytes(data.allBytes)}`}</span>
                </div>
                <div className="media-cleanup-list">
                  {items.map((item) => {
                    const trashItem = tab === "trash" ? item as MediaTrashItem : null;
                    return (
                    <div className={`media-file-row${selectable ? "" : " is-all"}`} key={item.name}>
                      {selectable && (
                        <input type="checkbox" aria-label={`选择 ${item.name}`} checked={selected.has(item.name)}
                          onChange={() => toggle(item.name)} disabled={busy !== ""} />
                      )}
                      <div className="media-file-thumb">
                        {item.mediaKind === "image" && tab !== "trash"
                          ? <img src={item.url} alt="" loading="lazy" />
                          : <FileImage size={20} />}
                      </div>
                      <div className="media-file-copy">
                        <b>{item.name}</b>
                        <span>{formatBytes(item.size)} · 修改于 {formatTime(item.modifiedAt)}</span>
                        <div className="media-source-list">
                          {item.sources.map((source) => (
                            <span className={`media-source ${source.kind}`} key={`${source.kind}-${source.detail ?? ""}`}
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
        <Modal label={confirm.op === "trash" ? "移到回收站" : "永久删除媒体"} className="media-confirm-modal" placement="center"
          onClose={() => { if (busy === "") setConfirm(null); }}>
          <div className="media-confirm-icon"><AlertTriangle size={20} /></div>
          <div className="modal-title">{confirm.op === "trash" ? "移到回收站？" : "永久删除这些文件？"}</div>
          <p className="modal-sub">
            {confirm.op === "trash"
              ? `将移动 ${confirm.names.length} 个文件。它们会保留 ${data?.trashRetentionDays ?? 7} 天，期间可以从回收站恢复。`
              : `将永久删除 ${confirm.names.length} 个文件，无法恢复。`}
          </p>
          <div className="actions">
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => setConfirm(null)}>取消</button>
            <button type="button" className={confirm.op === "trash" ? "primary" : "primary danger"} disabled={busy !== ""}
              onClick={() => operate(confirm.op, confirm.names)}>
              {busy === confirm.op ? "处理中…" : confirm.op === "trash" ? "确认移到回收站" : "永久删除"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
