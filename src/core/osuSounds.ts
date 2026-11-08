/**
 * 从 .osu 谱面提取音效事件，生成 musictxt（.hs）。
 *
 * 核心难点：
 *  1) auto 采样组：hitSample 的 normalSet / additionSet 为 0 时不是「固定某组」，
 *     而是回落到该物件**所在红/绿线区域**的 sampleSet（红线的 sampleSet 只在非 0 时才生效）。
 *  2) Slider 头/尾/每个折返点各自独立设置音效，需要先换算出每个节点的实际毫秒时间，
 *     再按那个时间去找对应的红绿线区域（绿线跨滑条时尤为重要）。
 *  3) 绿线（inherited）只改滑条速度，不改绝对拍数；换算绝对时间只认绿线（uninherited=1）。
 *  4) 多个音色文件可能内容完全一样（复制粘贴），按内容去重让它们共用同一个音效代码。
 */

import type { SampleSet, HitType } from './types'

// ---------------------------------------------------------------------------
// osu! 基础类型
// ---------------------------------------------------------------------------

export interface OsuTimingPoint {
  time: number
  beatLength: number
  meter: number
  sampleSet: number
  sampleIndex: number
  volume: number
  uninherited: boolean
  effects: number
}

export interface OsuHitSample {
  normalSet: number
  additionSet: number
  index: number
  volume: number
  filename: string
}

export interface OsuHitObject {
  x: number
  y: number
  time: number
  type: number
  hitSound: number
  objectParams: string
  hitSample: OsuHitSample
}

export interface OsuDifficulty {
  version: string
  title: string
  artist: string
  creator: string
  beatmapID: string
  level: number
  fileName: string
  audioFilename: string
  path?: string
}

/** 一个音效"代码"，对应 [Define] 里的一条 hitsound */
export interface SoundCode {
  /** .hs 正文里用的名字：英文字母，大小写不限（数字/符号用 One / Slash 这类名字） */
  name: string
  sampleSet: SampleSet
  hitType: HitType
  /** sampleIndex（音效组编号），0 = 用默认 */
  index: number
  /** 实际解析到的音色文件名（相对 .osu 所在目录），空 = 用内置 default */
  file: string
  /** [Define] 的槽位字符串，如 "normal-hitnormal" / "custom" */
  slot: string
  /**
   * 这个文件被哪些槽位请求过（`soft-hitclap` 这种）。
   * 文件内容相同的音效会共用同一个 code，所以可能不止一个。
   */
  usedAs: string[]
  /** [Define] 的值：引号包裹的相对路径，或 default.xxx 引用 */
  value: string
  /**
   * 这个文件是「多个代号混音」的产物时，记着混合前的来源。
   * 导出时写进 WAV 的 HSSM 块，重新导入就能拆回原来的多个音效。
   */
  mix?: MixMeta
}

/** 混音来源（写进 WAV 的 HSSM 块，格式见 electron/wav-mix.cjs） */
export interface MixSource {
  /** 导出前的代号（Aa/Ab…），仅用于展示 */
  code: string
  set: SampleSet
  hit: HitType
  /** 导出时的音效组编号 */
  index: number
  /** 源文件名（相对导出目录） */
  file: string
  /** 源文件绝对路径（导出时记录，用于换目录后找回） */
  path?: string
}

export interface MixMeta {
  v: number
  app?: string
  sources: MixSource[]
}

export interface ExtractedSound {
  time: number
  code: SoundCode
  volume: number
  /**
   * 该物件当时请求的 sampleIndex（音效组编号）。
   *
   * 不能直接用 `code.index`：内容相同的音色文件会被合并成同一个代码，
   * 合并后代码的 index 是第一次创建时那个，未必等于当前物件请求的编号。
   * 正文的 `<编号>` 前缀必须按请求值写，否则同一个音会被拆成两格。
   */
  sampleIndex: number
  /** UI 展示用：来自哪个物件 */
  source: string
}

/**
 * 音效代码的稳定标识（跨 extract / render 传递用）。
 * 不能用 name —— 导入对话框里用户可以随便改代号。
 */
export function soundCodeKey(c: SoundCode): string {
  return `${c.sampleSet}|${c.hitType}|${c.index}|${c.file || c.slot}`
}

export interface OsuSoundsResult {
  codes: SoundCode[]
  sounds: ExtractedSound[]
  timing: OsuTimingPoint[]
  difficulties: OsuDifficulty[]
  audioFilename: string
  /**
   * 乐曲结尾时间（毫秒）。
   *
   * 最后一条红线没有「下一条红线」，但它到曲末的距离同样要参与
   * 「是否继承拍号」的判断（超过 2000ms 就断开继承），所以必须知道曲末在哪。
   * 优先用音频时长；拿不到音频时退化为最后一个物件的时间。
   */
  songEnd: number
  /** 因所在区域没有 timing point 而被跳过的物件数 */
  skippedNoTiming: number
}

/** 环境能力：由调用方（Electron 侧）注入，浏览器下可以省略 */
export interface OsuSoundsEnv {
  /** .osu 所在目录 */
  dir?: string
  /** 判断目录下是否存在某个音色文件 */
  fileExists?: (dir: string, rel: string) => Promise<boolean>
  /** 读文件算内容哈希，用于「内容相同的音色文件去重」 */
  hashFile?: (dir: string, rel: string) => Promise<string>
  /**
   * 解析歌曲音频时长（毫秒），用于确定「最后一条红线到曲末」的距离。
   * 拿不到时留空，提取阶段会退化为「最后一个物件的时间」。
   */
  audioDurationMs?: (dir: string, rel: string) => Promise<number>
  /** 源文件名（仅用于展示） */
  fileName?: string
  /** 源文件完整路径（仅用于展示） */
  filePath?: string
  /** 读 WAV 里的 HSSM 混音信息（没有就返回 null） */
  wavMeta?: (dir: string, rel: string) => Promise<MixMeta | null>
}

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const SET_NAMES: Record<number, SampleSet> = { 1: 'normal', 2: 'soft', 3: 'drum' }
const HIT_BITS: { bit: number; hit: HitType }[] = [
  { bit: 1, hit: 'hitnormal' },
  { bit: 2, hit: 'hitwhistle' },
  { bit: 4, hit: 'hitfinish' },
  { bit: 8, hit: 'hitclap' },
]

export function setName(n: number): SampleSet {
  return SET_NAMES[n] || 'normal'
}

/**
 * [General] SampleSet 的值是英文名（Normal / Soft / Drum）。
 * timing point 和物件都没写采样组时，osu 用它作为最终兜底。
 */
export function sampleSetFromName(name: string | undefined): number {
  const n = (name || '').trim().toLowerCase()
  return n === 'normal' ? 1 : n === 'soft' ? 2 : n === 'drum' ? 3 : 0
}

export function defaultRefOf(set: SampleSet, hit: HitType): string {
  return `default.${set}-${hit}`
}

export function osuSections(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur = ''
  for (const l of src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
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

export function osuKV(lines: string[] | undefined): Record<string, string> {
  const o: Record<string, string> = {}
  for (const l of lines || []) {
    const i = l.indexOf(':')
    if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return o
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export function parseTimingPoints(lines: string[] | undefined): OsuTimingPoint[] {
  const out: OsuTimingPoint[] = []
  for (const l of lines || []) {
    const s = l.trim()
    if (!s || s.startsWith('//')) continue
    const p = s.split(',').map((x) => x.trim())
    if (p.length < 2) continue
    const time = Number(p[0])
    const beatLength = Number(p[1])
    if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue
    out.push({
      time,
      beatLength,
      meter: Number(p[2]) || 4,
      sampleSet: Number(p[3]) || 0,
      sampleIndex: Number(p[4]) || 0,
      volume: p[5] === undefined ? 100 : Number(p[5]) || 0,
      uninherited: (Number(p[6]) || 0) === 1,
      effects: Number(p[7]) || 0,
    })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

export function parseHitObjects(lines: string[] | undefined): OsuHitObject[] {
  const out: OsuHitObject[] = []
  for (const l of lines || []) {
    const s = l.trim()
    if (!s || s.startsWith('//')) continue
    const p = s.split(',')
    if (p.length < 5) continue
    const time = Number(p[2])
    const type = Number(p[3])
    if (!Number.isFinite(time) || !Number.isFinite(type)) continue
    // 滑条的 objectParams 自身含逗号（curveType|points,slides,length,edgeSounds,edgeSets），
    // hitSample 则是它后面那一整段，所以这里必须把余下字段重新拼回去。
    const isSlider = (type & 2) === 2
    const tail = p.slice(5).join(',')
    const objectParams = tail
    // 滑条的字段位置固定：curve(5) / slides(6) / length(7) / edgeSounds(8) / edgeSets(9) / hitSample(10)。
    // 老格式只写到 length 就结束，此时根本没有 hitSample。以前取 p[6]（slides 数量）
    // 会把它当成采样组（例如 "5"），滑块头就被当成 normal，Timing 里的 drum/soft 全丢。
    const hitSample = isSlider ? (p[10] ?? '') : tail
    out.push({
      x: Number(p[0]) || 0,
      y: Number(p[1]) || 0,
      time,
      type,
      hitSound: Number(p[4]) || 0,
      objectParams,
      hitSample: parseHitSample(hitSample),
    })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

function parseHitSample(s: string | undefined): OsuHitSample {
  if (!s) return { normalSet: 0, additionSet: 0, index: 0, volume: 0, filename: '' }
  const p = s.split(':')
  return {
    normalSet: Number(p[0]) || 0,
    additionSet: Number(p[1]) || 0,
    index: Number(p[2]) || 0,
    volume: Number(p[3]) || 0,
    filename: (p[4] || '').trim(),
  }
}

export function parseDifficulty(src: string, fileName: string, path?: string): OsuDifficulty {
  const sec = osuSections(src)
  const meta = osuKV(sec.get('metadata'))
  const gen = osuKV(sec.get('general'))
  const diff = osuKV(sec.get('difficulty'))
  return {
    version: meta.Version || '(未命名难度)',
    title: meta.Title || '',
    artist: meta.Artist || '',
    creator: meta.Creator || '',
    beatmapID: meta.BeatmapID || '0',
    level: Number(diff.HPDrainRate) || 0,
    fileName,
    path,
    audioFilename: gen.AudioFilename || '',
  }
}

// ---------------------------------------------------------------------------
// 红/绿线区域查询
// ---------------------------------------------------------------------------

export interface Region {
  sampleSet: number
  sampleIndex: number
  volume: number
}

/**
 * 取时间 t 生效的采样组设置。
 *
 * osu! 的规则：先找 t 之前最后一条 timing point；它的 sampleSet / sampleIndex / volume
 * 若为 0，则继续往前找，直到碰到非 0 的值。
 * 也就是说红色 inherited point 只有显式写了非 0 值时才会覆盖绿色基准。
 */
export function regionAt(tps: OsuTimingPoint[], t: number): Region | null {
  let idx = -1
  let lo = 0
  let hi = tps.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tps[mid].time <= t) {
      idx = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (idx < 0) return null
  let sampleSet = 0
  let sampleIndex = 0
  let volume = 0
  for (let i = idx; i >= 0; i--) {
    if (!sampleSet && tps[i].sampleSet) sampleSet = tps[i].sampleSet
    if (!sampleIndex && tps[i].sampleIndex) sampleIndex = tps[i].sampleIndex
    if (!volume && tps[i].volume) volume = tps[i].volume
    if (sampleSet && sampleIndex && volume) break
  }
  return { sampleSet, sampleIndex, volume }
}

// ---------------------------------------------------------------------------
// Slider 节点时间换算
// ---------------------------------------------------------------------------

/** 取时间 t 处生效的每拍毫秒数（只认绿线）与滑条速度倍率（只认红线） */
export function timingAt(tps: OsuTimingPoint[], t: number): { beatLength: number; sv: number } {
  let beatLength = 0
  let sv = 1
  for (let i = 0; i < tps.length; i++) {
    if (tps[i].time > t) break
    const tp = tps[i]
    if (tp.uninherited) beatLength = tp.beatLength
    else sv = 100 / Math.abs(tp.beatLength || 100)
  }
  return { beatLength: beatLength || 500, sv: sv || 1 }
}

/**
 * 算出 Slider 每个节点（头 + 每个折返点 + 尾）的时间戳，长度恒为 slides + 1。
 * 公式来自 osu! wiki：length / (SliderMultiplier * 100 * SV) * beatLength
 */
export function sliderNodeTimes(
  tps: OsuTimingPoint[],
  startTime: number,
  length: number,
  slides: number,
  sliderMultiplier: number,
): number[] {
  const { beatLength, sv } = timingAt(tps, startTime)
  const scoringDistance = 100 * (sliderMultiplier || 1)
  // 滑条速度 sv = 100/|绿线 beatLength|：-200 → 0.5（更慢）、-50 → 2（更快）。
  // 每拍走的距离 = 100 × SliderMultiplier × sv，所以时长要 **除以** sv；
  // 之前写成乘以 sv，SV 0.5 的段落会算成 1/4 时长（折返点整体提前）。
  const msPerSlide = (length / scoringDistance) * beatLength / sv
  const out: number[] = []
  for (let i = 0; i <= slides; i++) out.push(Math.round(startTime + i * msPerSlide))
  return out
}

function parseSliderParams(objectParams: string): { slides: number; length: number } {
  const p = objectParams.split(',')
  // curveType|points, slides, length, edgeSounds, edgeSets
  return { slides: Math.max(1, Number(p[1]) || 1), length: Number(p[2]) || 0 }
}

function parseSliderEdges(
  objectParams: string,
): { sounds: number[]; sets: { normal: number; addition: number }[] } {
  const p = objectParams.split(',')
  const sounds = (p[3] || '')
    .split('|')
    .filter((s) => s.trim())
    .map((s) => Number(s) || 0)
  const sets = (p[4] || '')
    .split('|')
    .filter((s) => s.trim())
    .map((s) => {
      const q = s.split(':')
      return { normal: Number(q[0]) || 0, addition: Number(q[1]) || 0 }
    })
  return { sounds, sets }
}

// ---------------------------------------------------------------------------
// 音效代码池（内容去重）
// ---------------------------------------------------------------------------

/**
 * 默认从「大写字母 + 小写字母」依次生成（Aa、Ab…），新规则下同样合法。
 */
function makeNameFactory(): () => string {
  const used = new Set<string>()
  let a = 0
  let b = 0
  return () => {
    for (;;) {
      const name = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[a] + 'abcdefghijklmnopqrstuvwxyz'[b]
      b++
      if (b > 25) {
        b = 0
        a = (a + 1) % 26
      }
      if (!used.has(name)) {
        used.add(name)
        return name
      }
    }
  }
}

/** osu! 目录里音色文件的命名：normal-hitnormal.wav / normal-hitnormal7.wav */
export function sampleFileName(set: SampleSet, hit: HitType, index: number): string {
  return index === 0 ? `${set}-${hit}.wav` : `${set}-${hit}${index}.wav`
}

class SoundCodePool {
  private byKey = new Map<string, SoundCode>()
  private byContent = new Map<string, SoundCode>()
  private nextName: () => string
  private env: OsuSoundsEnv
  private hashCache = new Map<string, string>()
  private existCache = new Map<string, boolean>()

  constructor(env: OsuSoundsEnv) {
    this.nextName = makeNameFactory()
    this.env = env
  }

  private async exists(rel: string): Promise<boolean> {
    if (!rel || !this.env.dir || !this.env.fileExists) return false
    const k = rel.toLowerCase()
    if (this.existCache.has(k)) return this.existCache.get(k)!
    const v = await this.env.fileExists(this.env.dir, rel)
    this.existCache.set(k, v)
    return v
  }

  private async hashOf(rel: string): Promise<string> {
    const k = rel.toLowerCase()
    if (this.hashCache.has(k)) return this.hashCache.get(k)!
    let h = `path:${k}`
    if (this.env.hashFile && this.env.dir) {
      try {
        h = (await this.env.hashFile(this.env.dir, rel)) || h
      } catch {
        /* 读不到就退化成路径指纹 */
      }
    }
    this.hashCache.set(k, h)
    return h
  }

  /**
   * 取（或创建）一个音效代码。
   * 解析顺序：
   *   1) hitSample.filename 指定的自定义文件（仅 addition 有效）
   *   2) .osu 所在目录里的标准命名音色文件
   *   3) 内置 default.xxx
   * 相同 (采样组, 类型, 索引) 复用同一 code；文件内容相同也复用同一 code。
   */
  async get(set: SampleSet, hit: HitType, index: number, customFile?: string): Promise<SoundCode> {
    const key = `${set}|${hit}|${index}`
    const exist = this.byKey.get(key)
    if (exist) return exist

    let file = ''
    if (customFile && (await this.exists(customFile))) file = customFile
    if (!file) {
      const std = sampleFileName(set, hit, index)
      if (await this.exists(std)) {
        file = std
      } else if (index > 0) {
        // osu 的回落：`normal-hitnormal3.wav` 不存在时用不带编号的那个。
        // 谱面里绿线常带 sampleIndex:1，但目录里只有基础名文件；
        // 不回落到这里就会全部退成 default.xxx，听感直接对不上（音效“没加载”）。
        const base = sampleFileName(set, hit, 0)
        if (await this.exists(base)) file = base
      }
    }

    const code = await this.codeFor(set, hit, index, file)
    this.byKey.set(key, code)
    return code
  }

  /** 按「文件内容」去重地建一个 code；混音文件会把 HSSM 信息挂到 code.mix 上 */
  private async codeFor(set: SampleSet, hit: HitType, index: number, file: string): Promise<SoundCode> {
    const contentKey = file ? `sha:${await this.hashOf(file)}` : `def:${defaultRefOf(set, hit)}`
    const own = `${set}-${hit}`
    const dup = this.byContent.get(contentKey)
    if (dup) {
      if (!dup.usedAs.includes(own)) dup.usedAs.push(own)
      return dup
    }

    const code: SoundCode = {
      name: this.nextName(),
      sampleSet: set,
      hitType: hit,
      index,
      file,
      usedAs: [own],
      slot: file ? 'custom' : own,
      value: file ? `"${file.replace(/\\/g, '/')}"` : defaultRefOf(set, hit),
      mix: file ? (await this.metaOf(file)) || undefined : undefined,
    }
    this.byContent.set(contentKey, code)
    return code
  }

  private metaCache = new Map<string, MixMeta | null>()

  private async metaOf(rel: string): Promise<MixMeta | null> {
    if (!rel || !this.env.dir || !this.env.wavMeta) return null
    const k = rel.toLowerCase()
    if (this.metaCache.has(k)) return this.metaCache.get(k)!
    let m: MixMeta | null = null
    try {
      m = (await this.env.wavMeta(this.env.dir, rel)) || null
    } catch {
      m = null
    }
    // 结构不完整就当没有，别让一条脏数据把整次导入搞崩
    if (m && (!Array.isArray(m.sources) || !m.sources.length)) m = null
    this.metaCache.set(k, m)
    return m
  }

  /**
   * 和 get 一样，但如果这个文件是混音产物（带 HSSM），并且源文件都还在，
   * 就拆回混合前的多个 code —— 正文会重新变成 [A B] 的叠加结构。
   * 少一个源就整体保留混音文件，不拆出「半个」音效。
   */
  async getMany(set: SampleSet, hit: HitType, index: number, customFile?: string): Promise<SoundCode[]> {
    const code = await this.get(set, hit, index, customFile)
    const mix = code.mix
    if (!mix || !mix.sources?.length) return [code]

    const resolved: { src: MixSource; file: string }[] = []
    for (const src of mix.sources) {
      if (!src.set || !src.hit) return [code]
      const file = await this.sourceRel(src)
      if (!file) return [code]
      resolved.push({ src, file })
    }
    const out: SoundCode[] = []
    for (const { src, file } of resolved) {
      out.push(await this.codeFor(src.set, src.hit, src.index || index, file))
    }
    return out.length ? out : [code]
  }

  /** 混音来源在导出目录里还找得到吗（先按文件名，再按导出时记的绝对路径） */
  private async sourceRel(src: MixSource): Promise<string> {
    if (src.file && (await this.exists(src.file))) return src.file
    if (src.path) {
      const rel = relUnder(this.env.dir || '', src.path)
      if (rel && (await this.exists(rel))) return rel
      // 导出到了别的目录：原绝对路径还在就直接用（源文件没被挪走的情况）
      if (/^[a-z]:[\\/]/i.test(src.path) || src.path.startsWith('//')) {
        if (await this.exists(src.path)) return src.path
      }
    }
    return ''
  }
}

/**
 * 文件名本身就是 osu 标准命名时（`drum-hitclap.wav`、`soft-hitnormal8.wav`），
 * 直接读回槽位。只认完整匹配，`my-soft-hitclap-remix.wav` 这类不会被误判。
 */
export function slotFromFileName(file: string): string {
  const base = String(file || '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
  const m = /^(soft|normal|drum)-(hitnormal|hitwhistle|hitfinish|hitclap|sliderside|slidertick)\d*$/.exec(base)
  return m ? `${m[1]}-${m[2]}` : ''
}

/**
 * code 写进 [Define] 时用哪个槽位。
 *
 * 以前只要是自定义文件就一律写 `custom`，让导出时再按文件名猜 ——
 * 但文件名本来就带槽位信息（`drum-hitclap.wav`），猜出来的结果和实际
 * 可能不一致，导入再导出就会漂槽位、撞同名文件。这里直接写死。
 */
function resolveCodeSlot(c: SoundCode): string {
  const used = c.usedAs || []
  // 同一个文件被当成不同槽位用过（内容相同的 soft-hitclap8 / normal-hitclap18 会合并成
  // 一个 code），写死任何一个都会让另一个时刻的叠音冲突，只能留给导出时按组合挑。
  if (used.length > 1) return 'custom'
  const byName = slotFromFileName(c.file)
  return byName || used[0] || 'custom'
}

/** 绝对路径在 dir 下时取相对部分（导出换了目录也能找回源文件） */
function relUnder(dir: string, abs: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const a = abs.replace(/\\/g, '/')
  if (!d) return ''
  if (a.toLowerCase().startsWith(d + '/')) return a.slice(d.length + 1)
  return ''
}

// ---------------------------------------------------------------------------
// 主转换
// ---------------------------------------------------------------------------

export function extractOsuSounds(src: string, env: OsuSoundsEnv = {}): Promise<OsuSoundsResult> {
  const sec = osuSections(src)
  const gen = osuKV(sec.get('general'))
  const tps = parseTimingPoints(sec.get('timingpoints'))
  const objs = parseHitObjects(sec.get('hitobjects'))
  const diff = osuKV(sec.get('difficulty'))
  const sliderMultiplier = Number(diff.SliderMultiplier) || 1
  // [General] SampleSet：timing point 和物件都写 auto（0）时的最终兜底
  const generalSet = sampleSetFromName(gen.SampleSet)

  const pool = new SoundCodePool(env)
  const sounds: ExtractedSound[] = []
  let skippedNoTiming = 0

  async function emit(
    hitSound: number,
    hs: OsuHitSample,
    at: number,
    region: Region,
    source: string,
    /** 是否补上基础 hitnormal（转盘不补：osu 的转盘播的是转盘音，不是 hitnormal） */
    withBase = true,
  ): Promise<void> {
    // osu! 里每个物件（以及滑条的每一个节点）都会播基础的 hitnormal ——
    // hitSound 的 bit 1 只表示「显式写了 normal」，不写也一样会响。
    // 所以这里始终把 bit 1 补上；否则导入出来的谱里 hitnormal 既没有代号、
    // 试听也听不到（用户反馈的「三个 hitnormal 都没加入」就是这个原因）。
    const sound = withBase ? hitSound | 1 : hitSound
    if (!sound) return
    // normalSet 为 0（auto）→ 回落到该区域生效的 sampleSet；
    // 区域里也没写（timing point 全是 auto）→ 用 [General] SampleSet。
    const normalSetNum = hs.normalSet || region.sampleSet || generalSet
    // additionSet 为 0 → 跟随 normal 的采样组
    const additionSetNum = hs.additionSet || normalSetNum
    const index = hs.index || region.sampleIndex
    const volume = hs.volume || region.volume || 100

    for (const { bit, hit } of HIT_BITS) {
      if (!(sound & bit)) continue
      const isNormal = hit === 'hitnormal'
      const setNum = isNormal ? normalSetNum : additionSetNum
      // hitSample.filename 按 osu 语义只对 addition 生效
      const custom = !isNormal && hs.filename ? hs.filename : ''
      // 混音文件在这里展开成混合前的多个音效；普通文件只会返回 1 个
      const codes = await pool.getMany(setName(setNum), hit, index, custom)
      for (const code of codes) {
        sounds.push({
          time: Math.round(at),
          code,
          volume: Math.max(1, Math.min(100, volume)),
          sampleIndex: index,
          source,
        })
      }
    }
  }

  return (async () => {
    for (const o of objs) {
      const region = regionAt(tps, o.time)
      if (!region) {
        skippedNoTiming++
        continue
      }

      if ((o.type & 2) === 2) {
        // Slider：头 / 每个折返点 / 尾 各自独立
        const { slides, length } = parseSliderParams(o.objectParams)
        const times = sliderNodeTimes(tps, o.time, length, slides, sliderMultiplier)
        const { sounds: edgeSounds, sets: edgeSets } = parseSliderEdges(o.objectParams)
        for (let i = 0; i < times.length; i++) {
          const t = times[i]
          // 每个节点按**自己**的时间找红绿线区域（绿线跨滑条时至关重要）
          const reg = regionAt(tps, t) || region
          const esSet = edgeSets[i] || { normal: 0, addition: 0 }
          // 滑条的 hitSound 是**头部**的基础音效（edgeSounds[0] 是头部的额外音效），
          // 两者叠加；以前只看 edgeSounds，hitSound 里写的 whistle/clap 会丢。
          // 头部还可能带自己的 hitSample（编号/音量），没有就沿用区域。
          const head = i === 0 ? o.hitSample : undefined
          await emit(
            i === 0 ? o.hitSound | (edgeSounds[0] || 0) : edgeSounds[i] || 0,
            {
              normalSet: esSet.normal || head?.normalSet || 0,
              additionSet: esSet.addition || head?.additionSet || 0,
              index: head?.index || reg.sampleIndex,
              volume: head?.volume || reg.volume,
              filename: head?.filename || '',
            },
            t,
            reg,
            i === 0 ? '滑条头' : i === times.length - 1 ? '滑条尾' : `折返点${i}`,
            // 基础 hitnormal 只补在滑条头（真正的“击打”）。折返点/尾巴在 osu 里
            // 只播各自 edgeSounds 里显式写的音效，补 base 会凭空多出一串 1/16、1/8。
            i === 0,
          )
        }
      } else {
        // 转盘：osu! 的转盘音效是在**转完**（结束）时才响的，不是转盘开头。
        // 物件行的第 6 个字段就是 endTime；拿不到就退回起点（自闭合转盘）。
        // 注意采样组/音量仍沿用**起点**所在的红绿线区域（和 osu 一致：音量在物件
        // 创建时按起点取样），只把播放时刻挪到尾部。
        const isSpinner = (o.type & 8) === 8
        let at = o.time
        if (isSpinner) {
          const end = Number((o.objectParams.split(',')[0] || '').trim())
          if (Number.isFinite(end) && end > o.time) at = end
        }
        await emit(o.hitSound, o.hitSample, at, region, describeType(o.type), !isSpinner)
      }
    }

    sounds.sort((a, b) => a.time - b.time)

    // 乐曲结尾：优先用音频时长；拿不到就退化为最后一个物件/音效的时间。
    // 这个值决定「最后一条红线到曲末」算不算超过 2000ms（也就是还继承不继承拍号）。
    let songEnd = sounds.length ? sounds[sounds.length - 1].time : 0
    const audio = gen.AudioFilename || ''
    if (env.audioDurationMs && env.dir && audio) {
      try {
        const dur = await env.audioDurationMs(env.dir, audio)
        if (dur > 0) songEnd = dur
      } catch {
        /* 解析不了就用物件时间兜底 */
      }
    }
    // 滑条尾比物件时间晚，物件里已含滑条节点；这里再兜一层长度下界
    let lastObject = 0
    for (const o of objs) if (o.time > lastObject) lastObject = o.time
    if (lastObject > songEnd) songEnd = lastObject

    const seen = new Set<SoundCode>()
    const codes: SoundCode[] = []
    for (const s of sounds) {
      if (!seen.has(s.code)) {
        seen.add(s.code)
        s.code.slot = resolveCodeSlot(s.code)
        codes.push(s.code)
      }
    }

    return {
      codes,
      sounds,
      timing: tps,
      difficulties: [parseDifficulty(src, env.fileName || '', env.filePath)],
      audioFilename: audio,
      songEnd,
      skippedNoTiming,
    } satisfies OsuSoundsResult
  })()
}

function describeType(type: number): string {
  if (type & 128) return 'mania长音'
  if (type & 64) return '长音'
  if (type & 8) return '转盘'
  return '单击'
}
