/**
 * 极简 SFZ 解析：只取每个 region 的 sample / 音域 / 根音 / 调律 / 音量。
 *
 * 不做 filter、envelope、loop、keyswitch、include 等；试听按键音够用。
 * 支持 `<global>` / `<group>` / `<region>` 的继承，和 `default_path`。
 */
import { parsePitchToken } from '../core/keysound'

export interface SfzRegion {
  /** sample 相对路径（已按 default_path 拼好，\ 统一成 /） */
  sample: string
  keyLow: number
  keyHigh: number
  velLow: number
  velHigh: number
  /** 根音（pitch_keycenter） */
  root: number
  /** 音分 */
  tune: number
  /** 线性增益（由 volume dB / gain 换算） */
  gain: number
}

export interface SfzParseResult {
  regions: SfzRegion[]
  errors: string[]
}

/** 去掉 // 注释（引号里的不算） */
function stripLineComment(line: string): string {
  let inQ = false
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i]
    if (c === '"' || c === "'") inQ = !inQ
    if (!inQ && c === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

/** 按空白切分 key=value；引号里的空格保留 */
function splitOpcodes(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"' || c === "'") {
      inQ = !inQ
      cur += c
      continue
    }
    if (!inQ && /\s/.test(c)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

function unquote(v: string): string {
  const s = v.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

function toNum(v: string | undefined): number | null {
  if (v === undefined) return null
  const s = unquote(v)
  if (!s) return null
  const n = parsePitchToken(s)
  if (n !== null) return n
  const f = Number(s)
  return Number.isFinite(f) ? f : null
}

type OpMap = Map<string, string>

function buildRegion(ops: OpMap, defaultPath: string, errors: string[]): SfzRegion | null {
  const rawSample = unquote(ops.get('sample') || '')
  if (!rawSample) return null
  let sample = rawSample.replace(/\\/g, '/')
  if (defaultPath && !/^[a-z]:\//i.test(sample) && !sample.startsWith('/')) {
    sample = `${defaultPath.replace(/\\/g, '/').replace(/\/+$/, '')}/${sample}`
  }
  const key = toNum(ops.get('key'))
  const lo = toNum(ops.get('lokey'))
  const hi = toNum(ops.get('hikey'))
  const keyLow = Math.max(0, Math.min(127, Math.round(lo ?? key ?? 0)))
  const keyHigh = Math.max(0, Math.min(127, Math.round(hi ?? key ?? 127)))
  if (keyLow > keyHigh) {
    errors.push(`${sample}：lokey (${keyLow}) 高于 hikey (${keyHigh})`)
    return null
  }
  const center = toNum(ops.get('pitch_keycenter'))
  const root = Math.round(center ?? key ?? 60)
  const tune = toNum(ops.get('tune')) ?? 0
  const volumeDb = toNum(ops.get('volume'))
  const gainRaw = toNum(ops.get('gain'))
  let gain = 1
  if (gainRaw !== null) gain = gainRaw
  else if (volumeDb !== null) gain = Math.pow(10, volumeDb / 20)
  return {
    sample,
    keyLow,
    keyHigh,
    velLow: Math.max(0, Math.min(127, Math.round(toNum(ops.get('lovel')) ?? 0))),
    velHigh: Math.max(0, Math.min(127, Math.round(toNum(ops.get('hivel')) ?? 127))),
    root: root >= 0 && root <= 127 ? root : 60,
    tune,
    gain: Math.max(0, Math.min(4, gain)),
  }
}

export function parseSfz(text: string): SfzParseResult {
  const errors: string[] = []
  const regions: SfzRegion[] = []
  const global: OpMap = new Map()
  let group: OpMap = new Map()
  let current: OpMap | null = null
  let section: 'none' | 'global' | 'group' | 'region' = 'none'
  let defaultPath = ''

  const flush = () => {
    if (!current) return
    const r = buildRegion(current, defaultPath, errors)
    if (r) regions.push(r)
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripLineComment(rawLine).trim()
    if (!line) continue
    const head = /^<([A-Za-z0-9_]+)>/.exec(line)
    if (head) {
      const tag = head[1].toLowerCase()
      if (tag === 'global') {
        flush()
        section = 'global'
        current = global
      } else if (tag === 'group') {
        flush()
        section = 'group'
        group = new Map(global)
        current = group
      } else if (tag === 'region') {
        flush()
        section = 'region'
        current = new Map([...global, ...group])
      } else {
        flush()
        section = 'none'
        current = null
      }
      const rest = line.slice(head[0].length).trim()
      if (!rest || !current) continue
      // `<region> sample=x.wav` 同一行也支持
    }
    if (!current) continue
    const rest = head ? line.slice(head[0].length).trim() : line
    for (const token of splitOpcodes(rest)) {
      const eq = token.indexOf('=')
      if (eq <= 0) continue
      const k = token.slice(0, eq).trim().toLowerCase()
      const v = token.slice(eq + 1).trim()
      if (k === 'default_path') {
        defaultPath = unquote(v)
        continue
      }
      current.set(k, v)
    }
  }
  flush()
  if (!regions.length) errors.push('sfz 里没有找到带 sample= 的 region')
  void section
  return { regions, errors }
}
