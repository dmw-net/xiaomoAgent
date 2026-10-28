/** 统一的轻量骨架：只用于已知结构、正在等待数据的区域，不冒充空状态。 */
export default function LoadingSkeleton({ rows = 3, className = "" }: { rows?: number; className?: string }): JSX.Element {
  return (
    <div className={"skeleton-stack" + (className ? " " + className : "")} aria-label="正在载入" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span style={{ width: `${34 + (i % 3) * 12}%` }} />
          <span style={{ width: `${62 + (i % 2) * 18}%` }} />
        </div>
      ))}
    </div>
  );
}
