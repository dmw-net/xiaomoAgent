/** 桌宠形象的 SVG 兜底：视频素材加载/解码失败时顶上，保证桌宠永远有形。 */
export default function PetMascotSvg(): JSX.Element {
  return (
    <svg className="pet-mascot-svg" viewBox="0 0 200 220" aria-hidden="true" focusable="false">
      {/* 尾巴在身体后面，单独一层便于摆动 */}
      <path className="pet-tail" d="M148 150 C176 146 188 126 182 104 C178 92 166 88 158 96 C166 108 162 128 146 138 Z" />
      {/* 耳朵 */}
      <path className="pet-ear pet-ear-left" d="M62 74 C54 46 62 28 78 30 C92 32 96 52 90 72 Z" />
      <path className="pet-ear pet-ear-right" d="M138 74 C146 46 138 28 122 30 C108 32 104 52 110 72 Z" />
      {/* 身体 */}
      <ellipse className="pet-body" cx="100" cy="140" rx="62" ry="58" />
      <ellipse className="pet-belly" cx="100" cy="158" rx="38" ry="30" />
      {/* 脚 */}
      <ellipse className="pet-foot pet-foot-left" cx="76" cy="192" rx="18" ry="12" />
      <ellipse className="pet-foot pet-foot-right" cx="124" cy="192" rx="18" ry="12" />
      {/* 眼睛 */}
      <circle className="pet-eye pet-eye-left" cx="78" cy="128" r="7" />
      <circle className="pet-eye pet-eye-right" cx="122" cy="128" r="7" />
      {/* 腮红 */}
      <ellipse className="pet-cheek pet-cheek-left" cx="62" cy="146" rx="10" ry="6" />
      <ellipse className="pet-cheek pet-cheek-right" cx="138" cy="146" rx="10" ry="6" />
      {/* 嘴 */}
      <path className="pet-mouth" d="M92 148 Q100 156 108 148" />
      {/* 头花 */}
      <g className="pet-flower" transform="translate(132 54)">
        <circle cx="0" cy="-8" r="5" />
        <circle cx="7" cy="-3" r="5" />
        <circle cx="5" cy="6" r="5" />
        <circle cx="-5" cy="6" r="5" />
        <circle cx="-7" cy="-3" r="5" />
        <circle className="pet-flower-center" cx="0" cy="0" r="4" />
      </g>
    </svg>
  );
}
