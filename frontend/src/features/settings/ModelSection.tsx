import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, FileDown, FileUp, Loader2, Pencil, Play, Plus, Zap, Trash2, X } from "lucide-react";
import Modal from "../../components/Modal";
import { settingsApi } from "../../api";
import { useDismiss } from "../../hooks/useDismiss";
import { CHAT_PRESETS, CAPABILITY_GROUPS } from "./presets";
import { groupByProvider, normBase, type ProviderGroup } from "../../lib/providers";
import { SETTINGS_CHANGED_EVENT } from "../../lib/ui-prefs";
import {
  buildModelConfig, downloadModelConfig, planImport, parseModelConfig, runImport,
  type ImportPlan, type ModelConfigFile,
} from "../../lib/model-config";
import type { ModelCaps, ProfileItem, ThinkingModeId, ThinkingParamId } from "../../types";
import type { SettingsForm } from "./useSettingsForm";

/** 添加/编辑面板的本地表单。密钥直接回填已保存的真实值（本机应用），眼睛按钮可明文查看。 */
type Draft = {
  id: string | null;
  label: string;
  baseUrl: string;
  key: string;
  name: string;
  timeout: string;
  extra: string;
  caps: ModelCaps;
  thinkingLevel: string;
  thinkingLevels: string[];
  /** 思考参数形态，取值语义见后端 ThinkingParam。 */
  thinkingParam: ThinkingParamId;
  /** 开关系形态（templateKw / thinkingType）的显式意图："" 跟随模型 / "on" 开 / "off" 关。 */
  thinkingMode: ThinkingModeId;
  maxInput: string;
  maxOutput: string;
  /** 往已有的一家下面加模型：true 时不问名字（档名=模型名），也不该再让人起名。 */
  underProvider: boolean;
};

const NO_CAPS: ModelCaps = {
  tools: false, vision: false, thinking: false,
  thinkingOnly: false, customProtocol: false,
};

const emptyDraft = (): Draft => ({
  id: null, label: "", baseUrl: "", key: "", name: "", timeout: "90000", extra: "",
  caps: { ...NO_CAPS }, thinkingLevel: "", thinkingLevels: [], thinkingParam: "effort", thinkingMode: "",
  maxInput: "", maxOutput: "", underProvider: false,
});

const CAP_DEFS: Array<{ key: keyof ModelCaps; label: string }> = [
  { key: "tools", label: "工具调用" },
  { key: "vision", label: "图片输入" },
  { key: "thinking", label: "思考模式" },
  { key: "thinkingOnly", label: "仅思考模式" },
  { key: "customProtocol", label: "自定义协议" },
];

/** 开关系形态（模板系 / 火山系）的三个取值；"" 表示一个字段都不发。 */
const THINKING_MODE_CHIPS: Array<{ id: ThinkingModeId; label: string }> = [
  { id: "", label: "跟随模型" },
  { id: "on", label: "开" },
  { id: "off", label: "关" },
];

/** 三种形态各自往请求体里塞什么——写明白，别让人猜字段名。 */
const THINKING_PARAM_DEFS: Array<{ id: Draft["thinkingParam"]; label: string; hint: string }> = [
  { id: "effort", label: "reasoning_effort（带强度）",
    hint: "只有强度、没有开关，发不发由上面的「思考模式」决定。" },
  { id: "templateKw", label: "chat_template_kwargs（开关）",
    hint: "开关式，没有强度可调。" },
  { id: "thinkingType", label: "thinking:{type}（火山方舟）",
    hint: "火山方舟用；豆包、GLM 这类默认就在思考的模型选它才关得掉。" },
];

const THINKING_DEFS: Array<{ id: string; label: string }> = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "超高" },
  { id: "max", label: "极致" },
];

const INPUT_LIMIT_CHIPS = [{ label: "64K", tokens: 65_536 }, { label: "128K", tokens: 131_072 }, { label: "256K", tokens: 262_144 }, { label: "512K", tokens: 524_288 }, { label: "1M", tokens: 1_048_576 }];
const OUTPUT_LIMIT_CHIPS = [{ label: "8K", tokens: 8_192 }, { label: "16K", tokens: 16_384 }, { label: "32K", tokens: 32_768 }, { label: "64K", tokens: 65_536 }];

/** 列表行的小徽标：只展示勾了的能力，一眼看出这套配置会什么。 */
function CapsTags({ caps }: { caps: ModelCaps | undefined }): JSX.Element | null {
  if (!caps) return null;
  const tags = CAP_DEFS.filter((c) => caps[c.key]).map((c) => c.label);
  if (tags.length === 0) return null;
  return (
    <span className="ml-tags">
      {tags.map((t) => <span key={t} className="ml-tag">{t}</span>)}
    </span>
  );
}

/** 摘要里要印卡片上的中文名，不是 imageVision 这种键名。 */
const CAP_TITLES: Record<string, string> = Object.fromEntries(CAPABILITY_GROUPS.map((g) => [g.name, g.title]));

/** 分区①：模型接入。列表管理多套模型（添加/编辑/应用/删除），演示模式开关兜底。 */
/** 导出 / 导入那条小流程的界面状态。 */
type IoState =
  | { step: "export"; withKeys: boolean }
  | { step: "import"; file: ModelConfigFile; plan: ImportPlan; running?: boolean };

export default function ModelSection({ form, revealAdvanced }: { form: SettingsForm; revealAdvanced?: boolean }): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showKey, setShowKey] = useState(false);
  // 弹窗：点遮罩外部或按 Esc 关闭（表单本体标了 data-keep-menu）
  useDismiss(draft !== null, () => setDraft(null));
  const m = form.saved?.model;
  const echoOn = m?.mode === "echo";
  const profiles = form.saved?.profiles ?? [];
  const activeLabel = profiles.find((p) => p.id === form.saved?.activeProfileId)?.label ?? m?.name ?? "";

  const set = (patch: Partial<Draft>): void => setDraft((d) => (d ? { ...d, ...patch } : d));

  // ── 模型配置导出 / 导入 ────────────────────────────────
  const [io, setIo] = useState<IoState | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  const snap = form.saved;
  // 导出预览算的是"这一份文件会长什么样"，勾选变化就要重算（8 份档，代价可忽略）
  const exportPreview = snap ? buildModelConfig(snap, io?.step === "export" && io.withKeys) : null;

  // 导入摘要分两类：往卡上补端点档 / 把挂主模型档的那张卡指到某份档（写法不同，别说成"补档"）
  const capPlan = io?.step === "import" ? io.plan.caps.filter((c) => c.refLabel === undefined) : [];
  const refPlan = io?.step === "import" ? io.plan.caps.filter((c) => c.refLabel !== undefined) : [];

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !snap) return;
    try {
      const file = parseModelConfig(await f.text());
      setIo({ step: "import", file, plan: planImport(file, snap) });
    } catch (err: unknown) {
      form.setModelBanner({ kind: "bad", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const doExport = (): void => {
    if (!exportPreview) return;
    downloadModelConfig(exportPreview.file);
    setIo(null);
    const n = exportPreview.file.profiles.length;
    form.setModelBanner({
      kind: "ok",
      text: exportPreview.file.hasKeys
        ? `已导出 ${n} 个模型，含密钥——这份文件别外发、别上传。`
        : `已导出 ${n} 个模型，没带密钥（导入后逐个补上）。`,
    });
  };

  const doImport = async (): Promise<void> => {
    if (!snap || io?.step !== "import") return;
    setIo({ ...io, running: true });
    const r = await runImport(io.file, snap);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
    const bits = [
      r.added > 0 ? `新增 ${r.added} 个` : "没有新的",
      r.skipped > 0 ? `跳过 ${r.skipped} 个重复` : "",
      r.failed.length > 0 ? `${r.failed.length} 个失败：${r.failed.map((x) => `${x.label}（${x.error}）`).join("；")}` : "",
    ].filter(Boolean);
    setIo(null);
    form.setModelBanner({ kind: r.failed.length > 0 ? "bad" : "ok", text: "导入完成：" + bits.join(" · ") });
  };

  const [advOpen, setAdvOpen] = useState(false);
  const advHasData = draft !== null
    && (draft.caps.tools || draft.caps.vision || draft.caps.thinking || draft.maxOutput !== "");
  useEffect(() => {
    if (revealAdvanced === true || advHasData) setAdvOpen(true);
  }, [revealAdvanced, advHasData]);

  const openAdd = (seed?: { baseUrl: string; key: string; underProvider?: boolean }): void => {
    form.setModelBanner(null);
    setShowKey(false);
    setDraft({
      ...emptyDraft(),
      ...(seed?.baseUrl ? { baseUrl: seed.baseUrl } : {}),
      ...(seed?.key ? { key: seed.key } : {}),
      ...(seed?.underProvider ? { underProvider: true } : {}),
    });
  };

  const openEdit = (id: string): void => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    form.setModelBanner(null);
    setShowKey(false);
    setDraft({
      id,
      label: p.label,
      baseUrl: p.baseUrl ?? "",
      key: p.apiKey ?? "",
      name: p.name ?? "",
      timeout: String(p.timeoutMs ?? 90000),
      extra: p.extraBody && Object.keys(p.extraBody).length ? JSON.stringify(p.extraBody) : "",
      caps: { ...NO_CAPS, ...(p.caps ?? {}) },
      thinkingLevel: p.thinkingLevel ?? "",
      thinkingLevels: p.thinkingLevels ?? [],
      thinkingParam: p.thinkingParam ?? "effort",
      thinkingMode: p.thinkingMode ?? "",
      maxInput: p.maxInputTokens ? String(p.maxInputTokens) : "",
      maxOutput: p.maxOutputTokens ? String(p.maxOutputTokens) : "",
      underProvider: false,
    });
  };

  // 从上下文圆环点「去设置」过来：直接把正在生效的那档打开。
  // 停在列表页等于把人领到门口又让他自己找门——高级参数还藏在折叠区里。
  const revealConsumed = useRef(false);
  useEffect(() => {
    if (revealAdvanced !== true || revealConsumed.current) return;
    const active = form.saved?.activeProfileId ?? "";
    if (active === "") return;
    revealConsumed.current = true;
    openEdit(active);
  }, [revealAdvanced, form.saved]);

  const save = (): void => {
    if (!draft) return;
    // 往已有的一家下面加模型：不需要名字，档名就等于模型名（供应商名在右栏那一栏管）。
    // 新建一家才问名字，问到的就是这家的显示名（providerLabel 会退回用第一份档的名字）。
    const label = draft.underProvider ? draft.name.trim() : draft.label.trim();
    if (label === "") {
      form.setModelBanner({ kind: "bad", text: draft.underProvider ? "模型名不能为空" : "给这一家起个名字" });
      return;
    }
    if (draft.baseUrl.trim() === "") { form.setModelBanner({ kind: "bad", text: "接口地址不能为空" }); return; }
    if (draft.name.trim() === "") { form.setModelBanner({ kind: "bad", text: "模型名不能为空" }); return; }
    if (draft.id === null && draft.key.trim() === "") {
      form.setModelBanner({ kind: "bad", text: "新增模型需要填 API Key（本地 Ollama 可随便填一串占位）" });
      return;
    }
    form.saveModelProfile({
      id: draft.id, label, baseUrl: draft.baseUrl,
      key: draft.key, name: draft.name, timeoutMs: draft.timeout, extraBody: draft.extra,
      caps: draft.caps, thinkingLevel: draft.thinkingLevel, thinkingLevels: draft.thinkingLevels,
        thinkingParam: draft.thinkingParam, thinkingMode: draft.thinkingMode,
      maxInput: draft.maxInput, maxOutput: draft.maxOutput,
    });
    setDraft(null);
  };

  const toggleLevel = (id: string): void => {
    if (!draft) return;
    set({
      thinkingLevels: draft.thinkingLevels.includes(id)
        ? draft.thinkingLevels.filter((x) => x !== id)
        : [...draft.thinkingLevels, id],
    });
  };

  // ── 供应商这一层 ──────────────────────────────────────
  // 后端不存供应商实体：同一批档里接口地址相同的就是同一家（见 settings.ts 那段注释）。
  // 所以这里只是把档按 baseUrl 归组，外加一张"这家叫什么"的名字表。
  const names = form.saved?.providerNames ?? {};
  const groups = groupByProvider(profiles, names);
  const activeBase = normBase(profiles.find((p) => p.id === form.saved?.activeProfileId)?.baseUrl);
  const [sel, setSel] = useState("");
  // 选中的那家被删掉或改了地址就自动跟上去：宁可显示别家，也不要停在一个不存在的地址上
  const shown = groups.some((g) => g.baseUrl === sel) ? sel : (activeBase || groups[0]?.baseUrl || "");
  const group = groups.find((g) => g.baseUrl === shown) ?? null;
  const baseKey = group?.models.find((m) => (m.apiKey ?? "") !== "")?.apiKey ?? "";
  const [provRaw, setProvRaw] = useState<{ from: string; url: string; key: string; label: string } | null>(null);
  const [provBusy, setProvBusy] = useState(false);
  const [showProvKey, setShowProvKey] = useState(false);
  // 窄屏不横滑供应商列表（手机上滑十行很难点准），改成一个自绘的下拉菜单。
  // 不用原生 select：它的弹层不吃主题，暗色下是系统那块浅蓝补丁（见 legacy.css 那条注释）。
  const [dropOpen, setDropOpen] = useState(false);
  // 判定全在 useDismiss：它听 pointerdown，打开那一发的按下比监听器存在更早，
  // 不会"点开即关"，所以这里不需要任何时间宽限。
  useDismiss(dropOpen, () => setDropOpen(false));
  // 换一家就重新取一次现值；在同一家里编辑中的内容不会被后台快照刷新冲掉
  const d = provRaw?.from === shown ? provRaw : { from: shown, url: shown, key: baseKey, label: group?.label ?? "" };
  const provDirty = group !== null && (d.url !== group.baseUrl || d.key !== baseKey || d.label !== group.label);

  const saveProvider = async (): Promise<void> => {
    if (!group) return;
    setProvBusy(true);
    const bits: string[] = [];
    try {
      const label = d.label.trim();
      if (label !== "" && label !== group.label) {
        const r = await settingsApi.provider({ op: "rename", baseUrl: group.baseUrl, label });
        form.applySnapshot(r);
        bits.push(`这一家改叫「${label}」`);
      }
      const url = normBase(d.url);
      if (url !== group.baseUrl || d.key !== baseKey) {
        const r = await settingsApi.provider({ op: "sync", baseUrl: group.baseUrl, toBaseUrl: url, apiKey: d.key });
        form.applySnapshot(r);
        setSel(url);
        setProvRaw(null);
        bits.push(r.note ?? `已同步给这 ${group.models.length} 个模型`);
      }
      form.setModelBanner({ kind: "ok", text: bits.length > 0 ? "供应商已更新：" + bits.join("，") : "没有需要保存的改动" });
    } catch (e: unknown) {
      form.setModelBanner({ kind: "bad", text: e instanceof Error ? e.message : String(e) });
    }
    setProvBusy(false);
  };

  /** 上下文上限做成「512K / 1M」那种短标签：一长串数字没人读得下去。 */
  const fmtCtx = (n: number | undefined): string =>
    n && n > 0 ? (n >= 1_000_000 ? Math.round(n / 1_000_000) + "M" : Math.round(n / 1024) + "K") : "";

  /** 一家下面的一个模型档。地址不重复写——整组共用同一个地址，它在供应商那一栏。 */
  const modelRow = (p: typeof profiles[number]): JSX.Element => {
    const activeRow = p.id === form.saved?.activeProfileId;
    const testing = form.busy === "test:" + p.id;
    const result = form.profileTestResult[p.id];
    return (
      <div key={p.id} className={"ml-row" + (activeRow ? " active" : "")}>
        <div className="ml-info">
          <div className="ml-name">{p.name || "未填模型名"}<CapsTags caps={p.caps} />{fmtCtx(p.maxInputTokens) !== "" && <span className="ml-tags"><span className="ml-tag">{fmtCtx(p.maxInputTokens)}</span></span>}</div>
          <div className="ml-meta">{p.label}</div>
          {result && (
            <div className={"ml-test " + result.kind} title={result.text}>
              {result.kind === "ok" ? <Check size={12} style={{ verticalAlign: -2 }} /> : "✗"} {result.text}
            </div>
          )}
        </div>
        {activeRow && <span className="ml-badge">使用中</span>}
        <div className="ml-actions">
          <button type="button" className="ml-btn" title="测一下能不能用" aria-label="测试"
            disabled={testing || form.busy !== ""} onClick={() => form.testProfile(p.id)}>
            {testing ? <Loader2 size={15} className="spin" /> : <Zap size={15} />}
          </button>
          <button type="button" className="ml-btn" title="启用" aria-label="启用"
            disabled={activeRow || form.busy !== ""}
            onClick={() => form.applyProfile(p.id)}><Play size={15} /></button>
          <button type="button" className="ml-btn" title="编辑" aria-label="编辑"
            onClick={(e) => { e.stopPropagation(); openEdit(p.id); }}><Pencil size={15} /></button>
          <button type="button" className="ml-btn danger" title="删除" aria-label="删除"
            disabled={form.busy !== ""} onClick={() => form.deleteProfile(p.id, p.label)}><Trash2 size={15} /></button>
        </div>
      </div>
    );
  };

  /** 拉回来的模型名筛选用（清单是全量，不截断）。 */
  const [listQuery, setListQuery] = useState("");
  const lq = listQuery.trim().toLowerCase();
  // 前缀命中的排前面（输入 deepseek 时 deepseek-chat 该在 [官B]deepseek-… 之前），其余按名字排
  const modelShown = (form.modelList?.ids ?? [])
    .filter((id) => lq === "" || id.toLowerCase().includes(lq))
    .sort((a, b) => (a.toLowerCase().startsWith(lq) ? 0 : 1) - (b.toLowerCase().startsWith(lq) ? 0 : 1)
      || a.localeCompare(b));

  /** 一家一行。窄屏的下拉菜单和宽屏的侧栏共用这一个渲染函数，两处不会长得不一样。 */
  const provRow = (g: ProviderGroup<ProfileItem>): JSX.Element => (
    <button key={g.baseUrl || "（没填地址）"} type="button" aria-pressed={g.baseUrl === shown}
      className={"prov-row" + (g.baseUrl === shown ? " on" : "")}
      title={g.baseUrl || "这家没填接口地址"}
      onClick={() => { setSel(g.baseUrl); setProvRaw(null); setDropOpen(false); }}>
      <span className={"dot " + (g.hasKey ? "on" : "off")} />
      <span className="prov-name">{g.label || "（没起名字）"}</span>
      <span className="prov-count">{g.models.length} 个模型</span>
    </button>
  );

  return (
    <div className="section">
      <h2>主对话模型</h2>
      <div className="desc">这里存你接入的模型，一份一个，随时切换。加好后先点「测试连接」。</div>

      <div className="now" id="now">
        <span className={"dot " + (form.saved?.modelReady && !echoOn ? "on" : "off")} id="nowDot" />
        <span className="val" id="nowText">
          {echoOn ? "演示模式：不调用真实模型，只验证流程通不通"
            : form.saved?.modelReady
              ? <>全局默认：<b>{activeLabel}</b><span className="sep"> · </span>没单独指定模型的人都用它</>
              : "还没接入能用的模型，先添加并启用一个"}
        </span>
      </div>

      <div className="card card-pad model-list-card">
        <div className="ml-head">
          <div className="subhead">模型列表</div>
          <span className="spacer" />
          <button type="button" className="btn sm" id="btn-export-models" disabled={profiles.length === 0 || draft !== null}
            title="把全部模型存成一个备份文件（可选是否带密钥）" onClick={() => setIo({ step: "export", withKeys: false })}>
            <FileDown size={13} strokeWidth={2.0} style={{ verticalAlign: -2 }} /> 导出
          </button>
          <button type="button" className="btn sm" id="btn-import-models" disabled={draft !== null}
            title="从备份文件恢复（只新增，不动已有的）" onClick={() => pickRef.current?.click()}>
            <FileUp size={13} strokeWidth={2.0} style={{ verticalAlign: -2 }} /> 导入
          </button>
          <input ref={pickRef} type="file" accept=".json,application/json" hidden onChange={(e) => { void onPickFile(e); }} />
          <button type="button" className="primary sm" id="btn-add-model" disabled={draft !== null} onClick={(e) => { e.stopPropagation(); openAdd(); }}>
            <Plus size={13} strokeWidth={2.2} style={{ verticalAlign: -2 }} /> 添加供应商
          </button>
        </div>

        {profiles.length === 0 && draft === null && (
          <div className="ml-empty">还没有模型。点「添加供应商」接入 DeepSeek、火山方舟、通义等；同一家下面想再加一个，点右侧「添加模型」。</div>
        )}

        {groups.length > 0 && (
          <div className="prov-pane">
            <div className="prov-side" data-keep-menu>
              {/* 窄屏：一行下拉按钮 + 点开是竖向菜单；宽屏：菜单收掉，侧栏常显 */}
              <button type="button" className="prov-drop" id="btn-prov-drop" aria-expanded={dropOpen}
                onClick={() => setDropOpen((v) => !v)}>
                <span className="prov-name">{group?.label || "选一家供应商"}</span>
                <span className="prov-caret" aria-hidden="true">{dropOpen ? "▴" : "▾"}</span>
              </button>
              {dropOpen && <div className="prov-menu">{groups.map((g) => provRow(g))}</div>}
              <div className="prov-list">{groups.map((g) => provRow(g))}</div>
            </div>

            {group && (
              <div className="prov-detail">
                <div className="field">
                  <label htmlFor="prov-name">供应商名</label>
                  <input id="prov-name" maxLength={24} value={d.label} placeholder={shown.replace(/^https?:\/\//, "").split("/")[0]}
                    onChange={(e) => setProvRaw({ ...d, label: e.target.value })} />
                  <div className="hint">{group.named ? "这一家共用的名字。" : "还没起名字，现在显示的是它第一个模型的名字。"}</div>
                </div>
                <div className="field">
                  <label htmlFor="prov-url">接口地址（Base URL）</label>
                  <input id="prov-url" title="协议：OpenAI Chat Completions，地址填到 /v1 这一层" placeholder="https://api.deepseek.com/v1" value={d.url}
                    onChange={(e) => setProvRaw({ ...d, url: e.target.value })} />
                  <div className="hint">填服务商给的地址，一般到 <code>/v1</code> 为止。</div>
                </div>
                <div className="field">
                  <label htmlFor="prov-key">API 密钥</label>
                  <div className="key-wrap">
                    <input id="prov-key" type={showProvKey ? "text" : "password"} value={d.key} placeholder="sk-..."
                      onChange={(e) => setProvRaw({ ...d, key: e.target.value })} />
                    <button type="button" className="key-eye" aria-label={showProvKey ? "隐藏密钥" : "显示密钥"}
                      title={showProvKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowProvKey((v) => !v)}>
                      {showProvKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <div className="hint">改地址或密钥，这一家所有模型一起变；密钥留空就是不改。</div>
                </div>
                <div className="actions">
                  <button type="button" className="primary sm" id="btn-save-provider" disabled={!provDirty || provBusy || form.busy !== ""}
                    onClick={() => { void saveProvider(); }}>
                    {provBusy ? "保存中…" : `保存供应商${provDirty ? `（同步 ${group.models.length} 个模型）` : ""}`}
                  </button>
                </div>

                <div className="prov-models-head">
                  <div className="subhead">模型列表</div>
                  <button type="button" className="btn sm" id="btn-add-under-provider" disabled={draft !== null}
                    title="地址和密钥沿用这一家，只填模型名和它的参数"
                    onClick={(e) => { e.stopPropagation(); openAdd({ baseUrl: group.baseUrl, key: baseKey, underProvider: true }); }}>
                    <Plus size={13} strokeWidth={2.2} style={{ verticalAlign: -2 }} /> 添加模型
                  </button>
                </div>
                {group.models.map((p) => modelRow(p))}
              </div>
            )}
          </div>
        )}

        {draft !== null && (
          <Modal onClose={() => { setDraft(null); }}
            label={draft.id ? "编辑模型" : draft.underProvider ? "添加模型" : "添加供应商"} className="ml-form">
            <div className="ml-form-head">
              <div className="subhead">{draft.id ? "编辑模型" : draft.underProvider ? "添加模型" : "添加供应商"}</div>
              <button type="button" className="ml-btn" title="取消" aria-label="取消" onClick={() => setDraft(null)}><X size={15} /></button>
            </div>
            {!draft.underProvider && (
            <div className="preset-row">
              {CHAT_PRESETS.map((pr) => (
                <button key={pr.label} type="button" className="preset"
                  onClick={() => set({ baseUrl: pr.baseUrl, label: pr.label, ...(pr.model ? { name: pr.model } : {}) })}>{pr.label}</button>
              ))}
            </div>
            )}
            {/* 连接信息一家只有一份：只有在"开一家新供应商"时才在这里填。
                往已有的一家加模型、或编辑已有档，这里只读——否则同一家里会出现
                两把钥匙、或凭空多出一家（右栏那栏显示的还是第一个非空密钥，等于说假话）。 */}
            {draft.id !== null || draft.underProvider ? (
              <div className="field">
                <label>连接信息（沿用这一家）</label>
                <div className="ml-meta" id="ml-conn-static">{group?.label || "这一家"} · 密钥 {draft.key ? "已带" : "未填"}</div>
                <div className="hint">地址和密钥在右侧「{group?.label || "这一家"}」那一栏改，改了这一家所有模型一起变。</div>
              </div>
            ) : (
              <div className="form-row">
                <div className="field">
                  <label htmlFor="ml-3">接口地址</label>
                  <input id="ml-3" title="协议：OpenAI Chat Completions，一般填到 /v1" placeholder="https://api.deepseek.com/v1" value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
                  <div className="hint">填服务商给的地址，一般到 <code>/v1</code> 为止；点上面的服务商名字可自动填。</div>
                </div>
                <div className="field">
                  <label>API 密钥</label>
                  <div className="key-wrap">
                    <input type={showKey ? "text" : "password"} placeholder="sk-..."
                      value={draft.key} onChange={(e) => set({ key: e.target.value })} />
                    <button type="button" className="key-eye" aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                      title={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((v) => !v)}>
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="form-row">
              <div className="field">
                {draft.underProvider ? (
                  <>
                    <label>加到哪家</label>
                    <div className="ml-meta" id="ml-1-static">{group?.label ?? draft.baseUrl}</div>
                  </>
                ) : (
                  <>
                    <label htmlFor="ml-1">{draft.id ? "显示名" : "供应商名"}</label>
                    <input id="ml-1" maxLength={24}
                      placeholder={draft.id ? "这份档自己的名字" : "如 DeepSeek、本地 Ollama"}
                      value={draft.label} onChange={(e) => set({ label: e.target.value })} />
                    {!draft.id && <div className="hint">这一家共用的名字。</div>}
                  </>
                )}
              </div>
              <div className="field">
                <label htmlFor="ml-2">模型名
                  <button type="button" className="pf-ghost" disabled={form.busy !== ""}
                    onClick={() => form.fetchModelList({ baseUrl: draft.baseUrl, key: draft.key })}>
                    {form.busy === "list" ? "拉取中…" : "从接口拉取"}
                  </button>
                </label>
                <input id="ml-2" placeholder="deepseek-chat" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                {form.modelList.show && (
                  <div className="model-pick" id="modelList">
                    <input className="model-filter" id="model-filter" value={listQuery} aria-label="筛选模型名"
                      placeholder={`在拉到的 ${form.modelList.ids.length} 个里筛…`}
                      onChange={(e) => setListQuery(e.target.value)} />
                    <div className="model-pick-list">
                      {modelShown.map((id) => (
                        <button key={id} type="button" title={id} onClick={() => set({ name: id })}>{id}</button>
                      ))}
                      {modelShown.length === 0 && <div className="hint">没匹配到，清空筛选框就能看全部。</div>}
                    </div>
                    <div className="hint">显示 {modelShown.length} / {form.modelList.ids.length} 个 · 点一个填进模型名。</div>
                  </div>
                )}
                <div className="hint">用上面的地址和密钥拉取；有些服务商不提供列表，拉不到就自己填模型名。</div>
              </div>
            </div>
            <details className="advanced" open={advOpen}
              onToggle={(e) => { setAdvOpen(e.currentTarget.open); }}>
              <summary>高级参数（能力 / 思考 / 超时 / 额外参数）</summary>

              <div className="field">
                <label>模型能力（按服务商文档勾选）</label>
                <div className="cap-checks">
                  {CAP_DEFS.map((c) => (
                    <label key={c.key} className="check">
                      <input type="checkbox" checked={draft.caps[c.key]}
                        onChange={(e) => set({ caps: { ...draft.caps, [c.key]: e.target.checked } })} />
                      <span>{c.label}</span>
                    </label>
                  ))}
                </div>
                <div className="hint">聊天收到图片时，直接交给这个模型识别（就不用另配图片理解）。</div>
              </div>

              <div className="field">
                <label>思考参数形态</label>
                <div className="adv-chips">
                  {THINKING_PARAM_DEFS.map((p) => (
                    <button key={p.id} type="button" className={"adv-chip" + (draft.thinkingParam === p.id ? " on" : "")}
                      onClick={() => set({ thinkingParam: p.id })}>{p.label}</button>
                  ))}
                </div>
                <div className="hint">
                  {THINKING_PARAM_DEFS.find((p) => p.id === draft.thinkingParam)?.hint}
                </div>
              </div>

              {draft.thinkingParam === "effort" ? (
                <div className="form-row">
                  <div className="field">
                    <label>默认思考强度</label>
                    <div className="adv-chips">
                      <button type="button" className={"adv-chip" + (draft.thinkingLevel === "" ? " on" : "")}
                        onClick={() => set({ thinkingLevel: "" })}>跟随模型</button>
                      {THINKING_DEFS.map((l) => (
                        <button key={l.id} type="button"
                          className={"adv-chip" + (draft.thinkingLevel === l.id ? " on" : "")}
                          onClick={() => set({ thinkingLevel: l.id })}>{l.label}</button>
                      ))}
                    </div>
                    <div className="hint">勾了「思考模式」才会带强度；不选就用中等。</div>
                  </div>
                  <div className="field">
                    <label>这个模型支持哪几档</label>
                    <div className="adv-chips">
                      {THINKING_DEFS.map((l) => (
                        <button key={l.id} type="button"
                          className={"adv-chip" + (draft.thinkingLevels.includes(l.id) ? " on" : "")}
                          onClick={() => toggleLevel(l.id)}>{l.label}</button>
                      ))}
                    </div>
                    <div className="hint">去掉服务商没有的档位。</div>
                  </div>
                </div>
              ) : (
                <div className="field">
                  <label>思考开关</label>
                  <div className="adv-chips">
                    {THINKING_MODE_CHIPS.map((m) => (
                      <button key={m.id || "follow"} type="button" className={"adv-chip" + (draft.thinkingMode === m.id ? " on" : "")}
                        onClick={() => set({ thinkingMode: m.id })}>{m.label}</button>
                    ))}
                  </div>
                  <div className="hint">
                    「跟随模型」= 不指定，按服务商自己的默认来。想关掉一个默认开思考的模型，选「关」。
                  </div>
                </div>
              )}

              <div className="form-row">
                <div className="field">
                  <label htmlFor="ml-4">输入上限（token）</label>
                  <input id="ml-4" inputMode="numeric" placeholder="如 131072；留空按 32K 保守估算" value={draft.maxInput}
                    onChange={(e) => set({ maxInput: e.target.value.replace(/[^\d]/g, "") })} />
                  <div className="adv-chips">
                    {INPUT_LIMIT_CHIPS.map((c) => (
                      <button key={c.label} type="button" className={"adv-chip" + (draft.maxInput === String(c.tokens) ? " on" : "")}
                        onClick={() => set({ maxInput: String(c.tokens) })}>{c.label}</button>
                    ))}
                  </div>
                  <div className="hint">对话历史最多能带多长；留空按保守值算，配大了会提前截断。</div>
                </div>
                <div className="field">
                  <label htmlFor="ml-5">输出上限（token）</label>
                  <input id="ml-5" inputMode="numeric" placeholder="如 8192；留空=不填" value={draft.maxOutput}
                    onChange={(e) => set({ maxOutput: e.target.value.replace(/[^\d]/g, "") })} />
                  <div className="adv-chips">
                    {OUTPUT_LIMIT_CHIPS.map((c) => (
                      <button key={c.label} type="button" className={"adv-chip" + (draft.maxOutput === String(c.tokens) ? " on" : "")}
                        onClick={() => set({ maxOutput: String(c.tokens) })}>{c.label}</button>
                    ))}
                  </div>
                  <div className="hint">一次回复最长能写多长；留空按默认值。</div>
                </div>
              </div>

              <div className="form-row">
                <div className="field">
                  <label htmlFor="ml-6">超时（毫秒）</label>
                  <input id="ml-6" value={draft.timeout} onChange={(e) => set({ timeout: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ml-7" title="一般不用填。只在需要往发给模型的请求体里塞额外字段时才用，格式是一个 JSON 对象。">额外参数（JSON）</label>
                  <input id="ml-7" placeholder='一般留空；如 {"temperature":0.9}' value={draft.extra} onChange={(e) => set({ extra: e.target.value })} />
                </div>
              </div>
            </details>
            {form.modelBanner && (
              <div className={"banner show " + form.modelBanner.kind} id="modelBanner" role={form.modelBanner.kind === "bad" ? "alert" : "status"}>
                <div className="body">{form.modelBanner.text}</div>
              </div>
            )}
            <div className="actions">
              <button type="button" className="btn" id="btn-test" disabled={form.busy !== ""}
                onClick={() => form.testModel({ baseUrl: draft.baseUrl, key: draft.key, name: draft.name })}>
                {form.busy === "test" ? "测试中…" : "测试连接"}
              </button>
              <button type="button" className="primary" id="btn-save-profile" disabled={form.busy !== ""} onClick={save}>
                {form.busy === "prof" ? "保存中…" : draft.id ? "保存修改" : draft.underProvider ? "保存模型" : "保存这一家"}
              </button>
              <button type="button" className="btn" onClick={() => setDraft(null)}>取消</button>
            </div>
          </Modal>
        )}


        {io?.step === "export" && exportPreview && (
          <Modal onClose={() => setIo(null)} label="导出模型配置" className="ml-form">
            <div className="ml-form-head">
              <div className="subhead">导出模型配置</div>
              <button type="button" className="ml-btn" title="取消" aria-label="取消" onClick={() => setIo(null)}><X size={15} /></button>
            </div>
            <div className="io-lines">
              <div>将导出 <b>{exportPreview.file.profiles.length}</b> 个模型。</div>
              <label className="check">
                <input type="checkbox" id="io-with-keys" checked={io.withKeys}
                  onChange={(e) => setIo({ step: "export", withKeys: e.target.checked })} />
                <span>连同 API 密钥一起导出</span>
              </label>
              <div className="hint">
                {io.withKeys
                  ? "这份文件里是明文密钥：只留在自己机器上，别发到群里、别传云盘。"
                  : `默认不带密钥——备份换机够用，导入后逐个补上。`}
              </div>
              {exportPreview.file.activeLabel !== "" && (
                <div className="hint">导出时正在用的是 {exportPreview.file.activeLabel}（导回来不会自动换上，要点一下「应用」）</div>
              )}
            </div>
            <div className="actions">
              <button type="button" className="primary" id="btn-do-export" onClick={doExport}>下载备份</button>
              <button type="button" className="btn" onClick={() => setIo(null)}>取消</button>
            </div>
          </Modal>
        )}

        {io?.step === "import" && (
          <Modal onClose={() => setIo(null)} label="导入模型配置" className="ml-form">
            <div className="ml-form-head">
              <div className="subhead">导入模型配置</div>
              <button type="button" className="ml-btn" title="取消" aria-label="取消" onClick={() => setIo(null)}><X size={15} /></button>
            </div>
            <div className="io-lines">
              <div>
                这份文件导出于 {io.file.exportedAt ? new Date(io.file.exportedAt).toLocaleString("zh-CN") : "（时间未知）"} ·
                {" "}{io.file.hasKeys ? "含 API 密钥" : "不含 API 密钥"}
              </div>
              <ul className="io-ul">
                <li>新增 <b>{io.plan.add.length}</b> 个模型{io.plan.add.length > 0 && <>：{io.plan.add.map((p) => p.label).join("、")}</>}</li>
                {io.plan.dup.length > 0 && <li>跳过 <b>{io.plan.dup.length}</b> 个已存在的同名模型：{io.plan.dup.join("、")}</li>}
                {(capPlan.length > 0 || refPlan.length > 0 || io.plan.capsBlocked.length > 0) && (
                  <li>
                    <details className="io-more">
                      <summary>能力相关的明细</summary>
                      <ul className="io-ul">
                        {capPlan.length > 0 && (
                          <li>往 {capPlan.length} 张能力卡补进端点档：{capPlan.map((c) => CAP_TITLES[c.name] ?? c.name).join("、")}</li>
                        )}
                        {refPlan.length > 0 && (
                          <li>把 {refPlan.length} 张卡指到「主对话模型」的档：
                            {refPlan.map((c) => `${CAP_TITLES[c.name] ?? c.name} → ${c.refLabel}`).join("、")}</li>
                        )}
                        {io.plan.capsBlocked.length > 0 && (
                          <li className="io-warn">有 {io.plan.capsBlocked.length} 项没导进来（{io.plan.capsBlocked.map((n) => CAP_TITLES[n] ?? n).join("、")}）：
                            文件里没带密钥，硬写进去等于把你的密钥发到那个地址。</li>
                        )}
                      </ul>
                    </details>
                  </li>
                )}
              </ul>
              <div className="hint">只会新增，不会动你已有的；导错了删掉就是。</div>
            </div>
            <div className="actions">
              <button type="button" className="primary" id="btn-do-import" disabled={io.running === true || form.busy !== ""}
                onClick={() => { void doImport(); }}>
                {io.running === true ? "导入中…" : `确认导入${io.plan.add.length > 0 ? ` ${io.plan.add.length} 个` : ""}`}
              </button>
              <button type="button" className="btn" onClick={() => setIo(null)}>取消</button>
            </div>
          </Modal>
        )}


        {draft === null && form.modelBanner && (
          <div className={"banner show " + form.modelBanner.kind} id="modelBanner" role={form.modelBanner.kind === "bad" ? "alert" : "status"}>
            <div className="body">{form.modelBanner.text}</div>
          </div>
        )}

        <div className="ml-foot">
          <label className="check">
            <input type="checkbox" id="f-echo" checked={echoOn} disabled={form.busy !== ""}
              onChange={(e) => form.setEchoMode(e.target.checked)} />
            <span>演示模式：不调用真实模型，只验证流程通不通</span>
          </label>
        </div>
      </div>

      <div className="hint" style={{ marginTop: 10 }}>
        每个联系人也能单独指定模型：联系人 → 编辑资料 → 模型。
      </div>
    </div>
  );
}

