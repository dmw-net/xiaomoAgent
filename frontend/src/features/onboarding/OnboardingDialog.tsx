import { useCallback, useEffect, useState } from "react";
import Modal from "../../components/Modal";
import { activateProfile, fetchSettings, pingModel, provider as providerRename, saveProfile, saveSettings } from "../../api/settings";
import { contactsApi } from "../../api";
import { buildMd, parseMd, TEMPLATE } from "../../lib/persona-doc";
import { CAP_OFF, CHAT_PRESETS, CAPABILITY_GROUPS } from "../settings/presets";
import { OPTIONAL_CAPABILITIES, STEPS, resolveStep, stepIndex, type OnboardingStep } from "./steps";
import type { SettingsSnapshot } from "../../types";

type Ping = { ok?: boolean; elapsedMs?: number; message?: string };
type PingReply = { provider?: string; ping?: Ping; hint?: string };
type Msg = { kind: "ok" | "bad"; text: string };

const errText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const providerHost = (url: string): string => {
  try { return new URL(url).host || url; } catch { return url.replace(/^https?:\/\//, "").split("/")[0] || "自定义地址"; }
};

const localProvider = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)/i.test(url.trim());

/** 第 0 步：先说清楚叫你什么。联系方式与印象都会进提示词，空着对方只能泛称。 */
function OwnerStep({ initial, onSaved }: { initial: { name: string; impression: string }; onSaved: (next: SettingsSnapshot) => void }): JSX.Element {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const value = e.currentTarget.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      onSaved(await saveSettings({ owner: { name: form.name, impression: form.impression } }));
    } catch (error) {
      setMsg({ kind: "bad", text: errText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="onb-body" onSubmit={save}>
      <h3>怎么称呼你</h3>
      <p>这一项所有联系人共用。填了之后，回复里就会用这个称呼叫你。</p>
      <label>称呼
        <input value={form.name} onChange={set("name")} placeholder="如：阿樟 / 老板 / 小明" maxLength={24} autoFocus />
      </label>
      <label>一句话介绍自己（可留空）
        <textarea value={form.impression} onChange={set("impression")} rows={3} maxLength={2000}
          placeholder="职业、最近在忙什么、希望被怎么对待" />
      </label>
      {msg && <p className={"onb-msg " + msg.kind} role="alert">{msg.text}</p>}
      <div className="onb-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "保存中…" : "保存并继续"}</button>
      </div>
    </form>
  );
}

/**
 * 第一步：接上主模型。
 * 存的是一份**模型档 + 供应商名**并当场启用，而不是只写「当前生效」那一层——
 * 只写当前生效时 activeProfileId 恒为 null，联系人绑模型、记忆提取挑档、导出配置
 * 三个入口都会因为"没有档可挑"而空着，用户以为配好了其实少存了一层。
 */
function ModelStep({ onSaved }: { onSaved: (next: SettingsSnapshot) => void }): JSX.Element {
  const [form, setForm] = useState({ provider: "", baseUrl: "", apiKey: "", name: "" });
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);
  /** 拉回来的模型名：留全量，界面自己筛（不少服务商不开放列表端点，拉不到就直接填）。 */
  const [ids, setIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>): void => {
    // 值必须先取出来：updater 是 React 延到下一次的 render 才执行的，那时
    // e.currentTarget 已经被置空（实测：往密码框打第二个字符整弹窗直接崩）。
    const value = e.currentTarget.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const test = async (): Promise<void> => {
    setBusy("test");
    setMsg(null);
    try {
      const r = await pingModel({ baseUrl: form.baseUrl, apiKey: form.apiKey, model: form.name, want: "chat" }) as PingReply;
      if (r.hint) setMsg({ kind: "bad", text: r.hint });
      else if (r.ping?.ok) setMsg({ kind: "ok", text: `${r.provider ?? "这家"}通了，约 ${Math.round((r.ping.elapsedMs ?? 0) / 100) / 10} 秒` });
      else setMsg({ kind: "bad", text: `测不通：${r.ping?.message ?? "未知原因"}` });
    } catch (error) {
      setMsg({ kind: "bad", text: errText(error) });
    } finally {
      setBusy("");
    }
  };

  const pull = async (): Promise<void> => {
    setBusy("list");
    setMsg(null);
    try {
      const r = await pingModel({ baseUrl: form.baseUrl, apiKey: form.apiKey, want: "list" }) as
        { list?: { ok?: boolean; ids?: string[]; chatIds?: string[] }; hint?: string };
      const got = (r.list?.chatIds?.length ? r.list.chatIds : r.list?.ids) ?? [];
      if (r.list?.ok && got.length > 0) {
        setIds(got);
        setMsg({ kind: "ok", text: `拉到 ${got.length} 个模型，点一个填进模型名` });
      } else {
        setMsg({ kind: "bad", text: "这家不提供模型列表——不代表不能用，模型名直接填就行" });
      }
    } catch (error) {
      setMsg({ kind: "bad", text: errText(error) });
    } finally {
      setBusy("");
    }
  };

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy("save");
    setMsg(null);
    const baseUrl = form.baseUrl.trim();
    const provider = (form.provider.trim() || providerHost(baseUrl)).slice(0, 24);
    if (baseUrl === "") { setMsg({ kind: "bad", text: "先填接口地址" }); setBusy(""); return; }
    if (!localProvider(baseUrl) && form.apiKey.trim() === "") {
      setMsg({ kind: "bad", text: "远程服务需要 API Key；本地 Ollama 可以留空" });
      setBusy("");
      return;
    }
    try {
      // 三步走的都是设置页已有的端点，不为此新开一个接口：
      // 存成档 → 给这一家起名 → 启用这份档。少任何一步都会在设置页留下对不上的地方。
      const norm = baseUrl.replace(/\/+$/, "");
      const d1 = await saveProfile({
        // mode 一并写 openai：不切模式的话密钥填了也只会回演示回复——那是最让人困惑的「配了没用」。
        label: provider, mode: "openai", baseUrl: norm, apiKey: form.apiKey, name: form.name.trim(),
      });
      const created = [...(d1.profiles ?? [])].reverse()
        .find((p) => (p.baseUrl ?? "").replace(/\/+$/, "") === norm && p.name === form.name.trim());
      const d2 = await providerRename({ op: "rename", baseUrl: norm, label: provider });
      onSaved(created ? await activateProfile(created.id) : d2);
    } catch (error) {
      setMsg({ kind: "bad", text: errText(error) });
    } finally {
      setBusy("");
    }
  };

  const lq = filter.trim().toLowerCase();
  const shown = ids.filter((id) => lq === "" || id.toLowerCase().includes(lq));

  return (
    <form className="onb-body" onSubmit={save}>
      <h3>接入一个模型</h3>
      <p>选一家服务、填上密钥，联系人就能回话了；之后随时能在「设置 → 主对话模型」改，也能在同一家里再加模型。</p>
      <div className="onb-provider-grid" role="group" aria-label="常用供应商">
        {CHAT_PRESETS.map((p) => {
          const selected = form.baseUrl === p.baseUrl;
          return (
            <button key={p.label} type="button" aria-pressed={selected}
              className={"ml-provider-card" + (selected ? " on" : "")}
              onClick={() => setForm((f) => ({ ...f, provider: p.label, baseUrl: p.baseUrl, name: p.model ?? "" }))}>
              <span className="ml-provider-mark" aria-hidden="true">{p.label.slice(0, 1)}</span>
              <span className="ml-provider-copy"><b>{p.label}</b><small>{providerHost(p.baseUrl)}</small></span>
            </button>
          );
        })}
      </div>
      <p className="onb-proto">按服务商文档填接口地址（一般到 <code>/v1</code> 为止）；本地 Ollama 的 API Key 可以留空。</p>
      <label>供应商名
        <input value={form.provider} onChange={set("provider")} placeholder="留空会自动使用服务商名" maxLength={24} />
      </label>
      <label>接口地址
        <input value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://api.deepseek.com/v1"
          autoComplete="url" maxLength={500} required />
      </label>
      <label>API Key
        <input value={form.apiKey} onChange={set("apiKey")} placeholder="填所选服务的密钥"
          autoComplete="new-password" type="password" maxLength={1000} required={!localProvider(form.baseUrl)} />
      </label>
      <label>模型名
        <span className="onb-inline">
          <input value={form.name} onChange={set("name")} placeholder="如 deepseek-chat" autoComplete="off" maxLength={200} required />
          <button type="button" className="btn ghost sm" disabled={busy !== ""} onClick={() => void pull()}>
            {busy === "list" ? "拉取中…" : "从接口拉取"}
          </button>
        </span>
      </label>
      {shown.length > 0 && (
        <div className="model-pick">
          <input className="model-filter" value={filter} aria-label="筛选模型名"
            placeholder={`在拉到的 ${ids.length} 个里筛…`} onChange={(e) => setFilter(e.target.value)} />
          <div className="model-pick-list">
            {shown.map((id) => (
              <button key={id} type="button" title={id} onClick={() => setForm((f) => ({ ...f, name: id }))}>{id}</button>
            ))}
          </div>
          <p className="hint">显示 {shown.length} / {ids.length} 个 · 点一个填进上面那格</p>
        </div>
      )}
      {msg && <p className={"onb-msg " + msg.kind} role="alert">{msg.text}</p>}
      <div className="onb-actions">
        <button type="button" className="btn ghost" disabled={busy !== ""} onClick={() => void test()}>
          {busy === "test" ? "测试中…" : "先测一下"}
        </button>
        <button type="submit" className="btn primary" disabled={busy !== ""}>
          {busy === "save" ? "保存中…" : "保存并启用"}
        </button>
      </div>
    </form>
  );
}

/** 第二步：可选能力。整步跳过是正常选择——只用文字聊天的人不需要眼睛和耳朵。 */
function CapabilityStep({ snapshot, onSkip, onGoto }: {
  snapshot: SettingsSnapshot;
  onSkip: () => void;
  onGoto: () => void;
}): JSX.Element {
  const optional = CAPABILITY_GROUPS.filter((g) => OPTIONAL_CAPABILITIES.includes(g.name));
  const readyCount = OPTIONAL_CAPABILITIES.filter((n) => snapshot.capabilitiesReady?.[n] === true).length;
  return (
    <div className="onb-body">
      <h3>要不要配上眼睛和耳朵</h3>
      <p>看图、听语音、说话、画图为各用各的模型。用不上就不配——不配只是那些入口不出现，不影响聊天。</p>
      <ul className="onb-caps">
        {optional.map((g) => {
          const ready = snapshot.capabilitiesReady?.[g.name] === true;
          return (
            <li key={g.name}>
              <span className={ready ? "on" : "off"}>{ready ? "已配" : "未配"}</span>
              <span className="onb-cap-copy">
                <b>{g.title}</b>
                {!ready && <small>{CAP_OFF[g.name]}</small>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="onb-actions">
        <button type="button" className="btn ghost" onClick={onSkip}>这步跳过</button>
        <button type="button" className="btn primary" onClick={onGoto}>
          {readyCount > 0 ? "去设置里再看一眼" : "去配能力模型"}
        </button>
      </div>
    </div>
  );
}

/**
 * 第三步：要不要改人设。默认那份是替所有人写的口气，这一步让它更像你要的那个伙伴。
 * 写的就是联系人资料页「人格设定」那三段（走同一份 buildMd/parseMd，两处不会长成不同格式）；
 * 不改就按默认，之后随时能在 联系人 → 人格设定 改。
 */
function PersonaStep({ onSaved, onSkip }: { onSaved: () => void; onSkip: () => void }): JSX.Element {
  const [contactId, setContactId] = useState("");
  const [whoName, setWhoName] = useState("");
  const [original, setOriginal] = useState({ background: "", identity: "", relationship: "" });
  const [md, setMd] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [confirmTemplate, setConfirmTemplate] = useState(false);

  useEffect(() => {
    void contactsApi.fetchContact("default").then((d) => {
      const c = d.contact;
      const parts = {
        background: c.card.background ?? "",
        identity: c.card.identity ?? "",
        relationship: c.card.relationship ?? "",
      };
      setContactId(c.id);
      setWhoName(c.name);
      setOriginal(parts);
      setMd(buildMd({ name: c.name, ...parts }));
    }).catch((e: Error) => setLoadErr(e.message));
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    const parts = parseMd(md);
    // 段标题被删掉时 parseMd 只会给出空串——照原样存回去等于悄悄抹了人设。
    const lost = (Object.keys(original) as Array<keyof typeof original>)
      .filter((k) => original[k] !== "" && parts[k].trim() === "");
    if (lost.length > 0) {
      setMsg({ kind: "bad", text: `没解析出这几段：${lost.join("、")}。三行「## 背景 / ## 人设 / ## 与用户关系」这几个标题不能删。` });
      setBusy(false);
      return;
    }
    try {
      await contactsApi.updateContact(contactId, { name: whoName, ...parts });
      onSaved();
    } catch (error) {
      setMsg({ kind: "bad", text: errText(error) });
      setBusy(false);
    }
  };

  if (loadErr !== "") {
    return (
      <div className="onb-body">
        <h3>读不到{whoName || "联系人"}的人设</h3>
        <p>{loadErr}</p>
        <div className="onb-actions">
          <button type="button" className="btn ghost" onClick={onSkip}>先跳过</button>
        </div>
      </div>
    );
  }

  // 与初始内容逐字相同 = 还没动过，直接填模板；改过就先确认，避免覆盖手写内容。
  const untouched = md === buildMd({ name: whoName, ...original });
  const applyTemplate = (): void => {
    setMd(buildMd({ name: whoName, ...TEMPLATE }));
    setConfirmTemplate(false);
    setMsg(null);
  };

  return (
    <div className="onb-body">
      <h3>要不要改一下{whoName || "联系人"}的人设</h3>
      <p>这段决定说话的内容与口气：是谁、怎么相处、你们是什么关系。不知道写什么可以先用示例，再照着改。</p>
      <textarea className="onb-persona" rows={14} spellCheck={false} value={md}
        aria-label="人格文档" onChange={(e) => setMd(e.target.value)} />
      {msg && <p className={"onb-msg " + msg.kind} role="alert">{msg.text}</p>}
      <div className="onb-actions">
        <button type="button" className="btn ghost sm" onClick={() => { if (untouched) applyTemplate(); else setConfirmTemplate(true); }}>
          按模板填写
        </button>
        <button type="button" className="btn ghost" onClick={onSkip}>用默认的</button>
        <button type="button" className="btn primary" disabled={busy || contactId === ""} onClick={() => void save()}>
          {busy ? "保存中…" : "保存并继续"}
        </button>
      </div>
      {confirmTemplate && (
        <Modal onClose={() => setConfirmTemplate(false)} label="用示例人设覆盖？" className="onb-card" placement="center">
          <div className="onb-body">
            <h3>用示例人设覆盖当前内容？</h3>
            <p>三段人设会整组换成示例模板，你写的版本会被替换；可以在示例基础上继续改。</p>
            <div className="onb-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirmTemplate(false)}>取消</button>
              <button type="button" className="btn primary" onClick={applyTemplate}>用模板覆盖</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReadyStep({ onFinish, busy }: { onFinish: () => void; busy: boolean }): JSX.Element {
  return (
    <div className="onb-body">
      <h3>现在可以开始了</h3>
      <p>在下面输入框里说一句话试试。说过的话会被记成长期记忆，安静太久时联系人也会主动来问一句——
        主动性、记忆、人设都在联系人资料页里配。</p>      <div className="onb-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={onFinish}>
          {busy ? "收尾中…" : "开始聊天"}
        </button>
      </div>
    </div>
  );
}

/**
 * 首次设置弹窗。当前该做哪一步由状态推导（steps.ts）：缺什么问什么，
 * 不是让人一步步点的向导——模型一填好就直接落到能力那步。
 * 快照自己拉、自己刷：App 只决定开不开，不替它养一份状态。
 */
export default function OnboardingDialog({ onClose, onFinished, onGotoCapabilities }: {
  onClose: () => void;
  onFinished: () => void;
  onGotoCapabilities: () => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [failed, setFailed] = useState("");
  const [manual, setManual] = useState<OnboardingStep | null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    void fetchSettings().then(setSnapshot).catch((e: unknown) => setFailed(errText(e)));
  }, []);

  // ⚠️ 这里必须是**原始值**，不能把 derived 对象直接写进依赖：
  // resolveStep 每轮渲染都返回一个新对象字面量，引用必然变，于是下面那个 effect
  // 每次渲染后都跑一遍 setManual(null)——「上一步」和两个「跳过」全是死的，
  // 用户卡在能力那一步出不去（只能关掉重开）。
  const derivedKey = snapshot === null
    ? ""
    : JSON.stringify({
        ownerName: snapshot.persona?.owner?.name ?? "",
        modelReady: snapshot.modelReady,
        capabilitiesReady: snapshot.capabilitiesReady,
        personaIsDefault: snapshot.personaIsDefault,
      });
  // 缺口一变（比如刚存好模型），手动停留的位置就作废，指针跟状态走。
  useEffect(() => { setManual(null); }, [derivedKey]);

  const finish = useCallback((): void => {
    setFinishing(true);
    void saveSettings({ onboarding: { completed: true } })
      .then((next) => { setSnapshot(next); onFinished(); })
      .catch((e: unknown) => { setFailed(errText(e)); setFinishing(false); });
  }, [onFinished]);

  /** 人设在联系人表里，不在 settings 快照里：保存后重拉一次（personaIsDefault 跟着变），再落到下一步。 */
  const refreshSnapshot = useCallback(async (next: OnboardingStep): Promise<void> => {
    try {
      setSnapshot(await fetchSettings());
      setManual(next);
    } catch (e: unknown) { setFailed(errText(e)); }
  }, []);

  if (failed !== "" && snapshot === null) {
    return (
      <Modal onClose={onClose} label="首次设置" className="onb-card">
        <div className="onb-body">
          <h3>读不到当前配置</h3>
          <p>{failed}</p>
          <div className="onb-actions"><button type="button" className="btn primary" onClick={onClose}>先关掉</button></div>
        </div>
      </Modal>
    );
  }

  // derived 从快照现算（便宜），effect 只认 derivedKey——两者分工：
  // 一个给渲染用，一个给"什么时候作废手动位置"当判据。
  const derived: OnboardingStep | null = snapshot === null ? null : resolveStep({
    ownerName: snapshot.persona?.owner?.name ?? "",
    modelReady: snapshot.modelReady,
    capabilitiesReady: snapshot.capabilitiesReady,
    personaIsDefault: snapshot.personaIsDefault,
  });
  const step: OnboardingStep = manual ?? derived ?? "owner";
  const active = stepIndex(step);
  const prev = active > 0 ? STEPS[active - 1] : undefined;

  return (
    <Modal onClose={onClose} label="首次设置" className="onb-card">
      <div className="onb-head">
        <h2>开始使用 <span className="onb-time">约 3 分钟</span></h2>
        <ol className="onb-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={i === active ? "on" : i < active ? "done" : ""}>
              <b>{i < active ? "✓" : i + 1}</b>{s.label}
            </li>
          ))}
        </ol>
      </div>
      {snapshot === null
        ? <div className="onb-body"><p>读取当前配置…</p></div>
        : step === "owner"
          ? <OwnerStep onSaved={setSnapshot} initial={{
              name: snapshot.persona?.owner?.name ?? "",
              impression: snapshot.persona?.owner?.impression ?? "",
            }} />
          : step === "model"
          ? <ModelStep onSaved={setSnapshot} />
          : step === "capability"
            // 跳过能力不等于跳过人设：那一问排在后面，跳过这步就走到那步。
            ? <CapabilityStep snapshot={snapshot} onSkip={() => setManual("persona")} onGoto={onGotoCapabilities} />
            : step === "persona"
              ? <PersonaStep onSkip={() => setManual("ready")} onSaved={() => void refreshSnapshot("ready")} />
              : <ReadyStep onFinish={finish} busy={finishing} />}
      {failed !== "" && snapshot !== null && <p className="onb-msg bad" role="alert">{failed}</p>}
      <div className="onb-foot">
        {prev
          ? <button type="button" className="btn ghost sm" onClick={() => setManual(prev.id)}>上一步</button>
          : <span />}
        {/* 「稍后设置」不写完成标记：那是"还没弄完"，下次开还在。 */}
        <button type="button" className="btn ghost sm" onClick={onClose}>稍后设置</button>
      </div>
    </Modal>
  );
}
