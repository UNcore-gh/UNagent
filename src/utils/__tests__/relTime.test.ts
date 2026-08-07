// relTime: relative-time labels for the conversation manager rows.
// `now` is injectable, so every case is a pure arithmetic comparison.

import { relTime } from '../relTime'

const NOW = new Date('2026-08-01T12:00:00').getTime()

describe('relTime', () => {
  it('says 刚刚 under a minute', () => {
    expect(relTime(NOW, NOW)).toBe('刚刚')
    expect(relTime(NOW - 30 * 1000, NOW)).toBe('刚刚')
    expect(relTime(NOW - 59 * 1000, NOW)).toBe('刚刚')
  })

  it('counts minutes under an hour', () => {
    expect(relTime(NOW - 60 * 1000, NOW)).toBe('1 分钟前')
    expect(relTime(NOW - 45 * 60 * 1000, NOW)).toBe('45 分钟前')
  })

  it('counts hours under a day', () => {
    expect(relTime(NOW - 60 * 60 * 1000, NOW)).toBe('1 小时前')
    expect(relTime(NOW - 23 * 60 * 60 * 1000, NOW)).toBe('23 小时前')
  })

  it('says 昨天 for one day, then counts days under a month', () => {
    expect(relTime(NOW - 24 * 60 * 60 * 1000, NOW)).toBe('昨天')
    expect(relTime(NOW - 12 * 24 * 60 * 60 * 1000, NOW)).toBe('12 天前')
    expect(relTime(NOW - 29 * 24 * 60 * 60 * 1000, NOW)).toBe('29 天前')
  })

  it('falls back to 月日 within the same year', () => {
    // 2026-03-05, same year as NOW (2026-08-01)
    const ts = new Date('2026-03-05T08:00:00').getTime()
    expect(relTime(ts, NOW)).toBe('3月5日')
  })

  it('includes the year across years', () => {
    const ts = new Date('2025-11-09T08:00:00').getTime()
    expect(relTime(ts, NOW)).toBe('2025年11月9日')
  })

  it('clamps future timestamps to 刚刚', () => {
    expect(relTime(NOW + 5000, NOW)).toBe('刚刚')
  })
})
