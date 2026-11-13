/**
 * 把 MIDI / musictxt 的音符导入到当前谱面的 [Keysound] 里。
 *
 * 为什么走「格子写回」而不是自己拼正文：
 *   - 正文是按小节等分的，一个 token 的时值取决于这一小节里有多少个 token；
 *     想把音插进某个位置就必须把这一小节按同一分辨率铺平，这正是 gridEdit 干的事；
 *   - 它还负责补 `#毫秒` 标记、补 [Keysound] 段、补谱表管道符这些边界情况。
 *
 * 因此这里只做三件事：
 *   1. 把各种来源的音符统一成 { pitch, time, velocity }；
 *   2. 按小节网格量化到 (小节, 每拍第几格)；
 *   3. 合成 CellEdit 列表交给 applyCellEdits，一次替换（撤销是一步）。
 */
import type { ChartDoc, HitsoundDef, MeasureInfo } from './types'
import { MeasureGrid, beatTimeOf, beatsAt, measureBeatTimes } from './measures'
import { applyCellEdits, readMeasureCells, type CellEdit, type GridEditTarget } from './gridEdit'
import { PIANO_HIGH, PIANO_LOW, clampToRange, midiToName } from './pitch'
import { parseChart } from './parse'

/** 统一后的待导入音符（时间单位毫秒） */
export interface ImportNote {
  pitch: number
  time: number
  /** 力度 1~127；没有就当 100 */
  velocity?: number
  /** 时值（毫秒），只用于界面统计，写进正文时一个音占一格 */
  duration?: number
}

export interface KeysoundImportOptions {
  /** 目标谱表下标（0 起） */
  staff: number
  /** 每拍几格：4 = 十六分音符，8 = 三十二分音符 */
  div: number
  /** 整体平移（毫秒，可负） */
  offsetMs?: number
  /** 移调（半音，可负） */
  transpose?: number
  /** 超出钢琴音域时：拉回音域 / 跳过 */
  outOfRange?: 'clamp' | 'skip'
  /** 音量：固定值 / 按 MIDI 力度换算 */
  volumeMode?: 'fixed' | 'velocity'
  /** volumeMode=fixed 时的音量（0~100） */
  fixedVolume?: number
  /** 导入前清空目标谱表已有的音符 */
  replace?: boolean
  /** 新建 [Keysound] 段时用的乐器名 */
  instrument?: string
  /** 新建 [Keysound] 段时按谱表顺序列出的乐器名 */
  instruments?: string[]
}

export interface KeysoundImportStats {
  /** 来源里参与导入的音符数（移调 / 音域过滤前） */
  notes: number
  /** 真正写进去的音符数 */
  placed: number
  /** 因为音域 / 时间范围 / 小节写法被跳过的音符数 */
  skipped: number
  /** 占用的格子数（同一格的和弦算一个） */
  cells: number
  /** 改动的小节数 */
  measures: number
  /** 第一个 / 最后一个音符的时间（毫秒，已含偏移） */
  firstMs: number
  lastMs: number
  /** 最后一个被改的小节（1 起，0 表示没有） */
  maxMeasure: number
  /** 量化带来的最大时间误差（毫秒） */
  quantizeMs: number
}

export interface KeysoundImportResult {
  ok: boolean
  text?: string
  reason?: string
  stats: KeysoundImportStats
  warnings: string[]
}

const EMPTY_STATS = (): KeysoundImportStats => ({
  notes: 0,
  placed: 0,
  skipped: 0,
  cells: 0,
  measures: 0,
  firstMs: 0,
  lastMs: 0,
  maxMeasure: 0,
  quantizeMs: 0,
})

/**
 * 把谱面的小节列表补到覆盖 `untilMs` 为止。
 *
 * 解析出来的 `doc.measures` 通常只铺到歌曲结束，MIDI 比歌长时就得往后补。
 * 这里用同一套 MeasureGrid 生成（输入相同，结果逐小节一致），并先核对前几小节，
 * 万一不一致就退回原来的列表 —— 宁可少导入，也不要让写回落到错的小节上。
 */
function extendMeasures(doc: ChartDoc, untilMs: number): { measures: MeasureInfo[]; extended: boolean } {
  const base = doc.measures
  if (!Number.isFinite(untilMs) || untilMs <= 0) return { measures: base, extended: false }
  if (base.length && base[base.length - 1].end >= untilMs) return { measures: base, extended: false }

  const grid = new MeasureGrid(doc.timing, [])
  const list: MeasureInfo[] = []
  for (let i = 0; i < base.length; i++) list.push(base[i])
  // 核对已有部分，防止两份网格的起点/拍长算得不一样
  for (let i = 0; i < base.length; i++) {
    const a = base[i]
    const b = grid.get(i)
    if (Math.abs(a.start - b.start) > 0.01 || Math.abs(a.end - b.end) > 0.01) {
      return { measures: base, extended: false }
    }
  }
  while (list.length < 20000 && list[list.length - 1].end < untilMs) {
    list.push(grid.get(list.length))
  }
  return { measures: list, extended: true }
}

/** 二分找到包含该时间的小节；不在任何小节里返回 -1 */
function measureAt(measures: MeasureInfo[], t: number): number {
  if (!measures.length) return -1
  if (t < measures[0].start) return -1
  let lo = 0
  let hi = measures.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measures[mid].start <= t + 1e-9) lo = mid
    else hi = mid - 1
  }
  const m = measures[lo]
  // 正好落在小节结束点上算下一小节；超出最后一个小节就不写（不硬塞进最后一格）
  return t < m.end ? lo : -1
}

function volumeOf(note: ImportNote, opts: KeysoundImportOptions): number {
  if (opts.volumeMode === 'velocity') {
    const v = Math.round(((note.velocity ?? 100) / 127) * 100)
    return Math.max(1, Math.min(100, v))
  }
  return Math.max(0, Math.min(100, Math.round(opts.fixedVolume ?? 100)))
}

/**
 * 把音符写进 [Keysound]。
 *
 * 不会触碰 [Hitsound] 和其它谱表；同一格里叠了多个音高时写成 `[4C 4E 4G]`。
 * 目标小节用了跨度 / 重复等不能安全改写的写法时，跳过这一小节并在 warnings 里说明。
 */
export function importKeysoundNotes(
  doc: ChartDoc,
  notes: ImportNote[],
  opts: KeysoundImportOptions,
): KeysoundImportResult {
  const stats = EMPTY_STATS()
  const warnings: string[] = []
  stats.notes = notes.length
  if (!notes.length) return { ok: false, reason: '没有可导入的音符', stats, warnings }
  const div = Math.max(1, Math.min(32, Math.floor(opts.div || 4)))
  const staff = Math.max(0, Math.floor(opts.staff || 0))
  const offset = Number.isFinite(opts.offsetMs) ? (opts.offsetMs as number) : 0
  const transpose = Number.isFinite(opts.transpose) ? Math.round(opts.transpose as number) : 0
  const mode = opts.outOfRange === 'skip' ? 'skip' : 'clamp'

  let minT = Infinity
  let maxT = -Infinity
  const prepared: { pitch: number; time: number; velocity: number }[] = []
  for (const n of notes) {
    const t = n.time + offset
    if (!Number.isFinite(t) || !Number.isFinite(n.pitch)) {
      stats.skipped++
      continue
    }
    let pitch = Math.round(n.pitch) + transpose
    if (pitch < PIANO_LOW || pitch > PIANO_HIGH) {
      if (mode === 'skip') {
        stats.skipped++
        continue
      }
      pitch = clampToRange(pitch)
    }
    prepared.push({ pitch, time: t, velocity: Math.max(1, Math.min(127, Math.round(n.velocity ?? 100))) })
    if (t < minT) minT = t
    if (t > maxT) maxT = t
  }
  if (!prepared.length) {
    return {
      ok: false,
      reason: `所有音符都在钢琴音域（${midiToName(PIANO_LOW)}~${midiToName(PIANO_HIGH)}）之外`,
      stats,
      warnings,
    }
  }

  const { measures, extended } = extendMeasures(doc, maxT)
  if (!extended && measures.length && maxT > measures[measures.length - 1].end) {
    warnings.push(
      `有音符超出谱面网格（${Math.round(maxT - measures[measures.length - 1].end)}ms），` +
        '已按最后一个小节截断；检查 [Timing] 是否覆盖到歌曲结尾',
    )
  }
  const doc2: ChartDoc = extended ? { ...doc, measures } : doc

  /** 同一格里叠音：合并音高、取最大力度 */
  const groups = new Map<string, { mi: number; k: number; pitches: number[]; velocity: number; time: number }>()
  let dropped = 0
  for (const n of prepared) {
    const mi = measureAt(measures, n.time)
    if (mi < 0) {
      dropped++
      continue
    }
    const m = measures[mi]
    const beats = Math.max(1, measureBeatTimes(m).length || m.meter || 4)
    const pos = beatsAt(m, n.time)
    let k = Math.round(pos * div)
    if (k < 0) k = 0
    if (k >= beats * div) k = beats * div - 1
    const quantized = beatTimeOf(m, k / div)
    stats.quantizeMs = Math.max(stats.quantizeMs, Math.abs(quantized - n.time))
    const key = `${mi}:${k}`
    const g = groups.get(key)
    if (g) {
      if (!g.pitches.includes(n.pitch)) g.pitches.push(n.pitch)
      g.velocity = Math.max(g.velocity, n.velocity)
    } else {
      groups.set(key, { mi, k, pitches: [n.pitch], velocity: n.velocity, time: n.time })
    }
  }
  if (dropped) {
    stats.skipped += dropped
    warnings.push(`${dropped} 个音符落在谱面时间范围之外，已跳过`)
  }
  if (!groups.size) {
    return { ok: false, reason: '音符都不在谱面时间范围内', stats, warnings }
  }

  const target: GridEditTarget = {
    mode: 'keysound',
    staff,
    instrument: opts.instrument,
    instruments: opts.instruments,
  }

  /**
   * 每个小节能不能安全改写：
   *   - 这一小节里有这一谱表的正文（ksBodies）；
   *   - 或者根本没有它的行（applyCellEdits 会补 `#标记 + /.../`）；
   *   - 被跨度 / 重复 / 多小节一行覆盖的不能动；
   *   - 有音符不在格子上（细分不够）的不能动。
   */
  const okMeasures = new Set<number>()
  const badMeasures = new Set<number>()
  const checkMeasure = (mi: number): boolean => {
    if (okMeasures.has(mi)) return true
    if (badMeasures.has(mi)) return false
    const m = measures[mi]
    const writable = !!m && (m.ksBodies?.[staff] !== undefined || !m.ksCovered?.[staff])
    const r = writable ? readMeasureCells(doc2, mi, div, target) : { ok: false as const, reason: '' }
    if (r.ok) okMeasures.add(mi)
    else badMeasures.add(mi)
    return r.ok
  }

  const edits: CellEdit[] = []
  const touched = new Set<number>()
  let cleared = 0

  // 清空放在前面：否则后面写进去的音会被「清空这一格」的编辑覆盖掉
  if (opts.replace) {
    const existing = new Set<number>()
    for (const e of doc.events) {
      if (e.kind !== 'keysound' || (e.staff ?? 0) !== staff) continue
      if (typeof e.measure === 'number' && e.measure > 0) existing.add(e.measure - 1)
    }
    for (const mi of [...existing].sort((a, b) => a - b)) {
      if (!checkMeasure(mi)) continue
      const r = readMeasureCells(doc2, mi, div, target)
      if (!r.ok) continue
      r.cells.forEach((c, k) => {
        if (!c.names.length) return
        edits.push({ mi, k, next: () => [] })
        cleared++
      })
      touched.add(mi)
    }
  }

  let skippedHere = 0
  let placed = 0
  let cells = 0
  for (const g of [...groups.values()].sort((a, b) => a.mi - b.mi || a.k - b.k)) {
    if (!checkMeasure(g.mi)) {
      skippedHere += g.pitches.length
      continue
    }
    const names = g.pitches.sort((a, b) => a - b).map((p) => midiToName(p))
    const volume = volumeOf({ pitch: g.pitches[0], time: g.time, velocity: g.velocity }, opts)
    edits.push({
      mi: g.mi,
      k: g.k,
      next: (cur) => {
        const out = [...cur]
        for (const n of names) if (!out.includes(n)) out.push(n)
        return out
      },
      volume,
    })
    touched.add(g.mi)
    placed += g.pitches.length
    cells++
  }
  if (skippedHere) {
    stats.skipped += skippedHere
    warnings.push(
      `${skippedHere} 个音符所在的小节用了跨度、重复或多小节一行等写法，格子无法安全改写，已跳过；` +
        '可以先在文本里把这些小节拆成普通写法',
    )
  }
  if (!placed) {
    return { ok: false, reason: warnings[0] || '没有可以写入的小节', stats, warnings }
  }
  if (cleared) warnings.push(`已清空目标谱表：${cleared} 格`)

  /**
   * 段末悬空的跨度标记（最后一行是 `/2/`，后面没有区域）：
   * 新补的 `#毫秒` 行会被当成它的区域，一小节的内容会被摊到两小节上。
   * 它后面本来就没有区域，删掉不改变语义；只有真要补新行时才动它。
   */
  let finalDoc = doc2
  const needAppend = [...touched].some((mi) => measures[mi] && measures[mi].ksBodies?.[staff] === undefined)
  if (needAppend) {
    const cleaned = stripDanglingKeysoundSpan(doc2)
    if (cleaned !== doc2.text) finalDoc = parseChart(cleaned, { baseDir: doc.baseDir })
  }

  const out = applyCellEdits(finalDoc, edits, div, target)
  if (!out.ok || out.text === undefined) {
    return { ok: false, reason: out.reason || '写回失败', stats, warnings }
  }

  stats.placed = placed
  stats.cells = cells
  stats.measures = touched.size
  stats.firstMs = Math.round(minT)
  stats.lastMs = Math.round(maxT)
  stats.maxMeasure = Math.max(...[...touched].map((mi) => mi + 1))
  return { ok: true, text: out.text, stats, warnings }
}


/** 删掉 [Keysound] 段末尾悬空的跨度行（`/2/`），只影响那一个标记 */
export function stripDanglingKeysoundSpan(doc: ChartDoc): string {
  const sec = doc.sections.find((x) => x.name.toLowerCase() === 'keysound')
  if (!sec) return doc.text
  const slice = doc.text.slice(sec.from, sec.to)
  const lines = slice.split('\n')
  let last = lines.length - 1
  while (last >= 0) {
    const code = lines[last].replace(/##.*$/, '').trim()
    if (code) break
    last--
  }
  if (last < 0) return doc.text
  const code = lines[last].replace(/##.*$/, '').trim()
  if (!/^\/\s*\d+\s*\/$/.test(code)) return doc.text
  lines.splice(last, 1)
  // 删掉整行后如果留下连续空行，收敛成一个
  const out = lines.join('\n')
  return doc.text.slice(0, sec.from) + out + doc.text.slice(sec.to)
}

// ---------------------------------------------------------------------------
// musictxt 来源
// ---------------------------------------------------------------------------

export interface ChartKeysoundStaff {
  staff: number
  /** 乐器名（[Keysound] 首行花括号里的名字） */
  name: string
  count: number
  low: number
  high: number
}

export interface ChartKeysoundSource {
  /** 解析后的谱面（取 [Timing] / [Define] 用） */
  doc: ChartDoc
  staves: ChartKeysoundStaff[]
  notes: (ImportNote & { staff: number; instrument?: string })[]
  /** 来源里定义过、且属于这些乐器的 [Define] 行 */
  defs: HitsoundDef[]
  /** 解析出的错误条数（导入仍然可以进行，但要提醒） */
  errorCount: number
  /** 第一行错误，界面显示用 */
  firstError: string
}

/**
 * 读一份 musictxt 里的 keysound 音符。
 *
 * 时间用谱面自己的绝对毫秒（和导入的 .osu 一样），所以只要两份谱是同一首歌，
 * 直接导入就能对上；不是同一首时用对话框里的「偏移」平移。
 */
export function readChartKeysound(text: string, baseDir?: string): ChartKeysoundSource {
  const doc = parseChart(text, { baseDir })
  const notes: (ImportNote & { staff: number; instrument?: string })[] = []
  for (const e of doc.events) {
    if (e.kind !== 'keysound' || typeof e.pitch !== 'number') continue
    notes.push({
      pitch: e.pitch,
      time: e.time,
      velocity: Math.max(1, Math.min(127, Math.round((e.volume / 100) * 127))),
      duration: e.duration,
      staff: e.staff ?? 0,
      instrument: e.instrument,
    })
  }
  notes.sort((a, b) => a.time - b.time || a.pitch - b.pitch)

  const staves: ChartKeysoundStaff[] = []
  const push = (staff: number, name: string, list: typeof notes) => {
    if (!list.length) {
      if (!staves.some((s) => s.staff === staff && s.name === name)) {
        staves.push({ staff, name, count: 0, low: 0, high: 0 })
      }
      return
    }
    const low = Math.min(...list.map((n) => n.pitch))
    const high = Math.max(...list.map((n) => n.pitch))
    staves.push({ staff, name, count: list.length, low, high })
  }
  if (doc.keyInstruments.length) {
    for (const k of doc.keyInstruments) push(k.staff, k.name, notes.filter((n) => n.staff === k.staff))
  } else {
    // 没有 [Keysound] 首行：按 [Define] 里 keysound 的顺序当谱表
    doc.hitsounds
      .filter((h) => h.kind === 'keysound' && h.name)
      .forEach((h, i) => push(i, h.name!, notes.filter((n) => n.staff === i)))
  }

  const names = new Set(staves.map((s) => s.name))
  const defs = doc.hitsounds.filter((h) => h.kind === 'keysound' && h.name && names.has(h.name))
  const errors = doc.diagnostics.filter((d) => d.severity === 'error')
  return {
    doc,
    staves,
    notes,
    defs,
    errorCount: errors.length,
    firstError: errors[0]?.message || '',
  }
}

/** 把来源定义的原值转成「目标谱面能用」的写法：相对路径按来源目录补成绝对路径 */
export function portableDefineValue(def: HitsoundDef, baseDir: string): string {
  const raw = (def.path || '').trim()
  if (!raw) return def.value || ''
  const win = raw.replace(/\\/g, '/')
  const absolute = /^[a-z]:\//i.test(win) || win.startsWith('/') || win.startsWith('//')
  if (absolute) return def.value || raw
  const dir = (baseDir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!dir) return def.value || raw
  return `${dir}/${win}`
}

// ---------------------------------------------------------------------------
// 目标谱面的准备：补定义、补谱表
// ---------------------------------------------------------------------------

/** 一条 keysound 定义的文本（跨行：值 + 可选参数块） */
export function keysoundDefineTextOf(doc: ChartDoc, name: string): string {
  const def = doc.hitsounds.find((h) => h.kind === 'keysound' && h.name === name)
  if (!def) return ''
  return doc.text.slice(def.from, def.to)
}

/** 把定义里第一个引号字符串（= 主路径）按来源目录补成绝对路径 */
function absolutizeFirstPath(line: string, baseDir: string): string {
  if (!baseDir) return line
  const m = /(["'])((?:[^"'\\]|\\.)*)\1/.exec(line)
  if (!m) return line
  const raw = m[2]
  if (!raw) return line
  const norm = raw.replace(/\\/g, '/')
  if (/^[a-z]:\//i.test(norm) || norm.startsWith('/') || norm.startsWith('//')) return line
  // 纯文件名（没有目录）也照样补：它本来就是相对 [Files] path 的
  const dir = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!dir) return line
  return line.slice(0, m.index) + m[1] + `${dir}/${norm}` + m[1] + line.slice(m.index + m[0].length)
}

/**
 * 把来源谱面的一条 keysound 定义搬过来：
 * 保持原来的写法（旧元组 / 新参数块都行），只把相对路径改成绝对路径。
 */
export function transcribedDefine(doc: ChartDoc, def: HitsoundDef, baseDir: string, renameTo?: string): string {
  let text = doc.text.slice(def.from, def.to)
  text = absolutizeFirstPath(text, baseDir)
  if (renameTo && def.name && renameTo !== def.name) {
    // 只换 = 左边那个代号 token
    const eq = text.indexOf('=')
    if (eq > 0) {
      const left = text.slice(0, eq)
      const m = /(\S+)(\s*)$/.exec(left)
      if (m) text = left.slice(0, m.index) + renameTo + m[2] + text.slice(eq)
    }
  }
  return text
}

/**
 * 往 [Define] 里写一条 keysound 定义（同名就整条替换）。
 * 返回新文本；失败（找不到可插入的位置）返回原文本。
 */
export function upsertKeysoundDefine(text: string, doc: ChartDoc, defText: string, name: string): string {
  const old = doc.hitsounds.find((h) => h.kind === 'keysound' && h.name === name)
  if (old) return text.slice(0, old.from) + defText + text.slice(old.to)

  const sec = doc.sections.find((s) => s.name.toLowerCase() === 'define')
  const block = defText.replace(/\s+$/, '')
  if (!sec) {
    const lead = text.endsWith('\n') || !text ? '' : '\n'
    return `${text}${lead}\n[Define]\n${block}\n`
  }
  // 段末：接在最后一行后面，别粘到下一个段标题上
  const at = sec.to
  const before = text.slice(0, at)
  const lead = before.endsWith('\n') ? '' : '\n'
  return `${before}${lead}${block}\n${text.slice(at)}`
}

/**
 * 确保某个乐器在 [Keysound] 首行的花括号列表里，返回它在列表中的下标。
 *
 * - 已经有 `[Keysound]` 段和花括号头：不在列表里就追加一项；
 * - 还没有这个段：返回 0（写回时会按 `instruments` 新建）；
 * - 段里有头但没写名字：按 [Define] 里的顺序兜底。
 */
export function ensureKeysoundStaff(text: string, doc: ChartDoc, name: string): { text: string; staff: number } {
  const existing = doc.keyInstruments.find((k) => k.name === name)
  if (existing) return { text, staff: existing.staff }

  const sec = doc.sections.find((s) => s.name.toLowerCase() === 'keysound')
  if (!sec) return { text, staff: 0 }

  // 段里第一行非空且以 { 开头的就是乐器列表
  const slice = text.slice(sec.from, sec.to)
  const re = /(^|\n)([ \t]*)(\{[^}\n]*\})/
  const m = re.exec(slice)
  if (m) {
    const inner = m[3].slice(1, -1)
    const names = inner
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)
    if (names.includes(name)) return { text, staff: names.indexOf(name) }
    const at = sec.from + m.index + m[1].length + m[2].length
    const head = text.slice(at, at + m[3].length)
    const nextHead = `{${names.concat(name).join(' | ')}}`
    return { text: text.slice(0, at) + nextHead + text.slice(at + head.length), staff: names.length }
  }

  // 有段落却没有花括号头：按 [Define] 里 keysound 的顺序当谱表
  const defines = doc.hitsounds.filter((h) => h.kind === 'keysound' && h.name)
  return { text, staff: Math.max(0, defines.findIndex((h) => h.name === name)) }
}
