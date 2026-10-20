const EXPORT_URL = "/api/settings/data-export";

export type ExportProgress = (loaded: number, total: number | null) => void;

export type ExportedArchive = {
  blob: Blob;
  fileName: string;
};

function fallbackFileName(): string {
  const d = new Date();
  const p = (n: number, len = 2): string => String(n).padStart(len, "0");
  return `xiaomo-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.tar.gz`;
}

function responseFileName(header: string | null): string {
  if (!header) return fallbackFileName();
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* 回退到普通 filename */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)?.[1];
  return plain?.trim() || fallbackFileName();
}

/**
 * 生成并下载备份。
 * 不用裸下载链接：链接触发后浏览器不会把“下载完成”回传给页面，进度会永远卡住。
 * XHR 能收到下载进度和 onload，完成后由这里明确返回 100% 与保存动作。
 */
export function exportDataArchive(onProgress?: ExportProgress): Promise<ExportedArchive> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", EXPORT_URL);
    xhr.responseType = "blob";
    xhr.timeout = 0;
    xhr.onprogress = (event) => {
      onProgress?.(event.loaded, event.lengthComputable ? event.total : null);
    };
    xhr.onerror = () => reject(new Error("网络中断或连接被关闭，备份没有下载完成"));
    xhr.onload = async () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = `导出失败（HTTP ${xhr.status}）`;
        try {
          const body = JSON.parse(await xhr.response.text()) as { error?: unknown };
          if (typeof body.error === "string" && body.error !== "") detail = body.error;
        } catch { /* 保留状态码提示 */ }
        reject(new Error(detail));
        return;
      }
      const blob = xhr.response as Blob;
      if (blob.size === 0) {
        reject(new Error("导出的备份是空文件，请重试"));
        return;
      }
      resolve({
        blob,
        fileName: responseFileName(xhr.getResponseHeader("content-disposition")),
      });
    };
    xhr.send();
  });
}

export type DataImportResult = {
  ok: true;
  files: number;
  media: number;
  skills: number;
  bytes: number;
  note: string;
  restartRequired: boolean;
};

export type ImportProgress = (loaded: number, total: number | null, phase: "upload" | "process") => void;

type ImportResponse = {
  ok?: boolean;
  error?: string;
  files?: number;
  media?: number;
  skills?: number;
  bytes?: number;
  note?: string;
  restartRequired?: boolean;
};

/** 上传备份文件。XHR 的 upload.progress 能在大文件迁移时给出真实上传百分比。 */
export function importDataArchive(file: File, onProgress?: ImportProgress): Promise<DataImportResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/settings/data-import");
    xhr.setRequestHeader("content-type", "application/gzip");
    xhr.timeout = 0;
    xhr.upload.onprogress = (event) => {
      onProgress?.(event.loaded, event.lengthComputable ? event.total : null, "upload");
    };
    xhr.upload.onload = () => onProgress?.(1, 1, "process");
    xhr.onerror = () => reject(new Error("网络中断或连接被关闭，导入没有完成"));
    xhr.onload = () => {
      let data: ImportResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as ImportResponse;
      } catch {
        reject(new Error(`导入失败：服务端返回了无法识别的内容（HTTP ${xhr.status}）`));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300 || !data.ok) {
        reject(new Error(data.error || `导入失败（HTTP ${xhr.status}）`));
        return;
      }
      resolve({
        ok: true,
        files: data.files ?? 0,
        media: data.media ?? 0,
        skills: data.skills ?? 0,
        bytes: data.bytes ?? 0,
        note: data.note ?? "导入完成",
        restartRequired: data.restartRequired ?? true,
      });
    };
    xhr.send(file);
  });
}
