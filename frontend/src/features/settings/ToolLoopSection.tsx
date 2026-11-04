import { useState } from "react";
import type { SettingsForm } from "./useSettingsForm";

/**
 * 全局工具循环轮次。预设负责覆盖常见取舍，自定义负责兜底。
 * 这一项真正要用户判断的是“聊天够不够快”还是“复杂任务能不能做完”，不是数字本身。
 */
const OPTIONS = [
  { turns: 3, name: "轻量", hint: "单步工具，响应最快" },
  { turns: 5, name: "均衡", hint: "覆盖常见多步流程" },
  { turns: 8, name: "多步", hint: "适合复杂任务，更慢也更费" },
];

export default function ToolLoopSection({ form }: { form: SettingsForm }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [custom, setCustom] = useState("");
  const current = form.saved?.toolLoopTurns ?? 5;
  const limits = form.saved?.toolLoopTurnLimits ?? { min: 1, max: 16 };
  const choices = OPTIONS.filter((o) => o.turns >= limits.min && o.turns <= limits.max);
  const customValue = Number(custom);
  const customValid = custom.trim() !== "" && Number.isInteger(customValue)
    && customValue >= limits.min && customValue <= limits.max;

  const saveTurns = (turns: number): void => {
    if (busy || form.busy !== "" || turns === current) return;
    setBusy(true);
    setNote("");
    setErr("");
    form.saveToolLoopTurns(turns)
      .then((saved) => {
        setNote(`已设为 ${saved} 轮，下一轮对话立即生效。`);
        setCustom("");
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="section" id="settings-tool-loop">
      <h2>工具循环轮次</h2>
      <div className="desc">
        按带工具定义的模型请求计轮；同一请求内的多个工具只算一轮。轮次越高，多步任务越容易完成，但响应更慢、消耗更多。
      </div>
      <div className="card card-pad">
        <div className="ml-head">
          <div className="subhead">全局默认</div>
          <span className="spacer" />
          <span className="hint">{busy ? "保存中…" : `当前 ${current} 轮`}</span>
        </div>
        <div className="adv-chips" role="radiogroup" aria-label="全局工具循环轮次">
          {choices.map((option) => (
            <button
              key={option.turns}
              type="button"
              role="radio"
              aria-checked={current === option.turns}
              title={option.hint}
              className={"adv-chip" + (current === option.turns ? " on" : "")}
              disabled={busy || form.busy !== ""}
              onClick={() => saveTurns(option.turns)}
            >
              {option.turns} 轮 · {option.name}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="tool-loop-turns-custom">自定义轮次</label>
          <input
            id="tool-loop-turns-custom"
            type="number"
            inputMode="numeric"
            min={limits.min}
            max={limits.max}
            step={1}
            value={custom}
            placeholder={`${limits.min}~${limits.max}`}
            aria-invalid={custom.trim() !== "" && !customValid}
            onChange={(e) => setCustom(e.target.value)}
          />
          <div className="hint">
            可填 {limits.min}~{limits.max} 轮。用尽后会追加一次无工具收口请求，不计入上限。
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn sm" disabled={!customValid || busy || form.busy !== ""}
            onClick={() => saveTurns(customValue)}>
            应用自定义
          </button>
        </div>
        <div className="hint">普通联系人共用此设置；设置助手固定 8 轮。</div>
        {note !== "" && <div className="banner show ok" role="status"><div className="body">{note}</div></div>}
        {err !== "" && <div className="banner show bad" role="alert"><div className="body">{err}</div></div>}
      </div>
    </div>
  );
}
