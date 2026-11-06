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
}

export interface Combo {
  key: string
  names: string[]
  /** 第一次出现的时间（毫秒，已向下取整） */
  time: number
  count: number
  volume: number
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
  const byTime = new Map<number, { names: Set<string>; volume: number }>()
  for (const e of doc.events) {
    if (e.kind === 'keysound') continue
    const t = Math.floor(e.time + 1e-6)
    const cur = byTime.get(t)
    if (cur) {
      for (const n of e.names) if (n) cur.names.add(n)
    } else {
      byTime.set(t, { names: new Set(e.names.filter(Boolean)), volume: e.volume })
    }
  }

  const map = new Map<string, Combo>()
  const occurrences: ComboOccurrence[] = []
  for (const [time, { names, volume }] of byTime) {
    if (!names.size) continue
    const list = [...names].sort()
    const key = list.join('+')
    let c = map.get(key)
    if (!c) {
      c = { key, names: list, time, count: 0, volume }
      map.set(key, c)
    }
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
      out.push({ slots, byName, score: scoreOf(pick, order, normalSet, addSet, lists) })
      return
    }
    for (const c of lists[i]) {
      pick[i] = c
      walk(i + 1)
    }
  }
  walk(0)
  return out.sort((a, b) => b.score - a.score)
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
      if (v && !v.file && v.defaultRef) return `@${v.defaultRef}`
      if (!n) return '@'
      return n
    })
    .sort()
    .join('+')
}

/** 这个方案能不能塞进已有编号（槽位要么空着，要么正好是同一批音色；空数组 = 必须留空） */
function canPlace(group: SlotMap, a: Assignment, voices: Map<string, ExportVoice>): boolean {
  for (const [k, names] of a.slots) {
    const cur = group.get(k)
    if (!names.length) {
      // 要求这个槽位没有自定义音效，编号里却已经放了 → 会串音
      if (cur && cur.length) return false
      continue
    }
    if (cur && slotSig(cur, voices) !== slotSig(names, voices)) return false
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
    if (cur && cur.sampleIndex === mv.index && cur.volume === mv.volume) continue

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
}

export interface OsuExportOptions {
  /** 谱面版本名（[Metadata] Version） */
  version?: string
  /** 槽位优先级，默认 DEFAULT_SLOT_ORDER */
  slotOrder?: string[]
  /** 用户设置里能不能改默认顺序还没接，先留口子 */
  fallbackVolume?: number
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
      errors.push(`${v.name}：${v.raw || '（空）'} 既不是 default.xxx，也没有解析到文件`)
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
  /** 为什么排不出合法槽位 */
  reason: string
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
    out.push({
      names: [...c.names],
      count: times.length,
      times,
      reason: conflictReason(c, voices),
    })
  }
  return out.sort((a, b) => (a.times[0] ?? 0) - (b.times[0] ?? 0))
}

/** 把「排不出方案」翻译成一句人话 */
function conflictReason(c: Combo, voices: Map<string, ExportVoice>): string {
  const missing = c.names.filter((n) => !voices.has(n))
  if (missing.length) return `[Define] 里没有代号 ${missing.join('、')}`
  const noSlot = c.names.filter((n) => !(voices.get(n)?.cands.length))
  if (noSlot.length) return `${noSlot.join('、')} 没有可用槽位（检查 [Define] 里的写法）`

  const candsOf = (n: string) => voices.get(n)?.cands || []
  const setOf = (k: string) => k.slice(0, k.indexOf('-'))
  const isNormal = (k: string) => k.endsWith('-hitnormal')

  /** 每个代号「可能落在哪些采样组」，取交集看还有没有共同解 */
  const common = (list: Set<string>[]) =>
    list.length ? [...list[0]].filter((s) => list.every((x) => x.has(s))) : []
  /** `T 在 soft-hitfinish` 这样列出每个代号各自的去向 */
  const detail = (parts: { n: string; sets: string[] }[]) =>
    parts.map((x) => `${x.n} 在 ${x.sets.join('/')}`).join('、')

  const addParts = c.names
    .map((n) => ({ n, sets: [...new Set(candsOf(n).filter((k) => !isNormal(k)).map(setOf))] }))
    .filter((x) => x.sets.length)
  if (addParts.length > 1 && common(addParts.map((x) => new Set(x.sets))).length === 0) {
    return `${detail(addParts)} —— w/f/c 纵向叠音必须同属 soft / normal / drum 之一`
  }
  const normalParts = c.names
    .map((n) => ({ n, sets: [...new Set(candsOf(n).filter(isNormal).map(setOf))] }))
    .filter((x) => x.sets.length)
  if (normalParts.length > 1 && common(normalParts.map((x) => new Set(x.sets))).length === 0) {
    return `${detail(normalParts)} —— 一个物件只有一个 hitnormal 采样组`
  }
  return '这些代号的槽位组合不合法（检查 [Define] 里的槽位写法）'
}

export function planOsuExport(doc: ChartDoc, opts: OsuExportOptions = {}): OsuExportPlan {
  const order = opts.slotOrder?.length ? opts.slotOrder : DEFAULT_SLOT_ORDER
  const errors: string[] = []
  const warnings: string[] = []

  // 1) 代号 -> 音色；没有代号的那条是「白板」（基础 hitnormal）
  const built = buildVoiceMap(doc, order)
  const voices = built.voices
  errors.push(...built.errors)

  // 2) 组合
  const { combos, occurrences } = collectCombos(doc)
  for (const c of combos) {
    for (const n of c.names) {
      if (!voices.has(n)) errors.push(`${n}：正文里用到，但 [Define] 里没有这个代号`)
    }
  }

  // 3) 贪心装箱：先处理出现次数最多的组合，能复用编号就复用
  const ordered = [...combos].sort((a, b) => b.count - a.count || a.time - b.time)
  const groups: ExportGroup[] = []
  // 编号先后按 [Settings] PreferredIndex：{11,45,14} → 11, 45, 14, 1, 2, 3…
  const seq = indexSequence(Array.isArray(doc.settings.PreferredIndex) ? doc.settings.PreferredIndex : [])
  for (const c of ordered) {
    const sols = assignmentsOf(c, voices, order)
    if (!sols.length) {
      errors.push(
        `组合 [${c.names.join(' ')}]（${fmtMs(c.time)}）没有合法的槽位：` +
          `w/f/c 纵向叠音必须同属 soft/normal/drum 之一，检查这些代号的槽位定义`,
      )
      continue
    }
    let placed = false
    for (const sol of sols) {
      const g = groups.find((x) => canPlace(x.slots, sol, voices))
      if (g) {
        for (const [k, names] of sol.slots) g.slots.set(k, names)
        c.group = g.index
        c.assign = sol
        placed = true
        break
      }
    }
    if (!placed) {
      const g: ExportGroup = { index: seq[groups.length] ?? groups.length + 1, slots: new Map() }
      const sol = sols[0]
      for (const [k, names] of sol.slots) g.slots.set(k, names)
      groups.push(g)
      c.group = g.index
      c.assign = sol
    }
  }

  // 4) [HitObjects]：每一次出现都要一个圆圈，音效组编号在 [TimingPoints] 里给
  const hitObjects: string[] = []
  const moves: SampleMove[] = []
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
    // 后两段固定 0:0：编号和音量交给绿线，物件本体保持编辑器能写出来的样子
    hitObjects.push(`256,192,${occ.time},1,${bits},${ns}:${as}:0:0:`)
    moves.push({ time: occ.time, index: c.group, volume: vol, set: as })
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
      const to = `${k}${g.index === 1 ? '' : g.index}${single ? single.ext : '.wav'}`
      const from = parts.filter((v) => v.file).map((v) => v.file)
      const defaults = parts.filter((v) => !v.file && v.defaultRef).map((v) => v.defaultRef)
      const mix = from.length + defaults.length > 1
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
  if (objectCount > 20 && timingPlan.added > objectCount / 3) {
    warnings.push(
      `这份谱要在 ${objectCount} 个物件之间来回切音效组，补了 ${timingPlan.added} 条绿线。` +
        `如果这不是本意，可以在导入音效时把基础 hitnormal 设成白板，让更多组合共用一个编号。`,
    )
  }

  // 7) 文本
  const text = toOsu(doc, opts.version || 'Hitsound', hitObjects, timingPlan.lines)

  return {
    hitObjects,
    groups,
    files,
    errors: [...new Set(errors)],
    warnings,
    comboCount: combos.length,
    mixCount,
    objectCount,
    timing: timingPlan.lines,
    greenLines: timingPlan.added,
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
