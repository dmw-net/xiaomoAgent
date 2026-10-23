import { useCallback, useState, type ReactNode } from "react";
import { copyText } from "./clipboard";
import { openExternal } from "./open-external";

/**
 * 回复里的外链。外壳（Tauri 的 WebView）里 `target="_blank"` 点了没反应，必须交给
 * openExternal 让系统浏览器接手；失败时把原因和地址摊在链接后面——只 console.warn 的话，
 * 用户看到的就是「点了没反应」。与「关于」里那条 ExtLink 同一套口径。
 */
function MdLink({ href, label }: { href: string; label: string }): JSX.Element {
  const [note, setNote] = useState("");
  const open = useCallback((): void => {
    setNote("");
    void (async () => {
      const r = await openExternal(href);
      if (r.ok) return;
      // 局域网是 http 普通源，navigator.clipboard 不存在；统一走带 execCommand 兜底的 copyText。
      const copied = (await copyText(href)) === "ok";
      setNote(`${r.error} · ${copied ? "链接已复制到剪贴板：" : "请手动打开："}${href}`);
    })();
  }, [href]);
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer" className="md-link" title={href}
        onClick={(e) => { e.preventDefault(); open(); }}>{label}</a>
      {note !== "" && <span className="md-link-note">{note}</span>}
    </>
  );
}

/**
 * 行内标记：**粗体**、`代码`、[文字](https://…) 与裸出现的 https://…。
 *
 * 链接**只认 http/https**：模型偶尔会吐 `javascript:` 这类地址，那类一律按普通文字渲染，
 * 不给它变出一个可点的锚点。裸地址排在 markdown 链接后面，否则 `[文字](https://…)`
 * 会从括号里的那半截开始匹配，把方括号和文字一起留在外面。
 */
const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(\s*https?:\/\/[^)\s]+\s*\)|https?:\/\/[^\s<>"'`）】]+)/g;
const MD_LINK_RE = /^\[([^\]\n]+)\]\(\s*(https?:\/\/[^)\s]+)\s*\)$/;
/** 裸地址尾巴上的标点是句读不是地址：中文句号、右括号、引号这些留在文字里。 */
const URL_TAIL_RE = /[.,;:!?。，；：！？、）》】”"'’\]\}＞…]+$/;
const BARE_URL_RE = /https?:\/\/[^\s<>"'`）】]+/g;

/** 裸链接只显示域名；完整 URL 留在 href/title 里，避免一条链接把气泡撑得很长。 */
export function linkDomain(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./i, "") || href;
  } catch {
    return href;
  }
}

function bareUrlParts(token: string): { url: string; tail: string } {
  let url = token.replace(URL_TAIL_RE, "");
  // 外面拿括号把地址括起来时（「见 (https://…)」），多出来的那个右括号是句读不是地址。
  // 只削配对不上的右侧括号：`…/a(b)` 这种自带括号的地址原样留着。
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return { url, tail: token.slice(url.length) };
}

/** 消息里第一条可预览的外链；围栏代码块、行内代码和图片地址都不算。 */
export function findFirstExternalUrl(text: string): string {
  // 先把围栏代码块整段遮掉。只在 inline() 里跳过反引号 token 是不够的：
  // 代码块的内容是按普通行走的，里面 `curl https://…` 这种地址会被误当成正文外链。
  let inFence = false;
  const visible = text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return ""; }
    return inFence ? "" : line;
  }).join("\n");
  // 行内代码同理；Markdown 图片的地址也不是“点开看看的网页”，摘掉后再扫。
  const scan = visible
    .replace(/`[^`\n]*`/g, "")
    .replace(/!\[[^\]\n]*\]\(\s*https?:\/\/[^)\s]+\s*\)/g, "");
  const re = new RegExp(INLINE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(scan)) !== null) {
    const token = match[0];
    if (token.startsWith("[")) {
      const parts = MD_LINK_RE.exec(token);
      if (parts) return parts[2]!;
    } else if (token.startsWith("http")) {
      return bareUrlParts(token).url;
    }
  }
  return "";
}

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={keyBase + i}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={keyBase + i} className="md-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const parts = MD_LINK_RE.exec(token);
      if (parts) nodes.push(<MdLink key={keyBase + i} href={parts[2]!} label={parts[1]!} />);
      else nodes.push(token); // 形状不合（比如地址不是 http）就原样显示，别吞字
    } else {
      const { url, tail } = bareUrlParts(token);
      nodes.push(<MdLink key={keyBase + i} href={url} label={linkDomain(url)} />);
      if (tail !== "") nodes.push(tail);
    }
    last = m.index + token.length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function renderMd(text: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  // 围栏代码块整段原样放进 <pre>：以前只跳过 ``` 标记行、内容仍走 inline()，
  // 代码里的 URL 会变成可点链接，**粗体** 之类也会被误当 Markdown 解析。
  let fenceKey = "";
  let fenceLines: string[] = [];
  const flushFence = (): void => {
    if (fenceLines.length > 0) {
      out.push(<pre key={fenceKey} className="md-pre">{fenceLines.join("\n")}</pre>);
    }
    fenceKey = "";
    fenceLines = [];
  };
  lines.forEach((line, index) => {
    const key = `l${index}`;
    if (/^\s*```/.test(line)) {
      if (fenceKey === "") fenceKey = key;
      else flushFence();
      return;
    }
    if (fenceKey !== "") {
      fenceLines.push(line);
      return;
    }
    const bullet = /^\s*[-*]\s+/.exec(line);
    const heading = /^\s*(#{1,4})\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(<div key={key} className="md-li">• {inline(line.slice(bullet[0].length), key)}</div>);
    } else if (heading) {
      out.push(<div key={key} className="md-h"><strong>{inline(heading[2] ?? "", key)}</strong></div>);
    } else {
      out.push(<span key={key}>{inline(line, key)}{index < lines.length - 1 ? "\n" : ""}</span>);
    }
  });
  if (fenceKey !== "") flushFence(); // 未闭合的围栏也按代码显示，别把后半段吞掉
  return out;
}

/** 工具详情等纯文本区域：保留原排版，只把裸 URL 变成可点击的域名链接。 */
export function renderLinkedText(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const re = new RegExp(BARE_URL_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const { url, tail } = bareUrlParts(match[0]);
    nodes.push(<MdLink key={"u" + i} href={url} label={linkDomain(url)} />);
    if (tail !== "") nodes.push(tail);
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 列表/预览用的纯文本化：去掉 markdown 标记，不留字面星号。 */
export function stripMd(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\(\s*https?:\/\/[^)\s]+\s*\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*#{1,4}\s+/gm, "")
    .replace(/```[^\n]*\n?/g, "");
}
