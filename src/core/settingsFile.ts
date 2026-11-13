/**
 * 应用设置的文本持久化：`settings.cfg`。
 *
 * 设置窗口里的内容（目录、导入代号/配色、Timing、显示、导出、谱面默认值、
 * 主题、语言）除了照旧写 localStorage / prefs.json，还会整份写进这个文本文件。
 * 好处是：换机器直接拷一份 cfg；出问题能让人把文件发过来看；也可以手改。
 *
 * 位置：
 *   - 打包的绿色版：exe 旁边（release/osu-hitsound-studio/settings.cfg）；
 *     写不进去（只读目录）时主进程会退到 userData
 *   - 开发模式：Electron userData/settings.cfg
 *   - 浏览器：localStorage（没有文件系统）
 *
 * 语法刻意做得懒散：
 *   `键 = 值`，`[段]` 分段，`#` / `;` / `//` 注释；
 *   字符串可以带引号也可以不带；true/false 也认 1/0、on/off、yes/no。
 *   不认识的键会忽略（不报错），方便以后加字段、旧版本读新文件。
 */
import type { ChartDefaults } from './chartDefaults'
import {
  CHART_BOOL_KEYS,
  loadChartDefaults,
  parseIndexList,
  saveChartDefaults,
} from './chartDefaults'
import {
  COMBO_KEYS,
  loadComboColors,
  loadComboPrefs,
  loadTimingPrefs,
  saveComboColors,
  saveComboPrefs,
  saveTimingPrefs,
  splitTokens,
  normalizeToken,
  type ComboColors,
  type ComboPrefs,
} from './importPrefs'
import { getDisplayPrefs, setDisplayPrefs, type VolumeDisplay } from './displayPrefs'
import {
  isValidOrder,
  loadExportPrefs,
  orderToText,
  saveExportPrefs,
  textToOrder,
} from './exportPrefs'
import { getSongsFolder, setSongsFolder } from './osuMapsets'
import { getSoundFolder, setSoundFolder } from './soundLibrary'
import { desktopApi } from './desktop'
import { useStore, type ThemePref } from '../store'

/**
 * i18n 用动态导入：它会把 .lang 文件一起静态 import 进来，
 * node 下的单测（tsx）不认识 .lang 扩展名。设置文件在启动时只读一次，
 * 动态导入的代价可以忽略。
 */
async function i18n() {
  return import('../i18n')
}

export interface SettingsValues {
  songsFolder: string
  soundFolder: string
  theme: ThemePref
  lang: string
  importCodes: ComboPrefs
  importColors: ComboColors
  inheritMs: number
  colorAlphaByVol: boolean
  volumeDisplay: VolumeDisplay
  showOsuObjects: boolean
  slotOrder: string[]
  cleanOld: boolean
  chart: ChartDefaults
}

const LS_TEXT = 'hsstudio.settingsCfgText'

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/** 值里只有双引号需要转义；Windows 路径一律换成 `/`，免得手改时要写双反斜杠 */
function quote(s: string): string {
  return `"${String(s).replace(/"/g, '\\"')}"`
}

function pad(key: string): string {
  return key.length >= 20 ? key : key + ' '.repeat(20 - key.length)
}

export function serializeSettings(v: SettingsValues): string {
  const L: string[] = []
  const kv = (key: string, value: string, comment?: string) => {
    L.push(`${pad(key)}= ${value}${comment ? `   # ${comment}` : ''}`)
  }

  L.push('# ============================================================')
  L.push('#  osu Hitsound Studio · settings.cfg')
  L.push('#')
  L.push('#  Maintained by the app: saving in Settings rewrites the whole file.')
  L.push('#  Hand edits are fine — restart to apply (invalid entries are skipped).')
  L.push('#  Syntax: `key = value`; quote strings; # or ; starts a comment.')
  L.push('# ============================================================')
  L.push('')

  L.push('# Folders for the osu! beatmap library / sound library (empty = auto-detect)')
  L.push('[General]')
  kv('SongsFolder', quote(v.songsFolder.replace(/\\/g, '/')))
  kv('SoundFolder', quote(v.soundFolder.replace(/\\/g, '/')))
  L.push('')

  L.push('# Theme: light / dark / auto (follow the system)')
  L.push('[Appearance]')
  kv('Theme', quote(v.theme))
  L.push('')

  L.push('# UI language: auto or a language pack id (zh-CN / en-US / zh-TW / ja-JP / ko-KR / ru-RU…)')
  L.push('[Language]')
  kv('Lang', quote(v.lang))
  L.push('')

  L.push('# Default codes for the 12 combos when importing .osu hitsounds (comma-separated by priority; `=` = whiteboard)')
  L.push('[Import]')
  for (const k of COMBO_KEYS) kv(k, quote(v.importCodes[k] || ''))
  L.push('')

  L.push('# Default color for each combo above (written as the fifth field of [Define])')
  L.push('[ImportColors]')
  for (const k of COMBO_KEYS) kv(k, quote(v.importColors[k] || ''))
  L.push('')

  L.push('# If the gap between red lines exceeds InheritMs (ms), the previous meter is not inherited')
  L.push('[Timing]')
  kv('InheritMs', String(Math.round(v.inheritMs)))
  kv('ColorAlphaByVol', v.colorAlphaByVol ? 'true' : 'false', 'sound color alpha follows volume')
  kv('VolumeDisplay', quote(v.volumeDisplay), 'number / bar / none')
  kv('ShowOsuObjects', v.showOsuObjects ? 'true' : 'false', 'show the ImportOsu object lane in the grid')
  L.push('')

  L.push('# Codes without a fixed sample set pick a slot in this order when exporting (9 entries, first wins)')
  L.push('[Export]')
  kv('SlotOrder', quote(orderToText(v.slotOrder)))
  kv('CleanOld', v.cleanOld ? 'true' : 'false', 'remove old [EZHS*] difficulties before exporting')
  L.push('')

  L.push('# Defaults written into [Settings] for new / imported charts')
  L.push('[Chart]')
  for (const k of CHART_BOOL_KEYS) kv(k, v.chart[k] ? 'true' : 'false')
  kv('PreferredIndex', quote(`{${v.chart.PreferredIndex.join(', ')}}`))
  L.push('')

  return L.join('\n')
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface ParsedSettingsFile {
  /** 段名 / 键名都小写；值保持原样（已去引号） */
  sections: Map<string, Map<string, string>>
  errors: string[]
}

/**
 * 去掉行尾注释：引号里的 `#` 不算，前面没有空白的 `#` 也不算（`#4cc2ff`）。
 * 另外 `#RRGGBB` 这种没加引号的颜色也不当注释 —— 手改文件时很容易忘了引号。
 */
function stripComment(line: string): string {
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"' && line[i - 1] !== '\\') inQuote = !inQuote
    else if (!inQuote && (c === ';' || c === '#') && (i === 0 || /\s/.test(line[i - 1]))) {
      if (/^#[0-9a-f]{3}([0-9a-f]{3})?\b/i.test(line.slice(i))) continue
      return line.slice(0, i)
    }
  }
  return line
}

function unquote(raw: string): string {
  let s = raw.trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1)
  return s.replace(/\\"/g, '"')
}

export function parseSettingsFile(text: string): ParsedSettingsFile {
  const sections = new Map<string, Map<string, string>>()
  const errors: string[] = []
  let cur: Map<string, string> | null = null
  const lines = String(text ?? '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = stripComment(raw).trim()
    if (!line) continue
    if (line.startsWith('//')) continue
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end < 0) {
        errors.push(`第 ${i + 1} 行：段名缺少右方括号`)
        cur = null
        continue
      }
      const name = line.slice(1, end).trim().toLowerCase()
      if (!name) {
        errors.push(`第 ${i + 1} 行：段名为空`)
        cur = null
        continue
      }
      cur = sections.get(name) || new Map<string, string>()
      sections.set(name, cur)
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) {
      errors.push(`第 ${i + 1} 行不是「键 = 值」：${line.slice(0, 40)}`)
      continue
    }
    if (!cur) {
      // 段外的键：当成 [general]，比直接丢掉更宽容
      cur = sections.get('general') || new Map<string, string>()
      sections.set('general', cur)
    }
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = unquote(line.slice(eq + 1))
    if (!key) {
      errors.push(`第 ${i + 1} 行：键名为空`)
      continue
    }
    cur.set(key, value)
  }
  return { sections, errors }
}

const TRUE = new Set(['true', '1', 'on', 'yes', 'y'])
const FALSE = new Set(['false', '0', 'off', 'no', 'n', ''])

function readBool(
  raw: string | undefined,
  where: string,
  errors: string[],
): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (TRUE.has(v)) return true
  if (FALSE.has(v)) return false
  errors.push(`${where} 应该是 true / false（现在是 "${raw}"）`)
  return undefined
}

// ---------------------------------------------------------------------------
// 读当前设置 / 写回
// ---------------------------------------------------------------------------

export async function collectSettings(): Promise<SettingsValues> {
  const dp = getDisplayPrefs()
  // node 单测里没有 .lang 的加载器，读不到就当 auto，别让写文件整个失败
  let lang = 'auto'
  try {
    lang = (await i18n()).langSelection()
  } catch {
    /* ignore */
  }
  return {
    songsFolder: await getSongsFolder(),
    soundFolder: await getSoundFolder(),
    theme: useStore.getState().theme,
    lang,
    importCodes: loadComboPrefs(),
    importColors: loadComboColors(),
    inheritMs: loadTimingPrefs().inheritMs,
    colorAlphaByVol: dp.colorAlphaByVol,
    volumeDisplay: dp.volumeDisplay,
    showOsuObjects: dp.showOsuObjects,
    slotOrder: loadExportPrefs().slotOrder,
    cleanOld: loadExportPrefs().cleanOld,
    chart: loadChartDefaults(),
  }
}

/** 文件里的值写回各个偏好模块（写进 localStorage / prefs.json，界面立刻按新值走） */
export async function applySettingsText(
  text: string,
): Promise<{ errors: string[]; applied: string[] }> {
  const parsed = parseSettingsFile(text)
  const errors = parsed.errors.slice()
  const applied: string[] = []
  const get = (section: string, key: string) => parsed.sections.get(section)?.get(key)
  const has = (section: string) => parsed.sections.has(section)

  // --- 目录 ---
  const songs = get('general', 'songsfolder')
  if (songs !== undefined) {
    await setSongsFolder(songs)
    applied.push('SongsFolder')
  }
  const sounds = get('general', 'soundfolder')
  if (sounds !== undefined) {
    await setSoundFolder(sounds)
    applied.push('SoundFolder')
  }

  // --- 外观 ---
  const theme = get('appearance', 'theme')
  if (theme !== undefined) {
    const v = theme.trim().toLowerCase()
    if (v === 'light' || v === 'dark' || v === 'auto') {
      useStore.getState().setTheme(v)
      applied.push('Theme')
    } else {
      errors.push(`[Appearance] Theme 只能是 light / dark / auto（现在是 "${theme}"）`)
    }
  }

  // --- 语言 ---
  const lang = get('language', 'lang')
  if (lang !== undefined && lang.trim()) {
    try {
      ;(await i18n()).setLang(lang.trim())
      applied.push('Lang')
    } catch (e) {
      errors.push(`[Language] Lang 没法应用：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // --- 导入代号 / 配色 ---
  if (has('import')) {
    const next: ComboPrefs = { ...loadComboPrefs() }
    for (const k of COMBO_KEYS) {
      const raw = get('import', k)
      if (raw === undefined) continue
      const toks = splitTokens(raw)
        .map((x) => (x === '=' ? '=' : normalizeToken(x)))
        .filter(Boolean)
      if (toks.length) next[k] = toks.join(', ')
      else delete next[k]
      applied.push(`Import.${k}`)
    }
    saveComboPrefs(next)
  }
  if (has('importcolors')) {
    const cur = loadComboColors()
    const next: ComboColors = { ...cur }
    for (const k of COMBO_KEYS) {
      const raw = get('importcolors', k)
      if (raw === undefined) continue
      const v = raw.trim().toLowerCase()
      if (!v) delete next[k]
      else if (/^#[0-9a-f]{6}$/.test(v)) next[k] = v
      else errors.push(`[ImportColors] ${k} 应该是 #RRGGBB（现在是 "${raw}"）`)
      applied.push(`ImportColors.${k}`)
    }
    saveComboColors(next)
  }

  // --- Timing / 显示 ---
  const dp = getDisplayPrefs()
  const nextDp = { ...dp }
  let dpChanged = false
  const inherit = get('timing', 'inheritms')
  if (inherit !== undefined) {
    const n = Math.round(Number(inherit))
    if (Number.isFinite(n) && n > 0) {
      saveTimingPrefs({ inheritMs: n })
      applied.push('InheritMs')
    } else {
      errors.push(`[Timing] InheritMs 必须是正数（现在是 "${inherit}"）`)
    }
  }
  const alpha = readBool(get('timing', 'coloralphabyvol'), '[Timing] ColorAlphaByVol', errors)
  if (alpha !== undefined) {
    nextDp.colorAlphaByVol = alpha
    dpChanged = true
    applied.push('ColorAlphaByVol')
  }
  const volMode = get('timing', 'volumedisplay')
  if (volMode !== undefined) {
    const v = volMode.trim().toLowerCase()
    if (v === 'number' || v === 'bar' || v === 'none') {
      nextDp.volumeDisplay = v as VolumeDisplay
      dpChanged = true
      applied.push('VolumeDisplay')
    } else {
      errors.push(`[Timing] VolumeDisplay 只能是 number / bar / none（现在是 "${volMode}"）`)
    }
  }
  const showObj = readBool(get('timing', 'showosuobjects'), '[Timing] ShowOsuObjects', errors)
  if (showObj !== undefined) {
    nextDp.showOsuObjects = showObj
    dpChanged = true
    applied.push('ShowOsuObjects')
  }
  if (dpChanged) setDisplayPrefs(nextDp)

  // --- 导出 ---
  const ep = loadExportPrefs()
  let epChanged = false
  const order = get('export', 'slotorder')
  if (order !== undefined) {
    const list = textToOrder(order)
    if (isValidOrder(list)) {
      ep.slotOrder = list
      epChanged = true
      applied.push('SlotOrder')
    } else {
      errors.push(`[Export] SlotOrder 要正好 9 个、互不重复（现在是 "${order}"）`)
    }
  }
  const clean = readBool(get('export', 'cleanold'), '[Export] CleanOld', errors)
  if (clean !== undefined) {
    ep.cleanOld = clean
    epChanged = true
    applied.push('CleanOld')
  }
  if (epChanged) saveExportPrefs(ep)

  // --- 谱面默认值 ---
  if (has('chart')) {
    const cd: ChartDefaults = loadChartDefaults()
    let changed = false
    for (const k of CHART_BOOL_KEYS) {
      const b = readBool(get('chart', k.toLowerCase()), `[Chart] ${k}`, errors)
      if (b !== undefined) {
        cd[k] = b
        changed = true
        applied.push(k)
      }
    }
    const idx = get('chart', 'preferredindex')
    if (idx !== undefined) {
      const list = parseIndexList(idx)
      if (list) {
        cd.PreferredIndex = list
        changed = true
        applied.push('PreferredIndex')
      } else {
        errors.push(`[Chart] PreferredIndex 只能填数字（现在是 "${idx}"）`)
      }
    }
    if (changed) saveChartDefaults(cd)
  }

  return { errors, applied }
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

export interface SettingsFileLoad {
  path: string
  /** 文件不存在（第一次运行） */
  missing: boolean
  /** 是否真的读到了磁盘文件（浏览器下永远是 false） */
  onDisk: boolean
  errors: string[]
  applied: string[]
  text: string
}

function browserPath(): string {
  return `localStorage / ${LS_TEXT}`
}

export async function readSettingsText(): Promise<{ text: string; path: string; onDisk: boolean }> {
  const api = desktopApi()
  if (api?.loadSettings) {
    try {
      const r = await api.loadSettings()
      return { text: r.text || '', path: r.path || '', onDisk: !!r.exists }
    } catch {
      return { text: '', path: '', onDisk: false }
    }
  }
  try {
    return { text: localStorage.getItem(LS_TEXT) || '', path: browserPath(), onDisk: false }
  } catch {
    return { text: '', path: browserPath(), onDisk: false }
  }
}

/** settings.cfg 的实际路径（浏览器下是一句说明） */
export async function settingsFilePath(): Promise<string> {
  const api = desktopApi()
  if (api?.settingsPath) {
    try {
      return await api.settingsPath()
    } catch {
      return ''
    }
  }
  return browserPath()
}

/** 把当前设置整份写回 settings.cfg；返回写到了哪里 */
export async function saveSettingsFile(): Promise<{ ok: boolean; path: string; error?: string }> {
  const values = await collectSettings()
  const text = serializeSettings(values)
  const api = desktopApi()
  if (api?.saveSettings) {
    try {
      const r = await api.saveSettings(text)
      return { ok: !!r.ok, path: r.path || '', error: r.error }
    } catch (e) {
      return { ok: false, path: '', error: e instanceof Error ? e.message : String(e) }
    }
  }
  try {
    localStorage.setItem(LS_TEXT, text)
    return { ok: true, path: browserPath() }
  } catch (e) {
    return { ok: false, path: browserPath(), error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 启动时调用：有 settings.cfg 就按它覆盖本地偏好；没有就按当前状态生成一份。
 * 这样第一次启动之后，用户就能在设置里看到「配置文件」在哪。
 */
export async function initSettingsFile(): Promise<SettingsFileLoad> {
  const { text, path, onDisk } = await readSettingsText()
  // 空文件、或者只有打包时放的说明性注释（没有任何 [段]）→ 当成首次运行，写一份完整的
  if (!text.trim() || parseSettingsFile(text).sections.size === 0) {
    const saved = await saveSettingsFile()
    return {
      path: saved.path || path,
      missing: true,
      onDisk: false,
      errors: saved.error ? [saved.error] : [],
      applied: [],
      text: '',
    }
  }
  const r = await applySettingsText(text)
  return { path, missing: false, onDisk, errors: r.errors, applied: r.applied, text }
}

/** 重新读一遍文件（设置窗口里点「重新读取」用） */
export async function reloadSettingsFile(): Promise<SettingsFileLoad> {
  const { text, path, onDisk } = await readSettingsText()
  if (!text.trim()) return { path, missing: true, onDisk, errors: [], applied: [], text: '' }
  // 手改时把内容删光只留注释：按「没有可应用的项」处理，不覆盖文件
  const r = await applySettingsText(text)
  useStore.getState().bumpUi()
  return { path, missing: false, onDisk, errors: r.errors, applied: r.applied, text }
}

// ---------------------------------------------------------------------------
// 自动同步：主题 / 语言这两个不经过设置窗口的「保存」按钮
// ---------------------------------------------------------------------------

let watchInstalled = false
let timer: ReturnType<typeof setTimeout> | null = null

function scheduleSave() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void saveSettingsFile()
  }, 400)
}

export function watchSettingsFile() {
  if (watchInstalled) return
  watchInstalled = true
  useStore.subscribe((s, prev) => {
    if (s.theme !== prev.theme) scheduleSave()
  })
  void i18n().then((m) => {
    // 启动时 initI18n() 补完语言包也会 emit 一次；只有「选择真的变了」才回写文件，
    // 否则每次启动都会把用户手改过的 settings.cfg 重新格式化一遍。
    let last = m.langSelection()
    m.subscribeLang(() => {
      const now = m.langSelection()
      if (now === last) return
      last = now
      scheduleSave()
    })
  })
}
