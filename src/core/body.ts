import type {
  BodyMarker,
  Diagnostic,
  KeysoundInstrument,
  MeasureInfo,
  NoteEvent,
  PhraseDef,
  TimingPoint,
} from './types'
import { beatAt, beatTimeOf, measureBeatLayout } from './measures'
import type { MeasureGrid } from './measures'
import { letterToSemi, midiToName, newPitchState, resolvePitch, type PitchState } from './pitch'

export type TokType =
  | 'bar'
  | 'note'
  | 'dash'
  | 'rest'
  | 'num'
  | 'star'
  | 'lp'
  | 'rp'
  | 'lb'
  | 'rb'
  | 'pipe'
  | 'phrase'
  | 'dir'
  /** "^" 相对八度上移 */
  | 'caret'
  /** "_" 相对八度下移 */
  | 'under'

export interface Tok {
  t: TokType
  s: string
  from: number
  to: number
  /** 数字是否应解释为音效组编号 */
  asIndex?: boolean
}

const INDEX_LEFT = new Set([' ', '\t', '/', '|', '[', '(', '>'])

export function tokenizeBody(src: string, base: number, diags: Diagnostic[]): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const push = (t: TokType, from: number, to: number, extra?: Partial<Tok>) => {
    toks.push({ t, s: src.slice(from, to), from: base + from, to: base + to, ...extra })
  }
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#') {
      if (src[i + 1] === '#' || i === 0 || src[i - 1] === ' ' || src[i - 1] === '\t') break
    }
    if (c === '/') {
      push('bar', i, i + 1)
      i++
      continue
    }
    if (c === '-') {
      push('dash', i, i + 1)
      i++
      continue
    }
    if (c === '=') {
      push('rest', i, i + 1)
      i++
      continue
    }
    if (c === '(') {
      push('lp', i, i + 1)
      i++
      continue
    }
    if (c === ')') {
      push('rp', i, i + 1)
      i++
      continue
    }
    if (c === '[') {
      push('lb', i, i + 1)
      i++
      continue
    }
    if (c === ']') {
      push('rb', i, i + 1)
      i++
      continue
    }
    if (c === '|') {
      push('pipe', i, i + 1)
      i++
      continue
    }
    if (c === '*') {
      push('star', i, i + 1)
      i++
      continue
    }
    if (c === '<') {
      const j = src.indexOf('>', i)
      if (j < 0) {
        diags.push({
          from: base + i,
          to: base + src.length,
          severity: 'error',
          message: '指令缺少右尖括号 ">"',
          code: 'dir-unclosed',
        })
        break
      }
      push('dir', i, j + 1)
      i = j + 1
      continue
    }
    if (c === '@') {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      if (j === i + 1) {
        diags.push({
          from: base + i,
          to: base + i + 1,
          severity: 'error',
          message: '@ 后面需要乐句名',
          code: 'phrase-empty',
        })
        i++
        continue
      }
      push('phrase', i, j)
      i = j
      continue
    }
    if (c === '^' || c === '_') {
      let j = i
      while (j < src.length && src[j] === c) j++
      push(c === '^' ? 'caret' : 'under', i, j)
      i = j
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++
      const asIndex = i === 0 || INDEX_LEFT.has(src[i - 1])
      push('num', i, j, { asIndex })
      i = j
      continue
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      // 代号大小写不限，所以一整段连续字母就是一个代号：
      // `AaAa` 是一个名字（不再是 `Aa` + `Aa`），音符之间必须用空格隔开。
      let j = i + 1
      while (j < src.length && /[A-Za-z]/.test(src[j])) j++
      push('note', i, j)
      i = j
      continue
    }
    diags.push({
      from: base + i,
      to: base + i + 1,
      severity: 'error',
      message: `无法识别的字符 "${c}"`,
      code: 'body-char',
    })
    i++
  }
  return toks
}

export interface Unit {
  kind: 'note' | 'rest' | 'group' | 'phrase'
  name?: string
  mode?: 'h' | 'v'
  children?: Unit[]
  phraseName?: string
  dur: number
  vol: number | null
  idx: number | null
  from: number
  to: number
  line: number
  /** keysound 的音高（MIDI 编号） */
  pitch?: number
  /** 所属谱表（keysound） */
  staff?: number
}

export interface BodyCtx {
  diags: Diagnostic[]
  phrases: Map<string, PhraseDef>
  defined: Set<string>
  standardFormat: boolean
  grid: MeasureGrid
  volume: number
  index: number | null
  undefinedNames: Set<string>
  leadDash: number
  lineOf: (pos: number) => number
  /** [Timing]，供 #timing(n) 取时间点 */
  timing: TimingPoint[]
  /** [Settings] 的 Bookmarks，供 #bookmark(n) 取时间点 */
  bookmarks: number[]
  /** hitsound：音符是音效名；keysound：音符是音名代号 A~L */
  mode?: 'hitsound' | 'keysound'
  /** 当前处理到第几条谱表（keysound 用，按行内的 "|" 递增） */
  staff?: number
  /** 每条谱表独立的音高状态（keysound 用） */
  pitchStates?: Map<number, PitchState>
  /** keysound：这条 src 只覆盖某一条谱表（多谱表行），写回时不要带两侧的 `/` */
  ksBare?: boolean
  /** [Keysound] 首行的乐器列表（keysound 用） */
  instruments?: KeysoundInstrument[]
}

const STANDARD_NAMES = new Set(['W', 'F', 'C', 'Ws', 'Fs', 'Cs', 'Wfcs', 'Dwfcs'])

/**
 * 给「连写导致整段被当成一个代号」的情况找一条提示：
 * `AaAa` 在 [Define] 里是 `Aa`，就提示写成 `Aa Aa`。
 */
function splitIntoDefined(name: string, defined: Set<string>): string[] | null {
  if (name.length < 2) return null
  const memo = new Map<number, string[] | null>()
  const walk = (at: number): string[] | null => {
    if (at === name.length) return []
    if (memo.has(at)) return memo.get(at)!
    for (let end = name.length; end > at; end--) {
      const piece = name.slice(at, end)
      if (!defined.has(piece)) continue
      const rest = walk(end)
      if (rest) {
        const out = [piece, ...rest]
        memo.set(at, out)
        return out
      }
    }
    memo.set(at, null)
    return null
  }
  const out = walk(0)
  return out && out.length > 1 ? out : null
}

interface Region {
  toks: Tok[]
  barsBefore: number
  from: number
  to: number
}

function sumDur(units: Unit[]): number {
  return units.reduce((s, u) => s + u.dur, 0)
}

function matchParen(toks: Tok[], i: number, end: number, open: TokType, close: TokType, ctx: BodyCtx): number {
  let depth = 0
  for (let j = i; j < end; j++) {
    if (toks[j].t === open) depth++
    else if (toks[j].t === close) {
      depth--
      if (depth === 0) return j
    } else if (toks[j].t === 'bar') break
  }
  ctx.diags.push({
    from: toks[i].from,
    to: toks[i].to,
    severity: 'error',
    message: '括号没有闭合',
    code: 'paren-unclosed',
  })
  return end
}

function applyDirective(t: Tok, ctx: BodyCtx) {
  const inner = t.s.slice(1, -1).trim()
  const m = /^(volume|v)\s*=\s*(-?\d+)$/i.exec(inner)
  if (m) {
    const v = Number(m[2])
    if (v < 0 || v > 100) {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: 'warning',
        message: `音量 ${v} 超出 0~100 的范围`,
        code: 'volume-range',
      })
    }
    ctx.volume = Math.max(0, Math.min(100, v))
    return
  }
  const m2 = /^(index|i)\s*=\s*(\d+)$/i.exec(inner)
  if (m2) {
    ctx.index = Number(m2[2])
    return
  }
  ctx.diags.push({
    from: t.from,
    to: t.to,
    severity: 'warning',
    message: `未识别的指令 <${inner}>（目前支持 <v=数值> / <volume=数值>）`,
    code: 'dir-unknown',
  })
}

function cloneUnit(u: Unit): Unit {
  return { ...u, children: u.children ? u.children.map(cloneUnit) : undefined }
}

function isKeysound(ctx: BodyCtx): boolean {
  return ctx.mode === 'keysound'
}

/** 取（必要时新建）某条谱表的音高状态 */
function pitchStateOf(ctx: BodyCtx, staff: number): PitchState {
  if (!ctx.pitchStates) ctx.pitchStates = new Map()
  let st = ctx.pitchStates.get(staff)
  if (!st) {
    st = newPitchState()
    ctx.pitchStates.set(staff, st)
  }
  return st
}

function instrumentOf(ctx: BodyCtx, staff: number): string | undefined {
  const list = ctx.instruments || []
  return list[staff]?.name ?? list[list.length - 1]?.name
}

/**
 * 解析 [Keysound] 音符的实际音高。
 * rel 为 "^"/"_" 计数，absOct 为紧跟的绝对八度数字；
 * 两者都没写时沿用本谱表最近一次指定的绝对八度（数字会持续生效，直到下一次指定）。
 */
function resolveKeysoundNote(
  t: Tok,
  st: PitchState,
  rel: number,
  absOct: number | null,
  ctx: BodyCtx,
): number | null {
  const letter = t.s
  if (letter.length !== 1 || letterToSemi(letter) === null) {
    ctx.diags.push({
      from: t.from,
      to: t.to,
      severity: 'error',
      message: `[Keysound] 里 "${letter}" 不是音符代号（只能用 C H D I E F J G K A L B，其中 H I J K L 是黑键）`,
      code: 'ks-note',
    })
    return null
  }
  const useAbs = rel === 0 ? (absOct !== null ? absOct : st.octave) : null
  return resolvePitch(letter, st, { rel, absOct: useAbs })
}

function parseUnits(toks: Tok[], from: number, to: number, ctx: BodyCtx, nested: boolean): Unit[] {
  const out: Unit[] = []
  const ks = isKeysound(ctx)
  /** 紧跟在后面的 "^" / "_" 计数（正=上移，负=下移） */
  let pendingRel = 0
  /** 紧跟在后面的绝对八度（keysound 下替代音效组编号） */
  let pendingOct: number | null = null
  let i = from
  while (i < to) {
    const t = toks[i]
    if (t.t === 'bar') break
    if (t.t === 'pipe') {
      if (ks && !nested) ctx.staff = (ctx.staff ?? 0) + 1
      i++
      continue
    }
    if (t.t === 'caret' || t.t === 'under') {
      if (!ks) {
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: 'error',
          message: `"${t.s}" 是相对八度记号，只有 [Keysound] 正文才支持`,
          code: 'oct-outside',
        })
        i++
        continue
      }
      pendingRel += t.t === 'caret' ? t.s.length : -t.s.length
      i++
      continue
    }
    if (t.t === 'dir') {
      applyDirective(t, ctx)
      i++
      continue
    }
    if (t.t === 'num' && t.asIndex) {
      if (ks) {
        // 同样的位置规则（左边是空格/小节线/竖线/左括号/右尖括号），
        // 但在 [Keysound] 里这个数字表示绝对八度而不是音效组编号。
        const n = Number(t.s)
        if (n < 0 || n > 8)
          ctx.diags.push({
            from: t.from,
            to: t.to,
            severity: 'warning',
            message: `八度 ${n} 超出钢琴音域（0~8），会往音域内拉`,
            code: 'oct-range',
          })
        pendingOct = n
      } else ctx.index = Number(t.s)
      i++
      continue
    }
    if (t.t === 'dash') {
      if (out.length) out[out.length - 1].dur += 1
      else if (!nested) ctx.leadDash += 1
      else
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: 'warning',
          message: '延音符 "-" 前面没有可延长的音符',
          code: 'dash-orphan',
        })
      i++
      continue
    }
    if (t.t === 'lp' || t.t === 'lb') {
      const close = t.t === 'lp' ? 'rp' : 'rb'
      const j = matchParen(toks, i, to, t.t, close, ctx)
      const children = parseUnits(toks, i + 1, j, ctx, true)
      const base: Unit = {
        kind: 'group',
        mode: t.t === 'lp' ? 'h' : 'v',
        children,
        dur: 1,
        vol: ctx.volume,
        idx: ctx.index,
        from: t.from,
        to: toks[Math.min(j, to - 1)].to,
        line: ctx.lineOf(t.from),
      }
      i = Math.min(j + 1, to)
      if (i < to && toks[i].t === 'num' && !toks[i].asIndex) {
        base.dur = Number(toks[i].s)
        base.to = toks[i].to
        i++
      }
      while (i < to && toks[i].t === 'dash') {
        base.dur += 1
        base.to = toks[i].to
        i++
      }
      let reps = 1
      if (i < to && toks[i].t === 'star') {
        const nt = toks[i + 1]
        if (nt && nt.t === 'num') {
          reps = Number(nt.s)
          i += 2
        } else {
          ctx.diags.push({
            from: t.from,
            to: t.to,
            severity: 'error',
            message: '* 后面需要一个重复次数',
            code: 'star-nonum',
          })
          i++
        }
      }
      if (reps < 1) reps = 1
      for (let k = 0; k < reps; k++) {
        const cp = k === 0 ? base : cloneUnit(base)
        out.push(cp)
      }
      continue
    }
    if (t.t === 'note' || t.t === 'rest') {
      let dur = 1
      let endTok = i
      i++
      let guard = 0
      while (i < to && guard++ < 64) {
        if (toks[i].t === 'dash') {
          dur += 1
          endTok = i
          i++
          continue
        }
        if (toks[i].t === 'num' && !toks[i].asIndex) {
          dur = Number(toks[i].s)
          endTok = i
          i++
          continue
        }
        break
      }
      let reps = 1
      if (i < to && toks[i].t === 'star') {
        const nt = toks[i + 1]
        if (nt && nt.t === 'num') {
          reps = Number(nt.s)
          endTok = i + 1
          i += 2
        } else {
          ctx.diags.push({
            from: toks[i].from,
            to: toks[i].to,
            severity: 'error',
            message: '* 后面需要一个重复次数',
            code: 'star-nonum',
          })
          i++
        }
      }
      if (t.t === 'note' && !ks) {
        const name = t.s
        if (!ctx.defined.has(name) && !(ctx.standardFormat && STANDARD_NAMES.has(name))) {
          if (!ctx.undefinedNames.has(name)) {
            ctx.undefinedNames.add(name)
            const split = splitIntoDefined(name, ctx.defined)
            ctx.diags.push({
              from: t.from,
              to: t.to,
              severity: 'warning',
              message: split
                ? `音效 "${name}" 未在 [Define] 中定义；要写成 "${split.join(' ')}"（代号之间必须有空格）`
                : `音效 "${name}" 未在 [Define] 中定义`,
              code: 'hs-undefined',
            })
          }
        }
      }
      if (reps < 1) reps = 1
      for (let k = 0; k < reps; k++) {
        const unit: Unit = {
          kind: t.t === 'note' ? 'note' : 'rest',
          name: t.t === 'note' ? t.s : undefined,
          dur: dur < 1 ? 1 : dur,
          vol: ctx.volume,
          idx: ctx.index,
          from: t.from,
          to: toks[endTok].to,
          line: ctx.lineOf(t.from),
        }
        if (ks && t.t === 'note') {
          const staff = ctx.staff ?? 0
          const st = pitchStateOf(ctx, staff)
          const pitch = resolveKeysoundNote(t, st, pendingRel, k === 0 ? pendingOct : null, ctx)
          if (pitch !== null) {
            unit.pitch = pitch
            unit.name = midiToName(pitch)
          }
          unit.staff = staff
        }
        out.push(unit)
      }
      // 记号只对紧跟其后的那一个音符生效
      pendingRel = 0
      pendingOct = null
      continue
    }
    if (t.t === 'phrase') {
      const name = t.s.slice(1)
      const ph = ctx.phrases.get(name)
      if (!ph) {
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: 'error',
          message: `未定义的乐句 @${name}`,
          code: 'phrase-undefined',
        })
        i++
        continue
      }
      const kids = getPhraseUnits(ph, ctx)
      const isAlone = !nested && from === i && to === i + 1
      const base: Unit = {
        kind: 'phrase',
        mode: 'h',
        phraseName: name,
        children: kids.map(cloneUnit),
        dur: isAlone ? sumDur(kids) : 1,
        vol: ctx.volume,
        idx: ctx.index,
        from: t.from,
        to: t.to,
        line: ctx.lineOf(t.from),
      }
      i++
      if (i < to && toks[i].t === 'num' && !toks[i].asIndex) {
        base.dur = Number(toks[i].s)
        i++
      }
      let reps = 1
      if (i < to && toks[i].t === 'star') {
        const nt = toks[i + 1]
        if (nt && nt.t === 'num') {
          reps = Number(nt.s)
          i += 2
        } else {
          i++
        }
      }
      if (!isAlone && !nested) {
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: 'warning',
          message: `乐句 @${name} 没有独占小节，建议用方括号括起来 [@${name}]`,
          code: 'phrase-notalone',
        })
      }
      if (reps < 1) reps = 1
      for (let k = 0; k < reps; k++) out.push(k === 0 ? base : cloneUnit(base))
      continue
    }
    if (t.t === 'num') {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: 'warning',
        message: '数字左侧不是音符/右括号，无法作为时值；若要表示音效组编号，请在它左边留空格',
        code: 'num-orphan',
      })
      i++
      continue
    }
    if (t.t === 'star') {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: 'error',
        message: '* 左侧缺少要重复的音符或片段',
        code: 'star-orphan',
      })
      i++
      continue
    }
    if (t.t === 'rp' || t.t === 'rb') {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: 'error',
        message: '多余的右括号',
        code: 'paren-extra',
      })
      i++
      continue
    }
    i++
  }
  return out
}

const phraseCache = new WeakMap<PhraseDef, Unit[]>()

function getPhraseUnits(ph: PhraseDef, ctx: BodyCtx): Unit[] {
  const cached = phraseCache.get(ph)
  if (cached) return cached
  const toks = tokenizeBody(ph.body, ph.from, ctx.diags)
  const units = parseUnits(toks, 0, toks.length, ctx, false)
  phraseCache.set(ph, units)
  return units
}

function emitUnit(u: Unit, start: number, span: number, out: NoteEvent[], ctx: BodyCtx, measure: MeasureInfo) {
  if (u.kind === 'note') {
    const ks = isKeysound(ctx)
    out.push({
      time: start,
      duration: span,
      names: [u.name!],
      volume: u.vol ?? 100,
      index: u.idx,
      measure: measure.index + 1,
      unitPos: 0,
      beat: beatAt(measure, start),
      line: u.line,
      from: u.from,
      to: u.to,
      ...(ks
        ? {
            kind: 'keysound' as const,
            pitch: u.pitch,
            staff: u.staff ?? 0,
            instrument: u.staff !== undefined ? instrumentOf(ctx, u.staff) : undefined,
          }
        : { kind: 'hitsound' as const }),
    })
    return
  }
  if (u.kind === 'rest') return
  const kids = u.children || []
  if (u.mode === 'v') {
    for (const ch of kids) emitUnit(ch, start, span, out, ctx, measure)
    return
  }
  const total = sumDur(kids) || 1
  let c = start
  for (const ch of kids) {
    const s = (span * ch.dur) / total
    emitUnit(ch, c, s, out, ctx, measure)
    c += s
  }
}

export interface BodyResult {
  events: NoteEvent[]
  measures: MeasureInfo[]
  usedMeasures: number
  markers: BodyMarker[]
}

/**
 * 解析正文里的段落标记行（以单个 "#" 开头；"##" 是注释，不在这里处理）。
 * 支持：#123456 / #2:03.456 / #02:03.456 / #2:03:456 / #02:03:456 / #bookmark(0) / #timing(0)
 */
export function parseMarkerText(
  raw: string,
  ctx: BodyCtx,
  line: { start: number; end: number; index: number },
): BodyMarker {
  const body = raw.trim()
  const mk = (m: Partial<BodyMarker>): BodyMarker => ({
    raw: body,
    kind: 'ms',
    time: null,
    measure: null,
    line: line.index + 1,
    from: line.start,
    to: line.end,
    ...m,
  })
  const fail = (msg: string) => {
    ctx.diags.push({ from: line.start, to: line.end, severity: 'error', message: msg, code: 'marker-bad' })
    return mk({})
  }

  // #123456 / #-1234 —— 全曲第 N 毫秒（允许负数：osu 的 lead-in 可能早于 0）
  let m = /^(-?\d+)$/.exec(body)
  if (m) return mk({ kind: 'ms', time: Number(m[1]) })

  // #2:03.456 —— 分:秒.毫秒（分可补零，小数点可写成冒号）
  m = /^(\d{1,3}):([0-5]?\d)[:.](\d{1,3})$/.exec(body)
  if (m) {
    const ms = Number(m[3]) * Math.pow(10, 3 - m[3].length)
    return mk({ kind: 'clock', time: Number(m[1]) * 60000 + Number(m[2]) * 1000 + ms })
  }

  // #bookmark(0) —— [Settings] Bookmarks 里的第 n 个
  m = /^bookmark\s*\(\s*(\d+)\s*\)$/i.exec(body)
  if (m) {
    const n = Number(m[1])
    const b = ctx.bookmarks
    if (!b || n >= b.length)
      return fail(`#bookmark(${n}) 超出范围：Bookmarks 只有 ${b ? b.length : 0} 项`)
    return mk({ kind: 'bookmark', arg: n, time: b[n] })
  }

  // #timing(0) —— [Timing] 第 n 条的时间点
  m = /^timing\s*\(\s*(\d+)\s*\)$/i.exec(body)
  if (m) {
    const n = Number(m[1])
    const tp = ctx.timing[n]
    if (!tp) return fail(`#timing(${n}) 超出范围：[Timing] 只有 ${ctx.timing.length} 条`)
    return mk({ kind: 'timing', arg: n, time: tp.offset + (tp.shift || 0) })
  }

  return fail(
    `无法识别的段落标记 "#${body}"（可用：#123456 / #2:03.456 / #02:03:456 / #bookmark(0) / #timing(0)）`,
  )
}

export function parseHitsoundBody(lines: LineInfo[], ctx: BodyCtx): BodyResult {
  const events: NoteEvent[] = []
  const markers: BodyMarker[] = []
  let measureCursor = 0
  let lastRegion: { units: Unit[]; span: number } | null = null
  /** 由纯数字小节（如 /5/）指定的、下一个区域要占的小节数 */
  let pendingSpan = 0

  for (const line of lines) {
    // 段落标记行：以单个 "#" 开头（"##" 已在 stripComment 阶段被剥掉）
    if (line.code.trimStart().startsWith('#')) {
      const marker = parseMarkerText(line.code.trimStart().slice(1), ctx, line)
      if (marker.time !== null) {
        let mi = ctx.grid.indexAt(marker.time)
        // 标记可以比小节起点早不到 1ms：osu 的整数毫秒对拍点/小节线是向下取整的
        // （57279.67 写成 57279），indexAt 会把这种标记算进上一小节。
        // 这里按「下一小节起点只差不到 1ms」纠正回来。
        const next = ctx.grid.get(mi + 1)
        if (next.start - marker.time <= 1 + 1e-9) mi += 1
        marker.measure = mi
        measureCursor = mi
        lastRegion = null
      }
      markers.push(marker)
      continue
    }
    const toks = tokenizeBody(line.code, line.start, ctx.diags)
    if (!toks.some((t) => t.t === 'bar')) {
      if (line.code.trim()) {
        ctx.diags.push({
          from: line.start,
          to: line.end,
          severity: 'info',
          message: '该行不以 "/" 开头，已按指令行忽略',
          code: 'not-phrase',
        })
      }
      continue
    }
    // 按小节线切分出 region（region = 相邻两条小节线之间的内容）
    const regions: Region[] = []
    let cur: Tok[] = []
    let started = false
    for (const t of toks) {
      if (t.t === 'bar') {
        if (!started) {
          if (cur.length) {
            ctx.diags.push({
              from: cur[0].from,
              to: cur[cur.length - 1].to,
              severity: 'error',
              message: '乐句必须以小节线 "/" 开头',
              code: 'no-leading-bar',
            })
            cur = []
          }
          started = true
          continue
        }
        regions.push({
          toks: cur,
          barsBefore: 1,
          from: cur.length ? cur[0].from : t.from,
          to: cur.length ? cur[cur.length - 1].to : t.from,
        })
        cur = []
      } else {
        cur.push(t)
      }
    }
    if (started && cur.length) {
      regions.push({
        toks: cur,
        barsBefore: 1,
        from: cur[0].from,
        to: cur[cur.length - 1].to,
      })
      ctx.diags.push({
        from: cur[cur.length - 1].to,
        to: line.end,
        severity: 'warning',
        message: '该行末尾缺少小节线 "/"，已自动补全',
        code: 'bar-missing',
      })
    }
    // 行首连续小节线：合并为空 region 的跨度到其后第一个非空 region
    let k = 0
    let extra = 0
    while (k < regions.length && regions[k].toks.length === 0) {
      extra += regions[k].barsBefore
      k++
    }
    if (extra > 0 && k < regions.length) {
      regions[k].barsBefore += extra
      regions.splice(0, k)
    } else if (extra > 0) {
      regions.splice(0, k)
    }

    for (const region of regions) {
      // 纯数字小节（如 /5/ / ///// 的简写）：数字不代表音符，而是指定
      // 「下一个区域要摊在几个小节里」。要写音效组编号就放在下一个有音符的小节开头。
      if (region.toks.length === 1 && region.toks[0].t === 'num') {
        const n = Number(region.toks[0].s)
        if (!(n >= 1)) {
          ctx.diags.push({
            from: region.from,
            to: region.to,
            severity: 'error',
            message: `小节跨度必须是正整数，收到 "${region.toks[0].s}"`,
            code: 'span-bad',
          })
          continue
        }
        pendingSpan = (pendingSpan > 0 ? pendingSpan : region.barsBefore) + n - 1
        continue
      }
      let span = region.barsBefore
      if (pendingSpan > 0) {
        span = pendingSpan
        pendingSpan = 0
      }
      let units: Unit[]
      if (
        region.toks.length === 2 &&
        region.toks[0].t === 'star' &&
        region.toks[1].t === 'num'
      ) {
        const reps = Number(region.toks[1].s)
        if (!lastRegion) {
          ctx.diags.push({
            from: region.from,
            to: region.to,
            severity: 'error',
            message: '重复记号 "*n" 前面没有可重复的小节',
            code: 'repeat-orphan',
          })
          continue
        }
        for (let r = 0; r < reps; r++) {
          place(lastRegion.units.map(cloneUnit), lastRegion.span)
        }
        continue
      }
      ctx.leadDash = 0
      ctx.staff = 0
      // [Keysound] 支持多谱表：多条谱表并列演唱同一个区域（各占满整个区域时长）
      const staves = isKeysound(ctx) ? splitByPipe(region.toks) : [region.toks]
      if (staves.length > 1) {
        const all: Unit[] = []
        const baseIdx = measureCursor
        /** 整行只有一个区域、一个小节时，每条谱表都能单独写回自己那一段 */
        const lineSpan = regions.length === 1 && span === 1
        for (let si = 0; si < staves.length; si++) {
          if (!staves[si].length) continue
          ctx.staff = si
          ctx.leadDash = 0
          const part = staves[si]
          const sub = parseUnits(part, 0, part.length, ctx, false)
          const psrc =
            lineSpan && part.length
              ? { from: part[0].from, to: part[part.length - 1].to }
              : undefined
          // 第一条谱表推进小节游标，其余共用同一段，at 传同一个起始小节
          ctx.ksBare = true
          place(sub, span, si === 0 ? undefined : baseIdx, psrc)
          ctx.ksBare = false
          all.push(...sub)
        }
        lastRegion = { units: all, span }
        continue
      }
      units = parseUnits(region.toks, 0, region.toks.length, ctx, false)
      lastRegion = { units, span }
      // 只有「整行只有一个小节」的普通写法才记范围：多小节一行/跨度/重复的
      // 写法替换掉会连带改到别的小节，宁可不支持写回。
      let src: { from: number; to: number } | undefined
      if (regions.length === 1 && span === 1) {
        const a = line.code.indexOf('/')
        const b = line.code.lastIndexOf('/')
        if (a >= 0 && b > a) src = { from: line.start + a, to: line.start + b + 1 }
      }
      place(units, span, undefined, src)
    }
  }

  /** 按顶层的竖线把tokens切成多条谱表 */
  function splitByPipe(toks: Tok[]): Tok[][] {
    const out: Tok[][] = []
    let cur: Tok[] = []
    let depth = 0
    for (const t of toks) {
      if (t.t === 'lp' || t.t === 'lb') depth++
      if (t.t === 'rp' || t.t === 'rb') depth--
      if (t.t === 'pipe' && depth === 0) {
        out.push(cur)
        cur = []
        continue
      }
      cur.push(t)
    }
    out.push(cur)
    return out
  }

  /**
   * @param at 多条谱表共用同一个区域时，非首条第几条都要传同一个起始小节；
   *           不传表示从当前游标开始并推进游标。
   */
  function place(units: Unit[], span: number, at?: number, src?: { from: number; to: number }) {
    const idx = at !== undefined ? at : measureCursor
    if (at === undefined) measureCursor += span
    const first = ctx.grid.get(idx)
    // 记下本区域占用了哪些小节：格子视图靠它区分「正文里没有这一小节」和
    // 「有，但是和别的小节写在同一行 / 被跨度覆盖」——前者可以补一行，后者不能。
    // [Keysound] 用同一个网格，只标 hitsound 段（格子视图写回的是 hitsound 正文）。
    const ks = isKeysound(ctx)
    if (!ks) {
      for (let j = 0; j < span; j++) {
        const mm = ctx.grid.get(idx + j)
        if (mm.coveredBy === undefined) mm.coveredBy = idx
      }
    }
    // 记下正文里这一小节的写回范围：hitsound 用 body，keysound 按谱表各记一段
    if (!ks) {
      if (src && span === 1) first.body = { from: src.from, to: src.to }
    } else {
      const staff = ctx.staff ?? 0
      const writable = !!src && span === 1
      if (writable) {
        const rec = first.ksBodies || (first.ksBodies = {})
        rec[staff] = { from: src!.from, to: src!.to, bare: !!ctx.ksBare }
      } else {
        // 跨度 / 重复 / 一行多个区域：改写会把别的小节带跑，这一条谱表就当不可写
        for (let j = 0; j < span; j++) {
          const mm = ctx.grid.get(idx + j)
          mm.ksCovered = { ...(mm.ksCovered || {}), [staff]: true }
        }
      }
    }
    const last = ctx.grid.get(idx + span - 1)
    const start = first.start
    const end = last.end
    const lead = ctx.leadDash
    ctx.leadDash = 0
    const total = lead + sumDur(units)
    if (total <= 0) return
    const unitDur = (end - start) / total
    /**
     * 小节中途变过 BPM（segments）时，不能按整小节时长均分：
     * 第 3 拍在 1000ms，均分却会算成 750ms，格子里的音符就整体错位。
     * 把「第几个时值单位」按总拍数换算成拍位，再用 beatTimeOf 映射回时间，
     * 和 measureTicks / 格子视图用同一套拍位算法。
     *
     * 只处理「一个区域正好一个小节」的普通写法；跨小节 / 重复写法仍按时间均分。
     */
    const segmented = span === 1 && !!first.segments && first.segments.length > 1
    /**
     * 用「拍起点个数」而不是 layout.beats（可能是 3.9967 这种小数）：
     * 红线可能比理论小节末尾早一点点，按 3.9967 均分会让后面的 token
     * 每个都提前 1ms 左右，正好掉到上一格。16 个 token 的 1/4 网格里，
     * 第 9 个 token 应该是第 3 拍（beat 2.0），不能用 3.9967/4 去压。
     */
    const totalBeats = segmented ? measureBeatLayout(first).times.length : 0
    const timeAt = (pos: number) =>
      segmented ? beatTimeOf(first, (pos / total) * totalBeats) : start + pos * unitDur
    if (lead > 0 && events.length) {
      const prev = events[events.length - 1]
      prev.duration += timeAt(lead) - start
    }
    let pos = lead
    for (const u of units) {
      const t0 = timeAt(pos)
      const t1 = timeAt(pos + u.dur)
      emitUnit(u, t0, t1 - t0, events, ctx, first)
      pos += u.dur
    }
  }

  events.sort((a, b) => a.time - b.time || a.from - b.from)
  // 回填 unitPos
  let lastMeasure = -1
  let lastStart = 0
  let lastLen = 1
  for (const e of events) {
    if (e.measure !== lastMeasure) {
      lastMeasure = e.measure
      const m = ctx.grid.get(e.measure - 1)
      lastStart = m.start
      lastLen = m.end - m.start || 1
    }
    e.unitPos = (e.time - lastStart) / lastLen
  }
  return { events, measures: ctx.grid.snapshot(), usedMeasures: measureCursor, markers }
}

export interface LineInfo {
  text: string
  code: string
  start: number
  end: number
  index: number
}
