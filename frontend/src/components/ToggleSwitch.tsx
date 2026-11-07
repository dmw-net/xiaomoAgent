// 全站唯一的「真滑块开关」。
//
// 为什么收敛成滑块：项目里曾同时存在三种「开启某功能」的形态——
// ① 旧 components/Switch.tsx（已删）名字叫 Switch，实际是「关闭/开启」双按钮分段；
// ② QQSection 手写的 role="switch" 轨道滑块（每处样式各自维护）；
// ③ 十来处原生 checkbox 直接当开关用。用户在同一个界面里切换功能，
//    得重新学习每个位置的控件形态。分段按钮表达的是「在两个选项里选」，
//    滑块表达的是「这个功能开着/关着」——后者才是这里的语义，所以统一到滑块。
//
// 实现：原生 <button> + role="switch" + aria-checked。Space / Enter 天然可触发，
// 不需要手写 keydown。命中区由 components.css 的伪元素外扩保证 ≥ --tap-min。
//
// 多选、勾选确认类语义（批量选择、导出带不带密钥这类）不要用本组件，保留 checkbox。

export default function ToggleSwitch({ checked, onChange, disabled = false, label, hint, title, ariaLabel, labelSide = "left", tone = "accent", className }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
  /** 原生 title 提示（悬停说明），透传给 button。 */
  title?: string;
  /** 无障碍名。默认读按钮内文字；当可见文字只是动态状态词（如「收件中」）时用它补全语义。 */
  ariaLabel?: string;
  /** 文字在轨道左边（表单行）还是右边（紧凑网格、行内菜单）。 */
  labelSide?: "left" | "right";
  /** danger：on 态轨道用警示色——这是「开了有风险的功能」的开关，不是普通偏好。 */
  tone?: "accent" | "danger";
  /** 挂在 button 上；用于复用调用点既有的行级容器样式，避免多包一层 div。 */
  className?: string;
}): JSX.Element {
  const text = label !== undefined && label !== "" && (
    <span className="toggle-switch-text">
      <b>{label}</b>
      {hint !== undefined && hint !== "" && <span>{hint}</span>}
    </span>
  );
  const track = (
    <span className="toggle-switch-track" aria-hidden="true">
      <span className="toggle-switch-thumb" />
    </span>
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className={"toggle-switch" + (tone === "danger" ? " is-danger" : "") + (className ? " " + className : "")}
      onClick={() => onChange(!checked)}
    >
      {labelSide === "left" ? <>{text}{track}</> : <>{track}{text}</>}
    </button>
  );
}
