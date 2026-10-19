import { useState } from "react";
import { saveSettings } from "../../api/settings";
import { STEPS, capsConfigured, resolveStep, type OnboardingInput, type OnboardingStep } from "./steps";
import type { Caps } from "../../lib/capsStore";

/**
 * 聊天空态里的常驻清单。弹窗收掉（「稍后设置」）之后它还在——引导不该只有一条命；
 * 走完或就地收起后消失。步骤判定与弹窗共用 steps.ts 那一份，不会出现两边说法不一。
 */
export default function OnboardingChecklist({ ownerName, modelReady, caps, personaIsDefault, onOpen, onFinished }: {
  ownerName: string;
  modelReady: boolean;
  caps: Caps;
  /** 人设还是出厂那份（服务端算的，判的是 contacts.card）。省略按"改过了"处理：清单不催这一步。 */
  personaIsDefault?: boolean;
  onOpen?: () => void;
  onFinished: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const input: OnboardingInput = { ownerName, modelReady, capabilitiesReady: caps, personaIsDefault };
  const step = resolveStep(input);
  // 「开始相处」只能由人自己点：替用户宣布"我们开始了"是假完成。
  const isDone = (id: OnboardingStep): boolean =>
    id === "owner" ? ownerName.trim() !== ""
      : id === "model" ? modelReady
        : id === "capability" ? capsConfigured(input)
          : id === "persona" ? personaIsDefault !== true
            : false;

  const finish = (): void => {
    setBusy(true);
    void saveSettings({ onboarding: { completed: true } })
      .then(onFinished)
      .catch(() => setBusy(false));
  };

  return (
    <div className="onb-list" id="onb-list">
      <div className="onb-list-h">首次设置 · 还差 {STEPS.filter((s) => !isDone(s.id)).length} 步</div>
      {STEPS.map((s) => (
        <div key={s.id} className={"onb-row" + (isDone(s.id) ? " done" : "") + (s.id === step ? " on" : "")}>
          <b>{isDone(s.id) ? "✓" : "○"}</b>
          <span className="onb-row-t">{s.label}</span>
          <span className="onb-row-h">{isDone(s.id) ? "已完成" : s.hint}</span>
        </div>
      ))}
      <div className="onb-list-f">
        {onOpen && <button type="button" className="btn ghost sm" onClick={onOpen}>继续设置</button>}
        <button type="button" className="btn ghost sm" disabled={busy} onClick={finish}>
          {busy ? "收起来…" : "就这样，收起来"}
        </button>
      </div>
    </div>
  );
}
