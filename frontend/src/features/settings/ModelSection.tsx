import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, Eye, EyeOff, FileDown, FileUp, Loader2,
  Pencil, Play, Plus, Server, ShieldCheck, Sparkles, Trash2, X, Zap,
} from "lucide-react";
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

/* 与后端 defaultModelCaps 对齐：新档默认按「支持工具」处理——工具是历史行为，
   端点不兼容由运行时探测兜底（吃 400 后按端点降级）。默认不勾的后果是联系人
   设置里的工具开关全部失效（实测踩过）。 */
const NO_CAPS: ModelCaps = {
  tools: true, vision: false, thinking: false,
  thinkingOnly: false, customProtocol: false,
};

const emptyDraft = (): Draft => ({
  id: null, label: "", baseUrl: "", key: "", name: "", timeout: "90000", extra: "",
  caps: { ...NO_CAPS }, thinkingLevel: "", thinkingLevels: [], thinkingParam: "effort", thinkingMode: "auto",
  maxInput: "", maxOutput: "", underProvider: false,
});

const CAP_DEFS: Array<{ key: keyof ModelCaps; label: string }> = [
  { key: "tools", label: "工具调用" },
  { key: "vision", label: "图片输入" },
  { key: "thinking", label: "支持思考" },
  { key: "thinkingOnly", label: "仅思考模式" },
  { key: "customProtocol", label: "自定义协议" },
];

/** 一级勾选只放三个用户能对着服务商文档回答的问题；仅思考/自定义协议是极少数
 *  排障时才碰的元数据，沉进下方「接口格式不兼容时再改」折叠区（字段与保存不动）。 */
const MAIN_CAP_DEFS: Array<{ key: keyof ModelCaps; label: string; hint: string }> = [
  { key: "tools", label: "工具调用", hint: "不勾时请求不携带工具定义，也不会执行任何工具；普通聊天不受影响。" },
  { key: "vision", label: "图片输入", hint: "主模型支持看图就勾；不确定可不勾，看图会走「图片理解」兜底。" },
  { key: "thinking", label: "支持思考", hint: "模型能输出思考过程（reasoning）就勾。" },
];

/** 开关系形态（模板系 / 火山系）的三个取值；"" 表示一个字段都不发。 */
const THINKING_MODE_CHIPS: Array<{ id: ThinkingModeId; label: string }> = [
  { id: "auto", label: "跟随模型" },
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

/** 新供应商接入只走两步：先确认连接，再挑第一个模型。 */
type AddStep = "connection" | "model";

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl.trim()).host || baseUrl.trim();
  } catch {
    return baseUrl.trim().replace(/^https?:\/\//, "").split("/")[0] || "";
  }
};

const isLocalBase = (baseUrl: string): boolean => {
  const host = hostOf(baseUrl).split(":")[0]?.toLowerCase() ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
};

/** 供应商名允许留空：界面最后用预设名或域名兜底，不再用一条校验拦住用户。 */
const fallbackProviderName = (baseUrl: string): string => {
  const base = normBase(baseUrl);
  return (CHAT_PRESETS.find((p) => normBase(p.baseUrl) === base)?.label || hostOf(base) || "新供应商").slice(0, 24);
};

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

/** 全局回放范围。档位与联系人页同一套语义（3 眼前 / 10 一段对话 / 30 一个话题），
 *  上限 30 与后端 sanitizeRecentTurns 对齐；比例档与联系人 turnPct 同一判序（比例优先）。 */
const GLOBAL_TURN_CHIPS = [3, 10, 30];
const GLOBAL_TURN_CHIP_LABELS: Record<number, string> = { 3: "眼前", 10: "一段对话", 30: "一个话题" };
const GLOBAL_TURN_MAX = 30;
const GLOBAL_PCT_CHIPS = [25, 50, 75];
type GlobalReplayMode = "turns" | "pct" | "all";

/** 从快照解析当前全局模式（与后端 effectiveRecentTurnsSpec 同一判序）。 */
function globalReplayModeOf(persona: { recentTurns?: number; recentTurnsPct?: number } | undefined): { mode: GlobalReplayMode; turns: number; pct: number } {
  const turns = persona?.recentTurns ?? 0;
  const pct = persona?.recentTurnsPct ?? 0;
  if (pct > 0) return { mode: "pct", turns, pct };
  if (turns === -1) return { mode: "all", turns, pct };
  return { mode: "turns", turns, pct };
}

/** 全局回放范围：没单独指定「回放范围」的联系人都跟着它走。
 *  这份值原本只有固定轮数、且任何设置页都没有入口——联系人页那句「跟随全局 · N 轮」
 *  的 N 改不了，是归类核查揪出的隐形设置；现在补齐为与联系人页同构的三种给法。 */
function GlobalTurnsCard({ form }: { form: SettingsForm }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [custom, setCustom] = useState("");
  const persona = form.saved?.persona;
  const { mode, turns: savedTurns, pct: savedPct } = globalReplayModeOf(persona);
  const fallback = form.saved?.defaultRecentTurns ?? 6;
  const customValue = Number(custom);
  const customValid = custom.trim() !== "" && Number.isInteger(customValue)
    && customValue >= 1 && customValue <= (mode === "pct" ? 100 : GLOBAL_TURN_MAX);

  /** 一次请求把两个字段写齐：模式互斥在服务端 updatePersona 里兜底，这里显式带上更直观。 */
  const save = (patch: { recentTurns: number; recentTurnsPct: number }, ok: string): void => {
    if (busy) return;
    setBusy(true);
    setNote("");
    setErr("");
    settingsApi.saveSettings(patch)
      .then((d) => {
        form.applySnapshot(d);
        // 联系人页的「跟随全局」标签监听这条广播，保存后立刻跟上。
        window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
        setNote(ok);
        setCustom("");
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const pickMode = (next: GlobalReplayMode): void => {
    if (next === mode) return;
    if (next === "all") {
      save({ recentTurns: -1, recentTurnsPct: 0 }, "已改为回放全部历史。长会话的每次调用输入都会涨到全部历史那么大。");
    } else if (next === "pct") {
      save({ recentTurns: 0, recentTurnsPct: 50 }, "已改为按会话比例回放（默认 50%，可在下方调整）。");
    } else {
      save({ recentTurns: 0, recentTurnsPct: 0 }, `已改为按轮数回放（跟随默认 ${fallback} 轮）。`);
    }
  };

  const currentDesc = mode === "all"
    ? "全部历史都会带上：接得住很久之前的话题，代价是每次调用的输入随历史一起涨。"
    : mode === "pct"
      ? `带这段会话最近 ${savedPct}% 的轮数——比例会随聊了多久自己伸缩。`
      : savedTurns > 0
        ? `每轮带上最近 ${savedTurns} 轮对话。`
        : `跟随内置默认：最近 ${fallback} 轮。`;

  return (
    <div className="card card-pad">
      <div className="ml-head">
        <div className="subhead">全局回放范围</div>
        <span className="spacer" />
        <span className="hint">{busy ? "保存中…" : ""}</span>
      </div>
      <div className="adv-chips" role="radiogroup" aria-label="全局回放的给法">
        <button type="button" role="radio" aria-checked={mode === "turns"}
          className={"adv-chip" + (mode === "turns" ? " on" : "")}
          disabled={busy || form.busy !== ""} onClick={() => pickMode("turns")}>按轮数</button>
        <button type="button" role="radio" aria-checked={mode === "pct"}
          className={"adv-chip" + (mode === "pct" ? " on" : "")}
          disabled={busy || form.busy !== ""} onClick={() => pickMode("pct")}>按会话比例</button>
        <button type="button" role="radio" aria-checked={mode === "all"}
          className={"adv-chip" + (mode === "all" ? " on" : "")}
          disabled={busy || form.busy !== ""} onClick={() => pickMode("all")}>全部历史</button>
      </div>
      <div className="hint">{currentDesc}</div>

      {mode === "turns" && (
        <>
          <div className="adv-chips" role="radiogroup" aria-label="全局回放轮数">
            <button type="button" role="radio" aria-checked={savedTurns === 0}
              title={`不覆盖，用内置默认 ${fallback} 轮`}
              className={"adv-chip" + (savedTurns === 0 ? " on" : "")}
              disabled={busy || form.busy !== ""}
              onClick={() => save({ recentTurns: 0, recentTurnsPct: 0 }, `已回到跟随默认（${fallback} 轮）。`)}>
              跟随默认 · {fallback} 轮
            </button>
            {GLOBAL_TURN_CHIPS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={savedTurns === n}
                title={`${GLOBAL_TURN_CHIP_LABELS[n]}：每轮带上最近 ${n} 轮对话`}
                className={"adv-chip" + (savedTurns === n ? " on" : "")}
                disabled={busy || form.busy !== ""}
                onClick={() => save({ recentTurns: n, recentTurnsPct: 0 }, `已设为最近 ${n} 轮，下一轮对话生效。`)}>
                {n} 轮 · {GLOBAL_TURN_CHIP_LABELS[n]}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="global-turns-custom">自定义轮数</label>
            <input
              id="global-turns-custom"
              type="number"
              inputMode="numeric"
              min={1}
              max={GLOBAL_TURN_MAX}
              step={1}
              value={custom}
              placeholder={`1~${GLOBAL_TURN_MAX}`}
              aria-invalid={custom.trim() !== "" && !customValid}
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="button" className="btn sm" disabled={!customValid || busy || form.busy !== ""}
              onClick={() => save({ recentTurns: customValue, recentTurnsPct: 0 }, `已设为最近 ${customValue} 轮，下一轮对话生效。`)}>
              应用自定义
            </button>
          </div>
        </>
      )}

      {mode === "pct" && (
        <>
          <div className="adv-chips" role="radiogroup" aria-label="全局回放比例">
            {GLOBAL_PCT_CHIPS.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={savedPct === p}
                className={"adv-chip" + (savedPct === p ? " on" : "")}
                disabled={busy || form.busy !== ""}
                onClick={() => save({ recentTurns: 0, recentTurnsPct: p }, `已设为按会话 ${p}% 回放。`)}>
                {p}%
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="global-pct-custom">自定义比例</label>
            <input
              id="global-pct-custom"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              step={1}
              value={custom}
              placeholder="1~100"
              aria-invalid={custom.trim() !== "" && !customValid}
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="button" className="btn sm" disabled={!customValid || busy || form.busy !== ""}
              onClick={() => save({ recentTurns: 0, recentTurnsPct: customValue }, `已设为按会话 ${customValue}% 回放。`)}>
              应用自定义
            </button>
          </div>
        </>
      )}

      <div className="hint">
        没单独指定「回放范围」的联系人都用这一档；联系人页的「跟随全局」指的就是它。
        单独改过的人在联系人 → 对话 → 回放范围里调。
      </div>
      {note !== "" && <div className="banner show ok" role="status"><div className="body">{note}</div></div>}
      {err !== "" && <div className="banner show bad" role="alert"><div className="body">{err}</div></div>}
    </div>
  );
}

/** 分区①：模型接入。列表管理多套模型（添加/编辑/应用/删除），演示模式开关兜底。 */
/** 导出 / 导入那条小流程的界面状态。 */
type IoState =
  | { step: "export"; withKeys: boolean }
  | { step: "import"; file: ModelConfigFile; plan: ImportPlan; running?: boolean };

export default function ModelSection({ form, revealAdvanced, focusProfile = "", focusSeq = 0 }: {
  form: SettingsForm;
  revealAdvanced?: boolean;
  /** 「去设置」点名要打开的那一档（空串 = 没点名，退回全局在用的那档）。 */
  focusProfile?: string;
  /** 同一次导航的序号：同一个人连点两次也要重新打开，切去别的子页再回来不该又弹一次。 */
  focusSeq?: number;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [modalStep, setModalStep] = useState<AddStep>("connection");
  const [advOpen, setAdvOpen] = useState(false);
  const [listQuery, setListQuery] = useState("");
  /** 刚被「去设置」定位到的那一档：短暂描边，让人知道弹窗关掉后该看哪一行。 */
  const [flash, setFlash] = useState("");
  const modelInputRef = useRef<HTMLInputElement>(null);
  // 弹窗：点遮罩外部或按 Esc 关闭（表单本体标了 data-keep-menu）
  useDismiss(draft !== null, () => setDraft(null));
  const m = form.saved?.model;
  const echoOn = m?.mode === "echo";
  const profiles = form.saved?.profiles ?? [];
  const activeLabel = profiles.find((p) => p.id === form.saved?.activeProfileId)?.label ?? m?.name ?? "";

  const set = (patch: Partial<Draft>): void => {
    form.setModelBanner(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

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

  useEffect(() => {
    if (revealAdvanced === true) setAdvOpen(true);
  }, [revealAdvanced]);

  useEffect(() => {
    if (modalStep !== "model" || draft === null) return;
    document.querySelector<HTMLElement>(".ml-form.modal-card")?.scrollTo({ top: 0 });
    requestAnimationFrame(() => modelInputRef.current?.focus({ preventScroll: true }));
  }, [modalStep, draft?.id, draft?.underProvider]);

  const openAdd = (seed?: { baseUrl: string; key: string; underProvider?: boolean }): void => {
    form.setModelBanner(null);
    form.resetModelList();
    setListQuery("");
    setShowKey(false);
    setAdvOpen(false);
    setModalStep(seed?.underProvider ? "model" : "connection");
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
    form.resetModelList();
    setListQuery("");
    setShowKey(false);
    setModalStep("model");
    setAdvOpen(revealAdvanced === true || p.caps?.thinking === true || p.caps?.vision === true
      || p.maxOutputTokens != null);
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
      thinkingMode: p.thinkingMode === "" ? "auto" : (p.thinkingMode ?? "auto"),
      maxInput: p.maxInputTokens ? String(p.maxInputTokens) : "",
      maxOutput: p.maxOutputTokens ? String(p.maxOutputTokens) : "",
      underProvider: false,
    });
  };

  // 从上下文圆环点「去设置」过来：直接把**圆环量的那一档**打开（见下方 reveal 那段）。
  // 停在列表页等于把人领到门口又让用户自己找门——高级参数还藏在折叠区里。

  /** 第一步只校验“能不能建立连接”，把模型选择留给下一步。 */
  const goToModelStep = (): void => {
    if (!draft) return;
    if (draft.baseUrl.trim() === "") {
      form.setModelBanner({ kind: "bad", text: "先填接口地址，下一步才好选模型。" });
      return;
    }
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    } catch {
      form.setModelBanner({ kind: "bad", text: "接口地址需要以 http:// 或 https:// 开头。" });
      return;
    }
    if (!isLocalBase(draft.baseUrl) && draft.key.trim() === "") {
      form.setModelBanner({ kind: "bad", text: "远程服务需要 API Key；本地 Ollama 可以留空。" });
      return;
    }
    form.setModelBanner(null);
    set({ label: draft.label.trim() || fallbackProviderName(draft.baseUrl) });
    setModalStep("model");
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    // 往已有的一家下面加模型：配置名留空时默认取模型名前 24 字，避免超长模型名被 400 拒绝。
    // 新建一家的显示名允许留空，保存时用预设名或域名兜底，不再拿一个命名问题挡路。
    const label = draft.underProvider
      ? (draft.label.trim() || draft.name.trim().slice(0, 24))
      : (draft.label.trim() || draft.name.trim() || fallbackProviderName(draft.baseUrl));
    if (label === "") {
      form.setModelBanner({ kind: "bad", text: draft.underProvider ? "模型名不能为空" : "给这一家起个名字" });
      return;
    }
    if (draft.baseUrl.trim() === "") { form.setModelBanner({ kind: "bad", text: "接口地址不能为空" }); return; }
    if (draft.name.trim() === "") { form.setModelBanner({ kind: "bad", text: "模型名不能为空" }); return; }
    if (draft.id === null && !draft.underProvider && !isLocalBase(draft.baseUrl) && draft.key.trim() === "") {
      form.setModelBanner({ kind: "bad", text: "远程服务需要填 API Key；本地 Ollama 可以留空。" });
      return;
    }
    const saved = await form.saveModelProfile({
      id: draft.id, label, baseUrl: draft.baseUrl,
      key: draft.key, name: draft.name, timeoutMs: draft.timeout, extraBody: draft.extra,
      caps: draft.caps, thinkingLevel: draft.thinkingLevel, thinkingLevels: draft.thinkingLevels,
      thinkingParam: draft.thinkingParam, thinkingMode: draft.thinkingMode,
      maxInput: draft.maxInput, maxOutput: draft.maxOutput,
    });
    if (!saved) return;
    setDraft(null);
    setModalStep("connection");
    setAdvOpen(false);
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
  // 不用原生 select：它的弹层不吃主题，暗色下是系统那块浅蓝补丁（见 foundation.css 那条注释）。
  const [dropOpen, setDropOpen] = useState(false);
  // 判定全在 useDismiss：它听 pointerdown，打开那一发的按下比监听器存在更早，
  // 不会"点开即关"，所以这里不需要任何时间宽限。
  useDismiss(dropOpen, () => setDropOpen(false));
  // 换一家就重新取一次现值；在同一家里编辑中的内容不会被后台快照刷新冲掉
  const d = provRaw?.from === shown ? provRaw : { from: shown, url: shown, key: baseKey, label: group?.label ?? "" };
  const provDirty = group !== null && (d.url !== group.baseUrl || d.key !== baseKey || d.label !== group.label);

  // 「去设置」要落到哪一档：点名的那档优先（联系人可能单独绑了档，圆环量的就是它），
  // 没点名才退回全局在用的那档。用「序号 + id」记住已经执行过的那一次：
  // 同一个人连点两次要重新打开（上一次可能已经关掉了），切去别的子页再回来不该又弹一遍。
  const revealTarget = focusProfile || form.saved?.activeProfileId || "";
  const revealKey = `${focusSeq}:${revealTarget}`;
  const revealDone = useRef("");
  useEffect(() => {
    if (revealAdvanced !== true || revealTarget === "") return;
    if (revealDone.current === revealKey) return;
    const target = profiles.find((p) => p.id === revealTarget);
    if (!target) return; // 档被删了/还没加载到：不硬开一个不存在的弹窗，等快照回来再试
    revealDone.current = revealKey;
    // 列表按 baseUrl 归组，先把供应商切到这一家，关掉弹窗后那一行才在眼前。
    setSel(normBase(target.baseUrl));
    openEdit(revealTarget);
    setFlash(revealTarget);
  }, [revealAdvanced, revealKey, revealTarget, profiles]);

  // 描边闪一下 + 把它滚到视野中间。延时是因为切供应商后那一行要下一次提交才存在。
  useEffect(() => {
    if (flash === "") return;
    const roll = setTimeout(() => {
      document.getElementById("ml-row-" + flash)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    const clear = setTimeout(() => setFlash(""), 2600);
    return () => { clearTimeout(roll); clearTimeout(clear); };
  }, [flash]);

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
      <div key={p.id} id={"ml-row-" + p.id} className={"ml-row" + (activeRow ? " active" : "") + (flash === p.id ? " flash" : "")}>
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
    <div className="section" id="settings-models">
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

      <GlobalTurnsCard form={form} />

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

        {draft !== null && (() => {
          const isNewProvider = draft.id === null && !draft.underProvider;
          const connectionStep = isNewProvider && modalStep === "connection";
          const modalTitle = draft.id
            ? "编辑模型"
            : draft.underProvider
              ? "添加模型"
              : connectionStep ? "接入新供应商" : "添加第一个模型";
          const modalSub = draft.id
            ? "只改这个模型自己的参数；地址和密钥仍由供应商统一管理。"
            : draft.underProvider
              ? "连接信息沿用当前供应商，只需要告诉小茉模型名。"
              : connectionStep
                ? "连接信息只填一次，同一家下的模型共用。名称和密钥都可以稍后再改。"
                : "连接已经准备好，选一个服务商现在能用的模型。";
          const canFetchModels = draft.baseUrl.trim() !== "" && (isLocalBase(draft.baseUrl) || draft.key.trim() !== "");
          return (
            <Modal onClose={() => setDraft(null)} label={modalTitle}
              className={"ml-form" + (isNewProvider ? " ml-form-flow" : "")}>
              <div className="ml-form-head">
                <div>
                  <div className="modal-title">{modalTitle}</div>
                  <div className="modal-sub">{modalSub}</div>
                  {isNewProvider && (
                    <ol className="ml-steps" aria-label="接入步骤">
                      <li className={connectionStep ? "on" : "done"} aria-current={connectionStep ? "step" : undefined}>
                        <span>{connectionStep ? "1" : <Check size={11} strokeWidth={2.6} />}</span>
                        连接服务
                      </li>
                      <li className={connectionStep ? "" : "on"} aria-current={connectionStep ? undefined : "step"}>
                        <span>2</span>
                        添加模型
                      </li>
                    </ol>
                  )}
                </div>
                <button type="button" className="ml-btn" title="关闭" aria-label="关闭" onClick={() => setDraft(null)}><X size={16} /></button>
              </div>

              {connectionStep ? (
                <div className="ml-connect-stage">
                  <div className="ml-stage-intro">
                    <div className="ml-eyebrow">第 1 步 · 连接</div>
                    <h3>这家模型从哪里调用？</h3>
                    <p>选常用服务商会自动填好接口地址和推荐模型；自建服务直接在下方填写。</p>
                  </div>

                  <div className="ml-provider-grid" role="group" aria-label="常用供应商">
                    {CHAT_PRESETS.map((pr) => {
                      const selected = normBase(draft.baseUrl) === normBase(pr.baseUrl);
                      return (
                        <button key={pr.label} type="button" aria-pressed={selected}
                          className={"ml-provider-card" + (selected ? " on" : "")}
                          onClick={() => {
                            form.setModelBanner(null);
                            form.resetModelList();
                            set({
                              baseUrl: pr.baseUrl,
                              label: pr.label,
                              ...(pr.model ? { name: pr.model } : {}),
                            });
                          }}>
                          <span className="ml-provider-mark" aria-hidden="true">{pr.label.slice(0, 1)}</span>
                          <span className="ml-provider-copy">
                            <b>{pr.label}</b>
                            <small>{hostOf(pr.baseUrl)}</small>
                          </span>
                          {selected && <Check className="ml-provider-check" size={15} strokeWidth={2.4} />}
                        </button>
                      );
                    })}
                  </div>

                  <div className="ml-connection-card">
                    <div className="ml-card-heading">
                      <div>
                        <b>连接信息</b>
                        <span>从这里开始填写，带 * 的是必填项</span>
                      </div>
                      <span className="ml-connection-kind"><Server size={14} /> OpenAI 兼容接口</span>
                    </div>
                    <div className="form-row">
                      <div className="field">
                        <label htmlFor="ml-provider-name">供应商名 <span className="ml-optional">可选</span></label>
                        <input id="ml-provider-name" maxLength={24} placeholder={fallbackProviderName(draft.baseUrl)}
                          value={draft.label} onChange={(e) => set({ label: e.target.value })} />
                        <div className="hint">留空会自动使用服务商名，之后也能改。</div>
                      </div>
                      <div className="field">
                        <label htmlFor="ml-base-url">接口地址 *</label>
                        <input id="ml-base-url" inputMode="url" spellCheck={false}
                          placeholder="https://api.deepseek.com/v1"
                          value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
                        <div className="hint">一般填到 <code>/v1</code>；火山方舟等按服务商文档填写。</div>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="ml-api-key">API Key {isLocalBase(draft.baseUrl) ? <span className="ml-optional">本地可留空</span> : "*"}</label>
                      <div className="key-wrap">
                        <input id="ml-api-key" type={showKey ? "text" : "password"} placeholder="sk-..."
                          value={draft.key} onChange={(e) => set({ key: e.target.value })} />
                        <button type="button" className="key-eye" aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                          title={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((v) => !v)}>
                          {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                      <div className="ml-key-note">
                        <ShieldCheck size={14} />
                        <span>密钥只保存在这台设备；调用时只会发给上方填写的服务商。</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="ml-model-stage">
                  <div className="ml-connection-summary">
                    <span className="ml-connection-summary-icon"><Server size={17} /></span>
                    <span className="ml-connection-summary-copy">
                      <b>{draft.label.trim() || group?.label || fallbackProviderName(draft.baseUrl)}</b>
                      <small>{hostOf(draft.baseUrl) || draft.baseUrl || "未填接口地址"}</small>
                    </span>
                    {isNewProvider ? (
                      <button type="button" className="pf-ghost ml-summary-action"
                        onClick={() => { form.setModelBanner(null); setModalStep("connection"); }}>
                        <Pencil size={13} /> 修改连接
                      </button>
                    ) : (
                      <span className="ml-connection-badge"><ShieldCheck size={13} /> 密钥已复用</span>
                    )}
                  </div>

                  <div className="ml-stage-intro compact">
                    <div className="ml-eyebrow">{isNewProvider ? "第 2 步 · 模型" : "模型配置"}</div>
                    <h3>选择要添加的模型</h3>
                    <p>{isNewProvider ? "先把第一个模型加进来，之后可以继续在同一家下添加。" : "只改模型名和能力参数，不会影响这一家下的其他模型。"}</p>
                  </div>

                  <div className="field ml-model-field">
                    <label htmlFor="ml-model-name">模型名 *
                      <button type="button" className="pf-ghost" disabled={!canFetchModels || form.busy !== ""}
                        title={canFetchModels ? "从接口拉取可用模型" : "先填接口地址；远程服务还需要 API Key"}
                        onClick={() => form.fetchModelList({ baseUrl: draft.baseUrl, key: draft.key })}>
                        {form.busy === "list" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                        {form.busy === "list" ? "拉取中…" : "获取可选模型"}
                      </button>
                    </label>
                    <input ref={modelInputRef} id="ml-model-name" spellCheck={false}
                      placeholder="如 deepseek-chat / qwen-plus" value={draft.name}
                      onChange={(e) => set({ name: e.target.value })} />
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
                    <div className="hint">
                      {canFetchModels ? "可以从接口拉取，也可以直接填服务商文档里的模型名。" : "先返回上一步补齐连接信息，才能拉取模型列表。"}
                    </div>
                  </div>

                  {(draft.id !== null || draft.underProvider) && (
                    <div className="field ml-profile-name-field">
                      <label htmlFor="ml-profile-label">配置名 <span className="ml-optional">可选</span></label>
                      <input id="ml-profile-label" maxLength={24}
                        placeholder={draft.underProvider
                          ? `留空默认用「${draft.name.trim().slice(0, 24) || "模型名前 24 字"}」`
                          : (draft.name.trim() || "默认使用模型名")}
                        value={draft.label} onChange={(e) => set({ label: e.target.value })} />
                      <div className="hint">
                        {draft.underProvider
                          ? "留空自动用模型名前 24 字；同一家下多个模型时，填个短名更好认，比如「日常聊天」「便宜备用」。"
                          : "同一家下挂多个模型时，用它区分用途，比如「日常聊天」「便宜备用」。"}
                      </div>
                    </div>
                  )}

                  <details className="advanced" open={advOpen}
                    onToggle={(e) => { setAdvOpen(e.currentTarget.open); }}>
                    <summary>高级参数（能力 / 思考 / 上下文 / 超时 / 额外参数）</summary>

                    <div className="field">
                      <label>模型能力（按服务商文档勾选）</label>
                      <div className="cap-checks">
                        {MAIN_CAP_DEFS.map((c) => (
                          <label key={c.key} className="check" title={c.hint}>
                            <input type="checkbox" checked={draft.caps[c.key]}
                              onChange={(e) => set({ caps: { ...draft.caps, [c.key]: e.target.checked } })} />
                            <span>{c.label}</span>
                          </label>
                        ))}
                      </div>
                      <div className="hint">按服务商文档勾真实能力；其余能力项在下方「接口格式不兼容时再改」里。</div>
                    </div>

                    <div className="field think-settings">
                      <label>思考</label>
                      {draft.thinkingParam === "effort" ? (
                        <div className="field">
                          <label>默认强度</label>
                          <div className="adv-chips">
                            <button type="button" className={"adv-chip" + (draft.thinkingMode === "auto" ? " on" : "")}
                              onClick={() => set({ thinkingMode: "auto", thinkingLevel: "" })}>跟随模型</button>
                            {THINKING_DEFS.map((l) => (
                              <button key={l.id} type="button"
                                className={"adv-chip" + (draft.thinkingLevel === l.id ? " on" : "")}
                                onClick={() => set({ thinkingMode: "on", thinkingLevel: l.id })}>{l.label}</button>
                            ))}
                          </div>
                          <div className="hint">「跟随模型」不发送强度字段，由服务商决定；选具体档位才会显式覆盖。聊天输入区可以随时切换——那里是思考的日常入口，这里只定默认值。</div>
                        </div>
                      ) : (
                        <>
                          <div className="adv-chips">
                            {THINKING_MODE_CHIPS.map((m) => (
                              <button key={m.id || "follow"} type="button" className={"adv-chip" + (draft.thinkingMode === m.id ? " on" : "")}
                                onClick={() => set({ thinkingMode: m.id })}>{m.label}</button>
                            ))}
                          </div>
                          <div className="hint">
                            这类模型只有开关、没有强度。默认开思考的模型若想关掉，选「关」。
                          </div>
                        </>
                      )}
                      <details className="thinking-compat">
                        <summary>接口格式不兼容时再改</summary>
                        <div className="adv-chips">
                          {THINKING_PARAM_DEFS.map((p) => (
                            <button key={p.id} type="button" className={"adv-chip" + (draft.thinkingParam === p.id ? " on" : "")}
                              onClick={() => set({ thinkingParam: p.id })}>{p.label}</button>
                          ))}
                        </div>
                        <div className="hint">
                          {THINKING_PARAM_DEFS.find((p) => p.id === draft.thinkingParam)?.hint}
                          普通模型保持「reasoning_effort」即可；只有服务商明确换了字段名时才需要改。
                        </div>
                        <div className="cap-checks">
                          {CAP_DEFS.filter((c) => c.key === "thinkingOnly" || c.key === "customProtocol").map((c) => (
                            <label key={c.key} className="check"
                              title={c.key === "thinkingOnly"
                                ? "模型只会思考、不产出正文（如 o1 系的部分端点）"
                                : "端点不是标准 OpenAI 协议时的展示标记，不影响请求"}>
                              <input type="checkbox" checked={draft.caps[c.key]}
                                onChange={(e) => set({ caps: { ...draft.caps, [c.key]: e.target.checked } })} />
                              <span>{c.label}</span>
                            </label>
                          ))}
                        </div>
                      </details>
                    </div>

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
                      <div className="hint">一次回复最长能写多长；留空就不发这个字段，由服务商按模型的上下文窗口决定（想更稳可以填 8192）。</div>
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
                </div>
              )}

              {form.modelBanner && (
                <div className={"banner show " + form.modelBanner.kind} id="modelBanner" role={form.modelBanner.kind === "bad" ? "alert" : "status"}>
                  <div className="body">{form.modelBanner.text}</div>
                </div>
              )}

              <div className="actions ml-form-actions">
                {connectionStep ? (
                  <>
                    <button type="button" className="btn" onClick={() => setDraft(null)}>取消</button>
                    <span className="spacer" />
                    <button type="button" className="primary" id="btn-next-model" onClick={goToModelStep}>
                      下一步：添加模型 <ArrowRight size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn"
                      onClick={() => { form.setModelBanner(null); isNewProvider ? setModalStep("connection") : setDraft(null); }}>
                      {isNewProvider ? <><ArrowLeft size={15} /> 上一步</> : "取消"}
                    </button>
                    <span className="spacer" />
                    <button type="button" className="btn" id="btn-test"
                      disabled={form.busy !== "" || draft.name.trim() === ""}
                      onClick={() => form.testModel({ baseUrl: draft.baseUrl, key: draft.key, name: draft.name })}>
                      {form.busy === "test" ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
                      {form.busy === "test" ? "测试中…" : "测试连接"}
                    </button>
                    <button type="button" className="primary" id="btn-save-profile"
                      disabled={form.busy !== ""} onClick={() => { void save(); }}>
                      {form.busy === "prof" ? <Loader2 size={14} className="spin" /> : <Check size={15} />}
                      {form.busy === "prof" ? "保存中…" : draft.id ? "保存修改" : draft.underProvider ? "添加模型" : "保存模型"}
                    </button>
                  </>
                )}
              </div>
            </Modal>
          );
        })()}

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



