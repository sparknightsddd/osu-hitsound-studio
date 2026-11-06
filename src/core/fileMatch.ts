import type { ChartDoc, HitsoundDef } from './types'
import { keySampleName } from './keysound'

export interface PickedEntry {
  file: File
  /** 规范化后的路径（去掉所选文件夹那一层，分隔符统一为 /，小写） */
  path: string
  name: string
}

export interface MatchResult<T> {
  target: T
  relPath: string
  file: File | null
  /** 命中的方式 */
  how: 'exact' | 'suffix' | 'name' | null
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/** 把谱面里写的路径（可能绝对、可能相对、可能带引号）变成用于匹配的形式 */
export function matchKey(raw: string): { rel: string; base: string } {
  // 解析器保留原始写法，带引号的路径要先把引号剥掉
  const n = norm(raw.replace(/^\s*["']|["']\s*$/g, '').trim())
  const i = n.lastIndexOf('/')
  const base = i >= 0 ? n.slice(i + 1) : n
  // 绝对路径（D:/xx 或 D:\xx）只剩文件名可用
  const isAbs = /^[a-z]:/.test(n) || n.startsWith('//')
  return { rel: isAbs ? base : n, base }
}

/** 把用户选中的一批 File 变成可匹配条目 */
export function entriesFromFiles(files: File[]): PickedEntry[] {
  return files.map((file) => {
    const rp = (file as any).webkitRelativePath || ''
    const raw = rp || file.name
    let p = norm(raw)
    // 去掉最外层（所选文件夹自身那一级）
    const i = p.indexOf('/')
    if (i > 0) p = p.slice(i + 1)
    const j = p.lastIndexOf('/')
    return { file, path: p, name: j >= 0 ? p.slice(j + 1) : p }
  })
}

/**
 * 在一批文件里找 target。
 * 优先级：完整相对路径相等 > 路径后缀匹配 > 纯文件名匹配
 */
function findEntry(entries: PickedEntry[], rel: string, base: string): { file: File; how: 'exact' | 'suffix' | 'name' } | null {
  if (!rel && !base) return null
  let best: { file: File; how: 'suffix'; len: number } | null = null
  for (const e of entries) {
    if (e.path === rel) return { file: e.file, how: 'exact' }
    if (rel && e.path.endsWith('/' + rel)) {
      if (!best || e.path.length < best.len) best = { file: e.file, how: 'suffix', len: e.path.length }
    }
  }
  if (best) return { file: best.file, how: best.how }
  if (base) {
    for (const e of entries) {
      if (e.name === base) return { file: e.file, how: 'name' }
    }
  }
  return null
}

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i

/** 匹配歌曲（[Files] audio） */
export function matchSong(doc: ChartDoc, entries: PickedEntry[]): MatchResult<string> | null {
  const raw = doc.settings.Audio || doc.settings.Song || ''
  if (!raw) return null
  const { rel, base } = matchKey(raw)
  const hit = findEntry(entries, rel, base)
  return { target: raw, relPath: rel, file: hit?.file ?? null, how: hit?.how ?? null }
}

/** 匹配所有自定义音效定义（跳过 default.xxx） */
export function matchHitsounds(
  doc: ChartDoc,
  entries: PickedEntry[],
): MatchResult<HitsoundDef>[] {
  const out: MatchResult<HitsoundDef>[] = []
  for (const h of doc.hitsounds) {
    if (!h.name) continue
    if (h.defaultRef) continue // 官方默认音效走内置库
    const raw = h.value || ''
    if (!raw) continue
    const { rel, base } = matchKey(raw)
    const hit = findEntry(entries, rel, base)
    out.push({ target: h, relPath: rel, file: hit?.file ?? null, how: hit?.how ?? null })
  }
  return out
}

export interface KeysoundFileMatch {
  target: HitsoundDef
  instrument: string
  midi: number
  /** 引擎里登记的名字（ks:乐器#音高） */
  keyName: string
  relPath: string
  file: File | null
  how: 'exact' | 'suffix' | 'name' | null
}

/** keysound 单文件（音色库 .sf2/.sf3，或单一 wav）的匹配结果 */
export interface SoundFontMatch {
  target: HitsoundDef
  instrument: string
  relPath: string
  file: File | null
  how: 'exact' | 'suffix' | 'name' | null
}

/** 匹配所有 keysound：逐个音高的文件表 + 音色库整体文件 */
export function matchKeysounds(
  doc: ChartDoc,
  entries: PickedEntry[],
): { files: KeysoundFileMatch[]; libs: SoundFontMatch[] } {
  const files: KeysoundFileMatch[] = []
  const libs: SoundFontMatch[] = []
  if (!entries.length) return { files, libs }
  for (const h of doc.hitsounds) {
    if (h.kind !== 'keysound' || !h.name) continue
    const instrument = h.name
    // 音色库 / 单一音效文件
    const raw = h.value || ''
    if (h.soundFont || h.path) {
      const { rel, base } = matchKey(raw)
      const hit = findEntry(entries, rel, base)
      libs.push({ target: h, instrument, relPath: rel, file: hit?.file ?? null, how: hit?.how ?? null })
    }
    // 每个音高一个文件
    if (h.keyFiles) {
      for (const [midi, p] of h.keyFiles) {
        const { rel, base } = matchKey(p)
        const hit = findEntry(entries, rel, base)
        files.push({
          target: h,
          instrument,
          midi,
          keyName: keySampleName(instrument, midi),
          relPath: rel,
          file: hit?.file ?? null,
          how: hit?.how ?? null,
        })
      }
    }
  }
  return { files, libs }
}

export function isAudioFile(f: File): boolean {
  return AUDIO_EXT.test(f.name) || /^audio\//.test(f.type)
}
