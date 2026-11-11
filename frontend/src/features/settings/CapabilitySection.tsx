import { useState } from "react";
import { Eye, EyeOff, Pencil, Plus, X } from "lucide-react";
import Modal from "../../components/Modal";
import PickList, { type PickOption } from "../../components/PickList";
import { settingsApi } from "../../api";
import { CAPABILITY_GROUPS, type CapabilityPresetGroup } from "./presets";
import { groupByProvider, normBase, profilePicks, providerTitle } from "../../lib/providers";
import { offerToast } from "../../lib/toast";
import type { CapabilityEndpoint } from "../../types";
import { TIMEOUT_HINT, TIMEOUT_MAX_SEC, TIMEOUT_MIN_SEC, timeoutSecOf, type SettingsForm } from "./useSettingsForm";

const errText = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** 一份端点档的草稿。密钥直接回填已存值：本机自用，界面不做掩码游戏。 */
type Draft = {
  id: string | null;
  label: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  name: string;
  voice: string;
  /** 超时，界面按「秒」（1~600 整数，口径见 useSettingsForm 的 timeoutSecOf）；库里存毫秒，加载/保存时换算。 */
  timeout: string;
};

const EMPTY: Draft = { id: null, label: "", provider: "", baseUrl: "", apiKey: "", name: "", voice: "", timeout: "90" };

const draftOf = (p: CapabilityEndpoint, provider: string): Draft => ({
  id: p.id,
  label: p.label,
  provider,
  baseUrl: p.baseUrl ?? "",
  apiKey: p.apiKey ?? "",
  name: p.name ?? "",
  voice: p.voice ?? "",
  // 库里是毫秒，界面按秒说话：回填时除以 1000 取整。
  timeout: p.timeoutMs != null ? String(Math.round(p.timeoutMs / 1000)) : "90",
});

type Banner = { kind: "ok" | "bad"; text: string } | null;

/** 主模型侧已接入的供应商（按接口地址去重）：给「复用」chips 用，
 *  地址与密钥一起照抄——能力卡配端点最常见的痛点就是把同一把 key 再敲一遍。 */
type ReuseProvider = { baseUrl: string; apiKey: string; label: string };

const reuseProvidersOf = (form: SettingsForm): ReuseProvider[] => {
  const names = form.saved?.providerNames ?? {};
  const seen = new Set<string>();
  const out: ReuseProvider[] = [];
  for (const p of form.saved?.profiles ?? []) {
    const base = normBase(p.baseUrl ?? "");
    if (base === "" || seen.has(base)) continue;
    seen.add(base);
    out.push({
      baseUrl: p.baseUrl ?? "",
      apiKey: p.apiKey ?? "",
      label: names[base] || p.label || p.name || base,
    });
  }
  return out;
};

/** 添加 / 编辑一份端点档：服务商 chips 填地址与常用模型名，可先测再存。 */
function EndpointForm({ group, initial, names, reuse, onClose, onSaved }: {
  group: CapabilityPresetGroup;
  initial: Draft;
  names: Record<string, string>;
  reuse: ReuseProvider[];
  onClose: () => void;
  onSaved: (text: string) => void;
}): JSX.Element {
  const [f, setF] = useState<Draft>(initial);
  /** 这一家用户起过的名字：按当前接口地址派生，只用于显示，不写回 f.provider（那是提交值）。 */
  const savedProvider = names[normBase(f.baseUrl)] || "";
  const [busy, setBusy] = useState<"" | "save" | "test" | "list">("");
  const [msg, setMsg] = useState<Banner>(null);
  const [ids, setIds] = useState<string[] | null>(null);
  const [showKey, setShowKey] = useState(false);
  // 拉回来的模型清单的筛选词（清单是全量，不截断）。
  const [filter, setFilter] = useState("");
  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>): void => {
    // 值先取出来再更新：updater 要等下一次 render 才跑，那时 currentTarget 已经空了。
    const value = e.currentTarget.value;
    setF((prev) => ({ ...prev, [key]: value }));
  };

  const test = async (): Promise<void> => {
    // 超时先过校验：非法/空值就地拦下说清楚，不把秒的数字当毫秒发出去。
    const sec = timeoutSecOf(f.timeout);
    if (sec === null) { setMsg({ kind: "bad", text: TIMEOUT_HINT }); return; }
    setBusy("test");
    setMsg(null);
    try {
      const r = await settingsApi.testCapability({
        capability: group.name, baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.name, timeoutMs: sec * 1000,
      }) as { ready?: boolean; hint?: string; note?: string; error?: string };
      setMsg(r.ready ? { kind: "ok", text: r.note ?? "连上了" } : { kind: "bad", text: r.hint ?? r.error ?? "没连上" });
    } catch (e: unknown) {
      setMsg({ kind: "bad", text: errText(e) });
    } finally {
      setBusy("");
    }
  };

  const pull = async (): Promise<void> => {
    setBusy("list");
    setMsg(null);
    try {
      const r = await settingsApi.pingModel({ baseUrl: f.baseUrl, apiKey: f.apiKey, want: "list" }) as {
        list?: { ok: boolean; ids?: string[]; message?: string };
      };
      if (r.list?.ok) {
        // 新清单来了先清掉上一轮的筛选词：别让人对着一个被筛空的列表以为没拉到。
        setFilter("");
        setIds(r.list.ids ?? []);
      } else setMsg({ kind: "bad", text: "没拉到这个服务商的模型清单，可以直接填模型名。" });
    } catch (e: unknown) {
      setMsg({ kind: "bad", text: errText(e) });
    } finally {
      setBusy("");
    }
  };

  // 与主模型清单同一套口径：全量保留、输入即筛（前缀命中的排前面）、限高滚动，
  // 长尾模型在清单里也够得着。
  const lq = filter.trim().toLowerCase();
  const shownIds = (ids ?? [])
    .filter((id) => lq === "" || id.toLowerCase().includes(lq))
    .sort((a, b) => (a.toLowerCase().startsWith(lq) ? 0 : 1) - (b.toLowerCase().startsWith(lq) ? 0 : 1)
      || a.localeCompare(b));

  const save = async (): Promise<void> => {
    // 与测试同一道校验：秒 ×1000 转毫秒落库，非法/空值拦在本地而不是发给后端。
    const sec = timeoutSecOf(f.timeout);
    if (sec === null) { setMsg({ kind: "bad", text: TIMEOUT_HINT }); return; }
    setBusy("save");
    setMsg(null);
    try {
      await settingsApi.capabilityProfile({
        capability: group.name, op: "save", id: f.id ?? undefined,
        label: f.label.trim() === "" ? f.name.trim() : f.label.trim(),
        baseUrl: f.baseUrl, apiKey: f.apiKey, name: f.name, voice: f.voice, timeoutMs: sec * 1000,
      });
      // 供应商名走主模型那条同一接口：两家共用一张名字表，不另存一份。
      const provider = f.provider.trim();
      if (provider !== "" && names[normBase(f.baseUrl)] !== provider) {
        await settingsApi.provider({ op: "rename", baseUrl: f.baseUrl, label: provider });
      }
      onSaved("已保存，立即生效");
    } catch (e: unknown) {
      setMsg({ kind: "bad", text: errText(e) });
      setBusy("");
    }
  };

  return (
    <Modal onClose={onClose} label={`${f.id ? "编辑" : "添加"}${group.title}端点`} className="ml-form">
      <div className="ml-form-head">
        <div>
          <div className="modal-title">{f.id ? "编辑端点档" : "添加端点档"}</div>
          <div className="modal-sub">{group.title} · 保存后立即生效</div>
        </div>
        <button type="button" className="ml-btn" title="关闭" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </div>
      {/* 预设名说的是「这家的哪个模型」，不是这家供应商叫什么。别把它填进 provider：
          save() 会拿这个值去发全局 rename，主对话模型里同一 baseUrl 那家的显示名会被一起改掉。
          框里按 baseUrl 回显已存名只是展示，提交值仍只有 f.provider；复用主模型那排 chips 同理。 */}
      <div className="preset-row">
        {group.presets.map((p) => (
          <button key={p.label} type="button" className="preset"
            aria-pressed={normBase(p.baseUrl) === normBase(f.baseUrl) ? "true" : "false"}
            onClick={() => setF((prev) => ({
              ...prev, baseUrl: p.baseUrl, name: prev.name || p.model || "",
              voice: prev.voice || p.voice || "",
            }))}>{p.label}</button>
        ))}
      </div>
      {reuse.length > 0 && (
        <div className="preset-row cap-reuse-row">
          <span className="preset-row-label">复用主模型已接入的（地址与密钥一起带过来）：</span>
          {reuse.map((r) => (
            <button key={r.baseUrl} type="button" className="preset"
              title={`接口地址与密钥照抄「${r.label}」在主对话模型里的配置`}
              aria-pressed={normBase(r.baseUrl) === normBase(f.baseUrl) ? "true" : "false"}
              onClick={() => setF((prev) => ({
                ...prev, baseUrl: r.baseUrl, apiKey: r.apiKey,
              }))}>{r.label}</button>
          ))}
        </div>
      )}
      <div className="form-row">
        <div className="field">
          <label>供应商名（可选）
            <input value={f.provider || savedProvider} onChange={set("provider")} placeholder="如 DeepSeek、硅基流动" maxLength={24} />
          </label>
          <div className="hint">按地址回显已存名；不动即不改，改了全局同步。</div>
        </div>
        <div className="field">
          <label>显示名
            <input value={f.label} onChange={set("label")} placeholder={f.name || "留空则用模型名"} maxLength={24} />
          </label>
        </div>
      </div>
      <div className="field">
        <label>接口地址
          <input value={f.baseUrl} onChange={set("baseUrl")} placeholder="https://api.example.com/v1" maxLength={500} required />
        </label>
        <div className="hint">填服务商给的地址，一般到 <code>/v1</code> 为止。</div>
      </div>
      <div className="field">
        <label>API 密钥
          <span className="key-wrap">
            <input value={f.apiKey} onChange={set("apiKey")} type={showKey ? "text" : "password"}
              placeholder="sk-..." autoComplete="new-password" maxLength={1000} />
            <button type="button" className="key-eye" aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              title={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((v) => !v)}>
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </span>
        </label>
      </div>
      <div className="form-row">
        <div className="field">
          <label>模型名
            <input value={f.name} onChange={set("name")} placeholder={group.modelHint} maxLength={200} required />
          </label>
          <button type="button" className="btn ghost sm" disabled={busy !== ""} onClick={() => void pull()}>
            {busy === "list" ? "拉取中…" : "从接口拉取"}
          </button>
          {ids !== null && (
            <div className="model-pick">
              <input className="model-filter" value={filter} aria-label="筛选模型名"
                placeholder={`在拉到的 ${ids.length} 个里筛…`} onChange={(e) => setFilter(e.target.value)} />
              <div className="model-pick-list">
                {shownIds.map((id) => (
                  <button key={id} type="button" title={id} onClick={() => setF((prev) => ({ ...prev, name: id }))}>{id}</button>
                ))}
                {shownIds.length === 0 && <div className="hint">没匹配到，清空筛选框就能看全部。</div>}
              </div>
              <div className="hint">显示 {shownIds.length} / {ids.length} 个 · 点一个填进模型名。</div>
            </div>
          )}
        </div>
        {group.hasVoice === true && (
          <div className="field">
            <label>音色（可选）
              <input value={f.voice} onChange={set("voice")} placeholder="如 alloy" maxLength={60} />
            </label>
          </div>
        )}
        <div className="field">
          <label>超时（秒）
            <input value={f.timeout} onChange={set("timeout")} type="number" inputMode="numeric"
              min={TIMEOUT_MIN_SEC} max={TIMEOUT_MAX_SEC} step={1} placeholder="90"
              aria-invalid={timeoutSecOf(f.timeout) === null} />
          </label>
          {timeoutSecOf(f.timeout) === null && <div className="hint bad">{TIMEOUT_HINT}。</div>}
        </div>
      </div>
      {msg && <p className={"onb-msg " + msg.kind} role="alert">{msg.text}</p>}
      <div className="add-row">
        <button type="button" className="btn ghost" disabled={busy !== ""} onClick={() => void test()}>
          {busy === "test" ? "测试中…" : "测试连接"}
        </button>
        <button type="button" className="primary" disabled={busy !== ""} onClick={() => void save()}>
          {busy === "save" ? "保存中…" : f.id ? "保存修改" : "存为端点档"}
        </button>
      </div>
    </Modal>
  );
}

/** 一张能力卡：能挑哪些档、在用哪一份、以及回到跟随主模型的出口。 */
function CapCard({ group, form }: { group: CapabilityPresetGroup; form: SettingsForm }): JSX.Element {
  const card = form.saved?.capabilities?.[group.name];
  const names = form.saved?.providerNames ?? {};
  const profiles = card?.profiles ?? [];
  const groups = groupByProvider(profiles, names);
  const activeId = card?.activeId ?? "";
  const linked = card?.linkedToMain === true;
  const ready = form.saved?.capabilitiesReady?.[group.name] === true;
  const active = profiles.find((p) => p.id === activeId) ?? null;
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  // 启用/删除档的结果走全局 toast：用户点完「使用中」把卡一折叠、或切个分组，
  // 结果也看得见。
  // 弹窗内的校验/试连提示（EndpointForm 的 msg）留在就地——用户正盯着表单。
  const run = (payload: Record<string, unknown>, ok: string): void => {
    setBusy(true);
    void settingsApi.capabilityProfile({ capability: group.name, ...payload })
      .then((snap) => { form.applySnapshot(snap); offerToast(ok, "ok"); })
      .catch((e: Error) => offerToast("没保存成：" + e.message, "error"))
      .finally(() => setBusy(false));
  };

  /** 挂在主模型档上的那张卡：选项就是那批档，按供应商排好（同一家挨着）。 */
  const pickOptions: PickOption[] = [
    { value: "", label: "跟随主模型（正在生效的那份）" },
    ...profilePicks(profiles, names),
    // 原先挑的那档被删掉了也要说清，不能把选择器显示成"没挑过"——那是骗人的清白。
    ...(activeId !== "" && !profiles.some((p) => p.id === activeId)
      ? [{ value: activeId, label: "原先挑的那档已经不在了（现在跟着主模型）", disabled: true }]
      : []),
  ];

  // 折叠标题要说清"现在实际用谁"、以及**它是从哪来的**：记忆提取和图片理解本来就能
  // 跟主模型共用一份档，没配是因为主模型还没接上；语音、绘图要的是各自端点上的模型名，
  // 拿聊天模型名去打 /audio、/images 只会失败，所以那种情况不能写成"跟随主模型"。
  const using = active
    ? `${providerTitle(groups.find((g) => g.models.some((m) => m.id === active.id)) ?? null, names)} · ${active.name || active.label}`
      + (linked ? "（选自主对话模型）" : "（这份端点档）")
    : ready
      ? `${card?.effective.model ?? ""}（跟随主模型）`
      : group.followsMain
        ? "未配置：先在「主对话模型」接一套模型"
        : "未配置：这类功能要专门的模型名，不能跟主模型共用";

  return (
    <details className="settings-panel cap-card">
      <summary className="cap-summary">
        <div className="cap-summary-main">
          <div className="cap-title-line">
            <span className="cap-title">{group.title}</span>
            <span className="cap-subtitle">{ready ? "配置完整，可以直接使用" : "尚未配置"}</span>
          </div>
          <div className="cap-using" id={"cap-" + group.name + "-using"}>{using}</div>
        </div>
        <span className={"cap-state " + (ready ? "on" : "off")} id={"cap-" + group.name + "-state"}>
          {ready ? "已就绪" : "未配置"}
        </span>
      </summary>

      <div className="cap-body">
        <p className="cap-body-desc">{group.desc}</p>
        {linked ? (
          <div className="cap-picker">
            <PickList label={group.title + "用哪一份主模型档"} value={activeId} options={pickOptions} disabled={busy}
              empty={profiles.length === 0 ? "「主对话模型」里还没有档" : "未选择"}
              onChange={(v) => run({ op: "activate", id: v }, v === "" ? "已回到跟随主模型" : "已改用选中的那一份")} />
            <span className="hint">从「主对话模型」已保存的端点档里选择；新增或删除请去上一页。</span>
          </div>
        ) : (
          <div className="cap-profile-list">
            {profiles.map((p) => (
              <span key={p.id} className={"cap-prof" + (p.id === activeId ? " on" : "")}>
                <button type="button" disabled={busy || p.id === activeId}
                  title={p.id === activeId ? "正在用这一份" : "换成这一份"}
                  onClick={() => run({ op: "activate", id: p.id }, `已换到「${p.label}」`)}>
                  {p.id === activeId ? "使用中 · " : ""}{p.label}
                </button>
                <button type="button" className="cap-prof-del" aria-label={`编辑 ${p.label}`} title="编辑"
                  disabled={busy} onClick={() => setEditing(draftOf(p, names[normBase(p.baseUrl)] ?? ""))}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="cap-prof-del" aria-label={`删除 ${p.label}`} title="删除这一份"
                  disabled={busy}
                  onClick={() => form.askDangerous(`删除端点档「${p.label}」？`,
                    "删掉这一张卡上的这一份；正在用的功能会改回跟随主模型，地址和密钥删掉就找不回来了。",
                    () => run({ op: "delete", id: p.id }, `已删除「${p.label}」`)) }>
                  <X size={12} />
                </button>
              </span>
            ))}
            {profiles.length === 0 && <span className="hint">还没存过端点档</span>}
          </div>
        )}

        <div className="cap-actions">
          {!linked && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => setEditing({ ...EMPTY })}>
              <Plus size={13} />添加端点
            </button>
          )}
          {!linked && activeId !== "" && (
            <button type="button" className="btn ghost sm" disabled={busy}
              onClick={() => run({ op: "activate", id: "" }, "已回到跟随主模型")}>
              跟随主模型
            </button>
          )}
        </div>
      </div>

      {editing !== null && (
        <EndpointForm group={group} initial={editing} names={names} reuse={reuseProvidersOf(form)} onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            // 弹窗关掉后结果只能交给全局 toast：banner 没有落点了。
            void settingsApi.fetchSettings()
              .then((snap) => { form.applySnapshot(snap); offerToast(text, "ok"); })
              .catch((e: Error) => offerToast("配置没刷新出来：" + e.message, "error"));
          }} />
      )}
    </details>
  );
}

/** 分区②：能力模型。五张卡同构——各自存几份端点档、点一份启用，一份都没启用就跟随主模型。 */
export default function CapabilitySection({ form }: { form: SettingsForm }): JSX.Element {
  const readyCount = CAPABILITY_GROUPS.filter((g) => form.saved?.capabilitiesReady?.[g.name] === true).length;
  return (
    <div className="section capability-section" id="settings-capabilities">
      <h2>能力模型</h2>
      <div className="desc">
        聊天、听音、说话、画图可以各配一个模型；图片理解卡只在主聊天模型不能看图时作为兜底，主模型自带视觉时不会被聊天调用。
      </div>
      <div className="settings-overview-strip">
        <span><b>{readyCount}</b> / {CAPABILITY_GROUPS.length} 项能力已就绪</span>
        <span>展开一项即可更换模型或新增端点档。</span>
      </div>
      <div className="settings-disclosure-list">
        {CAPABILITY_GROUPS.map((g) => <CapCard key={g.name} group={g} form={form} />)}
      </div>
    </div>
  );
}

