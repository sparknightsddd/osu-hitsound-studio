/**
 * [Settings] 里那几项 true/false 与 PreferredIndex 的「应用级默认值」。
 *
 * 这些值会写进**新生成**的 .hs（新建谱面、从 .osu 导入音效/谱面），
 * 已经存在的谱面不受影响 —— 想改某一份谱，仍然直接在文本里改 [Settings]。
 *
 * 存 localStorage `hsstudio.chartDefaults`；没有 localStorage（node 测试）时用内置默认。
 */

export const CHART_BOOL_KEYS = [
  'AutoHitsoundIndex',
  'SliderSlideHitsound',
  'SliderTickHitsound',
  'SpinnerHitsound',
  'DefaultOverride',
  'StandardFormat',
] as const

export type ChartBoolKey = (typeof CHART_BOOL_KEYS)[number]

export interface ChartDefaults {
  AutoHitsoundIndex: boolean
  SliderSlideHitsound: boolean
  SliderTickHitsound: boolean
  SpinnerHitsound: boolean
  DefaultOverride: boolean
  StandardFormat: boolean
  /** 音效组编号的优先顺序，导出 .osu 时按它分配 */
  PreferredIndex: number[]
}

/** 和之前模板里写的一致，只是改成可配置 */
export const DEFAULT_CHART_DEFAULTS: ChartDefaults = {
  AutoHitsoundIndex: true,
  SliderSlideHitsound: false,
  SliderTickHitsound: false,
  SpinnerHitsound: false,
  DefaultOverride: false,
  StandardFormat: false,
  PreferredIndex: [11, 45, 14],
}

const LS_KEY = 'hsstudio.chartDefaults'

/** 把 `11, 45, 14` / `{11,45,14}` / `11 45 14` 解析成数字；非法返回 null */
export function parseIndexList(raw: string): number[] | null {
  const body = raw.replace(/[{}]/g, ' ').trim()
  if (!body) return []
  const out: number[] = []
  for (const part of body.split(/[,，\s]+/).filter(Boolean)) {
    if (!/^-?\d+$/.test(part)) return null
    const n = Number(part)
    if (!Number.isFinite(n)) return null
    out.push(Math.trunc(n))
  }
  return out
}

export function formatIndexList(list: number[]): string {
  return `{${list.join(', ')}}`
}

export function loadChartDefaults(): ChartDefaults {
  const out: ChartDefaults = { ...DEFAULT_CHART_DEFAULTS, PreferredIndex: [...DEFAULT_CHART_DEFAULTS.PreferredIndex] }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    if (!raw || typeof raw !== 'object') return out
    for (const k of CHART_BOOL_KEYS) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'boolean') out[k] = v
    }
    if (Array.isArray((raw as Record<string, unknown>).PreferredIndex)) {
      const list = ((raw as Record<string, unknown>).PreferredIndex as unknown[])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n))
        .map((n) => Math.trunc(n))
      out.PreferredIndex = list
    }
  } catch {
    /* 坏了就用默认 */
  }
  return out
}

export function saveChartDefaults(p: ChartDefaults) {
  try {
    const clean: Record<string, unknown> = {}
    for (const k of CHART_BOOL_KEYS) clean[k] = !!p[k]
    clean.PreferredIndex = (p.PreferredIndex || []).map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n))
    localStorage.setItem(LS_KEY, JSON.stringify(clean))
  } catch {
    /* 配额满了不影响保存谱面 */
  }
}

/** 这几项的 [Settings] 行（顺序固定，写在新文件里） */
export function chartSettingsLines(d: ChartDefaults = loadChartDefaults()): string[] {
  return [
    ...CHART_BOOL_KEYS.map((k) => `${k} = ${d[k] ? 'true' : 'false'}`),
    `PreferredIndex = ${formatIndexList(d.PreferredIndex)}`,
  ]
}

/**
 * 把默认值盖到一份已有的 [Settings] 行上：有的就地替换（保持原位置），
 * 没有的补在末尾，其它键（Mode / Key / TimingAdsorb / Bookmarks…）原样保留。
 */
export function applyChartSettings(lines: string[], d: ChartDefaults = loadChartDefaults()): string[] {
  const out = lines.slice()
  for (const line of chartSettingsLines(d)) {
    const key = line.slice(0, line.indexOf('=')).trim()
    const re = new RegExp(`^\\s*${key}\\s*=`, 'i')
    const idx = out.findIndex((l) => re.test(l))
    if (idx >= 0) out[idx] = line
    else out.push(line)
  }
  return out
}

/**
 * 把默认值盖到整份 .hs 文本的 [Settings] 块上（其它段原样保留）。
 * 没有 [Settings] 段就原样返回。
 */
export function applyChartSettingsToText(text: string, d: ChartDefaults = loadChartDefaults()): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => /^\[Settings\]\s*$/i.test(l.trim()))
  if (start < 0) return text
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[[A-Za-z]+\]\s*$/.test(lines[i].trim())) {
      end = i
      break
    }
  }
  const body = lines.slice(start + 1, end).filter((l) => l.trim() !== '')
  const patched = applyChartSettings(body, d)
  const tail = lines.slice(end)
  const out = [...lines.slice(0, start + 1), ...patched, '']
  // 原来后面紧跟别的段落时，补回一个空行（文件末尾则不留）
  if (tail.length) out.push(...tail)
  else out.pop()
  return out.join('\n')
}
