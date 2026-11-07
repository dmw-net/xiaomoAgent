// 开关统一复用项目既有的 `.settings-row` + `.choice-row` / `.choice`
// （「设置 → 系统与数据 → 开机自动启动」那一套）。
//
// 曾经这里自创过一枚绿色滑块，和项目里其它开关摆在一起像两个应用。
// 同一个界面里出现两套开关视觉，比「不好看」更伤害一致性，所以全部收回来。

export default function Switch({ checked, onChange, disabled = false, label, hint, tone = "accent" }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  hint?: string;
  tone?: "accent" | "danger";
}): JSX.Element {
  return (
    <div className={"settings-row compact tw-choice-row" + (tone === "danger" ? " is-danger" : "")}>
      <div className="settings-row-label">
        <b>{label}</b>
        {hint !== undefined && hint !== "" && <span>{hint}</span>}
      </div>
      <div className="choice-row" role="group" aria-label={label}>
        <button type="button" className="choice" aria-pressed={!checked} disabled={disabled}
          onClick={() => onChange(false)}>关闭</button>
        <button type="button" className="choice" aria-pressed={checked} disabled={disabled}
          onClick={() => onChange(true)}>开启</button>
      </div>
    </div>
  );
}
