/**
 * 最小 Standard MIDI File 解析（只取「音符 + 时间」）。
 *
 * 编辑器需要的是：每个音符的音高、起始/结束毫秒、力度、通道与所在音轨，
 * 用来往 [Keysound] 里铺音符。因此这里不碰控制器曲线、歌词、SysEx 等，
 * 只实现这部分：
 *
 *   - MThd：format 0/1/2、PPQ（每四分音符多少 tick）、SMPTE 时基；
 *   - MTrk：VLQ 增量时间、running status、meta（速度 / 拍号 / 轨道名 / 结束）、
 *     通道事件 note on/off、program change；
 *   - 速度表：任一轨道里的 tempo（0x51）都收进来，按 tick 排好后换算毫秒。
 *     format 1 的速度一般只在第 0 轨，format 0 全在唯一一轨，两种都能处理。
 *
 * 解析失败（不是 MIDI、截断、没有轨道）直接抛 Error，由调用方转成界面提示。
 */

export interface MidiNote {
  /** MIDI 音高 0~127 */
  pitch: number
  /** 起始毫秒（从文件开头算） */
  start: number
  /** 结束毫秒；没有配对 note off 时取轨道结尾 */
  end: number
  /** 力度 1~127 */
  velocity: number
  /** 通道 0~15 */
  channel: number
}

export interface MidiTrack {
  index: number
  name: string
  notes: MidiNote[]
  /** 这条轨道用到的通道（去重、升序） */
  channels: number[]
  /** 出现过的 program（音色号，0~127） */
  programs: number[]
  /** 是否含打击乐通道（通道 10，界面从 1 数就是 10） */
  percussion: boolean
  /** 轨道里的拍号（第一条，形如 "4/4"）；没有就是空串 */
  timeSignature: string
}

export interface MidiTempoPoint {
  /** 毫秒位置 */
  ms: number
  /** 每分钟拍数（四分音符） */
  bpm: number
}

export interface MidiFile {
  /** 0 / 1 / 2 */
  format: number
  /** 每四分音符的 tick 数（SMPTE 时基下为 0） */
  ppq: number
  /** SMPTE 时基；PPQ 时为 null */
  smpte: { fps: number; ticksPerFrame: number } | null
  tracks: MidiTrack[]
  tempo: MidiTempoPoint[]
  /** 最后一个音符的结束时间（没有任何音符时取 0） */
  durationMs: number
  /** 不致命的问题（跳过了什么、哪里截断了） */
  warnings: string[]
}

interface RawNote {
  pitch: number
  startTick: number
  endTick: number
  velocity: number
  channel: number
}

const DEFAULT_TEMPO = 500000 // 120 BPM，单位 µs / 四分音符

class Reader {
  pos = 0
  constructor(
    readonly data: Uint8Array,
    readonly label = 'MIDI',
  ) {}

  get left() {
    return this.data.length - this.pos
  }

  need(n: number) {
    if (this.pos + n > this.data.length) throw new Error(`${this.label} 数据不完整（还差 ${this.pos + n - this.data.length} 字节）`)
  }

  u8(): number {
    this.need(1)
    return this.data[this.pos++]
  }

  u16(): number {
    this.need(2)
    const v = (this.data[this.pos] << 8) | this.data[this.pos + 1]
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v =
      ((this.data[this.pos] << 24) | (this.data[this.pos + 1] << 16) | (this.data[this.pos + 2] << 8) | this.data[this.pos + 3]) >>> 0
    this.pos += 4
    return v
  }

  /** 变长整数（每个字节 7 位，最高位表示还有后续） */
  varLen(): number {
    let v = 0
    for (let i = 0; i < 4; i++) {
      const b = this.u8()
      v = (v << 7) | (b & 0x7f)
      if (!(b & 0x80)) return v
    }
    throw new Error('MIDI 的变长整数超过 4 字节（文件可能损坏）')
  }

  ascii(n: number): string {
    this.need(n)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.data[this.pos + i])
    this.pos += n
    return s
  }

  slice(n: number): Uint8Array {
    this.need(n)
    const out = this.data.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}

interface TempoEvent {
  tick: number
  us: number
}

interface TrackParse {
  name: string
  notes: RawNote[]
  channels: Set<number>
  programs: Set<number>
  timeSignature: string
  /** 轨道最后一个事件的 tick（给没配对的音符收尾） */
  lastTick: number
}

function parseTrack(data: Uint8Array, index: number, tempos: TempoEvent[], warnings: string[]): TrackParse {
  const r = new Reader(data, `第 ${index + 1} 轨`)
  const notes: RawNote[] = []
  const channels = new Set<number>()
  const programs = new Set<number>()
  const open = new Map<number, RawNote[]>()
  let name = ''
  let timeSignature = ''
  let tick = 0
  let lastTick = 0
  /** 上一个通道状态字节（running status） */
  let running = 0

  const close = (key: number, ch: number, pitch: number, atTick: number) => {
    const list = open.get(key)
    if (!list || !list.length) {
      warnings.push(`第 ${index + 1} 轨：通道 ${ch + 1} 的音高 ${pitch} 有 note off 但没有对应的 note on（已忽略）`)
      return
    }
    const n = list.shift()!
    n.endTick = Math.max(atTick, n.startTick)
    notes.push(n)
    if (!list.length) open.delete(key)
  }

  while (r.left > 0) {
    const delta = r.varLen()
    tick += delta
    lastTick = Math.max(lastTick, tick)
    let b = r.u8()

    // 运行状态：数据字节直接复用上一个状态
    if (!(b & 0x80)) {
      if (!running) throw new Error(`第 ${index + 1} 轨在 ${tick} tick 处出现数据字节但没有状态（running status 丢失）`)
      r.pos--
      b = running
    } else if (b < 0xf0) {
      running = b
    }

    if (b === 0xff) {
      // meta：类型 + 长度 + 数据
      running = 0
      const type = r.u8()
      const len = r.varLen()
      const body = r.slice(len)
      if (type === 0x03 && !name) name = new TextDecoder().decode(body).trim()
      else if (type === 0x51 && len >= 3) {
        const us = (body[0] << 16) | (body[1] << 8) | body[2]
        if (us > 0) tempos.push({ tick, us })
      } else if (type === 0x58 && len >= 2) {
        if (!timeSignature) timeSignature = `${body[0]}/${Math.pow(2, body[1])}`
      } else if (type === 0x2f) {
        break
      }
      continue
    }

    if (b === 0xf0 || b === 0xf7) {
      // SysEx：长度 + 数据，直接跳过
      running = 0
      const len = r.varLen()
      r.slice(len)
      continue
    }

    if (b >= 0xf1) {
      // 其它系统消息（MTC / 歌曲位置 / 选歌 / 调音请求 / 时钟…）：按长度跳过
      running = 0
      if (b === 0xf2) r.u8(), r.u8()
      else if (b === 0xf1 || b === 0xf3) r.u8()
      // 0xf6 / 0xf8~0xfe 没有数据字节
      continue
    }

    const type = b & 0xf0
    const ch = b & 0x0f
    channels.add(ch)
    switch (type) {
      case 0x80: {
        const pitch = r.u8()
        r.u8() // velocity
        close(ch * 128 + pitch, ch, pitch, tick)
        break
      }
      case 0x90: {
        const pitch = r.u8()
        const vel = r.u8()
        if (vel > 0) {
          const note: RawNote = { pitch, startTick: tick, endTick: tick, velocity: vel, channel: ch }
          const key = ch * 128 + pitch
          const list = open.get(key)
          if (list) list.push(note)
          else open.set(key, [note])
        } else {
          close(ch * 128 + pitch, ch, pitch, tick)
        }
        break
      }
      case 0xa0:
        r.u8()
        r.u8()
        break
      case 0xb0:
        r.u8()
        r.u8()
        break
      case 0xc0:
        programs.add(r.u8())
        break
      case 0xd0:
        r.u8()
        break
      case 0xe0:
        r.u8()
        r.u8()
        break
      default:
        throw new Error(`第 ${index + 1} 轨在 ${tick} tick 处出现无法识别的状态字节 0x${b.toString(16)}`)
    }
  }

  // 没等到 note off 的音符：收在轨道结尾，别丢掉
  const pending: RawNote[] = []
  for (const list of open.values()) {
    for (const n of list) {
      n.endTick = Math.max(lastTick, n.startTick)
      pending.push(n)
    }
  }
  open.clear()
  return {
    name,
    notes: notes.concat(pending),
    channels,
    programs,
    timeSignature,
    lastTick,
  }
}

/** tick → 毫秒的换算器（速度表按 tick 排好） */
function makeTickToMs(ppq: number, smpte: { fps: number; ticksPerFrame: number } | null, tempos: TempoEvent[]) {
  if (smpte) {
    const perTick = 1000 / (smpte.fps * smpte.ticksPerFrame)
    return (tick: number) => tick * perTick
  }
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick)
  // 同一 tick 上出现多条时后一条生效（常见于格式转换留下的重复）
  const list: TempoEvent[] = []
  for (const t of sorted) {
    if (list.length && list[list.length - 1].tick === t.tick) list[list.length - 1] = t
    else list.push(t)
  }
  const segs: { tick: number; ms: number; us: number }[] = []
  let ms = 0
  let lastTick = 0
  let us = DEFAULT_TEMPO
  if (!list.length || list[0].tick > 0) segs.push({ tick: 0, ms: 0, us })
  for (const t of list) {
    ms += ((t.tick - lastTick) * us) / ppq / 1000
    lastTick = t.tick
    us = t.us
    segs.push({ tick: t.tick, ms, us })
  }
  return (tick: number) => {
    let seg = segs[0]
    for (const s of segs) {
      if (s.tick <= tick) seg = s
      else break
    }
    return seg.ms + ((tick - seg.tick) * seg.us) / ppq / 1000
  }
}

/**
 * 解析 MIDI 字节。
 * @throws 不是 SMF、没有轨道、或某条轨道结构损坏时抛错
 */
export function parseMidi(input: ArrayBuffer | Uint8Array): MidiFile {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (data.length < 14) throw new Error('文件太短，不是 MIDI')
  const r = new Reader(data)
  const magic = r.ascii(4)
  if (magic !== 'MThd') throw new Error('不是 MIDI 文件（缺少 MThd 头）')
  const headerLen = r.u32()
  if (headerLen < 6) throw new Error('MIDI 头长度异常')
  const headerEnd = r.pos + headerLen
  const format = r.u16()
  const trackCount = r.u16()
  const division = r.u16()
  r.pos = Math.min(headerEnd, data.length)

  let ppq = 0
  let smpte: { fps: number; ticksPerFrame: number } | null = null
  if (division & 0x8000) {
    // SMPTE：高字节是负的帧率，低字节是每帧 tick
    const fps = 256 - ((division >> 8) & 0xff)
    const ticksPerFrame = division & 0xff
    if (!fps || !ticksPerFrame) throw new Error('MIDI 的 SMPTE 时基不合法')
    smpte = { fps, ticksPerFrame }
  } else {
    ppq = division
    if (!ppq) throw new Error('MIDI 的时基为 0（每四分音符 tick 数不合法）')
  }

  const tracks: MidiTrack[] = []
  const tempos: TempoEvent[] = []
  const warnings: string[] = []
  const parsed: TrackParse[] = []
  /** 头里声明 0 条轨道时一直读到文件结束（有些导出器会写 0） */
  const limit = trackCount > 0 ? trackCount : Number.POSITIVE_INFINITY

  while (r.left >= 8 && parsed.length < limit) {
    const id = r.ascii(4)
    const len = r.u32()
    if (id !== 'MTrk') {
      // 未知块：跳过（RIFF 包装、厂商块都可能出现）
      r.slice(Math.min(len, r.left))
      continue
    }
    const body = r.slice(Math.min(len, r.left))
    if (len > body.length) warnings.push(`第 ${parsed.length + 1} 轨被截断（声明 ${len} 字节，实际 ${body.length}）`)
    try {
      parsed.push(parseTrack(body, parsed.length, tempos, warnings))
    } catch (e) {
      warnings.push(`${e instanceof Error ? e.message : String(e)}（这一轨已跳过）`)
    }
  }

  if (!parsed.length) throw new Error('MIDI 里没有可读的音轨')

  const toMs = makeTickToMs(ppq, smpte, tempos)
  let duration = 0
  parsed.forEach((tp, i) => {
    const notes: MidiNote[] = tp.notes
      .map((n) => ({
        pitch: n.pitch,
        start: toMs(n.startTick),
        end: toMs(n.endTick),
        velocity: n.velocity,
        channel: n.channel,
      }))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    for (const n of notes) duration = Math.max(duration, n.end)
    tracks.push({
      index: i,
      name: tp.name || `轨道 ${i + 1}`,
      notes,
      channels: [...tp.channels].sort((a, b) => a - b),
      programs: [...tp.programs].sort((a, b) => a - b),
      percussion: tp.channels.has(9),
      timeSignature: tp.timeSignature,
    })
  })

  const tempo: MidiTempoPoint[] = []
  const sortedTempo = [...tempos].sort((a, b) => a.tick - b.tick)
  for (const t of sortedTempo) tempo.push({ ms: toMs(t.tick), bpm: 60000000 / t.us })
  if (!tempo.length) tempo.push({ ms: 0, bpm: 120 })

  return {
    format,
    ppq,
    smpte,
    tracks: tracks.filter((t) => t.notes.length > 0),
    tempo,
    durationMs: duration,
    warnings,
  }
}

/** 给界面用：一句话概括 MIDI 文件 */
export function describeMidi(m: MidiFile): string {
  const total = m.tracks.reduce((n, t) => n + t.notes.length, 0)
  const base = m.smpte
    ? `SMPTE ${m.smpte.fps}fps × ${m.smpte.ticksPerFrame}`
    : `${m.ppq} tick / 四分音符`
  return `format ${m.format} · ${base} · ${m.tracks.length} 条有音符的轨道 · 共 ${total} 个音符`
}
