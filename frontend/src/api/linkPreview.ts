import { getJson } from "./client";

export type LinkPreview = {
  url: string;
  finalUrl: string;
  domain: string;
  title: string;
  description: string;
  siteName: string;
  icon: string;
};

/** 取一条链接预览。失败由调用方安静降级，聊天正文本身永远不受影响。 */
export async function preview(url: string): Promise<LinkPreview> {
  const data = await getJson<{ ok: true; preview: LinkPreview }>(
    "/api/link-preview?url=" + encodeURIComponent(url),
  );
  return data.preview;
}
