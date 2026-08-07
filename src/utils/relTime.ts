// Relative-time formatting for the conversation manager rows ("3 分钟前").
// Pure: `now` is injectable so tests never touch the clock.

/** Human relative time in Chinese; falls back to a date as it gets older. */
export function relTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day === 1) return '昨天'
  if (day < 30) return `${day} 天前`
  const d = new Date(ts)
  const sameYear = new Date(now).getFullYear() === d.getFullYear()
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
