import { useState } from "react";
import type { EmoteFrequency } from "../../types";
import type { SettingsForm } from "./useSettingsForm";

/**
 * 表情能力的唯一开关（全局一档，所有联系人共享）。
 * 「关闭」时表情工具不再声明、系统提示里也不出现表情段；其余三档只改“主动不主动”，
 * 不改检索阈值。曾经这里还有一句「联系人没开表情工具时不生效」——那一层已删，
 * 正因为有两档，才出现过「全局开着、13 个联系人里只有 1 个真能用」这种断链。
 */
const OPTIONS: Array<{ value: EmoteFrequency; name: string; hint: string }> = [
  { value: "off", name: "关闭", hint: "不发表情：表情工具和表情提示一起下线" },
  { value: "rare", name: "少发", hint: "只在情绪非常明显、确实贴切时偶尔发" },
  { value: "normal", name: "自然", hint: "闲聊、接梗、庆祝或安慰时顺手发，认真时少发" },
  { value: "often", name: "主动", hint: "轻松聊天里更主动，每两三条回复一次，一次最多 3 张" },
];

export default function EmoteFrequencySection({ form }: { form: SettingsForm }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const current = form.saved?.emoteFrequency ?? "normal";

  // 成败提示走全局 toast（hook 内 offerToast）：就地 banner 在用户切走「媒体与表情」
  // 分组的瞬间就被卸载了；这里只保留按钮级的「保存中…」。
  const save = (frequency: EmoteFrequency): void => {
    if (busy || form.busy !== "" || frequency === current) return;
    setBusy(true);
    void form.saveEmoteFrequency(frequency)
      .finally(() => setBusy(false));
  };

  return (
    <div className="section" id="settings-emote-frequency">
      <h2>发表情频率</h2>
      <div className="desc">
        表情能力的唯一开关，对所有联系人生效。除「关闭」外，这一档只改变主动程度，不改变表情检索与发送规则；素材在 设置 → 媒体与表情 里管理。
      </div>
      <div className="card card-pad">
        <div className="ml-head">
          <div className="subhead">全局倾向</div>
          <span className="spacer" />
          <span className="hint">{busy ? "保存中…" : `当前 ${OPTIONS.find((o) => o.value === current)?.name ?? current}`}</span>
        </div>
        <div className="adv-chips" role="radiogroup" aria-label="全局发表情频率">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={current === option.value}
              title={option.hint}
              className={"adv-chip" + (current === option.value ? " on" : "")}
              disabled={busy || form.busy !== ""}
              onClick={() => save(option.value)}
            >
              {option.name}
            </button>
          ))}
        </div>
        <div className="hint">
          「主动」也不会为了凑频率硬发；认真解决问题时仍应少发。要发时联系人会直接调用表情工具，而不是只在文字里描述。
        </div>
      </div>
    </div>
  );
}