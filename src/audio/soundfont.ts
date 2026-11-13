/**
 * SoundFont 2 / 3 的最小解析器（不依赖第三方库）。
 *
 * 只做「选一个 preset，取出它的 instrument zones，交给播放引擎按音高变调」，
 * 不做滤波/包络/调制轮等合成细节 —— 用来试听按键音已经够用。
 *
 * SF2 结构：RIFF/sfbk → LIST(sdta){smpl} + LIST(pdta){phdr,pbag,pgen,inst,ibag,igen,shdr}
 * SF3 与 SF2 相同，只是 smpl 里的每个 sample 是一段完整的 Ogg Vorbis 字节流。
 */

export type Sf2Kind = 'sf2' | 'sf3'

export interface Sf2SampleInfo {
  index: number
  name: string
  /** smpl 里的起点/终点；SF2 以 16-bit sample 为单位，SF3 以字节为单位 */
  start: number
  end: number
  loopStart: number
  loopEnd: number
  sampleRate: number
  originalPitch: number
  pitchCorrection: number
  sampleType: number
}

export interface Sf2ZoneInfo {
  sampleIndex: number
  keyLow: number
  keyHigh: number
  velLow: number
  velHigh: number
  /** 已解析好的根音（覆盖值 > sample.originalPitch） */
  rootKey: number
  coarseTune: number
  fineTune: number
  /** 衰减，单位 centibel；0 = 不衰减 */
  attenuation: number
}

export interface Sf2PresetInfo {
  index: number
  name: string
  bank: number
  program: number
  zones: Sf2ZoneInfo[]
}

export interface Sf2File {
  kind: Sf2Kind
  presets: Sf2PresetInfo[]
  samples: Sf2SampleInfo[]
  /** smpl chunk 的原始字节 */
  smpl: Uint8Array
}

interface Chunk {
  start: number
  end: number
}

interface Gen {
  oper: number
  amount: number
  /** keyRange / velRange 的 lo/hi 字节 */
  range?: [number, number]
}

function ascii(view: DataView, start: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(start + i)
    if (!c) break
    s += String.fromCharCode(c)
  }
  return s.trim()
}

function findChunks(view: DataView, start: number, end: number, out: Map<string, Chunk>) {
  let p = start
  while (p + 8 <= end) {
    const id = ascii(view, p, 4)
    const size = view.getUint32(p + 4, true)
    const dataStart = p + 8
    const dataEnd = Math.min(dataStart + size, end)
    if (size < 0 || dataEnd < dataStart) break
    if (id === 'LIST') {
      // LIST 的前 4 字节是类型（INFO / sdta / pdta），里面才是真正的 chunk
      if (dataStart + 4 <= dataEnd) findChunks(view, dataStart + 4, dataEnd, out)
    } else if (id !== 'RIFF') {
      out.set(id, { start: dataStart, end: dataEnd })
    }
    p = dataStart + size + (size % 2)
  }
}

/** 一个 zone 的生成器集合；terminal 出现的位置决定它是什么类型的 zone */
interface RawZone {
  terminal: number
  gens: Map<number, Gen>
}

/**
 * 按 bag 划分 zone。
 *
 * SF2 的规则：每个 bag 是「一个 zone 的生成器区间」，最后一个生成器是 terminal
 * （preset 用 41=instrument，instrument 用 53=sampleID）。没有 terminal 的 bag
 * 是 global zone，作为后续 zone 的默认值。
 */
function readZones(
  view: DataView,
  genChunk: Chunk,
  bagChunk: Chunk,
  bagStart: number,
  bagEnd: number,
  terminal: number,
): RawZone[] {
  const genCount = Math.floor((genChunk.end - genChunk.start) / 4)
  const bagCount = Math.floor((bagChunk.end - bagChunk.start) / 4)
  const bagGen = (i: number) =>
    i >= 0 && i < bagCount ? view.getUint16(bagChunk.start + i * 4, true) : genCount

  const out: RawZone[] = []
  let global = new Map<number, Gen>()
  for (let b = Math.max(0, bagStart); b < Math.min(bagEnd, bagCount); b++) {
    const gs = bagGen(b)
    const ge = bagGen(b + 1)
    const gens = new Map<number, Gen>()
    let term: Gen | null = null
    for (let g = gs; g < ge && g < genCount; g++) {
      const off = genChunk.start + g * 4
      const oper = view.getUint16(off, true)
      const raw = view.getUint16(off + 2, true)
      const signed = view.getInt16(off + 2, true)
      const gen: Gen = { oper, amount: signed }
      if (oper === 43 || oper === 44) gen.range = [view.getUint8(off + 2), view.getUint8(off + 3)]
      if (oper === terminal) term = gen
      else gens.set(oper, gen)
    }
    if (!term) {
      // global zone：合并默认值
      for (const [k, v] of gens) global.set(k, v)
      continue
    }
    const merged = new Map(global)
    for (const [k, v] of gens) merged.set(k, v)
    out.push({ terminal: term.amount, gens: merged })
  }
  return out
}

function genRange(gens: Map<number, Gen>, oper: number): [number, number] | null {
  const g = gens.get(oper)
  return g?.range ?? null
}

function genNum(gens: Map<number, Gen>, oper: number, def = 0): number {
  return gens.get(oper)?.amount ?? def
}

export function parseSoundFont(buf: ArrayBuffer, kind: Sf2Kind): Sf2File {
  const view = new DataView(buf)
  if (buf.byteLength < 12 || ascii(view, 0, 4) !== 'RIFF') throw new Error('不是 RIFF 文件')
  const form = ascii(view, 8, 4)
  if (form !== 'sfbk') throw new Error(`不是 SoundFont 文件（RIFF/${form}）`)

  const chunks = new Map<string, Chunk>()
  findChunks(view, 12, view.byteLength, chunks)
  const need = ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr', 'smpl']
  for (const k of need) if (!chunks.has(k)) throw new Error(`SoundFont 缺少 ${k} chunk`)

  const phdr = chunks.get('phdr')!
  const pbag = chunks.get('pbag')!
  const pgen = chunks.get('pgen')!
  const inst = chunks.get('inst')!
  const ibag = chunks.get('ibag')!
  const igen = chunks.get('igen')!
  const shdr = chunks.get('shdr')!
  const smpl = chunks.get('smpl')!

  // sample headers
  const samples: Sf2SampleInfo[] = []
  const shCount = Math.floor((shdr.end - shdr.start) / 46)
  for (let i = 0; i < shCount; i++) {
    const o = shdr.start + i * 46
    const name = ascii(view, o, 20)
    if (name === 'EOS') break
    samples.push({
      index: samples.length,
      name,
      start: view.getUint32(o + 20, true),
      end: view.getUint32(o + 24, true),
      loopStart: view.getUint32(o + 28, true),
      loopEnd: view.getUint32(o + 32, true),
      sampleRate: view.getUint32(o + 36, true) || 44100,
      originalPitch: view.getUint8(o + 40),
      pitchCorrection: view.getInt8(o + 41),
      sampleType: view.getUint16(o + 44, true),
    })
  }

  // instrument zones：每个 instrument 的 bag 区间
  const instCount = Math.floor((inst.end - inst.start) / 22)
  const instBags: { start: number; end: number }[] = []
  for (let i = 0; i < instCount; i++) {
    const o = inst.start + i * 22
    const name = ascii(view, o, 20)
    if (name === 'EOI') break
    instBags.push({ start: view.getUint16(o + 20, true), end: 0 })
  }
  for (let i = 0; i < instBags.length; i++) {
    instBags[i].end = i + 1 < instBags.length ? instBags[i + 1].start : Math.floor((ibag.end - ibag.start) / 4)
  }
  const instZones = instBags.map((b) => readZones(view, igen, ibag, b.start, b.end, 53))

  // preset zones
  const presets: Sf2PresetInfo[] = []
  const phCount = Math.floor((phdr.end - phdr.start) / 38)
  const presetsRaw: { name: string; program: number; bank: number; bagStart: number; bagEnd: number }[] = []
  for (let i = 0; i < phCount; i++) {
    const o = phdr.start + i * 38
    const name = ascii(view, o, 20)
    if (name === 'EOP') break
    presetsRaw.push({
      name,
      program: view.getUint16(o + 20, true),
      bank: view.getUint16(o + 22, true),
      bagStart: view.getUint16(o + 24, true),
      bagEnd: 0,
    })
  }
  for (let i = 0; i < presetsRaw.length; i++) {
    presetsRaw[i].bagEnd = i + 1 < presetsRaw.length ? presetsRaw[i + 1].bagStart : Math.floor((pbag.end - pbag.start) / 4)
  }

  for (let pi = 0; pi < presetsRaw.length; pi++) {
    const p = presetsRaw[pi]
    const pzones = readZones(view, pgen, pbag, p.bagStart, p.bagEnd, 41)
    const zones: Sf2ZoneInfo[] = []
    for (const pz of pzones) {
      const instIdx = pz.terminal
      if (instIdx < 0 || instIdx >= instZones.length) continue
      const pr = genRange(pz.gens, 43)
      const pv = genRange(pz.gens, 44)
      for (const iz of instZones[instIdx]) {
        const si = iz.terminal
        const sample = samples[si]
        if (!sample) continue
        const ir = genRange(iz.gens, 43)
        const iv = genRange(iz.gens, 44)
        // preset 和 instrument 的音域/力度取交集
        const keyLow = Math.max(pr?.[0] ?? 0, ir?.[0] ?? 0)
        const keyHigh = Math.min(pr?.[1] ?? 127, ir?.[1] ?? 127)
        const velLow = Math.max(pv?.[0] ?? 0, iv?.[0] ?? 0)
        const velHigh = Math.min(pv?.[1] ?? 127, iv?.[1] ?? 127)
        if (keyLow > keyHigh || velLow > velHigh) continue
        const rootGen = genNum(iz.gens, 58, -1)
        const rootKey = rootGen >= 0 ? rootGen : sample.originalPitch
        zones.push({
          sampleIndex: si,
          keyLow,
          keyHigh,
          velLow,
          velHigh,
          rootKey: rootKey > 0 && rootKey < 128 ? rootKey : 60,
          coarseTune: genNum(pz.gens, 51) + genNum(iz.gens, 51),
          // sample 头里的 pitchCorrection 是音分，直接并进细调
          fineTune: genNum(pz.gens, 52) + genNum(iz.gens, 52) + sample.pitchCorrection,
          attenuation: genNum(pz.gens, 48) + genNum(iz.gens, 48),
        })
      }
    }
    presets.push({
      index: pi,
      name: p.name || `Preset ${pi}`,
      bank: p.bank,
      program: p.program,
      zones,
    })
  }

  return {
    kind,
    presets,
    samples,
    smpl: new Uint8Array(buf, smpl.start, smpl.end - smpl.start),
  }
}

export interface PickPresetOptions {
  bank: number
  preset: number
  program: number
  percussion: boolean
}

/** 按 bank/program/preset 选 preset；找不到就退到同 bank 的第一个 / 文件第一个 */
export function pickPreset(
  file: Sf2File,
  opts: PickPresetOptions,
): { preset: Sf2PresetInfo | null; warning?: string } {
  if (!file.presets.length) return { preset: null, warning: '音色库里没有 preset' }
  const bank = opts.percussion ? 128 : opts.bank
  const program = opts.program
  let p =
    file.presets.find((x) => x.bank === bank && x.program === program) ||
    (opts.preset !== program ? file.presets.find((x) => x.bank === bank && x.program === opts.preset) : null)
  if (!p && bank !== opts.bank) p = file.presets.find((x) => x.bank === opts.bank && x.program === program)
  if (!p) p = file.presets.find((x) => x.bank === bank)
  if (!p && opts.preset >= 0 && opts.preset < file.presets.length) p = file.presets[opts.preset]
  if (!p) p = file.presets[0]
  const warning =
    p && (p.bank !== bank || p.program !== program)
      ? `没找到 bank ${bank} / program ${program}，改用 "${p.name}"（bank ${p.bank} / program ${p.program}）`
      : undefined
  return { preset: p, warning }
}

/** 每个 MIDI 音高挑一个 zone（力度按 100 算；重叠时取第一个） */
export function keyZones(preset: Sf2PresetInfo, velocity = 100): Map<number, Sf2ZoneInfo> {
  const out = new Map<number, Sf2ZoneInfo>()
  for (const z of preset.zones) {
    if (velocity < z.velLow || velocity > z.velHigh) continue
    for (let k = z.keyLow; k <= z.keyHigh; k++) if (!out.has(k)) out.set(k, z)
  }
  return out
}

/** 取出一个 sample 的音频字节（SF2 = 16-bit PCM，SF3 = Ogg Vorbis 流） */
export function sampleBytes(file: Sf2File, sample: Sf2SampleInfo): Uint8Array | null {
  const start = sample.start
  const end = sample.end
  if (file.kind === 'sf3') {
    if (start < 0 || end > file.smpl.length || end <= start) return null
    return file.smpl.subarray(start, end)
  }
  const b0 = start * 2
  const b1 = end * 2
  if (b0 < 0 || b1 > file.smpl.length || b1 <= b0) return null
  return file.smpl.subarray(b0, b1)
}

/** SF2 PCM → Float32（mono；立体声 sample 取左声道） */
export function pcmToFloat(bytes: Uint8Array): Float32Array {
  const frames = Math.floor(bytes.length / 2)
  const out = new Float32Array(frames)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < frames; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}
