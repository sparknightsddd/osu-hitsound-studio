/**
 * 副槽位（slidertick / sliderside / successor）的落点规划。
 *
 * 只在「把音效写进现有 .osu」时有意义：主槽位要求时间正好落在圆圈 / 滑条头 /
 * 折返点 / 滑条尾 / 转盘尾上；落不到这些节点上的音效才按固定优先级退到副槽位：
 *
 *   slidertick（正好是滑条点）> sliderside（在滑条身里）> successor（混进前一个音效）
 *
 * 输出：
 *  - samples：留下来的主槽位音效（副槽位接走的会删掉，不再算“未匹配”）
 *  - moves：副槽位额外要铺的绿线（滑条身/滑条点，以及滑条尾恢复采样组）
 *  - files：副槽位自己的音效文件（soft-sliderslide2.wav / soft-slidertick3.wav /
 *    successor 的「A + 延迟 B」混音文件）
 *  - placements：给日志/测试看的落点清单
 */
import type { ChartDoc, HitsoundDef, SampleSet, SubSlot } from './types'
import type { ComboSample, ExportFileTask, SampleMove } from './osuExport'
import { buildVoice, parseSlotKey } from './osuExport'
import type { OsuTargetTimeline } from './osuPatch'

const SET_NUM: Record<SampleSet, number> = { normal: 1, soft: 2, drum: 3 }
const NUM_SET: Record<number, SampleSet> = { 1: 'normal', 2: 'soft', 3: 'drum' }
/** 副槽位在 osu 里的文件名：sliderside 对应 osu 的 sliderslide */
const OSU_FILE_KIND: Record<'sliderside' | 'slidertick', string> = {
  sliderside: 'sliderslide',
  slidertick: 'slidertick',
}

export interface SubPlacement {
  time: number
  slot: SubSlot
  name: string
  set: SampleSet
  index: number
  /** 滑条身/滑条点：所属滑条 */
  sliderHead?: number
  sliderTail?: number
  /** successor：挂在哪个音效上，以及延迟 */
  of?: number
  delay?: number
}

export interface SubSlotPlan {
  samples: Map<number, ComboSample>
  moves: SampleMove[]
  files: ExportFileTask[]
  placements: SubPlacement[]
  /** 全局白板副槽位写了几个文件 */
  globalCount: number
  /** 被副槽位接走、不再参与「未匹配」的时刻 */
  removed: number[]
  /** 仍然落不下去的时刻及原因 */
  skipped: { time: number; names: string[]; reason: string }[]
}

export interface SubSlotOptions {
  /** 目标谱已经用掉的音效组编号 */
  usedIndices?: number[]
}

function extOf(file: string): string {
  const m = /\.[a-z0-9]+$/i.exec(file)
  return m ? m[0].toLowerCase() : '.wav'
}

function voiceMain(def: HitsoundDef): { set: SampleSet; hit: string } | null {
  const v = buildVoice(def)
  const key = v?.cands[0]
  const ref = key ? parseSlotKey(key) : null
  return ref ? { set: ref.set, hit: ref.hit } : null
}

function setOfSample(sample: ComboSample, hit: string | undefined): SampleSet {
  const n = hit === 'hitnormal' ? sample.normalSetNum : sample.additionSetNum
  return NUM_SET[n] || 'soft'
}

function taskFor(
  def: HitsoundDef,
  set: SampleSet,
  index: number,
  kind: 'sliderside' | 'slidertick',
): ExportFileTask | null {
  const file = def.resolvedPath || ''
  const ext = file ? extOf(file) : '.wav'
  const to = `${set}-${OSU_FILE_KIND[kind]}${index === 1 ? '' : index}${ext}`
  if (file) return { to, from: [file], defaults: [], mix: false }
  if (def.defaultRef) return { to, from: [], defaults: [def.defaultRef], mix: true }
  return null
}

/** 白板副槽位：所有采样组共用同一个音效（没有代号，全局生效） */
function globalTask(def: HitsoundDef, set: SampleSet, kind: 'sliderside' | 'slidertick'): ExportFileTask | null {
  const file = def.resolvedPath || ''
  const ext = file ? extOf(file) : '.wav'
  const to = `${set}-${OSU_FILE_KIND[kind]}${ext}`
  // 全局白板就是要盖掉谱面里现有的滑条身/点音效，允许覆盖同名文件
  if (file) return { to, from: [file], defaults: [], mix: false, overwrite: true }
  if (def.defaultRef) return { to, from: [], defaults: [def.defaultRef], mix: true, overwrite: true }
  return null
}

interface SourceRef {
  file?: string
  defaultRef?: string
  delay: number
  code: string
  set: SampleSet
  hit: string
  index: number
}

function mixTask(to: string, sources: SourceRef[]): ExportFileTask {
  const from: string[] = []
  const delays: number[] = []
  const defaults: string[] = []
  const defaultDelays: number[] = []
  for (const s of sources) {
    if (s.file) {
      from.push(s.file)
      delays.push(Math.round(s.delay))
    } else if (s.defaultRef) {
      defaults.push(s.defaultRef)
      defaultDelays.push(Math.round(s.delay))
    }
  }
  return {
    to,
    from,
    defaults,
    mix: true,
    ...(delays.some((d) => d) ? { delays } : {}),
    ...(defaultDelays.some((d) => d) ? { defaultDelays } : {}),
  }
}

/** 目标谱里某一时刻原本生效的采样组 / 编号 / 音量（用于滑条尾恢复） */
function originalState(target: OsuTargetTimeline, time: number): SampleMove {
  let tp: (typeof target.timing)[number] | null = null
  for (const p of target.timing) {
    if (p.time <= time) tp = p
    else break
  }
  return {
    time,
    set: tp && tp.sampleSet ? tp.sampleSet : target.generalSet,
    index: tp ? tp.sampleIndex : 0,
    volume: tp ? tp.volume : 100,
  }
}

export function planSubSlots(
  doc: ChartDoc,
  samples: Map<number, ComboSample>,
  target: OsuTargetTimeline,
  opts: SubSlotOptions = {},
): SubSlotPlan {
  const keep = new Map(samples)
  const moves: SampleMove[] = []
  const files: ExportFileTask[] = []
  const placements: SubPlacement[] = []
  let globalCount = 0
  const removed: number[] = []
  const skipped: { time: number; names: string[]; reason: string }[] = []
  const nodeList = [...target.nodes].sort((a, b) => a - b)
  const hasNode = (t: number) => {
    if (target.nodes.has(t)) return true
    // 和 patchOsuText 的容差一致：±2ms 都算落在节点上
    let lo = 0
    let hi = nodeList.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const d = nodeList[mid] - t
      if (Math.abs(d) <= 2) return true
      if (d < 0) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }

  let nextIndex = Math.max(1, ...(opts.usedIndices || []).filter((n) => n > 0), 0) + 1
  const defByName = new Map<string, HitsoundDef>()
  for (const h of doc.hitsounds) if (h.name) defByName.set(h.name, h)

  // 1) 全局白板副槽位：对所有采样组写一份基础文件（目标谱没有滑条就不用写）
  const globalDone = new Set<string>()
  if (target.sliders.length) {
    for (const h of doc.hitsounds) {
      if (h.name || !h.subSlots?.length) continue
      for (const sub of h.subSlots) {
        if (sub !== 'sliderside' && sub !== 'slidertick') continue
        for (const set of ['soft', 'normal', 'drum'] as SampleSet[]) {
          const key = `${set}-${sub}`
          if (globalDone.has(key)) continue
          globalDone.add(key)
          const t = globalTask(h, set, sub)
          if (t) {
            files.push(t)
            globalCount++
          }
        }
      }
    }
  }

  // 2) 逐个时刻判断：主槽位落不下时，按固定优先级找副槽位
  const times = [...samples.keys()].sort((a, b) => a - b)
  const restores = new Map<number, SampleMove>()
  /** successor 分组：挂在前一个音效 A 上，同一个 A 的多个 B 合成一个文件 */
  const successorGroups = new Map<
    number,
    { sample: ComboSample; def: HitsoundDef; set: SampleSet; hit: string; index: number; sources: SourceRef[] }
  >()
  type Placed =
    | { kind: 'main'; time: number; sample: ComboSample; def: HitsoundDef }
    | {
        kind: 'slidertick' | 'sliderside'
        time: number
        sample: ComboSample
        def: HitsoundDef
        index: number
        set: SampleSet
        fileTo: string
      }
  let lastPlaced: Placed | null = null

  for (const time of times) {
    const sample = samples.get(time)!
    if (hasNode(time)) {
      const name = sample.names[0]
      const def = name ? defByName.get(name) : undefined
      if (def) lastPlaced = { kind: 'main', time, sample, def }
      continue
    }

    const names = sample.names.filter(Boolean)
    if (names.length !== 1) {
      skipped.push({ time, names, reason: '同一时刻有多个音效，副槽位只能一个文件' })
      continue
    }
    const name = names[0]
    const def = defByName.get(name)
    if (!def || !def.subSlots?.length) {
      skipped.push({ time, names, reason: '没有启用副槽位' })
      continue
    }

    const tickSlider = target.sliders.find((s) => s.ticks.some((x) => Math.abs(x - time) <= 2))
    const bodySlider = target.sliders.find((s) =>
      s.spans.some((sp) => time > sp.start + 2 && time < sp.end - 2),
    )
    const subs = def.subSlots
    let slot: SubSlot | '' = ''
    if (subs.includes('slidertick') && tickSlider) slot = 'slidertick'
    else if (subs.includes('sliderside') && bodySlider) slot = 'sliderside'
    else if (subs.includes('successor')) slot = 'successor'

    if (!slot) {
      skipped.push({ time, names, reason: '时间不在滑条身/滑条点上，且没有 successor' })
      continue
    }

    const main = voiceMain(def)
    const set = setOfSample(sample, main?.hit)

    if (slot === 'slidertick' || slot === 'sliderside') {
      const slider = slot === 'slidertick' ? tickSlider! : bodySlider!
      const index = nextIndex++
      const task = taskFor(def, set, index, slot)
      if (!task) {
        skipped.push({ time, names, reason: '副槽位定义没有可用的音频文件' })
        continue
      }
      files.push(task)
      moves.push({ time, index, volume: sample.volume, set: SET_NUM[set] })
      placements.push({
        time,
        slot,
        name,
        set,
        index,
        sliderHead: slider.head,
        sliderTail: slider.tail,
      })
      lastPlaced = { kind: slot, time, sample, def, index, set, fileTo: task.to }
      keep.delete(time)
      removed.push(time)

      /**
       * 恢复采样组：
       *  - slidertick 只应影响这一个滑条点，所以在这个点之后 1ms 恢复；
       *    （否则到滑条尾之前的后续滑条点都会用同一个 tick 文件）
       *  - sliderside 要覆盖整段滑条身，到滑条尾再恢复。
       */
      const restoreAt = slot === 'slidertick' ? time + 1 : slider.tail
      if (!keep.has(restoreAt) && !restores.has(restoreAt)) {
        restores.set(restoreAt, originalState(target, restoreAt))
      }
      continue
    }

    // successor：挂到前一个已落下的音效上（主槽位，或滑条点）
    const placed = lastPlaced
    if (!placed) {
      skipped.push({ time, names, reason: '前面没有可以附着的音效' })
      continue
    }
    if (placed.kind === 'sliderside') {
      skipped.push({ time, names, reason: '前一个音效是滑条身（循环音），不能把后继混进去' })
      continue
    }
    if (placed.sample.names.filter(Boolean).length !== 1) {
      skipped.push({ time, names, reason: '前一个音效是叠音，无法把后继混进单文件' })
      continue
    }
    if (!def.resolvedPath && !def.defaultRef) {
      skipped.push({ time, names, reason: 'successor 定义没有可用的音频文件' })
      continue
    }
    // 混音器只读 WAV；ogg/mp3 的后继先跳过，免得整个导出在写文件时失败
    const bFile = def.resolvedPath || ''
    if (bFile && !/\.wav$/i.test(bFile)) {
      skipped.push({ time, names, reason: 'successor 的音频不是 WAV，暂不能延迟混音' })
      continue
    }
    const delay = time - placed.time
    if (delay <= 0) {
      skipped.push({ time, names, reason: '后继时间不在前一个音效之后' })
      continue
    }

    // A 是滑条点：直接把这个点自己的文件扩展成「tick + 延迟 B」，不用再开新编号
    if (placed.kind === 'slidertick') {
      const task = files.find((f) => f.to === placed.fileTo)
      if (!task || task.overwrite) {
        skipped.push({ time, names, reason: '前一个滑条点没有可混音的文件' })
        continue
      }
      if (bFile) {
        const base = task.delays || new Array(task.from.length).fill(0)
        task.from.push(bFile)
        task.delays = [...base, delay]
      } else {
        const base = task.defaultDelays || new Array(task.defaults.length).fill(0)
        task.defaults.push(def.defaultRef!)
        task.defaultDelays = [...base, delay]
      }
      task.mix = true
      placements.push({
        time,
        slot: 'successor',
        name,
        set,
        index: placed.index,
        of: placed.time,
        delay,
      })
      keep.delete(time)
      removed.push(time)
      continue
    }

    // A 是普通主槽位音效：给 A 开一个新编号，生成「A + 延迟 B」的新文件
    const aDef = placed.def
    const aMain = voiceMain(aDef)
    if (!aMain) {
      skipped.push({ time, names, reason: '前一个音效没有主槽位，副槽位无法附着' })
      continue
    }
    if (!aDef.resolvedPath && !aDef.defaultRef) {
      skipped.push({ time, names, reason: '前一个音效没有可用的音频文件' })
      continue
    }
    if (aDef.resolvedPath && !/\.wav$/i.test(aDef.resolvedPath)) {
      skipped.push({ time, names, reason: '前一个音效不是 WAV，暂不能延迟混音' })
      continue
    }
    const aSet = setOfSample(placed.sample, aMain.hit)
    let group = successorGroups.get(placed.time)
    if (!group) {
      group = {
        sample: placed.sample,
        def: aDef,
        set: aSet,
        hit: aMain.hit,
        index: nextIndex++,
        sources: [],
      }
      successorGroups.set(placed.time, group)
      moves.push({
        time: placed.time,
        index: group.index,
        volume: placed.sample.volume,
        set: SET_NUM[aSet],
      })
    }
    group.sources.push({
      file: bFile || undefined,
      defaultRef: bFile ? undefined : def.defaultRef,
      delay,
      code: name,
      set,
      hit: main?.hit || 'hitnormal',
      index: sample.group,
    })
    placements.push({
      time,
      slot: 'successor',
      name,
      set,
      index: group.index,
      of: placed.time,
      delay,
    })
    keep.delete(time)
    removed.push(time)
  }

  // successor 的混音文件：A 的原始音效放在 0ms，B 按间隔延迟叠上去
  for (const [aTime, g] of successorGroups) {
    const aFile = g.def.resolvedPath || ''
    const sources: SourceRef[] = [
      {
        file: aFile || undefined,
        defaultRef: aFile ? undefined : g.def.defaultRef,
        delay: 0,
        code: g.def.name || '',
        set: g.set,
        hit: g.hit,
        index: g.index,
      },
      ...g.sources,
    ]
    const ext = '.wav' // 混音输出统一是 wav
    files.push(mixTask(`${g.set}-${g.hit}${g.index}${ext}`, sources))
  }

  for (const [time, mv] of restores) {
    // 尾巴上本来就有主槽位音效时，patch 会用那个音效自己的编号/采样组，别再插恢复线
    if (!keep.has(time)) moves.push(mv)
  }

  return { samples: keep, moves, files, placements, globalCount, removed, skipped }
}
