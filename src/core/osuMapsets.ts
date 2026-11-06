/**
 * osu! 谱面库（左侧第 5 个图标的数据层）。
 *
 * 只做两件事：
 *   1. 记住用户在设置里指定的 Songs 目录（没有就自动探测）；
 *   2. 把主进程的三个 IPC 包成有兜底的 Promise，浏览器模式下安静地返回空。
 *
 * 排序规则不在这一层 —— 那是主进程 sortedMapsetFolders() 的事，
 * 与 Mapset Verifier 一致：按「有效修改时间」倒序（最近改过的排最前）。
 */
import { desktopApi } from './desktop'
import type { CurrentMapsetResult, MapsetPage } from './desktop'

/** prefs.json 里存 Songs 目录的键 */
export const SONGS_FOLDER_PREF = 'songsFolder'

const EMPTY_PAGE: MapsetPage = {
  ok: false,
  songsFolder: '',
  total: 0,
  offset: 0,
  hasMore: false,
  mapsets: [],
}

/** 当前生效的 Songs 目录：设置里指定过的优先，否则自动探测 */
export async function getSongsFolder(): Promise<string> {
  const api = desktopApi()
  if (!api) return ''
  try {
    const prefs = (await api.getPrefs()) || {}
    const saved = String(prefs[SONGS_FOLDER_PREF] || '')
    if (saved) return saved
  } catch {
    /* prefs 读不到就走探测 */
  }
  try {
    const r = await api.osuDetectSongsFolder()
    return r?.folder || ''
  } catch {
    return ''
  }
}

export async function setSongsFolder(p: string): Promise<void> {
  const api = desktopApi()
  if (!api) return
  try {
    await api.setPrefs({ [SONGS_FOLDER_PREF]: p })
  } catch {
    /* 写不进去不阻塞 UI */
  }
}

export async function listMapsets(opts: {
  songsFolder?: string
  offset?: number
  limit?: number
  search?: string
}): Promise<MapsetPage> {
  const api = desktopApi()
  if (!api) return { ...EMPTY_PAGE, error: 'browser' }
  try {
    return await api.osuListMapsets(opts)
  } catch (err) {
    return { ...EMPTY_PAGE, error: String(err) }
  }
}

export async function currentMapset(songsFolder?: string): Promise<CurrentMapsetResult> {
  const api = desktopApi()
  if (!api) {
    return { ok: false, status: 'browser', message: '浏览器模式无法读取 osu! 当前谱面', mapset: null }
  }
  try {
    return await api.osuCurrentMapset({ songsFolder })
  } catch (err) {
    return { ok: false, status: 'error', message: String(err), mapset: null }
  }
}

/** 「3 分钟前」这种相对时间，列表里比绝对时间戳好读 */
export function fmtAgo(mtimeMs: number): string {
  if (!mtimeMs) return ''
  const diff = Date.now() - mtimeMs
  if (diff < 60_000) return '刚刚'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} 个月前`
  return `${Math.floor(mo / 12)} 年前`
}

/** 谱面集在列表里显示的主标题：`Artist - Title` */
export function mapsetLabel(m: { artist?: string; title?: string; folder?: string }): string {
  const a = (m.artist || '').trim()
  const t = (m.title || '').trim()
  if (a && t) return `${a} - ${t}`
  return t || a || m.folder || '(未命名)'
}
