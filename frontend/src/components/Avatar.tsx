/** 气泡/列表通用头像：有图显示图，没图用名字首字占位。 */
import { useEffect, useState } from "react";

export default function Avatar({ src, name, className = "", alt, style, title }: {
  src?: string;
  name: string;
  className?: string;
  /** 读屏可懂：默认用名字当替代文本，而不是 alt="" 装没看见。 */
  alt?: string;
  /** 头像色档等一次性变量走这里（见 lib/avatar-tone）。 */
  style?: React.CSSProperties;
  title?: string;
}): JSX.Element {
  // 图片加载失败要退回首字占位：破图框里浮着 alt 文案，比没图更难解释。
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  const showImg = !!src && !failed;
  return (
    <div className={className + (showImg ? " has-img" : "")} style={style} title={title}>
      {showImg ? (
        <img src={src} alt={alt ?? name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        (name || "?").slice(0, 1)
      )}
    </div>
  );
}
