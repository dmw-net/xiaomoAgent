import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, Database, FileText, Loader2, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import Modal from "./Modal";
import { storageApi } from "../api";
import type { StorageCleanupOp, StorageOverview } from "../types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatTime(at: number | null): string {
  if (at === null) return "暂无";
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 数据占用与清理：只暴露不会动聊天/记忆的非核心项，危险操作另做确认。 */
export default function StorageCleanupDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<StorageOverview | null>(null);
  const [selected, setSelected] = useState<Set<StorageCleanupOp>>(() => new Set());
  const [busy, setBusy] = useState<"load" | "cleanup" | "">("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(false);
  const initialized = useRef(false);

  const load = useCallback(async (chooseRecommended = false): Promise<void> => {
    setBusy("load");
    setError("");
    try {
      const next = await storageApi.overview();
      setData(next);
      if (chooseRecommended) {
        const hasBodies = next.diagnostics.withBodies > 0;
        setSelected(new Set<StorageCleanupOp>(hasBodies ? ["diagnosticBodies"] : []));
      } else {
        setSelected(new Set());
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void load(true);
  }, [load]);

  const toggle = (op: StorageCleanupOp): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(op)) next.delete(op);
      else next.add(op);
      return next;
    });
    setNotice("");
  };

  const doCleanup = async (): Promise<void> => {
    if (selected.size === 0) return;
    setBusy("cleanup");
    setError("");
    setNotice("");
    try {
      const result = await storageApi.cleanup([...selected]);
      setConfirm(false);
      const parts: string[] = [];
      if (result.diagnosticBodiesCleared > 0) parts.push(`${result.diagnosticBodiesCleared} 条诊断原文`);
      if (result.modelCallsDeleted > 0) parts.push(`${result.modelCallsDeleted} 条调用记录`);
      if (result.importBackupsDeleted > 0) parts.push(`${result.importBackupsDeleted} 份导入前备份`);
      const onlyCompact = selected.size === 1 && selected.has("compact");
      setNotice(onlyCompact
        ? `数据库整理完成，当前总占用 ${formatBytes(result.afterBytes)}。`
        : `清理完成${parts.length > 0 ? "：" + parts.join("、") : ""}；本次整体占用减少 ${formatBytes(result.reclaimedBytes)}。${result.compacted ? "" : "数据库暂时被占用，下次清理或重启后会继续整理。"}`);
      await load(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const diagnosticsBytes = data === null ? 0 : data.diagnostics.reqBytes + data.diagnostics.resBytes;
  const diagnosticsCount = data?.diagnostics.withBodies ?? 0;
  const selectedDangerous = selected.has("modelCalls");

  return (
    <>
      <Modal label="数据占用与清理" className="storage-cleanup-modal" onClose={onClose}>
        <div className="media-cleanup-head">
          <div className="media-cleanup-heading">
            <Database size={19} />
            <div>
              <div className="modal-title">数据占用与清理</div>
              <div className="modal-sub">这里清理排障信息和旧备份；聊天、长期记忆、联系人、媒体引用不会在这里被删除。</div>
            </div>
          </div>
          <button type="button" className="ml-btn" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        {busy === "load" && data === null && (
          <div className="diagnostics-loading"><Loader2 size={18} className="spin" /> 正在统计数据占用…</div>
        )}
        {error !== "" && <div className="banner show bad" role="alert"><div className="body">{error}</div></div>}
        {notice !== "" && <div className="banner show ok" role="status"><div className="body">{notice}</div></div>}

        {data !== null && (
          <>
            <div className="media-cleanup-summary storage-cleanup-summary">
              <div><b>{formatBytes(data.totalBytes)}</b><span>全部数据</span><small>含数据库、媒体与旧备份</small></div>
              <div><b>{formatBytes(data.databaseBytes + data.walBytes)}</b><span>数据库</span><small>含 WAL 日志</small></div>
              <div><b>{formatBytes(data.mediaBytes)}</b><span>媒体文件</span><small>{data.importBackups.count > 0 ? `另有 ${data.importBackups.count} 份旧备份` : "无导入前备份"}</small></div>
              <p><code>{data.dataDir}</code></p>
            </div>

            <div className="storage-cleanup-list">
              <label className={`storage-cleanup-option${selected.has("diagnosticBodies") ? " selected" : ""}`}>
                <input type="checkbox" checked={selected.has("diagnosticBodies")}
                  disabled={busy !== "" || diagnosticsCount === 0} onChange={() => toggle("diagnosticBodies")} />
                <div>
                  <b><FileText size={14} /> 诊断原文 {diagnosticsCount > 0 && <span className="storage-recommended">推荐</span>}</b>
                  <p>完整请求与响应属于排障信息，不是聊天内容；仅保留最近若干次调用。清理后不影响聊天、记忆和用量统计。</p>
                </div>
                <span className="storage-size">{diagnosticsCount > 0 ? `当前 ${formatBytes(diagnosticsBytes)}` : "已清空"}</span>
              </label>

              <label className={`storage-cleanup-option${selected.has("modelCalls") ? " selected danger" : ""}`}>
                <input type="checkbox" checked={selected.has("modelCalls")}
                  disabled={busy !== "" || data.modelCalls.count === 0} onChange={() => toggle("modelCalls")} />
                <div>
                  <b><Trash2 size={14} /> 全部调用记录</b>
                  <p>删除 {data.modelCalls.count} 条活动记录；历史用量统计会归零，但聊天与记忆不受影响。调用时间范围 {formatTime(data.modelCalls.oldestAt)} 至 {formatTime(data.modelCalls.newestAt)}。</p>
                </div>
                <span className="storage-size">{data.modelCalls.count} 条</span>
              </label>

              <label className={`storage-cleanup-option${selected.has("importBackups") ? " selected" : ""}`}>
                <input type="checkbox" checked={selected.has("importBackups")}
                  disabled={busy !== "" || data.importBackups.count === 0} onChange={() => toggle("importBackups")} />
                <div>
                  <b><Archive size={14} /> 导入前备份</b>
                  <p>导入数据时自动留下的旧数据库和旧媒体，不影响当前正在使用的数据。</p>
                </div>
                <span className="storage-size">{data.importBackups.count > 0 ? formatBytes(data.importBackups.bytes) : "没有"}</span>
              </label>

              <label className={`storage-cleanup-option${selected.has("compact") ? " selected" : ""}`}>
                <input type="checkbox" checked={selected.has("compact")}
                  disabled={busy !== ""} onChange={() => toggle("compact")} />
                <div>
                  <b><Database size={14} /> 压缩数据库空间</b>
                  <p>整理数据库中的空闲空间和 WAL 日志；不删除聊天、调用记录或设置。删过数据但文件占用仍明显偏大时使用。</p>
                </div>
                <span className="storage-size">当前 {formatBytes(data.databaseBytes + data.walBytes)}</span>
              </label>
            </div>

            <div className="storage-cleanup-safety">
              <ShieldCheck size={15} />
              <span>不会清理：聊天消息、长期记忆、联系人、设置与密钥、作品、被引用的媒体。媒体请去「媒体与存储」按文件确认。</span>
            </div>

            <div className="actions media-cleanup-actions">
              <button type="button" className="btn" onClick={() => void load(false)} disabled={busy !== ""}>
                <RefreshCw size={14} className={busy === "load" ? "spin" : ""} /> 重新统计
              </button>
              <button type="button" className={selectedDangerous ? "danger" : "primary"}
                disabled={selected.size === 0 || busy !== ""} onClick={() => setConfirm(true)}>
                {busy === "cleanup" ? <><Loader2 size={14} className="spin" /> 正在清理…</> : <><Trash2 size={14} /> 清理所选</>}
              </button>
            </div>
          </>
        )}
      </Modal>

      {confirm && (
        <Modal label="确认清理数据" className="storage-confirm-modal" placement="center"
          onClose={() => { if (busy !== "cleanup") setConfirm(false); }}>
          <div className="media-confirm-icon"><AlertTriangle size={20} /></div>
          <div className="modal-title">确认清理所选数据？</div>
          <p className="modal-sub">
            {selected.size === 1 && selected.has("compact")
              ? "将整理数据库空闲空间，不删除任何聊天、调用记录或设置。"
              : `将清理 ${selected.size} 项非核心数据并压缩数据库。${selectedDangerous ? "调用记录的用量统计会归零。" : ""}聊天、记忆、联系人与媒体引用不会被删除。`}
          </p>
          <div className="actions">
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => setConfirm(false)}>取消</button>
            <button type="button" className="primary danger" disabled={busy !== ""} onClick={() => void doCleanup()}>
              {busy === "cleanup" ? "正在清理…" : "确认清理"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
