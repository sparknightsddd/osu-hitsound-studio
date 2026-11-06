/**
 * 添加音效前的重复检查：这个音频文件是不是已经用在 [Define] 的某个代号上了。
 *
 * 两层判断：
 *   1. 路径相同（同一份文件，可能只是斜杠/大小写写法不同）；
 *   2. 内容相同（从别处复制出的一份副本）—— 比 sha1，先按文件大小预筛。
 *
 * 「同一份文件被两个代号引用」在谱面里不是错误，但基本都不是用户想要的，
 * 所以加音效时直接拦下来并告诉他已经在哪个代号上。
 */
import type { ChartDoc } from './types'
import { desktopApi, type DesktopApi } from './desktop'

/** Windows 下路径不分大小写（osu! 只跑 Windows，这里按平台判断） */
const foldCase = () => desktopApi()?.platform === 'win32'

function normalizePath(p: string): string {
  const s = p.replace(/\\/g, '/')
  return foldCase() ? s.toLowerCase() : s
}

/**
 * 找重复只用得到这两个能力，抽出来是为了能在 Node 里注入假实现做测试。
 */
type FileApi = Pick<DesktopApi, 'exists' | 'hashFile'>

/** 哈希缓存：连续加好几个音效时，别把已有文件一遍遍重读。键是路径，值带上 size/mtime，文件改过就失效。 */
const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>()

async function hashOf(api: FileApi, path: string, size: number, mtimeMs: number): Promise<string | null> {
  const key = normalizePath(path)
  const hit = hashCache.get(key)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.hash
  const r = await api.hashFile(path)
  if (!r.ok || !r.hash) return null
  hashCache.set(key, { size, mtimeMs, hash: r.hash })
  return r.hash
}

/**
 * 找出和新文件重复的已有代号；没有重复返回 null。
 *
 * 只比 [Define] 里**有代号**且能解析到磁盘路径的那几条（`default.xxx` 没有文件）。
 */
export async function findDuplicateSound(
  doc: ChartDoc,
  filePath: string,
  api: FileApi | null = desktopApi(),
): Promise<string | null> {
  const defs = doc.hitsounds.filter((h): h is typeof h & { name: string; resolvedPath: string } =>
    !!h.name && !!h.resolvedPath,
  )
  if (!defs.length) return null

  // 1) 路径相同：不用读文件
  const target = normalizePath(filePath)
  for (const h of defs) {
    if (normalizePath(h.resolvedPath) === target) return h.name
  }

  // 2) 内容相同。读不了（文件被删/没权限）就当不重复，别挡住正常添加。
  if (!api?.hashFile || !api.exists) return null
  const mine = await api.exists(filePath)
  if (!mine?.exists || mine.size == null) return null
  const mineHash = await hashOf(api, filePath, mine.size, mine.mtimeMs ?? 0)
  if (!mineHash) return null

  for (const h of defs) {
    const st = await api.exists(h.resolvedPath)
    if (!st?.exists || st.size == null) continue
    // 大小不同肯定不是同一份，省一次读盘
    if (st.size !== mine.size) continue
    const other = await hashOf(api, h.resolvedPath, st.size, st.mtimeMs ?? 0)
    if (other && other === mineHash) return h.name
  }
  return null
}
