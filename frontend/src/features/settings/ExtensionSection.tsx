// 扩展工作台：MCP / Webhook / JS 工具的登记、启停与诊断。
//
// 三类工具从这里进模型的手：
//   mcp     — 清单里连一个 MCP 服务，工具目录由对方下发（probe 后可见）
//   webhook — 清单自带的自定义工具，调用时把参数 POST 给一个 URL
//   script  — 同样自带，但执行的是一段 JS；整个类别被「脚本许可」锁着，默认关
//
// 界面纪律：风险说在明处。诊断按级别上色，脚本许可与删除都走确认弹窗；
// 快照由 ToolsWorkbench 统一持有，这一屏不再自己缓存一份可能过期的状态。

import { useRef, useState } from "react";
import { FileJson, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import * as extensionsApi from "../../api/extensions";
import Switch from "../../components/Switch";
import type { ExtensionSnapshot, ExtensionSnapshotEntry, ExtensionToolKind } from "../../types";

const KIND_LABEL: Record<ExtensionToolKind, string> = { mcp: "MCP", webhook: "Webhook", script: "JS" };

/** 一份扩展清单长什么样——界面给样本，校验规则在后端，两边说的是同一份格式。 */
const SAMPLE_MANIFEST = [
  "{",
  '  "formatVersion": 1,',
  '  "id": "tavily-web-search",',
  '  "name": "Tavily 网络搜索",',
  '  "version": "1.0.0",',
  '  "description": "联网搜索实时信息。",',
  '  "mcp": { "url": "https://mcp.example.com/mcp/" },',
  '  "tools": []',
  "}",
].join("\n");

const DEFAULT_SCHEMA = '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}';

type ToolDraft = {
  name: string;
  description: string;
  parameters: string;
  kind: "webhook" | "script";
  url: string;
  code: string;
};

const EMPTY_DRAFT: ToolDraft = {
  name: "", description: "", parameters: DEFAULT_SCHEMA, kind: "webhook", url: "", code: "async (args) => ({ ok: true, result: args })",
};

function stateOf(entry: ExtensionSnapshotEntry): { label: string; tone: string; on: boolean } {
  if (entry.diagnostics.some((d) => d.level === "error")) return { label: "有问题", tone: "is-bad", on: false };
  if (entry.enabled) return { label: "已启用", tone: "is-on", on: true };
  return { label: "已停用", tone: "is-off", on: false };
}

/**
 * 快照里的工具名带命名空间前缀（ext__<id>__ / mcp__<id>__），
 * 而后端 DELETE 收的是清单里的短名。反解不出来（超长被截短并加了哈希）就不给删除入口，
 * 免得点下去删了个寂寞；MCP 远端目录里的工具本来也不在清单里。
 */
function editableShortName(entry: ExtensionSnapshotEntry, declaredName: string, kind: ExtensionToolKind): string | null {
  if (kind === "mcp") return null;
  const extPrefix = `ext__${entry.id}__`;
  const mcpPrefix = `mcp__${entry.id}__`;
  let short = declaredName;
  if (short.startsWith(extPrefix)) short = short.slice(extPrefix.length);
  else if (short.startsWith(mcpPrefix)) short = short.slice(mcpPrefix.length);
  return /^[a-z][a-z0-9_]{0,39}$/.test(short) ? short : null;
}

export default function ExtensionSection({ ask, snapshot, onSnapshot, onRefresh }: {
  ask: (title: string, note: string, run: () => void) => void;
  snapshot: ExtensionSnapshot | null;
  onSnapshot: (next: ExtensionSnapshot) => void;
  onRefresh: () => void;
}): JSX.Element {
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [paste, setPaste] = useState("");
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<ToolDraft>(EMPTY_DRAFT);
  const fileRef = useRef<HTMLInputElement>(null);

  const fail = (e: unknown): void => {
    setNote("");
    setErr(e instanceof Error ? e.message : String(e));
  };

  const run = (key: string, work: Promise<ExtensionSnapshot>, ok: string): void => {
    setBusy(key);
    setErr("");
    setNote("");
    work
      .then((next) => { onSnapshot(next); setNote(ok); })
      .catch(fail)
      .finally(() => setBusy(""));
  };

  const toggle = (entry: ExtensionSnapshotEntry, enabled: boolean): void => {
    setBusy(entry.id);
    setErr("");
    setNote("");
    extensionsApi.setExtensionEnabled(entry.id, enabled)
      .then((next) => {
        onSnapshot(next);
        const bad = next.extensions.find((x) => x.id === entry.id)?.diagnostics.find((d) => d.level === "error");
        // 开启失败不回滚开关：服务可能只是暂时不可达，但要把话说全。
        if (enabled && bad) setErr(bad.message);
        else setNote(enabled ? `「${entry.name}」已启用，工具目录已就绪。` : `「${entry.name}」已停用。`);
      })
      .catch(fail)
      .finally(() => setBusy(""));
  };

  const probe = (entry: ExtensionSnapshotEntry): void => {
    setBusy(entry.id);
    setErr("");
    setNote("");
    extensionsApi.probeExtension(entry.id)
      .then((next) => {
        onSnapshot(next);
        const found = next.extensions.find((x) => x.id === entry.id);
        const bad = found?.diagnostics.find((d) => d.level === "error");
        if (bad) setErr(bad.message);
        else setNote(`「${entry.name}」连接正常，发现 ${found?.tools.filter((t) => t.kind === "mcp").length ?? 0} 个 MCP 工具。`);
      })
      .catch(fail)
      .finally(() => setBusy(""));
  };

  const remove = (entry: ExtensionSnapshotEntry): void => {
    ask(`删掉「${entry.name}」？`, "扩展连同全部工具一起摘除，找不回来。要换新版本重新导入即可。", () => {
      run(entry.id, extensionsApi.removeExtension(entry.id, true), `「${entry.name}」已经删掉了。`);
    });
  };

  const toggleScriptGate = (allow: boolean): void => {
    if (snapshot === null) return;
    if (!allow) {
      run("gate", extensionsApi.setScriptGate(true, false), "JS 工具执行许可已关闭，脚本工具对模型不可见。");
      return;
    }
    ask(
      "开启 JS 工具执行？",
      "JS 工具会在本机的一段受限沙箱里运行写好的代码。模型可以决定传给它的参数，" +
      "被诱导的工具调用可能把参数变成攻击面。只在确有需要时开启，代码只放自己审查过的。",
      () => run("gate", extensionsApi.setScriptGate(true, true), "JS 工具执行许可已开启。"),
    );
  };

  const importManifest = (manifest: unknown): void => {
    run("import", extensionsApi.importExtension(manifest), "清单已导入，打开开关让它生效。");
    setImportOpen(false);
    setPaste("");
  };

  const onPickFile = (file: File | undefined): void => {
    if (file === undefined) return;
    file.text()
      .then((text) => JSON.parse(text) as unknown)
      .then((manifest) => {
        // busy 只交给 run 管：这里再 setBusy("") 会在请求在飞时把按钮提前放开。
        run("import", extensionsApi.importExtension(manifest), "清单已导入，打开开关让它生效。");
        setImportOpen(false);
        setPaste("");
      })
      .catch(fail)
      .finally(() => {
        if (fileRef.current) fileRef.current.value = "";
      });
  };

  const importPasted = (): void => {
    if (paste.trim() === "") { setErr("先粘贴一份清单 JSON，或选择文件导入。"); return; }
    let manifest: unknown;
    try { manifest = JSON.parse(paste) as unknown; }
    catch { setErr("这段文本不是合法 JSON，检查括号和引号。"); return; }
    importManifest(manifest);
  };

  const saveDraft = (entry: ExtensionSnapshotEntry): void => {
    let parameters: unknown;
    try { parameters = JSON.parse(draft.parameters) as unknown; }
    catch { setErr("parameters 不是合法 JSON。"); return; }
    const name = draft.name.trim();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) {
      setErr("工具名要小写字母开头，只含小写字母 / 数字 / 下划线，最长 40 字。");
      return;
    }
    const handler = draft.kind === "webhook"
      ? { kind: "webhook", url: draft.url.trim(), headers: {} as Record<string, string>, timeoutMs: 15_000 }
      : { kind: "script", code: draft.code, timeoutMs: 10_000 };
    const tool = { name, description: draft.description.trim(), parameters, handler };
    run(`tool:${entry.id}`, extensionsApi.saveExtensionTool(entry.id, tool), `工具「${name}」已保存；扩展已启用时下一轮对话即生效。`);
    setDraftFor(null);
    setDraft(EMPTY_DRAFT);
  };

  const deleteTool = (entry: ExtensionSnapshotEntry, short: string): void => {
    ask(`删掉工具「${short}」？`, "这只手会从清单里摘掉；扩展本身和其它工具不受影响。", () => {
      run(`del:${entry.id}:${short}`, extensionsApi.deleteExtensionTool(entry.id, short), `工具「${short}」已删除。`);
    });
  };

  const extensions = snapshot?.extensions ?? [];
  const enabledCount = extensions.filter((e) => stateOf(e).on).length;
  const toolCount = extensions.reduce((n, e) => n + e.tools.length, 0);
  const diagCount = extensions.reduce((n, e) => n + e.diagnostics.length, 0);

  return (
    <div className="tw-board" id="settings-extensions">
      <div className="tw-board-head">
        <div className="tw-board-head-copy">
          <h2>扩展</h2>
          <p>通过一份清单接入 MCP 服务或自定义工具。启用、停用与删除都即时生效，改完下一轮对话就能看见。</p>
        </div>
        <div className="tw-board-head-aside">
          <button type="button" className="btn sm" onClick={onRefresh} disabled={busy !== ""}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button type="button" className="primary sm" onClick={() => fileRef.current?.click()} disabled={busy !== ""}>
            <Upload size={13} /> {busy === "import" ? "导入中…" : "导入清单"}
          </button>
        </div>
      </div>

      <div className="tw-metrics">
        <div className="tw-metric"><span className="tw-metric-label">已登记</span><span className="tw-metric-value">{extensions.length}</span><span className="tw-metric-hint">份扩展清单</span></div>
        <div className="tw-metric"><span className="tw-metric-label">已启用</span><span className="tw-metric-value">{enabledCount}</span><span className="tw-metric-hint">工具对模型可见</span></div>
        <div className="tw-metric"><span className="tw-metric-label">工具总数</span><span className="tw-metric-value">{toolCount}</span><span className="tw-metric-hint">含 MCP 目录</span></div>
        <div className={"tw-metric " + (diagCount > 0 ? "is-bad" : "")}>
          <span className="tw-metric-label">待处理诊断</span><span className="tw-metric-value">{diagCount}</span><span className="tw-metric-hint">安全与连接提示</span>
        </div>
      </div>

      {err !== "" && <div className="ext-banner is-bad" role="alert"><span>{err}</span></div>}
      {note !== "" && <div className="ext-banner is-ok" role="status"><span>{note}</span></div>}

      <div className="tw-panel">
        <div className="tw-panel-head">
          <h3>安全边界</h3>
          <span className="tw-panel-note">外部服务会收到工具调用的参数；只导入可信来源的清单。</span>
        </div>
        <Switch
          checked={snapshot?.allowScripts === true}
          disabled={snapshot === null || busy !== ""}
          onChange={toggleScriptGate}
          tone="danger"
          label="允许执行 JS 工具"
          hint="默认关闭。开启后，模型可以调用经过沙箱限制的本机脚本；只允许自己审查过的代码。"
        />
      </div>

      <div className="ext-toolbar">
        <button type="button" className="btn sm" onClick={() => setImportOpen((v) => !v)}>
          {importOpen ? <X size={13} /> : <FileJson size={13} />}
          {importOpen ? "收起粘贴导入" : "粘贴清单 JSON"}
        </button>
        <span className="ext-drop-hint">也可以直接把 .json 文件拖进下面的输入框</span>
      </div>

      {importOpen && (
        <div className="ext-import">
          <div className="ext-import-head">
            <b>粘贴或拖入 xiaomo-extension.json</b>
            <span>校验在后端，格式不对会给出一句人话原因。</span>
          </div>
          <textarea
            value={paste}
            spellCheck={false}
            placeholder={SAMPLE_MANIFEST}
            aria-label="扩展清单 JSON"
            onChange={(e) => setPaste(e.target.value)}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file !== undefined) void file.text().then(setPaste);
            }}
            onDragOver={(e) => e.preventDefault()}
          />
          <div className="ext-import-actions">
            <button type="button" className="primary sm" onClick={importPasted} disabled={busy !== ""}>导入这段清单</button>
            <button type="button" className="btn sm" onClick={() => setPaste(SAMPLE_MANIFEST)}>填入样本</button>
          </div>
        </div>
      )}

      <input ref={fileRef} type="file" accept=".json,application/json" hidden
        onChange={(e) => onPickFile(e.target.files?.[0])} />

      {snapshot === null ? (
        <div className="ext-empty"><b>正在读取扩展列表…</b><span>第一次打开会向本机后端取一次清单快照。</span></div>
      ) : extensions.length === 0 ? (
        <div className="ext-empty">
          <b>还没有扩展</b>
          <span>导入一份清单后即可启用。MCP 服务会在启用时自动拉取工具目录；Webhook 与 JS 工具由清单自带。</span>
          <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>选择清单文件</button>
        </div>
      ) : (
        <div className="ext-cards">
          {extensions.map((entry) => {
            const st = stateOf(entry);
            const drafting = draftFor === entry.id;
            return (
              <div className={"ext-card " + (st.tone === "is-bad" ? "is-bad" : "")} key={entry.id}>
                <div className="ext-card-head">
                  <div className="ext-card-title">
                    <h4 title={entry.name}>{entry.name}</h4>
                    <span className="ext-id">{entry.id}</span>
                  </div>
                  <span className="ext-version">v{entry.version}</span>
                  <span className={"tw-badge " + st.tone}>{st.label}</span>
                </div>

                {entry.description !== "" && <p className="ext-card-desc">{entry.description}</p>}

                {entry.diagnostics.length > 0 && (
                  <div className="ext-diags">
                    {entry.diagnostics.map((d, i) => (
                      <div className={"ext-diag is-" + d.level} key={i} role={d.level === "error" ? "alert" : undefined}>
                        <span>{d.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="ext-section-label">
                  <span>工具 · {entry.tools.length}</span>
                  <button type="button" className="tw-link"
                    onClick={() => { setDraftFor(drafting ? null : entry.id); setDraft(EMPTY_DRAFT); }}>
                    {drafting ? "收起" : "+ 添加工具"}
                  </button>
                </div>

                {entry.tools.length === 0 ? (
                  <div className="ext-tools-empty">还没有工具。启用 MCP 后点「连接测试」拉取目录，或在上面添加自定义工具。</div>
                ) : (
                  <div className="ext-tools">
                    {entry.tools.map((tool) => {
                      const short = editableShortName(entry, tool.name, tool.kind);
                      return (
                        <div className="ext-tool" key={tool.name}>
                          <span className={"ext-tool-kind " + (tool.kind === "script" ? "is-script" : tool.kind === "webhook" ? "is-webhook" : "")}>
                            {KIND_LABEL[tool.kind] ?? tool.kind}
                          </span>
                          <div className="ext-tool-body">
                            <span className="ext-tool-name">{tool.name}</span>
                            {tool.description !== "" && <span className="ext-tool-desc" title={tool.description}>{tool.description}</span>}
                          </div>
                          {short !== null && (
                            <button type="button" className="ext-tool-del" title={`删除工具「${short}」`}
                              aria-label={`删除工具「${short}」`} onClick={() => deleteTool(entry, short)} disabled={busy !== ""}>
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {drafting && (
                  <div className="ext-form">
                    <div className="ext-field">
                      <label htmlFor={`ext-tool-name-${entry.id}`}>工具名（小写字母开头）</label>
                      <input id={`ext-tool-name-${entry.id}`} value={draft.name} placeholder="get_weather"
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    </div>
                    <div className="ext-field">
                      <label htmlFor={`ext-tool-desc-${entry.id}`}>用法说明（给模型看，必填）</label>
                      <input id={`ext-tool-desc-${entry.id}`} value={draft.description} placeholder="查某个城市的当前天气"
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    </div>
                    <div className="ext-field">
                      <label htmlFor={`ext-tool-kind-${entry.id}`}>执行方式</label>
                      <select id={`ext-tool-kind-${entry.id}`} value={draft.kind}
                        onChange={(e) => setDraft({ ...draft, kind: e.target.value as ToolDraft["kind"] })}>
                        <option value="webhook">Webhook（POST 到一个 URL）</option>
                        <option value="script">JS（本机沙箱，需先开许可）</option>
                      </select>
                    </div>
                    {draft.kind === "webhook" ? (
                      <div className="ext-field">
                        <label htmlFor={`ext-tool-url-${entry.id}`}>URL（https，或本机 / 局域网 http）</label>
                        <input id={`ext-tool-url-${entry.id}`} value={draft.url} placeholder="http://127.0.0.1:9000/run"
                          onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
                      </div>
                    ) : (
                      <div className="ext-field">
                        <label htmlFor={`ext-tool-code-${entry.id}`}>JS 代码（求值结果要是一个函数）</label>
                        <textarea id={`ext-tool-code-${entry.id}`} value={draft.code}
                          onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                      </div>
                    )}
                    <div className="ext-field">
                      <label htmlFor={`ext-tool-schema-${entry.id}`}>parameters（JSON Schema，type 必须是 object）</label>
                      <textarea id={`ext-tool-schema-${entry.id}`} value={draft.parameters}
                        onChange={(e) => setDraft({ ...draft, parameters: e.target.value })} />
                    </div>
                    <div className="ext-form-actions">
                      <button type="button" className="primary sm" onClick={() => saveDraft(entry)} disabled={busy !== ""}>
                        <Plus size={13} /> 保存工具
                      </button>
                      <button type="button" className="btn sm" onClick={() => { setDraftFor(null); setDraft(EMPTY_DRAFT); }}>取消</button>
                    </div>
                  </div>
                )}

                <div className="ext-card-foot">
                  <Switch checked={entry.enabled} disabled={busy !== ""} onChange={(next) => toggle(entry, next)} label="启用" />
                  <div className="ext-card-acts">
                    <button type="button" className="btn sm" onClick={() => probe(entry)} disabled={busy !== ""}>
                      <RefreshCw size={13} /> {busy === entry.id ? "连接中…" : "连接测试"}
                    </button>
                    <button type="button" className="btn sm ghost" onClick={() => remove(entry)} disabled={busy !== ""}>
                      <Trash2 size={13} /> 删除
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <details className="ext-template">
        <summary>清单怎么写</summary>
        <div className="ext-template-body">
          <pre>{SAMPLE_MANIFEST}</pre>
          <div className="ext-template-note">
            <b>mcp</b> 与 <b>tools</b> 至少要有其一。mcp 只收 https（本机回环可用 http）；
            tools 里每个工具要 name、description（给模型看的用法说明，500 字内）、
            parameters（JSON Schema，type 必须是 object），handler 用
            <b> webhook</b>（url / headers / timeoutMs）或 <b>script</b>（code 写成一个箭头函数）。
          </div>
          <div className="ext-template-note">
            密钥放 headers，不要拼进 URL——URL 会原样留在清单里，并随每一轮请求外发。
          </div>
        </div>
      </details>
    </div>
  );
}
