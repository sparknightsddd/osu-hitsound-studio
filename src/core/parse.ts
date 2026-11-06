import type {
  ChartDoc,
  Diagnostic,
  HitsoundDef,
  HitType,
  IndexRange,
  KeysoundInstrument,
  KeysoundSpec,
  ListDef,
  PhraseDef,
  SampleSet,
  SectionMark,
  Settings,
  SlotAlt,
  TimingPoint,
} from './types'
import { MeasureGrid } from './measures'
import { parseColorToken } from './colors'

/** 小节网格至少铺满这么多小节，保证空谱面/短正文也有东西可看 */
const MIN_GRID_MEASURES = 32
/** 最后一个 Timing 之后至少再保留这么多小节，让变速在时间轴上可见 */
const TAIL_GRID_MEASURES = 8
/** 铺网格的硬上限，防止 Timing 写得离谱时卡死 */
const MAX_GRID_MEASURES = 20000
import {
  expandKeysoundPath,
  parsePitchToken,
  splitTemplateArgs,
  unquote,
} from './keysound'
import { PIANO_HIGH, PIANO_LOW } from './pitch'
import { parseHitsoundBody, type BodyCtx, type LineInfo } from './body'

export interface Line {
  text: string
  code: string
  start: number
  end: number
  index: number
}

export function splitLines(text: string): Line[] {
  const out: Line[] = []
  let pos = 0
  const raw = text.split(/\r?\n/)
  raw.forEach((t, i) => {
    const { code } = stripComment(t)
    out.push({ text: t, code, start: pos, end: pos + t.length, index: i })
    pos += t.length + 1
  })
  return out
}

/**
 * 只有 "##" 才是注释（可在行首，也可在代码后面）。
 * 单个 "#" 在正文里是段落标记（#123456 / #2:03.456 / #bookmark(0) / #timing(0)），不是注释。
 */
function stripComment(text: string): { code: string; end: number } {
  let inQuote = false
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i]
    if (c === '"') inQuote = !inQuote
    if (inQuote) continue
    if (c === '#' && text[i + 1] === '#') return { code: text.slice(0, i), end: i }
  }
  return { code: text, end: text.length }
}

const SET_MAP: Record<string, SampleSet> = {
  soft: 'soft',
  normal: 'normal',
  drum: 'drum',
  s: 'soft',
  n: 'normal',
  d: 'drum',
}
const TYPE_MAP: Record<string, HitType> = {
  hitnormal: 'hitnormal',
  hitwhistle: 'hitwhistle',
  hitfinish: 'hitfinish',
  hitclap: 'hitclap',
  sliderside: 'sliderside',
  slidertick: 'slidertick',
  n: 'hitnormal',
  w: 'hitwhistle',
  f: 'hitfinish',
  c: 'hitclap',
  s: 'sliderside',
  t: 'slidertick',
}

function parseAlt(raw: string, from: number, to: number, diags: Diagnostic[], abs: number): SlotAlt {
  const r = raw.trim().toLowerCase()
  if (r === 'custom') return { raw, custom: true, from: abs + from, to: abs + to }
  if (r.includes('-')) {
    const [a, b] = r.split('-')
    const ss = SET_MAP[a]
    const tt = TYPE_MAP[b]
    if (!ss || !tt) {
      diags.push({
        from: abs + from,
        to: abs + to,
        severity: 'error',
        message: `无法识别的音效槽位 "${raw}"（可用：soft/normal/drum + hitnormal/hitwhistle/hitfinish/hitclap/sliderside/slidertick，或缩写如 sc、dw）`,
        code: 'slot-unknown',
      })
    }
    return {
      raw,
      custom: false,
      sampleSet: ss,
      hitType: tt,
      from: abs + from,
      to: abs + to,
    }
  }
  if (TYPE_MAP[r] && r.length > 2) {
    // 完整写法：hitnormal / hitwhistle / hitfinish / hitclap / sliderside / slidertick。
    // 不带 set 表示「哪种音效固定，s/n/d 留给导出时按优先级挑」。
    return { raw, custom: false, hitType: TYPE_MAP[r], from: abs + from, to: abs + to }
  }
  if (r.length === 2) {
    const ss = SET_MAP[r[0]]
    const tt = TYPE_MAP[r[1]]
    if (!ss || !tt) {
      diags.push({
        from: abs + from,
        to: abs + to,
        severity: 'error',
        message: `无法识别的音效槽位缩写 "${raw}"`,
        code: 'slot-unknown',
      })
    }
    return { raw, custom: false, sampleSet: ss, hitType: tt, from: abs + from, to: abs + to }
  }
  diags.push({
    from: abs + from,
    to: abs + to,
    severity: 'error',
    message: `无法识别的音效槽位 "${raw}"`,
    code: 'slot-unknown',
  })
  return { raw, custom: false, from: abs + from, to: abs + to }
}

/** 解析 `slotExpr(|slotExpr)*` 以及可选的 `{indexList}` */
function parseSlotPart(
  s: string,
  abs: number,
  diags: Diagnostic[],
): { alts: SlotAlt[]; indices: IndexRange[]; name: string; nameStart: number } {
  const alts: SlotAlt[] = []
  const indices: IndexRange[] = []
  let rest = s
  // 逐个 alt 扫描：alt  boleh 带 {..}
  let pos = 0
  let guard = 0
  while (pos < rest.length && guard++ < 32) {
    // 跳空格
    while (pos < rest.length && rest[pos] === ' ') pos++
    if (pos >= rest.length) break
    let j = pos
    while (j < rest.length && rest[j] !== '|' && rest[j] !== '{' && rest[j] !== ' ') j++
    const raw = rest.slice(pos, j)
    if (raw) alts.push(parseAlt(raw, pos, j, diags, abs))
    pos = j
    if (rest[pos] === '{') {
      let depth = 0
      let k = pos
      for (; k < rest.length; k++) {
        if (rest[k] === '{') depth++
        else if (rest[k] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      const inner = rest.slice(pos + 1, k)
      indices.push(...parseIndexList(inner, abs + pos, diags))
      pos = Math.min(k + 1, rest.length)
    }
    if (rest[pos] === '|') {
      pos++
      continue
    }
    break
  }
  // 剩余部分为自定义音效名
  while (pos < rest.length && rest[pos] === ' ') pos++
  return { alts, indices, name: rest.slice(pos).trim(), nameStart: pos }
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') depth--
    if (c === sep && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}

function parseIndexList(inner: string, abs: number, diags: Diagnostic[]): IndexRange[] {
  const out: IndexRange[] = []
  for (const part of splitTopLevel(inner, ',')) {
    const p = part.trim()
    if (!p) continue
    let m = /^\((\d+)\s*,\s*(\d+)\)$/.exec(p)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      out.push({ from: Math.min(a, b), to: Math.max(a, b) })
      continue
    }
    m = /^(\d+)$/.exec(p)
    if (m) {
      const a = Number(m[1])
      out.push({ from: a, to: a })
      continue
    }
    diags.push({
      from: abs,
      to: abs + inner.length + 2,
      severity: 'error',
      message: `无法解析的音效组编号 "${p}"（应为数字或 (a,b) 区间）`,
      code: 'index-bad',
    })
  }
  return out
}

function parseBraceList(s: string): string[] {
  const m = /\{([\s\S]*)\}/.exec(s)
  const inner = m ? m[1] : s
  return inner
    .split(',')
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** `( 123456 , "段落名" ) , ...` → [{time,name}]（逗号在括号里，不能走 parseBraceList） */
function parseSectionList(s: string): SectionMark[] {
  const out: SectionMark[] = []
  const re = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const time = Number(m[1])
    if (!Number.isFinite(time)) continue
    const name = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    out.push({ time, name })
  }
  return out
}

function parseBool(s: string): boolean {
  return /^(true|1|yes|on)$/i.test(s.trim())
}

function parseNumberExpr(s: string): number {
  const t = s.trim()
  let m = /^bpm\(([-\d.]+)\)$/i.exec(t)
  if (m) {
    const b = Number(m[1])
    return b > 0 ? 60000 / b : NaN
  }
  m = /^beat\(([-\d.]+),([-\d.]+),([-\d.]+)\)$/i.exec(t)
  if (m) {
    const [, x, y, z] = m
    const zz = Number(z)
    return zz === 0 ? Number(x) : Number(x) + Number(y) / zz
  }
  if (/^[-\d.]+$/.test(t)) return Number(t)
  return NaN
}

/** 判断是否为绝对路径（C:\...、C:/...、\\server\share、/...） */
function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/** 以 [Files] 的 path 为基准解析相对路径 */
export function resolvePath(base: string, p: string): string {
  if (!p) return ''
  if (isAbsolute(p)) {
    // Windows 盘符 / UNC 路径统一成反斜杠，Unix 路径保持原样
    return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') ? p.replace(/\//g, '\\') : p
  }
  if (!base) return p
  const b = base.replace(/[\\/]+$/, '')
  return `${b}\\${p.replace(/^[\\/]+/, '').replace(/\//g, '\\')}`
}

export function dirname(p: string): string {
  const m = /^(.*)[\\/][^\\/]*$/.exec(p.replace(/\//g, '\\'))
  return m ? m[1] : ''
}

export function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || ''
}

function defaultSettings(): Settings {
  return {
    Path: '',
    Audio: '',
    ImportOsu: '',
    Mode: 'default',
    Key: ['A', 'B', 'C', 'D'],
    AutoHitsoundIndex: true,
    SliderSlideHitsound: false,
    SliderTickHitsound: false,
    SpinnerHitsound: false,
    DefaultOverride: false,
    StandardFormat: false,
    PreferredIndex: [],
    TimingAdsorb: 0.5,
    TimingAdsorbRaw: 'beat(0,1,2)',
    Bookmarks: [],
    BookmarksRaw: '',
    Sections: [],
    SectionsRaw: '',
    Song: '',
  }
}

const FILES_KEYS = new Set(['path', 'audio', 'importosu'])

const SECTION_RE = /^\[([A-Za-z]+)\]\s*$/

/**
 * 旧格式迁移：[Settings] 里的 Song = "..." 搬到 [Files] 的 path / audio。
 * 已经写了 [Files] 的文件原样返回。
 */
export function migrateSongToFiles(src: string): string {
  if (/^\s*\[Files\]/im.test(src)) return src
  const m = /^[ \t]*Song[ \t]*=[ \t]*(".*?"|'.*?'|\S+)[ \t]*\r?\n?/im.exec(src)
  if (!m) return src
  const value = m[1].trim().replace(/^["']|["']$/g, '')
  if (!value) return src
  const dir = dirname(value)
  const file = value.replace(/\\/g, '/').split('/').pop() || value
  const block = `[Files]\npath = "${dir}"\naudio = "${file}"\n`
  let out = src.replace(m[0], '')
  if (/^\s*\[Settings\]/im.test(out)) out = out.replace(/^([ \t]*)\[Settings\]/im, `$1${block}\n$1[Settings]`)
  else out = block + '\n' + out
  return out.replace(/\n[ \t]*\n[ \t]*\n/, '\n\n')
}

export interface ParseOptions {
  /**
   * 已载入音频的总时长（毫秒）。
   * 给了之后小节网格会一直铺到歌曲结束，时间轴滚到底也有刻度。
   */
  audioDurationMs?: number
  /**
   * .hs 自己所在的文件夹。没有写 `[Files] path` 时，相对路径按它解析 ——
   * 打包给别人的谱子会把 path 删掉，靠这一条仍然能找回同目录的音频/音效。
   */
  baseDir?: string
}

export function parseChart(text: string, opts: ParseOptions = {}): ChartDoc {
  const diags: Diagnostic[] = []
  const lines = splitLines(text)
  const metadata: Record<string, string> = {}
  const metadataOrder: string[] = []
  const settings = defaultSettings()
  const hitsounds: HitsoundDef[] = []
  const phrases: PhraseDef[] = []
  const lists: ListDef[] = []
  const timing: TimingPoint[] = []
  const sections: { name: string; from: number; to: number }[] = []
  /** [Keysound] 首行的乐器列表 */
  const keyInstruments: KeysoundInstrument[] = []
  const keyBodyLines: LineInfo[] = []
  let seenKeyInst = false
  let section = ''
  const bodyLines: LineInfo[] = []

  const lineOf = (pos: number) => {
    let lo = 0
    let hi = lines.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lines[mid].start <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const code = line.code.trim()
    if (!code) continue
    const sec = SECTION_RE.exec(code)
    if (sec) {
      if (section) sections[sections.length - 1].to = lines[li - 1]?.end ?? line.start
      section = sec[1].toLowerCase()
      // 每个 [Keysound] 段落的第一行都是乐器列表
      if (section === 'keysound') seenKeyInst = false
      sections.push({ name: sec[1], from: line.start, to: text.length })
      continue
    }
    if (!section) {
      if (!/^##/.test(line.text.trim()))
        diags.push({
          from: line.start,
          to: line.end,
          severity: 'warning',
          message: '该行位于任何小节（[xxx]）之前，会被忽略',
          code: 'no-section',
        })
      continue
    }

    switch (section) {
      case 'metadata': {
        const m = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(code)
        if (!m) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'error',
            message: '元数据应为 "键 = 值" 的形式',
            code: 'meta-bad',
          })
          break
        }
        if (!metadataOrder.includes(m[1])) metadataOrder.push(m[1])
        metadata[m[1]] = m[2].trim()
        break
      }
      case 'files': {
        const m = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(code)
        if (!m) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'error',
            message: '[Files] 应为 "键 = 值" 的形式（可用 path / audio）',
            code: 'files-bad',
          })
          break
        }
        const key = m[1].toLowerCase()
        const val = m[2].trim().replace(/^["']|["']$/g, '')
        if (!FILES_KEYS.has(key)) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'warning',
            message: `[Files] 暂不支持 "${m[1]}"，目前只有 path / audio / ImportOsu`,
            code: 'files-unknown',
          })
          break
        }
        if (key === 'path') settings.Path = val
        else if (key === 'audio') settings.Audio = val
        else settings.ImportOsu = val
        break
      }
      case 'settings': {
        const m = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(code)
        if (!m) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'error',
            message: '设置项应为 "键 = 值" 的形式',
            code: 'set-bad',
          })
          break
        }
        const key = m[1]
        const val = m[2].trim()
        switch (key.toLowerCase()) {
          case 'mode':
            if (!/^(default|taiko|mania)$/.test(val))
              diags.push({
                from: line.start,
                to: line.end,
                severity: 'error',
                message: 'Mode 只能是 default / taiko / mania',
                code: 'set-mode',
              })
            else settings.Mode = val as Settings['Mode']
            break
          case 'key':
            settings.Key = parseBraceList(val)
            break
          case 'autohitsoundindex':
            settings.AutoHitsoundIndex = parseBool(val)
            break
          case 'sliderslidehitsound':
            settings.SliderSlideHitsound = parseBool(val)
            break
          case 'slidertickhitsound':
            settings.SliderTickHitsound = parseBool(val)
            break
          case 'spinnerhitsound':
            settings.SpinnerHitsound = parseBool(val)
            break
          case 'defaultoverride':
            settings.DefaultOverride = parseBool(val)
            break
          case 'standardformat':
            settings.StandardFormat = parseBool(val)
            break
          case 'preferredindex':
            settings.PreferredIndex = parseBraceList(val)
              .map((x) => Number(x))
              .filter((n) => !Number.isNaN(n))
            break
          case 'bookmarks': {
            settings.BookmarksRaw = val
            const nums: number[] = []
            for (const x of parseBraceList(val)) {
              const n = Number(x)
              if (Number.isNaN(n)) {
                diags.push({
                  from: line.start,
                  to: line.end,
                  severity: 'error',
                  message: `Bookmarks 里的 "${x}" 不是数字（单位与 [Timing] 每行第一项相同，毫秒）`,
                  code: 'set-bookmarks',
                })
              } else nums.push(n)
            }
            settings.Bookmarks = nums
            break
          }
          case 'sections': {
            settings.SectionsRaw = val
            settings.Sections = parseSectionList(val)
            if (/\S/.test(val.replace(/[{}\s]/g, '')) && !settings.Sections.length) {
              diags.push({
                from: line.start,
                to: line.end,
                severity: 'warning',
                message: 'Sections 格式应为 { ( 123456 , "段落名" ) , ... }',
                code: 'set-sections',
              })
            }
            break
          }
          case 'timingadsorb': {
            const n = parseNumberExpr(val)
            settings.TimingAdsorbRaw = val
            if (Number.isNaN(n))
              diags.push({
                from: line.start,
                to: line.end,
                severity: 'error',
                message: 'TimingAdsorb 应为数字或 beat(x,y,z)',
                code: 'set-adsorb',
              })
            else settings.TimingAdsorb = n
            break
          }
          case 'song':
            settings.Song = val.replace(/^["']|["']$/g, '')
            if (!settings.Audio) {
              settings.Audio = settings.Song
              if (!settings.Path) settings.Path = dirname(settings.Song)
            }
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'warning',
              message: '[Settings] 的 Song 已迁移到 [Files] 的 audio，建议改写为 [Files] path = "..." / audio = "..."',
              code: 'set-song-deprecated',
            })
            break
          default:
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'warning',
              message: `未知的设置项 "${key}"`,
              code: 'set-unknown',
            })
        }
        break
      }
      case 'define': {
        if (code.startsWith('list')) {
          const m = /^list\s+(\w+)\s+(\w+)\s*\{?\s*$/.exec(code)
          if (!m) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'error',
              message: '列表定义应为 list <类型> <名称> { ... }，类型可用 int/float/string',
              code: 'list-bad',
            })
            break
          }
          let body = ''
          let endLine = li
          const braceHere = code.includes('{')
          if (!braceHere) {
            endLine = li + 1
          }
          if (braceHere && code.includes('}')) {
            body = code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'))
          } else {
            let buf = braceHere ? code.slice(code.indexOf('{') + 1) : ''
            while (endLine < lines.length) {
              const l = lines[endLine].code
              if (l.includes('}')) {
                buf += ' ' + l.slice(0, l.indexOf('}'))
                break
              }
              buf += ' ' + l
              endLine++
            }
            body = buf
          }
          const items = (body.match(/"[^"]*"|'[^']*'|[^\s,]+/g) || [])
            .map((x) => x.replace(/^["']|["']$/g, ''))
            .filter(Boolean)
          lists.push({
            name: m[2],
            type: m[1],
            items,
            from: line.start,
            to: lines[Math.min(endLine, lines.length - 1)].end,
            line: li + 1,
          })
          li = endLine
          break
        }
        if (code.startsWith('@')) {
          const m = /^@([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(code)
          if (!m) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'error',
              message: '乐句定义应为 @名称 = /.../',
              code: 'phrase-bad',
            })
            break
          }
          const raw = m[2].trim()
          const a = raw.indexOf('/')
          const b = raw.lastIndexOf('/')
          if (a < 0 || b <= a) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'error',
              message: '乐句内容需要用 "/" 包裹',
              code: 'phrase-body',
            })
            break
          }
          const bodyStart = line.start + line.code.indexOf(m[2]) + a + 1
          phrases.push({
            name: m[1],
            body: raw.slice(a + 1, b),
            from: bodyStart,
            to: bodyStart + (b - a - 1),
            line: li + 1,
          })
          break
        }
        if (code.startsWith('hitsound') || code.startsWith('keysound')) {
          const isKs = code.startsWith('keysound')
          const rest = code.slice(isKs ? 8 : 8)
          const eq = rest.indexOf('=')
          if (eq < 0) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'error',
              message: '音效定义应为 hitsound <槽位> [名称] = <路径或 default.xxx>',
              code: 'hs-bad',
            })
            break
          }
          const leftPart = rest.slice(0, eq)
          const rightPart = rest.slice(eq + 1).trim()
          // 末尾可选颜色：`... "x.wav" #ff0000` / `... "x.wav" red`
          let color: string | undefined
          let rhs = rightPart
          const tail = /^([\s\S]*?)\s+(\S+)\s*$/.exec(rightPart)
          if (tail) {
            const c = parseColorToken(tail[2])
            if (c) {
              rhs = tail[1].trim()
              color = c
            } else if (/^#[0-9a-fA-F]{4,8}$/.test(tail[2]) && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(tail[2])) {
              diags.push({
                from: line.start + line.code.lastIndexOf(tail[2]),
                to: line.end,
                severity: 'warning',
                message: `颜色 "${tail[2]}" 无法识别（支持 #RGB / #RRGGBB 或英文名，如 red / green / blue）`,
                code: 'hs-color',
              })
            }
          }
          const leftAbs = line.start + line.code.indexOf(leftPart)
          const { alts, indices, name } = parseSlotPart(leftPart, leftAbs, diags)
          let value = rhs
          let defaultRef: string | undefined
          let path: string | undefined
          let keys: KeysoundSpec | undefined
          let soundFont = false
          if (/^default\./i.test(value)) {
            defaultRef = value.slice(8)
          } else if (/^\(([\s\S]*)\)\s*$/.test(value) && isKs) {
            // keysound 多文件：("路径模板", 最低音, 最高音 [, 调律])
            const args = splitTemplateArgs(value.replace(/^\(|\)\s*$/g, ''))
            if (args.length < 3) {
              diags.push({
                from: line.start + line.code.indexOf(rightPart),
                to: line.end,
                severity: 'error',
                message: 'keysound 多文件定义应为 ("路径模板", 最低音, 最高音 [, 调律])，例如 ("piano/<loop("A","A#")><int((i+9)/12)>.wav", A0, C8)',
                code: 'ks-args',
              })
            }
            const lo = parsePitchToken(args[1] ?? '')
            const hi = parsePitchToken(args[2] ?? '')
            const tune = args[3] !== undefined ? Number(args[3]) : 0
            keys = {
              pattern: unquote(args[0] ?? ''),
              low: lo ?? PIANO_LOW,
              high: hi ?? PIANO_HIGH,
              tune: Number.isFinite(tune) ? tune : 0,
            }
            if (lo === null || hi === null)
              diags.push({
                from: line.start + line.code.indexOf(rightPart),
                to: line.end,
                severity: 'warning',
                message: `最低/最高音 "${args[1] ?? ''}" / "${args[2] ?? ''}" 无法识别，已按 A0~C8 处理`,
                code: 'ks-range',
              })
          } else if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
            path = value.slice(1, -1)
          } else {
            path = value
            diags.push({
              from: line.start + line.code.indexOf(rightPart),
              to: line.end,
              severity: 'warning',
              message: '路径建议用引号包裹',
              code: 'hs-quote',
            })
          }
          if (/\.(sf2|sf3)$/i.test(path || '')) soundFont = true
          // keysound 的名字允许全小写（如 guitar / piano），hitsound 必须是大写开头
          if (name && !(isKs ? /^[A-Za-z][A-Za-z0-9_]*$/.test(name) : /^[A-Z][a-z]*$/.test(name))) {
            diags.push({
              from: leftAbs + leftPart.length - name.length,
              to: leftAbs + leftPart.length,
              severity: 'error',
              message: isKs
                ? `keysound 名 "${name}" 不符合命名规则（应以字母开头，后可跟字母/数字/下划线）`
                : `音效名 "${name}" 不符合命名规则（必须以大写字母开头，后可跟小写字母）`,
              code: 'hs-name',
            })
          }
          const nameFrom = leftAbs + leftPart.trimEnd().length - name.length
          hitsounds.push({
            kind: isKs ? 'keysound' : 'hitsound',
            color,
            name: name || undefined,
            nameFrom: name ? nameFrom : leftAbs,
            nameTo: name ? nameFrom + name.length : leftAbs,
            alts,
            indices,
            value,
            defaultRef,
            path,
            keys,
            soundFont,
            from: line.start,
            to: line.end,
            line: li + 1,
          })
          break
        }
        diags.push({
          from: line.start,
          to: line.end,
          severity: 'warning',
          message: '无法识别的 [Define] 语句（支持 hitsound / @乐句 / list）',
          code: 'define-unknown',
        })
        break
      }
      case 'timing': {
        const parts = code.split(',').map((x) => x.trim())
        if (parts.length < 3) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'error',
            message: 'Timing 至少要有 时间轴,每拍毫秒数,每小节拍数 三个字段',
            code: 'timing-fields',
          })
          break
        }
        const offset = Number(parts[0])
        const bl = parseNumberExpr(parts[1])
        const meter = Number(parts[2])
        const resetMode = parts[3] !== undefined ? Number(parts[3]) : 0
        const rbExpr = parts[4] !== undefined ? parseNumberExpr(parts[4]) : 0
        const shift = parts[5] !== undefined ? Number(parts[5]) : 0
        if (Number.isNaN(offset))
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'error',
            message: '时间轴不是合法数字',
            code: 'timing-offset',
          })
        if (Number.isNaN(bl) || !(bl > 0))
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'error',
            message: '每拍毫秒数无效（可用 bpm(135) 或直接写毫秒）',
            code: 'timing-beat',
          })
        if (!(meter > 0))
          diags.push({
            from: line.start,
            to: line.end,
            severity: 'error',
            message: '每小节拍数必须为正整数',
            code: 'timing-meter',
          })
        timing.push({
          offset: Number.isNaN(offset) ? 0 : offset,
          beatLength: Number.isNaN(bl) ? 500 : bl,
          meter: meter > 0 ? meter : 4,
          resetMode: (resetMode === 1 || resetMode === 2 ? resetMode : 0) as 0 | 1 | 2,
          resetBeats: Number.isNaN(rbExpr) ? 0 : rbExpr,
          resetBeatsSet: parts[4] !== undefined && !Number.isNaN(rbExpr),
          shift: Number.isNaN(shift) ? 0 : shift,
          from: line.start,
          to: line.end,
          line: li + 1,
        })
        break
      }
      case 'hitsound': {
        bodyLines.push({
          text: line.text,
          code: line.code,
          start: line.start,
          end: line.end,
          index: li,
        })
        break
      }
      case 'keysound': {
        // 首行必须是花括号乐器列表 {piano | guitar}，之后才是正文（以 "/" 开头）
        if (!seenKeyInst) {
          if (!code.trim()) break
          if (!code.startsWith('{')) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'error',
              message: `本行不以 "/" 开头。乐器列表应使用花括号填写：{乐器A | 乐器B}`,
              code: 'ks-instbad',
            })
            break
          }
          seenKeyInst = true
          const inner = code.slice(1, code.lastIndexOf('}') < 0 ? undefined : code.lastIndexOf('}'))
          const base = line.start + line.code.indexOf(inner)
          let staff = 0
          for (const raw of inner.split('|')) {
            const nm = raw.trim()
            if (!nm) continue
            keyInstruments.push({
              name: nm,
              staff: staff++,
              from: base + inner.indexOf(nm),
              to: base + inner.indexOf(nm) + nm.length,
              line: li + 1,
            })
          }
          if (!keyInstruments.length)
            diags.push({
              from: line.start,
              to: line.end,
              severity: 'error',
              message: '乐器列表为空，至少要写一个在 [Define] 里定义的 keysound 名',
              code: 'ks-instempty',
            })
          break
        }
        keyBodyLines.push({
          text: line.text,
          code: line.code,
          start: line.start,
          end: line.end,
          index: li,
        })
        break
      }
      case 'hitobjects':
        break
      default:
        break
    }
  }
  if (sections.length) sections[sections.length - 1].to = text.length

  // 路径解析：音频 + 音效文件
  // [Files] path 优先；没写的时候退回 .hs 所在目录（打包后靠这层默认值找同目录文件）
  // path 本身也允许写相对路径 —— 相对 .hs 所在目录再解析一层。
  const baseDir = settings.Path
    ? resolvePath(opts.baseDir || '', settings.Path).replace(/[\\/]+$/, '')
    : (opts.baseDir || '').replace(/[\\/]+$/, '')
  const audioPath = resolvePath(baseDir, settings.Audio)
  // ImportOsu：只读的 .osu，用来在格子里对照原谱物件时间轴；相对 [Files] path 解析
  const importOsuPath = settings.ImportOsu ? resolvePath(baseDir, settings.ImportOsu) : ''
  for (const h of hitsounds) {
    if (h.path) h.resolvedPath = resolvePath(baseDir, h.path)
  }

  const grid = new MeasureGrid(timing, diags)
  const defined = new Set<string>()
  for (const h of hitsounds) if (h.name) defined.add(h.name)
  const phraseMap = new Map<string, PhraseDef>()
  for (const p of phrases) {
    if (phraseMap.has(p.name))
      diags.push({
        from: p.from,
        to: p.to,
        severity: 'warning',
        message: `乐句 @${p.name} 重复定义，后面的会覆盖前面的`,
        code: 'phrase-dup',
      })
    phraseMap.set(p.name, p)
  }
  const undefinedNames = new Set<string>()
  const ctx: BodyCtx = {
    diags,
    phrases: phraseMap,
    defined,
    standardFormat: settings.StandardFormat,
    grid,
    volume: 100,
    index: null,
    undefinedNames,
    leadDash: 0,
    lineOf,
    timing,
    bookmarks: settings.Bookmarks,
  }
  // keysound 乐器：校名 + 展开每个音高的文件路径
  const listMap = new Map<string, string[]>()
  for (const l of lists) listMap.set(l.name, l.items)
  const ksNames = new Set<string>()
  for (const h of hitsounds) if (h.kind === 'keysound' && h.name) ksNames.add(h.name)
  for (const inst of keyInstruments) {
    if (ksNames.has(inst.name)) continue
    diags.push({
      from: inst.from,
      to: inst.to,
      severity: 'error',
      message: `乐器 "${inst.name}" 没有在 [Define] 里用 keysound 定义过`,
      code: 'ks-undefined',
    })
  }
  for (const h of hitsounds) {
    if (h.kind !== 'keysound' || !h.keys) continue
    const res = expandKeysoundPath({ pattern: h.keys.pattern, low: h.keys.low, high: h.keys.high, tune: h.keys.tune, lists: listMap })
    const files = new Map<number, string>()
    for (const [midi, rel] of res.files) files.set(midi, resolvePath(baseDir, rel))
    h.keyFiles = files
    for (const e of res.errors)
      diags.push({ from: h.from, to: h.to, severity: 'error', message: e, code: 'ks-pattern' })
  }

  const body = parseHitsoundBody(bodyLines, ctx)

  // [Keysound] 正文：每条谱表对应乐器列表里的一项，音符是音名而不是音效名
  const keyCtx: BodyCtx = {
    ...ctx,
    mode: 'keysound',
    staff: 0,
    volume: 100,
    index: null,
    leadDash: 0,
    pitchStates: new Map(),
    instruments: keyInstruments,
  }
  const keyBody = keyBodyLines.length ? parseHitsoundBody(keyBodyLines, keyCtx) : null
  let events = body.events
  let usedMeasures = body.usedMeasures
  if (keyBody) {
    usedMeasures = Math.max(usedMeasures, keyBody.usedMeasures)
    events = [...events, ...keyBody.events].sort((a, b) => a.time - b.time || a.from - b.from)
    // 统一回填 unitPos（keysound 与 hitsound 混排后按时间重排）
    let lastMeasure = -1
    let lastStart = 0
    let lastLen = 1
    for (const e of events) {
      if (e.measure !== lastMeasure) {
        lastMeasure = e.measure
        const m = grid.get(e.measure - 1)
        lastStart = m.start
        lastLen = m.end - m.start || 1
      }
      e.unitPos = (e.time - lastStart) / lastLen
    }
  }

  // 小节网格原本是懒生成的，只铺到正文用到的地方 —— 这会导致 [Timing] 里写在正文之后的
  // 变速点根本没被生成，时间轴看起来像恒定 BPM。这里主动把网格铺满：
  // 至少 MIN_GRID_MEASURES 个小节，且保证最后一个 Timing 之后还有 TAIL_GRID_MEASURES 的余量。
  const lastTp = timing.length ? timing[timing.length - 1] : undefined
  let tailTarget = 0
  if (lastTp) {
    const bl = lastTp.beatLength > 0 ? lastTp.beatLength : 500
    const meter = lastTp.meter > 0 ? lastTp.meter : 4
    tailTarget = lastTp.offset + TAIL_GRID_MEASURES * meter * bl
  }
  let gridCount = Math.max(usedMeasures, MIN_GRID_MEASURES)
  if (tailTarget > 0) {
    while (gridCount < MAX_GRID_MEASURES && grid.get(gridCount - 1).end < tailTarget) gridCount++
  }
  // 载入了音频就把网格铺到歌曲结束，滚到时间轴底部也有刻度
  const songEnd = opts.audioDurationMs
  if (typeof songEnd === 'number' && Number.isFinite(songEnd) && songEnd > 0) {
    while (gridCount < MAX_GRID_MEASURES && grid.get(gridCount - 1).end < songEnd) gridCount++
  }
  grid.get(gridCount - 1) // 触发生成，使 snapshot 完整

  diags.sort((a, b) => a.from - b.from)
  return {
    text,
    metadata,
    metadataOrder,
    settings,
    audioPath,
    baseDir,
    importOsuPath,
    hitsounds,
    phrases,
    lists,
    timing,
    events,
    measures: grid.snapshot(),
    usedMeasures,
    diagnostics: diags,
    sections,
    markers: body.markers,
    undefinedNames: [...undefinedNames],
    keyInstruments,
  }
}
