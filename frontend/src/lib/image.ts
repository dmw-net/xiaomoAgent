/** 选图 → 等比缩到 maxSide 内 → JPEG（约 100-400KB）。手机端原图动辄 5MB+，必须先压。 */
export function fileToImageBlob(file: File, maxSide = 1280): Promise<Blob> {
  return new Promise((resolvePromise, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件"));
      return;
    }
    const reader = new FileReader();
    reader.onload = (): void => {
      const img = new Image();
      img.onload = (): void => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        // 小图本就够小、或 GIF（重编码会丢动画）：原样上传
        if (scale === 1 && file.size <= 400 * 1024) {
          resolvePromise(file);
          return;
        }
        if (file.type === "image/gif" && file.size <= 4 * 1024 * 1024) {
          resolvePromise(file);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("画布不可用"));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => (blob ? resolvePromise(blob) : reject(new Error("图片压缩失败"))),
          "image/jpeg",
          0.85,
        );
      };
      img.onerror = (): void => reject(new Error("图片读取失败（格式可能不受支持）"));
      img.src = String(reader.result);
    };
    reader.onerror = (): void => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/** Blob → dataURL（录音送 ASR 用）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolvePromise(String(reader.result));
    reader.onerror = (): void => reject(new Error("读取失败"));
    reader.readAsDataURL(blob);
  });
}
