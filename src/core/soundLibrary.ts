/**
 * 音效库（左侧第 6 个图标）的数据层。
 *
 * 只做三件事：
 *   1. 记住用户在设置里指定的音效文件夹（prefs.json 的 soundFolder）；
 *   2. 把目录里所有 .wav / .ogg 列出来（递归子目录，主进程负责）；
 *   3. 把磁盘文件读成 File，供试听 / 绑定样本。
 *
 * 和「谱面库」一样，浏览器模式下安静地返回空，不弹错。
 */
import { desktopApi } from './desktop'

/** prefs.json 里存音效文件夹的键 */
export const SOUND_FOLDER_PREF = 'soundFolder'

export interface SoundFileEntry {
  name: string
  /** 磁盘绝对路径 */
  path: string
  /** 相对音效文件夹的路径（子目录会带上） */
  relPath: string
  size: number
}

export async function getSoundFolder(): Promise<string> {
  const api = desktopApi()
  if (!api) return ''
  try {
    const prefs = (await api.getPrefs()) || {}
    return String(prefs[SOUND_FOLDER_PREF] || '')
  } catch {
    return ''
  }
}

export async function setSoundFolder(p: string): Promise<void> {
  const api = desktopApi()
  if (!api) return
  try {
    await api.setPrefs({ [SOUND_FOLDER_PREF]: p })
  } catch {
    /* 写不进去不阻塞 UI */
  }
}

/** 列出目录下所有 .wav / .ogg（含子目录），按相对路径排序 */
export async function listSoundFiles(
  dir: string,
): Promise<{ ok: boolean; files: SoundFileEntry[]; error?: string }> {
  const api = desktopApi()
  if (!api) return { ok: false, files: [], error: 'browser' }
  if (!dir) return { ok: true, files: [] }
  try {
    const r = await api.listDir(dir, { exts: ['.wav', '.ogg'], maxFiles: 5000 })
    const files = (r.files || []).map((f) => ({
      name: f.name,
      path: f.path,
      relPath: f.relPath,
      size: f.size,
    }))
    files.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh'))
    return { ok: !!r.ok, files, error: r.error }
  } catch (e) {
    return { ok: false, files: [], error: String(e) }
  }
}

/** 1.2 MB / 380 KB 这种 */
export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
