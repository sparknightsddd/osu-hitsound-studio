/**
 * 「把所有音效收进谱面文件夹」的纯规划逻辑（不碰磁盘，方便测试）。
 *
 * 目标：做一份能直接发给别人的谱面包。
 *   - 每个 [Define] 用到的音频复制到谱面文件夹，并改名成代号（`xxx.wav` → `Aa.wav`）；
 *   - [Define] 里的路径跟着改成新文件名；
 *   - 删掉 [Files] 的 `path = ...`（没有 path 时基准目录就是 .hs 自己所在的文件夹）；
 *   - .hs 也挪进同一个文件夹（由调用方执行）。
 *
 * 只复制、不改名源文件：源文件在别的目录里原样保留。
 */
import { basename, dirname, resolvePath } from './parse'
import type { ChartDoc } from './types'

export interface BundleCopy {
  /** 音效代号，也是新文件名的主干 */
  code: string
  /** 源文件绝对路径 */
  from: string
  /** 目标文件绝对路径 */
  to: string
  /** 写回 [Define] 的文件名（含扩展名） */
  fileName: string
}

export interface BundleSkip {
  code: string
  reason: string
}

export interface BundlePlan {
  /** 目标是哪个文件夹（[Files] path，没写就是 .hs 所在目录） */
  targetDir: string
  copies: BundleCopy[]
  /** 没法自动处理的定义（保持原样） */
  skips: BundleSkip[]
  /** 改写后的整份文本 */
  text: string
  /** 改写了多少条 [Define] */
  rewritten: number
  /** 是否删掉了 [Files] path 那一行 */
  removedPath: boolean
}

function unquote(p: string): string {
  return String(p || '').trim().replace(/^["']|["']$/g, '')
}

/** 目录比较：Windows 不区分大小写，分隔符统一 */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return n(a) === n(b)
}

/** Windows 盘符/UNC 统一反斜杠，其余保持原样 */
function diskPath(p: string): string {
  const s = String(p || '')
  return /^[A-Za-z]:/.test(s) || s.startsWith('\\\\') ? s.replace(/\//g, '\\') : s
}

export function joinDir(dir: string, name: string): string {
  const d = dir.replace(/[\\/]+$/, '')
  const sep = /^[A-Za-z]:/.test(d) || d.includes('\\') ? '\\' : '/'
  return `${d}${sep}${name}`
}

/** 取扩展名（保留原大小写，比如 `.OGG`） */
function extOf(p: string): string {
  const m = /\.[A-Za-z0-9]+$/.exec(basename(p))
  return m ? m[0] : ''
}

/** 只改 `=` 右边的路径，保留引号风格和末尾的颜色 */
function rewriteDefineLine(line: string, fileName: string): string {
  const quoted = /(=\s*)(['"])([^'"]*)\2/
  if (quoted.test(line)) return line.replace(quoted, (_m, p1: string, q: string) => `${p1}${q}${fileName}${q}`)
  const plain = /(=\s*)([^\s#]+)/
  return line.replace(plain, (_m, p1: string) => `${p1}${fileName}`)
}

/**
 * 算出这次打包要复制哪些文件、文本怎么改。
 *
 * @param doc       当前谱面（必须带 .hs 的磁盘路径，或 [Files] path）
 * @param chartPath .hs 的磁盘路径（没有就传空串）
 */
export function planSoundBundle(doc: ChartDoc, chartPath: string): BundlePlan {
  // [Files] path 可能是相对的（相对 .hs 所在目录），统一解析成绝对路径再比
  const chartDir = chartPath ? dirname(chartPath) : ''
  const rawPath = unquote(doc.settings.Path)
  const targetDir = rawPath ? resolvePath(chartDir, rawPath) : chartDir
  const plan: BundlePlan = {
    targetDir,
    copies: [],
    skips: [],
    text: doc.text,
    rewritten: 0,
    removedPath: false,
  }
  if (!targetDir) return plan

  /** 行号（1 起）→ 新的文件名 */
  const byLine = new Map<number, string>()
  /**
   * 已占用的文件名（小写）。代号区分大小写，但 Windows 文件系统不区分：
   * `a` 和 `A` 不能都叫 `a.wav`，撞上就加 `_2`、`_3` 后缀。
   */
  const usedFile = new Set<string>()
  for (const h of doc.hitsounds) {
    if (!h.name) continue
    if (h.defaultRef) continue // 内置 default.xxx，没有实体文件
    // keysound 多文件：一个代号对应几十个音高文件，没法都叫 Aa.wav，保持原样
    if (h.keyFiles && h.keyFiles.size) {
      plan.skips.push({ code: h.name, reason: 'keysound 多文件定义（一个代号对应多个音频）' })
      continue
    }
    const src = unquote(h.resolvedPath || '')
    if (!src) {
      plan.skips.push({ code: h.name, reason: '[Define] 里没有可解析的文件路径' })
      continue
    }
    const ext = extOf(src)
    let fileName = `${h.name}${ext}`
    if (usedFile.has(fileName.toLowerCase())) {
      let n = 2
      while (usedFile.has(`${h.name}_${n}${ext}`.toLowerCase())) n++
      fileName = `${h.name}_${n}${ext}`
    }
    usedFile.add(fileName.toLowerCase())
    const to = joinDir(targetDir, fileName)
    if (!samePath(src, to)) plan.copies.push({ code: h.name, from: diskPath(src), to, fileName })
    byLine.set(h.line, fileName)
  }

  const lines = doc.text.split('\n')
  // 先按行号改 [Define]（这时行号还没被删行影响）
  for (const [lineNo, fileName] of byLine) {
    const i = lineNo - 1
    if (i < 0 || i >= lines.length) continue
    const next = rewriteDefineLine(lines[i], fileName)
    if (next !== lines[i]) {
      lines[i] = next
      plan.rewritten++
    }
  }

  // 再删 [Files] 里的 path 行（该段里出现几次删几次）
  let section = ''
  const kept: string[] = []
  for (const line of lines) {
    const sm = /^\s*\[([A-Za-z][A-Za-z0-9]*)\]\s*$/.exec(line)
    if (sm) section = sm[1].toLowerCase()
    if (section === 'files' && /^\s*path\s*=/i.test(line)) {
      plan.removedPath = true
      continue
    }
    kept.push(line)
  }
  plan.text = kept.join('\n')
  return plan
}
