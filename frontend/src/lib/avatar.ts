/**
 * 选图 → 居中裁剪 → 压成 128×128 JPEG dataURL。
 *
 * ⚠️ 两个上限不是一回事，别照着一个写另一个：
 *   服务端**字段**校验（settings.ts 的 sanitizeOwner / validatePersona）放 150KB；
 *   但 `POST /api/settings` 走 readJson 的**传输**上限 MAX_BODY_BYTES = 32KB，
 *   超了在字段校验之前就 400「请求体过大」。所以一张细节多的图（128×128 q0.85 的
 *   base64 很容易越过 24KB → 32KB）会被一个说着 150KB 的错误挡掉。
 *   联系人头像没有这个问题（那条路走 /api/media 落 /media 文件，不内联）。
 *   修法要么给 /api/settings 与联系人 PUT 放宽传输上限（/api/asr 已经这么做了），
 *   要么让全局用户头像也改走 /api/media。
 */
export function fileToAvatarDataUrl(file: File, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件"));
      return;
    }
    const reader = new FileReader();
    reader.onload = (): void => {
      const img = new Image();
      img.onload = (): void => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("画布不可用"));
          return;
        }
        const side = Math.min(img.width, img.height);
        ctx.drawImage(
          img,
          (img.width - side) / 2,
          (img.height - side) / 2,
          side,
          side,
          0,
          0,
          size,
          size,
        );
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = (): void => reject(new Error("图片读取失败"));
      img.src = String(reader.result);
    };
    reader.onerror = (): void => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
