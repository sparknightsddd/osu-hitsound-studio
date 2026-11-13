/**
 * 音效谱 → .osu 的导出规划。
 *
 * 纯音效谱里没有「物件位置」，[HitObjects] 只是为了给每个音效落点一个 256,192 的圆圈。
 * 难点不在文本，而在把 `[Define]` 里的代号翻译成 osu 的「采样组编号（sampleIndex）」：
 *
 * - 一个物件只有一对 (normalSet, additionSet, index)：
 *   hitnormal 走 normalSet，whistle/finish/clap 一起走 additionSet。
 *   所以同一时刻叠起来的 w/f/c 必须落在同一个 s/n/d，否则物理上表达不出来（槽位冲突）。
 * - 同一编号下，每个 (set, hit) 只能对应一个音色文件；两种不同音色叠在同一个槽位，
 *   只能先把音频混成一个文件（[AB] 两个 soft-hitwhistle）。
 * - 一个组合能塞进已有编号（该编号上这些槽位空着或正好是同一批音色）就复用，
 *   塞不进去才另起一个编号 —— 这样 4 种组合最多 4 个编号，能复用时会明显更少。
 *
 * 组合的优先级按用户要求：出现次数降序 → 最早出现时间升序。
 * 每个组合内部按槽位优先级取方案：sw > sf > sc > nw > nf > nc > dw > df > dc
 * （显式写了 `soft-hitwhistle|normal-hitwhistle` 的按书写顺序）。
 */
import type { ChartDoc, HitType, HitsoundDef, SampleSet } from './types'
import { defaultTimingLines, toOsu, type OsuTimingLine } from './exporter'

/**
 * 导出提示的翻译钩子。
 *
 * osuExport 是纯计算模块，Node 单测会直接引用它；这里不能静态 import i18n
 * （i18n 会 import `.lang` 文件，tsx 读不了）。应用里由 actions 注入 `t()`，
 * 单测 / 命令行没注入时保持中文原文。
 */
type ExportTranslator = (msg: string, vars?: Record<string, string | number>) => string
let exportT: ExportTranslator = (msg) => msg

/** 注入翻译函数；传 null 恢复原文（测试用） */
export function setExportTranslator(fn: ExportTranslator | null) {
  exportT = fn || ((msg) => msg)
}

const T = (msg: string, vars?: Record<string, string | number>) => exportT(msg, vars)

const SET_NUM: Record<SampleSet, number> = { normal: 1, soft: 2, drum: 3 }
const SETS: SampleSet[] = ['soft', 'normal', 'drum']
const HITS: HitType[] = ['hitnormal', 'hitwhistle', 'hitfinish', 'hitclap']
const HIT_BIT: Record<string, number> = { hitnormal: 1, hitwhistle: 2, hitfinish: 4, hitclap: 8 }

/** 默认槽位顺序（设置里可改）：sw > sf > sc > nw > nf > nc > dw > df > dc */
export const DEFAULT_SLOT_ORDER: string[] = [
  'soft-hitwhistle',
  'soft-hitfinish',
  'soft-hitclap',
  'normal-hitwhistle',
  'normal-hitfinish',
  'normal-hitclap',
  'drum-hitwhistle',
  'drum-hitfinish',
  'drum-hitclap',
]

export interface SlotRef {
  set: SampleSet
  hit: HitType
}

export function isExportHit(hit: string): hit is HitType {
  return (HITS as string[]).includes(hit)
}

export function parseSlotKey(key: string): SlotRef | null {
  const i = key.indexOf('-')
  if (i < 0) return null
  const set = key.slice(0, i) as SampleSet
  const hit = key.slice(i + 1)
  if (!SETS.includes(set) || !isExportHit(hit)) return null
  return { set, hit }
}

function slotKey(set: SampleSet, hit: HitType): string {
  return `${set}-${hit}`
}

// ---------------------------------------------------------------------------
// 音色（[Define] 里的一个代号）
// ---------------------------------------------------------------------------

export interface ExportVoice {
  name: string
  /** 自定义音效的源文件（绝对路径）；default.xxx 为空 */
  file: string
  /** 源扩展名，含点；默认 .wav */
  ext: string
  /** default.xxx 的槽位名（soft-hitwhistle），自定义为空 */
  defaultRef: string
  /** 候选槽位，按优先级 */
  cands: string[]
  /** 定义里的原始值，用于报错 */
  raw: string
}

function extOf(file: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(file)
  return m ? `.${m[1].toLowerCase()}` : '.wav'
}

/**
 * 文件名自带的音效组编号：`soft-hitclap.wav` → 1、`soft-hitclap44.ogg` → 44。
 * 不是标准命名（`clap-a.ogg`）返回 null —— 这种文件无法靠编号找回来。
 */
export function fileSampleIndex(file: string): number | null {
  const base = String(file || '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
  const m = /^(soft|normal|drum)-hit(normal|whistle|finish|clap)(\d*)$/.exec(base)
  if (!m) return null
  const n = m[3] ? Number(m[3]) : 1
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/** 从文件名猜这是哪种音效（custom 槽位没有 hitType，只能这么判断） */
export function guessHitType(file: string): HitType | null {
  const s = file.toLowerCase()
  // hitnormal 先判，避免 "normal-hitclap" 之类被别的词抢先
  for (const h of HITS) if (s.includes(h)) return h
  return null
}

/** 从文件名猜原本属于哪个采样组（drum-hitnormal18.wav → drum） */
export function guessSampleSet(file: string): SampleSet | null {
  const s = file.toLowerCase()
  for (const set of SETS) if (s.includes(set)) return set
  return null
}

/** 该 hit 类型的 set 尝试顺序 */
function setsFor(hit: HitType, order: string[]): SampleSet[] {
  const out: SampleSet[] = []
  for (const k of order) {
    const s = parseSlotKey(k)
    if (s && s.hit === hit && !out.includes(s.set)) out.push(s.set)
  }
  if (!out.length) return [...SETS]
  return out
}

export function buildVoice(h: HitsoundDef, order: string[] = DEFAULT_SLOT_ORDER): ExportVoice | null {
  if (h.kind === 'keysound') return null
  const file = h.resolvedPath || ''
  const cands: string[] = []

  if (h.defaultRef) {
    const s = parseSlotKey(h.defaultRef)
    if (s) cands.push(slotKey(s.set, s.hit))
  } else {
    for (const a of h.alts) {
      if (a.custom) {
        // custom 的槽位没写死：hit 类型从文件名猜，set 留空按优先级挑。
        // 这就是「custom G + soft-hitclap H」里 G 能避开 soft-hitwhistle 的原因。
        // 文件名里本来就带 set（drum-hitnormal18.wav）时优先沿用它，
        // 这样导出的文件数不会凭空翻几倍。
        const src = file || h.value
        const hit = guessHitType(src)
        if (hit) {
          const own = guessSampleSet(src)
          const sets = setsFor(hit, order)
          // 文件名里带 set（drum-hitclap.wav）时把自己的 set 放第一位：
          // 评分会给「第一个候选」很高权重，往返导出时槽位才不会漂
          const ordered = own ? [own, ...sets.filter((s) => s !== own)] : sets
          for (const set of ordered) cands.push(slotKey(set, hit))
        }
      } else if (a.hitType && a.sampleSet) {
        cands.push(slotKey(a.sampleSet, a.hitType))
      } else if (a.hitType) {
        for (const set of setsFor(a.hitType, order)) cands.push(slotKey(set, a.hitType))
      }
    }
  }

  const uniq = [...new Set(cands)]
  if (!uniq.length) return null
  return {
    name: h.name || '',
    file,
    ext: file ? extOf(file) : '.wav',
    defaultRef: h.defaultRef || '',
    cands: uniq,
    raw: h.value,
  }
}

/**
 * 白板在方案里的特殊名字。
 *
 * 正文里不写这个代号，但 osu 的每个物件都会播基础 hitnormal ——
 * 它对应 [Define] 里那条没有代号的 hitnormal 定义，没有写就按
 * `hitsound soft-hitnormal = default.soft-hitnormal` 处理。
 */
export const WHITEBOARD = ''

/** 没有无名 hitnormal 定义时的白板：soft-hitnormal + 内置默认音效 */
export function defaultWhiteboard(): ExportVoice {
  return {
    name: '',
    file: '',
    ext: '.wav',
    defaultRef: 'soft-hitnormal',
    cands: ['soft-hitnormal'],
    raw: 'default.soft-hitnormal',
  }
}

/**
 * 音效组编号的分配顺序：先按 [Settings] PreferredIndex，再从 1 开始补没用过的。
 * 例：`{11, 45, 14}` → 11, 45, 14, 1, 2, 3, …, 10, 12, 13, 15, …
 * 不写 PreferredIndex 就是 1, 2, 3, …
 */
export function indexSequence(preferred: number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const raw of preferred) {
    const n = Math.floor(raw)
    if (n >= 1 && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  // 512 个编号足够用；真超过了再从没用过的继续补
  for (let n = 1; out.length < 512; n++) {
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 组合与槽位方案
// ---------------------------------------------------------------------------

/** slotKey -> 该槽位上的代号（多个 = 需要混合） */
export type SlotMap = Map<string, string[]>

export interface Assignment {
  slots: SlotMap
  byName: Map<string, string>
  score: number
  /**
   * 这个方案里有没有「一个槽位塞了多个不同音效」。
   * 有的话导出时必须混音；只要还有别的排法，就不该选它。
   */
  mixed: boolean
}

export interface Combo {
  key: string
  names: string[]
  /** 第一次出现的时间（毫秒，已向下取整） */
  time: number
  count: number
  volume: number
  /**
   * 正文里写着的音效组编号（导入时从 .osu 的 sampleIndex 带过来的）。
   * 有值时优先用它，导出就不会把 `soft-hitclap44.ogg` 改名成别的编号，
   * 目录里已有的音频文件可以原样复用。
   */
  want?: number
  /** 同一时刻出现了多个编号（叠了物件），只能取最多的那个 */
  indexConflict?: boolean
  /** 分配到的编号；分配失败时为空 */
  group?: number
  assign?: Assignment
}

/** 组合在某个时间点的一次出现（导出时要为每一次出现写一行） */
export interface ComboOccurrence {
  time: number
  volume: number
  combo: Combo
}

/** 一次导出里所有出现过的「同刻叠音组合」，以及它们在时间轴上的每一次出现 */
export function collectCombos(doc: ChartDoc): { combos: Combo[]; occurrences: ComboOccurrence[] } {
  const byTime = new Map<number, { names: Set<string>; volume: number; indices: Map<number, number> }>()
  for (const e of doc.events) {
    if (e.kind === 'keysound') continue
    const t = Math.floor(e.time + 1e-6)
    // 正文里的 `<n>`：导入时就是原 .osu 的 sampleIndex，导出要沿用它
    const idx = typeof e.index === 'number' && Number.isFinite(e.index) && e.index > 0 ? Math.floor(e.index) : null
    const cur = byTime.get(t)
    if (cur) {
      for (const n of e.names) if (n) cur.names.add(n)
      if (idx != null) cur.indices.set(idx, (cur.indices.get(idx) || 0) + 1)
    } else {
      const indices = new Map<number, number>()
      if (idx != null) indices.set(idx, 1)
      byTime.set(t, { names: new Set(e.names.filter(Boolean)), volume: e.volume, indices })
    }
  }

  const map = new Map<string, Combo>()
  const occurrences: ComboOccurrence[] = []
  for (const [time, { names, volume, indices }] of byTime) {
    if (!names.size) continue
    const list = [...names].sort()
    // 同一时刻叠了多个物件、各自编号不同时，一个绿线只能写一个编号，取出现最多的
    let want: number | undefined
    let indexConflict = false
    if (indices.size) {
      const sorted = [...indices.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
      want = sorted[0][0]
      indexConflict = sorted.length > 1
    }
    // 编号也算组合的一部分：同样的音效在别的编号下用的是另一批文件，不能合成一组
    const key = `${list.join('+')}${want ? `#${want}` : ''}`
    let c = map.get(key)
    if (!c) {
      c = { key, names: list, time, count: 0, volume, want }
      map.set(key, c)
    }
    if (indexConflict) c.indexConflict = true
    c.count++
    if (time < c.time) c.time = time
    occurrences.push({ time, volume, combo: c })
  }
  occurrences.sort((a, b) => a.time - b.time)
  return { combos: [...map.values()], occurrences }
}

/** 枚举一个组合所有合法的槽位方案（w/f/c 必须同 set），按优先级降序 */
function assignmentsOf(combo: Combo, voices: Map<string, ExportVoice>, order: string[]): Assignment[] {
  // 组合里没写 hitnormal 时，把「白板」当成隐式成员一起参与槽位分配：
  // 它占的就是基础 hitnormal 的位置，别的代号不能挤进来（否则会串音）。
  const hasNormal = combo.names.some((n) =>
    (voices.get(n)?.cands || []).some((k) => k.endsWith('-hitnormal')),
  )
  const members = hasNormal ? combo.names : [...combo.names, WHITEBOARD]
  const lists = members.map((n) => voices.get(n)?.cands || [])
  if (lists.some((l) => !l.length)) return []

  const out: Assignment[] = []
  const pick: string[] = new Array(members.length)

  const walk = (i: number) => {
    if (i === members.length) {
      const slots: SlotMap = new Map()
      const byName = new Map<string, string>()
      let addSet: SampleSet | null = null
      let normalSet: SampleSet | null = null
      for (let j = 0; j < members.length; j++) {
        const name = members[j]
        const k = pick[j]
        const s = parseSlotKey(k)
        if (!s) return
        if (s.hit === 'hitnormal') {
          // 一个物件只有一个 normalSet：两个不同 set 的 hitnormal 叠不起来
          if (normalSet && normalSet !== s.set) return
          normalSet = s.set
        } else if (addSet === null) addSet = s.set
        else if (addSet !== s.set) return // 槽位冲突：w/f/c 必须同 set
        if (name !== WHITEBOARD) byName.set(name, k)
        const arr = slots.get(k)
        if (arr) {
          if (!arr.includes(name)) arr.push(name)
        } else slots.set(k, [name])
      }

      // 走到这里一定有 hitnormal（白板兜底），不需要再补空槽位
      const mixed = [...slots.values()].some((arr) => arr.filter((n) => n !== WHITEBOARD).length > 1)
      out.push({ slots, byName, score: scoreOf(pick, order, normalSet, addSet, lists), mixed })
      return
    }
    for (const c of lists[i]) {
      pick[i] = c
      walk(i + 1)
    }
  }
  walk(0)
  // 能不混合就不混合：先按「有没有槽位叠了多个音效」分档，再按槽位优先级 / 候选顺序排。
  // 否则 A 同时有 sw/sc、B 只有 sw 时，会优先把 A 也塞进 sw（候选 0 得分更高），
  // 导致本来可以 A→sc / B→sw 的组合被无谓地混音。
  return out.sort((a, b) => Number(a.mixed) - Number(b.mixed) || b.score - a.score)
}

/** 方案得分：槽位越靠前越高；hitnormal 跟 additionSet 同组再补一点 */
function scoreOf(
  pick: string[],
  order: string[],
  normalSet: string | null,
  addSet: string | null,
  lists?: string[][],
): number {
  let score = 0
  let bestRank = 0
  for (const k of pick) {
    const idx = order.indexOf(k)
    score += idx < 0 ? 1 : order.length - idx
    const r = idx < 0 ? 0 : order.length - idx
    if (r > bestRank) bestRank = r
  }
  // 每个代号优先用它自己最靠前的候选（custom 的文件名里带 set、
  // 或显式写了 `soft-hitwhistle|normal-hitwhistle`）。
  // 否则贪心为了复用编号会把 drum-hitclap 挪到 soft-hitclap，
  // 导入再导出时会生成一堆和源文件同名的「新」文件。
  if (lists) {
    for (let j = 0; j < pick.length; j++) {
      const at = lists[j] ? lists[j].indexOf(pick[j]) : -1
      if (at === 0) score += 400
      else if (at > 0) score -= at * 40
    }
  }
  if (normalSet && addSet && normalSet === addSet) score += 5
  return score * 100 + bestRank
}

function sameNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort().join('+')
  const y = [...b].sort().join('+')
  return x === y
}

/**
 * 槽位内容的「音色签名」。
 *
 * 白板（空代号）和显式写了 `default.soft-hitnormal` 的代号是同一个内置音效，
 * 比较时必须当成一样，否则导入的谱（`Ac = default.soft-hitnormal`）和
 * 「没写 hitnormal 的组合」会被判成冲突，多开一个没必要的编号。
 */
function slotSig(names: string[], voices: Map<string, ExportVoice>): string {
  return names
    .map((n) => {
      const v = voices.get(n)
      if (!v) return n ? `n:${n}` : '@'
      // 按「实际音色文件」比较：两个不同的代号指向同一个文件时是同一个声音，
      // 没必要为了代号不同另开一个编号、再复制一份一模一样的音频。
      if (v.file) return `f:${v.file.replace(/\\/g, '/').toLowerCase()}`
      if (v.defaultRef) return `d:${v.defaultRef}`
      return '@'
    })
    .sort()
    .join('+')
}

/**
 * 这个方案能不能塞进已有编号（槽位要么空着，要么正好是同一批音色；空数组 = 必须留空）。
 *
 * 唯一的例外是「隐式白板」：组合里没写 hitnormal 时，导出仍会生成一个带基础音的
 * 圆圈。如果这个编号上已经有 hitnormal 音色（别的物件用的），直接复用那份文件，
 * 不要为了「留空」另开一个编号 —— 那会凭空多出一整套音效文件，
 * 导入的谱也就没法原样导出了。
 */
/** 槽位里是不是「只有白板」（空代号或空数组） */
function isBlankSlot(names: string[]): boolean {
  return !names.length || names.every((n) => !n)
}

function canPlace(
  group: SlotMap,
  a: Assignment,
  voices: Map<string, ExportVoice>,
  /**
   * 允许复用/填充编号里已有的基础 hitnormal。
   * 只对「正文带编号」的组合打开：那种组合是从 .osu 导进来的，
   * 复用已有文件才不会凭空多出 soft-hitclap11 之类的副本；
   * 手写谱没编号，仍按白板语义要求 hitnormal 槽位留空。
   */
  allowNormalReuse = false,
): boolean {
  for (const [k, names] of a.slots) {
    const cur = group.get(k)
    // 编号里还没有这个槽位 → 直接加进来（同一个编号本来就可以带多个槽位的文件）
    if (!cur) continue
    const normalSlot = k.endsWith('-hitnormal')
    const isNormalName = (n: string) => (voices.get(n)?.cands || []).some((c) => c.endsWith('-hitnormal'))
    if (isBlankSlot(names)) {
      if (isBlankSlot(cur)) continue
      // 隐式白板碰上编号里已有的 hitnormal 音色 → 复用，不另开编号
      if (allowNormalReuse && normalSlot && cur.every((n) => !!n && isNormalName(n))) continue
      return false
    }
    if (isBlankSlot(cur)) {
      // 空槽位本来是「必须留空」，但 hitnormal 可以被真正的 normal 音色填上
      if (allowNormalReuse && normalSlot && names.every((n) => !!n && isNormalName(n))) continue
      return false
    }
    if (slotSig(cur, voices) !== slotSig(names, voices)) return false
  }
  return true
}

export interface ExportGroup {
  index: number
  slots: SlotMap
}

// ---------------------------------------------------------------------------
// 导出计划
// ---------------------------------------------------------------------------

export interface ExportFileTask {
  /** 目标文件名（含扩展名），如 soft-hitwhistle2.wav */
  to: string
  /** 自定义源文件（绝对路径），可能多个 = 需要混合 */
  from: string[]
  /** 混音里要一并混进去的内置音效（default.xxx 的槽位名） */
  defaults: string[]
  /** 是否需要混音（from.length + defaults.length > 1） */
  mix: boolean
  /** 每个 from 源文件的延迟（毫秒），按 from 顺序；缺省 0。successor 用 */
  delays?: number[]
  /** 每个 defaults 内置音效的延迟（毫秒），按 defaults 顺序；缺省 0 */
  defaultDelays?: number[]
  /** 允许覆盖目录里同名但内容不同的文件（全局白板副槽位用） */
  overwrite?: boolean
  /**
   * 这个槽位需要混音的位置（毫秒，升序）：
   * 这些时刻有多个音效落在同一个槽位上，导出时会叠成一个 wav。
   * 导出前的提示框直接拿它列 mm:ss:ms。
   */
  mixTimes?: number[]
  /**
   * 混音来源，写进目标 WAV 的 HSSM 块。
   * 重新导入这份 .osu 时，源文件还在就能拆回混合前的多个音效。
   */
  mixMeta?: {
    v: number
    app?: string
    sources: {
      code: string
      set: SampleSet
      hit: HitType
      index: number
      file: string
      path: string
    }[]
  }
}

/** 某个时间点最终要写进 .osu 的 hitSample + hitSound 位 */
export interface ComboSample {
  /** hitSound 位：1 normal / 2 whistle / 4 finish / 8 clap */
  bits: number
  normalSet: SampleSet
  additionSet: SampleSet
  /** 1 normal / 2 soft / 3 drum */
  normalSetNum: number
  additionSetNum: number
  /** 音效组编号，对应 plan.files 里同编号的文件 */
  group: number
  volume: number
  names: string[]
}

/** 一个物件要的「音效组编号 + 音量」 */
export interface SampleMove {
  time: number
  /** 音效组编号 */
  index: number
  volume: number
  /** 该物件主要的采样组（写进绿线的 sampleSet，方便编辑器里继续编辑） */
  set: number
}

/**
 * 把「音效组编号 / 音量」从物件末尾搬到绿线上。
 *
 * osu 编辑器不提供改 hitSample 后两段（index:volume）的入口，正常作图出来的谱
 * 物件总是以 `:0:0:` 结尾，音效组和音量靠绿线（inherited timing point）设置。
 * 所以这里按时间顺序走一遍物件：
 *
 * - 当前生效的线（红线或绿线）本来就是想要的编号/音量 → 什么都不做；
 * - 那一刻正好有红线（或绿线）→ 直接改它的 sampleSet/sampleIndex/volume
 *   （用户要求：有音效落在红线上就只改红线；红绿线重叠时两条一起改）；
 * - 否则插一条绿线，SV 沿用当前值（.hs 没有 SV，所以是 -100 = 1.0x）。
 */
export function applyHitsoundTiming(
  lines: OsuTimingLine[],
  moves: SampleMove[],
): { lines: OsuTimingLine[]; added: number; retargeted: number } {
  // 红线在前绿线在后：同一时刻绿线生效
  const list = lines.slice().sort((a, b) => a.offset - b.offset || b.uninherited - a.uninherited)
  let added = 0
  let retargeted = 0
  let i = -1
  let lastSv = -100

  for (const mv of [...moves].sort((a, b) => a.time - b.time)) {
    while (i + 1 < list.length && list[i + 1].offset <= mv.time) {
      i++
      if (list[i].uninherited === 0) lastSv = list[i].beatLength
    }
    const cur = i >= 0 ? list[i] : null
    if (cur && cur.sampleIndex === mv.index && cur.volume === mv.volume && cur.sampleSet === mv.set) continue

    // 这一刻已经有线：直接改（红绿重叠时两条都改）
    let touched = false
    for (let j = i; j >= 0 && list[j].offset === mv.time; j--) {
      list[j].sampleIndex = mv.index
      list[j].volume = mv.volume
      list[j].sampleSet = mv.set
      touched = true
    }
    if (touched) {
      retargeted++
      continue
    }

    const green: OsuTimingLine = {
      offset: mv.time,
      beatLength: lastSv,
      meter: cur ? cur.meter : 4,
      sampleSet: mv.set,
      sampleIndex: mv.index,
      volume: mv.volume,
      uninherited: 0,
      effects: cur ? cur.effects : 0,
    }
    list.splice(i + 1, 0, green)
    i++
    added++
  }

  return { lines: list, added, retargeted }
}

export interface OsuExportPlan {
  /** 完整的 .osu 文本（[HitObjects] 已填好） */
  text: string
  hitObjects: string[]
  groups: ExportGroup[]
  files: ExportFileTask[]
  errors: string[]
  warnings: string[]
  /** 没有合法槽位、被跳过的组合（写入 .osu 时可以确认后跳过它们） */
  skippedCombos: Combo[]
  /** 「没有合法槽位」的那些 error（其余是缺定义之类的致命错误） */
  noSlotErrors: string[]
  /** 出现的不同组合数 */
  comboCount: number
  /** 混音任务数 */
  mixCount: number
  /** 导出的物件数 */
  objectCount: number
  /** [TimingPoints]（红线 + 为音效组/音量补的绿线） */
  timing: OsuTimingLine[]
  /** 新插的绿线条数 */
  greenLines: number
  /** 时间（整数毫秒）→ 该时刻的样本，供「直接写入 .osu」复用 */
  samples: Map<number, ComboSample>
}

export interface OsuExportOptions {
  /** 谱面版本名（[Metadata] Version） */
  version?: string
  /** 槽位优先级，默认 DEFAULT_SLOT_ORDER */
  slotOrder?: string[]
  /** 用户设置里能不能改默认顺序还没接，先留口子 */
  fallbackVolume?: number
  /**
   * 目标 .osu 已经占用的音效组编号。直接写入现有谱时传进来，
   * 新分配的编号会跳过它们，避免覆盖目标谱自己的音效。
   */
  reservedIndices?: number[]
}

/**
 * `[Define]` → 代号到音色的表（导出和审阅共用）。
 *
 * 没有代号的那条 hitnormal 定义是「白板」：它不出现在正文里，但每个物件都会播，
 * 所以用空字符串当它的名字塞进同一张表。没写就补一个 `default.soft-hitnormal`。
 */
export function buildVoiceMap(
  doc: ChartDoc,
  order: string[] = DEFAULT_SLOT_ORDER,
): { voices: Map<string, ExportVoice>; errors: string[] } {
  const errors: string[] = []
  const voices = new Map<string, ExportVoice>()
  let whiteboard: ExportVoice | null = null
  for (const h of doc.hitsounds) {
    const v = buildVoice(h, order)
    if (!v) continue
    if (!v.name) {
      if (!whiteboard && v.cands.some((k) => k.endsWith('-hitnormal'))) whiteboard = v
      continue
    }
    if (!v.file && !v.defaultRef) {
      errors.push(T('{name}：{raw} 既不是 default.xxx，也没有解析到文件', { name: v.name, raw: v.raw || T('（空）') }))
      continue
    }
    voices.set(v.name, v)
  }
  voices.set(WHITEBOARD, whiteboard || defaultWhiteboard())
  return { voices, errors }
}

// ---------------------------------------------------------------------------
// 审阅：槽位冲突
// ---------------------------------------------------------------------------

export interface SlotConflictReport {
  /** 组合里的代号（字母序，和导出时一致） */
  names: string[]
  /** 这个组合出现了几次 */
  count: number
  /** 每一次出现的时间（毫秒，升序） */
  times: number[]
  /** 为什么排不出合法槽位（中文原文，日志 / 测试 / 兜底用） */
  reason: string
  /**
   * 可翻译版本：msgid + 变量。
   * 界面里用 `tr(reasonKey, vars)` 渲染；`{names}` / `{detail}` 需要按语言拼接，
   * 所以另外给出 reasonList / reasonParts。
   */
  reasonKey: string
  reasonVars: Record<string, string | number>
  /** `{names}` 里的代号（界面按语言用顿号或逗号连接） */
  reasonList?: string[]
  /** `{detail}` 里的明细（界面按语言拼成「T 在 soft/normal」） */
  reasonParts?: { name: string; sets: string[] }[]
}

/**
 * 找出「怎么排都不合法」的叠音组合。
 *
 * 导出时这类组合会直接报错跳过，但错误信息混在导出日志里、只带第一次出现的时间。
 * 审阅里单独列出来：每个组合 + 它的每一次落点，方便顺着时间轴改 [Define]。
 */
export function detectSlotConflicts(
  doc: ChartDoc,
  order: string[] = DEFAULT_SLOT_ORDER,
): SlotConflictReport[] {
  const { voices } = buildVoiceMap(doc, order)
  const { combos, occurrences } = collectCombos(doc)
  const timesByKey = new Map<string, number[]>()
  for (const occ of occurrences) {
    const arr = timesByKey.get(occ.combo.key)
    if (arr) arr.push(occ.time)
    else timesByKey.set(occ.combo.key, [occ.time])
  }

  const out: SlotConflictReport[] = []
  for (const c of combos) {
    if (assignmentsOf(c, voices, order).length) continue
    const times = timesByKey.get(c.key) || [c.time]
    const why = conflictReason(c, voices)
    out.push({
      names: [...c.names],
      count: times.length,
      times,
      reason: why.reason,
      reasonKey: why.reasonKey,
      reasonVars: why.reasonVars,
      reasonList: why.reasonList,
      reasonParts: why.reasonParts,
    })
  }
  return out.sort((a, b) => (a.times[0] ?? 0) - (b.times[0] ?? 0))
}

/** 把「排不出方案」翻译成一句人话；同时给出可翻译的 msgid + 变量 */
function conflictReason(
  c: Combo,
  voices: Map<string, ExportVoice>,
): {
  reason: string
  reasonKey: string
  reasonVars: Record<string, string | number>
  reasonList?: string[]
  reasonParts?: { name: string; sets: string[] }[]
} {
  const missing = c.names.filter((n) => !voices.has(n))
  if (missing.length) {
    const names = missing.join('、')
    return {
      reason: `[Define] 里没有代号 ${names}`,
      reasonKey: '[Define] 里没有代号 {names}',
      reasonVars: { names },
      reasonList: missing,
    }
  }
  const noSlot = c.names.filter((n) => !(voices.get(n)?.cands.length))
  if (noSlot.length) {
    const names = noSlot.join('、')
    return {
      reason: `${names} 没有可用槽位（检查 [Define] 里的写法）`,
      reasonKey: '{names} 没有可用槽位（检查 [Define] 里的写法）',
      reasonVars: { names },
      reasonList: noSlot,
    }
  }

  const candsOf = (n: string) => voices.get(n)?.cands || []
  const setOf = (k: string) => k.slice(0, k.indexOf('-'))
  const isNormal = (k: string) => k.endsWith('-hitnormal')

  /** 每个代号「可能落在哪些采样组」，取交集看还有没有共同解 */
  const common = (list: Set<string>[]) =>
    list.length ? [...list[0]].filter((s) => list.every((x) => x.has(s))) : []
  /** `T 在 soft-hitfinish` 这样列出每个代号各自的去向 */
  const detail = (parts: { name: string; sets: string[] }[]) =>
    parts.map((x) => `${x.name} 在 ${x.sets.join('/')}`).join('、')

  const addParts = c.names
    .map((n) => ({ name: n, sets: [...new Set(candsOf(n).filter((k) => !isNormal(k)).map(setOf))] }))
    .filter((x) => x.sets.length)
  if (addParts.length > 1 && common(addParts.map((x) => new Set(x.sets))).length === 0) {
    return {
      reason: `${detail(addParts)} —— w/f/c 纵向叠音必须同属 soft / normal / drum 之一`,
      reasonKey: '{detail} —— w/f/c 纵向叠音必须同属 soft / normal / drum 之一',
      reasonVars: { detail: detail(addParts) },
      reasonParts: addParts,
    }
  }
  const normalParts = c.names
    .map((n) => ({ name: n, sets: [...new Set(candsOf(n).filter(isNormal).map(setOf))] }))
    .filter((x) => x.sets.length)
  if (normalParts.length > 1 && common(normalParts.map((x) => new Set(x.sets))).length === 0) {
    return {
      reason: `${detail(normalParts)} —— 一个物件只有一个 hitnormal 采样组`,
      reasonKey: '{detail} —— 一个物件只有一个 hitnormal 采样组',
      reasonVars: { detail: detail(normalParts) },
      reasonParts: normalParts,
    }
  }
  return {
    reason: '这些代号的槽位组合不合法（检查 [Define] 里的槽位写法）',
    reasonKey: '这些代号的槽位组合不合法（检查 [Define] 里的槽位写法）',
    reasonVars: {},
  }
}

/** 槽位 / 音效组编号的分配结果（不含文本、文件任务，时间轴这种只读展示可以直接用） */
export interface SlotAssignmentPlan {
  order: string[]
  voices: Map<string, ExportVoice>
  combos: Combo[]
  occurrences: ComboOccurrence[]
  groups: ExportGroup[]
  errors: string[]
  /** 不阻断导出、但值得提醒的事（例如原谱编号被占用只能改号） */
  warnings: string[]
  skippedCombos: Combo[]
  /** 「没有合法槽位」的那些 error（其余是缺定义之类的致命错误） */
  noSlotErrors: string[]
}

/**
 * 只做「代号 → 槽位 → 音效组编号」的装箱，不生成 .osu 文本。
 * 导出（planOsuExport）和时间轴的「槽位」视图共用同一份规则，保证看到的编号就是导出用的编号。
 */
export function planSlotAssignments(doc: ChartDoc, opts: OsuExportOptions = {}): SlotAssignmentPlan {
  const order = opts.slotOrder?.length ? opts.slotOrder : DEFAULT_SLOT_ORDER
  const errors: string[] = []
  const warnings: string[] = []
  /** 没有合法槽位的组合：它们不会出现在 samples 里 */
  const skippedCombos: Combo[] = []

  // 1) 代号 -> 音色；没有代号的那条是「白板」（基础 hitnormal）
  const built = buildVoiceMap(doc, order)
  const voices = built.voices
  errors.push(...built.errors)

  // 2) 组合
  const { combos, occurrences } = collectCombos(doc)
  for (const c of combos) {
    for (const n of c.names) {
      if (!voices.has(n)) errors.push(T('{name}：正文里用到，但 [Define] 里没有这个代号', { name: n }))
    }
  }

  // 3) 贪心装箱：先处理出现次数最多的组合，能复用编号就复用
  const ordered = [...combos].sort((a, b) => b.count - a.count || a.time - b.time)
  const groups: ExportGroup[] = []
  // 编号先后按 [Settings] PreferredIndex：{11,45,14} → 11, 45, 14, 1, 2, 3…
  const reserved = new Set((opts.reservedIndices || []).filter((n) => Number.isFinite(n) && n > 0))
  const seq = indexSequence(Array.isArray(doc.settings.PreferredIndex) ? doc.settings.PreferredIndex : []).filter(
    (n) => !reserved.has(n),
  )
  /** 已经被某个编号组用掉的编号（一个编号只能有一组槽位，否则同名文件会打架） */
  const usedIndices = new Set<number>()
  /**
   * 这份谱是不是「从 .osu 导入的」：只要有一个组合带着正文编号就算。
   * 导入的谱要尽量复用编号里已有的 hitnormal 文件，避免凭空生成新音频；
   * 纯手写的谱没有编号，仍按白板语义把 hitnormal 槽位留空。
   */
  const reuseNormals = combos.some((c) => c.want != null)

  const nextIndex = (prefer?: number): number => {
    if (prefer && prefer >= 1 && !usedIndices.has(prefer) && !reserved.has(prefer)) return prefer
    const free = seq.find((n) => !usedIndices.has(n))
    if (free) return free
    let n = 1
    while (usedIndices.has(n)) n++
    return n
  }

  /** 「没有合法槽位」的那些 error（写入 .osu 时要把它们和致命错误分开） */
  const noSlotErrors: string[] = []
  for (const c of ordered) {
    const sols = assignmentsOf(c, voices, order)
    if (!sols.length) {
      skippedCombos.push(c)
      const msg = T(
        '组合 [{names}]（{time}）没有合法的槽位：w/f/c 纵向叠音必须同属 soft/normal/drum 之一，检查这些代号的槽位定义',
        { names: c.names.join(' '), time: fmtMs(c.time) },
      )
      errors.push(msg)
      noSlotErrors.push(msg)
      continue
    }
    let placed = false
    const apply = (g: ExportGroup, sol: Assignment) => {
      for (const [k, names] of sol.slots) {
        // 白板空槽不能盖掉编号里已有的 hitnormal 音色（那份文件别的物件还要用）
        const cur = g.slots.get(k)
        if (isBlankSlot(names) && cur && !isBlankSlot(cur)) continue
        g.slots.set(k, names)
      }
      c.group = g.index
      c.assign = sol
    }
    const create = (sol: Assignment, prefer?: number) => {
      const index = nextIndex(prefer)
      const g: ExportGroup = { index, slots: new Map() }
      apply(g, sol)
      groups.push(g)
      usedIndices.add(index)
      if (c.want && prefer && index !== prefer) {
        warnings.push(
          T(
            '组合 [{names}]（{time}）原谱用编号 {want}，但该编号已经被另一组音效占用，改用编号 {got}（会新写一份音效文件）',
            { names: c.names.join(' '), time: fmtMs(c.time), want: prefer, got: index },
          ),
        )
      }
    }
    /**
     * 先试「原谱的编号」：导入时正文里的 `<n>` 就是 sampleIndex，
     * 沿用它导出的文件名才和目录里已有的 `soft-hitclap44.ogg` 对得上。
     */
    const tryOriginalIndex = (solutions: Assignment[]): boolean => {
      const want = c.want
      if (!want || want < 1 || reserved.has(want)) return false
      const same = groups.filter((g) => g.index === want)
      for (const sol of solutions) {
        for (const g of same) {
          if (canPlace(g.slots, sol, voices, reuseNormals)) {
            apply(g, sol)
            return true
          }
        }
      }
      if (!same.length && solutions.length) {
        create(solutions[0], want)
        return true
      }
      return false
    }

    // 先只用「不混音」的排法：能塞进已有编号就复用，塞不进就为它单开一个编号。
    // 宁可多一个编号，也不要把两个本来能分开的音效混进同一个槽位。
    const clean = sols.filter((s) => !s.mixed)
    placed = tryOriginalIndex(clean)
    if (!placed) {
      for (const sol of clean) {
        const g = groups.find((x) => canPlace(x.slots, sol, voices, reuseNormals))
        if (g) {
          apply(g, sol)
          placed = true
          break
        }
      }
    }
    if (!placed && clean.length) {
      create(clean[0], c.want)
      placed = true
    }
    // 所有排法都必然混音（例如两个代号都只有 sw）时，才退回原来的贪心装箱
    if (!placed) {
      placed = tryOriginalIndex(sols)
    }
    if (!placed) {
      for (const sol of sols) {
        const g = groups.find((x) => canPlace(x.slots, sol, voices, reuseNormals))
        if (g) {
          apply(g, sol)
          placed = true
          break
        }
      }
      if (!placed) create(sols[0], c.want)
    }
    if (c.indexConflict && c.group) {
      warnings.push(
        T('组合 [{names}]（{time}）同一时刻有多个音效组编号，一个绿线只能写一个，导出统一用编号 {got}', {
          names: c.names.join(' '),
          time: fmtMs(c.time),
          got: c.group,
        }),
      )
    }
  }

  return { order, voices, combos, occurrences, groups, errors, warnings, skippedCombos, noSlotErrors }
}

export function planOsuExport(doc: ChartDoc, opts: OsuExportOptions = {}): OsuExportPlan {
  const warnings: string[] = []
  const slotPlan = planSlotAssignments(doc, opts)
  warnings.push(...slotPlan.warnings)
  const { voices, combos, occurrences, groups, skippedCombos, noSlotErrors } = slotPlan
  const errors = slotPlan.errors

  // 4) [HitObjects]：每一次出现都要一个圆圈，音效组编号在 [TimingPoints] 里给
  const hitObjects: string[] = []
  const moves: SampleMove[] = []
  /** 时间（整数毫秒）→ 这个时刻要写入的样本；直接写 .osu 时用 */
  const samples = new Map<number, ComboSample>()
  let objectCount = 0
  for (const occ of occurrences) {
    const c = occ.combo
    if (!c.group || !c.assign) continue
    const bits = c.names.reduce((n, name) => {
      const k = c.assign!.byName.get(name)
      const s = k ? parseSlotKey(k) : null
      return s ? n | HIT_BIT[s.hit] : n
    }, 0)
    if (!bits) continue
    let normalSet: SampleSet | null = null
    let addSet: SampleSet | null = null
    // 用 slots 而不是 byName：没有 hitnormal 代号时，方案里有一个「必须留空」的
    // hitnormal 槽位，normalSet 要指向它，基础音效才会走 osu 默认。
    for (const k of c.assign.slots.keys()) {
      const s = parseSlotKey(k)
      if (!s) continue
      if (s.hit === 'hitnormal') normalSet = s.set
      else if (!addSet) addSet = s.set
    }
    const ns = SET_NUM[normalSet || addSet || 'normal']
    const as = SET_NUM[addSet || normalSet || 'normal']
    const vol = Math.max(1, Math.min(100, occ.volume || opts.fallbackVolume || 100))
    const group = c.group
    samples.set(occ.time, {
      bits,
      normalSet: normalSet || addSet || 'normal',
      additionSet: addSet || normalSet || 'normal',
      normalSetNum: ns,
      additionSetNum: as,
      group,
      volume: vol,
      names: [...c.names],
    })
    // 后两段固定 0:0：编号和音量交给绿线，物件本体保持编辑器能写出来的样子
    hitObjects.push(`256,192,${occ.time},1,${bits},${ns}:${as}:0:0:`)
    moves.push({ time: occ.time, index: group, volume: vol, set: as })
    objectCount++
  }

  // 5) 文件任务：每个编号下的每个槽位一份文件（同槽位多代号 -> 混音）
  const files: ExportFileTask[] = []
  let mixCount = 0
  /** 编号 -> 这个编号下所有出现（按时间升序，occurrences 本来就是排好的） */
  const occByGroup = new Map<number, typeof occurrences>()
  for (const occ of occurrences) {
    const gi = occ.combo.group
    if (!gi) continue
    const arr = occByGroup.get(gi)
    if (arr) arr.push(occ)
    else occByGroup.set(gi, [occ])
  }
  for (const g of groups) {
    for (const [k, names] of g.slots) {
      const parts = names.map((n) => voices.get(n)).filter((v): v is ExportVoice => !!v)
      if (!parts.length) continue
      const hasCustom = parts.some((v) => !!v.file)
      // 全是 default：osu 自己会用内置音效，不用复制
      if (!hasCustom) continue
      const single = parts.length === 1 ? parts[0] : null
      const from = parts.filter((v) => v.file).map((v) => v.file)
      const defaults = parts.filter((v) => !v.file && v.defaultRef).map((v) => v.defaultRef)
      const mix = from.length + defaults.length > 1
      /**
       * 源文件是无编号的基础名（soft-hitclap.ogg），但这一组用的编号不是 1：
       * osu 找 soft-hitclap44 时会回落到 soft-hitclap，不需要把基础文件复制成 44。
       * 不跳过的话，每次导出都会凭空多出一份「新」音频。
       */
      if (!mix && single && g.index !== 1 && fileSampleIndex(single.file) === 1) continue
      const to = `${k}${g.index === 1 ? '' : g.index}${single ? single.ext : '.wav'}`
      /** 混音落点：同一编号里这个槽位装了多个音效的那些时刻 */
      const mixTimes = mix
        ? (occByGroup.get(g.index) || [])
            .filter((o) => (o.combo.assign?.slots.get(k)?.length ?? 0) > 1)
            .map((o) => o.time)
        : undefined
      if (mix) mixCount++
      // 混音文件里记下「混合前是谁」，重新导入时靠它还原成 [A B]
      const slot = parseSlotKey(k)
      const mixMeta =
        mix && slot
          ? {
              v: 1,
              app: 'osu-hitsound-studio',
              sources: parts.map((v) => ({
                code: v.name,
                set: slot.set,
                hit: slot.hit,
                index: g.index,
                file: v.file.split(/[\\/]/).pop() || '',
                path: v.file,
              })),
            }
          : undefined
      files.push({ to, from, defaults, mix, mixTimes, mixMeta })
    }
  }

  // 6) 音效组编号 / 音量搬到绿线
  const timingPlan = applyHitsoundTiming(defaultTimingLines(doc), moves)
  /**
   * 导出时 [TimingPoints] 的采样组统一写成 soft（2）。
   *
   * 用户要求：绿线的 d/n/s 全部是 soft；导出结果里原本是 auto（0）的
   * （红线默认就是 0）也一并改成 soft，免得谱面里还留着「自动」。
   * 物件本身的 normalSet/additionSet 不动 —— 它决定实际读哪个 wav 文件，
   * 绿线只影响后续自动取值。
   */
  const timingLines = timingPlan.lines.map((l) => ({ ...l, sampleSet: 2 }))
  if (objectCount > 20 && timingPlan.added > objectCount / 3) {
    warnings.push(
      T(
        '这份谱要在 {objects} 个物件之间来回切音效组，补了 {added} 条绿线。如果这不是本意，可以在导入音效时把基础 hitnormal 设成白板，让更多组合共用一个编号。',
        { objects: objectCount, added: timingPlan.added },
      ),
    )
  }

  // 7) 文本
  const text = toOsu(doc, opts.version || 'Hitsound', hitObjects, timingLines)

  return {
    hitObjects,
    groups,
    files,
    errors: [...new Set(errors)],
    noSlotErrors: [...new Set(noSlotErrors)],
    warnings,
    skippedCombos,
    comboCount: combos.length,
    mixCount,
    objectCount,
    timing: timingLines,
    greenLines: timingPlan.added,
    samples,
    text,
  }
}

/**
 * 导出用的标准 .osu 文件名：`<artist> - <title> (<creator>) [[EZHS]].osu`。
 *
 * 主进程写盘时也会按同一规则命名（还会自动递增 `[EZHS1]`），
 * 这里的版本用于「另存为」对话框的默认文件名。
 */
export function osuFileName(doc: ChartDoc, diff = '[EZHS]'): string {
  const clean = (s: string) =>
    String(s || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
  const a = clean(doc.metadata.Artist || doc.metadata.ArtistUnicode) || 'Unknown Artist'
  const t = clean(doc.metadata.Title || doc.metadata.TitleUnicode) || 'Unknown Title'
  const c = clean(doc.metadata.Creator)
  return c ? `${a} - ${t} (${c}) [${diff}].osu` : `${a} - ${t} [${diff}].osu`
}

function fmtMs(t: number): string {
  const m = Math.floor(t / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const ms = t % 1000
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ms).padStart(3, '0')}`
}
