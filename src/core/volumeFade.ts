/**
 * 渐变音量的采样点：在长度为 `length` 的连续区域里，从 `start` 线性变到 `end`，
 * 每隔 `step` 个时值（格子）取一个点，首尾一定包含。
 *
 * 音量按「位置比例」线性插值（不是按段数均分），所以即使最后一段不足 `step` 格，
 * 整条曲线的斜率仍然一致。
 */
export interface FadePoint {
  /** 相对区域第一格的偏移（0 起） */
  at: number
  /** 0–100 */
  volume: number
}

const clampVol = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

export function fadeVolumePoints(length: number, start: number, end: number, step: number): FadePoint[] {
  const n = Math.floor(length)
  if (!Number.isFinite(n) || n <= 0) return []
  const s = Math.max(1, Math.min(Math.max(1, n - 1), Math.round(step) || 1))
  if (n === 1) return [{ at: 0, volume: clampVol(end) }]
  const span = n - 1
  const segs = Math.ceil(span / s)
  const out: FadePoint[] = []
  let last = -1
  for (let i = 0; i <= segs; i++) {
    const at = i === segs ? span : Math.min(span, i * s)
    if (at === last) continue
    last = at
    const volume = at === span ? end : start + ((end - start) * at) / span
    out.push({ at, volume: clampVol(volume) })
  }
  return out
}
