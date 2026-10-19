import { useState } from "react";
import { Eye, EyeOff, Pencil, Plus, X } from "lucide-react";
import Modal from "../../components/Modal";
import PickList, { type PickOption } from "../../components/PickList";
import { settingsApi } from "../../api";
import { CAPABILITY_GROUPS, type CapabilityPresetGroup } from "./presets";
import { groupByProvider, normBase, profilePicks, providerTitle } from "../../lib/providers";
import type { CapabilityEndpoint } from "../../types";
import type { SettingsForm } from "./useSettingsForm";

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
  timeout: string;
};

const EMPTY: Draft = { id: null, label: "", provider: "", baseUrl: "", apiKey: "", name: "", voice: "", timeout: "90000" };

const draftOf = (p: CapabilityEndpoint, provider: string): Draft => ({
  id: p.id,
  label: p.label,
  provider,
  baseUrl: p.baseUrl ?? "",
  apiKey: p.apiKey ?? "",
  name: p.name ?? "",
  voice: p.voice ?? "",
  timeout: String(p.timeoutMs ?? 90_000),
});

type Banner = { kind: "ok" | "bad"; text: string } | null;

/** 添加 / 编辑一份端点档：服务商 chips 填地址与常用模型名，可先测再存。 */
function EndpointForm({ group, initial, names, onClose, onSaved }: {
  group: CapabilityPresetGroup;
  initial: Draft;
  names: Record<string, string>;
  onClose: () => void;
  onSaved: (text: string) => void;
}): JSX.Element {
  const [f, setF] = useState<Draft>(initial);
  const [busy, setBusy] = useState<"" | "save" | "test" | "list">("");
  const [msg, setMsg] = useState<Banner>(null);
  const [ids, setIds] = useState<string[] | null>(null);
  const [showKey, setShowKey] = useState(false);
  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>): void => {
    // 值先取出来再更新：updater 要等下一次 render 才跑，那时 currentTarget 已经空了。
    const value = e.currentTarget.value;
    setF((prev) => ({ ...prev, [key]: value }));
  };

  const test = async (): Promise<void> => {
    setBusy("test");
    setMsg(null);
    try {
      const r = await settingsApi.testCapability({
        capability: group.name, baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.name, timeoutMs: Number(f.timeout),
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
      if (r.list?.ok) setIds(r.list.ids ?? []);
      else setMsg({ kind: "bad", text: "没拉到这个服务商的模型清单，可以直接填模型名。" });
    } catch (e: unknown) {
      setMsg({ kind: "bad", text: errText(e) });
    } finally {
      setBusy("");
    }
  };

  const save = async (): Promise<void> => {
    setBusy("save");
    setMsg(null);
    try {
      await settingsApi.capabilityProfile({
        capability: group.name, op: "save", id: f.id ?? undefined,
        label: f.label.trim() === "" ? f.name.trim() : f.label.trim(),
        baseUrl: f.baseUrl, apiKey: f.apiKey, name: f.name, voice: f.voice, timeoutMs: Number(f.timeout),
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
      <div className="preset-row">
        {group.presets.map((p) => (
          <button key={p.label} type="button" className="preset"
            aria-pressed={normBase(p.baseUrl) === normBase(f.baseUrl) ? "true" : "false"}
            onClick={() => setF((prev) => ({
              ...prev, baseUrl: p.baseUrl, name: prev.name || p.model || "",
              voice: prev.voice || p.voice || "", provider: prev.provider || p.label,
            }))}>{p.label}</button>
        ))}
      </div>
      <div className="form-row">
        <div className="field">
          <label>供应商名（可选）
            <input value={f.provider} onChange={set("provider")} placeholder="如 DeepSeek、硅基流动" maxLength={24} />
          </label>
          <div className="hint">填个名字方便认；不填就用这家第一个模型的名字。</div>
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
              {ids.slice(0, 80).map((id) => (
                <button key={id} type="button" title={id} onClick={() => setF((prev) => ({ ...prev, name: id }))}>{id}</button>
              ))}
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
            <input value={f.timeout} onChange={set("timeout")} type="number" min={1} max={600} />
          </label>
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
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const run = (payload: Record<string, unknown>, ok: string): void => {
    setBusy(true);
    setBanner(null);
    void settingsApi.capabilityProfile({ capability: group.name, ...payload })
      .then((snap) => { form.applySnapshot(snap); setBanner({ kind: "ok", text: ok }); })
      .catch((e: Error) => setBanner({ kind: "bad", text: e.message }))
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
    <details className="card card-pad cap-card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <div className="cap-head">
          <div>
            <div className="subhead">{group.title}</div>
            <div className="hint">{group.desc}</div>
            <div className="hint cap-using" id={"cap-" + group.name + "-using"}>现在用：{using}</div>
          </div>
          <span className={"cap-state " + (ready ? "on" : "off")} id={"cap-" + group.name + "-state"}>
            {ready ? "已就绪" : "未配置"}
          </span>
        </div>
        {linked ? (
          <div className="preset-row cap-pro-row" onClick={(e) => { e.preventDefault(); }}>
            <PickList label={group.title + "用哪一份主模型档"} value={activeId} options={pickOptions} disabled={busy}
              empty={profiles.length === 0 ? "「主对话模型」里还没有档" : "未选择"}
              onChange={(v) => run({ op: "activate", id: v }, v === "" ? "已回到跟随主模型" : "已改用选中的那一份")} />
            <span className="hint">选的就是「主对话模型」里存的那几份；要加或删去那一页。</span>
          </div>
        ) : (
          <div className="preset-row cap-pro-row" onClick={(e) => e.preventDefault()}>
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
      </summary>

      {banner && <div className={"banner show " + banner.kind}><div className="body">{banner.text}</div></div>}
      <div className="actions">
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
      {editing !== null && (
        <EndpointForm group={group} initial={editing} names={names} onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            void settingsApi.fetchSettings()
              .then((snap) => { form.applySnapshot(snap); setBanner({ kind: "ok", text }); })
              .catch((e: Error) => setBanner({ kind: "bad", text: e.message }));
          }} />
      )}
    </details>
  );
}

/** 分区②：能力模型。五张卡同构——各自存几份端点档、点一份启用，一份都没启用就跟随主模型。 */
export default function CapabilitySection({ form }: { form: SettingsForm }): JSX.Element {
  return (
    <div className="section">
      <h2>能力模型</h2>
      <div className="desc">
        聊天、看图、听音、说话、画图可以各配一个模型；不配就跟着主模型走。
        语音和画图例外——要填各自的模型，用聊天的模型名会失败。
      </div>
      {CAPABILITY_GROUPS.map((g) => <CapCard key={g.name} group={g} form={form} />)}
    </div>
  );
}
