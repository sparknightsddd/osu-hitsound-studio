/**
 * 把音效谱里的音效直接写进一份现有的 .osu（替代 Mapping Tools 的 Hitsound Copier）。
 *
 * 思路和导出音效谱一致：音效谱里的每个时刻已经算好了
 * `hitSound 位 + normalSet/additionSet + 音效组编号 + 音量`，这里只做两件事：
 *   1. 按时间找到目标 .osu 里的物件节点（圆圈 / 滑条头 / 折返点 / 滑条尾 / 转盘尾），
 *      把 hitSound 位和 hitSample 写进去；
 *   2. 在目标 [TimingPoints] 里补绿线，把编号/音量/采样组按时间铺开
 *      （滑条折返点没有自己的 index/volume 字段，只能靠绿线继承）。
 *
 * 不做的事：不动目标谱的其它段落、不改物件位置/时间、不覆盖没有对应音效的物件。
 */
import type { ComboSample } from './osuExport'
import { applyHitsoundTiming, type SampleMove } from './osuExport'
import { fmtTimingLine, type OsuTimingLine } from './exporter'
import { sliderNodeTimes, timingAt, type OsuTimingPoint } from './osuSounds'

export interface PatchOsuOptions {
  /** 匹配物件节点的时间容差（毫秒），默认 2 */
  tolerance?: number
  /** 只在「另存为新难度」时改 [Metadata] 的 Version */
  version?: string
  /** 副槽位（滑条身/滑条点/恢复绿线）额外要铺的绿线 */
  extraMoves?: SampleMove[]
  /** 允许没有主槽位音效（只写全局白板副槽位时用） */
  allowEmpty?: boolean
}

/** 目标谱里的滑条：头/尾、每段开区间、滑条点时刻 */
export interface TargetSlider {
  head: number
  tail: number
  /** 折返段（含头/尾/每个折返点） */
  spans: { start: number; end: number }[]
  /** 滑条点时刻（不含头/尾/折返点） */
  ticks: number[]
}

export interface OsuTargetTimeline {
  /** 能正常下主槽位音效的时刻（圆圈 / 滑条头 / 折返点 / 滑条尾 / 转盘头尾） */
  nodes: Set<number>
  sliders: TargetSlider[]
  tickRate: number
  /** [General] SampleSet，绿线 auto 时的兜底：1 normal / 2 soft / 3 drum */
  generalSet: number
  /** 目标谱原始 timing points（用于恢复滑条身/点之前的采样组） */
  timing: OsuTimingPoint[]
}

export interface PatchOsuStats {
  /** 音效谱里有多少个不同时刻 */
  eventTimes: number
  /** 有多少个时刻在目标谱里找到了节点 */
  matchedTimes: number
  /** 没找到节点的时刻总数 */
  missingCount: number
  /** 没找到节点的时刻（最多列 8 个） */
  missingTimes: number[]
  /** 改了多少个物件 / 节点 */
  objectsPatched: number
  nodesPatched: number
  /** 其中滑条折返点/尾节点 */
  edgeNodesPatched: number
  /** 新插的绿线条数 */
  greenLines: number
}

export interface PatchOsuResult {
  ok: boolean
  text?: string
  error?: string
  stats: PatchOsuStats
}

interface Section {
  /** 段头所在行 */
  head: number
  /** 段内容 [start, end) */
  start: number
  end: number
}

interface ParsedTiming {
  point: OsuTimingPoint
  line: OsuTimingLine
}

interface TargetObject {
  /** 在 lines 里的下标 */
  line: number
  time: number
  type: number
  kind: 'circle' | 'slider' | 'spinner'
  parts: string[]
  slides: number
  nodes: number[]
  edgeSounds: number[]
  edgeSets: { normal: number; addition: number }[]
}

const HEADER_RE = /^\s*\[[^\]]+\]\s*$/

function findSection(lines: string[], name: string): Section | null {
  const want = `[${name}]`.toLowerCase()
  const head = lines.findIndex((l) => l.trim().toLowerCase() === want)
  if (head < 0) return null
  let end = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i])) {
      end = i
      break
    }
  }
  return { head, start: head + 1, end }
}

function parseTiming(lines: string[], sec: Section | null): ParsedTiming[] {
  if (!sec) return []
  const out: ParsedTiming[] = []
  for (let i = sec.start; i < sec.end; i++) {
    const s = lines[i].trim()
    if (!s || s.startsWith('//')) continue
    const p = s.split(',')
    if (p.length < 2) continue
    const time = Number(p[0])
    const beatLength = Number(p[1])
    if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue
    const point: OsuTimingPoint = {
      time,
      beatLength,
      meter: Number(p[2]) || 4,
      sampleSet: Number(p[3]) || 0,
      sampleIndex: Number(p[4]) || 0,
      volume: p[5] === undefined ? 100 : Number(p[5]) || 0,
      uninherited: (Number(p[6]) || 0) === 1,
      effects: Number(p[7]) || 0,
    }
    out.push({
      point,
      line: {
        offset: point.time,
        beatLength: point.beatLength,
        meter: point.meter,
        sampleSet: point.sampleSet,
        sampleIndex: point.sampleIndex,
        volume: point.volume,
        uninherited: point.uninherited ? 1 : 0,
        effects: point.effects,
      },
    })
  }
  out.sort((a, b) => a.point.time - b.point.time)
  return out
}

function sliderMultiplier(lines: string[]): number {
  const sec = findSection(lines, 'Difficulty')
  if (!sec) return 1.4
  for (let i = sec.start; i < sec.end; i++) {
    const m = /^\s*SliderMultiplier\s*:\s*([0-9.]+)/i.exec(lines[i])
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return 1.4
}

/** [Difficulty] SliderTickRate（每拍几个滑条点；默认 1） */
function sliderTickRate(lines: string[]): number {
  const sec = findSection(lines, 'Difficulty')
  if (!sec) return 1
  for (let i = sec.start; i < sec.end; i++) {
    const m = /^\s*SliderTickRate\s*:\s*([0-9.]+)/i.exec(lines[i])
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return 1
}

/** [General] SampleSet：1 normal / 2 soft / 3 drum（不写 = 1） */
function generalSampleSet(lines: string[]): number {
  const sec = findSection(lines, 'General')
  if (!sec) return 1
  for (let i = sec.start; i < sec.end; i++) {
    const m = /^\s*SampleSet\s*:\s*([A-Za-z]+)/i.exec(lines[i])
    if (m) {
      const v = m[1].toLowerCase()
      return v === 'soft' ? 2 : v === 'drum' ? 3 : 1
    }
  }
  return 1
}

function parseEdges(raw: string): { sounds: number[]; sets: { normal: number; addition: number }[] } {
  const sounds = (raw || '')
    .split('|')
    .filter((s) => s.trim() !== '')
    .map((s) => Number(s) || 0)
  const sets = (raw || '')
    .split('|')
    .filter((s) => s.trim() !== '')
    .map((s) => {
      const q = s.split(':')
      return { normal: Number(q[0]) || 0, addition: Number(q[1]) || 0 }
    })
  return { sounds, sets }
}

function parseObjects(
  lines: string[],
  sec: Section | null,
  timing: OsuTimingPoint[],
  sm: number,
): TargetObject[] {
  if (!sec) return []
  const out: TargetObject[] = []
  for (let i = sec.start; i < sec.end; i++) {
    const s = lines[i].trim()
    if (!s || s.startsWith('//')) continue
    const parts = s.split(',')
    if (parts.length < 5) continue
    const time = Number(parts[2])
    const type = Number(parts[3])
    if (!Number.isFinite(time) || !Number.isFinite(type)) continue
    const isSlider = (type & 2) === 2
    const isSpinner = (type & 8) === 8
    if (isSlider) {
      const slides = Math.max(1, Number(parts[6]) || 1)
      const length = Number(parts[7]) || 0
      const nodes = sliderNodeTimes(timing, time, length, slides, sm)
      const edges = parseEdges(parts[8] || '')
      out.push({
        line: i,
        time,
        type,
        kind: 'slider',
        parts,
        slides,
        nodes,
        edgeSounds: edges.sounds,
        edgeSets: edges.sets,
      })
    } else if (isSpinner) {
      const end = Number(parts[5])
      // 转盘头和转盘尾都可能被放了音效：头写物件行，尾只能靠绿线。
      out.push({
        line: i,
        time,
        type,
        kind: 'spinner',
        parts,
        slides: 0,
        nodes: Number.isFinite(end) && end > time ? [time, end] : [time],
        edgeSounds: [],
        edgeSets: [],
      })
    } else {
      out.push({ line: i, time, type, kind: 'circle', parts, slides: 0, nodes: [time], edgeSounds: [], edgeSets: [] })
    }
  }
  return out
}

/**
 * 解析目标谱里「哪些时间能下主槽位音效」以及滑条身/滑条点的位置。
 * 供副槽位规划使用；不改动目标文本。
 */
export function parseOsuTargetTimeline(text: string): OsuTargetTimeline {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  const timingSec = findSection(lines, 'TimingPoints')
  const objectSec = findSection(lines, 'HitObjects')
  const parsedTiming = parseTiming(lines, timingSec)
  const timing = parsedTiming.map((t) => t.point)
  const objects = parseObjects(lines, objectSec, timing, sliderMultiplier(lines))
  const tickRate = sliderTickRate(lines)
  const nodes = new Set<number>()
  const sliders: TargetSlider[] = []

  for (const o of objects) {
    for (const n of o.nodes) nodes.add(n)
    if (o.kind !== 'slider') continue
    const spans: { start: number; end: number }[] = []
    const ticks: number[] = []
    for (let i = 0; i + 1 < o.nodes.length; i++) {
      const start = o.nodes[i]
      const end = o.nodes[i + 1]
      spans.push({ start, end })
      if (tickRate <= 0 || end - start <= 2) continue
      const { beatLength } = timingAt(timing, start)
      const step = Math.max(1, beatLength / tickRate)
      for (let t = start + step; t < end - 2; t += step) {
        const at = Math.round(t)
        if (at <= start + 2 || at >= end - 2) continue
        // 正好压在折返点/尾上时算主槽位，不当滑条点
        if (o.nodes.some((n) => Math.abs(n - at) <= 2)) continue
        if (!ticks.some((x) => Math.abs(x - at) <= 2)) ticks.push(at)
      }
    }
    sliders.push({ head: o.nodes[0], tail: o.nodes[o.nodes.length - 1], spans, ticks })
  }

  return { nodes, sliders, tickRate, generalSet: generalSampleSet(lines), timing }
}

/** 时间 → 样本：容差内取最近的一个（同距离优先取靠前的） */function makeMatcher(samples: Map<number, ComboSample>, tolerance: number) {
  const times = [...samples.keys()].sort((a, b) => a - b)
  return (t: number): { time: number; sample: ComboSample } | null => {
    let lo = 0
    let hi = times.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (times[mid] <= t) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const cands: number[] = []
    if (best >= 0) cands.push(best)
    if (best + 1 < times.length) cands.push(best + 1)
    if (!cands.length) return null
    let pick = cands[0]
    for (const i of cands) {
      if (Math.abs(times[i] - t) < Math.abs(times[pick] - t)) pick = i
    }
    if (Math.abs(times[pick] - t) > tolerance) return null
    return { time: times[pick], sample: samples.get(times[pick])! }
  }
}

/**
 * 目标谱已经用到的音效组编号（TimingPoints 的 sampleIndex + 物件 hitSample 的 index）。
 * 直接写入时把这些编号留给原谱，新的音效组从后面的编号开始。
 */
export function collectOsuSampleIndices(text: string): number[] {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  const used = new Set<number>()
  const timing = findSection(lines, 'TimingPoints')
  if (timing) {
    for (let i = timing.start; i < timing.end; i++) {
      const p = lines[i].trim().split(',')
      if (p.length >= 5) {
        const idx = Number(p[4])
        if (Number.isFinite(idx) && idx > 0) used.add(idx)
      }
    }
  }
  const objects = findSection(lines, 'HitObjects')
  if (objects) {
    for (let i = objects.start; i < objects.end; i++) {
      const p = lines[i].trim().split(',')
      if (p.length < 5) continue
      const type = Number(p[3])
      const isSlider = (type & 2) === 2
      const sample = isSlider ? p[10] : p[5]
      if (!sample) continue
      const idx = Number(sample.split(':')[2])
      if (Number.isFinite(idx) && idx > 0) used.add(idx)
    }
  }
  return [...used].sort((a, b) => a - b)
}

function hitSample(s: ComboSample): string {
  return `${s.normalSetNum}:${s.additionSetNum}:${s.group}:${s.volume}:`
}

function pad(parts: string[], n: number) {
  while (parts.length < n) parts.push('')
}

function setOsuVersion(text: string, version: string): string {
  return text.replace(/^(Version:)[^\r\n]*/m, `$1${version}`)
}

/**
 * 把样本补进目标 .osu 文本。
 *
 * @param targetText 目标 .osu 原文
 * @param samples    planOsuExport(doc).samples
 */
export function patchOsuText(
  targetText: string,
  samples: Map<number, ComboSample>,
  opts: PatchOsuOptions = {},
): PatchOsuResult {
  const stats: PatchOsuStats = {
    eventTimes: samples.size,
    matchedTimes: 0,
    missingCount: 0,
    missingTimes: [],
    objectsPatched: 0,
    nodesPatched: 0,
    edgeNodesPatched: 0,
    greenLines: 0,
  }
  if (!samples.size && !opts.allowEmpty) return { ok: false, error: '音效谱里没有可写入的音效', stats }

  const eol = targetText.includes('\r\n') ? '\r\n' : '\n'
  const lines = targetText.replace(/^\uFEFF/, '').split(/\r?\n/)
  const timingSec = findSection(lines, 'TimingPoints')
  const objectSec = findSection(lines, 'HitObjects')
  if (!timingSec) return { ok: false, error: '目标 .osu 没有 [TimingPoints] 段', stats }
  if (!objectSec) return { ok: false, error: '目标 .osu 没有 [HitObjects] 段', stats }

  const parsedTiming = parseTiming(lines, timingSec)
  const timingPoints = parsedTiming.map((t) => t.point)
  const timingLines = parsedTiming.map((t) => t.line)
  const objects = parseObjects(lines, objectSec, timingPoints, sliderMultiplier(lines))

  const match = makeMatcher(samples, opts.tolerance ?? 2)
  const usedTimes = new Set<number>()
  const patchedLines = new Map<number, string>()
  const moves = new Map<number, SampleMove>()

  for (const obj of objects) {
    const matches = obj.nodes.map((t) => match(t))
    if (!matches.some(Boolean)) continue
    const parts = obj.parts.slice()

    if (obj.kind === 'slider') {
      const head = matches[0]
      const edgeHits: { i: number; time: number; sample: ComboSample }[] = []
      for (let i = 1; i < matches.length; i++) {
        const m = matches[i]
        if (m) edgeHits.push({ i, time: m.time, sample: m.sample })
      }
      const needsEdges = head !== null || edgeHits.length > 0
      if (needsEdges) {
        const n = obj.slides + 1
        const sounds = obj.edgeSounds.slice()
        const sets = obj.edgeSets.slice()
        while (sounds.length < n) sounds.push(0)
        while (sets.length < n) sets.push({ normal: 0, addition: 0 })
        if (head) {
          parts[4] = String(head.sample.bits)
          pad(parts, 11)
          parts[10] = hitSample(head.sample)
          // 滑条头的 hitSound 已经在 parts[4] 里，edgeSounds[0] 是「头部额外音效」，
          // 不清掉会和旧的头部音效叠加。
          sounds[0] = 0
          usedTimes.add(head.time)
          moves.set(head.time, {
            time: head.time,
            index: head.sample.group,
            volume: head.sample.volume,
            set: head.sample.additionSetNum,
          })
        }
        for (const e of edgeHits) {
          sounds[e.i] = e.sample.bits
          sets[e.i] = {
            normal: e.sample.normalSetNum,
            addition: e.sample.additionSetNum,
          }
          usedTimes.add(e.time)
          moves.set(e.time, {
            time: e.time,
            index: e.sample.group,
            volume: e.sample.volume,
            set: e.sample.additionSetNum,
          })
          stats.edgeNodesPatched++
        }
        pad(parts, 11)
        if (sounds.some((x) => x !== 0) || obj.edgeSounds.length) parts[8] = sounds.join('|')
        if (sets.some((s) => s.normal || s.addition) || obj.edgeSets.length)
          parts[9] = sets.map((s) => `${s.normal}:${s.addition}`).join('|')
      }
    } else {
      const m = matches[0]
      if (m) {
        if (obj.kind === 'spinner') {
          pad(parts, 7)
          parts[4] = String(m.sample.bits)
          parts[6] = hitSample(m.sample)
        } else {
          pad(parts, 6)
          parts[4] = String(m.sample.bits)
          parts[5] = hitSample(m.sample)
        }
        usedTimes.add(m.time)
        moves.set(m.time, {
          time: m.time,
          index: m.sample.group,
          volume: m.sample.volume,
          set: m.sample.additionSetNum,
        })
      }
      // 转盘尾没有自己的 hitSample 字段：在尾巴上插绿线换编号/音量
      const tail = obj.kind === 'spinner' ? matches[1] : null
      if (tail) {
        usedTimes.add(tail.time)
        moves.set(tail.time, {
          time: tail.time,
          index: tail.sample.group,
          volume: tail.sample.volume,
          set: tail.sample.additionSetNum,
        })
      }
    }

    patchedLines.set(obj.line, parts.join(','))
    stats.objectsPatched++
    stats.nodesPatched += matches.filter(Boolean).length
  }

  stats.matchedTimes = usedTimes.size
  // 副槽位额外铺的绿线（滑条身/滑条点/在滑条尾恢复采样组）。
  // successor 会改写前一个音效的文件，所以同一时刻要覆盖主槽位的编号；
  // 恢复线只会在尾巴没有主槽位音效时生成，不会盖掉真正的物件音效。
  for (const m of opts.extraMoves || []) moves.set(m.time, m)
  const allTimes = [...samples.keys()].sort((a, b) => a - b)
  const missing = allTimes.filter((t) => !usedTimes.has(t))
  stats.missingCount = missing.length
  stats.missingTimes = missing.slice(0, 8)

  // 编号/音量/采样组铺到绿线上；早于第一条红线的时刻不插绿线（osu 会忽略）
  const firstOffset = timingLines.length ? Math.min(...timingLines.map((t) => t.offset)) : -Infinity
  const timingPlan = applyHitsoundTiming(
    timingLines,
    [...moves.values()].filter((m) => m.time >= firstOffset),
  )
  stats.greenLines = timingPlan.added

  // 按原行号重建：TimingPoints 整段替换，HitObjects 逐行替换，其它原样保留
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === timingSec.start) {
      for (const t of timingPlan.lines) out.push(fmtTimingLine(t))
      if (timingSec.end > timingSec.start) out.push('')
      i = timingSec.end - 1
      continue
    }
    const patched = patchedLines.get(i)
    out.push(patched !== undefined ? patched : lines[i])
  }

  let text = out.join(eol)
  if (/\r?\n$/.test(targetText)) text += eol
  if (opts.version) text = setOsuVersion(text, opts.version)

  return { ok: true, text, stats }
}
