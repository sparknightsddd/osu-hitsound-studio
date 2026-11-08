/**
 * 格子查找替换的纯逻辑（不碰 UI，方便单测）。
 *
 * 查找：把输入框里的代号解析成集合（`[Aa Ab]` / `Aa, Ab` / `Aa Ab` 都行）。
 * - 精确匹配：格子里的代号**正好**是这一组（顺序无关）
 * - 包含匹配：格子里**同时含有**这一组，多出来的代号不算问题
 *
 * 替换：
 * - 仅替换匹配项：把命中的代号换成新代号，格子里其它代号保留
 *   （[Aa Ac] 把 Aa 换成 Ab → [Ab Ac]；[Aa Ab] → [Ab]，不会出现两个 Ab）
 * - 完全替换：整格直接变成替换内容（[Aa Ac] → [Ab]），新内容留空就是把这一格清空
 */
import { normalizeCodeInput } from './codes'

/**
 * 从输入框解析代号列表：去掉方括号，按空格/逗号/顿号切分，去重。
 * 单个数字/符号按网格习惯转成正文名（`1` → `One`、`/` → `Slash`）。
 */
export function parseCodes(text: string): string[] {
  const body = String(text || '').replace(/[[\]]/g, ' ')
  const out: string[] = []
  for (const tok of body.split(/[\s,，、]+/)) {
    const t = normalizeCodeInput(tok.trim()) || tok.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 这一格是否命中查找 */
export function matchCell(names: string[], find: string[], exact: boolean): boolean {
  if (!find.length || !names.length) return false
  if (exact) return names.length === find.length && find.every((n) => names.includes(n))
  return find.every((n) => names.includes(n))
}

/**
 * 替换后这一格的新代号。
 *
 * @param onlyMatched 只换命中的那些代号（保留格子里其它代号）；false = 整格替换。
 *                    精确匹配时两种说法结果一样，调用方可以忽略这个参数。
 */
export function replaceCell(
  names: string[],
  find: string[],
  repl: string[],
  exact: boolean,
  onlyMatched: boolean,
): string[] {
  if (exact || !onlyMatched) return [...repl]
  // 命中的代号就地换成新代号（其它代号位置不动），重复的只留一个
  const out: string[] = []
  let placed = false
  for (const n of names) {
    if (find.includes(n)) {
      if (!placed) {
        for (const r of repl) if (!out.includes(r)) out.push(r)
        placed = true
      }
      continue
    }
    if (!out.includes(n)) out.push(n)
  }
  // 一个都没命中（理论上不会走到）：新代号补在末尾
  if (!placed) for (const r of repl) if (!out.includes(r)) out.push(r)
  return out
}

/** 两个代号列表是不是同一组（比较用，和顺序无关） */
export function sameCodes(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((n) => b.includes(n))
}
