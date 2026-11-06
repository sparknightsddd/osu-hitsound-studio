/**
 * 把从 .osu 提取出来的音效事件渲染成 musictxt（.hs）文本。
 *
 * musictxt 正文的時間是由 [Timing] 推导出的「小节网格」决定的：
 * 一个 `/` 区域（region）横跨 span 个小节，区域内每个单位平分这段时长；
 * `[A B]` 是纵向同时发声组，`=` 是休止，`N` / `-` 是时值，`<v=xx>` 是音量。
 * 因此导入的关键是：把每个音效事件落到「小节 × 细分格」上。
 */

import { MeasureGrid, beatsAt, measureBeatLayout } from './measures'
import type { MeasureInfo, TimingPoint } from './types'
import { desktopApi } from './desktop'
import type { ExtractedSound, OsuSoundsEnv, OsuSoundsResult, SoundCode } from './osuSounds'
import { extractOsuSounds, soundCodeKey } from './osuSounds'
import { appendTailRedLine, NO_INHERIT_GAP_MS, shouldResetMode, snapResetBeats } from './exporter'
import { chartSettingsLines } from './chartDefaults'

/** 允许使用的最细分母上限（1/32 拍，120 BPM 下约 15.6ms），只作兜底 */
const DEFAULT_DIV = 32

export interface HsRenderOptions {
  /** 时值单位上限（每拍最多分几份），默认 32 */
  div?: number
  /** [Files] 的 path：音效相对路径的基准目录 */
  path?: string
  /** [Files] 的 ImportOsu：来源 .osu（相对 path），网格里用来对照原谱物件时间轴 */
  importOsu?: string
  /** [Settings] 模板块（沿用编辑器模板） */
  settingsLines?: string[]
  /**
   * 白板音效的 key（见 `soundCodeKey`）。
   *
   * 白板在正文里不写代号 —— 命中它的音符直接变成休止符 `=`，
   * 只在 [Define] 里留一条无名定义（`hitsound <槽位> = <值>`）供游戏/导出使用。
   * 编辑器试听时休止符不发声。
   */
  whiteboard?: string
  /** 自定义代号：key -> 名称（缺省沿用自动生成的 Aa/Ab…） */
  codeNames?: Record<string, string>
  /** 每个代号的默认颜色：key -> `#rrggbb`（写进 [Define] 的第五段） */
  codeColors?: Record<string, string>
  /** TIMING 继承阈值（ms）：红线段超过它就开新小节；缺省 4000 */
  inheritMs?: number
}

export interface HsRenderResult {
  text: string
  /** 落在网格上、已写进正文的音效数 */
  placed: number
  /** 偏差过大无法落点而被跳过的音效数 */
  unplaced: number
  /** 同时刻存在多种音量、被排到相邻网格的次数 */
  splitVolume: number
  /** 各小节实际用到的时值单位统计，单位 -> 小节数（单位是「每拍分几份」，4 = 1/4 拍） */
  timeUnits: Record<number, number>
}

// ---------------------------------------------------------------------------
// [Timing]：只取红线（uninherited）
// ---------------------------------------------------------------------------

function round6(n: number): string {
  return String(Math.round(n * 1e6) / 1e6)
}

/**
 * 与 fromOsu 保持一致的红线抽取规则：
 * 到下一条红线的距离 > 2000ms 或拍号变化 → 不继承拍子（resetMode=1）。
 *
 * `songEnd` 用来在末尾补一条收尾红线：最后一条真实红线到曲末通常隔着十几秒空白，
 * 那段空档同样不该继续延伸小节，所以必须参与继承判断。
 */
export function osuTimingLines(
  tps: OsuSoundsResult['timing'],
  songEnd = 0,
  inheritMs = NO_INHERIT_GAP_MS,
): { lines: string[]; points: TimingPoint[] } {
  const red0 = tps
    .filter((tp) => tp.uninherited && tp.beatLength > 0)
    .slice()
    .sort((a, b) => a.time - b.time)

  if (!red0.length) {
    const p: TimingPoint = {
      offset: 0,
      beatLength: 500,
      meter: 4,
      resetMode: 1,
      resetBeats: 0,
      resetBeatsSet: false,
      shift: 0,
      from: 0,
      to: 0,
      line: 0,
    }
    return { lines: ['0,bpm(120),4,0,0'], points: [p] }
  }

  // 末尾补一条收尾红线，让「最后一条红线 → 曲末」这段空档也走继承判断
  const red = appendTailRedLine(
    red0.map((tp) => ({ offset: tp.time, beatLength: tp.beatLength, meter: tp.meter })),
    songEnd,
    inheritMs,
  )

  const lines: string[] = []
  const points: TimingPoint[] = []
  red.forEach((tp, i) => {
    const meter = tp.meter > 0 ? tp.meter : 4
    const head = `${Math.round(tp.offset)},${round6(tp.beatLength)},${meter}`
    let resetMode = 0
    let resetBeats = 0
    // 第一条红线没有前驱，不存在「继承」问题，统一写0（与模板 / fromOsu 一致）
    if (i > 0) {
      const prev = red[i - 1]
      const prevMeter = prev.meter > 0 ? prev.meter : 4
      if (
        shouldResetMode(
          { offset: prev.offset, beatLength: prev.beatLength, meter: prevMeter },
          { offset: tp.offset, meter },
          red[i + 1],
          inheritMs,
        )
      ) {
        resetMode = 1
      } else {
        const beats = (tp.offset - prev.offset) / prev.beatLength
        const rb = snapResetBeats(beats % prevMeter, prevMeter)
        // 落在小节边界上（吸附到第 0 拍）：直接当新小节，别写成「继承到第 0 拍」——
        // 后者要靠时间反推拍位，网格一旦有零点几毫秒的累积偏差就会切出 2ms 的碎片段，
        // 那一小段里的音符会被挤到上一拍去（实测能差 400ms+）。
        if (rb === 0) resetMode = 1
        else resetBeats = rb
      }
    }
    lines.push(`${head},${resetMode},${round6(resetBeats)}`)
    points.push({
      offset: tp.offset,
      beatLength: tp.beatLength,
      meter,
      resetMode: resetMode as 0 | 1,
      resetBeats,
      resetBeatsSet: resetBeats !== 0,
      shift: 0,
      from: 0,
      to: 0,
      line: 0,
    })
  })
  return { lines, points }
}

// ---------------------------------------------------------------------------
// 正文渲染
// ---------------------------------------------------------------------------

/**
 * 候选时值单位（每拍分几份），按人类可读性从粗到细。
 *
 * 1/9、1/5、1/7 这类非常规节奏放在最后，只有前面全都不合适时才用；
 * 不试 1/11 及更大的分母 —— osu 里那些位置更可能是没对齐的 unsnap，
 * 强行用超大分母去贴合只会写出一堆看不懂的休止符。
 */
const TIME_UNITS = [1, 2, 3, 4, 6, 8, 12, 16, 9, 5, 7]

/** 「拍位 × 单位」与整数的最大允许偏差（0.95 ~ 1.05 都算落在格点上） */
const FIT_TOL = 0.05

/** 反向验算：量化后的格点时间向下取整，与物件原始时间的最大差（毫秒） */
const MS_TOL = 1

/**
 * 没有任何单位能完全对上时（小节里有没对齐的物件，比如滑条 tick），
 * 允许比「最优误差」多出这么多毫秒去换一个更粗、更好读的单位。
 */
const FALLBACK_SLACK_MS = 3

/**
 * 给 `#标记` 挑一个落在这小节内部的整数毫秒。
 *
 * 解析器是按 `indexAt(标记时间)` 定位小节的，而小节起点常带小数
 * （BPM 140 → 每拍 428.5714ms）。直接用 round 可能取整到起点之前，
 * 整段内容会被解析到上一小节，听感上就是整体提前一小节。
 * 所以这里向上取整（并确保仍在 [start, end) 内）；实在顶到末尾就退回向下取整。
 */
function subMeasureMark(m: MeasureInfo): number {
  // 用 floor 和 osu 对齐：整数毫秒是「拍点时间向下取整」得到的
  // （18570 + 80×(60000÷124) = 57279.67 → osu 里写 57279）。
  // 解析器那边对「标记比小节起点早不到 1ms」做了容忍，所以这里可以放心取 floor。
  // +1e-6 吸收浮点误差：小节起点本来是整数时（例如红线正好落在 919084），
  // 算出来可能是 919083.9999999，直接 floor 会变成 919083。
  const down = Math.floor(m.start + 1e-6)
  if (down >= 0) return down
  // 小节起点是负数时优先落在非负区间内（lead-in 早于 0 的谱）
  if (m.start <= 0 && 0 < m.end) return 0
  return down
}

/** 时间 t 在本小节里的归一化位置（0 = 小节起点，1 = 小节终点） */
function measurePos(m: MeasureInfo, t: number): number {
  const span = m.end - m.start
  if (!(span > 0)) return 0
  return Math.min(1, Math.max(0, (t - m.start) / span))
}

/** 一个小节里的「同一时刻的一批音效」 */
interface NoteUnit {
  /** 原始时间（毫秒） */
  time: number
  /**
   * 在小节内的归一化位置 0~1。
   *
   * 为什么不用「拍位」：正文的一个 `/.../` 区域是按**均匀**切分整段时长的，
   * 而小节内部如果发生变速（红线不落在小节线上），各拍长短并不一致。
   * 这时用拍位去排会和解析器算出的时间对不上，必须用「时间在区域里的比例」。
   * 对于没有内部变速的小节，两者完全等价。
   */
  pos: number
  /** 已按音量/编号拆好的、需要逐个写出的发声组 */
  groups: ExtractedSound[][]
}

/**
 * 挑一个最合适的时值单位。
 *
 * 旧版只看「这一小节排不排得下」，结果 1/2 网格里混着 1/4 音符时，
 * 那些 1/4 音符会被硬塞进最近的 1/2 格——排得下，但时间偏了半格。
 *
 * 现在逐音符验算它是否真的落在格点上：
 *   1) 拍位 × u 与最近整数的差 <= FIT_TOL（0.05 拍，即 0.95~1.05；
 *      46ms @ 214BPM = 0.164 拍，×6 = 0.984 落在阈值内，判定为 1/6）；
 *   2) 反向验算：把该格点换算回毫秒、向下取整，与原始时间的差 <= 1ms；
 *   3) 两个音符不能抢同一个格点（同刻不同音量组除外，它们本来就要顺延）。
 *
 * 候选按 TIME_UNITS 的顺序试，第一个全部通过的即为结果。
 *
 * 都不通过时（小节里有没对齐的物件，比如滑条 tick）不能只看误差：
 * 粗单位虽然「平均偏差」小，却可能把音符挤出小节末尾而直接丢掉。
 * 所以按「丢音数 → 不合格数 → 时间误差」的优先级挑，宁可细一点也绝不能丢音。
 */
function fitTimeUnit(units: NoteUnit[], m: MeasureInfo, maxUnit: number): number {
  const beats = measureBeatLayout(m).beats
  const span = m.end - m.start
  const cands: { u: number; drop: number; maxErr: number }[] = []

  for (const u of TIME_UNITS) {
    if (u > maxUnit) continue
    const total = Math.max(1, Math.round(beats * u))
    let bad = 0
    let maxErr = 0
    for (const it of units) {
      const x = it.pos * total
      const r = Math.round(x)
      if (Math.abs(x - r) > FIT_TOL) bad++
      // 反向验算用「正文解析器实际算出的时间」：区域时长 / 单位数 才是
      // 每格的真实长度，理想拍位在小节被红线截断时会偏。
      const g = m.start + (r * span) / total
      const d = Math.abs(Math.floor(g + 1e-9) - it.time)
      if (d > maxErr) maxErr = d
      if (d > MS_TOL) bad++
    }
    // 按与正式渲染完全一致的方式模拟一次排位，统计会被挤出去的音符
    let drop = 0
    const used = new Set<number>()
    for (const it of units) {
      let p = Math.round(it.pos * total)
      if (p < 0) p = 0
      if (p >= total) p = total - 1
      while (p < total && used.has(p)) p++
      if (p >= total) drop++
      else used.add(p)
    }
    if (bad === 0 && drop === 0) return u
    cands.push({ u, drop, maxErr })
  }

  if (!cands.length) return Math.min(maxUnit, DEFAULT_DIV)
  // 先保证不丢音，再在「误差已经很接近最优」的候选里挑最粗的
  // （顺序就是 TIME_UNITS 的可读性顺序），避免 2 个音符铺出 64 个格。
  const minDrop = Math.min(...cands.map((c) => c.drop))
  const pool = cands.filter((c) => c.drop === minDrop)
  const bestErr = Math.min(...pool.map((c) => c.maxErr))
  const pick = pool.find((c) => c.maxErr <= bestErr + FALLBACK_SLACK_MS)
  return (pick ?? pool[pool.length - 1]).u
}

/**
 * 把同一个网格位置上的事件分组。
 *
 * `[A B]` 这种同时发声组在语法上只能带一组「音量 + 音效组编号」（都写在组前面的
 * `<v=xx>` 和数字里），所以只有音量和音效组编号都相同的音效才能真正同时发声；
 * 其余的只能依次排到相邻网格（每格 1/div 拍，120 BPM 下约 8ms，听不出来）。
 */
function groupForSlot(list: ExtractedSound[]): { groups: ExtractedSound[][]; split: boolean } {
  const byKey = new Map<string, ExtractedSound[]>()
  for (const s of list) {
    const k = `${s.volume}|${s.sampleIndex}`
    const arr = byKey.get(k)
    if (arr) arr.push(s)
    else byKey.set(k, [s])
  }
  if (byKey.size <= 1) return { groups: [list], split: false }
  // 音量大的排前面，尽量保住底音的原始时间
  const keys = [...byKey.keys()].sort((a, b) => Number(b.split('|')[0]) - Number(a.split('|')[0]))
  return { groups: keys.map((k) => byKey.get(k)!), split: true }
}

export function renderOsuSoundsHs(res: OsuSoundsResult, opts: HsRenderOptions = {}): HsRenderResult {
  const div = Math.max(1, Math.floor(opts.div ?? DEFAULT_DIV))
  const whiteboard = opts.whiteboard || ''
  /** 代码在正文 / [Define] 里用的名字；白板返回空串 */
  const nameOf = (c: SoundCode): string => {
    if (whiteboard && soundCodeKey(c) === whiteboard) return ''
    return opts.codeNames?.[soundCodeKey(c)] || c.name
  }
  const isWhiteboard = (c: SoundCode): boolean => !!whiteboard && soundCodeKey(c) === whiteboard
  const { lines: timingLines, points: timingPoints } = osuTimingLines(res.timing, res.songEnd, opts.inheritMs)
  const diags: never[] = []
  const grid = new MeasureGrid(timingPoints, diags)

  // 1) 把每个事件算到 (小节, 位置)
  //
  //    这里不再先吸附到 1/32 网格：那样会把音符位置提前量化一次，
  //    后面无论怎么选单位都找不回原始时间。小节归属用 MeasureGrid，
  //    拍位用 beatsAt 从该音符所属红线推出来（判断时值单位和是否贴小节末尾），
  //    真正排位用的则是 pos = 时间在小节里的比例。
  const byMeasure = new Map<number, Map<number, { pos: number; list: ExtractedSound[] }>>()
  let placed = 0
  let unplaced = 0

  for (const s of res.sounds) {
    let mi = grid.indexAt(s.time)
    let m = grid.get(mi)
    let beat = beatsAt(m, s.time)

    // MeasureGrid.indexAt 用 `time < m.end` 判定归属，恰好压在小节末尾
    // （或刚过末尾一点点）的物件会被算进下一小节，拍位变成负数。
    // 这种情况回退到上一小节，用上一小节的拍位表示。
    if (beat < -1e-6 && mi > 0) {
      const pm = grid.get(mi - 1)
      const pb = beatsAt(pm, s.time)
      if (pb >= -1e-6) {
        mi -= 1
        m = pm
        beat = pb
      }
    }

    if (!Number.isFinite(beat) || beat < -1e-6) {
      unplaced++
      continue
    }

    // 贴着小节末尾的音符，本质上就是落在小节线上。
    // 留在本小节只能塞进最后一格（可能偏出小半拍甚至一整拍），交给下一小节的
    // 第 0 格反而更准，也不会因为位置取整越界而被丢。
    // 判定用「距离小节结束还有多少毫秒」——变速小节最后一拍可能很短，
    // 用拍数比例判断会漏掉。
    const layout = measureBeatLayout(m)
    const nBeat = layout.times.length
    const tailMs = (layout.lengths[nBeat - 1] > 0 ? layout.lengths[nBeat - 1] : 500) / 32
    if (nBeat > 0 && (beat >= layout.beats - 0.02 || m.end - s.time <= tailMs)) {
      const nm = grid.get(mi + 1)
      const nb = beatsAt(nm, s.time)
      if (nb >= -0.05 && nb <= 0.05) {
        mi += 1
        m = nm
        beat = Math.max(0, nb)
      }
    }

    let cells = byMeasure.get(mi)
    if (!cells) {
      cells = new Map()
      byMeasure.set(mi, cells)
    }
    // 同一毫秒的多个音效放在一起，后面按「音量 + 编号」拆成并排组
    const key = Math.round(s.time * 1000)
    const cell = cells.get(key)
    if (cell) cell.list.push(s)
    else cells.set(key, { pos: measurePos(m, s.time), list: [s] })
    placed++
  }

  // 2) 逐小节渲染
  const body: string[] = []
  let splitVolume = 0
  const measureIdx = [...byMeasure.keys()].sort((a, b) => a - b)
  const timeUnitStat = new Map<number, number>()
  for (const mi of measureIdx) {
    const m = grid.get(mi)
    const cells = byMeasure.get(mi)!
    const n = measureBeatLayout(m).beats

    // 2a) 同一时刻的不同音量/编号要分开写，拆成一个个发声组。
    //     白板音效不写进正文（它就是「什么都没标」的那个音），先剔掉；
    //     一格如果只有白板，就落成休止符。
    const wanted: NoteUnit[] = []
    for (const key of [...cells.keys()].sort((a, b) => a - b)) {
      const cell = cells.get(key)!
      const list = whiteboard ? cell.list.filter((s) => !isWhiteboard(s.code)) : cell.list
      if (!list.length) continue
      const { groups, split } = groupForSlot(list)
      if (split) splitVolume++
      for (const g of groups) wanted.push({ time: g[0].time, pos: cell.pos, groups: [g] })
    }
    if (!wanted.length) continue

    // 2b) 按「拍位 × 单位是否落在整数」挑时值单位
    const unit = fitTimeUnit(wanted, m, div)
    timeUnitStat.set(unit, (timeUnitStat.get(unit) || 0) + 1)

    // 2c) 正式排位。格点下标 = round(拍位 × 单位)，同格顺延到后面空位。
    //     单位数按「小数拍数」算：被红线截断的小节末尾还有不足一拍的余量，
    //     只按整拍数写会把这些音符挤到最后一个格子上。
    const total = Math.max(1, Math.round(n * unit))
    const plan = new Map<number, ExtractedSound[][]>()
    for (const it of wanted) {
      let p = Math.round(it.pos * total)
      if (p < 0) p = 0
      if (p >= total) p = total - 1
      while (p < total && plan.has(p)) p++
      if (p >= total) {
        unplaced += it.groups.reduce((s, g) => s + g.length, 0)
        continue
      }
      plan.set(p, it.groups)
    }

    const parts: string[] = []
    let curVol = -1
    let curIdx = -1
    for (let pos = 0; pos < total; pos++) {
      const cell = plan.get(pos)
      if (!cell) {
        parts.push('=')
        continue
      }
      for (const g of cell) {
        const names = g.map((x) => nameOf(x.code)).filter(Boolean)
        if (!names.length) continue
        const v = g[0].volume
        if (v !== curVol) {
          parts.push(`<v=${v}>`)
          curVol = v
        }
        const idx = g[0].sampleIndex
        if (idx !== curIdx) {
          parts.push(`${idx}`)
          curIdx = idx
        }
        parts.push(names.length === 1 ? names[0] : `[${names.join(' ')}]`)
      }
    }
    // 必须写满整小节的格数：正文解析器是按「实际写出的单位数」均分小节时长的，
    // 末尾少写一个休止会让该小节里所有音符的时间整体被拉伸。
    //
    // 标记必须落在 [m.start, m.end) 里：解析器用 indexAt(标记) 找小节，
    // 而小节起点常常是小数（BPM 140 → 428.5714ms/拍）。用 round 有可能
    // 取整到小节起点之前，整段音符会被解析到上一小节、整体提前一小节。
    body.push(`#${subMeasureMark(m)}`)
    body.push(`/${parts.join(' ')}/`)
  }

  if (!body.length) body.push('/D/')


  // 3) 组装整份文档
  const blocks: string[] = []
  const diff = res.difficulties[0]
  const title = diff ? `${diff.title || '(无标题)'} [${diff.version}]` : ''
  blocks.push(
    [
      '[Metadata]',
      `Title = ${diff?.title ?? ''}`,
      `TitleUnicode = ${diff?.title ?? ''}`,
      `Artist = ${diff?.artist ?? ''}`,
      `ArtistUnicode = ${diff?.artist ?? ''}`,
      `Creator = ${osuCreator(res)}`,
      'Source = ',
      'Tags = ',
      `BeatmapID = ${diff?.beatmapID ?? '0'}`,
      'BeatmapSetID = -1',
    ].join('\n'),
  )

  const path = (opts.path ?? '').replace(/\\/g, '/')
  const filesLines = [`path = "${path}"`, `audio = "${(res.audioFilename || '').replace(/"/g, '')}"`]
  // 从 .osu 导入音效时顺手记下来源谱面：网格模式会在格子下方画它的物件时间轴
  const importOsu = (opts.importOsu ?? '').replace(/\\/g, '/').replace(/"/g, '')
  if (importOsu) filesLines.push(`ImportOsu = "${importOsu}"`)
  blocks.push(['[Files]', ...filesLines].join('\n'))

  const settings = opts.settingsLines?.length
    ? opts.settingsLines
    : [
        'Mode = default',
        'Key = {D, F, J, K}',
        ...chartSettingsLines(),
        'TimingAdsorb = beat(0,1,2)',
        'Bookmarks = {}',
      ]
  blocks.push(['[Settings]', ...settings].join('\n'))

  const wbCount = whiteboard ? res.codes.filter((c) => isWhiteboard(c)).length : 0
  const define: string[] = [
    `## 从 ${diff?.fileName || '.osu'} 导入：${title || '(未命名难度)'}`,
    `## 共 ${res.codes.length} 个音效（内容相同的音色文件已自动合并）`,
  ]
  if (wbCount)
    define.push('## 无名的那条是「白板」：正文里留空（休止符）就表示它，试听时不发声')
  for (const c of res.codes) {
    const n = nameOf(c)
    // 混音文件没能拆开（源文件不在了）：至少把来源写清楚，别让人以为是个普通音效
    if (c.mix?.sources?.length) {
      const from = c.mix.sources.map((s) => s.code || s.file).join(' + ')
      define.push(`## 混合音效：由 ${from} 混合而成（源文件不在目录里，无法拆回）`)
    }
    // 颜色是可选的第五段；没配就照旧不写
    const col = opts.codeColors?.[soundCodeKey(c)]
    const tail = col ? ` ${col}` : ''
    // 白板没有代号：`hitsound <槽位> = <值>`
    define.push(
      n ? `hitsound ${c.slot} ${n} = ${c.value}${tail}` : `hitsound ${c.slot} = ${c.value}${tail}`,
    )
  }
  blocks.push(['[Define]', ...define].join('\n'))
  blocks.push(['[Timing]', ...timingLines].join('\n'))
  // 头部注释里的时值说明：让人一眼看出这份谱用到了哪些节奏
  const unitSummary = [...timeUnitStat.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([u, n]) => `${u === 1 ? '整拍' : `1/${u}`}×${n}`)
    .join('、')

  blocks.push(
    [
      '[Hitsound]',
      `## 共 ${placed} 个音效事件；最细网格 1/${div} 拍，实际按小节自适应到${
        unitSummary || '整拍'
      }`,
      ...body,
    ].join('\n'),
  )

  const timeUnits: Record<number, number> = {}
  for (const [u, n] of timeUnitStat) timeUnits[u] = n
  return { text: blocks.join('\n\n') + '\n', placed, unplaced, splitVolume, timeUnits }
}

function osuCreator(res: OsuSoundsResult): string {
  // 只保留 .osu 里的原作者，不再追加 " / osu!"：
  // 这个后缀是导入器的标记，写着写着会被当成 CREATOR 的昵称，导出回 .osu 时也多余。
  return res.difficulties[0]?.creator ?? ''
}

/**
 * 用桌面端能力构造 OsuSoundsEnv：判断音色文件是否存在、算内容哈希（供去重）。
 * 没有桌面 API 时（浏览器预览）返回空 env，此时全部音色回落到 default.xxx。
 */
export function desktopOsuEnv(dir: string, filePath: string, fileName: string): OsuSoundsEnv {
  const api = desktopApi()
  if (!api || !dir) return { filePath, fileName }
  const joinPath = (rel: string) => {
    const p = rel.replace(/\\/g, '/')
    // 绝对路径原样返回：`E:/...`、`//server/share`、`/posix`
    return /^[a-z]+:\/\//i.test(p) || /^[a-z]:[\\/]/i.test(p) || p.startsWith('/')
      ? p
      : dir.replace(/[\\/]+$/, '') + '\\' + p.replace(/\//g, '\\')
  }
  return {
    dir,
    filePath,
    fileName,
    fileExists: async (_d, rel) => (await api.exists(joinPath(rel))).exists,
    wavMeta: async (_d, rel) => {
      if (!api.wavMeta) return null
      const r = await api.wavMeta(joinPath(rel))
      return r.ok && r.meta ? r.meta : null
    },
    hashFile: async (_d, rel) => {
      const r = await api.hashFile(joinPath(rel))
      return r.ok && r.hash ? r.hash : `path:${rel.toLowerCase()}`
    },
    audioDurationMs: async (_d, rel) => {
      const r = await api.audioDuration(joinPath(rel))
      return r.ok ? r.durationMs : 0
    },
  }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export interface OsuImportSoundsResult extends OsuSoundsResult, HsRenderResult {}

/**
 * 从 .osu 文本提取音效并直接生成 .hs 文本。
 */
export async function osuToHs(
  src: string,
  env: OsuSoundsEnv = {},
  opts: HsRenderOptions = {},
): Promise<OsuImportSoundsResult> {
  const res = await extractOsuSounds(src, env)
  const out = renderOsuSoundsHs(res, opts)
  return { ...res, ...out }
}

/** 不选任何 .osu 时使用的空白音效谱 */
export function blankHitsoundHs(path = ''): string {
  const p = path.replace(/\\/g, '/')
  return (
    [
      '[Metadata]',
      'Title = ',
      'TitleUnicode = ',
      'Artist = ',
      'ArtistUnicode = ',
      'Creator = ',
      'Source = ',
      'Tags = ',
      'BeatmapID = 0',
      'BeatmapSetID = -1',
      '',
      '[Files]',
      `path = "${p}"`,
      'audio = ""',
      '',
      '[Settings]',
      'Mode = default',
      'Key = {D, F, J, K}',
      ...chartSettingsLines(),
      'TimingAdsorb = beat(0,1,2)',
      'Bookmarks = {}',
      '',
      '[Define]',
      'hitsound normal-hitnormal D = default.normal-hitnormal',
      '',
      '[Timing]',
      '0,bpm(120),4,1,0',
      '',
      '[Hitsound]',
      '/D/',
      '',
    ].join('\n')
  )
}