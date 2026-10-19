/** 复制文本。http 局域网场景 navigator.clipboard 不存在，必须带 execCommand 兜底。 */
export async function copyText(text: string): Promise<"ok" | "manual"> {
  const fallback = (): "ok" | "manual" => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch { /* 老浏览器 */ }
    let fine = false;
    try { fine = document.execCommand("copy"); } catch { fine = false; }
    document.body.removeChild(ta);
    return fine ? "ok" : "manual";
  };
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return "ok"; } catch { return fallback(); }
  }
  return fallback();
}
