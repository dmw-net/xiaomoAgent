/** 时间格式化。各视图共用，保证「今天 / 昨天 / 具体日期」的口径一致。 */

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 日分隔条文案：今天 / 昨天 / 「09 月 03 日 周三」。 */
export function dayLabel(ts: number): string {
  const day = dayOf(ts);
  const today = dayOf(Date.now());
  if (day === today) return "今天";
  const yest = dayOf(Date.now() - 86_400_000);
  if (day === yest) return "昨天";
  const d = new Date(ts);
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()] ?? "";
  return `${day.slice(5).replace("-", " 月 ")} 日 ${week}`;
}

export function clockOf(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
  return Math.floor(diff / 86_400_000) + " 天前";
}

/** 未来时间：即将检查 / N 分钟后 / 约 N 小时后 / 约 N 天后。 */
export function whenText(ts: number): string {
  const mins = Math.round((ts - Date.now()) / 60_000);
  if (mins <= 0) return "即将检查";
  if (mins < 60) return mins + " 分钟后";
  const hours = Math.round(mins / 60);
  if (hours < 36) return "约 " + hours + " 小时后";
  return "约 " + Math.round(hours / 24) + " 天后";
}

/** 侧栏联系人时间：当天显示时刻，否则显示 月/日。 */
export function shortTimeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clockOf(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
