/**
 * 格子视图 → 正文写回。
 *
 * 只改被点到的那些小节：把它们原来的 `/.../` 重新按格子的分辨率铺平
 * （一格一个 token，空格子写 `=`），其它小节、缩进、行尾注释都不动。
 *
 * 为什么必须先铺平：正文里一个 token 的时值 = 小节时长 ÷ token 数，
 * 想在某个 token 内部插一个音，就只能把整个小节拆到同一分辨率，
 * 否则后面的所有音都会往前挤。
 *
 * 有些写法不能安全写回，直接拒绝并给理由：
 *   - 一行写多个小节（`/a b/c d/`）、跨度（`/5/`）、重复（`*n`）→ 解析器没记范围
 *   - 小节中途变 BPM（segments）→ 等分 token 的算法和实际拍位不一致
 *   - 有音符落在格子之外（细分不够细）→ 铺平会把它量化到相邻格
 */
import type { ChartDoc, MeasureInfo, NoteEvent } from './types'
import { beatsAt, measureBeatLayout, measureBeatTimes, measureTicks } from './measures'
import { midiToToken, nameToMidi } from './pitch'

export interface GridEditResult {
  ok: boolean
  /** 改好的整份文本（ok 时才有） */
  text?: string
  /** 失败原因（给日志/提示用） */
  reason?: string
}

/** 写回目标：默认 hitsound，keysound 需要指定谱表 */
export interface GridEditTarget {
  mode?: 'hitsound' | 'keysound'
  /** keysound 谱表下标（0 起） */
  staff?: number
  /** 没有 [Keysound] 段时要新建，用这个乐器名写花括号 */
  instrument?: string
  /** 新建 [Keysound] 段时，按谱表顺序列出的全部乐器名（名额不够时用它补齐） */
  instruments?: string[]
}

export interface CellState {
  names: string[]
  volume: number
  index: number
}

/** 一次写入：把第 mi 小节的第 k 格改成 next（函数形式会收到这一格现在的代号） */
export interface CellEdit {
  mi: number
  k: number
  next: string[] | ((cur: string[]) => string[])
  /** 粘贴时连同音量一起写；不传就沿用这一格原来的 */
  volume?: number
  index?: number
  /**
   * 强制写 `<v=xx>`（哪怕这一格是空的、或值和上一格一样）。
   * 右键「修改音量」用：用户明确要求在这个位置留一个 `<v>`。
   */
  volumeForce?: boolean
  /**
   * 删掉这一格前面的 `<v=xx>`。
   * 这一格以及后面沿用它音量的格子，回到前一段的音量（也就是删掉标记后正文本来的含义）。
   */
  volumeClear?: boolean
}

/** 对齐容差（毫秒）：导入的整数毫秒和浮点拍点最多差 0.5 上下 */
const SNAP_MS = 1.5

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) {
    const t = a % b
    a = b
    b = t
  }
  return a || 1
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b
}

/**
 * 正文里的一个「时值单位」——只关心它在小节里占多少、占哪一段，
 * 不校验内容是否合法（那是 `body.ts` 的事）。
 */
interface BodyNode {
  kind: 'cell' | 'dir' | 'group'
  /** 占几个时值单位 */
  dur: number
  text: string
  children?: BodyNode[]
  /** `[...]` 叠音：子项共用同一个起点；`(...)` 子项顺次排开 */
  chord?: boolean
}

/** 切 token 时遇到这些字符就断开（括号内部单独处理） */
const NODE_STOP = /[\s<>()[\]|#*]/

function cloneNode(n: BodyNode): BodyNode {
  return { ...n, children: n.children ? n.children.map(cloneNode) : undefined }
}

/**
 * 把一小节 `/.../` 里的正文解析成树。
 *
 * 括号必须当树看：`(Aa = = Ab)` 是**一拍**里再分 4 份，而不是 4 个独立格子。
 * 之前这里把整段括号当成一个 token，于是括号里的内容（含 `<v=xx>`）全被忽略，
 * 写回时会把音量标记弄丢。后缀语义照抄 `body.ts`：`2` = 时值、`-` = 延一拍、
 * `*3` = 重复三遍。
 */
function parseBodyNodes(src: string): BodyNode[] {
  const nodes: BodyNode[] = []
  let i = 0
  /** 处理紧跟在一个单位后面的 `2` / `-` / `*3` */
  const suffix = (node: BodyNode) => {
    while (i < src.length) {
      const c = src[i]
      if (c === ' ' || c === '\t') {
        i++
        continue
      }
      if (c === '-') {
        node.dur += 1
        i++
        continue
      }
      if (c === '*') {
        let j = i + 1
        let num = ''
        while (j < src.length && src[j] >= '0' && src[j] <= '9') {
          num += src[j]
          j++
        }
        if (num) {
          const reps = Math.min(64, Math.max(1, Number(num)))
          for (let r = 1; r < reps; r++) nodes.push(cloneNode(node))
        }
        i = j
        continue
      }
      if (c >= '0' && c <= '9') {
        let j = i
        let num = ''
        while (j < src.length && src[j] >= '0' && src[j] <= '9') {
          num += src[j]
          j++
        }
        node.dur = Math.max(1, Number(num))
        i = j
        continue
      }
      break
    }
  }

  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '|') {
      i++
      continue
    }
    if (c === '#') break
    if (c === '<') {
      const j = src.indexOf('>', i)
      if (j < 0) break
      nodes.push({ kind: 'dir', dur: 0, text: src.slice(i, j + 1) })
      i = j + 1
      continue
    }
    if (c === '(' || c === '[') {
      const close = c === '(' ? ')' : ']'
      let depth = 0
      let j = i
      for (; j < src.length; j++) {
        if (src[j] === c) depth++
        else if (src[j] === close) {
          depth--
          if (!depth) break
        }
      }
      const node: BodyNode = {
        kind: 'group',
        dur: 1,
        text: c,
        children: parseBodyNodes(src.slice(i + 1, j)),
        chord: c === '[',
      }
      i = Math.min(j + 1, src.length)
      nodes.push(node)
      suffix(node)
      continue
    }
    if (c === '-') {
      const last = nodes[nodes.length - 1]
      if (last && last.kind !== 'dir') last.dur += 1
      i++
      continue
    }
    if (c === '*') {
      // 孤立的 `*n`（前面没有可重复的单位）：吃掉次数，忽略
      let j = i + 1
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++
      i = j
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      let num = ''
      while (j < src.length && src[j] >= '0' && src[j] <= '9') {
        num += src[j]
        j++
      }
      const last = nodes[nodes.length - 1]
      if (last && last.kind !== 'dir') last.dur = Math.max(1, Number(num))
      i = j
      continue
    }
    let j = i
    while (
      j < src.length &&
      !NODE_STOP.test(src[j]) &&
      !(src[j] >= '0' && src[j] <= '9') &&
      src[j] !== '-'
    ) {
      j++
    }
    if (j === i) {
      i++
      continue
    }
    const node: BodyNode = { kind: 'cell', dur: 1, text: src.slice(i, j) }
    i = j
    nodes.push(node)
    suffix(node)
  }
  return nodes
}

/**
 * 顺着正文树往下走，算出每个时值单位的起点（小节内的比例 0~1）和它生效的音量。
 * 只记**显式写了 `<v=xx>`** 的位置（继承来的不算）。
 */
function collectVolumeMarks(nodes: BodyNode[]): Map<number, number> {
  const marks = new Map<number, number>()
  let total = 0
  for (const n of nodes) if (n.kind !== 'dir') total += n.dur
  if (!total) return marks
  let cur = 0
  let pending: number | null = null
  for (const n of nodes) {
    if (n.kind === 'dir') {
      // `<v=50>` 和 `<volume=50>` 是同义词（body.ts 两种都认）
      const m = /^<(?:v|volume)=(\d+)>$/i.exec(n.text)
      if (m) pending = Number(m[1])
      continue
    }
    const span = n.dur / total
    if (pending !== null) {
      marks.set(cur, pending)
      pending = null
    }
    if (n.kind === 'group' && !n.chord && n.children?.length) {
      for (const [p, v] of collectVolumeMarks(n.children)) marks.set(cur + p * span, v)
    }
    cur += span
  }
  return marks
}

/**
 * 正文这一小节里 `<v=xx>` 各自落在哪一格（第 k 格 = 第 k 个「拍/细分」刻度）。
 *
 * 括号内按它自己的份数再分，所以 `(= = <v=40> Aa)` 里的 `<v>` 落在这一拍的
 * 第 3 份上 —— 用比例换算到格子，而不是简单地数 token。
 */
export function measureVolumeMarks(
  doc: ChartDoc,
  mi: number,
  div: number,
  target: GridEditTarget = {},
): Map<number, number> {
  const m = doc.measures[mi]
  const n = m ? measureTicks(m, div).length : 0
  const range = target.mode === 'keysound' ? m?.ksBodies?.[target.staff ?? 0] : m?.body
  if (!m || !n || !range) return new Map()
  const marks = volumeMarkFractions(doc, range)
  const out = new Map<number, number>()
  for (const [pos, v] of marks) {
    const k = Math.min(n - 1, Math.max(0, Math.floor(pos * n + 1e-6)))
    out.set(k, v)
  }
  return out
}

/** 同上，但按「每拍 work 格」换算（work 可能是 div 的整数倍） */
function volumeMarkSlots(
  doc: ChartDoc,
  m: ChartDoc['measures'][number],
  work: number,
  range: { from: number; to: number },
): Map<number, number> {
  const beats = measureBeatTimes(m).length
  const n = beats * work
  if (!n) return new Map()
  const marks = volumeMarkFractions(doc, range)
  const out = new Map<number, number>()
  for (const [pos, v] of marks) {
    const j = Math.min(n - 1, Math.max(0, Math.floor(pos * n + 1e-6)))
    out.set(j, v)
  }
  return out
}

/** `<v=xx>` 的位置（小节内的比例 0~1）→ 音量（range 可以是整行，也可以是某条谱表那一段） */
function volumeMarkFractions(doc: ChartDoc, range: { from: number; to: number }): Map<number, number> {
  const raw = doc.text.slice(range.from, range.to)
  const a = raw.indexOf('/')
  const b = raw.lastIndexOf('/')
  const inner = a >= 0 && b > a ? raw.slice(a + 1, b) : raw
  return collectVolumeMarks(parseBodyNodes(inner))
}

/**
 * 单选「修改音量」的作用范围：从这一格一直到下一条 `<v>` 之前（只在本小节内）。
 *
 * 语义等价于「在这格的 token 前面加一条 `<v=xx>`」——后面的小节不用改，
 * 它们本来就会继承这个音量，直到遇到自己的 `<v>`。
 */
export function volumeSpanFrom(doc: ChartDoc, mi: number, k: number, div: number): number[] {
  const m = doc.measures[mi]
  const n = m ? measureTicks(m, div).length : 0
  if (!n || k >= n) return []
  const marks = measureVolumeMarks(doc, mi, div)
  let end = n
  for (let j = k + 1; j < n; j++) {
    if (marks.has(j)) {
      end = j
      break
    }
  }
  const out: number[] = []
  for (let j = k; j < end; j++) out.push(j)
  return out
}

/** 一小节最多展开到每拍多少格（再细就拒绝，免得一行被撑爆） */
const MAX_WORK = 64

/** 认到多细的分母：比这更怪的位置（1/17 拍之类）当噪声处理，照旧报错 */
const MAX_DENOM = 24

/**
 * 这一小节「够用」的分辨率：div 的整数倍里最小的、能装下所有音符的那个。
 *
 * 为什么要放大：同一小节里先下了 1/4 再下 1/6，1/4 = 3/12、1/6 = 2/12 ——
 * 4 格和 6 格都装不下，得按最小公倍数 12 格来排。
 * 取 div 的整数倍是因为界面上的格子下标 k 要能换算成这里的格（k × mult）。
 *
 * 只对**简洁分数**放宽：先给这个位置找一个分母 ≤ MAX_DENOM 的近似分数，
 * 找不到（多半是导入时四舍五入留下的噪声）就维持原来的「细分不够细」报错，
 * 免得为了一个 0.9ms 的偏差把一小节撑成几十格。
 */
function workDivFor(m: MeasureInfo, events: NoteEvent[], div: number): number | null {
  const { lengths } = measureBeatLayout(m)
  const bl = lengths && lengths[0] > 0 ? lengths[0] : 500
  /** 容差（以「拍」为单位） */
  const tol = SNAP_MS / bl
  let work = div
  for (const e of events) {
    const fb = beatsAt(m, e.time)
    /** 拍内位置：拍号里的第几拍不用管，分辨率是「每拍几格」 */
    const f = fb - Math.floor(fb + 1e-9)
    if (Math.abs(fb * work - Math.round(fb * work)) <= tol * work) continue // 已经落在当前分辨率上
    let best = 0
    let bestErr = Infinity
    for (let q = 2; q <= MAX_DENOM; q++) {
      const p = Math.round(f * q)
      if (p <= 0 || p >= q) continue // 0 / 整拍说明它本来就落在格上
      const err = Math.abs(f - p / q)
      // 分母小的优先：4/12 该认成 1/3，而不是 1/12
      if (err <= tol && err < bestErr) {
        bestErr = err
        best = q
      }
    }
    // 找不到简洁分数：只有「贴着拍头/拍尾」能放行（那种偏差是四舍五入留下的）
    if (!best) {
      if (Math.min(f, 1 - f) <= tol) continue
      return null
    }
    work = lcm(work, best)
    if (work > MAX_WORK) return null
  }
  return work
}

interface MeasureSlots {
  measure: MeasureInfo
  /** 这一小节有几拍 */
  beats: number
  /** 每拍展开多少格（= div × mult，界面上的 1 格 = 这里 mult 格） */
  work: number
  mult: number
  /** 一共 beats × work 格 */
  slots: CellState[]
  /** 正文里显式写了 `<v=xx>` 的格（这里的下标） */
  volMarks: Map<number, number>
}

type SlotsResult = { ok: true; s: MeasureSlots } | { ok: false; reason: string }

/**
 * 读出这一小节的每一格（按 work 分辨率）。
 *
 * 和以前只看 `div` 不同：碰到装不下的音符不再直接报错，而是把分辨率放大到
 * 能装下的最小整数倍 —— 于是 1/4 和 1/6 可以待在同一小节里。
 */
function collectSlots(doc: ChartDoc, mi: number, div: number, target: GridEditTarget = {}): SlotsResult {
  const ks = target.mode === 'keysound'
  const staff = target.staff ?? 0
  const m = doc.measures[mi]
  if (!m) return { ok: false, reason: '小节不存在' }
  const beats = measureBeatTimes(m).length
  if (!beats) return { ok: false, reason: '这一小节没有可用的拍点（检查 [Timing]）' }

  const events = doc.events.filter(
    (e) =>
      e.measure === m.index + 1 &&
      (ks ? e.kind === 'keysound' && (e.staff ?? 0) === staff : e.kind !== 'keysound'),
  )
  const work = workDivFor(m, events, div)
  if (!work) return { ok: false, reason: '这一小节有音符不在格子上（细分不够细），先把「细分」调大再改' }
  const mult = work / div
  const n = beats * work

  // volume = -1 表示这一格还没有音效
  const slots: CellState[] = Array.from({ length: n }, () => ({ names: [], volume: -1, index: 0 }))
  for (const e of events) {
    let j = Math.round(beatsAt(m, e.time) * work)
    if (j < 0) j = 0
    if (j >= n) j = n - 1
    const c = slots[j]
    if (!c.names.length) {
      c.volume = e.volume
      c.index = e.index ?? 0
    } else if (c.volume !== e.volume) {
      // 同一格里两个音音量不同：写成 [A B] 会丢掉其中一个音量
      return { ok: false, reason: '同一格里有不同音量的叠音，先在文本里处理' }
    }
    for (const nm of e.names) if (nm && !c.names.includes(nm)) c.names.push(nm)
  }
  const range = ks ? m.ksBodies?.[staff] : m.body
  const volMarks = range ? volumeMarkSlots(doc, m, work, range) : new Map<number, number>()
  // 没有音效、只写了 <v=xx> 的格子：把音量补上，免得下次写回时被丢掉
  for (const [j, v] of volMarks) {
    if (slots[j] && slots[j].volume < 0) slots[j].volume = v
  }
  return { ok: true, s: { measure: m, beats, work, mult, slots, volMarks } }
}

/** 读一小节每格的代号/音量/编号（复制格子用；不修改内容） */
export function readMeasureCells(
  doc: ChartDoc,
  mi: number,
  div: number,
  target: GridEditTarget = {},
): { ok: true; cells: CellState[] } | { ok: false; reason: string } {
  const got = collectSlots(doc, mi, div, target)
  if (!got.ok) return got
  const { slots, beats, mult } = got.s
  const cells: CellState[] = []
  for (let k = 0; k < beats * div; k++) {
    const c = slots[k * mult]
    cells.push({ names: [...c.names], volume: c.volume < 0 ? 100 : c.volume, index: c.index })
  }
  return { ok: true, cells }
}

/**
 * 把一格子里的代号序列写成 token。
 * keysound 的名字在内存里是 `C4`（midiToName），写回正文要换成 `4C`（八度前缀）。
 */
function tokenOf(names: string[], ks = false): string {
  const list = ks
    ? names.map((n) => {
        const m = nameToMidi(n)
        return m == null ? n : midiToToken(m)
      })
    : names
  if (!list.length) return '='
  if (list.length === 1) return list[0]
  return `[${list.join(' ')}]`
}

/** 这一小节之前的音量/编号状态（用于决定第一格要不要写 <v>/<i> 前缀） */
function inheritedState(events: NoteEvent[], start: number, target: GridEditTarget = {}) {
  const ks = target.mode === 'keysound'
  const staff = target.staff ?? 0
  let volume = 100
  let index = 0
  for (const e of events) {
    if (e.time >= start - 0.5) break
    if (ks ? !(e.kind === 'keysound' && (e.staff ?? 0) === staff) : e.kind === 'keysound') continue
    volume = e.volume
    index = e.index ?? 0
  }
  return { volume, index }
}

/**
 * 把整小节序列化成一行 `/.../`。
 *
 * 两种写法：
 *   - 所有音符都落在当前细分上（work === div）→ 一格一个 token，和以前一样；
 *   - 有音符落在更细的位置上（1/4 混 1/6 之类）→ **一拍一个括号**，括号里按
 *     这一拍自己的最小公倍数细分。这样 4/4 拍一小节就是 4 个括号，
 *     同一拍里有 1/3 和 1/4 才用 1/12，不同拍各算各的；
 *     括号里只有一个时值单位时（`(Aa)`）括号没有意义，就省略。
 */
function serialize(
  doc: ChartDoc,
  s: MeasureSlots,
  div: number,
  forced: Set<number> = new Set(),
  clear: Set<number> = new Set(),
  target: GridEditTarget = {},
) {
  const { measure, beats, work, slots } = s
  const { volume: baseVol, index: baseIdx } = inheritedState(doc.events, measure.start, target)
  // 空格子沿用前面的音量/编号：往空格里加音效时不该突然变成 100
  let fv = baseVol
  let fi = baseIdx
  for (const c of slots) {
    if (c.volume >= 0) {
      fv = c.volume
      fi = c.index
    } else {
      c.volume = fv
      c.index = fi
    }
  }
  // 删除音量标记：这一格和后面沿用同一音量的格子改成前一段的音量，
  // 于是写回时它们和 prevVol 相同，不会再冒出 `<v>`。
  for (const k of [...clear].sort((a, b) => a - b)) {
    if (k < 0 || k >= slots.length) continue
    const removed = slots[k].volume
    const prev = k > 0 ? slots[k - 1].volume : baseVol
    for (let j = k; j < slots.length; j++) {
      if (slots[j].volume !== removed) break
      slots[j].volume = prev
    }
  }

  let prevVol = baseVol
  let prevIdx = baseIdx
  /** 写出第 j 格（含它前面的 <v>/<i> 前缀） */
  const emit = (j: number): string => {
    const c = slots[j]
    // 空格的 `=` 不消费音量/编号，所以别在它前面写前缀，否则一行会被塞满 <v>/<i>
    // 例外：用户右键设过音量的格子（forced）即使空着也写一条 `<v=xx>`
    const force = forced.has(j)
    let pre = ''
    if (c.names.length || force) {
      if (c.volume !== prevVol || force) {
        pre += `<v=${c.volume}> `
        prevVol = c.volume
      }
      if (c.index !== prevIdx) {
        pre += `<i=${c.index}> `
        prevIdx = c.index
      }
    }
    return pre + tokenOf(c.names, target.mode === 'keysound')
  }

  // 先算每一拍至少要分成几份，再决定用哪种写法
  const perBeat: number[] = []
  for (let b = 0; b < beats; b++) {
    let d = 1
    for (let j = 0; j < work; j++) {
      const gi = b * work + j
      if (!slots[gi].names.length && !forced.has(gi)) continue
      d = lcm(d, work / gcd(j, work))
    }
    perBeat.push(d)
  }
  /**
   * 两种写法：
   *   - 全都是 1/4 节奏（每拍需要的份数都能被 4 整除）→ 一格一个 token，和以前一样；
   *   - 有非 1/4 节奏（1/3、1/6…）→ 一拍一个括号，括号内按这一拍自己的最小公倍数细分。
   *     括号里只有一个时值单位时（`(Aa)`）加不加都一样，省掉。
   */
  const plain = work === div && perBeat.every((d) => 4 % d === 0)
  if (plain) {
    const toks: string[] = []
    for (let j = 0; j < slots.length; j++) toks.push(emit(j))
    return `/${toks.join(' ')}/`
  }

  const parts: string[] = []
  for (let b = 0; b < beats; b++) {
    const base = b * work
    const d = perBeat[b]
    if (d === 1) {
      parts.push(emit(base))
      continue
    }
    const step = work / d
    const inner: string[] = []
    for (let t = 0; t < d; t++) inner.push(emit(base + t * step))
    parts.push(`(${inner.join(' ')})`)
  }
  return `/${parts.join(' ')}/`
}

/**
 * 批量写回：一次操作可以跨多个小节，最后合成**一次**文本替换，
 * 这样撤销/重做按「一次用户操作」回退，而不是一小节一步。
 */
export function applyCellEdits(
  doc: ChartDoc,
  edits: CellEdit[],
  div: number,
  target: GridEditTarget = {},
): GridEditResult {
  if (!edits.length) return { ok: true, text: doc.text }
  const ks = target.mode === 'keysound'
  const staff = target.staff ?? 0
  /** 去掉 serialize 产出的两侧 `/`（多谱表行只替换自己那一段） */
  const innerOf = (line: string) =>
    line.startsWith('/') && line.endsWith('/') ? line.slice(1, -1) : line

  const byMeasure = new Map<number, CellEdit[]>()
  for (const e of edits) {
    const list = byMeasure.get(e.mi)
    if (list) list.push(e)
    else byMeasure.set(e.mi, [e])
  }

  const ops: { from: number; to: number; text: string }[] = []
  /** 正文里还没有行的小节（两段之间的空洞、谱面末尾的空小节） */
  const missing: { mi: number; start: number; line: string }[] = []

  for (const [mi, list] of byMeasure) {
    const got = collectSlots(doc, mi, div, target)
    if (!got.ok) return { ok: false, reason: got.reason }
    const { slots, measure, volMarks, mult, beats } = got.s
    /** 强制写 <v> 的格子：正文里本来就有 <v> 的 + 这次右键改音量的 */
    const forced = new Set<number>(volMarks.keys())
    /** 这次要删掉 <v> 的格子 */
    const clear = new Set<number>()

    for (const e of list) {
      if (e.k < 0 || e.k >= beats * div) return { ok: false, reason: '格子序号超出小节范围' }
      // 界面上的 1 格 = 内部 mult 格
      const j = e.k * mult
      const raw = typeof e.next === 'function' ? e.next(slots[j].names) : e.next
      const names = [...new Set(raw.map((n) => n.trim()).filter(Boolean))]
      slots[j] = {
        names,
        volume: e.volume ?? slots[j].volume,
        index: e.index ?? slots[j].index,
      }
      if (e.volumeClear) {
        clear.add(j)
        forced.delete(j)
      } else if (e.volumeForce && e.volume !== undefined) forced.add(j)
    }

    const line = serialize(doc, got.s, div, forced, clear, target)
    const body = ks ? measure.ksBodies?.[staff] : measure.body
    if (body) {
      const bare = ks && 'bare' in body && body.bare
      ops.push({ from: body.from, to: body.to, text: bare ? innerOf(line) : line })
    } else if (ks ? measure.ksCovered?.[staff] : measure.coveredBy !== undefined) {
      return {
        ok: false,
        reason: ks
          ? '这一小节的 Keysound 用了跨度/重复写法，格子暂不支持改'
          : '这一小节和别的小节写在同一行（或用了跨度/重复），格子暂不支持改',
      }
    } else {
      missing.push({ mi, start: measure.start, line })
    }
  }

  if (missing.length && ks) {
    const sec = doc.sections.find((s) => s.name.toLowerCase() === 'keysound')
    const items = [...missing].sort((a, b) => a.start - b.start)
    const body = items
      .map((it) => `#${Math.floor(it.start)}\n/${'| '.repeat(staff)}${innerOf(it.line)}/`)
      .join('\n')
    if (sec) {
      const lead = sec.to > 0 && doc.text[sec.to - 1] !== '\n' ? '\n' : ''
      // 段末正好是空行时补一个换行，免得新行和下一个段标题黏在一起
      const tail = doc.text[sec.to] === '\n' ? '\n' : ''
      ops.push({ from: sec.to, to: sec.to, text: lead + body + tail })
    } else {
      const inst = target.instrument
      if (!inst) return { ok: false, reason: '这份谱没有 [Keysound] 段，也没有可用的乐器名' }
      // 谱表下标可能不是 0：按顺序把已知乐器名都写进花括号，保证这一条落在对的谱表上
      const names = target.instruments?.length ? target.instruments : [inst]
      const header = Array.from({ length: Math.max(names.length, staff + 1) }, (_, i) => names[i] || inst)
      ops.push({
        from: doc.text.length,
        to: doc.text.length,
        text: `\n\n[Keysound]\n{${header.join(' | ')}}\n${body}\n`,
      })
    }
  } else if (missing.length) {
    const sec = doc.sections.find((s) => s.name.toLowerCase() === 'hitsound')
    /** 插入点 → 若干段文本（最后按时间拼起来，一起插） */
    const blocks = new Map<number, string[]>()
    const pushBlock = (at: number, text: string) => {
      const list = blocks.get(at)
      if (list) list.push(text)
      else blocks.set(at, [text])
    }
    const chunkOf = (items: { start: number; line: string }[]) =>
      [...items]
        .sort((a, b) => a.start - b.start)
        .map((it) => `#${Math.floor(it.start)}\n${it.line}`)
        .join('\n')

    // 每个小节前面最近一个「独占一行」的小节：补出来的行接在它后面，
    // 位置尽量贴近用户在看的地方，而不是一股脑堆到文件末尾。
    const lastBodyBefore: number[] = []
    let lastBody = -1
    for (let i = 0; i < doc.measures.length; i++) {
      lastBodyBefore.push(lastBody)
      if (doc.measures[i].body) lastBody = i
    }

    // 谱面末尾的空小节：直接接在 [Hitsound] 段末
    const tailItems = missing.filter((m) => m.mi >= doc.usedMeasures)
    if (tailItems.length) {
      const body = chunkOf(tailItems)
      if (sec) pushBlock(sec.to, body)
      else pushBlock(doc.text.length, `[Hitsound]\n${body}`)
    }

    // 中间的空洞：接在上一行后面，末尾再补一个标记把后续内容送回原来的小节
    const byAnchor = new Map<number, { mi: number; start: number; line: string }[]>()
    for (const it of missing) {
      if (it.mi >= doc.usedMeasures) continue
      const anchor = it.mi < lastBodyBefore.length ? lastBodyBefore[it.mi] : lastBody
      const list = byAnchor.get(anchor)
      if (list) list.push(it)
      else byAnchor.set(anchor, [it])
    }
    for (const [anchor, items] of byAnchor) {
      let body = chunkOf(items)
      // 后面紧跟的原有行原本落在 anchor+1 小节；补了行之后要把它推回原位
      const nextM = anchor >= 0 ? doc.measures[anchor + 1] : undefined
      if (nextM && nextM.coveredBy !== undefined) body += `\n#${Math.floor(nextM.start)}`

      if (anchor >= 0) {
        const b = doc.measures[anchor].body!
        const nl = doc.text.indexOf('\n', b.to)
        pushBlock(nl < 0 ? doc.text.length : nl, body)
      } else if (sec) {
        // 前面没有任何正文行（谱面开头的空小节）：放到 [Hitsound] 段标题后面
        const nl = doc.text.indexOf('\n', sec.from)
        pushBlock(nl < 0 ? doc.text.length : nl, body)
      } else {
        pushBlock(doc.text.length, `[Hitsound]\n${body}`)
      }
    }

    for (const [at, list] of blocks) {
      const text = list.join('\n')
      const lead = at > 0 && doc.text[at - 1] !== '\n' ? '\n' : ''
      // 插入点和某个小节的行尾重合时，直接接在这一行的替换文本后面，
      // 否则替换改变长度后偏移会失效。
      const rep = ops.find((o) => o.from < o.to && o.to === at)
      if (rep) rep.text += lead + text
      else ops.push({ from: at, to: at, text: lead + text })
    }
  }

  // 从后往前替换，前面的偏移量才不会被后面的改动带跑
  ops.sort((a, b) => b.from - a.from || b.to - a.to)
  let text = doc.text
  for (const op of ops) text = text.slice(0, op.from) + op.text + text.slice(op.to)
  return { ok: true, text }
}

/** 单格版本（保留给测试和简单调用） */
export function applyCellEdit(
  doc: ChartDoc,
  mi: number,
  k: number,
  div: number,
  nextNames: string[],
  target: GridEditTarget = {},
): GridEditResult {
  return applyCellEdits(doc, [{ mi, k, next: nextNames }], div, target)
}
