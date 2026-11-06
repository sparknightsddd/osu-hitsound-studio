/**
 * 音高核心：音符代号 <-> 半音 <-> MIDI <-> 频率，以及三种八度定位逻辑。
 *
 * 音符代号（一个八度从低到高）：C H D I E F J G K A L B，其中 H I J K L 是五个黑键。
 * 绝对八度按钢琴音域：A0(MIDI 21) ~ C8(MIDI 108)，第 4 八度为 A=440Hz 所在的八度。
 */

/** 一个八度的音符代号，索引即半音数（0=C  … 11=B） */
export const NOTE_CODES = 'CHDIEFJGKALB' as const

/** 半音 -> 是否为黑键 */
const BLACK = new Set([1, 3, 6, 8, 10])

/** 钢琴音域下限 A0 / 上限 C8（MIDI 编号） */
export const PIANO_LOW = 21
export const PIANO_HIGH = 108
/** 未指定八度时的默认八度（小字一组，A=440Hz 所在的八度） */
export const DEFAULT_OCTAVE = 4

/** 音符代号 -> 半音（非法代号返回 null） */
export function letterToSemi(letter: string): number | null {
  if (letter.length !== 1) return null
  const i = NOTE_CODES.indexOf(letter)
  return i < 0 ? null : i
}

/** 半音 -> 音符代号 */
export function semiToLetter(semi: number): string {
  return NOTE_CODES[((semi % 12) + 12) % 12]
}

/** 音符代号 + 八度 -> MIDI 编号 */
export function midiOf(letter: string, octave: number): number | null {
  const s = letterToSemi(letter)
  if (s === null) return null
  return (octave + 1) * 12 + s
}

/** 音名（如 C4 / H3 / A0）-> MIDI 编号 */
export function nameToMidi(name: string): number | null {
  const m = /^([A-L])(-?\d+)$/.exec(name.trim())
  if (!m) return null
  return midiOf(m[1], Number(m[2]))
}

/** MIDI -> 音名（如 69 -> A4） */
export function midiToName(midi: number): string {
  const m = Math.round(midi)
  const semi = ((m % 12) + 12) % 12
  const oct = Math.floor(m / 12) - 1
  return `${semiToLetter(semi)}${oct}`
}

/**
 * MIDI -> 正文 token（八度写在前面）：60 -> "4C"，61 -> "4H"。
 *
 * 谱面里八度是**前缀**（`4C`），`midiToName` 那种 `C4` 写法会被当成「C 持续 4 拍」。
 */
export function midiToToken(midi: number): string {
  const m = Math.round(midi)
  const oct = Math.floor(m / 12) - 1
  return `${oct}${semiToLetter(((m % 12) + 12) % 12)}`
}

/** 正文 token（八度在前）-> MIDI；不是这种写法就返回 null */
export function tokenToMidi(tok: string): number | null {
  const m = /^(-?\d+)([A-L])$/.exec(tok.trim())
  if (!m) return null
  return midiOf(m[2], Number(m[1]))
}

/** MIDI -> 频率（Hz），tuneCents 为调律偏移（音分，正值升高） */
export function freqOf(midi: number, tuneCents = 0, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69 + tuneCents / 100) / 12)
}

export function isBlackKey(midi: number): boolean {
  return BLACK.has(((Math.round(midi) % 12) + 12) % 12)
}

/** 超出钢琴音域时往音域内拉一个八度（代码谱语法 4.5） */
export function clampToRange(midi: number, low = PIANO_LOW, high = PIANO_HIGH): number {
  let m = midi
  while (m < low) m += 12
  while (m > high) m -= 12
  return m
}

/** 每条谱表独立的音高状态 */
export interface PitchState {
  /** 上一个音符的 MIDI（谱表开头为 null） */
  prev: number | null
  /** 最近一次显式指定的绝对八度（会持续生效，直到下一次指定） */
  octave: number | null
}

export function newPitchState(): PitchState {
  return { prev: null, octave: null }
}

export interface ResolveOpts {
  /** "^" 的数量记正、"_" 的数量记负；0 表示按默认就近规则 */
  rel?: number
  /** 显式绝对八度；与 rel 同时出现时以绝对八度为准 */
  absOct?: number | null
}

/**
 * 按代码谱语法 4.1~4.5 解析出实际 MIDI：
 * - absOct：绝对八度；
 * - rel>0："^"n 表示 +1~+12n 之内的同名音；rel<0 同理向下；
 * - 都没有：默认取与上一个音相差 -6~+5 半音之内的同名音（谱表开头取第 4 八度）；
 * - 结果超出音域则拉回一个八度。
 */
export function resolvePitch(letter: string, st: PitchState, opts: ResolveOpts = {}): number | null {
  const semi = letterToSemi(letter)
  if (semi === null) return null

  // 绝对八度优先（谱表开头也可以用 ^ / _ 表达相对第 4 八度的偏移）
  const absOct = opts.absOct !== undefined && opts.absOct !== null ? opts.absOct : null
  const rel = opts.rel ?? 0
  let out: number
  if (absOct !== null) {
    out = clampToRange((absOct + 1) * 12 + semi)
    st.octave = absOct
  } else if (st.prev === null) {
    const oct = DEFAULT_OCTAVE + rel
    out = clampToRange((oct + 1) * 12 + semi)
  } else if (rel !== 0) {
    const lo = rel > 0 ? (rel - 1) * 12 + 1 : rel * 12
    const hi = rel > 0 ? rel * 12 : (rel + 1) * 12 - 1
    out = pickInRange(semi, st.prev, lo, hi)
  } else {
    out = pickInRange(semi, st.prev, -6, 5)
  }
  st.prev = out
  return out
}

/** 在 diff ∈ [lo,hi] 里挑一个最近的同类音；一个都没有时退回最近的一个 */
function pickInRange(semi: number, prev: number, lo: number, hi: number): number {
  let best: number | null = null
  let bestDiff = Infinity
  let fallback: number | null = null
  let fallbackDiff = Infinity
  for (let oct = -1; oct <= 9; oct++) {
    const m = (oct + 1) * 12 + semi
    const d = m - prev
    if (Math.abs(d) < fallbackDiff) {
      fallbackDiff = Math.abs(d)
      fallback = m
    }
    if (d >= lo && d <= hi && Math.abs(d) < bestDiff) {
      bestDiff = Math.abs(d)
      best = m
    }
  }
  const picked = best !== null ? best : fallback !== null ? fallback : (DEFAULT_OCTAVE + 1) * 12 + semi
  return clampToRange(picked)
}
