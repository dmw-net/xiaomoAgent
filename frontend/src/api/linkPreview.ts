import { getJson } from "./client";
import type { LinkPreview } from "../../../shared/api";

export type { LinkPreview };

/** 取一条链接预览。失败由调用方安静降级，聊天正文本身永远不受影响。 */
export async function preview(url: string): Promise<LinkPreview> {
  const data = await getJson<{ ok: true; preview: LinkPreview }>(
    "/api/link-preview?url=" + encodeURIComponent(url),
  );
  return data.preview;
}
