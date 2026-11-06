/**
 * 调整 [Define] 里音效定义的先后顺序（格子模式顶部画笔栏拖动排序用）。
 *
 * 只动「有代号」的那几行：把它们的**整行内容**按新顺序放回原来那几行所在的位置。
 * 换句话说，行号不变、只换内容，所以：
 *   - 空行、缩进、行尾 `## 注释` 跟着自己那一行走；
 *   - 无名定义（`hitsound custom = "x.wav"`）、`@乐句`、`list`、其它段落一律原地不动。
 *
 * 为什么按行搬而不是按字符搬：一条定义就是一行，整行搬过去注释也不会丢，
 * 而且不会因为重排打乱别的段落里的字符偏移。
 */
import { parseChart } from './parse'

const HEADER_RE = /^\s*\[[A-Za-z][A-Za-z0-9]*\]\s*$/
const DEFINE_RE = /^\s*\[Define\]\s*$/i

/**
 * 把 `text` 里 [Define] 的代号定义按 `order` 重新排列。
 *
 * `order` 里没提到的代号（比如拖动过程中文本又被改过）按原顺序补在后面，
 * 保证不会因为一份过期的名单把某条定义搬丢。
 * 顺序没变化时原样返回（调用方据此判断要不要写回/记撤销）。
 */
export function reorderDefineText(text: string, order: string[]): string {
  const doc = parseChart(text)
  const defs = doc.hitsounds.filter((h) => !!h.name)
  if (defs.length < 2) return text

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  let head = -1
  for (let i = 0; i < lines.length; i++) {
    if (DEFINE_RE.test(lines[i])) {
      head = i
      break
    }
  }
  if (head < 0) return text

  let tail = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i])) {
      tail = i
      break
    }
  }

  /** 行号（0 起）-> 代号；一行里塞了两条定义（或定义跑出 [Define]）就放弃 */
  const byLine = new Map<number, string>()
  for (const h of defs) {
    const li = h.line - 1
    if (li <= head || li >= tail) return text
    if (byLine.has(li)) return text
    byLine.set(li, h.name!)
  }

  const slots = [...byLine.keys()].sort((a, b) => a - b)
  const old = slots.map((li) => byLine.get(li)!)

  const known = new Set(old)
  const seen = new Set<string>()
  const next: string[] = []
  for (const n of order) {
    if (!known.has(n) || seen.has(n)) continue
    seen.add(n)
    next.push(n)
  }
  for (const n of old) {
    if (seen.has(n)) continue
    seen.add(n)
    next.push(n)
  }
  if (next.join('\u0000') === old.join('\u0000')) return text

  // 行内容按新顺序填回原来的行号
  const body = slots.map((li) => lines[li])
  const moved = next.map((n) => body[old.indexOf(n)])
  slots.forEach((li, i) => {
    lines[li] = moved[i]
  })
  return lines.join(eol)
}
