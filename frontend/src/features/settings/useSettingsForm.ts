import { useCallback, useEffect, useState } from "react";
import { settingsApi } from "../../api";
import { DATA_WIPED_EVENT, SETTINGS_CHANGED_EVENT } from "../../lib/ui-prefs";
import type { ModelCaps, SettingsSnapshot, ThinkingModeId, ThinkingParamId } from "../../types";

type Banner = { kind: string; text: string } | null;

/** 一份能力卡片的表单值（全是字符串，保存时才转数字/清值）。 */
/** 添加/编辑模型档的表单载荷。 */
export type ProfileInput = {
  id: string | null;
  label: string;
  baseUrl: string;
  key: string;
  name: string;
  timeoutMs: string;
  extraBody: string;
  caps: ModelCaps;
  /** "" = 跟随模型。 */
  thinkingLevel: string;
  thinkingLevels: string[];
  /** 思考参数形态，见 ModelSettings.thinkingParam。 */
  thinkingParam: ThinkingParamId;
  /** 开关系形态（模板系 / 火山系）的显式意图，"" = 跟随模型。 */
  thinkingMode: ThinkingModeId;
  /** token 上限，空串 = 不填。 */
  maxInput: string;
  maxOutput: string;
};

/**
 * 设置页的全部表单状态与动作，集中在一个 hook 里。
 * 每个 tab 自己保存自己；模型相关全部围绕「档」进行（列表 + 添加/编辑/应用/删除），
 * 不再有一张裸的全局表单和一根「保存全部」横杆。
 */
export function useSettingsForm(onChanged: () => void): {
  saved: SettingsSnapshot | null;
  loadErr: string;
  busy: string;
  reload: () => void;
  modelBanner: Banner;
  setModelBanner: (b: Banner) => void;
  personaBanner: Banner;
  modelList: { show: boolean; ids: string[] };
  /** 危险操作确认弹窗的状态与动作，由 SettingsView 渲染成 <Modal>。 */
  ask: { title: string; note: string; run: () => void } | null;
  askDangerous: (title: string, note: string, run: () => void) => void;
  acceptAsk: () => void;
  cancelAsk: () => void;
  // 全局用户资料
  oName: string; setOName: (v: string) => void;
  oImpression: string; setOImpression: (v: string) => void;
  oNotes: string; setONotes: (v: string) => void;
  oGender: string; setOGender: (v: string) => void;
  // 动作（模型相关全部围绕「档」：测试/保存/应用/删除都显式传参）
  testModel: (input: { baseUrl: string; key: string; name: string }) => void;
  /** 拉模型列表填模型名，和「测试连接」是两件事。 */
  fetchModelList: (input: { baseUrl: string; key: string }) => void;
  saveModelProfile: (input: ProfileInput) => void;
  applyProfile: (id: string) => void;
  deleteProfile: (id: string, label: string) => void;
  testProfile: (id: string) => void;
  profileTestResult: Record<string, { kind: "ok" | "bad"; text: string } | undefined>;
  setEchoMode: (on: boolean) => void;
  /** 写接口拿回来的新快照直接灌进表单状态。给不经本 hook 的局部动作（供应商层改名/同步）用。 */
  applySnapshot: (d: SettingsSnapshot) => void;
  saveOwner: () => void;
  resetAll: () => void;
  /** 比「恢复默认」狠一档：连对话、记忆、画作、绑定一起清，再重新种子内置联系人。 */
  factoryResetAll: () => void;
  saveOwnerAvatar: (dataUrl: string) => Promise<void>;
} {
  const [saved, setSaved] = useState<SettingsSnapshot | null>(null);
  const [loadErr, setLoadErr] = useState("");


  const [oName, setOName] = useState("");
  const [oImpression, setOImpression] = useState("");
  const [oNotes, setONotes] = useState("");
  // 缺省空 = 没设性别，提示词里对用户的代词走中性「TA」（见后端 ownerPronoun）
  const [oGender, setOGender] = useState("");

  const [modelBanner, setModelBanner] = useState<Banner>(null);
  const [personaBanner, setPersonaBanner] = useState<Banner>(null);
  const [profileTestResult, setProfileTestResult] = useState<Record<string, { kind: "ok" | "bad"; text: string } | undefined>>({});
  /**
   * 危险操作的确认一律走应用内的居中弹窗（<Modal>），不再用 window.confirm：
   * 项目里删消息、归档、删画、解绑微信早就都是弹窗了，原生 confirm 在 iOS Safari 上
   * 长成另一个样子，而且 `\n` 排出来的说明没人看得下去。
   */
  const [ask, setAsk] = useState<{ title: string; note: string; run: () => void } | null>(null);
  const askDangerous = useCallback((title: string, note: string, run: () => void): void => { setAsk({ title, note, run }); }, []);
  const acceptAsk = useCallback((): void => {
    setAsk((a) => { a?.run(); return null; });
  }, []);
  const cancelAsk = useCallback((): void => { setAsk(null); }, []);
  const [modelList, setModelList] = useState<{ show: boolean; ids: string[] }>({ show: false, ids: [] });
  const [busy, setBusy] = useState("");

  const fill = useCallback((data: SettingsSnapshot): void => {
    setSaved(data);
    const owner = data.persona?.owner ?? {};
    setOName(owner.name ?? "");
    setOImpression(owner.impression ?? "");
    setONotes(owner.notes ?? "");
    setOGender(owner.gender ?? "");
  }, []);

  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = (): void => { setLoadErr(""); setReloadNonce((n) => n + 1); };

  useEffect(() => {
    void settingsApi.fetchSettings().then(fill).catch((e: Error) => setLoadErr(e.message));
  }, [fill, reloadNonce]);

  // 导入模型档不进本快照：它跑完广播一句，这里重拉一次，
  // 否则同一页上「全局默认：xxx」和刚导入的档会各说一段历史。
  useEffect(() => {
    const refetch = (): void => { void settingsApi.fetchSettings().then(fill).catch(() => undefined); };
    window.addEventListener(SETTINGS_CHANGED_EVENT, refetch);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, refetch);
  }, [fill]);

  const collectOwner = useCallback(() => ({
    name: oName.trim(),
    impression: oImpression,
    notes: oNotes,
    gender: oGender,
  }), [oGender, oImpression, oName, oNotes]);

  /** 试连：用表单里还没保存的参数直接打，通了再保存。密钥留空 = 沿用已存的。 */
  const testModel = (input: { baseUrl: string; key: string; name: string }): void => {
    setBusy("test");
    setModelBanner(null);
    settingsApi.pingModel({
      baseUrl: input.baseUrl.trim(),
      apiKey: input.key.trim(),
      model: input.name.trim(),
      want: "chat",
    })
      .then((data) => {
        if (!data.modelReady) {
          setModelBanner({ kind: "bad", text: String(data.hint || "还不能调用模型") });
          return;
        }
        const pingRes = data.ping as { ok?: boolean; elapsedMs?: number; text?: string; message?: string; code?: string } | undefined;
        if (pingRes && pingRes.ok) {
          setModelBanner({ kind: "ok", text: `连上了${pingRes.elapsedMs != null ? ` · ${pingRes.elapsedMs}ms` : ""}，模型回了：「${(pingRes.text || "").slice(0, 30)}」` });
        } else if (pingRes) {
          setModelBanner({ kind: "bad", text: "没连上：" + (pingRes.message || pingRes.code || "")
            + "。有时服务商不报错、只是没反应——那多半是这个模型名在这里用不了。" });
        }
      })
      .catch((e: Error) => setModelBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  /** 拉模型列表：只为填模型名。它和"能不能用"是两件事——不开放列表端点的服务商很多。 */
  const fetchModelList = (input: { baseUrl: string; key: string }): void => {
    setBusy("list");
    setModelBanner(null);
    setModelList({ show: false, ids: [] });
    settingsApi.pingModel({ baseUrl: input.baseUrl.trim(), apiKey: input.key.trim(), want: "list" })
      .then((data) => {
        if (!data.modelReady) {
          setModelBanner({ kind: "bad", text: String(data.hint || "还缺接口地址或密钥") });
          return;
        }
        const list = data.list as { ok?: boolean; ids?: string[]; chatIds?: string[]; elapsedMs?: number; message?: string; code?: string } | undefined;
        if (list && list.ok) {
          // 全量留下，不截断：从前砍到 24 个，剩下的 298 个用户在界面里根本够不着，
          // 只能回去手打。清单现在自己可搜、限高滚动，交得下三百条。
          const ids = list.chatIds && list.chatIds.length ? list.chatIds : list.ids ?? [];
          setModelList({ show: ids.length > 0, ids });
          setModelBanner({ kind: "ok", text: `拉到 ${ids.length} 个模型：输入即筛，点一个填上。` });
        } else {
          setModelBanner({ kind: "bad", text: "没拉到清单。这不代表模型不能用——很多服务商不提供这个，直接填模型名再测。" });
        }
      })
      .catch((e: Error) => setModelBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  /** 保存一档模型（id=null 新建；带 id 更新）。密钥留空 = 不动原值。 */
  const saveModelProfile = (input: ProfileInput): void => {
    setBusy("prof");
    setModelBanner(null);
    const payload: Record<string, unknown> = {
      label: input.label.trim(),
      mode: "openai",
      baseUrl: input.baseUrl.trim(),
      name: input.name.trim(),
      timeoutMs: Number(input.timeoutMs) || 90000,
      extraBody: input.extraBody,
      caps: input.caps,
      thinkingLevel: input.thinkingLevel,
      thinkingLevels: input.thinkingLevels,
      thinkingParam: input.thinkingParam,
      thinkingMode: input.thinkingMode,
      maxInputTokens: Number(input.maxInput) || 0,
      maxOutputTokens: Number(input.maxOutput) || 0,
    };
    const key = input.key.trim();
    if (key !== "") payload.apiKey = key;
    if (input.id) payload.id = input.id;
    settingsApi.saveProfile(payload)
      .then((d) => {
        fill(d);
        setModelBanner({ kind: "ok", text: d.note || "模型配置已保存" });
      })
      .catch((e: Error) => setModelBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  const applyProfile = (id: string): void => {
    setBusy("prof");
    setModelBanner(null);
    settingsApi.activateProfile(id)
      .then((d) => { fill(d); setModelBanner({ kind: "ok", text: d.note || "已启用这个模型" }); })
      .catch((e: Error) => setModelBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  /** 列表行的快速测速：结果不进全局 banner，落在对应行上。 */
  const testProfile = (id: string): void => {
    setBusy("test:" + id);
    setProfileTestResult((prev) => ({ ...prev, [id]: undefined }));
    settingsApi.testProfile(id)
      .then((d) => setProfileTestResult((prev) => ({
        ...prev,
        [id]: d.pass
          ? { kind: "ok", text: `连上了${d.elapsedMs != null ? ` · ${d.elapsedMs}ms` : ""}（回了「${(d.text || "").slice(0, 12)}」）` }
          : { kind: "bad", text: ("连不上：" + (d.error || "失败")).slice(0, 80) },
      })))
      .catch((e: Error) => setProfileTestResult((prev) => ({ ...prev, [id]: { kind: "bad", text: e.message.slice(0, 80) } })))
      .finally(() => setBusy(""));
  };

  const deleteProfile = (id: string, label: string): void => {
    askDangerous(`删除模型「${label}」？`, "正在用的不受影响；指定了这个模型的联系人会改用全局默认。", () => doDeleteProfile(id));
  };

  const doDeleteProfile = (id: string): void => {
    setBusy("prof");
    setModelBanner(null);
    settingsApi.deleteProfile(id)
      .then((d) => { fill(d); setModelBanner({ kind: "ok", text: d.note || "已删除" }); })
      .catch((e: Error) => setModelBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  /** Echo 调试开关：只动 mode 一个字段，其余配置原样。 */
  const setEchoMode = (on: boolean): void => {
    setBusy("mode");
    setModelBanner(null);
    settingsApi.saveSettings({ model: { mode: on ? "echo" : "openai" } })
      .then((d) => {
        fill(d);
        setModelBanner({ kind: "ok", text: on ? "已切到演示模式。" : "已退出演示模式。" });
      })
      .catch((e: Error) => setModelBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  const saveOwner = (): void => {
    setBusy("owner");
    settingsApi.saveSettings({ owner: collectOwner() })
      .then((d) => {
        fill(d);
        setPersonaBanner({ kind: "ok", text: "资料已保存，立即生效。" });
        onChanged();
      })
      .catch((e: Error) => setPersonaBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  const resetAll = (): void => {
    askDangerous("重置设置？", "会清掉你改过的全部设置，回到刚装好时的样子。联系人和聊天记录不受影响。", () => doResetAll());
  };

  const doResetAll = (): void => {
    setBusy("reset");
    settingsApi.resetSettings()
      .then((d) => { fill(d); setPersonaBanner({ kind: "ok", text: "已恢复默认。" }); })
      .catch((e: Error) => setPersonaBanner({ kind: "bad", text: e.message }))
      .finally(() => setBusy(""));
  };

  /**
   * 恢复出厂设置：比「恢复默认」狠一档——那个只清设置覆盖值，这个连对话、记忆、画作、
   * 微信绑定、联系人本身一起清掉，然后重新种子内置联系人。
   * 确认文案里逐项列清楚丢什么：一句话的「确定吗」挡不住不可逆。
   */
  const factoryResetAll = (): void => askDangerous(
    "全部清空？",
    "这一步找不回来，会清掉：所有聊天和长期记忆、画过的画、模型和密钥、各项设置、微信绑定。相当于第一次打开这个应用。",
    () => {
      setBusy("reset");
      settingsApi.factoryReset()
        .then((d) => {
          fill(d);
          // 联系人全变了：侧栏/会话列表那份缓存必须重拉，否则还显示着已经被清掉的人。
          window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
          // 会话页那份消息种子也得作废：库被 DELETE 过了，AUTOINCREMENT 不复位，
          // 没有任何 id 变化能提醒它"这些行已经不存在"。不清的话切回对话页，
          // 那一整段被清掉的对话会原样重现，直到第一次拉取落地（拉取失败就永远留着）。
          window.dispatchEvent(new Event(DATA_WIPED_EVENT));
          onChanged();
          setPersonaBanner({ kind: "ok", text: d.note || "已恢复出厂设置。" });
        })
        .catch((e: Error) => setPersonaBanner({ kind: "bad", text: e.message }))
        .finally(() => setBusy(""));
    },
  );

  /** 换我的头像：上传 → 存全局 owner → 快照同步。 */
  const saveOwnerAvatar = async (dataUrl: string): Promise<void> => {
    const d = await settingsApi.saveSettings({ owner: { avatar: dataUrl } });
    fill(d);
  };

  return {
    saved, loadErr, busy, reload, modelBanner, setModelBanner, personaBanner, modelList,
    oName, setOName, oImpression, setOImpression, oNotes, setONotes, oGender, setOGender,
    testModel, fetchModelList, saveModelProfile, applyProfile, deleteProfile, testProfile, profileTestResult, setEchoMode,
    ask, askDangerous, acceptAsk, cancelAsk,
    applySnapshot: fill,
    saveOwner, resetAll, factoryResetAll, saveOwnerAvatar,
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
