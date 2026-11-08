import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChartDoc, MeasureInfo, NoteEvent } from '../core/types'
import { engine } from '../audio/engine'
import { useStore } from '../store'
import { fmtOsuTime } from '../core/time'
import { measureTicks } from '../core/measures'
import { clampToRange, isBlackKey, midiToName } from '../core/pitch'
import { alphaForVolume } from '../core/colors'
import { codeGlyph } from '../core/codes'
import { getDisplayPrefs } from '../core/displayPrefs'
import {
  PRIORITY_ALPHA as LINE_A,
  PRIORITY_MIN_PX as MIN_PX,
  PRIORITY_WIDTH as LINE_W,
  DOWNBEAT_WIDTH,
  rhythmPalette,
  tickPriority,
  type Priority,
} from '../core/rhythmColors'
import { onRevealTime } from '../core/reveal'
import { IconMetronome, IconPause, IconPlay, IconStop } from './Icons'
import VolumeControl from './VolumeControl'
import { t as tr } from '../i18n'

/** 卷帘里每条谱表用的颜色 */
const STAFF_COLORS = ['#3ec5ff', '#ffb347', '#8be78b', '#ff8ab5', '#c39bff', '#ffe28a']

interface Props {
  doc: ChartDoc
  theme: 'light' | 'dark'
  onPlaySample: (name: string, vol: number, ev?: NoteEvent) => void
}

const LANE_H = 24
const HEADER_H = 22
const GUTTER = 74
const PROG_H = 22


function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 画圆角矩形路径（不调用 beginPath 之外的副作用） */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 时间轴试听可选的倍速 */
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
/** 0.25 → "0.25x"、1 → "1.0x"、2 → "2.0x" */
function fmtRate(r: number) {
  return `${r.toFixed(2).replace(/0$/, '')}x`
}

export default function Timeline({ doc, theme, onPlaySample }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const miniRef = useRef<HTMLCanvasElement>(null)
  const [ppsec, setPpsec] = useState(90)
  // 细分和跟随放进 store：格子视图和时间轴共用同一份，两边一起变
  const div = useStore((s) => s.div)
  const setDiv = useStore((s) => s.setDiv)
  const follow = useStore((s) => s.follow)
  const setFollow = useStore((s) => s.setFollow)
  const [cursorTime, setCursorTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [tick, setTick] = useState(0)
  const [nowMs, setNowMs] = useState(0)
  const [durMs, setDurMs] = useState(0)
  const [hasAudio, setHasAudio] = useState(!!engine.songName)
  const startRef = useRef(0)
  const sizeRef = useRef({ w: 800, h: 300 })
  const dragRef = useRef(false)
  const miniDragRef = useRef<{ startX: number; startAt: number } | null>(null)
  const lastNowRef = useRef(-1)
  const lastDurRef = useRef(-1)

  const lanes = useMemo(() => {
    const arr: string[] = []
    for (const h of doc.hitsounds) if (h.name && !arr.includes(h.name)) arr.push(h.name)
    for (const e of doc.events) for (const n of e.names) if (!arr.includes(n)) arr.push(n)
    return arr
  }, [doc])

  /** 代号 -> 自定义颜色（#rrggbb）；没配色的音符用默认色 */
  const colorByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of doc.hitsounds) if (h.name && h.color) m.set(h.name, h.color)
    return m
  }, [doc])

  const laneIndex = useMemo(() => {
    const m = new Map<string, number>()
    lanes.forEach((n, i) => m.set(n, i))
    return m
  }, [lanes])

  /** [Keysound] 正文产生的、有音高的音符 */
  const ksEvents = useMemo(
    () => doc.events.filter((e) => e.kind === 'keysound' && typeof e.pitch === 'number'),
    [doc],
  )
  /** lanes = 现有音效名分行视图；roll = keysound 钢琴卷帘 */
  const [view, setView] = useState<'lanes' | 'roll'>('lanes')
  const [viewPinned, setViewPinned] = useState(false)
  const [rollScroll, setRollScroll] = useState(0)
  /** 音效行视图的竖向滚动（音效名太多、行数超出可视高度时用） */
  const [laneScroll, setLaneScroll] = useState(0)
  // 谱面里第一次出现 [Keysound] 时自动切到卷帘；用户手动切过之后就听用户的
  useEffect(() => {
    if (!viewPinned) setView(ksEvents.length ? 'roll' : 'lanes')
  }, [ksEvents.length, viewPinned])

  /** 卷帘要显示的音高范围：按实际用到的音高收窄，至少留一个八度 */
  const rollRange = useMemo(() => {
    if (!ksEvents.length) return { low: 60, high: 71 }
    let lo = Infinity
    let hi = -Infinity
    for (const e of ksEvents) {
      const p = e.pitch as number
      if (p < lo) lo = p
      if (p > hi) hi = p
    }
    return {
      low: Math.max(21, Math.min(lo - 2, hi - 13)),
      high: Math.min(108, Math.max(hi + 2, lo + 13)),
    }
  }, [ksEvents])

  /** 由画布高度算出卷帘几何：行高自适应（5~16px），内容超高时允许竖向滚动 */
  function rollGeom(mainH: number) {
    const low = rollRange.low
    const high = rollRange.high
    const count = Math.max(1, high - low + 1)
    const avail = Math.max(24, mainH - HEADER_H)
    const rowH = Math.max(5, Math.min(16, avail / count))
    const contentH = count * rowH
    const maxScroll = Math.max(0, contentH - avail)
    return { low, high, count, rowH, avail, maxScroll }
  }
  const rollY = (pitch: number, g: ReturnType<typeof rollGeom>) =>
    HEADER_H + (g.high - pitch) * g.rowH - Math.min(rollScroll, g.maxScroll)
  const rollPitchAt = (my: number, g: ReturnType<typeof rollGeom>) =>
    g.high - Math.floor((my - HEADER_H + Math.min(rollScroll, g.maxScroll)) / g.rowH)

  const isRoll = view === 'roll' && ksEvents.length > 0

  // 谱面自身的小节 + 有音频时延伸到歌曲末尾的虚拟小节
  const gridMeasures = useMemo<MeasureInfo[]>(() => {
    const arr = [...doc.measures]
    const last = arr[arr.length - 1]
    if (!last) return arr
    if (hasAudio && durMs > last.end + 1) {
      // 末小节若有变速，延伸段沿用最后一段的 BPM
      const segs = last.segments
      const tailBl = segs && segs.length ? segs[segs.length - 1].beatLength : last.beatLength
      let t = last.end
      let idx = last.index + 1
      let guard = 0
      while (t < durMs && guard < 20000) {
        const e = t + last.meter * tailBl
        arr.push({ index: idx++, start: t, end: e, meter: last.meter, beatLength: tailBl })
        t = e
        guard++
      }
    }
    return arr
  }, [doc.measures, hasAudio, durMs])

  // 所有等分刻度位置（升序），用于滚轮吸附。
  // 用 measureTicks 是为了让变速小节按分段展开 —— BPM 变高刻度变密、变低变疏。
  const ticks = useMemo(() => {
    const a: number[] = []
    for (const m of gridMeasures) a.push(...measureTicks(m, div))
    a.sort((x, y) => x - y)
    return a
  }, [gridMeasures, div])

  const snapNext = (t: number) => {
    let lo = 0
    let hi = ticks.length - 1
    let ans = -1
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      if (ticks[m] > t + 0.5) {
        ans = m
        hi = m - 1
      } else lo = m + 1
    }
    return ans >= 0 ? ticks[ans] : ticks[ticks.length - 1] ?? 0
  }
  const snapPrev = (t: number) => {
    let lo = 0
    let hi = ticks.length - 1
    let ans = -1
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      if (ticks[m] < t - 0.5) {
        ans = m
        lo = m + 1
      } else hi = m - 1
    }
    return ans >= 0 ? ticks[ans] : 0
  }

  useEffect(() => engine.subscribe(() => setTick((t) => t + 1)), [])
  useEffect(() => {
    const un = engine.subscribe(() => {
      setPlaying(engine.playing)
      setHasAudio(!!engine.songName)
    })
    return un
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      sizeRef.current = { w: Math.max(200, r.width), h: Math.max(120, r.height) }
      const apply = (c: HTMLCanvasElement | null, w: number, h: number) => {
        if (!c) return
        const dpr = window.devicePixelRatio || 1
        c.width = w * dpr
        c.height = h * dpr
        c.style.width = w + 'px'
        c.style.height = h + 'px'
      }
      apply(canvasRef.current, sizeRef.current.w, sizeRef.current.h - PROG_H)
      apply(miniRef.current, sizeRef.current.w, PROG_H)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 主绘制循环
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const n = engine.nowMs()
      if (Math.abs(n - lastNowRef.current) >= 80) {
        lastNowRef.current = n
        setNowMs(n)
      }
      const d = engine.durationMs
      if (Math.abs(d - lastDurRef.current) >= 300) {
        lastDurRef.current = d
        setDurMs(d)
      }
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  })

  // 滚轮：普通滚动 = 光标吸附到下一/上一刻度；Ctrl = 缩放
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {})
  wheelRef.current = (e: WheelEvent) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      setPpsec((p) => Math.max(8, Math.min(1200, p * (e.deltaY > 0 ? 0.9 : 1.12))))
      return
    }
    // 指针在左边音效名栏（没有网格的那块）：滚轮 = 上下滚动，
    // 音效行太多、下面几行显示不全时用这个翻。
    const cv = canvasRef.current
    const mx = cv ? e.clientX - cv.getBoundingClientRect().left : GUTTER
    if (mx < GUTTER) {
      if (isRoll) {
        const g = rollGeom(sizeRef.current.h - PROG_H)
        setRollScroll((v) => Math.max(0, Math.min(g.maxScroll, v + e.deltaY)))
      } else {
        const g = laneGeom(sizeRef.current.h - PROG_H)
        setLaneScroll((v) => Math.max(0, Math.min(g.maxScroll, v + e.deltaY)))
      }
      return
    }
    // 卷帘视图下 Shift+滚轮 = 竖向滚动音高
    if (isRoll && e.shiftKey) {
      const g = rollGeom(sizeRef.current.h - PROG_H)
      setRollScroll((s) => Math.max(0, Math.min(g.maxScroll, s + e.deltaY)))
      return
    }
    const t = engine.nowMs()
    const target = (e.deltaY + e.deltaX) > 0 ? snapNext(t) : snapPrev(t)
    engine.seek(target)
    setCursorTime(target)
    // 保持光标在视野内
    const vis = sizeRef.current.w / (ppsec / 1000)
    if (target < startRef.current + vis * 0.05 || target > startRef.current + vis * 0.9) {
      startRef.current = Math.max(0, target - vis * 0.35)
    }
  }
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const h = (e: WheelEvent) => wheelRef.current(e)
    c.addEventListener('wheel', h, { passive: false })
    return () => c.removeEventListener('wheel', h)
  }, [])

  // 审阅报告里点时间：把那一刻滚到视野中间（播放头由调用方 seek）
  useEffect(
    () =>
      onRevealTime((t) => {
        const vis = sizeRef.current.w / (ppsec / 1000)
        startRef.current = Math.max(0, t - vis * 0.35)
      }),
    [ppsec],
  )

  /** 音效行视图的竖向几何：内容高度 / 可视高度 / 最大滚动量 */
  function laneGeom(mainH: number) {
    const count = Math.max(1, lanes.length)
    const contentH = count * LANE_H
    const viewH = Math.max(0, mainH - HEADER_H)
    return { count, contentH, viewH, maxScroll: Math.max(0, contentH - viewH) }
  }

  function totalMs(): number {
    const d = engine.durationMs
    return Number.isFinite(d) && d > 0 ? d : Math.max(30000, (doc.events[doc.events.length - 1]?.time ?? 0) + 3000)
  }

  function draw() {
    const c = canvasRef.current
    const mc = miniRef.current
    if (!c || !mc) return
    const ctx = c.getContext('2d')
    const mctx = mc.getContext('2d')
    if (!ctx || !mctx) return
    const dpr = window.devicePixelRatio || 1
    const { w, h } = sizeRef.current
    const mainH = h - PROG_H
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, mainH)
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    mctx.clearRect(0, 0, w, PROG_H)

    const bg = cssVar('--bg')
    const text = cssVar('--text')
    const dim = cssVar('--text-faint')
    const border = cssVar('--border')
    const accent = cssVar('--accent')
    const alt = cssVar('--bg-alt')
    const P = rhythmPalette(theme)

    const now = engine.nowMs()
    const pxPerMs = ppsec / 1000
    const visibleMs = w / pxPerMs
    if (follow && engine.playing) {
      const target = now - visibleMs * 0.35
      startRef.current = Math.max(0, target)
    }
    const start = startRef.current
    const x = (t: number) => GUTTER + (t - start) * pxPerMs
    const lg = laneGeom(mainH)
    const ls = isRoll ? 0 : Math.min(laneScroll, lg.maxScroll)

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, mainH)

    if (isRoll) {
      // 钢琴卷帘：纵轴是音高，黑键行画深色，八度（C）位置画分隔线 + 音名
      const g = rollGeom(mainH)
      for (let i = 0; i < g.count; i++) {
        const pitch = g.high - i
        const y = HEADER_H + i * g.rowH - Math.min(rollScroll, g.maxScroll)
        if (y + g.rowH < HEADER_H || y > mainH) continue
        const black = isBlackKey(pitch)
        ctx.fillStyle = black ? (theme === 'dark' ? '#171717' : '#e2e2e2') : alt
        ctx.fillRect(0, y, w, g.rowH)
      }
      for (let i = 0; i < g.count; i++) {
        const pitch = g.high - i
        if (pitch % 12 !== 0) continue
        const y = HEADER_H + i * g.rowH - Math.min(rollScroll, g.maxScroll) + 0.5
        if (y < HEADER_H || y > mainH) continue
        ctx.strokeStyle = border
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, GUTTER, mainH)
      ctx.strokeStyle = border
      ctx.beginPath()
      ctx.moveTo(GUTTER + 0.5, 0)
      ctx.lineTo(GUTTER + 0.5, mainH)
      ctx.stroke()
      ctx.font = '9px ui-monospace, Consolas, monospace'
      ctx.textBaseline = 'middle'
      for (let i = 0; i < g.count; i++) {
        const pitch = g.high - i
        const y = HEADER_H + i * g.rowH - Math.min(rollScroll, g.maxScroll)
        const cy = y + g.rowH / 2
        if (cy < HEADER_H - 4 || cy > mainH) continue
        const black = isBlackKey(pitch)
        if (!black && g.rowH >= 8) {
          ctx.fillStyle = dim
          ctx.fillText(midiToName(pitch), 6, cy)
        }
      }
    } else {
      // 泳道背景（按音效名分行）—— 支持竖向滚动，超出部分裁在表头/底边之外
      const laneCount = lg.count
      for (let i = 0; i < laneCount; i++) {
        const y = HEADER_H + i * LANE_H - ls
        if (y + LANE_H < HEADER_H || y > mainH) continue
        const y0 = Math.max(y, HEADER_H)
        const y1 = Math.min(y + LANE_H, mainH)
        ctx.fillStyle = i % 2 ? alt : bg
        ctx.fillRect(0, y0, w, Math.max(0, y1 - y0))
        if (y >= HEADER_H) {
          ctx.strokeStyle = border
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(0, Math.round(y) + 0.5)
          ctx.lineTo(w, Math.round(y) + 0.5)
          ctx.stroke()
        }
      }
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, GUTTER, mainH)
      ctx.strokeStyle = border
      ctx.beginPath()
      ctx.moveTo(GUTTER + 0.5, 0)
      ctx.lineTo(GUTTER + 0.5, mainH)
      ctx.stroke()
      ctx.font = '600 11px ui-monospace, Consolas, monospace'
      ctx.fillStyle = accent
      ctx.textBaseline = 'middle'
      for (let i = 0; i < laneCount; i++) {
        const y = HEADER_H + i * LANE_H + LANE_H / 2 - ls
        if (y < HEADER_H + 6 || y > mainH - 4) continue
        ctx.fillText(codeGlyph(lanes[i]).slice(0, 9), 8, y)
      }
      // 竖向滚动条：行数超出可视高度时贴在名字栏右侧，提示这里可以滚
      if (lg.maxScroll > 0) {
        const viewH = Math.max(1, lg.viewH)
        const thumbH = Math.max(24, (viewH / lg.contentH) * viewH)
        const thumbY = HEADER_H + (ls / lg.maxScroll) * Math.max(0, viewH - thumbH)
        ctx.fillStyle = accent
        ctx.globalAlpha = 0.35
        ctx.fillRect(GUTTER - 3, thumbY, 2.5, thumbH)
        ctx.globalAlpha = 1
      }
    }

    // 小节 / 拍 / 等分刻度线
    ctx.font = '10px ui-monospace, Consolas, monospace'
    ctx.lineCap = 'butt'
    for (const m of gridMeasures) {
      if (m.end < start || m.start > start + visibleMs) continue
      // 小节起始线（较强）
      const mx = x(m.start)
      ctx.strokeStyle = border
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(Math.round(mx) + 0.5, HEADER_H)
      ctx.lineTo(Math.round(mx) + 0.5, mainH)
      ctx.stroke()
      ctx.fillStyle = dim
      ctx.fillText(String(m.index + 1), mx + 3, HEADER_H - 8)

      // 小节内按段展开：变速小节每一段用自己的 beatLength，
      // 因此 BPM 变高时刻度自动变密、变低时变疏。
      const segs: { start: number; end: number; beatLength: number; beats: number }[] =
        m.segments && m.segments.length
          ? m.segments
          : [{ start: m.start, end: m.end, beatLength: m.beatLength, beats: m.meter }]
      for (const seg of segs) {
        const bl = seg.beatLength > 0 ? seg.beatLength : 500
        const spacing = (bl / div) * pxPerMs
        for (let b = 0; b < seg.beats - 1e-9; b++) {
          const bs = seg.start + b * bl
          for (let i = 0; i < div; i++) {
            const pri = tickPriority(i, div)
            if (spacing < MIN_PX[pri]) continue
            const t = bs + (i * bl) / div
            if (t > m.end + 1e-6) break
            const gx = x(t)
            if (gx < GUTTER - 1) continue
            if (gx > w) break
            // 每小节第一拍（“动”）画粗线，其它拍（次/打/次）细线
            const isDownbeat = Math.abs(t - m.start) < 0.5
            ctx.strokeStyle = P[pri]
            ctx.globalAlpha = isDownbeat ? 1 : LINE_A[pri]
            ctx.lineWidth = isDownbeat ? DOWNBEAT_WIDTH : LINE_W[pri]
            ctx.beginPath()
            ctx.moveTo(Math.round(gx) + 0.5, HEADER_H)
            ctx.lineTo(Math.round(gx) + 0.5, mainH)
            ctx.stroke()
            ctx.globalAlpha = 1
          }
        }
      }
    }

    // 段落标记（#123456 / #2:03.456 / #bookmark(n) / #timing(n)）
    ctx.font = '10px ui-monospace, Consolas, monospace'
    ctx.setLineDash([4, 3])
    for (const mk of doc.markers) {
      if (mk.time === null) continue
      if (mk.time < start - 500 || mk.time > start + visibleMs + 500) continue
      const gx = x(mk.time)
      if (gx < GUTTER - 1 || gx > w) continue
      ctx.strokeStyle = accent
      ctx.globalAlpha = 0.9
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(Math.round(gx) + 0.5, HEADER_H)
      ctx.lineTo(Math.round(gx) + 0.5, mainH)
      ctx.stroke()
      ctx.globalAlpha = 1
      const label = `#${mk.raw}`
      const tw = ctx.measureText(label).width
      ctx.fillStyle = accent
      ctx.fillRect(Math.round(gx) + 1, HEADER_H + 1, tw + 4, 12)
      ctx.fillStyle = bg
      ctx.fillText(label, Math.round(gx) + 3, HEADER_H + 7)
    }
    ctx.setLineDash([])

    // 音符：裁到网格区里 —— 左边的音效名栏不该被滑过去的音符盖住
    ctx.save()
    ctx.beginPath()
    ctx.rect(GUTTER, HEADER_H, Math.max(0, w - GUTTER), Math.max(0, mainH - HEADER_H))
    ctx.clip()
    const first = Math.max(0, findFirst(doc.events, start - 500))
    for (let i = first; i < doc.events.length; i++) {
      const e = doc.events[i]
      if (e.time > start + visibleMs + 500) break
      const nx = x(e.time)
      const bw = Math.max(3, Math.min(14, (e.duration * pxPerMs) | 0 || 5))
      // 颜色不透明度：默认随音量变化（100 → 0xFF、0 → 0x37），可在 设置 里关掉
      const alpha = getDisplayPrefs().colorAlphaByVol ? alphaForVolume(e.volume) : 1
      if (isRoll) {
        if (typeof e.pitch !== 'number') continue
        const g = rollGeom(mainH)
        const bwRoll = Math.max(3, e.duration * pxPerMs)
        const y = rollY(e.pitch, g)
        const bh = Math.max(3, g.rowH - 1)
        if (y < HEADER_H - bh || y > mainH) continue
        const real = engine.hasKeySample(e.instrument, e.pitch)
        ctx.globalAlpha = alpha * (real ? 1 : 0.6)
        ctx.fillStyle = STAFF_COLORS[(e.staff ?? 0) % STAFF_COLORS.length]
        ctx.beginPath()
        ctx.roundRect
          ? ctx.roundRect(nx, y - bh / 2, bwRoll, bh, Math.min(3, bh / 2))
          : ctx.rect(nx, y - bh / 2, bwRoll, bh)
        ctx.fill()
        if (!real) {
          // 没有真实样本（走内置合成音）的音符加一圈虚线，方便确认
          ctx.globalAlpha = 0.9
          ctx.strokeStyle = ctx.fillStyle
          ctx.lineWidth = 1
          ctx.setLineDash([2, 2])
          ctx.stroke()
          ctx.setLineDash([])
        }
        ctx.globalAlpha = 1
        if (g.rowH >= 11 && bw > 6) {
          ctx.fillStyle = theme === 'dark' ? '#101010' : '#ffffff'
          ctx.font = '8px ui-monospace, Consolas, monospace'
          ctx.fillText(midiToName(e.pitch), nx + 2, y)
        }
        continue
      }
      const li = laneIndex.get(e.names[0])
      if (li === undefined) continue
      const y = HEADER_H + li * LANE_H + LANE_H / 2 - ls
      if (y < HEADER_H - LANE_H || y > mainH + LANE_H) continue
      ctx.globalAlpha = alpha
      ctx.fillStyle = colorByName.get(e.names[0]) || (e.index != null ? '#b5509c' : accent)
      ctx.beginPath()
      const rr = 3
      const bh = 12
      ctx.roundRect ? ctx.roundRect(nx, y - bh / 2, bw, bh, rr) : ctx.rect(nx, y - bh / 2, bw, bh)
      ctx.fill()
      ctx.globalAlpha = 1
      if (ppsec > 150 && e.index != null) {
        ctx.fillStyle = dim
        ctx.font = '9px ui-monospace, Consolas, monospace'
        ctx.fillText(String(e.index), nx + bw + 2, y - 6)
      }
    }

    // 播放头（青色系，与 1/2 红线明显区分）
    const px = x(now)
    if (px >= GUTTER - 1 && px <= w) {
      ctx.strokeStyle = P.playhead
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(Math.round(px) + 0.5, 0)
      ctx.lineTo(Math.round(px) + 0.5, mainH)
      ctx.stroke()
    }

    ctx.restore()

    // 顶部时间刻度
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, HEADER_H)
    ctx.strokeStyle = border
    ctx.beginPath()
    ctx.moveTo(0, HEADER_H + 0.5)
    ctx.lineTo(w, HEADER_H + 0.5)
    ctx.stroke()
    ctx.fillStyle = dim
    ctx.font = '10px ui-monospace, Consolas, monospace'
    // 标签是 `00:05:000`（9 个字符 ≈ 54px），步长按「至少留 70px」选，避免低缩放下叠在一起
    const STEPS = [250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000]
    const step = STEPS.find((ms) => (ms / 1000) * ppsec >= 70) ?? 60000
    const from = Math.floor(start / step) * step
    for (let t = from; t < start + visibleMs + step; t += step) {
      if (t < 0) continue
      const tx = x(t)
      if (tx < GUTTER) continue
      ctx.fillText(fmtOsuTime(t), tx + 3, 10)
      ctx.strokeStyle = border
      ctx.beginPath()
      ctx.moveTo(Math.round(tx) + 0.5, HEADER_H - 5)
      ctx.lineTo(Math.round(tx) + 0.5, HEADER_H)
      ctx.stroke()
    }
    void text

    // 底部进度条
    drawProgress(mctx, dpr)
  }

  function drawProgress(mctx: CanvasRenderingContext2D, dpr: number) {
    const P = rhythmPalette(theme)
    const w = sizeRef.current.w
    const full = totalMs()
    const now = engine.nowMs()
    const bg = cssVar('--bg')
    const alt = cssVar('--bg-alt')
    const border = cssVar('--border')
    const accent = cssVar('--accent')
    const dim = cssVar('--text-faint')

    mctx.fillStyle = alt
    mctx.fillRect(0, 0, w, PROG_H)
    mctx.strokeStyle = border
    mctx.lineWidth = 1
    mctx.beginPath()
    mctx.moveTo(0, 0.5)
    mctx.lineTo(w, 0.5)
    mctx.stroke()

    const tx = (ms: number) => (ms / full) * w

    // 已播放区域
    mctx.fillStyle = accent
    mctx.globalAlpha = 0.14
    mctx.fillRect(0, 0, Math.max(0, tx(now)), PROG_H)
    mctx.globalAlpha = 1

    // 音符密度
    mctx.strokeStyle = dim
    mctx.globalAlpha = 0.5
    mctx.beginPath()
    for (const e of doc.events) {
      const px = Math.round(tx(e.time)) + 0.5
      mctx.moveTo(px, PROG_H - 6)
      mctx.lineTo(px, PROG_H)
    }
    mctx.stroke()
    mctx.globalAlpha = 1

    // 当前可视窗口（底部滑块：按住拖动即平移时间轴）
    const vis = sizeRef.current.w / (ppsec / 1000)
    const v0 = tx(startRef.current)
    const v1 = tx(startRef.current + vis)
    // 窗口很窄时也留一个抓得住的最小宽度
    const vw = Math.max(12, Math.min(w, v1 - v0))
    const vx = Math.max(0, Math.min(w - vw, v0))
    mctx.fillStyle = accent
    mctx.globalAlpha = 0.22
    roundRectPath(mctx, vx + 0.5, 3.5, Math.max(1, vw - 1), PROG_H - 7, 3)
    mctx.fill()
    mctx.globalAlpha = 0.65
    mctx.strokeStyle = accent
    mctx.lineWidth = 1
    mctx.stroke()
    mctx.globalAlpha = 1

    // 播放头（青色系，与 1/2 红线明显区分）
    const px = tx(now)
    if (px >= 0 && px <= w) {
      mctx.strokeStyle = P.playhead
      mctx.lineWidth = 2
      mctx.beginPath()
      mctx.moveTo(Math.round(px) + 0.5, 0)
      mctx.lineTo(Math.round(px) + 0.5, PROG_H)
      mctx.stroke()
    }

    // 底部边框
    mctx.strokeStyle = border
    mctx.beginPath()
    mctx.moveTo(0, PROG_H - 0.5)
    mctx.lineTo(w, PROG_H - 0.5)
    mctx.stroke()
  }

  function findFirst(events: NoteEvent[], t: number) {
    let lo = 0
    let hi = events.length - 1
    let res = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (events[mid].time >= t) {
        res = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    return res
  }

  function hitTest(clientX: number, clientY: number) {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    const mx = clientX - r.left
    const my = clientY - r.top
    const t = startRef.current + (mx - GUTTER) / (ppsec / 1000)
    // 卷帘视图：按 (时间, 音高) 就近命中 keysound 音符
    if (isRoll) {
      const g = rollGeom(sizeRef.current.h - PROG_H)
      const pitch = g.high - Math.floor((my - HEADER_H + Math.min(rollScroll, g.maxScroll)) / g.rowH)
      const tolMs = 12 / (ppsec / 1000)
      let best: NoteEvent | null = null
      let bestScore = Infinity
      for (const e of ksEvents) {
        if (Math.abs(e.time - t) > tolMs) continue
        const dp = Math.abs((e.pitch as number) - pitch)
        const dt = Math.abs(e.time - t) / (tolMs || 1)
        const score = dp * 2 + dt
        if (score < bestScore) {
          bestScore = score
          best = e
        }
      }
      if (!best) {
        // 同一时间点附近没找到，就取时间上最近的一个
        for (const e of ksEvents) {
          if (!best || Math.abs(e.time - t) < Math.abs(best.time - t)) best = e
        }
      }
      return { time: Math.max(0, t), lane: undefined, event: best }
    }
    const lg = laneGeom(sizeRef.current.h - PROG_H)
    const li = Math.floor((my - HEADER_H + Math.min(laneScroll, lg.maxScroll)) / LANE_H)
    const lane = lanes[li]
    let best: NoteEvent | null = null
    if (lane) {
      for (const e of doc.events) {
        if (e.time < t - 120) continue
        if (e.time > t + 120) break
        if (e.names[0] === lane && (!best || Math.abs(e.time - t) < Math.abs(best.time - t))) best = e
      }
    }
    return { time: Math.max(0, t), lane, event: best }
  }

  function miniGeom() {
    const c = miniRef.current!
    const r = c.getBoundingClientRect()
    const w = Math.max(1, r.width)
    const total = Math.max(1, totalMs())
    const vis = Math.max(1, Math.min(total, sizeRef.current.w / (ppsec / 1000)))
    const maxStart = Math.max(0, total - vis)
    const start = Math.max(0, Math.min(maxStart, startRef.current))
    const v0 = (start / total) * w
    const v1 = Math.min(w, ((start + vis) / total) * w)
    return { r, w, total, vis, maxStart, start, v0: Math.min(v0, w), v1: Math.max(v1, 0) }
  }

  /** 按住底部滑块（可视窗口）左右拖 = 平移时间轴；点滑块外面 = 把窗口挪过去 */
  function miniDown(clientX: number) {
    const g = miniGeom()
    const x = clientX - g.r.left
    // 窗口很窄时也给一个至少 12px 的抓取范围
    const pad = Math.max(2, 6 - (g.v1 - g.v0))
    let startAt = g.start
    if (!(x >= g.v0 - pad && x <= g.v1 + pad)) {
      const t = (x / g.w) * g.total
      startAt = Math.max(0, Math.min(g.maxStart, t - g.vis / 2))
      startRef.current = startAt
    }
    miniDragRef.current = { startX: clientX, startAt }
    if (miniRef.current) miniRef.current.style.cursor = 'grabbing'
    // 手动平移后默认不再自动跟随播放头
    setFollow(false)
  }

  function miniMove(clientX: number) {
    const d = miniDragRef.current
    if (!d) return
    const g = miniGeom()
    const t = (clientX - d.startX) / g.w
    startRef.current = Math.max(0, Math.min(g.maxStart, d.startAt + t * g.total))
  }

  const pct = durMs > 0 ? ((nowMs / durMs) * 100).toFixed(1) : '0.0'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="tl-toolbar">
        <button
          className="icon-btn"
          title={tr('播放 / 暂停 (Space)')}
          onClick={() => {
            engine.toggle()
            setPlaying(engine.playing)
          }}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button
          className="icon-btn"
          title={tr('停止并回到开头')}
          onClick={() => {
            engine.pause()
            engine.seek(0)
          }}
        >
          <IconStop />
        </button>
        <span className="mono" style={{ minWidth: 92, color: 'var(--text-dim)' }}>
          {fmtOsuTime(nowMs)}
          {hasAudio ? <span style={{ color: 'var(--text-faint)' }}> · {pct}%</span> : ''}
        </span>
        <button
          className={`icon-btn ${engine.metronome ? 'on' : ''}`}
          title={engine.metronome ? tr('节拍器：已开启 ✓') : tr('节拍器：已关闭')}
          onClick={() => {
            engine.setMetronome(!engine.metronome)
            setTick((t) => t + 1)
          }}
        >
          <IconMetronome />
          {engine.metronome && <span style={{ fontSize: 9, marginLeft: 1 }}>✓</span>}
        </button>
        <label className="hint" title={tr('播放倍速（只影响试听，不影响导出）')} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {tr('倍速')}
          <select
            value={engine.rate}
            onChange={(e) => engine.setRate(Number(e.target.value))}
            style={{ padding: '1px 4px' }}
          >
            {PLAYBACK_RATES.map((r) => (
              <option key={r} value={r}>
                {fmtRate(r)}
              </option>
            ))}
          </select>
        </label>
        <VolumeControl compact />
        <label className="hint" title={tr('每拍等分数（1~64）')} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {tr('细分')}
          <input
            type="number"
            min={1}
            max={64}
            step={1}
            value={div}
            onChange={(e) => {
              let v = Math.round(Number(e.target.value))
              if (Number.isNaN(v)) return
              v = Math.max(1, Math.min(64, v))
              setDiv(v)
            }}
            style={{ width: 46, padding: '1px 3px' }}
          />
          <span className="hint">{tr('/拍')}</span>
        </label>
        <div className="spacer" />
        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {tr('视图')}
          <button
            className={`tl-seg ${view === 'lanes' ? 'on' : ''}`}
            title={tr('音效名分行视图')}
            onClick={() => {
              setViewPinned(true)
              setView('lanes')
            }}
          >
            {tr('音效行')}
          </button>
          <button
            className={`tl-seg ${isRoll ? 'on' : ''}`}
            title={tr('Keysound 钢琴卷帘视图（Shift+滚轮可上下滚动）')}
            onClick={() => {
              setViewPinned(true)
              setView('roll')
            }}
          >
            {tr('钢琴卷帘')}
          </button>
        </label>
        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          {tr('跟随')}
        </label>
        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {tr('缩放')}
          <input
            type="range"
            min={10}
            max={600}
            step={5}
            value={ppsec}
            onChange={(e) => setPpsec(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>
        <span className="hint mono">{tr('光标')} {fmtOsuTime(cursorTime)}</span>
        <span className="hint">{tr('共 {notes} 个音符 / {measures} 小节', { notes: doc.events.length, measures: doc.usedMeasures })}</span>
      </div>
      <div className="timeline-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onMouseDown={(e) => {
            dragRef.current = true
            const r = hitTest(e.clientX, e.clientY)
            engine.seek(r.time)
            setCursorTime(r.time)
            if (r.event) onPlaySample(r.event.names[0], r.event.volume, r.event)
          }}
          onMouseMove={(e) => {
            const r = hitTest(e.clientX, e.clientY)
            if (dragRef.current) {
              engine.seek(r.time)
              setCursorTime(r.time)
            }
          }}
          onMouseUp={() => (dragRef.current = false)}
          onMouseLeave={() => (dragRef.current = false)}
        />
        <canvas
          ref={miniRef}
          style={{ cursor: 'grab', touchAction: 'none' }}
          title={tr('拖动滑块左右平移时间轴；点在滑块外可把视野挪到该处')}
          onPointerDown={(e) => {
            e.preventDefault()
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
              /* 合成事件没有活跃指针，忽略即可 */
            }
            miniDown(e.clientX)
          }}
          onPointerMove={(e) => miniMove(e.clientX)}
          onPointerUp={(e) => {
            miniDragRef.current = null
            if (miniRef.current) miniRef.current.style.cursor = 'grab'
            try {
              e.currentTarget.releasePointerCapture(e.pointerId)
            } catch {
              /* 指针已经释放 */
            }
          }}
          onPointerCancel={(e) => {
            miniDragRef.current = null
            if (miniRef.current) miniRef.current.style.cursor = 'grab'
            try {
              e.currentTarget.releasePointerCapture(e.pointerId)
            } catch {
              /* ignore */
            }
          }}
        />
      </div>
    </div>
  )
}
