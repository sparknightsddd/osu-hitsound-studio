import type { ChartDoc, HitsoundDef } from './types'
import { applyChartSettings } from './chartDefaults'

function meta(doc: ChartDoc, key: string, fallback = ''): string {
  const v = doc.metadata[key]
  return v === undefined ? fallback : v
}

function audioFileName(doc: ChartDoc): string {
  const src = doc.audioPath || doc.settings.Audio || doc.settings.Song
  const song = src.replace(/\\/g, '/')
  const i = song.lastIndexOf('/')
  return i >= 0 ? song.slice(i + 1) : song
}

export function modeNumber(doc: ChartDoc): number {
  return doc.settings.Mode === 'taiko' ? 1 : doc.settings.Mode === 'mania' ? 3 : 0
}

/** 一条 [TimingPoints] 行（红线 uninherited=1，绿线 0） */
export interface OsuTimingLine {
  offset: number
  /** 红线 = 每拍毫秒；绿线 = 负的 SV 倍数（-100 = 1.0x） */
  beatLength: number
  meter: number
  /** 0 自动 / 1 normal / 2 soft / 3 drum */
  sampleSet: number
  /** 音效组编号（0 = 不带编号） */
  sampleIndex: number
  volume: number
  uninherited: 0 | 1
  effects: number
}

/** 谱面自己的红线（.hs 的 [Timing] 只有红线，没有 SV 绿线） */
export function defaultTimingLines(doc: ChartDoc): OsuTimingLine[] {
  return doc.timing.map((t) => ({
    offset: Math.round(t.offset + (t.shift || 0)),
    beatLength: Number.isFinite(t.beatLength) ? t.beatLength : 500,
    meter: t.meter || 4,
    sampleSet: 0,
    sampleIndex: 0,
    volume: 80,
    uninherited: 1 as const,
    effects: 0,
  }))
}

export function fmtTimingLine(t: OsuTimingLine): string {
  return `${t.offset},${round6(t.beatLength)},${t.meter},${t.sampleSet},${t.sampleIndex},${t.volume},${t.uninherited},${t.effects}`
}

export function toOsu(
  doc: ChartDoc,
  version = 'Hitsound',
  hitObjects: string[] = [],
  timing?: OsuTimingLine[],
): string {
  const mode = modeNumber(doc)
  const cs = mode === 3 ? String(Math.max(1, doc.settings.Key.length)) : '5'
  const lines: string[] = []
  lines.push('osu file format v14', '')
  lines.push('[General]')
  lines.push(`AudioFilename: ${audioFileName(doc)}`)
  lines.push('AudioLeadIn: 0')
  lines.push('PreviewTime: -1')
  lines.push('Countdown: 0')
  lines.push(`SampleSet: ${doc.settings.Mode === 'taiko' ? 'Drum' : 'Normal'}`)
  lines.push('StackLeniency: 0.7')
  lines.push(`Mode: ${mode}`)
  lines.push('LetterboxInBreaks: 0')
  lines.push('WidescreenStoryboard: 1', '')
  lines.push('[Editor]')
  lines.push('DistanceSpacing: 1')
  lines.push('BeatDivisor: 4')
  lines.push('GridSize: 4')
  lines.push('TimelineZoom: 1')
  if (doc.settings.Bookmarks.length) {
    lines.push(`Bookmarks: ${doc.settings.Bookmarks.map((b) => Math.round(b)).join(',')}`)
  }
  lines.push('')
  lines.push('[Metadata]')
  lines.push(`Title:${meta(doc, 'Title', meta(doc, 'TitleUnicode'))}`)
  lines.push(`TitleUnicode:${meta(doc, 'TitleUnicode')}`)
  lines.push(`Artist:${meta(doc, 'Artist', meta(doc, 'ArtistUnicode'))}`)
  lines.push(`ArtistUnicode:${meta(doc, 'ArtistUnicode')}`)
  lines.push(`Creator:${meta(doc, 'Creator')}`)
  lines.push(`Version:${version}`)
  lines.push(`Source:${meta(doc, 'Source')}`)
  lines.push(`Tags:${meta(doc, 'Tags')}`)
  lines.push(`BeatmapID:${meta(doc, 'BeatmapID', '0')}`)
  lines.push(`BeatmapSetID:${meta(doc, 'BeatmapSetID', '-1')}`, '')
  lines.push('[Difficulty]')
  lines.push('HPDrainRate:5')
  lines.push(`CircleSize:${cs}`)
  lines.push('OverallDifficulty:5')
  lines.push('ApproachRate:5')
  lines.push('SliderMultiplier:1.4')
  lines.push('SliderTickRate:1', '')
  lines.push('[Events]')
  lines.push('//Background and Video events')
  lines.push('//Break Periods')
  lines.push('//Storyboard Layer 0 (Background)')
  lines.push('//Storyboard Layer 1 (Fail)')
  lines.push('//Storyboard Layer 2 (Pass)')
  lines.push('//Storyboard Layer 3 (Foreground)', '')
  lines.push('[TimingPoints]')
  for (const t of timing ?? defaultTimingLines(doc)) lines.push(fmtTimingLine(t))
  lines.push('')
  lines.push('// 音效映射见「导出音效映射」，本节由 osu Hitsound Studio 生成')
  lines.push('[HitObjects]')
  for (const o of hitObjects) lines.push(o)
  lines.push('')
  return lines.join('\r\n')
}

function round6(n: number): string {
  const s = n.toFixed(6)
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

export function toTimelineCsv(doc: ChartDoc): string {
  const rows = ['time_ms,beat,measure,unit_pos,sound,volume,index,duration_ms,line']
  for (const e of doc.events) {
    rows.push(
      [
        // 和 osu 一致：整数毫秒是「拍点时间向下取整」得到的
        Math.floor(e.time + 1e-6),
        e.beat.toFixed(4),
        e.measure,
        e.unitPos.toFixed(4),
        e.names.join('+'),
        e.volume,
        e.index ?? '',
        Math.round(e.duration),
        e.line,
      ].join(','),
    )
  }
  return rows.join('\r\n')
}

export function slotLabel(h: HitsoundDef): string {
  if (!h.alts.length) return 'custom'
  return h.alts
    .map((a) => {
      if (a.custom) return 'custom'
      if (a.sampleSet && a.hitType) return `${a.sampleSet}-${a.hitType}`
      return a.hitType || a.raw
    })
    .join('|')
}

export function toSampleMapJson(doc: ChartDoc, bindings: Record<string, string> = {}): string {
  const obj = {
    basePath: doc.settings.Path,
    audio: doc.audioPath,
    settings: doc.settings,
    hitsounds: doc.hitsounds.map((h) => ({
      name: h.name || null,
      slot: slotLabel(h),
      indices: h.indices.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)),
      value: h.value,
      resolvedPath: h.resolvedPath || null,
      boundFile: bindings[h.name || ''] || null,
    })),
  }
  return JSON.stringify(obj, null, 2)
}

export function toSampleMapText(doc: ChartDoc): string {
  const lines: string[] = ['# 音效映射表（槽位\t名称\t原始值\t解析后的完整路径）']
  if (doc.settings.Path) lines.push(`# [Files] path = ${doc.settings.Path}`)
  for (const h of doc.hitsounds) {
    const idx = h.indices.length
      ? ' {' +
        h.indices.map((r) => (r.from === r.to ? `${r.from}` : `(${r.from},${r.to})`)).join(',') +
        '}'
      : ''
    lines.push(`${slotLabel(h)}${idx}\t${h.name || ''}\t${h.value}\t${h.resolvedPath || ''}`)
  }
  return lines.join('\r\n')
}

export function download(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function osuSections(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur = ''
  for (const l of raw.split('\n')) {
    const m = /^\s*\[([A-Za-z0-9]+)\]\s*$/.exec(l)
    if (m) {
      cur = m[1].toLowerCase()
      if (!out.has(cur)) out.set(cur, [])
      continue
    }
    if (!cur) continue
    out.get(cur)!.push(l.replace(/\s+$/, ''))
  }
  return out
}

function osuKV(lines: string[] | undefined, sep: string): Record<string, string> {
  const o: Record<string, string> = {}
  for (const l of lines || []) {
    const i = l.indexOf(sep)
    if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return o
}

/** 从模板里取某个 section 的正文行（不含段标题） */
function templateBlock(template: string, name: string): string[] {
  const sec = osuSections(template.replace(/\r\n/g, '\n'))
  return (sec.get(name.toLowerCase()) || []).filter((l) => l.trim())
}

export interface OsuImport {
  text: string
  timingCount: number
  skippedGreen: number
  bookmarksCount: number
  /** .osu 所在目录（写进 [Files] path，便于之后自动载入歌曲与音效样本） */
  sourceDir: string
}

/** 默认：红线段超过该时长就不继承拍子（可在 设置 → Timing 里改） */
export const NO_INHERIT_GAP_MS = 4000

/** resetBeats 离整数拍多近就吸附（0.05 拍，450ms/拍时约 22ms） */
const RB_SNAP = 0.05

/**
 * 把 resetBeats 吸附到整数拍。
 *
 * 谱面的红线时间常比拍点差一两毫秒（beatLength 截断），算出来会是 3.998412 这种
 * 「几乎就到边界」的值 —— 直接写进 Timing 会在小节末尾切出一个 2ms 的碎片段，
 * 那个位置附近的音符会被挤到下一拍去。吸附之后 3.998 → 4 → 归 0（正好是边界）。
 */
export function snapResetBeats(rb: number, meter: number): number {
  const nearest = Math.round(rb)
  let v = Math.abs(rb - nearest) < RB_SNAP ? nearest : rb
  if (v >= meter || v < 0) v = 0
  return v
}

/**
 * 判断一条红线是否「开启新小节」（resetMode = 1）。
 *
 * 只看**后一段**：这段红线到下一次 BPM 变更之间的时长超过阈值（默认 4000ms）说明
 * 它是一整个乐段，起点就该是小节第一拍；只占一两拍的短段（弱起/过渡）才继承上一小节，
 * 落在第 n 拍（resetMode = 0）。前一段多长不参与判断 —— 弱起后再接长段很常见。
 *
 * 例：红线 1000 / 1428 / 18570 —— 1428 后面是 17 秒长段，所以 1428 是新小节第一拍，
 * 前面的 1000 就是只有 1 拍的弱起小节。
 *
 * 没有下一条红线（曲末空档不长、补不出收尾行）时按继承处理。
 */
export function shouldResetMode(
  prev: { offset: number; beatLength: number; meter: number },
  cur: { offset: number; meter: number },
  next?: { offset: number } | null,
  threshold = NO_INHERIT_GAP_MS,
): boolean {
  if (cur.meter !== prev.meter) return true
  return !!next && next.offset - cur.offset > threshold
}

/**
 * 在末尾补一条「收尾红线」，让最后一条真实红线到曲末的空档也参与继承判断。
 *
 * 没有它的话，最后一条红线的 resetMode 只能看它与前一条的间距，
 * 而它后面那段可能长达几十秒的空白会被当成连续小节一直延伸下去。
 *
 * @param red 至少有一条红线
 * @param songEnd 乐曲结尾时间（毫秒）
 */
export function appendTailRedLine(
  red: { offset: number; beatLength: number; meter: number }[],
  songEnd: number,
  threshold = NO_INHERIT_GAP_MS,
): { offset: number; beatLength: number; meter: number }[] {
  const last = red[red.length - 1]
  // 已经有一条红线落在曲末（或曲末未知）就不用补
  if (!last || !(songEnd > last.offset)) return red
  // 末尾空档本来就在阈值内，补进去也只是多一条等价的收尾行
  if (songEnd - last.offset <= threshold) return red
  return [...red, { offset: songEnd, beatLength: last.beatLength, meter: last.meter }]
}

/**
 * 取 [HitObjects] 里最后一个物件的时间（毫秒），当作乐曲结尾的下界。
 *
 * 滑条尾比物件本身晚，但这里只需要一个「不早于最后一个物件」的下界，
 * 用来判断末尾空档是否超过阈值，精度足够。
 */
function lastObjectOffset(hitObjects: string[]): number {
  let last = 0
  for (const l of hitObjects) {
    if (!l.trim()) continue
    const p = l.split(',')
    if (p.length < 3) continue
    const t = Number(p[2])
    if (Number.isFinite(t) && t > last) last = t
  }
  return last
}

/**
 * 从 .osu 抽取 [Metadata] / [General] / [TimingPoints]，生成干净的 musictxt。
 * resetMode 推断：到下一条红线的距离 > 2000ms 或拍号变化 → 1（不继承拍子）；
 * 否则 → 0（继承），resetBeats = 该点在小节内的第几拍。
 */
export function fromOsu(
  src: string,
  template: string,
  sourceDir = '',
  opts: { inheritMs?: number } = {},
): OsuImport {
  const inheritMs = opts.inheritMs && opts.inheritMs > 0 ? opts.inheritMs : NO_INHERIT_GAP_MS
  const raw = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const sec = osuSections(raw)
  const meta = osuKV(sec.get('metadata'), ':')
  const gen = osuKV(sec.get('general'), ':')
  // 目录统一成正斜杠、去掉首尾引号，写进 [Files] path
  const dirNorm = sourceDir.replace(/\\/g, '/').replace(/^[/"]+|[/"]+$/g, '')

  // 只要红线（uninherited），绿线是滑条速度，musictxt 的 Timing 不表达
  const red: { offset: number; beatLength: number; meter: number }[] = []
  let skippedGreen = 0
  for (const l of sec.get('timingpoints') || []) {
    if (!l.trim()) continue
    const p = l.split(',').map((x) => x.trim())
    if (p.length < 2) continue
    const off = Number(p[0])
    const bl = Number(p[1])
    if (!Number.isFinite(off) || !Number.isFinite(bl)) continue
    if (bl < 0) {
      skippedGreen++
      continue
    }
    if (!(bl > 0)) continue
    const meter = Number(p[2]) || 4
    red.push({ offset: off, beatLength: bl, meter })
  }
  red.sort((a, b) => a.offset - b.offset)

  // 补一条曲末收尾红线，让最后一条真实红线到曲末的空档也参与继承判断。
  // 曲末优先用音频时长，没有音频信息时就用最后一个物件的时间。
  const tail = lastObjectOffset(sec.get('hitobjects') || [])
  const withTail = appendTailRedLine(red, tail, inheritMs)

  const tps = withTail.map((tp, i) => {
    const head = `${Math.round(tp.offset)},${round6(tp.beatLength)},${tp.meter}`
    if (i === 0) return `${head},0,0`
    const prev = withTail[i - 1]
    if (shouldResetMode(prev, tp, withTail[i + 1], inheritMs)) return `${head},1,0`
    const beats = (tp.offset - prev.offset) / prev.beatLength
    const rb = snapResetBeats(beats % prev.meter, prev.meter)
    // 正好落在小节边界上 → 直接写新小节（和「继承到第 0 拍」等价，但不会被时间反推带偏）
    if (rb === 0) return `${head},1,0`
    return `${head},0,${round6(rb)}`
  })

  const metaKeys = [
    'Title',
    'TitleUnicode',
    'Artist',
    'ArtistUnicode',
    'Creator',
    'Source',
    'Tags',
    'BeatmapID',
    'BeatmapSetID',
  ]
  const metaLines = metaKeys.map((k) => `${k} = ${meta[k] ?? ''}`)

  const modeMap: Record<string, string> = { '0': 'default', '1': 'taiko', '2': 'default', '3': 'mania' }
  let settingsLines = templateBlock(template, 'settings').filter((l) => !/^\s*Song\s*=/i.test(l))
  if (!settingsLines.length) {
    settingsLines = templateBlock(DEFAULT_TEMPLATE_SETTINGS, 'settings')
  }
  // [Settings] 里那几个开关和 PreferredIndex 用应用设置里的默认值
  settingsLines = applyChartSettings(settingsLines)
  const osuMode = modeMap[gen['Mode'] ?? '']
  if (osuMode) {
    const idx = settingsLines.findIndex((l) => /^\s*Mode\s*=/i.test(l))
    const line = `Mode = ${osuMode}`
    if (idx >= 0) settingsLines[idx] = line
    else settingsLines.unshift(line)
  }

  // [Editor] 的 Bookmarks -> [Settings] 的 Bookmarks = {...}
  const ed = osuKV(sec.get('editor'), ':')
  const bms = (ed['Bookmarks'] ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n >= 0)
  let bookmarksCount = 0
  if (bms.length) {
    bookmarksCount = bms.length
    settingsLines = settingsLines.filter((l) => !/^\s*Bookmarks\s*=/i.test(l))
    settingsLines.push(`Bookmarks = {${bms.map((b) => Math.round(b)).join(', ')}}`)
  }

  const defineLines = templateBlock(template, 'define')
  const hitsoundLines = templateBlock(template, 'hitsound')

  const blocks: string[] = []
  blocks.push(['[Metadata]', ...metaLines].join('\n'))
  blocks.push(['[Files]', `path = "${dirNorm}"`, `audio = "${gen['AudioFilename'] ?? ''}"`].join('\n'))
  blocks.push(['[Settings]', ...settingsLines].join('\n'))
  if (defineLines.length) blocks.push(['[Define]', ...defineLines].join('\n'))
  blocks.push(['[Timing]', ...(tps.length ? tps : ['0,bpm(120),4,0,0'])].join('\n'))
  blocks.push(['[Hitsound]', ...(hitsoundLines.length ? hitsoundLines : ['/D D K K/'])].join('\n'))

  return {
    text: blocks.join('\n\n') + '\n',
    timingCount: tps.length,
    skippedGreen,
    bookmarksCount,
    sourceDir: dirNorm,
  }
}

const DEFAULT_TEMPLATE_SETTINGS = `[Settings]
Mode = default
Key = {D, F, J, K}
AutoHitsoundIndex = true
SliderSlideHitsound = false
SliderTickHitsound = false
SpinnerHitsound = false
DefaultOverride = false
StandardFormat = false
PreferredIndex = {11, 45, 14}
TimingAdsorb = beat(0,1,2)
`
