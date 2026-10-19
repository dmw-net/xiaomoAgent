/** 展示格式化：数字与 token 量的中文口径。 */

/** 千分位整数。 */
export function fmtInt(n: number): string {
  return Math.round(n || 0).toLocaleString("zh-CN");
}

/** token 量：1.2k / 3.4万。服务商没返回 usage 时老记录是 0。 */
export function fmtTokens(n: number): string {
  const v = Math.round(n || 0);
  if (v >= 10_000) return (v / 10_000).toFixed(1).replace(/\.0$/, "") + " 万";
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}
