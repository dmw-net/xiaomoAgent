import { useCallback, useState, type ReactNode } from "react";
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
      let copied = false;
      try { await navigator.clipboard.writeText(href); copied = true; } catch { copied = false; }
      setNote(`${r.error} · ${copied ? "链接已复制到剪贴板：" : "请手动打开："}${href}`);
    })();
  }, [href]);
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer" className="md-link"
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
const URL_TAIL_RE = /[.,;:!?。，；：！？、）》】”"'’]+$/;

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
      let url = token.replace(URL_TAIL_RE, "");
      // 外面拿括号把地址括起来时（「见 (https://…)」），多出来的那个右括号是句读不是地址。
      // 只削配对不上的右侧括号：`…/a(b)` 这种自带括号的地址原样留着。
      while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
        url = url.slice(0, -1);
      }
      nodes.push(<MdLink key={keyBase + i} href={url} label={url} />);
      const tail = token.slice(url.length);
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
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) return; // 代码围栏标记本身不显示，内容按普通行走
    const key = `l${index}`;
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
  return out;
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
