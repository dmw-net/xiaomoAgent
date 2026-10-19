/** 气泡/列表通用头像：有图显示图，没图用名字首字占位。 */
export default function Avatar({ src, name, className = "", alt, style }: {
  src?: string;
  name: string;
  className?: string;
  /** 读屏可懂：默认用名字当替代文本，而不是 alt="" 装没看见。 */
  alt?: string;
  /** 头像色档等一次性变量走这里（见 lib/avatar-tone）。 */
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <div className={className + (src ? " has-img" : "")} style={style}>
      {src ? <img src={src} alt={alt ?? name} loading="lazy" decoding="async" /> : (name || "?").slice(0, 1)}
    </div>
  );
}
