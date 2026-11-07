// 「工具与扩展 → 总览」= 工具台账。
//
// 一张表回答三件事：现在有哪些手、哪些被收回、为什么没生效。
// 目录、档位、状态理由全部由 /api/tools 下发，前端不维护第二份工具名。
// 全局档位是**上限**：这里收掉的，任何联系人档位都开不回来。
//
// 只读的部分（模型档硬闸、能力就绪、联系人档位）不在这里复制成可写控件，
// 只给一句话说明与直达入口，避免两处状态打架。
//
// 首屏只回答一个问题：在什么档。「全关」与三档合并成一条档位轴（存储仍是
// toolsEnabled + globalPreset 两个字段，写入时一次请求带齐）；21 行逐项明细收进
// 折叠区——真要逐项拧的人才展开它；扩展带来的工具在明细里没有第二个开关，
// 状态列写明来源，启停一律回「扩展」页（双开关是「开了扩展却看不到工具」
// 这类困惑的根源，现在一条因果只有一处闸）。

import { useCallback, useEffect, useState } from "react";
import { CircleDot, RefreshCw, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { contactsApi, toolsApi } from "../../api";
import type { ToolCatalogEntry, ToolPreset, ToolPresetChoice, ToolState } from "../../api/tools";
import { loadToolState, putToolState } from "../../lib/toolsStore";
import ToolLoopSection from "./ToolLoopSection";
import type { SettingsForm } from "./useSettingsForm";

/** 「全关」与三档合并成一条档位轴（off / quiet / balanced / full）。
 *  存储上仍是两个字段（toolsEnabled + globalPreset），写入时一次请求带上；
 *  界面不再出现「总闸」这张卡——总闸×档位×逐项的三层门控，用户只需要理解一层。 */
type PresetChoice = ToolPreset | "off";

function choiceLabelsOf(state: ToolState): Record<ToolPresetChoice, string> {
  const labels = {} as Record<ToolPresetChoice, string>;
  for (const choice of state.choices) labels[choice.key] = choice.label;
  labels.off = "全关";
  return labels;
}

/** 当前生效档：总闸关着就显示「全关」，否则显示所选档。 */
function currentPresetOf(state: ToolState): PresetChoice {
  return state.toolsEnabled ? state.globalPreset : "off";
}

/** 状态列的「一步修复」出口：这句理由的后端真源在 routes/tools.ts，
 *  这里按文案映射到修复现场（能力模型 / 表情频率），后端改文案时这里要跟着对。 */
const STATE_FIXES: Record<string, "capability" | "media"> = {
  "图像生成未配好": "capability",
  "语音合成未配好": "capability",
  "表情频率设为关闭": "media",
};

function LedgerRow({ tool, state, onToggle, onGoExtensions, onGoCapability, onGoMedia, busy }: {
  tool: ToolCatalogEntry;
  state: ToolState;
  onToggle: (name: string, next: boolean) => void;
  onGoExtensions: () => void;
  onGoCapability: () => void;
  onGoMedia: () => void;
  busy: boolean;
}): JSX.Element {
  const off = state.disabledTools.includes(tool.name);
  const reason = state.status[tool.name] ?? "";
  const blocked = reason !== "允许" && !tool.alwaysOn;
  // 「为什么没生效」的下一步是修好它：能一步到修复现场的状态给直达出口，
  // 不让用户拿着一句「图像生成未配好」再去设置地图里找是哪一张卡。
  const fix = blocked ? STATE_FIXES[reason] : undefined;
  return (
    <div className={"lg-row" + (off || blocked ? " is-off" : "")}>
      <span className={"lg-dot lg-dot-" + tool.group} aria-hidden="true" />
      <div className="lg-copy">
        <div className="lg-name">
          {tool.label}
          {tool.alwaysOn === true && <span className="lg-tag is-fixed">常开</span>}
          {tool.risk === "high" && <span className="lg-tag is-risk" title="出网、花钱或授予本机执行权限">高风险</span>}
          {tool.dynamic === true && <span className="lg-tag">扩展</span>}
        </div>
        <div className="lg-summary">{tool.summary}</div>
      </div>
      {fix !== undefined ? (
        <button type="button" className="tw-link lg-state-link"
          onClick={fix === "capability" ? onGoCapability : onGoMedia}
          title="去把这一项修好">
          {reason} →
        </button>
      ) : (
        <span className={"lg-state" + (blocked ? " is-muted" : "")}>{reason}</span>
      )}
      {tool.alwaysOn === true ? (
        <span className="lg-fixed">常开</span>
      ) : tool.dynamic === true ? (
        /* 扩展工具没有逐项开关：扩展页的启停就是它的总闸，这里只指路。 */
        <button type="button" className="tw-link" onClick={onGoExtensions}
          title={`启停请到「扩展」页的「${tool.source ?? ""}」`}>
          来自{tool.source ?? "扩展"} · 去启停
        </button>
      ) : (
        <div className="choice-row" role="group" aria-label={`「${tool.label}」开关`}>
          <button type="button" className="choice" aria-pressed={off} disabled={busy}
            onClick={() => onToggle(tool.name, false)}>关闭</button>
          <button type="button" className="choice" aria-pressed={!off} disabled={busy}
            onClick={() => onToggle(tool.name, true)}>开启</button>
        </div>
      )}
    </div>
  );
}

export default function ToolOverviewSection({ form, onGoModel, onGoCapability, onGoMedia, onGoExtensions }: {
  form: SettingsForm;
  onGoModel: () => void;
  onGoCapability: () => void;
  onGoMedia: () => void;
  /** 扩展工具行的「去启停」：切到工作台的「扩展」页签，不出这个一级分组。 */
  onGoExtensions: () => void;
}): JSX.Element {
  const [state, setState] = useState<ToolState | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback((): void => {
    // 写方挂载必须看到最新：不走缓存， store 会对同一时刻的并发去重。
    loadToolState()
      .then((next) => { setState(next); setErr(""); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const write = (key: string, patch: { disabledTools?: string[]; globalPreset?: ToolPreset; toolsEnabled?: boolean }, ok: string): void => {
    setBusy(key);
    setErr("");
    setNote("");
    toolsApi.saveToolState(patch)
      .then((next) => { putToolState(next); setState(next); setNote(ok); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(""));
  };

  /** 档位轴的唯一写入口：全关=只关总闸，其余档位=开总闸并选中该档。
   *  两个字段一次请求写齐，台账状态由服务端重算返回，不存在中间态。 */
  const setPreset = (preset: PresetChoice): void => {
    if (state === null || preset === currentPresetOf(state)) return;
    const label = preset === "off" ? "全关" : state.presets.find((p) => p.key === preset)?.label ?? preset;
    const patch: { toolsEnabled: boolean; globalPreset?: ToolPreset } = { toolsEnabled: preset !== "off" };
    if (preset !== "off") patch.globalPreset = preset;
    write("preset", patch, preset === "off"
      ? "已全关：陪伴侧不再声明任何工具，助手的管理操作仍保留。"
      : `全局档位已设为「${label}」，下一轮对话生效。`);
  };

  const toggleTool = (name: string, enable: boolean): void => {
    if (state === null) return;
    const next = enable
      ? state.disabledTools.filter((n) => n !== name)
      : [...state.disabledTools, name];
    const label = state.tools.find((t) => t.name === name)?.label ?? name;
    write(name, { disabledTools: next }, enable ? `「${label}」已放开。` : `「${label}」已全局关闭。`);
  };

  const followGlobal = async (id: string, name: string): Promise<void> => {
    setBusy(`c:${id}`);
    setErr("");
    setNote("");
    try {
      await contactsApi.updateContact(id, { features: { toolPreset: "follow" } });
      load();
      setNote(`「${name}」已改回跟随全局档。`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  if (state === null) {
    return (
      <div className="tw-board" id="settings-tools-overview">
        <div className="lg-loading">{err === "" ? "正在读取工具台账…" : err}</div>
        {err !== "" && <button type="button" className="btn sm" onClick={load}>重试</button>}
      </div>
    );
  }

  const labels = choiceLabelsOf(state);
  const companions = state.tools.filter((t) => t.scope === "companion");
  const assistants = state.tools.filter((t) => t.scope === "assistant");
  const currentPreset = currentPresetOf(state);
  const exceptions = state.contacts.filter((c) => c.preset !== "follow");
  const disabledCount = state.disabledTools.length;

  /** 档位轴：全关在最左（最严），三档依次放开。描述直接吃后端下发的文案。 */
  const presetAxis: Array<{ key: PresetChoice; label: string; desc: string }> = [
    { key: "off", label: "全关", desc: "陪伴侧一个工具都不声明，助手的管理操作仍保留。" },
    ...state.presets.map((p) => ({ key: p.key as PresetChoice, label: p.label, desc: p.desc })),
  ];
  const currentDesc = presetAxis.find((p) => p.key === currentPreset)?.desc ?? "";

  return (
    <div className="tw-board" id="settings-tools-overview">
      <div className="tw-board-head">
        <div className="tw-board-head-copy">
          <h2>工具台账</h2>
          <p>一眼看清小茉现在有哪些手、哪些被收回、为什么没生效。这里的档位是全局上限，联系人只能更严，不能更松。</p>
        </div>
        <div className="tw-board-head-aside">
          <button type="button" className="btn sm" onClick={load} disabled={busy !== ""}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
      </div>

      {err !== "" && <div className="ext-banner is-bad" role="alert">{err}</div>}
      {note !== "" && <div className="ext-banner is-ok" role="status">{note}</div>}

      <div className="lg-preset-card">
        <div className="lg-preset-head">
          <span className="lg-preset-icon"><SlidersHorizontal size={15} /></span>
          <div className="lg-preset-title">
            <b>全局档位</b>
            <small>新建联系人默认跟随这一档；已有联系人若单独设过，会显示在下方「按联系人」里。</small>
          </div>
        </div>
        <div className="lg-segmented" role="radiogroup" aria-label="全局工具档位">
          {presetAxis.map((preset) => (
            <button key={preset.key} type="button" role="radio"
              aria-checked={currentPreset === preset.key}
              className={"lg-seg" + (currentPreset === preset.key ? " is-on" : "")}
              disabled={busy !== ""} onClick={() => setPreset(preset.key)}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className="lg-preset-desc">
          <CircleDot size={13} /> <span>{currentDesc}</span>
        </div>
        <div className="lg-preset-foot">
          <span>全局已单独关闭 <b>{disabledCount}</b> 项</span>
          <span className="lg-divider" />
          <span>{exceptions.length} 位联系人有单独设置</span>
        </div>
      </div>

      {/* 逐项明细收进折叠区：首屏留给两个决策（总闸、档位），明细为「真要逐项拧」的人服务。
          摘要里把账算出来（陪伴 + 助手 = 总数），联系人页的 6 个类开关跟这份账对得上。 */}
      <details className="lg-advanced">
        <summary>
          全部工具逐项查看
          <small>{state.tools.length} 项 = 陪伴 {companions.length} + 助手 {assistants.length} · {disabledCount > 0 ? `${disabledCount} 项已全局关闭` : "没有单独关闭的项"}</small>
        </summary>
        <div className="lg-advanced-body">
          {([
            { key: "companion", title: "陪伴工具", hint: "聊天里能调用的手", items: companions },
            { key: "assistant", title: "助手工具", hint: "设置助手用来管理应用的手，逐项可收回；也能在助手控制台只读查看", items: assistants },
          ] as const).map((section) => (
            <section className="lg-panel" key={section.key}>
              <div className="lg-panel-head">
                <div className="lg-panel-title">
                  <b>{section.title}</b>
                  <small>{section.hint}</small>
                </div>
                <span className="lg-count">{section.items.length} 项</span>
              </div>
              {state.groups.map((group) => {
                const rows = section.items.filter((t) => t.group === group.key);
                if (rows.length === 0) return null;
                return (
                  <div className="lg-group" key={group.key}>
                    <div className="lg-group-label"><span>{group.label}</span></div>
                    {rows.map((tool) => (
                      <LedgerRow key={tool.name} tool={tool} state={state}
                        onToggle={toggleTool} onGoExtensions={onGoExtensions}
                        onGoCapability={onGoCapability} onGoMedia={onGoMedia} busy={busy !== ""} />
                    ))}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </details>

      <section className="lg-panel" id="settings-tool-matrix">
        <div className="lg-panel-head">
          <div className="lg-panel-title">
            <b>按联系人</b>
            <small>「跟随全局」的联系人不单列；改过档位或沿用旧设置的显示为例外。</small>
          </div>
          <span className="lg-count">{state.contacts.length} 位</span>
        </div>
        {exceptions.length === 0 ? (
          <div className="lg-empty">所有联系人都跟随全局档，不需要逐个设置。</div>
        ) : (
          <div className="lg-contacts">
            {exceptions.map((contact) => (
              <div className="lg-contact-row" key={contact.id}>
                <button type="button" className="lg-contact-name"
                  onClick={() => window.dispatchEvent(new CustomEvent("xiaomo:open-contact", { detail: { contactId: contact.id } }))}
                  title="进入这一位的会话">
                  {contact.name}
                </button>
                <span className={"lg-choice is-" + contact.preset}>{labels[contact.preset] ?? contact.preset}</span>
                <span className="spacer" />
                <button type="button" className="btn sm" disabled={busy !== ""}
                  onClick={() => void followGlobal(contact.id, contact.name)}>
                  {busy === `c:${contact.id}` ? "保存中…" : "跟随全局"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="lg-footnote">
        <ShieldAlert size={14} />
        <div>
          最终是否生效还要看两道：模型档是否允许工具调用、这位联系人选了哪一档（专项能力没配好的会在台账里标出来）。
          工具台账里标「允许」不等于这一轮一定出现。
          <span className="lg-links">
            <button type="button" className="tw-link" onClick={onGoModel}>主对话模型</button>
            <button type="button" className="tw-link" onClick={onGoCapability}>能力模型</button>
            <button type="button" className="tw-link" onClick={onGoMedia}>表情频率</button>
          </span>
        </div>
      </div>

      <div className="tw-plain">
        <ToolLoopSection form={form} />
      </div>
    </div>
  );
}
