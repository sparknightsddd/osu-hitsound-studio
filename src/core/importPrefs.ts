/**
 * 导入 .osu 音效时的「默认代号」偏好。
 *
 * 12 个组合 = soft/normal/drum × hitnormal/hitwhistle/hitfinish/hitclap。
 * 每个组合填一串按优先级排列的代号（逗号分隔），例如 `Ka, Kb, Kc`：
 * 同组合因为 sampleIndex / 音色文件不同可能有多个代码，就按顺序依次取用。
 * 某一项填 `=` 表示这一条默认当白板（没有代号）。
 *
 * 存在 localStorage（应用级偏好，跟具体谱面无关）。
 */
import type { SoundCode } from './osuSounds'
import { soundCodeKey } from './osuSounds'

export const COMBO_SETS = ['soft', 'normal', 'drum'] as const
export const COMBO_HITS = ['hitnormal', 'hitwhistle', 'hitfinish', 'hitclap'] as const
export type ComboKey = `${(typeof COMBO_SETS)[number]}-${(typeof COMBO_HITS)[number]}`

export const COMBO_KEYS: ComboKey[] = COMBO_SETS.flatMap((s) =>
  COMBO_HITS.map((h) => `${s}-${h}` as ComboKey),
)

const LS_KEY = 'hsstudio.importCodes'
const LS_COLORS = 'hsstudio.importColors'
const LS_TIMING = 'hsstudio.timing'

/** 红线区间超过这个时长就不继承上一小节（默认 4 秒） */
export const DEFAULT_INHERIT_MS = 4000

export interface TimingPrefs {
  inheritMs: number
}

export function loadTimingPrefs(): TimingPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TIMING) || '{}')
    const n = Number(raw?.inheritMs)
    if (Number.isFinite(n) && n > 0) return { inheritMs: Math.round(n) }
  } catch {
    /* 没有 localStorage（node 测试）或数据坏了 → 用默认值 */
  }
  return { inheritMs: DEFAULT_INHERIT_MS }
}

export function saveTimingPrefs(p: TimingPrefs) {
  try {
    const n = Math.round(Number(p.inheritMs))
    localStorage.setItem(LS_TIMING, JSON.stringify({ inheritMs: Number.isFinite(n) && n > 0 ? n : DEFAULT_INHERIT_MS }))
  } catch {
    /* ignore */
  }
}

export type ComboPrefs = Partial<Record<ComboKey, string>>

export function loadComboPrefs(): ComboPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    if (!raw || typeof raw !== 'object') return {}
    const out: ComboPrefs = {}
    for (const k of COMBO_KEYS) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim()) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function saveComboPrefs(p: ComboPrefs) {
  try {
    const clean: ComboPrefs = {}
    for (const k of COMBO_KEYS) {
      const v = (p[k] || '').trim()
      if (v) clean[k] = v
    }
    localStorage.setItem(LS_KEY, JSON.stringify(clean))
  } catch {
    /* 配额满了也不影响本次导入 */
  }
}

/** 把 "Ka, Kb , =" 拆成 ["Ka","Kb","="] */
export function splitTokens(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** 规整一个 token：`=` 原样保留，其余按代号规则（首字母大写、其余小写、只留字母） */
export function normalizeToken(t: string): string {
  if (t === '=') return '='
  const letters = t.replace(/[^A-Za-z]/g, '')
  if (!letters) return ''
  return letters[0].toUpperCase() + letters.slice(1).toLowerCase()
}

export function normalizePrefLine(raw: string): string {
  const toks = splitTokens(raw)
    .map(normalizeToken)
    .filter(Boolean)
  return toks.join(', ')
}

/** 一行里的非法 token（用于设置界面的校验） */
export function invalidTokens(raw: string): string[] {
  return splitTokens(raw).filter((t) => t !== '=' && !/^[A-Z][a-z]*$/.test(normalizeToken(t)))
}

// ---------------------------------------------------------------------------
// 每个槽位默认代号的配色
// ---------------------------------------------------------------------------

/**
 * 12 个组合的默认颜色（导入时写进 [Define] 第五段）。
 * 按行分配色相：soft 偏蓝青、normal 偏绿黄、drum 偏红橙，同一行内相邻也能分清。
 */
export const DEFAULT_COMBO_COLORS: Record<ComboKey, string> = {
  'soft-hitnormal': '#4cc2ff',
  'soft-hitwhistle': '#22e0b8',
  'soft-hitfinish': '#3f6bff',
  'soft-hitclap': '#8f7bff',
  'normal-hitnormal': '#6fd36f',
  'normal-hitwhistle': '#b6e02e',
  'normal-hitfinish': '#e8c33a',
  'normal-hitclap': '#ff9a3c',
  'drum-hitnormal': '#ff5d5d',
  'drum-hitwhistle': '#ff6fb5',
  'drum-hitfinish': '#e05ce0',
  'drum-hitclap': '#ff9d6b',
}

export type ComboColors = Partial<Record<ComboKey, string>>

export function loadComboColors(): ComboColors {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_COLORS) || '{}')
    if (!raw || typeof raw !== 'object') return {}
    const out: ComboColors = {}
    for (const k of COMBO_KEYS) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) out[k] = v.trim().toLowerCase()
    }
    return out
  } catch {
    return {}
  }
}

export function saveComboColors(p: ComboColors) {
  try {
    const clean: ComboColors = {}
    for (const k of COMBO_KEYS) {
      const v = (p[k] || '').trim()
      if (/^#[0-9a-f]{6}$/i.test(v)) clean[k] = v.toLowerCase()
    }
    localStorage.setItem(LS_COLORS, JSON.stringify(clean))
  } catch {
    /* ignore */
  }
}

/** 某个槽位当前用的颜色（没自定义就是默认表里的） */
export function comboColor(key: ComboKey, prefs: ComboColors = {}): string {
  return prefs[key] || DEFAULT_COMBO_COLORS[key]
}

/** 往白色/黑色方向挪一点，用来区分同一槽位里第 2、3… 个代号 */
function shade(hex: string, step: number): string {
  if (!step) return hex
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const to = step % 2 === 1 ? 255 : 0 // 奇数往上提亮，偶数往下压暗
  const amt = Math.min(0.42, 0.18 * Math.ceil(step / 2))
  const mix = (v: number) => Math.round(v + (to - v) * amt)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/**
 * 给每个音效 code 算颜色：同一个槽位用同一个色，槽位里第 2、3… 个代号做深浅变化。
 * 返回 soundCodeKey -> `#rrggbb`，直接喂给 renderOsuSoundsHs 的 codeColors。
 */
export function planDefaultColors(
  codes: SoundCode[],
  prefs: ComboColors = {},
): Record<string, string> {
  const nth = new Map<ComboKey, number>()
  const out: Record<string, string> = {}
  for (const c of codes) {
    const combo = comboOf(c)
    const i = nth.get(combo) || 0
    nth.set(combo, i + 1)
    out[soundCodeKey(c)] = shade(comboColor(combo, prefs), i)
  }
  return out
}

export function comboOf(c: SoundCode): ComboKey {
  return `${c.sampleSet}-${c.hitType}` as ComboKey
}

/**
 * 按偏好给这组音效生成默认代号 / 默认白板。
 *
 * 规则：
 *  - 同一个组合内按 `codes` 的顺序依次取偏好列表的第 1、2、3… 项；
 *  - 取到 `=` 的那一条成为白板候选（全局只认第一个），其余 `=` 退回自动名；
 *  - 偏好项被别人占用了（不同组合填了同名）就跳过，最后统一用 Aa、Ab… 补空位。
 */
export function planDefaultNames(
  codes: SoundCode[],
  prefs: ComboPrefs,
): { names: Record<string, string>; whiteboard: string } {
  const used = new Set<string>()
  const names: Record<string, string> = {}
  let whiteboard = ''
  const nth = new Map<ComboKey, number>()

  // 第一轮：按组合顺序消费偏好
  for (const c of codes) {
    const key = soundCodeKey(c)
    const combo = comboOf(c)
    const i = nth.get(combo) || 0
    nth.set(combo, i + 1)
    const toks = splitTokens(prefs[combo] || '')
    const tok = toks[i]
    if (!tok) continue
    if (tok === '=') {
      if (!whiteboard) whiteboard = key
      continue
    }
    const name = normalizeToken(tok)
    if (!name || used.has(name)) continue
    names[key] = name
    used.add(name)
  }

  // 第二轮：补自动名
  let a = 0
  let b = 0
  for (const c of codes) {
    const key = soundCodeKey(c)
    if (names[key] !== undefined) continue
    if (key === whiteboard) continue
    for (;;) {
      const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[a] + 'abcdefghijklmnopqrstuvwxyz'[b]
      b++
      if (b > 25) {
        b = 0
        a = (a + 1) % 26
      }
      if (!used.has(n)) {
        used.add(n)
        names[key] = n
        break
      }
    }
  }

  return { names, whiteboard }
}
