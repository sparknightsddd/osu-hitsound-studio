/**
 * [Settings] Sections 的读写。
 *
 * 格式（和需求里的例子一致）：
 *   Sections = { ( 123456 , "abcdef" ) , ( 345678 , "uvwxyz" ) }
 *
 * 圆括号里是毫秒数（与 Bookmarks / [Timing] 第一项同单位）和段落名。
 * 分节符的语义：time 对应的小节从新的一行开始显示。
 */
import type { SectionMark } from './types'

/** 段落名的引号转义（名字里可以有空格、中文，但不能直接塞双引号） */
export function quoteSectionName(name: string): string {
  return `"${String(name ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`
}

/** 没有分节符时返回空串（调用方据此删除整行） */
export function formatSections(sections: SectionMark[]): string {
  const list = sections
    .filter((s) => Number.isFinite(s.time))
    .slice()
    .sort((a, b) => a.time - b.time)
  if (!list.length) return ''
  const body = list.map((s) => `( ${Math.round(s.time)} , ${quoteSectionName(s.name)} )`).join(' , ')
  return `Sections = { ${body} }`
}

const HEADER_RE = /^\s*\[[A-Za-z][A-Za-z0-9]*\]\s*$/
const SETTINGS_RE = /^\s*\[Settings\]\s*$/i
const SECTIONS_RE = /^\s*Sections\s*=/i

/**
 * 把 Sections 写回整份文本：
 *   - [Settings] 里已有 Sections 行 → 替换（列表为空则删掉这一行）；
 *   - 没有 → 追加到 [Settings] 末尾；
 *   - 连 [Settings] 都没有 → 在 [Define]/[Timing]/[Hitsound] 之前补一段。
 * 其它行、缩进、注释、换行风格都不动。
 */
export function updateSectionsText(text: string, sections: SectionMark[]): string {
  const line = formatSections(sections)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  let sh = -1
  for (let i = 0; i < lines.length; i++) {
    if (SETTINGS_RE.test(lines[i])) {
      sh = i
      break
    }
  }

  if (sh >= 0) {
    let se = lines.length
    for (let i = sh + 1; i < lines.length; i++) {
      if (HEADER_RE.test(lines[i])) {
        se = i
        break
      }
    }
    let si = -1
    for (let i = sh + 1; i < se; i++) {
      if (SECTIONS_RE.test(lines[i])) {
        si = i
        break
      }
    }
    if (si >= 0) {
      if (line) lines[si] = line
      else lines.splice(si, 1)
    } else if (line) {
      // 插在块末尾，但保留块与下一个段之间的空行
      let at = se
      while (at > sh + 1 && !lines[at - 1].trim()) at--
      lines.splice(at, 0, line)
    }
    return lines.join(eol)
  }

  if (!line) return text

  // 没有 [Settings]：在主要段落之前补一个，保持常规顺序
  const at = lines.findIndex((l) => /^\s*\[(Define|Timing|Hitsound)\]\s*$/i.test(l))
  if (at >= 0) lines.splice(at, 0, '[Settings]', line, '')
  else lines.push('', '[Settings]', line)
  return lines.join(eol)
}
