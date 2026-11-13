import type { ChartDoc, NoteEvent } from '../core/types'
import { measureBeatTimes } from '../core/measures'
import { deleteSample, getSample, putSample } from './sampleDb'
import { decodeImaAdpcmWav } from './wav'
import { freqOf } from '../core/pitch'
import { keySampleName } from '../core/keysound'
import type { KeyLayoutEntry } from './keyLayout'

export interface BindingInfo {
  name: string
  fileName: string
  size: number
  /** 由「按 [Files] 自动载入」匹配来的，刷新后需要重新选目录 */
  auto?: boolean
}

type Listener = () => void

/** 音量设置的本地持久化键 */
const VOL_KEY = 'hss.vol.'
function loadVol(name: string, def: number): number {
  try {
    if (typeof localStorage === 'undefined') return def
    const raw = localStorage.getItem(VOL_KEY + name)
    if (raw === null) return def
    const v = Number(raw)
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : def
  } catch {
    return def
  }
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
}

function saveVol(name: string, v: number) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(VOL_KEY + name, String(v))
  } catch {
    /* 无痕模式等写不进去也不影响使用 */
  }
}

class AudioEngine {
  ctx: AudioContext | null = null
  private master!: GainNode
  /** 音效总线：hitsound / keysound 都走这里 */
  private sfxBus!: GainNode
  /** 节拍器总线 */
  private metroBus!: GainNode
  /** 音乐总线：<audio> 经 MediaElementSource 进来 */
  private songBus!: GainNode
  private songSrc: MediaElementAudioSourceNode | null = null
  songEl: HTMLAudioElement | null = null
  private songUrl: string | null = null
  private buffers = new Map<string, AudioBuffer>()
  /** 音效名 -> default.xxx 的引用名（如 D -> normal-hitnormal） */
  private defaultMap = new Map<string, string>()
  /** 内置官方默认音效，按引用名缓存 */
  private defaultBuffers = new Map<string, AudioBuffer>()
  /** 正在下载/解码的内置默认音效：同一份只加载一次，试听要能等它 */
  private defaultLoading = new Map<string, Promise<void>>()
  private events: NoteEvent[] = []
  private beats: number[] = []
  private timer: number | null = null
  private scheduledUntil = 0
  private startCtxTime = 0
  private startMediaMs = 0
  private listeners: Listener[] = []

  songName = ''
  playing = false
  rate = 1
  /** 总音量：所有声音最后都要过这一级 */
  masterVolume = loadVol('master', 0.8)
  /** 音乐音量（歌曲） */
  songVolume = loadVol('song', 0.7)
  /** 音效音量（hitsound / keysound） */
  hitsoundVolume = loadVol('sfx', 0.9)
  /** 节拍器音量 */
  metronomeVolume = loadVol('metro', 0.6)
  /** 静音：只是把总音量压到 0，原值保留 */
  muted = loadVol('muted', 0) === 1
  /** 分通道静音：各自把总线增益压到 0，音量原值保留 */
  songMuted = loadVol('mutedSong', 0) === 1
  hitsoundMuted = loadVol('mutedSfx', 0) === 1
  metronomeMuted = loadVol('mutedMetro', 0) === 1
  metronome = false
  loop = false
  /** keysound 找不到该音高的真实样本时，用内置合成音（按真实频率）发声 */
  synthFallback = true
  /** keysound 乐器 → 每个 MIDI 音高用哪个 buffer / 变调 / 增益（音色库与单文件用） */
  private keyLayouts = new Map<string, Map<number, KeyLayoutEntry>>()
  /** 各 keysound 乐器的调律偏移（音分），影响合成音频率与样本变调 */
  private keyTune = new Map<string, number>()
  /** 无音频时的虚拟播放头（毫秒） */
  private virtualMs = 0

  subscribe(fn: Listener) {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn)
    }
  }
  private emit() {
    this.listeners.forEach((f) => f())
  }

  ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : this.masterVolume
      this.master.connect(this.ctx.destination)
      // 三条独立总线：音效 / 节拍器 / 音乐，最后统一汇总到总音量
      this.sfxBus = this.ctx.createGain()
      this.sfxBus.gain.value = this.hitsoundMuted ? 0 : this.hitsoundVolume
      this.sfxBus.connect(this.master)
      this.metroBus = this.ctx.createGain()
      this.metroBus.gain.value = this.metronomeMuted ? 0 : this.metronomeVolume
      this.metroBus.connect(this.master)
      this.songBus = this.ctx.createGain()
      this.songBus.gain.value = this.songMuted ? 0 : this.songVolume
      this.songBus.connect(this.master)
      this.routeSong()
    }
    return this.ctx
  }

  /**
   * 把 <audio> 接进音频图，这样"总音量"也能管到音乐。
   * MediaElementAudioSourceNode 每个元素只能建一次，所以做缓存。
   */
  private routeSong() {
    if (!this.ctx || !this.songEl || this.songSrc) return
    try {
      this.songSrc = this.ctx.createMediaElementSource(this.songEl)
      this.songSrc.connect(this.songBus)
      // 音量交给总线，元素本身保持在 1，避免两级相乘
      this.songEl.volume = 1
    } catch {
      // 建不了就退回用元素自带音量
      this.songSrc = null
      this.songEl.volume = this.songMuted ? 0 : this.songVolume
    }
  }

  /** 供"单独试播歌曲"这类绕过 play() 的场景先唤醒音频图 */
  resume() {
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
  }

  get hasSong() {
    return !!this.songEl
  }

  get durationMs() {
    if (this.songEl && Number.isFinite(this.songEl.duration)) return this.songEl.duration * 1000
    const last = this.events[this.events.length - 1]
    return last ? last.time + 3000 : 60000
  }

  setEvents(doc: ChartDoc) {
    this.events = doc.events
    const beats: number[] = []
    for (const m of doc.measures) beats.push(...measureBeatTimes(m))
    this.beats = beats.sort((a, b) => a - b)
  }

  songError = ''

  async loadSong(file: File) {
    if (this.songUrl) URL.revokeObjectURL(this.songUrl)
    this.songUrl = URL.createObjectURL(file)
    if (!this.songEl) {
      this.songEl = new Audio()
      // 有些环境（企业策略 / 部分声卡驱动）下脱离文档树的 <audio> 不出声，挂上去更稳
      this.songEl.style.display = 'none'
      document.body.appendChild(this.songEl)
    }
    this.songError = ''
    this.songEl.preload = 'auto'
    this.songEl.src = this.songUrl
    this.songEl.muted = false
    // 先建好音频图，让音乐走 songBus（受"音乐音量"和"总音量"共同控制）
    this.ensureCtx()
    this.routeSong()
    this.songEl.playbackRate = this.rate
    this.songName = file.name
    this.songEl.onerror = () => {
      const e = this.songEl?.error
      this.songError = e
        ? `音频解码失败（code ${e.code}：${e.message || '浏览器不支持该编码'}）`
        : '音频载入失败'
      this.emit()
    }
    this.songEl.onended = () => {
      if (!this.loop) {
        this.pause()
        this.emit()
      }
    }
    this.emit()
  }

  clearSong() {
    this.pause()
    if (this.songEl) {
      this.songEl.pause()
      this.songEl.src = ''
      this.songEl.remove()
    }
    if (this.songUrl) URL.revokeObjectURL(this.songUrl)
    this.songUrl = null
    this.songEl = null
    this.songName = ''
    this.songError = ''
    this.emit()
  }

  /**
   * 绑定一个音效文件。
   * @param persist 是否写入 IndexedDB（自动按路径匹配来的不写，避免撑爆存储）
   */
  /**
   * 解码一段音频。
   *
   * Chromium 的 `decodeAudioData` 不支持 IMA ADPCM 的 WAV（osu! 谱面目录里
   * 不少老音效是这种 4-bit 格式）。这类文件以前会整段静音：自动加载时
   * 静默少绑几个样本、点格子也没有声音。这里自己解成 Float32 兜底。
   */
  private async decodeAny(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureCtx()
    try {
      return await ctx.decodeAudioData(data.slice(0))
    } catch (err) {
      const pcm = decodeImaAdpcmWav(data)
      if (!pcm || !pcm.frames) throw err
      const buf = ctx.createBuffer(pcm.channels, pcm.frames, pcm.sampleRate)
      for (let c = 0; c < pcm.channels; c++) buf.getChannelData(c).set(pcm.data[c])
      return buf
    }
  }

  /** 直接放入一个已解码的 AudioBuffer（音色库 / sfz 样本用，不写持久化） */
  bindBuffer(name: string, buffer: AudioBuffer) {
    this.ensureCtx()
    this.buffers.set(name, buffer)
    this.emit()
  }

  /** 解码一段音频字节（Ogg / Wav / MP3）；音色库里的样本用 */
  async decodeBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
    this.ensureCtx()
    return this.decodeAny(data)
  }

  /** 用 PCM 浮点数据建 AudioBuffer（SF2 的 16-bit 样本用） */
  pcmBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
    const ctx = this.ensureCtx()
    const frames = Math.max(1, channels[0]?.length ?? 1)
    const buf = ctx.createBuffer(Math.max(1, channels.length), frames, sampleRate)
    for (let c = 0; c < channels.length; c++) buf.getChannelData(c).set(channels[c])
    return buf
  }

  /**
   * 设置某个 keysound 乐器的按键布局。
   * `scheduleKeySample` 会优先查这张表；表里没有的音高再退回 `ks:乐器#音高`。
   */
  setKeyLayout(instrument: string, map: Map<number, KeyLayoutEntry>) {
    if (map.size) this.keyLayouts.set(instrument, map)
    else this.keyLayouts.delete(instrument)
    this.emit()
  }

  clearKeyLayouts() {
    this.keyLayouts.clear()
  }

  async bindSample(name: string, file: File, persist = true) {
    this.ensureCtx()
    const buf = await file.arrayBuffer()
    const decoded = await this.decodeAny(buf)
    this.buffers.set(name, decoded)
    if (persist) await putSample(name, new Blob([buf], { type: file.type || 'audio/wav' }))
    this.persisted.add(name)
    this.emit()
    return decoded
  }

  /** 该音效是否来自 IndexedDB（刷新后还能自动恢复） */
  private persisted = new Set<string>()
  isPersisted(name: string) {
    return this.persisted.has(name)
  }

  async clearSample(name: string) {
    this.buffers.delete(name)
    this.persisted.delete(name)
    await deleteSample(name)
    this.emit()
  }

  /**
   * 清空所有已解码的音效样本（不动 IndexedDB 里的持久化副本）。
   *
   * 切换谱面时用：上一份谱的音效样本如果不清掉，会继续在当前谱里发声，
   * 造成「切了谱但音效还是上一份的」。
   */
  unbindAll() {
    if (!this.buffers.size && !this.persisted.size && !this.keyLayouts.size) return
    this.buffers.clear()
    this.persisted.clear()
    this.keyLayouts.clear()
    this.emit()
  }

  /** 当前已解码的样本名（调试 / 面板展示用） */
  boundSampleNames(): string[] {
    return [...this.buffers.keys()]
  }

  /** 音效的解码信息，用于确认「真的加载进来了」 */
  sampleInfo(name: string) {
    const b = this.bufferFor(name)
    if (!b) return null
    return {
      duration: b.duration,
      channels: b.numberOfChannels,
      sampleRate: b.sampleRate,
      builtin: !this.buffers.has(name),
    }
  }

  async loadPersisted(names: string[]) {
    for (const n of names) {
      try {
        const blob = await getSample(n)
        if (!blob) continue
        const ab = await blob.arrayBuffer()
        const decoded = await this.decodeAny(ab)
        this.buffers.set(n, decoded)
        this.persisted.add(n)
      } catch {
        /* 忽略无法解码的文件 */
      }
    }
    this.emit()
  }

  hasSample(name: string) {
    return this.buffers.has(name)
  }

  /** 设置「音效名 -> default.xxx」的映射，并预加载内置默认音效 */
  setDefaultMap(map: Record<string, string>) {
    this.defaultMap = new Map(Object.entries(map))
    for (const ref of new Set(this.defaultMap.values())) this.loadDefault(ref)
  }

  private loadDefault(ref: string): Promise<void> {
    if (this.defaultBuffers.has(ref)) return Promise.resolve()
    // blank 是官方的 44 字节静音文件，不需要发声
    if (!ref || ref === 'blank') return Promise.resolve()
    const pending = this.defaultLoading.get(ref)
    if (pending) return pending
    const base = (import.meta as any).env?.BASE_URL || '/'
    const p = fetch(`${base}osudefaulthitsound/default.${ref}.wav`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('404'))))
      .then((ab) => this.ensureCtx().decodeAudioData(ab))
      .then((buf) => {
        this.defaultBuffers.set(ref, buf)
        this.emit()
      })
      .catch(() => {
        /* 404 / 解码失败：下次再试 */
      })
      .finally(() => {
        this.defaultLoading.delete(ref)
      })
    this.defaultLoading.set(ref, p)
    return p
  }

  /** 该音效名是否可发声（自己绑定的，或能用内置默认音效） */
  hasSound(name: string) {
    if (this.buffers.has(name)) return true
    const ref = this.defaultMap.get(name)
    if (!ref) return false
    return !!this.defaultBuffers.get(ref)
  }

  bufferFor(name: string): AudioBuffer | null {
    return this.buffers.get(name) || this.defaultBuffers.get(this.defaultMap.get(name) || '') || null
  }

  sampleNames() {
    return [...this.buffers.keys()]
  }

  /**
   * 试听一个磁盘上的音频文件：解码后直接播一次，不绑定成样本、也不进 IndexedDB。
   * 音效库的 ▶ 用这个（选了一堆文件不至于把样本表塞满）。
   */
  async previewFile(file: File, volume = 100): Promise<boolean> {
    try {
      const ctx = this.ensureCtx()
      const buf = await this.decodeAny(await file.arrayBuffer())
      if (ctx.state === 'suspended') void ctx.resume()
      const src = ctx.createBufferSource()
      src.buffer = buf
      const g = ctx.createGain()
      g.gain.value = Math.max(0, Math.min(1.5, volume / 100))
      src.connect(g)
      g.connect(this.sfxBus)
      src.start(ctx.currentTime + 0.001)
      return true
    } catch {
      return false
    }
  }

  /**
   * 试听**内置默认音效**（音效库下半层的 ▶）：按引用名加载 public 里的 wav，
   * 不绑定到任何代号、也不进 IndexedDB。
   */
  async previewDefault(ref: string, volume = 100): Promise<boolean> {
    if (!ref) return false
    // blank 是官方静音文件：点下去本来就该没声音
    if (ref === 'blank') return true
    await this.loadDefault(ref)
    const buf = this.defaultBuffers.get(ref)
    if (!buf) return false
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') void ctx.resume()
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    g.gain.value = Math.max(0, Math.min(1.5, volume / 100))
    src.connect(g)
    g.connect(this.sfxBus)
    src.start(ctx.currentTime + 0.001)
    return true
  }

  playSample(name: string, volume = 100) {
    const ctx = this.ensureCtx()
    const buf = this.bufferFor(name)
    if (!buf) return false
    if (ctx.state === 'suspended') ctx.resume()
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    g.gain.value = Math.max(0, Math.min(1.5, volume / 100))
    src.connect(g)
    g.connect(this.sfxBus)
    src.start(ctx.currentTime + 0.001)
    return true
  }

  /** 记录每个 keysound 乐器的调律（音分） */
  setKeyTune(map: Record<string, number>) {
    this.keyTune = new Map(Object.entries(map).filter(([, v]) => Number.isFinite(v)))
  }

  setSynthFallback(v: boolean) {
    this.synthFallback = v
    this.emit()
  }

  /** 某个音高有没有真实样本 */
  hasKeySample(instrument: string | undefined, midi: number): boolean {
    if (!instrument) return false
    const layout = this.keyLayouts.get(instrument)?.get(midi)
    if (layout) return !!this.buffers.get(layout.buffer)
    return !!this.bufferFor(keySampleName(instrument, midi))
  }

  /**
   * 按 MIDI 音高发声：优先用该乐器这个音高的真实样本，
   * 没有样本且开了合成兜底时，用振荡器按真实频率发声。
   */
  playKey(instrument: string | undefined, midi: number, volume = 100, durationMs = 0, tuneCents?: number): boolean {
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') ctx.resume()
    const when = ctx.currentTime + 0.001
    const tune = tuneCents ?? (instrument ? this.keyTune.get(instrument) ?? 0 : 0)
    if (!this.scheduleKeySample(instrument, midi, when, volume, tune)) {
      if (!this.synthFallback) return false
      this.scheduleTone(freqOf(midi, tune), when, durationMs, volume)
      return true
    }
    return true
  }

  /** 有真实样本就排期播放，返回是否命中 */
  private scheduleKeySample(
    instrument: string | undefined,
    midi: number,
    when: number,
    volume: number,
    tuneCents: number,
  ): boolean {
    if (!instrument) return false
    const layout = this.keyLayouts.get(instrument)?.get(midi)
    const name = layout ? layout.buffer : keySampleName(instrument, midi)
    const buf = layout ? this.buffers.get(name) : this.bufferFor(name)
    if (!buf) return false
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = buf
    // 音色库/单文件自带根音变调；再叠加乐器调律（音分）
    let rate = layout?.rate ?? 1
    if (tuneCents) rate *= Math.pow(2, tuneCents / 1200)
    if (rate !== 1) src.playbackRate.value = rate
    const g = ctx.createGain()
    const base = (volume / 100) * (layout?.gain ?? 1)
    g.gain.value = Math.max(0, Math.min(4, base))
    src.connect(g)
    g.connect(this.sfxBus)
    src.start(Math.max(when, ctx.currentTime))
    return true
  }

  /** 内置合成音：三角波主音 + 轻微包络，够听出旋律走向 */
  private scheduleTone(freq: number, when: number, durationMs: number, volume: number) {
    const ctx = this.ctx!
    const t0 = Math.max(when, ctx.currentTime)
    const sustain = Math.max(0.18, Math.min(2.2, (Number.isFinite(durationMs) ? durationMs : 300) / 1000))
    const peak = Math.max(0.0002, Math.min(0.5, (volume / 100) * 0.45))
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.value = freq
    const o2 = ctx.createOscillator()
    o2.type = 'sine'
    o2.frequency.value = freq * 2
    const g = ctx.createGain()
    const g2 = ctx.createGain()
    g2.gain.value = 0.18
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + sustain)
    o.connect(g)
    o2.connect(g2)
    g2.connect(g)
    g.connect(this.sfxBus)
    o.start(t0)
    o2.start(t0)
    o.stop(t0 + sustain + 0.05)
    o2.stop(t0 + sustain + 0.05)
  }

  click(accent = false) {
    const ctx = this.ensureCtx()
    const when = ctx.currentTime + 0.001
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = accent ? 1600 : 1050
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.18, when + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    o.connect(g)
    g.connect(this.metroBus)
    o.start(when)
    o.stop(when + 0.07)
  }

  nowMs(): number {
    if (this.songEl) return this.songEl.currentTime * 1000
    if (this.playing) {
      const ctx = this.ensureCtx()
      return this.startMediaMs + (ctx.currentTime - this.startCtxTime) * 1000 * this.rate
    }
    return this.virtualMs
  }

  play() {
    this.ensureCtx()
    if (this.ctx!.state === 'suspended') this.ctx!.resume()
    if (this.songEl) {
      this.songEl.playbackRate = this.rate
      this.songEl.play().catch((e) => {
        this.songError = `无法播放：${e?.message || e}（点一下页面再试，或换 mp3/wav）`
        this.pause()
        this.emit()
      })
    } else {
      this.startCtxTime = this.ctx!.currentTime
      this.startMediaMs = this.virtualMs
    }
    this.playing = true
    this.scheduledUntil = this.nowMs()
    this.timer = window.setInterval(() => this.tick(), 25)
    this.emit()
  }

  pause() {
    if (this.songEl) this.songEl.pause()
    else this.virtualMs = this.nowMs()
    this.playing = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.emit()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(ms: number) {
    const t = Math.max(0, ms)
    if (this.songEl) this.songEl.currentTime = t / 1000
    this.virtualMs = t
    if (!this.playing && !this.songEl) this.virtualMs = t
    if (this.playing && !this.songEl) {
      this.startCtxTime = this.ensureCtx().currentTime
      this.startMediaMs = t
    }
    this.scheduledUntil = t
    this.emit()
  }

  setRate(r: number) {
    this.rate = r
    if (this.songEl) this.songEl.playbackRate = r
    if (this.playing && !this.songEl) {
      const now = this.nowMs()
      this.startCtxTime = this.ensureCtx().currentTime
      this.startMediaMs = now
    }
    this.emit()
  }

  /** 总音量（0~1） */
  setMasterVolume(v: number) {
    this.masterVolume = clamp01(v)
    saveVol('master', this.masterVolume)
    if (this.master) this.master.gain.value = this.muted ? 0 : this.masterVolume
    this.emit()
  }

  /** 音乐音量（0~1） */
  setSongVolume(v: number) {
    this.songVolume = clamp01(v)
    saveVol('song', this.songVolume)
    if (this.songBus) this.songBus.gain.value = this.songMuted ? 0 : this.songVolume
    // 没接进音频图时才用元素自带音量兜底
    if (this.songEl && !this.songSrc) this.songEl.volume = this.songMuted ? 0 : this.songVolume
    this.emit()
  }

  /** 音效音量：hitsound / keysound（0~1） */
  setHitsoundVolume(v: number) {
    this.hitsoundVolume = clamp01(v)
    saveVol('sfx', this.hitsoundVolume)
    if (this.sfxBus) this.sfxBus.gain.value = this.hitsoundMuted ? 0 : this.hitsoundVolume
    this.emit()
  }

  /** 节拍器音量（0~1） */
  setMetronomeVolume(v: number) {
    this.metronomeVolume = clamp01(v)
    saveVol('metro', this.metronomeVolume)
    if (this.metroBus) this.metroBus.gain.value = this.metronomeMuted ? 0 : this.metronomeVolume
    this.emit()
  }

  /** 静音：只压总音量，记住原值以便恢复 */
  setMuted(v: boolean) {
    this.muted = v
    saveVol('muted', v ? 1 : 0)
    if (this.master) this.master.gain.value = v ? 0 : this.masterVolume
    this.emit()
  }

  /** 音乐静音：只压 songBus，音量原值保留 */
  setSongMuted(v: boolean) {
    this.songMuted = v
    saveVol('mutedSong', v ? 1 : 0)
    if (this.songBus) this.songBus.gain.value = v ? 0 : this.songVolume
    if (this.songEl && !this.songSrc) this.songEl.volume = v ? 0 : this.songVolume
    this.emit()
  }

  /** 音效静音：只压 sfxBus，音量原值保留 */
  setHitsoundMuted(v: boolean) {
    this.hitsoundMuted = v
    saveVol('mutedSfx', v ? 1 : 0)
    if (this.sfxBus) this.sfxBus.gain.value = v ? 0 : this.hitsoundVolume
    this.emit()
  }

  /** 节拍器静音：只压 metroBus，音量原值保留 */
  setMetronomeMuted(v: boolean) {
    this.metronomeMuted = v
    saveVol('mutedMetro', v ? 1 : 0)
    if (this.metroBus) this.metroBus.gain.value = v ? 0 : this.metronomeVolume
    this.emit()
  }

  setMetronome(v: boolean) {
    this.metronome = v
    this.emit()
  }

  private tick() {
    const now = this.nowMs()
    const until = now + 160 * this.rate
    if (until <= this.scheduledUntil) return
    const ctx = this.ensureCtx()
    const from = this.scheduledUntil
    for (const e of this.events) {
      if (e.time < from) continue
      if (e.time > until) break
      const when = ctx.currentTime + (e.time - now) / 1000 / this.rate
      if (e.kind === 'keysound' && typeof e.pitch === 'number') {
        // 有音高的音效：优先该乐器这个音高的样本，没有就用合成音
        const tune = e.instrument ? this.keyTune.get(e.instrument) ?? 0 : 0
        if (!this.scheduleKeySample(e.instrument, e.pitch, when, e.volume, tune) && this.synthFallback) {
          this.scheduleTone(freqOf(e.pitch, tune), when, e.duration, e.volume)
        }
      } else {
        for (const n of e.names) this.scheduleSample(n, when, e.volume)
      }
    }
    if (this.metronome) {
      for (const b of this.beats) {
        if (b < from) continue
        if (b > until) break
        const when = ctx.currentTime + (b - now) / 1000 / this.rate
        this.scheduleClick(when, false)
      }
    }
    this.scheduledUntil = until
  }

  private scheduleSample(name: string, when: number, volume: number) {
    const buf = this.bufferFor(name)
    if (!buf) return
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    g.gain.value = Math.max(0, Math.min(1.5, volume / 100))
    src.connect(g)
    g.connect(this.sfxBus)
    src.start(Math.max(when, ctx.currentTime))
  }

  private scheduleClick(when: number, accent: boolean) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = accent ? 1600 : 1050
    const g = ctx.createGain()
    const t0 = Math.max(when, ctx.currentTime)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.18, t0 + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05)
    o.connect(g)
    g.connect(this.metroBus)
    o.start(t0)
    o.stop(t0 + 0.07)
  }
}

export const engine = new AudioEngine()

// 调试入口：控制台里可用 __engine 检查播放链路状态
if (typeof window !== 'undefined') (window as any).__engine = engine
