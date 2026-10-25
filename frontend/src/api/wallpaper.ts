/** 壁纸上传与删除。文件落成 /media 的 wp 前缀文件，引用只存在设备 localStorage 里。 */

/** 上传壁纸（图片 ≤5MB / 视频 ≤100MB，后端按魔数复检），返回 /media URL。
 *  prev 传当前正在用的壁纸 URL：后端落好新文件后顺手删掉旧的，换壁纸不在盘上留大视频。
 *  视频上传可能上百 MB，超时给足五分钟——别的请求 10 秒是常态，这里不能共用。 */
export async function uploadWallpaper(file: File, prev?: string): Promise<{ url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const res = await fetch("/api/wallpaper" + (prev ? `?prev=${encodeURIComponent(prev)}` : ""), {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as { ok?: boolean; error?: string; url?: string };
    if (!data.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
    return { url: data.url };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("上传超时了，换个更小的文件试试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 删掉一个壁纸文件。失败不抛：文件残留交给出厂重置兜底，别为它打断换壁纸。 */
export async function removeWallpaperFile(url: string): Promise<void> {
  try {
    await fetch(`/api/wallpaper?url=${encodeURIComponent(url)}`, { method: "DELETE" });
  } catch { /* 同上 */ }
}
