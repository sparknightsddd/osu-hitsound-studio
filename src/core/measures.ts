import type { Diagnostic, MeasureInfo, MeasureSegment, TimingPoint } from './types'

const MAX_MEASURES = 20000

/**
 * 红线落点与小节自然结束点相差在这个范围内时，认为它们就是同一时刻。
 * 用来避免生成 span < 1ms 的碎片小节（见 build 里的说明）。
 */
const SLIVER_MS = 1

/**
 * 红线落在小节自然结束点前后这么多拍以内时，认为它就是这一小节的边界，
 * 直接把 end 对到红线，而不是截出一个十几毫秒的碎片小节。
 * （1/8 拍 @ 140BPM ≈ 53ms，足够吸收 osu 整数毫秒 offset 带来的误差）
 */
const SNAP_BEAT = 0.125

/**
 * 按 [Timing] 推导出小节网格。
 * 每小节的时长 = 每小节拍数 × 当前每拍毫秒数；
 * 若小节中间出现 resetMode=0 的 Timing 变更，则按 resetBeats 拆分两段 BPM。
 */
export class MeasureGrid {
  private list: MeasureInfo[] = []
  private cursor: number
  private timing: TimingPoint[]
  private warned = false
  private warnedReset = false
  private diags: Diagnostic[]

  constructor(timing: TimingPoint[], diags: Diagnostic[]) {
    this.diags = diags
    this.timing = [...timing].sort((a, b) => a.offset - b.offset)
    const first = this.timing[0]
    this.cursor = first ? first.offset + (first.shift || 0) : 0
  }

  private active(t: number): TimingPoint | undefined {
    let p: TimingPoint | undefined
    for (const tp of this.timing) {
      if (tp.offset <= t + 1e-9) p = tp
      else break
    }
    return p
  }

  private nextAfter(t: number): TimingPoint | undefined {
    return this.timing.find((tp) => tp.offset > t + 1e-9)
  }

  get(i: number): MeasureInfo {
    while (this.list.length <= i && this.list.length < MAX_MEASURES) {
      this.list.push(this.build(this.list.length))
    }
    if (i >= this.list.length) {
      return { index: i, start: this.cursor, end: this.cursor + 2000, beatLength: 500, meter: 4 }
    }
    return this.list[i]
  }

  get length() {
    return this.list.length
  }

  /**
   * 某个时间点落在第几个小节（0 起）。
   * 网格是懒生成的，这里会一路生成到覆盖该时间为止。
   */
  indexAt(time: number): number {
    if (!Number.isFinite(time)) return 0
    if (this.list.length === 0) this.get(0)
    if (time < this.list[0].start) return 0
    let i = 0
    while (i < MAX_MEASURES) {
      const m = this.get(i)
      if (time < m.end) return i
      i++
    }
    return i
  }

  snapshot(): MeasureInfo[] {
    return this.list.slice()
  }

  private build(index: number): MeasureInfo {
    const p = this.active(this.cursor)
    const start = this.cursor
    const meter = p && p.meter > 0 ? p.meter : 4
    const bl = p && p.beatLength > 0 ? p.beatLength : 500
    if ((!p || p.beatLength <= 0) && !this.warned) {
      this.warned = true
      this.diags.push({
        from: p ? p.from : 0,
        to: p ? p.to : 0,
        severity: 'warning',
        message: 'Timing 缺少有效的每拍毫秒数，已按 120 BPM / 4 拍 兜底处理',
        code: 'timing-fallback',
      })
    }

    // 本小节按当前 BPM 走完的自然结束点
    const naturalEnd = start + meter * bl
    let end = naturalEnd
    let segments: MeasureSegment[] | undefined

    /**
     * 小节边界只认「红线」（resetMode != 0）。
     * 不能只看 `nextAfter(start)`：它可能是一条继承型 Timing（只改 BPM 相位），
     * 真正的红线在它后面 —— 那样本小节会按自然结束点收尾，红线恰好落在
     * 结束点后面几毫秒时就会切出一个 10ms 的碎片小节。
     */
    const nextRed = this.timing.find(
      (tp) => tp.resetMode !== 0 && tp.offset + (tp.shift || 0) > start + 1e-9,
    )
    const redAt = nextRed ? nextRed.offset + (nextRed.shift || 0) : Infinity

    // 继承型变更：只有落在下一条红线之前，才属于本小节内部的变速
    const inh = this.timing.find((tp) => {
      if (tp.resetMode !== 0) return false
      const at = tp.offset + (tp.shift || 0)
      return at > start + 1e-9 && at < redAt
    })
    if (inh) {
      const changeAt = inh.offset + (inh.shift || 0)
      if (changeAt < naturalEnd - SLIVER_MS) {
        // 继承型变更落在本小节中间：前 r 拍用旧 BPM，其余拍用新 BPM
        const newBl = inh.beatLength > 0 ? inh.beatLength : bl
        // BPM 没变（.osu 里常见：同一条红线又写了一遍，只为改 offset 的相位）：
        // 拆成两段没有任何意义，只会让节奏刻度多一次无意义的断点。
        if (Math.abs(newBl - bl) > 1e-6) {
          // 优先用显式 resetBeats；没有就用变更点的实际时间反推落在第几拍
          let r = inh.resetBeats > 0 ? inh.resetBeats : (changeAt - start) / bl
          r = Math.max(0, Math.min(meter, r))
          const mid = start + r * bl
          end = mid + (meter - r) * newBl
          if (r > 1e-9 && r < meter - 1e-9) {
            segments = [
              { start, end: mid, beatLength: bl, beats: r },
              { start: mid, end, beatLength: newBl, beats: meter - r },
            ]
          }
          if (inh.resetBeats <= 0 && !inh.resetBeatsSet && !this.warnedReset) {
            this.warnedReset = true
            this.diags.push({
              from: inh.from,
              to: inh.to,
              severity: 'info',
              message:
                '该 Timing 未写 resetBeats，已按变更点所在时间推算它落在小节第 ' +
                r.toFixed(2) +
                ' 拍',
              code: 'timing-resetbeats',
            })
          }
        }
      }
    }

    /**
     * 红线：落在本小节内部就截断，落在自然结束点前后 1/8 拍内就对齐过去。
     *
     * 后一种「对齐」是必须的：osu 的 offset 是整数毫秒，而 428.571429ms/拍
     * 这类 BPM 算出来的边界带小数，红线常常比自然结束点晚几毫秒。
     * 不平移的话会切出一个 10ms 的碎片小节 —— 它排不出正文，却会被格子视图
     * 画成一整拍（多出好几格），插入点也被它占掉。
     */
    if (nextRed && redAt > start + SLIVER_MS && redAt <= end + bl * SNAP_BEAT) {
      end = redAt
    }

    if (!(end > start)) end = start + Math.max(1, meter * bl)
    this.cursor = end
    const info: MeasureInfo = { index, start, end, beatLength: bl, meter }
    if (segments) info.segments = segments
    return info
  }
}

/** 小节内每拍的起点、每拍时长，以及小节总拍数（可为小数） */
export interface MeasureBeatLayout {
  times: number[]
  lengths: number[]
  /**
   * 小节覆盖的总拍数，允许小数：红线可能把小节截断在某一拍中间。
   * 正文的单位数要按它来算（`round(beats * 单位)`），
   * 否则截断小节里最后那部分拍就没有格位可用。
   */
  beats: number
}

const layoutCache = new WeakMap<MeasureInfo, MeasureBeatLayout>()

/**
 * 小节内每拍的起点与拍长。
 *
 * 关键点：每一拍的起点都是**从它所在的红线**按该红线的 beatLength 推出来的，
 * 因此「(t - 拍起点) / 拍长 + 拍序号」正好等于「t 相对所在红线走过多少拍」。
 * 导入时判断时值单位必须用这个值，不能拿小节起点硬算——小节中途变速时
 * 红线并不在小节起点上。
 *
 * 拍数由小节的实际时长决定（`round((end - start) / beatLength)`），
 * 而不是简单取拍号分子：红线可能把小节截断成不足 meter 拍。
 */
export function measureBeatLayout(m: MeasureInfo): MeasureBeatLayout {
  const cached = layoutCache.get(m)
  if (cached) return cached

  const times: number[] = []
  const lengths: number[] = []
  let beats = 1
  if (!m.segments || m.segments.length < 2) {
    const bl = m.beatLength > 0 ? m.beatLength : 500
    const span = m.end - m.start
    const meter = Math.max(1, Math.round(m.meter))
    beats = Math.max(1 / 64, span / bl)
    // 拍起点个数 = 覆盖到的整拍 / 半拍起点数（末尾不足一拍也要留起点）
    const n = Math.max(1, Math.min(meter, Math.ceil(beats - 1e-3) || 1))
    /**
     * 拍长按「小节实际时长 ÷ 拍数」均分，而不是一律用 m.beatLength。
     *
     * 红线可能把小节截断/延长十几毫秒（osu 的 offset 是整数毫秒，而
     * 428.571429ms/拍 这类 BPM 算出来的边界带小数）。没有中途变速时，正文解析器
     * 也是按「区域时长 ÷ 时值单位数」均分的，格子这边必须用同一套，
     * 否则点最后一格写出来的音符会掉回前一格、整小节还会因为「音符不在格子上」拒绝编辑。
     * 完整小节（span === meter × beatLength）算出来仍是原拍长，行为不变。
     *
     * 中途变速（segments）时正文解析器改走 beatTimeOf（见 body.ts 的 place），
     * 和这里逐拍推进的 times/lengths 是同一套拍位算法。
     */
    const slot = span > 0 ? span / n : bl
    for (let b = 0; b < n; b++) {
      times.push(m.start + b * slot)
      lengths.push(slot)
    }
  } else {
    // 小节中途变速：逐拍推进，而不是「每段各自从段首展开」。
    //
    // 段首（红线）可能落在某一拍的正中间（例如整拍走了一半才变速），
    // 这时那一拍的长度 = 变速前的一半 + 变速后的一半，之后各拍才按新 BPM 排。
    // 如果让每段都从自己的段首开始铺，会把这一拍拆成两段、拍位整体错开半拍，
    // 正文里所有音符就都提前了半拍。
    const segs = m.segments!
    const meter = Math.max(1, Math.round(m.meter))
    let t = m.start
    let guard = 0
    while (t < m.end - 1e-6 && times.length < meter && guard++ < 1024) {
      // 取「起点不晚于 t 的最后一段」：t 正好落在段边界上时必须归到后一段，
      // 否则会用上一段的拍长去排下一段的第一拍。
      let seg = segs[segs.length - 1]
      for (const s of segs) {
        if (s.start <= t + 1e-9) seg = s
        else break
      }
      const bl = (seg.beatLength ?? m.beatLength) > 0 ? (seg.beatLength ?? m.beatLength) : 500
      let dur = bl
      // 这一拍中间是否跨过了 BPM 变更
      const cut = segs.find((s) => s.start > t + 1e-6 && s.start < t + bl - 1e-6)
      if (cut) {
        const elapsed = cut.start - t
        const frac = elapsed / bl
        const nbl = cut.beatLength > 0 ? cut.beatLength : bl
        dur = elapsed + nbl * (1 - frac)
      }
      if (!(dur > 0)) break
      times.push(t)
      lengths.push(dur)
      t += dur
    }
    if (!times.length) {
      times.push(m.start)
      lengths.push(m.beatLength > 0 ? m.beatLength : 500)
      t = m.end
    }
    // 总拍数：整拍数 + 末尾不足一拍的余量
    const lastT = times[times.length - 1]
    const lastLen = lengths[lengths.length - 1] > 0 ? lengths[lengths.length - 1] : 500
    beats = times.length - 1 + Math.max(0, m.end - lastT) / lastLen
    if (beats < 1 / 64) beats = 1 / 64
    if (beats > times.length) beats = times.length
  }

  const layout: MeasureBeatLayout = { times, lengths, beats }
  layoutCache.set(m, layout)
  return layout
}

/**
 * 小节内所有「拍」的起始时间（升序）。
 * 小节内变速时分两段各自按自己的每拍毫秒数展开。
 *
 * 变速小节的 segments[].beats 是由「红线落在本小节第几拍」反推出来的小数
 * （例如 1.998 / 2.002），直接按它循环会向上取整成 2 + 3 = 5 拍，
 * 导致这一小节比拍号多出一格、正文写出非常规数量的时值单位。
 * measureBeatLayout 里按四舍五入分配整数拍数，并强制各段之和等于 m.meter。
 */
export function measureBeatTimes(m: MeasureInfo): number[] {
  return measureBeatLayout(m).times
}

/**
 * 时间 t 在小节内的「小数拍位」：整数部分是第几拍，小数部分是这一拍走了多少。
 * 因为拍起点是从所在红线推出来的，这个值等价于「t 相对所在红线的拍数」。
 */
export function beatsAt(m: MeasureInfo, t: number): number {
  const { times, lengths } = measureBeatLayout(m)
  if (!times.length) return 0
  if (t <= times[0]) return (t - times[0]) / (lengths[0] > 0 ? lengths[0] : 500)
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= t + 1e-9) lo = mid
    else hi = mid - 1
  }
  return lo + (t - times[lo]) / (lengths[lo] > 0 ? lengths[lo] : 500)
}

/** 把小数拍位换算回时间（拍位可以超出小节拍数，用于量化验算） */
export function beatTimeOf(m: MeasureInfo, beat: number): number {
  const { times, lengths } = measureBeatLayout(m)
  if (!times.length) return m.start
  if (beat >= times.length) {
    const lastLen = lengths[lengths.length - 1] > 0 ? lengths[lengths.length - 1] : 500
    return times[times.length - 1] + (beat - (times.length - 1)) * lastLen
  }
  const i = Math.max(0, Math.floor(beat + 1e-9))
  return times[i] + (beat - i) * (lengths[i] > 0 ? lengths[i] : 500)
}

/**
 * 小节内所有等分刻度的起始时间（升序），每拍再等分成 div 份。
 * 变速小节的每一段用各自的每拍毫秒数等分，因此刻度会随 BPM 变密/变疏。
 */
export function measureTicks(m: MeasureInfo, div: number): number[] {
  const out: number[] = []
  const d = Math.max(1, Math.floor(div))
  const { times, lengths } = measureBeatLayout(m)
  for (let b = 0; b < times.length; b++) {
    const bl = lengths[b] > 0 ? lengths[b] : 500
    for (let i = 0; i < d; i++) out.push(times[b] + (i * bl) / d)
  }
  return out
}

/** 某个时间点落在该小节的第几拍（用于吸附/显示），与导入时的拍位算法保持一致 */
export function beatAt(m: MeasureInfo, t: number): number {
  return beatsAt(m, t)
}
