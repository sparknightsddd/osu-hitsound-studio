/**
 * 格子视图（可视化编辑）：把整首谱铺成一格一格的圆角方块。
 *
 * 排版规则（用户定的）：
 *   - 每格 = 一个「拍 / 细分」单位（div=4 就是 1/4 拍，即 16 分音符）；
 *   - 一行装整数个小节，除非装不下（格数不够一小节时）才拆行；
 *   - 拆行时必须落在拍边界上，并且在「小节线」处强制换行
 *     —— 下一小节永远从新的一行开头开始，不会接着上一行末尾排。
 *
 * 边框颜色跟时间轴网格线一致（整拍 / 1/2 / 1/3 / 1/4 / 1/8），
 * 有音效的格子用该音效的颜色填充，格子里写代号。
 *
 * 两种落笔方式：
 *   - 单击型：先在网格里点/拖出选区，再点音效圆按钮 → 把该音效加到选中的格子上（再点一次移除）；
 *   - 双击型：双击音效圆按钮锁定它（其它按钮变灰），之后点网格直接落笔。
 *
 * 右键 / Ctrl+Z X C V A 走一套自己的编辑命令（文本编辑器的同类快捷键仍由 CodeMirror 处理）。
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { ChartDoc, HitsoundDef, NoteEvent, SectionMark } from '../core/types'

/** 钢琴键盘的键宽（px）：88 键整台铺开，窗口放不下就横向滚动 */
const PIANO_WHITE_W = 22
const PIANO_BLACK_W = 13

import { measureTicks } from '../core/measures'
import { rhythmPalette, tickPriority, withAlpha, readableOn, PRIORITY_ALPHA, type Priority } from '../core/rhythmColors'
import { alphaForVolume, parseColorToken } from '../core/colors'
import { getDisplayPrefs } from '../core/displayPrefs'
import { engine } from '../audio/engine'
import { useStore } from '../store'
import { parseChart } from '../core/parse'
import {
  applyCellEdits,
  measureVolumeMarks,
  readMeasureCells,
  volumeSpanFrom,
  type CellEdit,
} from '../core/gridEdit'
import { matchCell, parseCodes, replaceCell } from '../core/findReplace'
import { reorderDefineText } from '../core/defineOrder'
import {
  clampToRange,
  isBlackKey,
  letterToSemi,
  midiToName,
  nameToMidi,
  PIANO_HIGH,
  PIANO_LOW,
  semiToLetter,
} from '../core/pitch'
import type { GridEditTarget } from '../core/gridEdit'
import { canRedo, canUndo, recordEdit, redoEdit, undoEdit } from '../core/gridHistory'
import { getGridClip, setGridClip, hasGridClip, type ClipCell, type GridClip } from '../core/gridClipboard'
import { writeClipboard } from '../core/clipboard'
import { openEditMenu, type EditMenuItem } from './EditMenu'
import { openExternalUrl } from '../core/desktop'
import { SLOT_HITS, SLOT_SETS } from '../core/soundSlots'
import { countHitsoundRefs } from '../core/defineEdit'
import { fmtOsuTime, osuEditUrl } from '../core/time'
import { updateSectionsText } from '../core/sections'
import {
  codeGlyph,
  codeGlyphs,
  codeNameFromKey,
  isCodeName,
  normalizeCodeInput,
} from '../core/codes'
import { desktopApi } from '../core/desktop'
import { parseOsuTimeline, type OsuTimelineObject } from '../core/osuObjects'
import { copySoundToOtherChart, editHitsoundDefine } from '../core/actions'
import SectionBand from './SectionBand'
import { t as tr } from '../i18n'

interface Props {
  /** 当前文件 id：只有切文件时才重置滚动/选区（改一个字不跳） */
  fileId: string
  doc: ChartDoc
  theme: 'light' | 'dark'
  onPlaySample: (name: string, vol: number, ev?: NoteEvent) => void
}

/** 音量条：0 → 全深绿，100 → 全浅绿；越界按 0/100 夹住 */
function volumePct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)))
}

const GUTTER = 46
const GAP = 4
/** 显示「数字」时把间距拉宽，好把 2~3 位数字塞进格子左边的缝隙；音量条用普通间距 */
const GAP_VOL = 18
const ROW_GAP = 7
const PAD = 10
/** 分节符那一段的额外高度（比普通行距 7px 大很多，能放下段落名和换行标识） */
const SECTION_H = 46
/** 画笔单击的等待时间：超过这个时间没有第二次点击才当作单击（双击 = 进入双击型） */
const DBL_WAIT = 220
/** 敲代号时等下一个字母的间隔：超过就按当前前缀结算 */
const TYPE_WAIT = 800
/** [Files] ImportOsu 物件轨道：高度 + 与格子之间的小缝（开启显示时每行加高这么多） */
const OBJ_LANE_H = 18
const OBJ_LANE_GAP = 4
const OBJ_EXTRA = OBJ_LANE_H + OBJ_LANE_GAP
/** 物件轨道里小圆的半径 */
const OBJ_R = 4.2
/** 小节之间的缝隙元素宽度，与 CSS `.gd-gap { width }` 保持一致（计算物件位置要算上它） */
const GD_GAP_W = 6
/**
 * 时间对齐容差（毫秒）。
 *
 * osu 的物件时间是整数毫秒，而小节起点可能是 2758.62 这种小数（BPM 换算出来的）。
 * 严格比较时，2758ms 的物件会被判成「在上一小节/上一行」，画到上一行行尾；
 * 点小节头后 <audio>.currentTime 的亚毫秒误差也会让播放头掉回前一格。
 * 2ms 远小于一格（120BPM 的 1/4 也有一百多毫秒），不会把真正的错位吸过来。
 */
const SNAP_MS = 2

/** .osu 解析结果按路径缓存：切谱 / 改文本时不用反复读盘 */
const osuObjCache = new Map<string, OsuTimelineObject[]>()

/** 一行里的一个片段：某小节的 [from, from+count) 格 */
interface Chunk {
  mi: number
  from: number
  count: number
  total: number
  /** 所在行号 / 行内起始列 */
  row: number
  col: number
  /** 这一小节被拆成几段时的序号（1 起）与总段数 */
  part?: number
  parts?: number
}

interface Row {
  chunks: Chunk[]
  cells: number
  /** 这段小节被拆成了几行显示（>1 时标 1/3、2/3） */
  solo: boolean
  /** 这一行前面有分节符（多出一段高度，显示段落名 + 换行标识） */
  section?: SectionMark
}

/** 选中的缝隙：按 Enter 在 mi 小节前分节 */
interface GapSel {
  mi: number
  key: string
}

interface CellRef {
  row: number
  col: number
}

interface GridCell extends CellRef {
  mi: number
  k: number
}

/**
 * 已经固化的附加选区（Ctrl+拖动新增的第二个、第三个选区）。
 *
 * 端点用 `mi:k` 存而不是 row/col：改格大小、换行之后格子坐标会变，
 * 但「第几小节第几个音」不会变，选区能自动跟过去。
 */
interface SelRegion {
  aKey: string
  bKey: string
  /** true = 矩形（右键拖出来的）；false = 阅读顺序区间（左键拖出来的） */
  rect: boolean
}

/** 当前格子里已有的代号（点音效按钮时作为开关） */
function toggleName(cur: string[], name: string): string[] {
  return cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]
}

export default function GridEditor({ fileId, doc, theme, onPlaySample }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 细分/跟随统一放在 store（时间轴面板里调），格子这边只读
  const div = useStore((s) => s.div)
  const follow = useStore((s) => s.follow)
  const [cell, setCell] = useState(26)
  /** 调格大小时要固定的锚点：时间 + 它所在行的顶边相对视口的偏移 */
  const cellAnchor = useRef<{ time: number; offset: number } | null>(null)
  /** 调格大小后按时间重映射选区端点（行/列坐标会随排版变化） */
  const pendingSel = useRef<{ a: number | null; b: number | null } | null>(null)
  /** 重映射过选区后，跳过那一轮「夹选区」的被动 effect */
  const skipClamp = useRef(false)
  /** 画笔类型与锁定代号：放 store 里，切到文本再切回来不丢 */
  const brushMode = useStore((s) => s.brushMode)
  const setBrushMode = useStore((s) => s.setBrushMode)
  const brushPin = useStore((s) => s.brushPin)
  const setBrushPin = useStore((s) => s.setBrushPin)
  /** keysound 乐器下拉的选中值：'' = hitsound，其它是 `${staff}:${name}` */
  const ksInst = useStore((s) => s.ksInst)
  const setKsInst = useStore((s) => s.setKsInst)
  /** 输入范围起点（MIDI）：A~L 依次对应该音起的 12 个半音 */
  const ksBase = useStore((s) => s.ksBase)
  const setKsBase = useStore((s) => s.setKsBase)
  const [size, setSize] = useState({ w: 900, h: 360 })
  const [scrollTop, setScrollTop] = useState(0)
  /** [Files] ImportOsu 里的物件时间轴（只读参考；没配置时为空） */
  const [osuObjects, setOsuObjects] = useState<OsuTimelineObject[]>([])
  /** 选区：anchor（起点）和 focus（当前格）；两者之间的所有格子都算选中 */
  const [selA, setSelA] = useState<CellRef | null>(null)
  const [selB, setSelB] = useState<CellRef | null>(null)
  /**
   * 右键矩形框选：true 时 selA/selB 是矩形的对角，选区 = 这个矩形里的所有格子；
   * false 时按阅读顺序取区间（左键拖选 / Shift+点击的语义）。
   */
  const [rectSel, setRectSel] = useState(false)
  /**
   * Ctrl+点击选出来的零散格子（key = `mi:k`）。
   * 普通点击 / 拖选 / Shift+点击 会用区间选区覆盖掉它，和资源管理器一致。
   */
  const [extraSel, setExtraSel] = useState<Set<string>>(() => new Set())
  /** Ctrl+拖动新增的附加选区（可以有好几个；和当前活动选区一起构成多选） */
  const [extraRegions, setExtraRegions] = useState<SelRegion[]>([])
  /** 区间里被 Ctrl+点击取消掉的格子（多选区时可能不止一个） */
  const [cutSel, setCutSel] = useState<Set<string>>(() => new Set())
  /** 播放头所在格子 */
  const [play, setPlay] = useState<CellRef | null>(null)
  /** 上次用的查找条件（关掉再打开时留着，省得重敲） */
  const lastFind = useRef({ find: '', repl: '', exact: false, onlyMatched: true })
  /** 查找替换弹窗 */
  const openFind = () => setFindDlg((d) => d ?? { ...lastFind.current })
  const [findDlg, setFindDlg] = useState<{
    find: string
    repl: string
    exact: boolean
    onlyMatched: boolean
  } | null>(null)

  /** 关掉弹窗，顺手记住这次的查找条件 */
  const closeFind = () => {
    if (findDlg) {
      lastFind.current = {
        find: findDlg.find,
        repl: findDlg.repl,
        exact: findDlg.exact,
        onlyMatched: findDlg.onlyMatched,
      }
    }
    setFindDlg(null)
  }
  /** 右键「修改音量」的输入框（cells 是这次要改的格子：单选是一整段，多选是选中的那些） */
  const [volDlg, setVolDlg] = useState<{ cells: { mi: number; k: number }[]; value: string; span: boolean } | null>(
    null,
  )
  /** 当前选中的缝隙（点一下，按 Enter 分节） */
  const [selGap, setSelGap] = useState<GapSel | null>(null)
  /** 刚创建的分节符时间：让它的段落名输入框自动聚焦 */
  const [focusSection, setFocusSection] = useState<number | null>(null)
  /**
   * 拖选状态：按下时记锚点，拖到别的格子才算拖动（拖动不落笔）。
   * additive = 按着 Ctrl：拖出去是「再选一个选区」，没拖则是切换单格。
   */
  const dragRef = useRef<{ active: boolean; moved: boolean; anchor: CellRef; additive?: boolean } | null>(
    null,
  )
  /** 拖选时最后一次经过的格子（mouseup 时用它定位） */
  const focusRef = useRef<CellRef | null>(null)
  /**
   * 右键框选：按下时只记锚点，跨到别的格子才算「拖动」。
   * 拖动结束不弹菜单（见 suppressContext），原位右键（没拖）照常弹。
   * additive = Ctrl：保留已有选区，再框一个矩形。
   */
  const rightDrag = useRef<{ anchor: CellRef; moved: boolean; additive?: boolean } | null>(null)
  /** 刚做完右键框选 → 吞掉随后那一次 contextmenu；下一次右键才弹菜单 */
  const suppressContext = useRef(false)
  /** 画笔单击延时：等一下看是不是双击 */
  const brushTimer = useRef<number | null>(null)
  /** 等待执行的单击动作（快速连点不同音效时先把它 flush 掉，不能丢） */
  const pendingBrush = useRef<{ name: string; wasDouble: boolean; samePin: boolean } | null>(null)
  /**
   * 画笔栏拖动排序：按下时先只记起点，超过阈值才算「拖动」。
   * 不这样做的话，已有的单击/双击落笔逻辑会被拖动吞掉。
   */
  const brushesRef = useRef<HTMLDivElement>(null)
  const brushPress = useRef<{ name: string; x: number; y: number; active: boolean } | null>(null)
  /** 拖动中的视觉状态（只在插入点变化时 setState，拖过格子时别每帧重渲染整张谱） */
  const [brushDrag, setBrushDrag] = useState<{ name: string; drop: number } | null>(null)
  const dragDropRef = useRef<number | null>(null)
  /** 拖动结束后浏览器还会补一个 click，用它吞掉（否则会误落笔） */
  const suppressBrushClick = useRef(false)

  const P = rhythmPalette(theme)
  // 订阅一下这个版本号：设置里改了显示偏好后能立刻重排（间距/标签）
  useStore((s) => s.uiRev)
  const prefs = getDisplayPrefs()
  const volMode = prefs.volumeDisplay
  /** 有 ImportOsu 物件、且设置里开着「显示物件时间轴」时才占额外行高 */
  const showOsuObjects = prefs.showOsuObjects && osuObjects.length > 0
  const rowH = cell + ROW_GAP + (showOsuObjects ? OBJ_EXTRA : 0)
  /** 只有「显示数字」需要加宽间距，音量条和不显示都用紧凑排列 */
  const gap = volMode === 'number' ? GAP_VOL : GAP

  // 默认色（没配色时用的 accent）要从 CSS 变量取，canvas 之外的 DOM 也想用同一个色
  const accentHex = useMemo(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '#3b82f6'
  }, [theme])

  /** 每个小节按当前细分展开的刻度时间（和解析器同一套拍位算法） */
  const ticksByMeasure = useMemo(
    () => doc.measures.map((m) => measureTicks(m, div)),
    [doc.measures, div],
  )

  /**
   * [Files] ImportOsu：把原谱 .osu 的物件时间轴读进来（只读参考）。
   * 按解析后的完整路径缓存，切谱/改文本不会反复读盘。
   */
  const importOsuPath = doc.importOsuPath || ''
  useEffect(() => {
    if (!importOsuPath) {
      setOsuObjects([])
      return
    }
    const cached = osuObjCache.get(importOsuPath)
    if (cached) {
      setOsuObjects(cached)
      return
    }
    setOsuObjects([])
    const api = desktopApi()
    if (!api) return
    let dead = false
    void api.readText(importOsuPath).then((r) => {
      if (dead) return
      const st = useStore.getState()
      if (!r.ok || !r.text) {
        st.log(`✗ 读取 ImportOsu 失败：${r.error || importOsuPath}`)
        return
      }
      const parsed = parseOsuTimeline(r.text)
      if (!parsed.objects.length) {
        st.log(`⚠ ImportOsu：${parsed.error || '没有可用物件'}`)
        return
      }
      osuObjCache.set(importOsuPath, parsed.objects)
      setOsuObjects(parsed.objects)
      const name = importOsuPath.replace(/\\/g, '/').split('/').pop()
      st.log(`ImportOsu：${name} · ${parsed.objects.length} 个物件${parsed.error ? `（${parsed.error}）` : ''}`)
    })
    return () => {
      dead = true
    }
  }, [importOsuPath])

  /**
   * 格子上方可切换的乐器：优先 [Keysound] 首行的谱表列表，
   * 没写这个段就退回 [Define] 里定义过的 keysound 名（按定义顺序当谱表 0、1…）。
   */
  const ksOptions = useMemo(() => {
    const out: { name: string; staff: number }[] = []
    for (const k of doc.keyInstruments) {
      if (out.some((o) => o.name === k.name && o.staff === k.staff)) continue
      out.push({ name: k.name, staff: k.staff })
    }
    if (!out.length) {
      let staff = 0
      for (const h of doc.hitsounds) {
        if (h.kind !== 'keysound' || !h.name) continue
        out.push({ name: h.name, staff: staff++ })
      }
    }
    return out
  }, [doc])

  /** 当前 keysound 选择（null = hitsound 模式） */
  const ksSel = useMemo(() => ksOptions.find((o) => `${o.staff}:${o.name}` === ksInst) || null, [ksOptions, ksInst])
  /** 写回目标（hitsound 模式为 undefined） */
  const ksTarget = (): GridEditTarget | undefined =>
    ksSel
      ? {
          mode: 'keysound',
          staff: ksSel.staff,
          instrument: ksSel.name,
          instruments: ksOptions.map((o) => o.name),
        }
      : undefined

  /** 下拉里的乐器已经从谱面里消失 → 回到 hitsound */
  useEffect(() => {
    if (ksInst && !ksOptions.some((o) => `${o.staff}:${o.name}` === ksInst)) setKsInst('')
  }, [ksInst, ksOptions, setKsInst])

  /** 音效设置里列出的定义：只列 hitsound（keysound 走上面的乐器下拉） */
  const hsDefs = useMemo(
    () => doc.hitsounds.filter((h): h is HitsoundDef & { name: string } => h.kind === 'hitsound' && !!h.name),
    [doc],
  )

  /** 一条定义占用的槽位（custom 就是空数组） */
  const slotsOfDef = (h: HitsoundDef): string[] =>
    h.alts.filter((a) => !a.custom && a.sampleSet && a.hitType).map((a) => `${a.sampleSet}-${a.hitType}`)

  /** 音效设置弹窗：sel = 正在编辑哪一条（原代号） */
  const [defDlg, setDefDlg] = useState<{
    sel: string
    name: string
    slots: string[]
    /** 颜色输入框的内容（'' = 默认色） */
    color: string
  } | null>(null)
  const [defMsg, setDefMsg] = useState('')

  const openDefSettings = () => {
    const first = hsDefs[0]
    setDefMsg('')
    setDefDlg(
      first
        ? { sel: first.name, name: first.name, slots: slotsOfDef(first), color: first.color?.toUpperCase() || '' }
        : { sel: '', name: '', slots: [], color: '' },
    )
  }

  const pickDef = (h: HitsoundDef) => {
    if (!h.name) return
    setDefMsg('')
    setDefDlg({ sel: h.name, name: h.name, slots: slotsOfDef(h), color: h.color?.toUpperCase() || '' })
  }

  const toggleDefSlot = (slot: string) => {
    setDefMsg('')
    setDefDlg((d) =>
      d ? { ...d, slots: d.slots.includes(slot) ? d.slots.filter((x) => x !== slot) : [...d.slots, slot] } : d,
    )
  }

  /** 试听：绑定过的样本直接播；`default.xxx` 走内置 wav */
  const previewDef = async (h: HitsoundDef) => {
    setDefMsg('')
    if (h.defaultRef) {
      const ok = await engine.previewDefault(h.defaultRef)
      if (!ok) setDefMsg(tr('这个代号还没有绑定音频文件，去「音效库」选一个'))
      return
    }
    if (h.name && !engine.playSample(h.name, 100))
      setDefMsg(tr('这个代号还没有绑定音频文件，去「音效库」选一个'))
  }

  /** 正文里这个代号出现了多少次（改名前先让人看见影响范围） */
  const defRefs = useMemo(() => countHitsoundRefs(doc, defDlg?.sel || ''), [doc, defDlg?.sel])

  const defNextName = (defDlg?.name ?? '').trim()
  const defDup = !!defDlg && defNextName !== defDlg.sel && hsDefs.some((h) => h.name === defNextName)
  const defNameOk = isCodeName(defNextName)
  const defColorText = (defDlg?.color ?? '').trim()
  const defColor = defColorText ? parseColorToken(defColorText) : null
  const defColorOk = !defColorText || !!defColor
  const defCanApply = !!defDlg?.sel && defNameOk && !defDup && defColorOk

  const applyDefEdit = () => {
    if (!defDlg?.sel || !defCanApply) return
    const res = editHitsoundDefine(defDlg.sel, {
      name: defNextName,
      slots: defDlg.slots,
      // '' 表示把颜色删掉（回到默认色）
      color: defColorText ? defColorText : null,
    })
    if (!res.ok) {
      setDefMsg(res.error || tr('修改失败'))
      return
    }
    // 双击型正锁着旧代号的话，跟着改名，别让画笔失效
    if (defNextName !== defDlg.sel && brushPin === defDlg.sel) setBrushPin(defNextName)
    setDefDlg({
      sel: defNextName,
      name: defNextName,
      slots: defDlg.slots,
      color: defColor ? defColor.toUpperCase() : '',
    })
    setDefMsg(
      res.changes
        ? tr('已更新 {name}：正文同步了 {n} 处', { name: defNextName, n: res.changes })
        : tr('已更新 {name}', { name: defNextName }),
    )
  }

  /** Esc 关掉音效设置弹窗（捕获阶段，别让网格的键盘处理抢走） */
  useEffect(() => {
    if (!defDlg) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setDefDlg(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [defDlg])

  /**
   * 整台 88 键（A0–C8）：白键固定宽度，窗口放不下就横向滚动。
   * `whiteIndex` 用来把当前八度滚进视野。
   */
  const pianoKeys = useMemo(() => {
    const list: {
      midi: number
      name: string
      black: boolean
      key: string
      left: number
      width: number
      whiteIndex: number
    }[] = []
    let wi = 0
    for (let midi = PIANO_LOW; midi <= PIANO_HIGH; midi++) {
      const black = isBlackKey(midi)
      const pc = ((midi % 12) + 12) % 12
      list.push({
        midi,
        name: midiToName(midi),
        black,
        // A~L 直接绑音名：C H D I E F J G K A L B
        key: semiToLetter(pc),
        whiteIndex: wi,
        left: black ? wi * PIANO_WHITE_W - PIANO_BLACK_W / 2 : wi * PIANO_WHITE_W,
        width: black ? PIANO_BLACK_W : PIANO_WHITE_W,
      })
      if (!black) wi++
    }
    return { list, width: wi * PIANO_WHITE_W, whiteCount: wi }
  }, [])

  /** 某个 MIDI 前面有几个白键（滚动定位用） */
  const pianoWhiteIndex = (midi: number): number => {
    const k = pianoKeys.list.find((x) => x.midi === midi)
    return k ? k.whiteIndex : 0
  }

  /**
   * 快捷键输入范围的框：当前八度 C → 下一个 C 的左边缘。
   * 用白键序号算宽度，黑键跨在白键缝上也不会偏。
   */
  const octLo = Math.max(PIANO_LOW, Math.min(PIANO_HIGH, ksBase))
  const octLeft = pianoWhiteIndex(octLo) * PIANO_WHITE_W
  const octRight =
    octLo + 12 <= PIANO_HIGH ? pianoWhiteIndex(octLo + 12) * PIANO_WHITE_W : pianoKeys.width
  const octWidth = Math.max(PIANO_WHITE_W, octRight - octLeft)

  const pianoRef = useRef<HTMLDivElement>(null)
  const [pianoNav, setPianoNav] = useState({ left: false, right: false })

  const syncPianoNav = () => {
    const el = pianoRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setPianoNav({ left: el.scrollLeft > 1, right: max > 1 && el.scrollLeft < max - 1 })
  }

  useEffect(() => {
    syncPianoNav()
    const onResize = () => syncPianoNav()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [ksSel])

  /** ◀▶ / Ctrl+←→：滚动可见区域（只动视野，不改音高） */
  const scrollPiano = (dir: -1 | 1) => {
    const el = pianoRef.current
    if (!el) return
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + dir * PIANO_WHITE_W * 7))
  }

  /** 换八度 / 切到钢琴模式：把这一组 12 个键滚进视野（用户手动滚走后不硬拉回来） */
  useEffect(() => {
    const el = pianoRef.current
    if (!el || !ksSel) return
    const x = pianoWhiteIndex(ksBase) * PIANO_WHITE_W
    const w = 7 * PIANO_WHITE_W
    if (x >= el.scrollLeft - 2 && x + w <= el.scrollLeft + el.clientWidth + 2) return
    el.scrollLeft = Math.max(0, x - (el.clientWidth - w) / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ksBase, ksSel])

  /** 点琴键：落笔，并把这组八度设成当前输入八度（之后按 A~L 就在同一八度） */
  const pickPianoKey = (midi: number) => {
    const pc = ((midi % 12) + 12) % 12
    const start = midi - pc
    if (start >= 24 && start <= PIANO_HIGH && start !== ksBase) setKsBase(start)
    applyNote(midi)
  }

  /** 每一格上的音效（键：`小节下标:格下标`） */
  const eventsByCell = useMemo(() => {
    const map = new Map<string, NoteEvent[]>()
    const push = (mi: number, k: number, e: NoteEvent) => {
      const key = `${mi}:${k}`
      const arr = map.get(key)
      if (arr) arr.push(e)
      else map.set(key, [e])
    }
    for (const e of doc.events) {
      if (ksSel) {
        // 只看当前乐器的谱表：其它谱表 / hitsound 都不显示（和分谱表编辑一致）
        if (e.kind !== 'keysound' || (e.staff ?? 0) !== ksSel.staff) continue
      } else if (e.kind === 'keysound') continue
      const mi = e.measure - 1
      const ticks = ticksByMeasure[mi]
      if (!ticks || !ticks.length) continue
      // 落在哪一格：最后一个「起点 <= 事件时间」的刻度
      let lo = 0
      let hi = ticks.length - 1
      let k = 0
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (ticks[mid] <= e.time + 0.5) {
          k = mid
          lo = mid + 1
        } else hi = mid - 1
      }
      // osu 的时间是整数毫秒，拍点常带小数（92270.873 → 92270）。
      // 落在下一格前 2ms 内的音符，显示也吸到下一格，和读格/写回的 Math.round 保持一致。
      if (k + 1 < ticks.length && ticks[k + 1] - e.time <= SNAP_MS) k++
      push(mi, k, e)
    }
    return map
  }, [doc.events, ticksByMeasure, ksSel])

  /**
   * 红线（[Timing] 的 BPM 行）和蓝线（[Settings] Bookmarks）落在哪一格。
   *
   * 判定用「最后一个起点 <= 时间」的格子；时间正好落在下一小节/下一行的起点时，
   * +1ms 的容差会把它算到后面那一格 —— 也就是「换行处显示在下一行左侧」。
   */
  const marksByCell = useMemo(() => {
    const map = new Map<string, { red?: number; blue?: number }>()
    const put = (t: number, kind: 'red' | 'blue') => {
      const ms = doc.measures
      if (!ms.length || !Number.isFinite(t)) return
      if (t < ms[0].start - 1) return
      let lo = 0
      let hi = ms.length - 1
      let mi = 0
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (ms[mid].start <= t + 1) {
          mi = mid
          lo = mid + 1
        } else hi = mid - 1
      }
      const ticks = ticksByMeasure[mi]
      if (!ticks || !ticks.length) return
      let k = 0
      for (let i = 0; i < ticks.length; i++) {
        if (ticks[i] <= t + 1) k = i
        else break
      }
      const key = `${mi}:${k}`
      const cur = map.get(key) || {}
      if (kind === 'red') cur.red = t
      else cur.blue = t
      map.set(key, cur)
    }
    for (const tp of doc.timing) put(tp.offset, 'red')
    for (const b of doc.settings.Bookmarks || []) put(b, 'blue')
    return map
  }, [doc, ticksByMeasure])

  /** keysound 音符颜色：按音高类取一个色相（同名音在任何八度颜色一致） */
  const noteColor = (name: string): string => {
    const m = nameToMidi(name)
    if (m == null) return accentHex
    const pc = ((m % 12) + 12) % 12
    return `hsl(${(pc * 30 + 205) % 360} 62% 52%)`
  }

  /** 代号 -> 自定义颜色 */
  const colorByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of doc.hitsounds) if (h.name && h.color) m.set(h.name, h.color)
    return m
  }, [doc])

  /**
   * 分节符落在哪一小节前。时间按毫秒存（可能被取整过），
   * 所以找「起点最接近」的小节，容差 2ms。
   */
  const sectionByMeasure = useMemo(() => {
    const map = new Map<number, SectionMark>()
    const ms = doc.measures
    if (!ms.length) return map
    for (const s of doc.settings.Sections || []) {
      let lo = 0
      let hi = ms.length - 1
      let best = -1
      let bestD = Infinity
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const d = ms[mid].start - s.time
        const ad = Math.abs(d)
        if (ad < bestD) {
          bestD = ad
          best = mid
        }
        if (d < 0) lo = mid + 1
        else if (d > 0) hi = mid - 1
        else break
      }
      if (best >= 0 && bestD <= 2) map.set(best, s)
    }
    return map
  }, [doc.measures, doc.settings.Sections])

  /** 排版：先按小节切片，再把切片塞进行 */
  const layout = useMemo(() => {
    const avail = Math.max(80, size.w - GUTTER - PAD * 2)
    const maxCells = Math.max(1, Math.floor((avail + gap) / (cell + gap)))
    const rows: Row[] = []
    /** 小节下标 -> 该小节占用的切片（用于播放头/选中定位） */
    const byMeasure = new Map<number, Chunk[]>()

    let cur: Row | null = null
    const startRow = (section?: SectionMark): Row => {
      const r: Row = { chunks: [], cells: 0, solo: false, section }
      rows.push(r)
      return r
    }

    for (let mi = 0; mi < doc.measures.length; mi++) {
      const ticks = ticksByMeasure[mi]
      const total = ticks ? ticks.length : 0
      if (!total) continue
      const sec = sectionByMeasure.get(mi)
      // 分节符：这一小节必须从新行开始
      if (sec && cur && cur.cells > 0) cur = null

      if (total <= maxCells) {
        // 整小节一行一个块；放不下就换行（保证一行里都是完整小节）
        if (!cur || cur.cells + total > maxCells) cur = startRow(sec)
        const row: Row = cur
        const ch: Chunk = { mi, from: 0, count: total, total, row: rows.length - 1, col: row.cells, part: 1, parts: 1 }
        row.chunks.push(ch)
        row.cells += total
        byMeasure.set(mi, [ch])
      } else {
        // 一小节比整行还宽：拆成多行，优先按整拍切（div 格 = 1 拍）
        let per = Math.floor(maxCells / div) * div
        if (per < 1) per = maxCells
        const list: Chunk[] = []
        let firstPart = true
        for (let from = 0; from < total; from += per) {
          const row = startRow(firstPart ? sec : undefined)
          firstPart = false
          row.solo = true
          const ch: Chunk = {
            mi,
            from,
            count: Math.min(per, total - from),
            total,
            row: rows.length - 1,
            col: 0,
            part: list.length + 1,
          }
          row.chunks.push(ch)
          row.cells = ch.count
          list.push(ch)
          cur = null
        }
        for (const ch of list) ch.parts = list.length
        byMeasure.set(mi, list)
      }
    }
    return { rows, byMeasure, maxCells }
  }, [doc.measures, ticksByMeasure, div, cell, size.w, sectionByMeasure, gap])

  function chunkOf(row: number, col: number): Chunk | null {
    const r = layout.rows[row]
    if (!r) return null
    let acc = 0
    for (const ch of r.chunks) {
      if (col < acc + ch.count) return ch
      acc += ch.count
    }
    return r.chunks[r.chunks.length - 1] ?? null
  }

  /** 每行第一个格子在整份谱里的序号（用来比较选区先后） */
  const rowStart = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const r of layout.rows) {
      out.push(acc)
      acc += r.cells
    }
    return out
  }, [layout])

  /** 每行覆盖的时间范围（ImportOsu 物件轨道按它筛物件） */
  const rowSpans = useMemo(() => {
    return layout.rows.map((r) => {
      const first = r.chunks[0]
      const last = r.chunks[r.chunks.length - 1]
      const ft = ticksByMeasure[first.mi] || []
      const lt = ticksByMeasure[last.mi] || []
      const start = ft[first.from] ?? doc.measures[first.mi]?.start ?? 0
      const lastK = last.from + last.count - 1
      const m = doc.measures[last.mi]
      const end = lastK + 1 < lt.length ? lt[lastK + 1] : (m?.end ?? (lt[lastK] ?? start) + 500)
      return { start, end }
    })
  }, [layout, ticksByMeasure, doc.measures])

  /**
   * 物件按「覆盖到哪几行」分组：跨行的滑条/转盘会同时出现在多行里，
   * 每行只画到行尾（下一行接着画），不再只在起点那一行画完。
   */
  const objectsByRow = useMemo(() => {
    const map = new Map<number, OsuTimelineObject[]>()
    if (!osuObjects.length || !rowSpans.length) return map
    for (const o of osuObjects) {
      let lo = 0
      let hi = rowSpans.length - 1
      let ri = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (rowSpans[mid].start <= o.start + SNAP_MS) {
          ri = mid
          lo = mid + 1
        } else hi = mid - 1
      }
      if (ri < 0) continue
      // 超出最后一行末尾的物件不画（网格没铺到那么远）
      if (o.start >= rowSpans[ri].end - SNAP_MS) continue
      for (let r = ri; r < rowSpans.length; r++) {
        // 起点所在行一定要放（circle 的 start 和 end 相同）；之后的续行才看是否已经结束
        if (r > ri && rowSpans[r].start >= o.end - SNAP_MS) break
        const arr = map.get(r)
        if (arr) arr.push(o)
        else map.set(r, [o])
      }
    }
    return map
  }, [osuObjects, rowSpans])

  const ordOf = (p: CellRef | null) => (p ? (rowStart[p.row] ?? 0) + p.col : -1)

  const cellAtOrd = (ord: number): CellRef | null => {
    for (let ri = 0; ri < layout.rows.length; ri++) {
      if (ord < rowStart[ri] + layout.rows[ri].cells) return { row: ri, col: ord - rowStart[ri] }
    }
    return null
  }

  /** 两个格子之间（按全谱格子顺序）的所有格子 */
  const cellsBetween = (a: CellRef, b: CellRef): GridCell[] => {
    const oa = ordOf(a)
    const ob = ordOf(b)
    const from = Math.min(oa, ob)
    const to = Math.max(oa, ob)
    const out: GridCell[] = []
    for (let ri = 0; ri < layout.rows.length; ri++) {
      const start = rowStart[ri]
      const count = layout.rows[ri].cells
      if (start + count - 1 < from) continue
      if (start > to) break
      const c0 = Math.max(0, from - start)
      const c1 = Math.min(count - 1, to - start)
      for (let col = c0; col <= c1; col++) {
        const ch = chunkOf(ri, col)
        if (!ch) continue
        out.push({ row: ri, col, mi: ch.mi, k: ch.from + (col - ch.col) })
      }
    }
    return out
  }

  /** 从某格开始往后数 count 格（粘贴多格时用） */
  const cellsFrom = (start: GridCell, count: number): GridCell[] => {
    if (!layout.rows.length) return []
    const lastRow = layout.rows.length - 1
    const total = rowStart[lastRow] + layout.rows[lastRow].cells
    const from = ordOf(start)
    const to = Math.min(total - 1, from + count - 1)
    const end = cellAtOrd(to)
    if (!end) return []
    return cellsBetween(start, end)
  }

  /** 矩形框选的对角范围（只在 rectSel 时有效；渲染时逐格判断用） */
  const rectRange = useMemo(() => {
    if (!rectSel || !selA || !selB) return null
    return {
      r0: Math.min(selA.row, selB.row),
      r1: Math.max(selA.row, selB.row),
      c0: Math.min(selA.col, selB.col),
      c1: Math.max(selA.col, selB.col),
    }
  }, [rectSel, selA, selB])

  /** `mi:k` → 格子（零散选择靠它找回视觉坐标） */
  const cellByKey = useMemo(() => {
    const m = new Map<string, GridCell>()
    for (let ri = 0; ri < layout.rows.length; ri++) {
      const n = layout.rows[ri].cells
      for (let col = 0; col < n; col++) {
        const ch = chunkOf(ri, col)
        if (!ch) continue
        const k = ch.from + (col - ch.col)
        m.set(`${ch.mi}:${k}`, { row: ri, col, mi: ch.mi, k })
      }
    }
    return m
  }, [layout])

  /** 行/列坐标 → `mi:k`（固化选区时用） */
  const keyOfPos = (p: CellRef): string | null => {
    const ch = chunkOf(p.row, p.col)
    if (!ch) return null
    return `${ch.mi}:${ch.from + (p.col - ch.col)}`
  }

  /** 一个已固化的附加选区包含哪些格子（矩形的按行列取，线性的按阅读顺序取） */
  const regionCells = (r: SelRegion): GridCell[] => {
    const a = cellByKey.get(r.aKey)
    const b = cellByKey.get(r.bKey)
    if (!a || !b) return []
    if (!r.rect) return cellsBetween(a, b)
    const out: GridCell[] = []
    const r0 = Math.min(a.row, b.row)
    const r1 = Math.max(a.row, b.row)
    const c0 = Math.min(a.col, b.col)
    const c1 = Math.max(a.col, b.col)
    for (let ri = r0; ri <= r1; ri++) {
      const n = layout.rows[ri]?.cells ?? 0
      const cmax = Math.min(c1, n - 1)
      for (let col = c0; col <= cmax; col++) {
        const ch = chunkOf(ri, col)
        if (ch) out.push({ row: ri, col, mi: ch.mi, k: ch.from + (col - ch.col) })
      }
    }
    return out
  }

  /** 当前正在拖/刚点出来的活动选区 */
  const activeCells = useMemo(() => {
    if (rectRange) {
      const out: GridCell[] = []
      for (let ri = rectRange.r0; ri <= rectRange.r1; ri++) {
        const n = layout.rows[ri]?.cells ?? 0
        const cmax = Math.min(rectRange.c1, n - 1)
        for (let col = rectRange.c0; col <= cmax; col++) {
          const ch = chunkOf(ri, col)
          if (ch) out.push({ row: ri, col, mi: ch.mi, k: ch.from + (col - ch.col) })
        }
      }
      return out
    }
    return selA && selB ? cellsBetween(selA, selB) : []
  }, [rectRange, selA, selB, layout])

  /**
   * 全部选中的格子 = 活动选区 + 所有附加选区 + Ctrl+点出来的零散格子，
   * 再去掉 Ctrl+点击取消掉的格。多块选区按时间排序合并成一份，复制/清空都走它。
   */
  const selCells = useMemo(() => {
    const seen = new Set<string>()
    const out: GridCell[] = []
    const add = (cells: GridCell[]) => {
      for (const c of cells) {
        const key = `${c.mi}:${c.k}`
        if (seen.has(key) || cutSel.has(key)) continue
        seen.add(key)
        out.push(c)
      }
    }
    add(activeCells)
    for (const r of extraRegions) add(regionCells(r))
    if (extraSel.size) {
      for (const key of extraSel) {
        const c = cellByKey.get(key)
        if (c) add([c])
      }
    }
    return out.sort((a, b) => ordOf(a) - ordOf(b))
  }, [activeCells, extraRegions, extraSel, cutSel, cellByKey, layout, rowStart])

  /** 选中格子的 `mi:k` 集合：右键判断「点的是不是选区内」用（矩形选区也适用） */
  const selKeys = useMemo(() => new Set(selCells.map((c) => `${c.mi}:${c.k}`)), [selCells])

  /**
   * 把当前活动选区固化成「附加选区」。
   * Ctrl+拖动开始一个新选区前调用 —— 上一个选区就这样留下来，不会被覆盖。
   */
  const commitActive = () => {
    if (!selA || !selB) return
    const aKey = keyOfPos(selA)
    const bKey = keyOfPos(selB)
    if (!aKey || !bKey) return
    setExtraRegions((prev) => [...prev, { aKey, bKey, rect: rectSel }])
  }

  /**
   * Ctrl+点击（没有拖动）：切换这一格的选中状态。
   * 之前选中的块保持不动，只把这格加进去 / 从里面拿掉。
   */
  const toggleCellSel = (row: number, col: number) => {
    const ch = chunkOf(row, col)
    if (!ch) return
    const key = `${ch.mi}:${ch.from + (col - ch.col)}`
    const had = selKeys.has(key)
    // 先把上一个选区固化，游标再落到这一格（否则旧区间会被新锚点带歪）
    commitActive()
    setRectSel(false)
    const p = { row, col }
    setSelA(p)
    setSelB(p)
    focusRef.current = p
    const t = timeAt(row, col)
    if (t != null) engine.seek(t)
    if (had) {
      setCutSel((prev) => new Set(prev).add(key))
      setExtraSel((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    } else {
      setCutSel((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      setExtraSel((prev) => new Set(prev).add(key))
    }
  }

  /**
   * 查找替换的范围：多选（>= 2 格）时只在选中的格子里找；
   * 没选或只选了 1 格时按整份谱处理 —— 点一下格子通常只是为了定位，
   * 不该把查找范围悄悄缩到那一格（真缩了会让人以为「找不到」）。
   */
  const findScope = useMemo(() => {
    if (selCells.length <= 1) return null
    return new Set(selCells.map((c) => `${c.mi}:${c.k}`))
  }, [selCells])

  /** 普通点击 / 拖选 / Shift 连选会覆盖掉所有附加选区 */
  const clearMulti = () => {
    if (extraRegions.length) setExtraRegions([])
    if (extraSel.size) setExtraSel(new Set())
    if (cutSel.size) setCutSel(new Set())
  }

  /** 每格的生效音量 / 需要显示 `<v=xx>` 的格子 */
  /** 查找命中的格子（弹窗打开时实时算，顺手给格子加高亮） */
  const findInfo = useMemo(() => {
    if (!findDlg) return null
    const find = parseCodes(findDlg.find)
    const repl = parseCodes(findDlg.repl)
    const scope = findScope
    if (!find.length)
      return { find, repl, hits: [] as { mi: number; k: number }[], total: 0, changed: 0, scope: scope?.size ?? 0 }
    const hits: { mi: number; k: number }[] = []
    let changed = 0
    const consider = (mi: number, k: number) => {
      const evs = eventsByCell.get(`${mi}:${k}`)
      if (!evs?.length) return
      const names = [...new Set(evs.flatMap((e) => e.names).filter(Boolean))]
      if (!matchCell(names, find, findDlg.exact)) return
      hits.push({ mi, k })
      const next = replaceCell(names, find, repl, findDlg.exact, findDlg.onlyMatched)
      // 顺序也算「变了」，否则 [A B] 换成 [B A] 会被当成没变
      if (next.join('\u0000') !== names.join('\u0000')) changed++
    }
    if (scope) {
      // 多选：只扫选中的格子（按时间顺序，和 selCells 一致）
      for (const key of scope) {
        const [mi, k] = key.split(':').map(Number)
        consider(mi, k)
      }
    } else {
      for (let mi = 0; mi < doc.measures.length; mi++) {
        const ticks = ticksByMeasure[mi] || []
        for (let k = 0; k < ticks.length; k++) consider(mi, k)
      }
    }
    return { find, repl, hits, total: hits.length, changed, scope: scope?.size ?? 0 }
  }, [findDlg, doc, ticksByMeasure, eventsByCell, findScope])

  /** `mi:k` → 命中格子（渲染时加高亮） */
  const findHits = useMemo(() => new Set((findInfo?.hits || []).map((h) => `${h.mi}:${h.k}`)), [findInfo])

  const volInfo = useMemo(() => {
    const at = new Map<string, number>()
    const mark = new Map<string, number>()
    let carry = 100
    for (let mi = 0; mi < doc.measures.length; mi++) {
      const ticks = ticksByMeasure[mi] || []
      const marks = measureVolumeMarks(doc, mi, div, ksTarget())
      for (let k = 0; k < ticks.length; k++) {
        const key = `${mi}:${k}`
        // 正文里写了 <v=xx> 的位置优先（哪怕这一格是空的）
        const mk = marks.get(k)
        if (mk !== undefined) {
          carry = mk
          mark.set(key, mk)
        }
        const evs = eventsByCell.get(key)
        if (evs?.length) carry = evs[0].volume
        at.set(key, carry)
      }
    }
    return { at, mark }
  }, [doc, eventsByCell, ticksByMeasure, div, ksSel])

  /** 选区里出现过的代号（画笔按钮右下角的小绿勾） */
  const namesInSel = useMemo(() => {
    const set = new Set<string>()
    for (const c of selCells) {
      const evs = eventsByCell.get(`${c.mi}:${c.k}`)
      if (!evs) continue
      for (const e of evs) for (const n of e.names) set.add(n)
    }
    return set
  }, [selCells, eventsByCell])

  const selTimes = useMemo(() => {
    if (!selCells.length) return null
    const first = selCells[0]
    const last = selCells[selCells.length - 1]
    return {
      t0: ticksByMeasure[first.mi]?.[first.k] ?? 0,
      t1: ticksByMeasure[last.mi]?.[last.k] ?? 0,
    }
  }, [selCells, ticksByMeasure])

  /** 小节下标 + 小节内格号 → 视觉坐标 */
  const locate = (mi: number, k: number) => {
    const list = layout.byMeasure.get(mi)
    if (!list) return null
    for (const ch of list) {
      if (k >= ch.from && k < ch.from + ch.count) {
        return { row: ch.row, col: ch.col + (k - ch.from), chunk: ch }
      }
    }
    const last = list[list.length - 1]
    return { row: last.row, col: last.col + last.count - 1, chunk: last }
  }

  /** 视觉坐标 → 时间 */
  const timeAt = (row: number, col: number): number | null => {
    const r = layout.rows[row]
    if (!r) return null
    let acc = 0
    for (const ch of r.chunks) {
      if (col < acc + ch.count) {
        const ticks = ticksByMeasure[ch.mi]
        const k = ch.from + (col - acc)
        return ticks?.[k] ?? null
      }
      acc += ch.count
    }
    const last = r.chunks[r.chunks.length - 1]
    const ticks = ticksByMeasure[last.mi]
    return ticks?.[last.from + last.count - 1] ?? null
  }

  /** 时间 → 视觉坐标（播放头用） */
  const locateTime = (t: number): { row: number; col: number } | null => {
    const ms = doc.measures
    if (!ms.length) return null
    let lo = 0
    let hi = ms.length - 1
    let mi = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (ms[mid].start <= t + SNAP_MS) {
        mi = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const ticks = ticksByMeasure[mi]
    if (!ticks || !ticks.length) return null
    let k = 0
    for (let i = 0; i < ticks.length; i++) {
      if (ticks[i] <= t + SNAP_MS) k = i
      else break
    }
    const at = locate(mi, k)
    return at ? { row: at.row, col: at.col } : null
  }

  // 尺寸变化（面板拉高/拉宽）
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(240, r.width), h: Math.max(120, r.height) })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: Math.max(240, r.width), h: Math.max(120, r.height) })
    return () => ro.disconnect()
  }, [])

  // 换文件时回到开头；不预选格子（单击型要求「先点网格」，没点之前不该有落笔目标）
  useEffect(() => {
    setSelA(null)
    setSelB(null)
    // 附加选区/零散格子也要清掉：`mi:k` 在新谱里指向的完全是别的音
    clearMulti()
    setRectSel(false)
    focusRef.current = null
    setScrollTop(0)
    const el = wrapRef.current
    if (el) el.scrollTop = 0
  }, [fileId])

  // 细分/窗口变化后，选区可能落到不存在的格子上：夹回去；
  // 调格大小时则按时间重新定位（行/列含义变了，单纯夹会造成选区跳到别的音）
  useEffect(() => {
    if (!layout.rows.length) return
    // 调格大小时刚按时间重映射过选区，这一轮不要再用旧坐标夹
    if (skipClamp.current) {
      skipClamp.current = false
      return
    }
    const clamp = (p: CellRef | null): CellRef | null => {
      if (!p) return null
      const row = Math.min(p.row, layout.rows.length - 1)
      const cells = layout.rows[row].cells
      const col = Math.min(Math.max(0, p.col), Math.max(0, cells - 1))
      return row === p.row && col === p.col ? p : { row, col }
    }
    const a = clamp(selA)
    const b = clamp(selB)
    if (a !== selA) setSelA(a)
    if (b !== selB) setSelB(b)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // 播放头：只在「跨格」时 setState，避免每帧重渲染上千个格子
  useEffect(() => {
    let raf = 0
    let last = ''
    const loop = () => {
      const t = engine.nowMs()
      const at = locateTime(t)
      const key = at ? `${at.row}:${at.col}` : ''
      if (key !== last) {
        last = key
        setPlay(at)
        if (follow && engine.playing && at) {
          const el = wrapRef.current
          if (el) {
            const y = rowTops[at.row] ?? at.row * rowH
            const viewTop = el.scrollTop
            const viewBottom = viewTop + el.clientHeight
            if (y < viewTop + rowH || y + rowH > viewBottom - rowH) {
              el.scrollTop = Math.max(0, y - el.clientHeight / 2)
            }
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [follow, rowH, ticksByMeasure, layout])

  // 行高不再统一：带分节符的行多出 SECTION_H，虚拟滚动按前缀和定位
  const rowHeights = useMemo(
    () => layout.rows.map((r) => rowH + (r.section ? SECTION_H : 0)),
    [layout, rowH],
  )
  const rowTops = useMemo(() => {
    const tops: number[] = []
    let acc = 0
    for (const h of rowHeights) {
      tops.push(acc)
      acc += h
    }
    return tops
  }, [rowHeights])
  const totalH = rowTops.length
    ? rowTops[rowTops.length - 1] + rowHeights[rowHeights.length - 1]
    : 0
  const first = useMemo(() => {
    if (!rowTops.length) return 0
    // 第一个「底边 > scrollTop」的行，再往上留 3 行做缓冲
    let lo = 0
    let hi = rowTops.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rowTops[mid] + rowHeights[mid] <= scrollTop) lo = mid + 1
      else hi = mid
    }
    return Math.max(0, lo - 3)
  }, [scrollTop, rowTops, rowHeights])
  const visible = Math.ceil((size.h + rowH * 4) / rowH) + 7
  const lastRow = Math.min(layout.rows.length, first + visible)
  const topPad = rowTops[first] ?? 0
  const bottomPad =
    lastRow > 0
      ? Math.max(0, totalH - (rowTops[lastRow - 1] + rowHeights[lastRow - 1]))
      : totalH

  /**
   * 调整格大小：保持「选区第一格所在行」在屏幕上的位置不变；
   * 没有选区时，固定视口正中间那一行。否则行高变了但 scrollTop 不变，视口会跳到别处。
   */
  const changeCellSize = (next: number) => {
    const el = wrapRef.current
    if (el && layout.rows.length && rowTops.length) {
      let row = 0
      let t: number | null = null
      if (selCells.length) {
        row = selCells[0].row
        t = timeAt(row, selCells[0].col)
      } else {
        // rowTops 不含 .gd-scroll 的 padding-top，取中点时要减掉
        const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0
        const mid = el.scrollTop + el.clientHeight / 2 - padTop
        let lo = 0
        let hi = rowTops.length - 1
        while (lo <= hi) {
          const m = (lo + hi) >> 1
          if (rowTops[m] <= mid) {
            row = m
            lo = m + 1
          } else hi = m - 1
        }
        t = rowSpans[row]?.start ?? null
      }
      if (t != null) cellAnchor.current = { time: t, offset: (rowTops[row] ?? 0) - el.scrollTop }
      const aT = selA ? timeAt(selA.row, selA.col) : null
      const bT = selB ? timeAt(selB.row, selB.col) : null
      pendingSel.current = aT != null || bT != null ? { a: aT, b: bT } : null
    }
    setCell(next)
  }

  // 新布局渲染完、绘制前：按时间重映射选区 + 把锚点行挪回原来的屏幕位置
  useLayoutEffect(() => {
    const ps = pendingSel.current
    if (ps) {
      pendingSel.current = null
      skipClamp.current = true
      const na = ps.a != null ? locateTime(ps.a) : null
      const nb = ps.b != null ? locateTime(ps.b) : null
      if (na) {
        setSelA(na)
        focusRef.current = na
      }
      if (nb) setSelB(nb)
    }
    const a = cellAnchor.current
    if (!a) return
    cellAnchor.current = null
    const el = wrapRef.current
    if (!el || !rowSpans.length) return
    let lo = 0
    let hi = rowSpans.length - 1
    let ri = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (rowSpans[mid].start <= a.time + SNAP_MS) {
        ri = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const top = rowTops[ri] ?? 0
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const next = Math.max(0, Math.min(max, top - a.offset))
    el.scrollTop = next
    setScrollTop(next)
  }, [cell, rowSpans, rowTops])

  /** 选中一格（seek；不试听） */
  const selectCell = (row: number, col: number, extend = false) => {
    const p = { row, col }
    clearMulti()
    setRectSel(false)
    if (!extend) setSelA(p)
    setSelB(p)
    focusRef.current = p
    const t = timeAt(row, col)
    if (t != null) engine.seek(t)
  }

  /** 试听这一格里的音效 */
  const audition = (row: number, col: number) => {
    const ch = chunkOf(row, col)
    if (!ch) return
    const k = ch.from + (col - ch.col)
    const evs = eventsByCell.get(`${ch.mi}:${k}`)
    if (!evs) return
    for (const e of evs) {
      if (e.kind === 'keysound') engine.playKey(e.instrument || ksSel?.name, e.pitch ?? ksBase, e.volume)
      else for (const n of e.names) onPlaySample(n, e.volume, e)
    }
  }

  /**
   * [Define] 里可用的 hitsound 代号（画笔的可选项）。
   * keysound 定义不能写进 [Hitsound] 正文，交给上面的乐器下拉框。
   */
  const names = useMemo(
    () =>
      doc.hitsounds
        .filter((h) => h.kind !== 'keysound')
        .map((h) => h.name)
        .filter((n): n is string => !!n),
    [doc],
  )

  // 双击型锁定的音效被删掉了 → 回到单击型
  useEffect(() => {
    if (brushMode === 'double' && brushPin && !names.includes(brushPin)) {
      setBrushMode('single')
      setBrushPin('')
    }
  }, [brushMode, brushPin, names, setBrushMode, setBrushPin])

  useEffect(
    () => () => {
      if (brushTimer.current) window.clearTimeout(brushTimer.current)
      if (typedTimer.current) window.clearTimeout(typedTimer.current)
    },
    [],
  )

  const currentFile = () => {
    const st = useStore.getState()
    return st.files.find((x) => x.id === st.activeId) || null
  }

  /**
   * 批量写回。每次操作都基于「当前文本」重新解析（连续快速点击时 props.doc 可能
   * 还停在 180ms 前的旧状态），多个小节也只产生一次撤销记录。
   */
  const applyEdits = (edits: CellEdit[], target: GridEditTarget | undefined = ksTarget()) => {
    if (!edits.length) return false
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return false
    const live = parseChart(f.content)
    const res = applyCellEdits(live, edits, div, target)
    if (!res.ok) {
      st.log(`✗ ${res.reason ?? '这一格改不了'}`)
      return false
    }
    if (res.text === f.content) return true
    recordEdit(f.id, f.content, res.text!)
    st.updateContent(f.id, res.text!)
    return true
  }

  const editCells = (
    targets: GridCell[],
    next: string[] | ((cur: string[]) => string[]),
    target: GridEditTarget | undefined = ksTarget(),
  ) => applyEdits(targets.map((t) => ({ mi: t.mi, k: t.k, next })), target)

  /**
   * 指针位置 → 插入点（0…names.length）。
   *
   * 找离指针最近的那个画笔，再看指针在它中线的左边还是右边：左 = 插在它前面、
   * 右 = 插在它后面。画笔栏折成多行时也能用（最近的按钮一定在同一行附近）。
   *
   * 用 DOM 查询而不是 ref 数组：切谱/重排时 ref 回调的调用顺序不保证，
   * 数组里可能残留已经卸载的旧按钮（位置全变成 0），拖起来会算错落点。
   */
  const dropIndexAt = (x: number, y: number): number => {
    const els = brushesRef.current?.querySelectorAll<HTMLButtonElement>('.gd-brush')
    if (!els || !els.length) return names.length
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      const dx = x - (r.left + r.width / 2)
      const dy = y - (r.top + r.height / 2)
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) return names.length
    const r = els[best].getBoundingClientRect()
    return x > r.left + r.width / 2 ? best + 1 : best
  }

  /**
   * 把代号 `name` 挪到 `before` 前面（null = 挪到最后），写回 [Define] 并记一条撤销。
   *
   * 目标用「插到哪个代号前面」而不是行号/下标来描述：解析有 180ms 延迟，
   * 连续拖动时 props.doc 可能还是旧的，拿代号当锚点才不会把上一次的结果覆盖掉。
   */
  const moveBrush = (name: string, before: string | null) => {
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const live = parseChart(f.content)
    const cur = live.hitsounds.map((h) => h.name).filter((n): n is string => !!n)
    const from = cur.indexOf(name)
    if (from < 0) return
    const rest = cur.filter((n) => n !== name)
    let at = before ? rest.indexOf(before) : -1
    if (at < 0) at = rest.length
    if (at === from) return
    rest.splice(at, 0, name)
    const text = reorderDefineText(f.content, rest)
    if (text === f.content) return
    recordEdit(f.id, f.content, text)
    st.updateContent(f.id, text)
    st.log(`音效顺序：${name} → 第 ${at + 1} 个（已同步 [Define]）`)
  }

  /** 拖动中的指针移动：先过阈值判定「这是拖动」，再更新插入点 */
  const brushMoveRef = useRef<(e: MouseEvent) => void>(() => {})
  brushMoveRef.current = (e: MouseEvent) => {
    const p = brushPress.current
    if (!p) return
    // 在窗口外松手时收不到 mouseup：再看一眼按键状态，松开就收摊
    if (p.active && (e.buttons & 1) === 0) {
      brushPress.current = null
      dragDropRef.current = null
      setBrushDrag(null)
      return
    }
    if (!p.active) {
      // 阈值给大一点：单击/双击时手抖一下不算拖动
      if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 5) return
      p.active = true
      // 拖动和单击是互斥的：把排队中的落笔撤掉
      if (brushTimer.current) {
        window.clearTimeout(brushTimer.current)
        brushTimer.current = null
      }
      pendingBrush.current = null
      const drop = dropIndexAt(e.clientX, e.clientY)
      dragDropRef.current = drop
      setBrushDrag({ name: p.name, drop })
      return
    }
    const drop = dropIndexAt(e.clientX, e.clientY)
    if (drop !== dragDropRef.current) {
      dragDropRef.current = drop
      setBrushDrag((d) => (d ? { ...d, drop } : d))
    }
  }

  /** 松手：真的拖动过就提交新顺序（没拖动就交给 click 走原来的落笔逻辑） */
  const brushUpRef = useRef<(e: MouseEvent) => void>(() => {})
  brushUpRef.current = (e: MouseEvent) => {
    const p = brushPress.current
    brushPress.current = null
    if (!p?.active) return
    const drop = dragDropRef.current
    dragDropRef.current = null
    setBrushDrag(null)
    // 拖动结束后浏览器还会补一个 click，先置位让 onBrushClick 吞掉它
    suppressBrushClick.current = true
    window.setTimeout(() => {
      suppressBrushClick.current = false
    }, 0)
    if (drop == null) return
    // 拖远了松手 = 取消（否则离工具条老远也会按最近的按钮算）
    const box = brushesRef.current?.getBoundingClientRect()
    if (
      box &&
      (e.clientX < box.left - 24 ||
        e.clientX > box.right + 24 ||
        e.clientY < box.top - 24 ||
        e.clientY > box.bottom + 24)
    )
      return
    const fromVis = names.indexOf(p.name)
    const vis = names.filter((n) => n !== p.name)
    const at = fromVis >= 0 && drop > fromVis ? drop - 1 : drop
    const anchor = at >= vis.length ? null : (vis[Math.max(0, at)] ?? null)
    moveBrush(p.name, anchor)
  }

  useEffect(() => {
    const mv = (e: MouseEvent) => brushMoveRef.current(e)
    const up = (e: MouseEvent) => brushUpRef.current(e)
    // 拖动中按 Esc = 放弃这次排序
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !brushPress.current) return
      brushPress.current = null
      dragDropRef.current = null
      setBrushDrag(null)
    }
    // 窗口失焦（切到别的程序）也放弃，免得回来时还粘着一次拖动
    const blur = () => {
      if (!brushPress.current) return
      brushPress.current = null
      dragDropRef.current = null
      setBrushDrag(null)
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', esc)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', esc)
      window.removeEventListener('blur', blur)
    }
  }, [])

  /** 把 [Settings] Sections 写回文本（一次操作一条撤销记录） */
  const writeSections = (next: SectionMark[]) => {
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const text = updateSectionsText(f.content, next)
    if (text === f.content) return
    recordEdit(f.id, f.content, text)
    st.updateContent(f.id, text)
  }

  /** 在第 mi 小节前插入分节符 */
  const addSection = (mi: number) => {
    const st = useStore.getState()
    const f = currentFile()
    const m = doc.measures[mi]
    if (!f || !m) return
    const time = Math.round(m.start)
    const live = parseChart(f.content)
    if (live.settings.Sections.some((s) => Math.abs(s.time - time) <= 1)) {
      st.log('这一小节前已经有分节符了')
      return
    }
    writeSections([...live.settings.Sections, { time, name: '' }])
    setSelGap(null)
    setFocusSection(time)
    st.log(`已分节：小节 ${mi + 1} 起`)
  }

  const renameSection = (time: number, name: string) => {
    const f = currentFile()
    if (!f) return
    const live = parseChart(f.content)
    const next = live.settings.Sections.map((s) =>
      Math.abs(s.time - time) <= 1 ? { ...s, name } : s,
    )
    writeSections(next)
  }

  const removeSection = (time: number) => {
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const live = parseChart(f.content)
    writeSections(live.settings.Sections.filter((s) => Math.abs(s.time - time) > 1))
    setFocusSection(null)
    st.log('已删除分节符')
    setTimeout(() => rootRef.current?.focus({ preventScroll: true }), 0)
  }

  /** 点击缝隙：选中它（按 Enter 分节），同时清掉格子的选区 */
  const onGapDown = (e: ReactMouseEvent, mi: number, key: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    rootRef.current?.focus({ preventScroll: true })
    setSelGap({ mi, key })
    setSelA(null)
    setSelB(null)
    setRectSel(false)
    clearMulti()
  }

  /**
   * 单击型：把某个音效落到整个选区。
   * 全选中的格子都已经有它 → 一起移除；否则一起补上（避免拖选一片时出现半有半无）。
   */
  const applySoundToSelection = (name: string) => {
    if (!selCells.length) {
      useStore.getState().log('先在网格里点一下格子，再点音效')
      return
    }
    // 用「当前文本」判断是不是每格都有它（props.doc 可能落后 180ms，
    // 连续快点两下时按旧状态判断会把「移除」当成「补上」）
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const live = parseChart(f.content)
    const cache = new Map<number, ReturnType<typeof readMeasureCells>>()
    let allHave = true
    for (const c of selCells) {
      let got = cache.get(c.mi)
      if (!got) {
        got = readMeasureCells(live, c.mi, div, ksTarget())
        cache.set(c.mi, got)
      }
      if (!got.ok) {
        st.log(`✗ ${got.reason}`)
        return
      }
      if (!got.cells[c.k]?.names.includes(name)) {
        allHave = false
        break
      }
    }
    editCells(
      selCells,
      allHave
        ? (cur) => cur.filter((n) => n !== name)
        : (cur) => (cur.includes(name) ? cur : [...cur, name]),
    )
  }

  /**
   * keysound：把某个音（MIDI）加到选中的格子（再按一次取消）。
   * 没有选格子时只试听，不动谱面 —— 方便先听音色再决定。
   */
  const applyNote = (midi: number) => {
    const m = Math.max(PIANO_LOW, Math.min(PIANO_HIGH, Math.round(midi)))
    if (ksSel) engine.playKey(ksSel.name, m, 100)
    if (!selCells.length) return
    applySoundToSelection(midiToName(m))
  }

  /** 移调：把选中的 keysound 音符整体平移 delta 个半音 */
  const transposeSelection = (delta: number) => {
    if (!delta || !selCells.length) return
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const live = parseChart(f.content)
    const target = ksTarget()
    const cache = new Map<number, ReturnType<typeof readMeasureCells>>()
    const edits: CellEdit[] = []
    for (const c of selCells) {
      let got = cache.get(c.mi)
      if (!got) {
        got = readMeasureCells(live, c.mi, div, target)
        cache.set(c.mi, got)
      }
      if (!got.ok) {
        st.log(`✗ ${got.reason}`)
        return
      }
      const cur = got.cells[c.k]?.names || []
      if (!cur.length) continue
      const next: string[] = []
      for (const n of cur) {
        const m = nameToMidi(n)
        const v = m == null ? n : midiToName(clampToRange(m + delta))
        if (!next.includes(v)) next.push(v)
      }
      if (next.join(' ') !== cur.join(' ')) edits.push({ mi: c.mi, k: c.k, next })
    }
    if (!edits.length) {
      st.log(tr('选中的格子里没有可移调的音符'))
      return
    }
    applyEdits(edits)
    st.log(tr('已移调 {n} 格：{delta} 个半音', { n: edits.length, delta: delta > 0 ? `+${delta}` : String(delta) }))
  }

  /**
   * 键盘敲代号：单键代号（52 字母 / 10 数字 / 符号）按一下直接落笔；
   * 多字母代号仍按前缀匹配，打全或只剩一个候选/超时后落笔。
   * 字母区分大小写（`a` 和 `A` 是两个代号）；前缀先按大小写匹配，
   * 一个都没有时再退回大小写不敏感，兼容旧的 `Aa` 这类代号。
   */
  const typedRef = useRef('')
  const [typed, setTyped] = useState('')
  const typedTimer = useRef<number | null>(null)

  const matchPrefix = (buf: string) => {
    const sensitive = names.filter((n) => n.startsWith(buf))
    return sensitive.length ? sensitive : names.filter((n) => n.toLowerCase().startsWith(buf.toLowerCase()))
  }

  const typedCands = useMemo(() => (typed ? matchPrefix(typed) : []), [typed, names])

  const clearTyped = () => {
    typedRef.current = ''
    setTyped('')
    if (typedTimer.current) {
      window.clearTimeout(typedTimer.current)
      typedTimer.current = null
    }
  }

  const commitTyped = (name: string) => {
    clearTyped()
    applySoundToSelection(name)
  }

  const typeCode = (ch: string) => {
    if (!names.length) return
    const keyName = codeNameFromKey(ch)
    if (!keyName) return
    // 数字 / 符号：一个键就是一个完整的正文名（1 → One、/ → Slash），没有前缀可接
    if (!/^[A-Za-z]$/.test(ch)) {
      if (names.includes(keyName)) commitTyped(keyName)
      else clearTyped()
      return
    }
    let buf = typedRef.current + ch
    let cands = matchPrefix(buf)
    // 上一个字母已经接不上任何代号：把它丢掉，当前这个字母当成新的一次输入
    if (!cands.length && typedRef.current) {
      buf = ch
      cands = matchPrefix(buf)
    }
    if (!cands.length) {
      clearTyped()
      return
    }
    typedRef.current = buf
    setTyped(buf)
    // 单键代号优先：完全同名的代号直接落笔（哪怕还有 Aa 这种更长的候选）。
    // 多字母代号在「没有同名单键」时才靠继续敲字母来输入。
    if (names.includes(buf)) {
      commitTyped(buf)
      return
    }
    // 兼容旧写法：Aa 可以敲 aa（前两个键大小写不敏感）
    const ciExact =
      buf.length > 1 ? cands.find((n) => n.toLowerCase() === buf.toLowerCase()) : undefined
    if (ciExact) {
      commitTyped(ciExact)
      return
    }
    if (typedTimer.current) window.clearTimeout(typedTimer.current)
    typedTimer.current = window.setTimeout(() => {
      typedTimer.current = null
      const cur = typedRef.current
      const list = cur ? matchPrefix(cur) : []
      const hit = list.find((n) => n === cur)
      // 有完全同名的就落它；否则只剩一个候选才替用户补全，多个就放弃
      if (hit) commitTyped(hit)
      else if (list.length === 1) commitTyped(list[0])
      else clearTyped()
    }, TYPE_WAIT)
  }

  /** 画笔按钮：单击 = 落笔（或从双击型切回）；双击 = 锁定成双击型 */
  const runPendingBrush = () => {
    const p = pendingBrush.current
    pendingBrush.current = null
    if (!p) return
    if (p.samePin) {
      // 再点一次已锁定的按钮 = 解锁（只有一个音效时也能退出双击型）
      setBrushMode('single')
      setBrushPin('')
      return
    }
    if (p.wasDouble) {
      // 双击型里单击了别的音效 → 只切回单击型（颜色恢复），不落笔：
      // 这一步的语义是「换模式」，避免在最后选中的格子上多出一个音效。
      setBrushMode('single')
      setBrushPin('')
      return
    }
    applySoundToSelection(p.name)
  }

  const onBrushClick = (e: ReactMouseEvent, name: string) => {
    // 刚拖动过：浏览器在松手后还会补一个 click，别让它落笔
    if (suppressBrushClick.current) {
      suppressBrushClick.current = false
      return
    }
    if (brushTimer.current) {
      window.clearTimeout(brushTimer.current)
      brushTimer.current = null
    }
    if (e.detail >= 2) {
      // 双击：丢掉这次单击的待办，直接锁定
      pendingBrush.current = null
      setBrushPin(name)
      setBrushMode('double')
      return
    }
    // 快速连点不同音效：先把上一个待办执行掉，别把它丢了
    if (pendingBrush.current && pendingBrush.current.name !== name) runPendingBrush()
    pendingBrush.current = {
      name,
      wasDouble: brushMode === 'double',
      samePin: brushMode === 'double' && name === brushPin,
    }
    brushTimer.current = window.setTimeout(() => {
      brushTimer.current = null
      runPendingBrush()
    }, DBL_WAIT)
  }

  const onCellDown = (e: ReactMouseEvent, ri: number, col: number) => {
    // 右键：先准备矩形框选。没拖动 → 松开时照常弹菜单；拖过别的格子 → 矩形选区，
    // 随后那一次 contextmenu 会被吞掉（再按一次右键才弹菜单）。
    // 按着 Ctrl 拖 = 在已有选区上再加一个矩形选区。
    if (e.button === 2) {
      e.preventDefault()
      setSelGap(null)
      rootRef.current?.focus({ preventScroll: true })
      suppressContext.current = false
      rightDrag.current = {
        anchor: { row: ri, col },
        moved: false,
        additive: e.ctrlKey || e.metaKey,
      }
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    rootRef.current?.focus({ preventScroll: true })
    setSelGap(null)
    // Ctrl+按下先不决定是「切换这一格」还是「再拖一个选区」，等 mouseup / mouseenter 再分
    if (e.ctrlKey || e.metaKey) {
      dragRef.current = { active: true, moved: false, anchor: { row: ri, col }, additive: true }
      return
    }
    selectCell(ri, col, e.shiftKey)
    dragRef.current = { active: true, moved: false, anchor: { row: ri, col } }
  }

  const onCellEnter = (ri: number, col: number) => {
    const rd = rightDrag.current
    if (rd) {
      // 右键拖动：跨到别的格子才开始框选（同一格里的细微移动仍然算点击）；
      // 拖回起点时照常收成单格
      if (!rd.moved && rd.anchor.row === ri && rd.anchor.col === col) return
      const f = focusRef.current
      if (f && f.row === ri && f.col === col) return
      if (!rd.moved) {
        rd.moved = true
        suppressContext.current = true
        // Ctrl：保留已有选区，把它固化后再框新的；否则整片替换
        if (rd.additive) commitActive()
        else clearMulti()
        setRectSel(true)
        setSelA(rd.anchor)
      }
      setSelB({ row: ri, col })
      focusRef.current = { row: ri, col }
      return
    }
    const d = dragRef.current
    if (!d?.active) return
    const f = focusRef.current
    // 鼠标在同一格里移动时 onMouseOver 会连着触发：同一格就直接返回，别每帧重渲染
    if (f && f.row === ri && f.col === col) return
    if (d.additive) {
      // Ctrl+拖动：把原来的选区固化，从锚点另起一个（左键 = 阅读顺序区间）
      if (!d.moved) {
        d.moved = true
        commitActive()
        setRectSel(false)
        setSelA(d.anchor)
      }
      setSelB({ row: ri, col })
      focusRef.current = { row: ri, col }
      return
    }
    if (d.anchor.row !== ri || d.anchor.col !== col) {
      d.moved = true
      clearMulti()
    }
    setSelB({ row: ri, col })
    focusRef.current = { row: ri, col }
  }

  // 拖动结束：没拖动 = 单击（试听；双击型还落笔），拖动 = 只留选区
  const upRef = useRef<() => void>(() => {})
  upRef.current = () => {
    // 右键框选：松手只保留选区，不弹菜单（contextmenu 由 suppressContext 吞掉）
    const rd = rightDrag.current
    if (rd) {
      rightDrag.current = null
      if (rd.moved) {
        const f = focusRef.current
        if (f) {
          const t = timeAt(f.row, f.col)
          if (t != null) engine.seek(t)
        }
      }
      return
    }
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    // Ctrl：没拖动 = 切换这一格；拖动了 = 新选区已经成形（附加选区保留）
    if (d.additive) {
      if (!d.moved) {
        toggleCellSel(d.anchor.row, d.anchor.col)
      } else {
        const f = focusRef.current
        if (f) {
          const t = timeAt(f.row, f.col)
          if (t != null) engine.seek(t)
        }
      }
      return
    }
    if (d.moved) {
      const f = focusRef.current
      if (f) {
        const t = timeAt(f.row, f.col)
        if (t != null) engine.seek(t)
      }
      return
    }
    audition(d.anchor.row, d.anchor.col)
    if (brushMode === 'double' && brushPin) {
      const ch = chunkOf(d.anchor.row, d.anchor.col)
      if (!ch) return
      const k = ch.from + (d.anchor.col - ch.col)
      editCells([{ ...d.anchor, mi: ch.mi, k }], (cur) => toggleName(cur, brushPin))
    }
  }
  useEffect(() => {
    const h = () => upRef.current()
    window.addEventListener('mouseup', h)
    return () => window.removeEventListener('mouseup', h)
  }, [])

  /** 当前选区的格子内容（复制用） */
  const readCellsAt = (text: string, targets: GridCell[], target = ksTarget()): ClipCell[] | null => {
    const live = parseChart(text)
    const cache = new Map<number, ReturnType<typeof readMeasureCells>>()
    const out: ClipCell[] = []
    for (const t of targets) {
      let got = cache.get(t.mi)
      if (!got) {
        got = readMeasureCells(live, t.mi, div, target)
        cache.set(t.mi, got)
      }
      if (!got.ok) {
        useStore.getState().log(`✗ ${got.reason}`)
        return null
      }
      const c = got.cells[t.k]
      if (!c) continue
      out.push({ names: [...c.names], volume: c.volume, index: c.index })
    }
    return out
  }

  const doUndo = () => {
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const text = undoEdit(f.id, f.content)
    if (text == null) {
      st.log('↶ 没有可撤销的格子操作（文本改动会清空历史）')
      return
    }
    st.updateContent(f.id, text)
  }

  const doRedo = () => {
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const text = redoEdit(f.id, f.content)
    if (text == null) {
      st.log('↷ 没有可重做的格子操作')
      return
    }
    st.updateContent(f.id, text)
  }

  /**
   * 复制：把选区连同**形状**一起存起来。
   *
   * 选区恰好铺满自己的外接矩形（右键框选出来的、或整行整行选的）→ 记成 rows×cols
   * 的矩形块，粘贴时按行列偏移铺回去；否则按阅读顺序当一串（老行为）。
   * 「复制一竖排结果粘成横排」就是因为以前只存了一串、没有形状。
   */
  const doCopy = (targets: GridCell[] = selCells) => {
    const st = useStore.getState()
    if (!targets.length) {
      st.log('没有选中的格子')
      return false
    }
    const f = currentFile()
    if (!f) return false
    const clipCells = readCellsAt(f.content, targets)
    if (!clipCells) return false
    // 理论上不会少：某个格子读不出来时宁可放弃，也别把 undefined 塞进剪贴板
    if (clipCells.length !== targets.length) {
      st.log(`✗ 选中的格子里有 ${targets.length - clipCells.length} 格读不出来，换个范围再试`)
      return false
    }

    const minRow = Math.min(...targets.map((t) => t.row))
    const maxRow = Math.max(...targets.map((t) => t.row))
    const minCol = Math.min(...targets.map((t) => t.col))
    const maxCol = Math.max(...targets.map((t) => t.col))
    const rows = maxRow - minRow + 1
    const cols = maxCol - minCol + 1
    const full = rows > 1 && targets.length === rows * cols

    const clip: GridClip = full
      ? {
          rows,
          cols,
          rect: true,
          mode: ksSel ? 'keysound' : 'hitsound',
          items: targets.map((t, i) => ({ dr: t.row - minRow, dc: t.col - minCol, cell: clipCells[i] })),
        }
      : {
          rows: 1,
          cols: targets.length,
          rect: false,
          mode: ksSel ? 'keysound' : 'hitsound',
          items: clipCells.map((cell, i) => ({ dr: 0, dc: i, cell })),
        }
    setGridClip(clip)
    // 系统剪贴板里放一份人看的文本：矩形块按行换行，方便贴到文本编辑器里也是竖排
    const text = clip.rect
      ? Array.from({ length: clip.rows }, (_, r) =>
          clip.items
            .filter((it) => it.dr === r)
            .sort((a, b) => a.dc - b.dc)
            .map((it) => it.cell.names.join('+'))
            .join('\t'),
        ).join('\n')
      : clip.items.map((it) => it.cell.names.join('+')).join('\t')
    void writeClipboard(text)
    st.log(`复制了 ${clip.items.length} 格${clip.rect ? `（${clip.rows}×${clip.cols} 矩形）` : ''}`)
    return true
  }

  const doCut = (targets: GridCell[] = selCells) => {
    if (!doCopy(targets)) return false
    return editCells(targets, [])
  }

  const doPaste = (targets: GridCell[] = selCells) => {
    const st = useStore.getState()
    const clip = getGridClip()
    if (!clip || !clip.items.length) {
      st.log('剪贴板里还没有复制的格子')
      return false
    }
    if (!targets.length) {
      st.log('先选中目标格子再粘贴')
      return false
    }
    if ((clip.mode || 'hitsound') !== (ksSel ? 'keysound' : 'hitsound')) {
      st.log(tr('剪贴板是从另一种模式复制的，先切回去再粘贴'))
      return false
    }
    let pairs: { cell: GridCell; data: ClipCell }[] = []
    if (clip.items.length === 1) {
      // 复制了一格 → 铺满整个选区
      pairs = targets.map((cell) => ({ cell, data: clip.items[0].cell }))
    } else if (clip.rect && clip.rows > 1) {
      // 矩形块（典型：一竖排）→ 以选区第一格为左上角，按行列偏移铺；目标行不够长就跳过
      const base = targets[0]
      for (const it of clip.items) {
        const r = base.row + it.dr
        const c = base.col + it.dc
        const row = layout.rows[r]
        if (!row || c < 0 || c >= row.cells) continue
        const ch = chunkOf(r, c)
        if (!ch) continue
        pairs.push({
          cell: { row: r, col: c, mi: ch.mi, k: ch.from + (c - ch.col) },
          data: it.cell,
        })
      }
      if (pairs.length < clip.items.length)
        st.log(`粘贴时跳过 ${clip.items.length - pairs.length} 格（目标位置超出网格范围）`)
    } else {
      // 单行 / 线性一串 → 从选区第一格起按阅读顺序往后铺（跨行也连续）
      const list = cellsFrom(targets[0], clip.items.length)
      pairs = list.map((cell, i) => ({ cell, data: clip.items[i]?.cell })).filter((p) => !!p.data)
    }
    if (!pairs.length) return false
    return applyEdits(
      pairs.map((p) => ({
        mi: p.cell.mi,
        k: p.cell.k,
        next: p.data.names,
        volume: p.data.volume,
        index: p.data.index,
      })),
    )
  }

  const doSelectAll = () => {
    if (!layout.rows.length) return
    const lastRow = layout.rows.length - 1
    clearMulti()
    setRectSel(false)
    setSelA({ row: 0, col: 0 })
    const p = { row: lastRow, col: Math.max(0, layout.rows[lastRow].cells - 1) }
    setSelB(p)
    focusRef.current = p
    rootRef.current?.focus({ preventScroll: true })
  }

  const doClear = (targets: GridCell[] = selCells) => {
    if (!targets.length) return false
    return editCells(targets, [])
  }

  /**
   * 右键「修改音量…」的目标格子。
   *
   * - 只选一格：从这一格一直到下一条 `<v>` 之前（等价于文本里只加一条 `<v=xx>`）
   * - 多选：只改选中的那些格
   */
  const volumeTargets = (scope: GridCell[]): { mi: number; k: number }[] => {
    if (scope.length !== 1) return scope.map((c) => ({ mi: c.mi, k: c.k }))
    const c = scope[0]
    const live = parseChart(currentFile()?.content || doc.text)
    const span = volumeSpanFrom(live, c.mi, c.k, div)
    return span.length ? span.map((k) => ({ mi: c.mi, k })) : [{ mi: c.mi, k: c.k }]
  }

  /** 预填这一格当前生效的音量 */
  const openVolumeDialog = (scope: GridCell[]) => {
    if (!scope.length) return
    const first = scope[0]
    const cur = volInfo.at.get(`${first.mi}:${first.k}`) ?? 100
    setVolDlg({ cells: volumeTargets(scope), value: String(cur), span: scope.length === 1 })
  }

  /** 写回 `<v=xx>`：空格子也会补一条，已经有的只改数值（不会重复加） */
  const applyVolume = () => {
    if (!volDlg) return
    const n = Number(volDlg.value)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) return
    // 已经就是这个音量的格子不用动（免得写出一条多余的 <v>）
    const targets = volDlg.cells.filter((c) => (volInfo.at.get(`${c.mi}:${c.k}`) ?? 100) !== n)
    if (!targets.length) {
      setVolDlg(null)
      return
    }
    /** 这一格现在生效的音量（写回时要拿它当「原来的值」） */
    const volAt = (mi: number, k: number) => volInfo.at.get(`${mi}:${k}`) ?? 100

    // 连续的一段只在开头写一条 <v>，后面的格子靠继承；段尾后面要再写一条把音量恢复回去，
    // 否则后面的空格子会一直沿用新音量。单选是「从这一格一直往后」，不需要恢复。
    const edits: CellEdit[] = []
    const add = (mi: number, k: number, volume: number, force: boolean) => {
      edits.push({ mi, k, next: (cur: string[]) => cur, volume, volumeForce: force })
    }

    if (volDlg.span) {
      targets.forEach((c, i) => add(c.mi, c.k, n, i === 0))
    } else {
      const selected = new Set(targets.map((c) => `${c.mi}:${c.k}`))
      /** 段尾之后那一格：恢复成它原来的音量（可能落到下一个小节的开头） */
      const restoreAfter = (mi: number, k: number) => {
        const ticks = (ticksByMeasure[mi] || []).length
        const nextMi = k + 1 >= ticks ? mi + 1 : mi
        const nextK = k + 1 >= ticks ? 0 : k + 1
        if (nextMi >= doc.measures.length) return
        if (selected.has(`${nextMi}:${nextK}`)) return
        const back = volAt(nextMi, nextK)
        if (back !== n) add(nextMi, nextK, back, true)
      }

      const byMi = new Map<number, number[]>()
      for (const c of targets) byMi.set(c.mi, [...(byMi.get(c.mi) ?? []), c.k])
      for (const [mi, ks] of byMi) {
        ks.sort((a, b) => a - b)
        let prev = Number.NaN
        for (const k of ks) {
          if (k !== prev + 1) {
            if (!Number.isNaN(prev)) restoreAfter(mi, prev)
            add(mi, k, n, true)
          } else {
            add(mi, k, n, false)
          }
          prev = k
        }
        if (!Number.isNaN(prev)) restoreAfter(mi, prev)
      }
    }

    const ok = applyEdits(edits)
    if (ok) setVolDlg(null)
  }

  /** 删掉选中格子里正文写着的 `<v=xx>`：这一格和后面沿用它音量的格子回到前一段的音量 */
  const clearVolume = (scope: GridCell[]) => {
    const targets = scope.filter((c) => volInfo.mark.has(`${c.mi}:${c.k}`))
    if (!targets.length) return
    applyEdits(
      targets.map((c) => ({ mi: c.mi, k: c.k, next: (cur: string[]) => cur, volumeClear: true })),
    )
  }

  /** 右键：落在选区外就先把选区移到这一格，再弹菜单 */
  /**
   * 全部替换：命中的格子一次改完，只留一条撤销记录。
   *
   * 先整批写；万一某个小节写不回去（中途变 BPM / 跨度 / 音符不在格上），
   * 再退化成逐小节写，能改的照改，跳过的在日志里列出来。
   */
  const doReplaceAll = () => {
    if (!findDlg || !findInfo || !findInfo.changed) return
    const st = useStore.getState()
    const f = currentFile()
    if (!f) return
    const toEdit = (mi: number, k: number): CellEdit => ({
      mi,
      k,
      next: (cur: string[]) => replaceCell(cur, findInfo.find, findInfo.repl, findDlg.exact, findDlg.onlyMatched),
    })
    const edits = findInfo.hits.map((h) => toEdit(h.mi, h.k))

    let text = ''
    let applied = 0
    const skipped: number[] = []
    const all = applyCellEdits(parseChart(f.content), edits, div)
    if (all.ok) {
      text = all.text!
      applied = findInfo.changed
    } else {
      const byMi = new Map<number, CellEdit[]>()
      for (const e of edits) byMi.set(e.mi, [...(byMi.get(e.mi) ?? []), e])
      text = f.content
      for (const [mi, list] of byMi) {
        const r = applyCellEdits(parseChart(text), list, div)
        if (!r.ok) {
          skipped.push(mi)
          continue
        }
        text = r.text!
        applied += list.length
      }
    }

    if (text === f.content) {
      st.log('没有需要替换的格子')
      return
    }
    recordEdit(f.id, f.content, text)
    st.updateContent(f.id, text)
    st.log(
      `✓ 替换 ${applied} 格${skipped.length ? `，跳过 ${skipped.length} 个小节（第 ${skipped.map((m) => m + 1).join('、')} 小节）` : ''}`,
    )
  }

  /**
   * 用 `osu://edit/mm:ss:xxx` 唤起 osu!，让它直接跳到这一格的时间点。
   *
   * 协议由 osu! 自己注册（stable 安装后可用；lazer 需要允许自定义协议），
   * 系统里没装或者没注册时这里只会失败，所以把链接也写进日志方便手动复制。
   */
  const openInOsuEditor = async (t: number) => {
    const url = osuEditUrl(t)
    const st = useStore.getState()
    const ok = await openExternalUrl(url)
    st.log(
      ok
        ? `已在 osu! Editor 中打开 ${fmtOsuTime(t)}（${url}）`
        : `✗ 没能唤起 osu!：${url}（系统里没装 osu!，或者没注册 osu:// 协议）`,
    )
  }

  const onCellContext = (e: ReactMouseEvent, ri: number, col: number) => {
    // 刚做完右键框选：这一次不弹菜单，再按一次右键才弹
    if (suppressContext.current) {
      e.preventDefault()
      e.stopPropagation()
      suppressContext.current = false
      rightDrag.current = null
      return
    }
    e.preventDefault()
    const ch = chunkOf(ri, col)
    const key = ch ? `${ch.mi}:${ch.from + (col - ch.col)}` : ''
    const inside = !!key && selKeys.has(key)
    let scope = selCells
    if (!inside) {
      // 点到了选区外面：整片重置成这一格（附加选区也一起清掉）
      clearMulti()
      const p = { row: ri, col }
      setRectSel(false)
      setSelA(p)
      setSelB(p)
      focusRef.current = p
      const t = timeAt(ri, col)
      if (t != null) engine.seek(t)
      scope = ch ? [{ row: ri, col, mi: ch.mi, k: ch.from + (col - ch.col) }] : []
    }
    rootRef.current?.focus({ preventScroll: true })
    const f = currentFile()
    /** 选区里有几格真的写了 `<v=xx>`（有才显示「删除音量」） */
    const volTargets = scope.filter((c) => volInfo.mark.has(`${c.mi}:${c.k}`))
    /** 「在 osu! Editor 中打开」只对单格有效：这一格的时间点 */
    const one = scope.length === 1 ? scope[0] : null
    const oneTime = one ? (ticksByMeasure[one.mi] || [])[one.k] : undefined
    /**
     * 单选一格时，这一格里的音效代号：右键菜单给每个能带走的代号一条
     * 「将音效 xx 复制到其他谱面」。default.xxx / keysound 多文件没有单一路径，跳过。
     */
    const cellCodes = one
      ? [...new Set((eventsByCell.get(`${one.mi}:${one.k}`) || []).flatMap((ev) => ev.names).filter(Boolean))]
      : []
    const copyableCodes = cellCodes.filter((n) => {
      const d = doc.hitsounds.find((h) => h.name === n)
      return !!d && d.kind === 'hitsound' && !d.defaultRef && !!d.path && !(d.keyFiles && d.keyFiles.size)
    })
    const items: EditMenuItem[] = [
      {
        label: tr('撤销'),
        hint: 'Ctrl+Z',
        disabled: !f || !canUndo(f.id, f.content),
        onClick: doUndo,
      },
      {
        label: tr('重做'),
        hint: 'Ctrl+Shift+Z',
        disabled: !f || !canRedo(f.id, f.content),
        onClick: doRedo,
      },
      { label: tr('剪切'), hint: 'Ctrl+X', disabled: !scope.length, sep: true, onClick: () => doCut(scope) },
      { label: tr('复制'), hint: 'Ctrl+C', disabled: !scope.length, onClick: () => doCopy(scope) },
      { label: tr('粘贴'), hint: 'Ctrl+V', disabled: !hasGridClip(), onClick: () => doPaste(scope) },
      { label: tr('全选'), hint: 'Ctrl+A', sep: true, onClick: doSelectAll },
      { label: tr('清空所选'), hint: 'Delete', disabled: !scope.length, danger: true, onClick: () => doClear(scope) },
      ...(ksSel
        ? []
        : [
            {
              label: tr('修改音量…'),
              sep: true,
              disabled: !scope.length,
              onClick: () => openVolumeDialog(scope),
            } satisfies EditMenuItem,
          ]),
      {
        label: tr('在 osu! Editor 中打开'),
        hint: oneTime != null ? fmtOsuTime(oneTime) : tr('仅单选'),
        disabled: oneTime == null,
        onClick: () => {
          if (oneTime != null) void openInOsuEditor(oneTime)
        },
      },
    ]
    if (!ksSel && volTargets.length) {
      items.push({
        label: volTargets.length > 1 ? tr('删除音量（{n} 处）', { n: volTargets.length }) : tr('删除音量'),
        onClick: () => clearVolume(scope),
      })
    }
    // 单选一格、且有实体音频文件时：把音效带到另一份已打开的谱面
    copyableCodes.forEach((n, i) => {
      items.push({
        label: tr('将音效 {name} 复制到其他谱面', { name: codeGlyph(n) }),
        sep: i === 0,
        onClick: () => void copySoundToOtherChart(n),
      })
    })
    if (!ksSel) items.push({ label: tr('查找替换…'), hint: 'Ctrl+F', sep: true, onClick: openFind })
    openEditMenu(e.clientX, e.clientY, items)
  }

  /**
   * Ctrl+Z/X/C/V/A 挂到 window 上：格子模式下焦点可能在时间轴/侧栏，
   * 只挂在 .gd-wrap 上的话这些快捷键会失灵。输入框和弹窗里不接管。
   */
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keysRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable ||
        t.closest?.('.cm-editor, .edit-menu, .si-dialog, .as-dialog, .set-dialog, .osu-diff'))
    )
      return
    // 中文输入法正在拼字时不要抢字母
    if (e.isComposing || e.keyCode === 229) return
    // keysound 模式：A~L 按顺序输入这 12 个半音；数字换八度；Ctrl+方向键移范围/移调
    if (ksSel) {
      if (!(e.ctrlKey || e.metaKey)) {
        if (e.altKey) return
        if (/^[A-La-l]$/.test(e.key)) {
          e.preventDefault()
          // A~L 是音名代号：A→A、B→B、C→C …，半音数见 NOTE_CODES
          const semi = letterToSemi(e.key.toUpperCase())
          if (semi != null) applyNote(ksBase + semi)
          return
        }
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault()
          // 1–8 = C1–C8（9 夹到 8）；A0–B0 直接点琴键
          setKsBase((Math.min(8, Number(e.key)) + 1) * 12)
          return
        }
        // keysound 模式下不接 hitsound 的代号输入
        return
      }
      if (/^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        e.preventDefault()
        const delta =
          e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? 12 : -12
        if (selCells.length) transposeSelection(delta)
        // 没选格子时：←→ 只滚动视野（A 永远写 A，不会因为滚动变调），↑↓ 换八度
        else if (e.key === 'ArrowLeft') scrollPiano(-1)
        else if (e.key === 'ArrowRight') scrollPiano(1)
        else setKsBase(ksBase + delta)
        return
      }
    }
    if (!(e.ctrlKey || e.metaKey)) {
      // 单键代号：52 个字母（区分大小写）+ 10 个数字 + 英文符号（`=` 除外）
      // 没选格子 / [Define] 里没有代号时不接管
      if (e.altKey) return
      if (!codeNameFromKey(e.key)) return
      if (!selCells.length || !names.length) return
      e.preventDefault()
      typeCode(e.key)
      return
    }
    const k = e.key.toLowerCase()
    if (k === 'z') {
      e.preventDefault()
      if (e.shiftKey) doRedo()
      else doUndo()
      return
    }
    if (k === 'y') {
      e.preventDefault()
      doRedo()
      return
    }
    if (k === 'x') {
      e.preventDefault()
      doCut()
      return
    }
    if (k === 'c') {
      e.preventDefault()
      doCopy()
      return
    }
    if (k === 'v') {
      e.preventDefault()
      doPaste()
      return
    }
    if (k === 'a') {
      e.preventDefault()
      doSelectAll()
      return
    }
    if (k === 'f') {
      e.preventDefault()
      if (!ksSel) openFind()
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keysRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // 段落名输入框里的按键不要漏到网格上（否则 Backspace 会清空选中的格子）
    const t = e.target as HTMLElement | null
    if (
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable ||
        t.closest?.('.gd-section'))
    )
      return
    if (ksSel && (e.ctrlKey || e.metaKey) && e.key.startsWith('Arrow')) return
    if (e.key === 'Enter') {
      if (selGap) {
        e.preventDefault()
        addSection(selGap.mi)
      }
      return
    }
    if (e.key === 'Escape') {
      if (selGap) {
        e.preventDefault()
        setSelGap(null)
      } else if (ksSel && (selA || selB)) {
        // keysound：没有选区才能用 Ctrl+方向键调整输入范围
        e.preventDefault()
        setSelA(null)
        setSelB(null)
        clearMulti()
        focusRef.current = null
      }
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selCells.length) {
        e.preventDefault()
        doClear()
      }
      return
    }
    if (!selB) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        selectCell(0, 0)
        e.preventDefault()
      }
      return
    }
    const step = (dr: number, dc: number) => {
      e.preventDefault()
      let r = selB.row + dr
      let c = selB.col + dc
      if (r < 0 || r >= layout.rows.length) return
      const target = layout.rows[r]
      if (c < 0) {
        r -= 1
        if (r < 0) return
        c = layout.rows[r].cells - 1
      } else if (c >= target.cells) {
        r += 1
        if (r >= layout.rows.length) return
        c = 0
      }
      selectCell(r, c, e.shiftKey)
      audition(r, c)
    }
    if (e.key === 'ArrowLeft') step(0, -1)
    else if (e.key === 'ArrowRight') step(0, 1)
    else if (e.key === 'ArrowUp') step(-1, 0)
    else if (e.key === 'ArrowDown') step(1, 0)
    else if (e.key === ' ') {
      e.preventDefault()
      engine.toggle()
    }
  }

  const sel = selB
  const selInfo = (() => {
    if (!sel) return null
    const ch = chunkOf(sel.row, sel.col)
    if (!ch) return null
    const k = ch.from + (sel.col - ch.col)
    const t = ticksByMeasure[ch.mi]?.[k]
    const m = doc.measures[ch.mi]
    if (t == null || !m) return null
    const evs = eventsByCell.get(`${ch.mi}:${k}`) || []
    const mark = marksByCell.get(`${ch.mi}:${k}`)
    return { t, m, k, evs, mark }
  })()

  /** 缝隙（点一下选中，按 Enter 分节）；已经有分节符的边界不画 */
  const gapNode = (mi: number, key: string, edge?: 'start' | 'end') => {
    if (sectionByMeasure.has(mi)) return null
    return (
      <div
        key={key}
        className={`gd-gap${edge ? ` edge ${edge}` : ''}${selGap?.key === key ? ' on' : ''}`}
        title={tr('点击后按 Enter 在这里分节')}
        onMouseDown={(e) => onGapDown(e, mi, key)}
      >
        <i className="gd-gap-bar" />
      </div>
    )
  }

  /** 一行格子下方的 ImportOsu 物件轨道 */
  const renderObjLane = (ri: number) => {
    const objs = objectsByRow.get(ri)
    if (!objs || !objs.length) return null
    const r = layout.rows[ri]
    if (!r) return null
    const rowW0 = r.cells * cell + Math.max(0, r.cells - 1) * gap
    if (rowW0 <= 0) return null
    /**
     * 每格的左边界 + 起止时间。
     *
     * 一行里跨小节时，小节之间会多插一个 6px 的 `.gd-gap`（左右还有各 4px flex gap），
     * 也就是每个小节边界额外占 6+gap。以前只按 col*(cell+gap) 算，后面小节会整体偏左，
     * 这里按 renderRow 的节点顺序把这部分补上。
     */
    const cells: { x: number; t0: number; t1: number }[] = []
    let x = 0
    let acc = 0
    for (const ch of r.chunks) {
      if (acc > 0 && ch.from === 0 && !sectionByMeasure.has(ch.mi)) x += GD_GAP_W + gap
      const ticks = ticksByMeasure[ch.mi] || []
      const m = doc.measures[ch.mi]
      for (let i = 0; i < ch.count; i++) {
        const k = ch.from + i
        const t0 = ticks[k]
        if (t0 == null) continue
        const t1 = k + 1 < ticks.length ? ticks[k + 1] : (m?.end ?? t0 + 500)
        cells.push({ x, t0, t1 })
        x += cell + gap
      }
      acc += ch.count
    }
    if (!cells.length) return null
    const rowW = Math.max(0, x - gap)
    /**
     * 时间 → x：以**格子中心**为基准。
     * f=0（正拍）落在格子中心的竖线上；f=0.5（比当前细分更细一档，如 1/8 对 1/4）
     * 落在到下一格中心的中间（也就是两格之间缝隙的中心，跨小节时缝隙更宽也同样居中）；
     * f 再大就按比例靠近下一格中心。这样不会挤在格子左边缘。
     */
    const xAt = (t: number) => {
      let idx = 0
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].t0 <= t + SNAP_MS) idx = i
        else break
      }
      const c = cells[idx]
      const f = Math.min(1, Math.max(0, (t - c.t0) / Math.max(1, c.t1 - c.t0)))
      const center = c.x + cell / 2
      const next = cells[idx + 1]
      // 到下一格中心的距离（跨小节时比 cell+gap 大，缝隙才会居中）
      const span = next ? next.x + cell / 2 - center : cell + gap
      return Math.min(rowW, center + f * span)
    }
    const cy = OBJ_LANE_H / 2
    const minW = OBJ_R * 2 + 2
    return (
      <svg
        className="gd-objlane"
        width={rowW}
        height={OBJ_LANE_H}
        style={{ top: cell + OBJ_LANE_GAP }}
        aria-hidden="true"
      >
        <defs>
          <pattern
            id={`gd-hatch-${ri}`}
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="5" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        {objs.map((o, i) => {
          const rs = rowSpans[ri]
          // 开始 / 结束是否落在本行：跨行的滑条/转盘在中间几行只有两条水平线（=）
          const startsHere = o.start >= rs.start - SNAP_MS
          const endsHere = o.end <= rs.end + SNAP_MS
          const span = !startsHere || !endsHere
          const repCount = o.kind === 'slider' ? Math.max(0, (o.spans ?? 1) - 1) : 0
          const tip = `${o.kind} · ${fmtOsuTime(o.start)}${o.kind === 'circle' ? '' : ` – ${fmtOsuTime(o.end)}`}${
            repCount ? ` · 折返 ${repCount} 次` : ''
          }${span ? '（跨行）' : ''}`
          if (o.kind === 'circle') {
            const cx = Math.min(rowW - OBJ_R, Math.max(OBJ_R, xAt(o.start)))
            return (
              <g key={i} className="gd-obj circle">
                <title>{tip}</title>
                <circle cx={cx} cy={cy} r={OBJ_R} fill="none" stroke="currentColor" strokeWidth={1.2} />
              </g>
            )
          }
          // slider / spinner：时间位置对齐格心/U 形弧心；跨行时上一行画到行尾就停（开口，看起来是 =），
          // 下一行从行首接着画（开头也是 =），只有真正结束的那一行才画右半圆弧收尾。
          const x0 = startsHere
            ? Math.min(Math.max(xAt(o.start), OBJ_R + 0.5), rowW - minW - OBJ_R - 1)
            : 0
          const x1 = endsHere ? Math.min(rowW - OBJ_R - 0.5, Math.max(x0 + minW, xAt(o.end))) : rowW
          // 折返点：每段一个边界（spans-1 个），在身体范围内画「→」
          const reps: number[] = []
          if (o.kind === 'slider' && (o.spans ?? 1) > 1) {
            const n = o.spans!
            const per = (o.end - o.start) / n
            const bodyEnd = endsHere ? x1 : rowW
            for (let r = 1; r < n; r++) {
              const t = o.start + per * r
              if (t < rs.start - SNAP_MS || t > rs.end + SNAP_MS) continue
              const rx = xAt(t)
              if (rx <= x0 + 3 || rx >= bodyEnd - 3) continue
              reps.push(rx)
            }
          }
          const arc = `A ${OBJ_R} ${OBJ_R} 0 0 1`
          let strokeD = ''
          let fillD = ''
          if (startsHere && endsHere) {
            // 一整条都在本行：胶囊
            strokeD =
              o.kind === 'spinner'
                ? `M ${x0} ${cy - OBJ_R} H ${x1} ${arc} ${x1} ${cy + OBJ_R} H ${x0} ${arc} ${x0} ${cy - OBJ_R} Z`
                : `M ${x0} ${cy - OBJ_R} H ${x1} ${arc} ${x1} ${cy + OBJ_R} H ${x0}`
            if (o.kind === 'spinner') fillD = strokeD
          } else if (startsHere) {
            // 续到下一行：右端开口（两条水平线到行尾）
            strokeD =
              o.kind === 'spinner'
                ? `M ${x0} ${cy - OBJ_R} H ${rowW} M ${rowW} ${cy + OBJ_R} H ${x0} ${arc} ${x0} ${cy - OBJ_R}`
                : `M ${x0} ${cy - OBJ_R} H ${rowW} M ${x0} ${cy + OBJ_R} H ${rowW}`
            if (o.kind === 'spinner')
              fillD = `M ${x0} ${cy - OBJ_R} H ${rowW} V ${cy + OBJ_R} H ${x0} ${arc} ${x0} ${cy - OBJ_R} Z`
          } else if (endsHere) {
            // 从上一行续过来：左端开口，右端正常收尾
            strokeD = `M 0 ${cy - OBJ_R} H ${x1} ${arc} ${x1} ${cy + OBJ_R} H 0`
            if (o.kind === 'spinner') fillD = `${strokeD} Z`
          } else {
            // 中间几行：两条水平线（=）
            strokeD = `M 0 ${cy - OBJ_R} H ${rowW} M 0 ${cy + OBJ_R} H ${rowW}`
            if (o.kind === 'spinner') fillD = `M 0 ${cy - OBJ_R} H ${rowW} V ${cy + OBJ_R} H 0 Z`
          }
          return (
            <g key={i} className={`gd-obj ${o.kind}`}>
              <title>{tip}</title>
              {o.kind === 'slider' && startsHere ? (
                <circle cx={x0} cy={cy} r={OBJ_R} fill="none" stroke="currentColor" strokeWidth={1.2} />
              ) : null}
              {o.kind === 'spinner' && fillD ? (
                <path d={fillD} fill={`url(#gd-hatch-${ri})`} stroke="none" />
              ) : null}
              <path d={strokeD} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
              {reps.map((rx, j) => (
                <path
                  key={`rep-${j}`}
                  className="gd-rep"
                  d={`M ${rx - 3.2} ${cy} H ${rx + 1.8} M ${rx - 0.6} ${cy - 2.6} L ${rx + 1.8} ${cy} L ${rx - 0.6} ${cy + 2.6}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>
          )
        })}
      </svg>
    )
  }

  const renderRow = (ri: number) => {
    const r = layout.rows[ri]
    if (!r) return null
    const firstCh = r.chunks[0]
    const lastCh = r.chunks[r.chunks.length - 1]
    let acc = 0
    const nodes: JSX.Element[] = []

    // 行首缝隙：上一行与本行之间（第一行没有上一行，不画）
    if (ri > 0 && firstCh.from === 0) {
      const g = gapNode(firstCh.mi, `gaps:${ri}`, 'start')
      if (g) nodes.push(g)
    }

    for (const ch of r.chunks) {
      const ticks = ticksByMeasure[ch.mi] || []
      for (let i = 0; i < ch.count; i++) {
        const k = ch.from + i
        const col = acc + i
        const t = ticks[k]
        if (t == null) continue
        const beat = Math.floor(k / div)
        const sub = k % div
        const pri: Priority = sub === 0 ? 'beat' : tickPriority(sub, div)
        const border = withAlpha(P[pri], PRIORITY_ALPHA[pri])
        /**
         * 边框宽度：每小节第一拍（“动”）2px 粗线，其余拍（次/打/次）和等分都是 1px，
         * 靠明度（PRIORITY_ALPHA）区分普通拍与更细的等分。
         * 绝对定位的红/蓝线要以 padding box 为基准，得把边框补回来，所以这个值也要参与定位。
         */
        const bw = k === 0 ? 2 : 1
        const isCursor = selB?.row === ri && selB?.col === col
        const cellKey = `${ch.mi}:${k}`
        // 多块选区统一用 selKeys 判断：活动选区 + Ctrl 拖出来的附加选区 + 零散格子
        const inSel = selKeys.has(cellKey)
        const isPlay = play?.row === ri && play?.col === col
        const evs = eventsByCell.get(`${ch.mi}:${k}`)
        const mark = marksByCell.get(`${ch.mi}:${k}`)
        // 同一格有多个音效时按颜色分层（上下一段一段），只有 1 个就是纯色
        const layers = (evs || [])
          .map((e) => ({
            color: ksSel ? noteColor(e.names[0]) : colorByName.get(e.names[0]) || accentHex,
            alpha: getDisplayPrefs().colorAlphaByVol ? alphaForVolume(e.volume) : 1,
          }))
          .filter((L, i, arr) => arr.findIndex((x) => x.color === L.color) === i)
        const bg =
          layers.length === 0
            ? undefined
            : layers.length === 1
              ? withAlpha(layers[0].color, layers[0].alpha)
              : `linear-gradient(to bottom, ${layers
                  .map((L, i) => {
                    const a = (i * 100) / layers.length
                    const b = ((i + 1) * 100) / layers.length
                    return `${withAlpha(L.color, L.alpha)} ${a}% ${b}%`
                  })
                  .join(', ')})`
        const name = evs?.length ? evs[0].names[0] || '' : ''
        const extra = evs && evs.length > 1 ? `+${evs.length - 1}` : ''
        const mStart = k === 0

        /**
         * 缝隙里的线从格子往外排：音量条 → 蓝线 → 红线，互不重叠。
         * 每条 1.5px、间隔 0.25px；left 以 padding box 为基准，所以要补回边框宽度 bw。
         * （4px 的缝隙刚好放得下「音量条 + 一条线」，三条会在前一个格子上压 1px，很罕见。）
         */
        const hasBar = volMode === 'bar' && volInfo.mark.has(cellKey)
        const lane = (n: number) => -(bw + 0.5 + n * 1.75 + 1.5)
        const barLeft = lane(0)
        const barVol = volInfo.mark.get(cellKey) ?? 100
        const redLeft = hasBar
          ? lane(mark?.blue !== undefined ? 2 : 1)
          : -(bw + (mark?.blue !== undefined ? 4 : 2.75))
        const blueLeft = hasBar
          ? lane(1)
          : -(bw + (mark?.red !== undefined ? 1.5 : 2.75))

        // 小节之间的缝隙（整小节起点的那个 chunk 前面）
        if (i === 0 && acc > 0 && ch.from === 0) {
          const g = gapNode(ch.mi, `gap:${ri}:${ch.mi}`)
          if (g) nodes.push(g)
        }

        nodes.push(
          <div
            key={`${ch.mi}:${k}`}
            data-sel={inSel ? '1' : undefined}
            className={`gd-cell${inSel && isCursor ? ' sel' : ''}${inSel && !isCursor ? ' insel' : ''}${
              !inSel && isCursor ? ' cur' : ''
            }${
              isPlay ? ' play' : ''
            }${mStart ? ' mstart' : ''}${evs?.length ? ' filled' : ''}${
              findHits.has(cellKey) ? ' find-hit' : ''
            }`}
            style={{
              width: cell,
              height: cell,
              border: `${bw}px solid ${border}`,
              background: bg,
              color: layers.length ? readableOn(layers[0].color) : undefined,
              fontSize: Math.max(8, Math.round(cell * 0.34)),
            }}
            title={`${fmtOsuTime(t)} · ${tr('小节 {n}', { n: ch.mi + 1 })} · ${tr('第 {beat} 拍', { beat: beat + 1 })}${
              sub ? ` +${sub}/${div}` : ''
            }${
              mark?.red !== undefined ? `\n${tr('红线（Timing）')}${fmtOsuTime(mark.red)}` : ''
            }${mark?.blue !== undefined ? `\n${tr('蓝线（书签）')}${fmtOsuTime(mark.blue)}` : ''}${
              volInfo.mark.has(cellKey)
                ? `\n${tr('音量 {v}（<v={v}>）', { v: volInfo.mark.get(cellKey) ?? 100 })}`
                : ''
            }${evs?.length ? `\n${evs.map((e) => codeGlyphs(e.names) + ` (v=${e.volume})`).join('\n')}` : ''
            }`}
            onMouseDown={(e) => onCellDown(e, ri, col)}
            onMouseOver={() => onCellEnter(ri, col)}
            onContextMenu={(e) => onCellContext(e, ri, col)}
          >
            {/* 红/蓝线：画在格子左侧的缝隙里（绝对定位以 padding box 为基准，
                要再把边框宽度补回来），两个都有时红左蓝右并排 */}
            {mark?.red !== undefined ? <i className="gd-mark red" style={{ left: redLeft }} /> : null}
            {mark?.blue !== undefined ? <i className="gd-mark blue" style={{ left: blueLeft }} /> : null}
            {volMode !== 'none' && volInfo.mark.has(cellKey) ? (
              volMode === 'number' ? (
                <span className="gd-vol" title={tr('这一格写 <v={v}>', { v: volInfo.mark.get(cellKey) ?? 100 })}>
                  {volInfo.mark.get(cellKey)}
                </span>
              ) : (
                // 音量条：下面浅绿 = 已到音量，上面深绿 = 还差的；竖着贴在红/蓝线旁边
                <i
                  className="gd-vbar"
                  style={{
                    left: barLeft,
                    background: `linear-gradient(to top, var(--vbar-on) 0 ${volumePct(barVol)}%, var(--vbar-off) ${volumePct(
                      barVol,
                    )}% 100%)`,
                  }}
                />
              )
            ) : null}
            {evs?.length ? (
              <span className="gd-label">
                {cell >= 20 ? codeGlyph(name).slice(0, 4) : ''}
                {extra && cell >= 24 ? <i>{extra}</i> : null}
              </span>
            ) : null}
          </div>,
        )
      }
      acc += ch.count
    }

    // 行尾缝隙：本行最后一格与下一行第一格之间
    if (lastCh.from + lastCh.count === lastCh.total && lastCh.mi + 1 < doc.measures.length) {
      const g = gapNode(lastCh.mi + 1, `gape:${ri}`, 'end')
      if (g) nodes.push(g)
    }

    const label = r.solo
      ? `${firstCh.mi + 1} (${firstCh.part}/${firstCh.parts})`
      : firstCh.mi === lastCh.mi
        ? String(firstCh.mi + 1)
        : `${firstCh.mi + 1}–${lastCh.mi + 1}`

    return (
      <div
        className="gd-rowwrap"
        key={ri}
        style={{ height: rowH + (r.section ? SECTION_H : 0) }}
      >
        {r.section ? (
          <SectionBand
            time={r.section.time}
            name={r.section.name}
            height={SECTION_H}
            autoFocus={focusSection === r.section.time}
            onFocused={() => setFocusSection(null)}
            onRename={renameSection}
            onDelete={removeSection}
          />
        ) : null}
        <div className={`gd-row${showOsuObjects ? ' has-obj' : ''}`} style={{ height: rowH }}>
          {/* 显示数字时把行号往左挪，给第一格的音量数值腾位置（音量条很窄，不用让） */}
          <div className="gd-gutter mono" style={volMode === 'number' ? { paddingRight: 20 } : undefined}>
            {label}
          </div>
          <div className="gd-cells" style={{ gap }}>
            {nodes}
            {showOsuObjects ? renderObjLane(ri) : null}
          </div>
        </div>
      </div>
    )
  }

  if (!doc.measures.length || totalH === 0) {
    return <div className="empty">这份谱还没有小节 —— 先写 [Timing] 或导入 .osu 再来看格子</div>
  }

  /** 拖动中的源位置与插入位置（插到自己身上/自己后面不画线） */
  const dragFrom = brushDrag ? names.indexOf(brushDrag.name) : -1
  const dropAt =
    brushDrag && brushDrag.drop !== dragFrom && brushDrag.drop !== dragFrom + 1 ? brushDrag.drop : -1

  return (
    <div
      className="gd-wrap"
      ref={rootRef}
      onKeyDown={onKeyDown}
      tabIndex={0}
      // 右键框选结束后的那一次 contextmenu 要吞掉（点在格子外/缝隙上也一样）
      onContextMenu={(e) => {
        if (!suppressContext.current) return
        e.preventDefault()
        suppressContext.current = false
        rightDrag.current = null
      }}
    >
      <div className="tl-toolbar gd-toolbar">
        <label className="hint" title={tr('格子边长')}>
          {tr('格大小')}
          <input
            type="range"
            min={16}
            max={40}
            step={2}
            value={cell}
            onChange={(e) => changeCellSize(Number(e.target.value))}
            style={{ width: 88 }}
          />
        </label>
        <label className="gd-inst" title={tr('切换编辑对象：Hitsound / [Keysound] 乐器 / 音效设置')}>
          <select
            className="gd-inst-sel"
            value={defDlg ? '@define' : ksInst}
            onChange={(e) => {
              const v = e.target.value
              if (v === '@define') {
                openDefSettings()
                return
              }
              setKsInst(v)
            }}
          >
            <option value="">{tr('Hitsound')}</option>
            {ksOptions.map((o) => {
              const dup = ksOptions.filter((x) => x.name === o.name).length > 1
              return (
                <option key={`${o.staff}:${o.name}`} value={`${o.staff}:${o.name}`}>
                  {dup ? `${o.name} · ${tr('谱表 {n}', { n: o.staff + 1 })}` : o.name}
                </option>
              )
            })}
            <option value="@define">{tr('音效设置')}</option>
          </select>
        </label>
        {ksSel ? (
          <div className="gd-piano-wrap">
            <button
              className="gd-piano-nav"
              title={tr('向左滚动')}
              disabled={!pianoNav.left}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => scrollPiano(-1)}
            >
              ◀
            </button>
            <div
              ref={pianoRef}
              className="gd-piano"
              onScroll={syncPianoNav}
              title={tr('钢琴键盘：点键落笔；A~L 直接对应音名（A 永远是 A，高亮框 = 当前输入八度）')}
            >
              <div className="gd-piano-inner" style={{ width: pianoKeys.width }}>
                {pianoKeys.list.map((k) => {
                  // 只给 C 键标八度音名；当前八度那一组再显示输入字母（A~L）
                  const inOct = k.midi >= ksBase && k.midi < ksBase + 12
                  const isC = ((k.midi % 12) + 12) % 12 === 0
                  const label = inOct ? (isC ? k.name : k.key) : isC ? k.name : ''
                  return (
                    <button
                      key={k.midi}
                      data-midi={k.midi}
                      className={`gd-pkey${k.black ? ' black' : ' white'}${inOct ? ' in-oct' : ''}${
                        k.midi === ksBase ? ' root' : ''
                      }`}
                      style={{ left: k.left, width: k.width }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickPianoKey(k.midi)}
                      title={`${k.name} · ${tr('按 {key} 输入', { key: k.key })}`}
                    >
                      {label ? <span className="gd-pkey-name">{label}</span> : null}
                    </button>
                  )
                })}
                {/* 快捷键（A~L）会写进这 12 个键，框出来免得找不到输入范围 */}
                <div
                  className="gd-piano-oct"
                  style={{ left: octLeft, width: octWidth }}
                  aria-hidden="true"
                />
              </div>
            </div>
            <button
              className="gd-piano-nav"
              title={tr('向右滚动')}
              disabled={!pianoNav.right}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => scrollPiano(1)}
            >
              ▶
            </button>
          </div>
        ) : (
        <div
          ref={brushesRef}
          className={`gd-brushes${brushDrag ? ' dragging' : ''}`}
          title={tr('单击音效 = 落到选中的格子；双击音效 = 锁定成双击型（之后直接点格子落笔）；按住拖动 = 调整顺序（同步写回 [Define]）')}
        >
          {names.map((n, i) => {
            const pinned = brushMode === 'double' && brushPin === n
            const muted = brushMode === 'double' && brushPin !== n
            const c = colorByName.get(n) || accentHex
            return (
              <button
                key={n}
                className={`gd-brush${pinned ? ' on' : ''}${muted ? ' muted' : ''}${
                  brushDrag?.name === n ? ' dragging' : ''
                }${dropAt === i ? ' drop-before' : ''}${
                  dropAt === names.length && i === names.length - 1 ? ' drop-after' : ''
                }`}
                style={{ ['--bc' as string]: c, ...(pinned ? { color: readableOn(c) } : null) }}
                onMouseDown={(e) => {
                  // 阻止按钮抢焦点（否则网格的键盘操作会断），拖动由 window 上的 mousemove 接管
                  e.preventDefault()
                  if (e.button !== 0) return
                  brushPress.current = { name: n, x: e.clientX, y: e.clientY, active: false }
                }}
                onClick={(e) => onBrushClick(e, n)}
                title={`${codeGlyph(n)}${codeGlyph(n) !== n ? ` (${n})` : ''}${colorByName.get(n) ? ' · ' + colorByName.get(n) : ''}${
                  namesInSel.has(n) ? ' · ' + tr('选中的格子里已有') : ''
                }${pinned ? '（' + tr('双击型') + '）' : ''} · ${tr('拖动可调整顺序')}`}
              >
                {codeGlyph(n)}
                {namesInSel.has(n) ? (
                  <i className="gd-brush-check" title={tr('选中的格子里已经有这个音效')}>
                    <svg viewBox="0 0 8 8" width="5.5" height="5.5" aria-hidden="true">
                      <path
                        d="M1.2 4.3 3 6.1 6.8 2"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </i>
                ) : null}
              </button>
            )
          })}
          {names.length === 0 ? (
            <span className="hint">{tr('先在 [Define] 里定义音效，才能在格子里加减')}</span>
          ) : null}
        </div>
        )}
        <div className="spacer" />
      </div>

      <div
        className="gd-scroll"
        ref={wrapRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div style={{ height: topPad }} />
        {Array.from({ length: lastRow - first }, (_, i) => renderRow(first + i))}
        <div style={{ height: bottomPad }} />
      </div>

      <div className="gd-foot">
        {typed ? (
          <>
            <span className="gd-keyhint">
              <span className="gd-tag blue">{tr('代号')}</span>
              <span className="mono gd-typed">{typed}</span>
              <span className="hint">
                {typedCands.length ? `→ ${typedCands.map(codeGlyph).join(' / ')}` : tr('没有匹配的代号')}
              </span>
            </span>
            <span className="gd-sep" />
          </>
        ) : null}
        {selGap ? (
          <>
            <span className="gd-tag blue">{tr('分节')}</span>
            <span className="hint">
              {tr('在小节 {n} 前插入 · 按 Enter 分节 · Esc 取消', { n: selGap.mi + 1 })}
            </span>
          </>
        ) : selCells.length > 1 && selTimes ? (
          <>
            <span className="mono">
              {fmtOsuTime(selTimes.t0)} – {fmtOsuTime(selTimes.t1)}
            </span>
            <span className="hint">{tr('已选 {n} 格', { n: selCells.length })}</span>
          </>
        ) : selInfo ? (
          <>
            <span className="mono">{fmtOsuTime(selInfo.t)}</span>
            <span className="hint">
              {tr('小节 {m} / {meter} 拍', { m: selInfo.m.index + 1, meter: selInfo.m.meter })} ·{' '}
              {tr('第 {beat} 拍', { beat: Math.floor(selInfo.k / div) + 1 })}
              {selInfo.k % div ? ` +${selInfo.k % div}/${div}` : ''}
            </span>
            {selInfo.mark?.red !== undefined ? (
              <span className="gd-tag red mono">{tr('红线')} {fmtOsuTime(selInfo.mark.red)}</span>
            ) : null}
            {selInfo.mark?.blue !== undefined ? (
              <span className="gd-tag blue mono">{tr('书签')} {fmtOsuTime(selInfo.mark.blue)}</span>
            ) : null}
            <span className="mono gd-names">
              {selInfo.evs.length
                ? selInfo.evs.map((e) => `${codeGlyphs(e.names)} v=${e.volume}`).join('  |  ')
                : tr('（空格子）')}
            </span>
          </>
        ) : (
          <span className="hint">
            {tr('点格子定位并试听 · Shift+点击连选 · Ctrl+点击加选/取消 · Ctrl+拖动（左右键）加选区 · 右键拖动矩形框选 · 空格播放 · 敲代号落笔 · 拖动顶部音效排序 · Ctrl+F 查找替换')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="hint">
          {ksSel
            ? tr('A~L 直接对应音名（A 永远是 A，高亮框内为当前 {base} 八度）· 1–8 / Ctrl+↑↓ 换八度 · Ctrl+←→ 滚动键盘 · 选中时移调', {
                base: midiToName(ksBase),
              })
            : !names.length
              ? tr('先在 [Define] 里定义音效，才能在格子里加减')
              : brushMode === 'double'
                ? tr('双击型（{name}）：点格子落笔 · 单击音效回到单击型', { name: brushPin })
                : tr('单击型：先点/拖选格子，再点音效（或直接敲代号）落笔 · 字母区分大小写，数字/符号也能直接敲 · 双击音效切换双击型')}
        </span>
      </div>

      {defDlg ? (
        <div className="gd-vol-overlay" onMouseDown={() => setDefDlg(null)}>
          <div className="gd-def-dlg" onMouseDown={(e) => e.stopPropagation()}>
            <div className="gd-def-head">
              <span className="gd-vol-title">{tr('音效设置')}</span>
              <span className="hint">{tr('左键选中一条，改槽位、代号和颜色；改代号会同步正文')}</span>
            </div>

            <div className="gd-def-list">
              {hsDefs.map((h) => {
                const on = defDlg.sel === h.name
                const slots = slotsOfDef(h)
                return (
                  <div
                    key={h.name}
                    className={`gd-def-row${on ? ' on' : ''}`}
                    onClick={() => pickDef(h)}
                    title={`${codeGlyph(h.name)}${codeGlyph(h.name) !== h.name ? ` (${h.name})` : ''} = ${h.value}`}
                  >
                    <i
                      className="gd-def-dot"
                      style={{ background: h.color || colorByName.get(h.name) || accentHex }}
                    />
                    <span className="gd-def-code mono">{codeGlyph(h.name)}</span>
                    <span className="gd-def-slots mono">{slots.length ? slots.join('|') : 'custom'}</span>
                    <button
                      className="gd-def-play"
                      title={tr('试听')}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation()
                        void previewDef(h)
                      }}
                    >
                      ▶
                    </button>
                  </div>
                )
              })}
              {!hsDefs.length ? (
                <div className="gd-def-empty hint">{tr('还没有 hitsound 定义：先在 [Define] 里写一条')}</div>
              ) : null}
            </div>

            {defDlg.sel ? (
              <>
                <div className="gd-def-name">
                  <label>{tr('代号')}</label>
                  <input
                    className="si-code-input mono"
                    maxLength={16}
                    spellCheck={false}
                    value={defDlg.name}
                    onChange={(e) => {
                      // 和「添加音效」一致：只留字母、大小写原样；单个数字/符号转成 One / Slash
                      const norm = normalizeCodeInput(e.target.value)
                      setDefMsg('')
                      setDefDlg((d) => (d ? { ...d, name: norm } : d))
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && defCanApply) {
                        e.preventDefault()
                        applyDefEdit()
                      }
                    }}
                  />
                  <span className="hint">
                    {tr('正文里 {n} 处引用会跟着改', { n: defRefs })}
                  </span>
                </div>

                <div className="gd-def-name">
                  <label>{tr('颜色')}</label>
                  <input
                    className="si-code-input mono gd-def-color"
                    value={defDlg.color}
                    placeholder={tr('留空 = 默认色')}
                    spellCheck={false}
                    onChange={(e) => {
                      setDefMsg('')
                      setDefDlg((d) => (d ? { ...d, color: e.target.value } : d))
                    }}
                    onBlur={() => {
                      // 失焦时把 red / #f00 归一成 #RRGGBB
                      const c = parseColorToken(defDlg.color)
                      if (c) setDefDlg((d) => (d ? { ...d, color: c.toUpperCase() } : d))
                    }}
                  />
                  <input
                    type="color"
                    className={`as-swatch${defDlg.color ? '' : ' is-empty'}`}
                    title={defColor ? defColor.toUpperCase() : tr('默认色（点一下挑一个）')}
                    value={defColor ? defColor.toUpperCase() : '#7aa2f7'}
                    onChange={(e) => {
                      setDefMsg('')
                      setDefDlg((d) => (d ? { ...d, color: e.target.value.toUpperCase() } : d))
                    }}
                  />
                  {defDlg.color ? (
                    <button
                      className="as-color-clear"
                      onClick={() => {
                        setDefMsg('')
                        setDefDlg((d) => (d ? { ...d, color: '' } : d))
                      }}
                    >
                      {tr('默认')}
                    </button>
                  ) : null}
                  <span className="hint">{tr('格子和列表里的颜色都跟着变')}</span>
                </div>

                <div className="as-slots gd-def-slotgrid">
                  <div className="as-corner" />
                  {SLOT_HITS.map((hit) => (
                    <div key={hit} className="as-col">
                      {hit}
                    </div>
                  ))}
                  {SLOT_SETS.map((set) => (
                    <Fragment key={set}>
                      <div className="as-row">{set}</div>
                      {SLOT_HITS.map((hit) => {
                        const slot = `${set}-${hit}`
                        const on = defDlg.slots.includes(slot)
                        return (
                          <label key={slot} className={`as-cell${on ? ' on' : ''}`} title={slot}>
                            <input type="checkbox" checked={on} onChange={() => toggleDefSlot(slot)} />
                          </label>
                        )
                      })}
                    </Fragment>
                  ))}
                </div>
                <div className="hint gd-def-tip">
                  {tr('一个都不勾 = custom（正文里只能用代号调用）；勾多个会用')} <span className="mono">|</span>{' '}
                  {tr('连起来。')}
                </div>
              </>
            ) : null}

            <div className="gd-vol-foot">
              <span
                className={`hint${defDup || (defDlg.sel && (!defNameOk || !defColorOk)) ? ' si-err' : ''}`}
              >
                {defMsg ||
                  (defDup
                    ? tr('代号 {name} 已经被占用', { name: defNextName })
                    : defDlg.sel && !defNameOk
                      ? tr('代号只能用英文字母，大小写不限')
                      : defDlg.sel && !defColorOk
                        ? tr('颜色看不懂：写 #RRGGBB 或 red / green / blue…')
                        : defDlg.sel
                          ? tr('槽位、代号和颜色改完点「应用」')
                          : tr('左键选中一条再改'))}
              </span>
              <button className="btn small" onClick={() => setDefDlg(null)}>
                {tr('关闭')}
              </button>
              <button className="btn small accent" disabled={!defCanApply} onClick={applyDefEdit}>
                {tr('应用')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {findDlg ? (
        <div className="gd-vol-overlay gd-find-overlay" onMouseDown={closeFind}>
          <div className="gd-find-dlg" onMouseDown={(e) => e.stopPropagation()}>
            <div className="gd-vol-title">{tr('查找替换')}</div>
            <div className="gd-find-row">
              <label>{tr('查找')}</label>
              <input
                className="gd-find-input mono"
                autoFocus
                value={findDlg.find}
                placeholder={tr('Aa Ab（多个代号用空格或逗号）')}
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setFindDlg((d) => (d ? { ...d, find: e.target.value } : d))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    closeFind()
                  } else if (e.key === 'Enter' && findInfo?.changed) {
                    e.preventDefault()
                    doReplaceAll()
                  }
                }}
              />
            </div>
            <div className="gd-find-row">
              <label>{tr('替换为')}</label>
              <input
                className="gd-find-input mono"
                value={findDlg.repl}
                placeholder={tr('留空 = 删除这些代号')}
                spellCheck={false}
                onChange={(e) => setFindDlg((d) => (d ? { ...d, repl: e.target.value } : d))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    closeFind()
                  } else if (e.key === 'Enter' && findInfo?.changed) {
                    e.preventDefault()
                    doReplaceAll()
                  }
                }}
              />
            </div>
            {findInfo?.scope ? (
              <div className="gd-find-scope" title={tr('只选 1 格或不选时，查找替换会作用于整份谱面')}>
                {tr('范围：多选中的')} <b>{findInfo.scope}</b> {tr('格 —— 只查找/替换这些格子')}
              </div>
            ) : null}
            <div className="gd-find-opts">
              <label className="set-check">
                <input
                  type="checkbox"
                  checked={findDlg.exact}
                  onChange={(e) => setFindDlg((d) => (d ? { ...d, exact: e.target.checked } : d))}
                />
                <span>{tr('精确匹配')}</span>
              </label>
              <label
                className={`set-check${findDlg.exact ? ' is-off' : ''}`}
                title={findDlg.exact ? tr('精确匹配时整格都会被替换，这一项不起作用') : tr('只换命中的代号，格子里其它代号保留')}
              >
                <input
                  type="checkbox"
                  disabled={findDlg.exact}
                  checked={findDlg.exact || findDlg.onlyMatched}
                  onChange={(e) => setFindDlg((d) => (d ? { ...d, onlyMatched: e.target.checked } : d))}
                />
                <span>{tr('仅替换匹配项')}</span>
              </label>
            </div>
            <div className="hint">
              {tr('精确匹配：只命中正好是')} <span className="mono">[Aa Ab]</span> {tr('的格子；不勾选则「包含」也算')}
              （<span className="mono">[Aa Ab Ac]</span> {tr('同样命中）。')}
              <br />
              {tr('仅替换匹配项：')} <span className="mono">[Aa Ac]</span> {tr('把 Aa 换成 Bb 得到')}{' '}
              <span className="mono">[Bb Ac]</span>{tr('；取消勾选则整格变成')} <span className="mono">[Bb]</span>
              {tr('，其它代号都不保留。替换内容留空 = 把这格清空。')}
            </div>
            <div className="gd-vol-foot">
              <span className="hint">
                {findInfo && findInfo.find.length
                  ? tr('匹配 {total} 格 · 会改 {changed} 格', { total: findInfo.total, changed: findInfo.changed })
                  : tr('先填要查找的代号')}
              </span>
              <button className="btn small" onClick={closeFind}>
                {tr('关闭')}
              </button>
              <button className="btn small accent" disabled={!findInfo?.changed} onClick={doReplaceAll}>
                {tr('全部替换')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {volDlg ? (
        <div className="gd-vol-overlay" onMouseDown={() => setVolDlg(null)}>
          <div className="gd-vol-dlg" onMouseDown={(e) => e.stopPropagation()}>
            <div className="gd-vol-title">{tr('修改音量')}</div>
            <div className="hint">
              {tr('0–100 的整数，写成')} <span className="mono">&lt;v=xx&gt;</span>{tr('；这个位置已经有')} <span className="mono">&lt;v&gt;</span> {tr('就只改数值，不会重复加。')}
              {volDlg.span ? (
                <>
                  <br />
                  {tr('单选：从这一格起，到')}<strong>{tr('下一条 <v> 之前')}</strong>{tr('的格子都会改成这个音量。')}
                </>
              ) : (
                <>
                  <br />
                  {tr('多选：只改选中的 {n} 格，后面的格子自动恢复原音量。', { n: volDlg.cells.length })}
                </>
              )}
            </div>
            <input
              className="gd-vol-input mono"
              autoFocus
              type="number"
              min={0}
              max={100}
              step={1}
              value={volDlg.value}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setVolDlg((d) => (d ? { ...d, value: e.target.value } : d))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyVolume()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setVolDlg(null)
                }
              }}
            />
            <div className="gd-vol-foot">
              <span className="hint">
                {(() => {
                  const n = Number(volDlg.value)
                  return Number.isInteger(n) && n >= 0 && n <= 100 ? '' : tr('要 0–100 的整数')
                })()}
              </span>
              <button className="btn small" onClick={() => setVolDlg(null)}>
                {tr('取消')}
              </button>
              <button
                className="btn small accent"
                disabled={!(() => {
                  const n = Number(volDlg.value)
                  return Number.isInteger(n) && n >= 0 && n <= 100
                })()}
                onClick={applyVolume}
              >
                {tr('确定')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
