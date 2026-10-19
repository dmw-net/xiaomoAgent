/** 体检表的一行：红绿灯 + 项目 + 结论 + 可选的修复建议。 */
export default function CheckRow({ led, k, v, fix }: {
  led: "ok" | "warn" | "bad";
  k: string;
  v: React.ReactNode;
  fix?: React.ReactNode;
}): JSX.Element {
  return (
    <div className={"check" + (fix ? " has-fix" : "")}>
      <span className={"led " + led} />
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {fix && <span className="fix">{fix}</span>}
    </div>
  );
}
