import { useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, X, XCircle } from "lucide-react";
import Modal from "./Modal";
import MediaMaintenanceDialog from "./MediaMaintenanceDialog";
import { diagnosticsApi } from "../api";
import type { DiagnosticLevel, UserDiagnostics, UserDiagnosticCheck } from "../types";

const LEVEL_LABEL: Record<DiagnosticLevel, string> = { ok: "正常", warn: "建议处理", bad: "需要处理" };

function LevelIcon({ level }: { level: DiagnosticLevel }): JSX.Element {
  if (level === "ok") return <CheckCircle2 size={17} />;
  if (level === "warn") return <AlertTriangle size={17} />;
  return <XCircle size={17} />;
}

function actionLabel(action: UserDiagnosticCheck["action"]): string {
  if (action === "backup") return "去备份";
  if (action === "storage") return "查看存储";
  if (action === "activity") return "查看活动";
  if (action === "settings") return "去设置";
  if (action === "media") return "查看并清理";
  return "";
}

/** 普通用户可用的只读体检入口。原始请求与系统提示词不会从这里返回。 */
export default function DiagnosticsButton({ className = "btn", label = "运行检查", onAction }: {
  className?: string;
  label?: string;
  onAction?: (action: NonNullable<UserDiagnosticCheck["action"]>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<UserDiagnostics | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"checks" | "media">("checks");

  const check = (): void => {
    setBusy(true);
    setError("");
    diagnosticsApi.run()
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const show = (): void => {
    setOpen(true);
    setView("checks");
    if (!busy) check();
  };

  const close = (): void => {
    setOpen(false);
    setView("checks");
  };

  const runAction = (action: NonNullable<UserDiagnosticCheck["action"]>): void => {
    if (action === "media") {
      setView("media");
      return;
    }
    if (!onAction) return;
    onAction(action);
    close();
  };

  return (
    <>
      <button type="button" className={className} onClick={show}>
        <Activity size={14} /> {label}
      </button>
      {open && view === "checks" && (
        <Modal label="运行检查" className="diagnostics-modal" onClose={close}>
          <div className="diagnostics-head">
            <div>
              <div className="modal-title">运行检查</div>
              <div className="modal-sub">检查本机数据、回复任务和媒体文件；不会修改任何内容。</div>
            </div>
            <button type="button" className="ml-btn" aria-label="关闭" title="关闭" onClick={close}>
              <X size={17} />
            </button>
          </div>

          {busy && !data && <div className="diagnostics-loading"><Loader2 size={18} className="spin" /> 正在检查…</div>}
          {error !== "" && (
            <div className="banner show bad" role="alert">
              <div className="body">检查失败：{error}</div>
            </div>
          )}
          {data && (
            <>
              <div className={`diagnostics-summary ${data.level}`}>
                <LevelIcon level={data.level} />
                <div>
                  <b>{data.level === "ok" ? "运行状态正常" : data.level === "warn" ? "有几项建议处理" : "发现需要处理的问题"}</b>
                  <span>共检查 {data.checks.length} 项 · {new Date(data.checkedAt).toLocaleTimeString("zh-CN")}</span>
                </div>
              </div>
              <div className="diagnostics-list">
                {data.checks.map((item) => (
                  <div key={item.id} className={`diagnostics-row ${item.level}`}>
                    <span className="diagnostics-icon"><LevelIcon level={item.level} /></span>
                    <div className="diagnostics-copy">
                      <div><b>{item.label}</b><span>{LEVEL_LABEL[item.level]}</span></div>
                      <small>{item.summary}</small>
                      {item.detail && (
                        <details>
                          <summary>查看说明</summary>
                          <p>{item.detail}</p>
                        </details>
                      )}
                    </div>
                    {item.action && (item.action === "media" || onAction) && (
                      <button type="button" className="btn sm"
                        onClick={() => runAction(item.action!)}>
                        {actionLabel(item.action)}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={check}>
              <RefreshCw size={14} className={busy ? "spin" : ""} /> {busy ? "检查中…" : "重新检查"}
            </button>
            <button type="button" className="primary" onClick={close}>完成</button>
          </div>
        </Modal>
      )}
      {open && view === "media" && (
        <MediaMaintenanceDialog
          initialTab="orphans"
          onBack={() => { check(); setView("checks"); }}
          onClose={close}
          onChanged={check}
        />
      )}
    </>
  );
}
