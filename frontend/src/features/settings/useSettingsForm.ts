import { useCallback, useEffect, useRef, useState } from "react";
import { settingsApi, storageApi } from "../../api";
import { DATA_WIPED_EVENT, SETTINGS_CHANGED_EVENT } from "../../lib/ui-prefs";
import { offerToast } from "../../lib/toast";
import type { EmoteFrequency, ModelCaps, SettingsSnapshot, ThinkingModeId, ThinkingParamId } from "../../types";

type Banner = { kind: string; text: string } | null;

/** 错误文案的统一取法：Axios/接口层抛的未必是 Error 实例，别让 "[object Object]" 进提示。 */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 一份能力卡片的表单值（全是字符串，保存时才转数字/清值）。 */
/** 添加/编辑模型档的表单载荷。 */
export type ProfileInput = {
  id: string | null;
  label: string;
  baseUrl: string;
  key: string;
  name: string;
  /** 超时（毫秒字符串）：界面按「秒」填，调用方用 timeoutSecOf 校验并 ×1000 后传进来。 */
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
 * 超时的统一口径：界面按「秒」说话（1~600 的整数），落库仍是毫秒（timeoutMs）。
 * 保存/测试前先过 timeoutSecOf，非法或空值给行内提示并拦下，不做静默兜底。
 */
export const TIMEOUT_MIN_SEC = 1;
export const TIMEOUT_MAX_SEC = 600;
export const TIMEOUT_HINT = `超时需要 ${TIMEOUT_MIN_SEC}~${TIMEOUT_MAX_SEC} 之间的整数（秒）`;
/** 合法时返回整数秒，非法/空返回 null。别拿 0 当哨兵——0 是个会真实出现的坏值。 */
export const timeoutSecOf = (raw: string): number | null => {
  const t = Number(raw);
  return raw.trim() !== "" && Number.isInteger(t) && t >= TIMEOUT_MIN_SEC && t <= TIMEOUT_MAX_SEC ? t : null;
};

/**
 * 设置页的全部表单状态与动作，集中在一个 hook 里。
 * 每个 tab 自己保存自己；模型相关全部围绕「档」进行（列表 + 添加/编辑/应用/删除），
 * 没有一张裸的全局表单，也没有一根「保存全部」横杆。
 *
 * 反馈口径（为什么要分层）：
 * - 纯结果类（保存成功/失败）一律 offerToast 走全局轻提示——就地 banner 绑在某个
 *   分区上，用户点完保存立刻切分组就看不见了，统一收敛到跨视图的出口。
 * - 带上下文/差异信息的诊断（试连结果、拉模型清单）留在就地 banner：用户正盯着
 *   表单等结果，且文案里带「下一步怎么办」，toast 3 秒读不完就没了。
 * - 所有异步动作 try/finally 管理 busy，无论成败 busy 都会复位；失败在 hook 内
 *   toast 报因并吞掉（返回 null/false 区分成败），调用方不必各自 .catch。
 */
export function useSettingsForm(onChanged: () => void): {
  saved: SettingsSnapshot | null;
  loadErr: string;
  busy: string;
  reload: () => void;
  modelBanner: Banner;
  setModelBanner: (b: Banner) => void;
  /** 保存全局工具循环轮次；失败已 toast 报因，返回 null 让调用方别把成功链跑下去。 */
  saveToolLoopTurns: (turns: number) => Promise<number | null>;
  /** 保存全局表情使用倾向；失败已 toast 报因，返回 null 让调用方别把成功链跑下去。 */
  saveEmoteFrequency: (frequency: EmoteFrequency) => Promise<EmoteFrequency | null>;
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
  /** 清掉上一轮拉取的模型清单，避免打开另一家时看到过期的候选。 */
  resetModelList: () => void;
  /** 保存成功时返回 true；调用方据此决定是否关闭弹窗，失败时保留现场。 */
  saveModelProfile: (input: ProfileInput) => Promise<boolean>;
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
  /** 换我的头像。失败已 toast 报因、不抛错，返回 false 让调用方别把成功链跑下去。 */
  saveOwnerAvatar: (dataUrl: string) => Promise<boolean>;
} {
  const [saved, setSaved] = useState<SettingsSnapshot | null>(null);
  const [loadErr, setLoadErr] = useState("");


  const [oName, setOName] = useState("");
  const [oImpression, setOImpression] = useState("");
  const [oNotes, setONotes] = useState("");
  // 默认中性指代；提示词里对用户统一走「TA」（见后端 ownerPronoun）
  const [oGender, setOGender] = useState("other");

  const [modelBanner, setModelBanner] = useState<Banner>(null);
  // personaBanner / resetBanner 已随「结果提示收敛到全局 toast」一并撤掉：
  // 这两个就地 banner 分别绑在「我的资料」分区和设置页头部，用户点完保存切分组
  // 就看不见；「按钮在系统页、提示也要落在系统页」那类补丁到 toast 出口为止。
  const [profileTestResult, setProfileTestResult] = useState<Record<string, { kind: "ok" | "bad"; text: string } | undefined>>({});
  /**
   * 危险操作的确认一律走应用内的居中弹窗（<Modal>），不用 window.confirm：
   * 项目里删消息、归档、删画、解绑微信都是弹窗，原生 confirm 在 iOS Safari 上
   * 长成另一个样子，而且 `\n` 排出来的说明没人看得下去。
   */
  const [ask, setAsk] = useState<{ title: string; note: string; run: () => void } | null>(null);
  const askDangerous = useCallback((title: string, note: string, run: () => void): void => { setAsk({ title, note, run }); }, []);
  // run() 不能写进 setState 的 updater 里：updater 必须纯，StrictMode 会把它调用两遍，
  // 危险操作（清库、删除）就会真的执行两次。ref 里拿当前待办，updater 只负责关弹窗。
  const askRef = useRef(ask);
  askRef.current = ask;
  const acceptAsk = useCallback((): void => {
    const pending = askRef.current;
    setAsk(null);
    pending?.run();
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
    setOGender(owner.gender ?? "other");
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
      .catch((e: unknown) => setModelBanner({ kind: "bad", text: errText(e) }))
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
          // 全量留下，不截断：清单可搜、限高滚动，三百条也交得下。
          const ids = list.chatIds && list.chatIds.length ? list.chatIds : list.ids ?? [];
          setModelList({ show: ids.length > 0, ids });
          setModelBanner({ kind: "ok", text: `拉到 ${ids.length} 个模型：输入即筛，点一个填上。` });
        } else {
          setModelBanner({ kind: "bad", text: "没拉到清单。这不代表模型不能用——很多服务商不提供这个，直接填模型名再测。" });
        }
      })
      .catch((e: unknown) => setModelBanner({ kind: "bad", text: errText(e) }))
      .finally(() => setBusy(""));
  };

  const resetModelList = (): void => setModelList({ show: false, ids: [] });

  /** 保存一档模型（id=null 新建；带 id 更新）。密钥留空 = 不动原值。 */
  const saveModelProfile = async (input: ProfileInput): Promise<boolean> => {
    setBusy("prof");
    setModelBanner(null);
    const payload: Record<string, unknown> = {
      label: input.label.trim(),
      mode: "openai",
      baseUrl: input.baseUrl.trim(),
      name: input.name.trim(),
      // 调用方已用 timeoutSecOf 把「秒」校验并 ×1000 过，不做 `|| 90000` 兜底：
      // 那种兜底会把打错的值悄悄洗成默认值，用户毫不知情。
      timeoutMs: Number(input.timeoutMs),
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
    try {
      const d = await settingsApi.saveProfile(payload);
      fill(d);
      // 保存结果走 toast：编辑弹窗关掉之后 banner 就没了落点，切分组更看不见。
      offerToast(d.note || "模型配置已保存", "ok");
      return true;
    } catch (e: unknown) {
      offerToast("模型配置没保存成：" + errText(e), "error");
      return false;
    } finally {
      setBusy("");
    }
  };

  const applyProfile = (id: string): void => {
    setBusy("prof");
    setModelBanner(null);
    settingsApi.activateProfile(id)
      .then((d) => { fill(d); offerToast(d.note || "已启用这个模型", "ok"); })
      .catch((e: unknown) => offerToast("启用没成功：" + errText(e), "error"))
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
      .then((d) => { fill(d); offerToast(d.note || "已删除这个模型档", "ok"); })
      .catch((e: unknown) => offerToast("删除没成功：" + errText(e), "error"))
      .finally(() => setBusy(""));
  };

  /** Echo 调试开关：只动 mode 一个字段，其余配置原样。 */
  const setEchoMode = (on: boolean): void => {
    setBusy("mode");
    setModelBanner(null);
    settingsApi.saveSettings({ model: { mode: on ? "echo" : "openai" } })
      .then((d) => {
        fill(d);
        offerToast(on ? "已切到演示模式。" : "已退出演示模式。", "ok");
      })
      .catch((e: unknown) => offerToast("切换没成功：" + errText(e), "error"))
      .finally(() => setBusy(""));
  };

  /**
   * 保存全局工具循环轮次。busy、错误提示（toast）、快照回灌都在 hook 内收口，
   * 失败返回 null，调用方只分辨成败。
   */
  const saveToolLoopTurns = async (turns: number): Promise<number | null> => {
    setBusy("toolLoop");
    try {
      const d = await settingsApi.saveSettings({ toolLoopTurns: turns });
      fill(d);
      onChanged();
      offerToast(`工具循环轮次已设为 ${d.toolLoopTurns} 轮，下一轮对话生效。`, "ok");
      return d.toolLoopTurns;
    } catch (e: unknown) {
      offerToast("轮次没保存成：" + errText(e), "error");
      return null;
    } finally {
      setBusy("");
    }
  };

  /** 同 saveToolLoopTurns：busy/报错在 hook 内收口，失败返回 null。 */
  const saveEmoteFrequency = async (frequency: EmoteFrequency): Promise<EmoteFrequency | null> => {
    setBusy("emote");
    try {
      const d = await settingsApi.saveSettings({ emoteFrequency: frequency });
      fill(d);
      onChanged();
      offerToast("发表情倾向已保存，下一轮对话生效。", "ok");
      return d.emoteFrequency;
    } catch (e: unknown) {
      offerToast("表情倾向没保存成：" + errText(e), "error");
      return null;
    } finally {
      setBusy("");
    }
  };

  /**
   * 保存「我的资料」。成功/失败都走全局 toast，用户点完保存切到别的分组也看得见结果。
   * 保存成功后快照被 fill() 灌回，OwnerSection 的脏值条自然消失——放弃改动（applySnapshot）
   * 不经过这里，所以「放弃后误弹已保存」不会发生。
   */
  const saveOwner = (): void => {
    setBusy("owner");
    settingsApi.saveSettings({ owner: collectOwner() })
      .then((d) => {
        fill(d);
        offerToast("资料已保存，立即生效。", "ok");
        onChanged();
      })
      .catch((e: unknown) => offerToast("资料没保存成：" + errText(e), "error"))
      .finally(() => setBusy(""));
  };

  const resetAll = (): void => {
    askDangerous("重置设置？", "会清掉你改过的全部设置，回到刚装好时的样子。联系人和聊天记录不受影响。", () => doResetAll());
  };

  const doResetAll = (): void => {
    setBusy("reset");
    settingsApi.resetSettings()
      .then((d) => { fill(d); offerToast("已恢复默认设置。", "ok"); })
      .catch((e: unknown) => offerToast("重置没成功：" + errText(e), "error"))
      .finally(() => setBusy(""));
  };

  /**
   * 恢复出厂设置：比「恢复默认」狠一档——那个只清设置覆盖值，这个连对话、记忆、画作、
   * 微信绑定、联系人本身一起清掉，然后重新种子内置联系人。
   * 确认文案里逐项列清楚丢什么：一句话的「确定吗」挡不住不可逆。盘上的媒体文件
   * （聊天图片、语音、导入的表情包）单独点名并报实数——用户最容易被「画过的画」
   * 四个字盖过去的就是自己攒的表情包。报数失败就退回不带数字的说法，别挡确认。
   */
  const factoryResetAll = (): void => {
    const run = () => {
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
          // 结果走全局 toast：重置按钮在系统页头部、就地 banner 曾被换成 resetBanner
          // 补丁，现在统一出口后，用户确认完无论停在哪一页都看得见结果。
          offerToast(d.note || "已恢复出厂设置。", "ok");
        })
        .catch((e: unknown) => offerToast("恢复出厂没成功：" + errText(e), "error"))
        .finally(() => setBusy(""));
    };
    const mediaClause = (n: number): string =>
      n > 0 ? `，以及盘上的 ${n} 个媒体文件（聊天图片、语音、导入的表情包）` : "";
    storageApi.overview()
      .then((d) => askDangerous("全部清空？",
        `这一步找不回来，会清掉：所有聊天和长期记忆、画过的画、模型和密钥、各项设置、微信绑定${mediaClause(d.mediaFiles)}。相当于第一次打开这个应用。`, run))
      .catch(() => askDangerous("全部清空？",
        "这一步找不回来，会清掉：所有聊天和长期记忆、画过的画、模型和密钥、各项设置、微信绑定，以及盘上的媒体文件（聊天图片、语音、导入的表情包）。相当于第一次打开这个应用。", run));
  };

  /**
   * 换我的头像：上传 → 存全局 owner → 快照同步。hook 内收口：busy 走 try/finally，
   * 成败都 toast（用户换完头像常顺手切去别的分组，「更新了没」不该只能猜），
   * 失败不抛、返回 false——调用方的成功链（改本地头像缓存、写就地提示）必须
   * 拿到 true 才继续跑，否则会把没保存成的 dataUrl 当成已生效的。
   */
  const saveOwnerAvatar = async (dataUrl: string): Promise<boolean> => {
    setBusy("avatar");
    try {
      const d = await settingsApi.saveSettings({ owner: { avatar: dataUrl } });
      fill(d);
      offerToast("头像已更新。", "ok");
      return true;
    } catch (e: unknown) {
      offerToast("头像没换成：" + errText(e), "error");
      return false;
    } finally {
      setBusy("");
    }
  };

  return {
    saved, loadErr, busy, reload, modelBanner, setModelBanner, modelList,
    oName, setOName, oImpression, setOImpression, oNotes, setONotes, oGender, setOGender,
    testModel, fetchModelList, resetModelList, saveModelProfile, applyProfile, deleteProfile, testProfile, profileTestResult, setEchoMode, saveToolLoopTurns, saveEmoteFrequency,
    ask, askDangerous, acceptAsk, cancelAsk,
    applySnapshot: fill,
    saveOwner, resetAll, factoryResetAll, saveOwnerAvatar,
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
