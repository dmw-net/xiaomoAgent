// 设置页「扩展」分区：外挂能力的登记与插拔。
//
// 三类工具从这里进模型的手：
//   mcp     — 清单里连一个 MCP 服务，工具目录由对方下发（probe 后可见）
//   webhook — 清单里自带的自定义工具，调用时把参数 POST 给一个 URL
//   script  — 同样自带，但执行的是一段 JS；整个类别被「脚本许可」锁着，默认关
//
// 界面纪律：风险说在明处。MCP 卡片带「数据会发给第三方」的横幅；URL 内嵌密钥、
// 明文 http 这些诊断是后端逐条给的人话，这里原样摊出来，不翻译不打折。
// 脚本许可和删除扩展都走居中确认弹窗（与应用内其它危险操作同一套）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import * as extensionsApi from "../../api/extensions";
import type { ExtensionSnapshot, ExtensionSnapshotEntry } from "../../types";

const KIND_LABEL: Record<string, string> = { mcp: "MCP", webhook: "Webhook", script: "JS" };

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

const stateOf = (e: ExtensionSnapshotEntry): { label: string; on: boolean } => {
  const blocked = e.diagnostics.some((d) => d.level === "error");
  if (blocked) return { label: "有问题", on: false };
  return e.enabled ? { label: "已启用", on: true } : { label: "已停用", on: false };
};

export default function ExtensionSection({ ask }: {
  ask: (title: string, note: string, run: () => void) => void;
}): JSX.Element {
  const [data, setData] = useState<ExtensionSnapshot | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const fail = (e: unknown): void => {
    setNote("");
    setErr(e instanceof Error ? e.message : String(e));
  };

  const apply = (next: ExtensionSnapshot): void => {
    setData(next);
    setErr("");
  };

  const load = useCallback((): void => {
    setBusy("load");
    extensionsApi.listExtensions()
      .then(apply)
      .catch(fail)
      .finally(() => setBusy(""));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (entry: ExtensionSnapshotEntry, enabled: boolean): void => {
    setBusy(entry.id);
    setErr("");
    extensionsApi.setExtensionEnabled(entry.id, enabled)
      .then((r) => {
        apply(r);
        const probeErr = r.extensions.find((x) => x.id === entry.id)?.diagnostics.find((d) => d.level === "error");
        // 开启失败不回滚开关：服务可能只是暂时不可达，关掉重来就是了。但要把话说全。
        if (enabled && probeErr) setErr(probeErr.message);
        else if (enabled) setNote(`「${entry.name}」已启用，工具目录已就绪。`);
        else setNote(`「${entry.name}」已停用。`);
      })
      .catch(fail)
      .finally(() => setBusy(""));
  };

  const probe = (entry: ExtensionSnapshotEntry): void => {
    setBusy(entry.id);
    setErr("");
    extensionsApi.probeExtension(entry.id)
      .then((r) => {
        apply(r);
        const probed = r.extensions.find((x) => x.id === entry.id);
        const probeErr = probed?.diagnostics.find((d) => d.level === "error");
        if (probeErr) setErr(probeErr.message);
        else setNote(`「${entry.name}」连接正常，发现 ${probed?.tools.filter((t) => t.kind === "mcp").length ?? 0} 个 MCP 工具。`);
      })
      .catch(fail)
      .finally(() => setBusy(""));
  };

  const remove = (entry: ExtensionSnapshotEntry): void => {
    ask(`删掉「${entry.name}」？`, "扩展连同它的全部工具一起摘除，找不回来。要换新版本重新导入即可。", () => {
      setBusy(entry.id);
      setErr("");
      extensionsApi.removeExtension(entry.id, true)
        .then((r) => { apply(r); setNote(`「${entry.name}」已经删掉了。`); })
        .catch(fail)
        .finally(() => setBusy(""));
    });
  };

  const toggleScriptGate = (): void => {
    if (data === null) return;
    if (data.allowScripts) {
      setBusy("gate");
      extensionsApi.setScriptGate(true, false).then(apply).catch(fail).finally(() => setBusy(""));
      return;
    }
    ask(
      "开启 JS 工具执行？",
      "JS 工具会在本机的一段受限沙箱里运行你写的代码。模型可以决定传给它的参数，" +
      "被诱导的工具调用可能把参数变成攻击面。只在确有需要时开启，代码只放你自己写的。",
      () => {
        setBusy("gate");
        extensionsApi.setScriptGate(true, true).then(apply).catch(fail).finally(() => setBusy(""));
      },
    );
  };

  const onPickFile = (file: File | undefined): void => {
    if (file === undefined) return;
    setBusy("import");
    setErr("");
    file.text()
      .then((text) => JSON.parse(text) as unknown)
      .then((manifest) => extensionsApi.importExtension(manifest))
      .then((r) => { apply(r); setNote("清单已导入，打开开关让它生效。"); })
      .catch(fail)
      .finally(() => {
        setBusy("");
        if (fileRef.current) fileRef.current.value = "";
      });
  };

  const extensions = data?.extensions ?? [];

  return (
    <div className="section extension-section" id="settings-extensions">
      <h2>扩展</h2>
      <div className="desc">
        通过清单接入 MCP 或 Webhook 工具。启用、停用与删除都即时生效。
      </div>
      <div className="settings-overview-strip">
        <span><b>{extensions.length}</b> 个扩展</span>
        <span>{extensions.filter((x) => stateOf(x).on).length} 个已启用</span>
      </div>

      {err && (
        <div className="banner show bad" role="alert"><div className="body">{err}</div></div>
      )}
      {note !== "" && (
        <div className="banner show ok" role="status"><div className="body">{note}</div></div>
      )}

      <div className="card card-pad extension-import">
        <div className="subhead">导入扩展</div>
        <div className="hint">
          选择一份 <b>xiaomo-extension.json</b>。启用 MCP 后，与工具调用相关的数据会发送给该服务，只导入可信来源。
        </div>
        <div className="actions">
          <button type="button" className="primary sm" disabled={busy !== ""}
            onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> {busy === "import" ? "导入中…" : "选择清单文件"}
          </button>
          <button type="button" className="btn sm" onClick={load} disabled={busy !== ""}>
            <RefreshCw size={13} /> {busy === "load" ? "读取中…" : "刷新"}
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => onPickFile(e.target.files?.[0])} />
      </div>

      {data !== null && (
        <div className="card card-pad">
          <div className="subhead">JS 工具执行许可</div>
          <div className="hint">默认关闭。开启后，模型可以调用经过沙箱限制的本机脚本；只允许自己审查过的代码。
          </div>
          <div className="preset-row cap-pro-row">
            <label className="cap-enable">
              <input type="checkbox" checked={data.allowScripts} disabled={busy !== ""}
                onChange={toggleScriptGate} />
              允许执行 JS 工具
            </label>
          </div>
        </div>
      )}

      {data === null ? (
        <div className="empty">正在读取扩展列表…</div>
      ) : extensions.length === 0 ? (
        <div className="empty">还没有扩展。选择一份清单文件导入后即可启用。</div>
      ) : (
        <div className="settings-list-scroll extension-list">
        {extensions.map((entry) => {
        const st = stateOf(entry);
        return (
          <div className="skill-item extension-item" key={entry.id}>
            <div className="cap-head">
              <div>
                <div className="subhead">{entry.name} <span className="hint">v{entry.version}</span></div>
                {entry.description !== "" && <div className="hint">{entry.description}</div>}
              </div>
              <span className={"cap-state " + (st.on ? "on" : "off")}>{st.label}</span>
            </div>

            {entry.diagnostics.length > 0 && (
              <div className="hint">
                {entry.diagnostics.map((d, i) => (
                  <div key={i} className={d.level === "error" ? "bad" : undefined}>· {d.message}</div>
                ))}
              </div>
            )}

            {entry.tools.length > 0 && (
              <div className="hint">
                {entry.tools.map((t) => (
                  <div key={t.name}>· [{KIND_LABEL[t.kind] ?? t.kind}] {t.name}</div>
                ))}
              </div>
            )}

            <div className="preset-row cap-pro-row">
              <label className="cap-enable">
                <input type="checkbox" checked={entry.enabled} disabled={busy !== ""}
                  onChange={(e) => toggle(entry, e.target.checked)} />
                启用
              </label>
              <div className="skill-acts">
                {entry.tools.some((t) => t.kind === "mcp") && (
                  <button type="button" className="btn sm" onClick={() => probe(entry)} disabled={busy !== ""}>
                    <RefreshCw size={13} /> {busy === entry.id ? "连接中…" : "连接测试"}
                  </button>
                )}
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

      <details className="card card-pad extension-template">
        <summary className="subhead">清单怎么写</summary>
        <div className="preview show"><pre>{SAMPLE_MANIFEST}</pre></div>
        <div className="hint">
          <b>mcp</b> 与 <b>tools</b> 至少要有其一。mcp 只收 https（本机回环可用 http）；
          tools 里每个工具要 name、description（给模型看的用法说明，500 字内）、
          parameters（JSON Schema，type 必须是 object），handler 用
          <b> webhook</b>（url/headers/timeoutMs）或 <b>script</b>（code 写成一个箭头函数）。
        </div>
        <div className="hint">
          <Plus size={12} /> 密钥放 headers，不要拼进 URL——URL 会原样留在清单里。
        </div>
      </details>
    </div>
  );
}

