/**
 * 改 [Define] 里一条 hitsound 定义：槽位 / 代号。
 *
 * 独立成纯函数（只吃文本、吐文本）是为了能单测。
 *
 * 改名要改的「正文」范围：
 *   - [Hitsound] 段的全部内容；
 *   - 乐句（`@Fill = /K (KK)/`）的 body —— 它们会被展开进正文；
 *   - `@Fill` 这种**乐句引用**不能动（前面有 `@` 的跳过）。
 * `Aa`、`[Aa Ab]`、`Aa<v=80>` 都算命中，`Aab` 这种别的代号不会误伤。
 */
import { parseChart } from './parse'
import { isCodeName } from './codes'
import { isSlotName } from './soundSlots'
import { parseColorToken } from './colors'
import type { ChartDoc } from './types'

export type DefineEditError = 'notFound' | 'badName' | 'dup' | 'badLine' | 'badColor'

export interface DefineEditOutcome {
  ok: boolean
  /** ok=true 时的完整新正文 */
  text?: string
  /** 正文里同步改掉的引用数 */
  changes?: number
  /** ok=false 时的原因码（UI 负责翻译） */
  error?: DefineEditError
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function refRe(code: string): RegExp {
  // (?<!@)：`@Fill` 是乐句引用，不是代号
  return new RegExp(`(?<!@)\\b${escapeRe(code)}\\b`, 'g')
}

/** 改名时会被扫到的文本范围（正文 + 乐句 body） */
function refRanges(doc: ChartDoc): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  const sec = doc.sections.find((x) => x.name.toLowerCase() === 'hitsound')
  if (sec) out.push({ from: sec.from, to: sec.to })
  for (const p of doc.phrases) {
    // 万一乐句落在 [Hitsound] 段里（不常见），别重复算
    if (out.some((r) => p.from >= r.from && p.to <= r.to)) continue
    out.push({ from: p.from, to: p.to })
  }
  return out
}

/**
 * 改定义行末尾的颜色 token（保留 `##` 注释与其它内容）。
 *
 * color 传 null = 去掉颜色；传 #RRGGBB = 换/加在末尾。
 * 原来写的是 `red` 还是 `#f00` 都能认出来（和解析器同一套 parseColorToken）。
 */
function withColor(line: string, color: string | null): string {
  const ci = line.indexOf('##')
  const head = (ci >= 0 ? line.slice(0, ci) : line).replace(/\s+$/, '')
  const tail = ci >= 0 ? line.slice(ci).trim() : ''
  const eq = head.indexOf('=')
  if (eq < 0) return line

  const rhs = head.slice(eq + 1)
  const m = /\s+(\S+)$/.exec(rhs)
  // 末尾 token 是颜色（或者是个写坏的 #hex）就替换它，否则直接往后加
  const isColorTok = !!m && (!!parseColorToken(m[1]) || /^#[0-9a-fA-F]{3,8}$/.test(m[1]))
  const base = (isColorTok && m ? head.slice(0, eq + 1 + m.index) : head).replace(/\s+$/, '')

  let out = base
  if (color) out = `${out} ${color}`
  if (tail) out = `${out} ${tail}`
  return out
}

/** 这个代号在正文 / 乐句里出现了几次（UI 显示影响范围用） */
export function countHitsoundRefs(doc: ChartDoc, code: string): number {
  if (!code) return 0
  const re = refRe(code)
  let n = 0
  for (const r of refRanges(doc)) {
    n += (doc.text.slice(r.from, r.to).match(re) || []).length
  }
  return n
}

export function editHitsoundDefineText(
  text: string,
  code: string,
  opts: { name?: string; slots?: string[]; color?: string | null } = {},
  baseDir?: string,
): DefineEditOutcome {
  const doc = parseChart(text, { baseDir })
  const def = doc.hitsounds.find((h) => h.kind === 'hitsound' && h.name === code)
  if (!def) return { ok: false, error: 'notFound' }

  const nextName = (opts.name ?? code).trim()
  if (!isCodeName(nextName)) return { ok: false, error: 'badName' }
  if (nextName !== code && doc.hitsounds.some((h) => h.name === nextName))
    return { ok: false, error: 'dup' }

  const line = text.slice(def.from, def.to)
  const m = /^(\s*hitsound\s+)(\S+)(\s+)(\S+)/.exec(line)
  if (!m) return { ok: false, error: 'badLine' }

  // slots 没传 = 保持原来的槽位；传空数组 = 明确要改成 custom
  let slotText = m[2]
  if (opts.slots !== undefined) {
    const slots = opts.slots.filter((x) => isSlotName(x))
    const main = slots.length ? slots.join('|') : 'custom'
    // 副槽位不在「音效设置」的复选框里，改主槽位 / 颜色 / 代号时原样保留
    const subs = def.subSlots || []
    slotText = subs.length ? `${main}|${subs.join('|')}` : main
  }
  // 只换「槽位」「代号」两个 token；值、颜色、行尾其它内容原样保留
  let newLine = m[1] + slotText + m[3] + nextName + line.slice(m[0].length)

  // 颜色：undefined = 保持；''/null = 去掉；其它 = 换成这个颜色
  if (opts.color !== undefined) {
    const want = opts.color === null ? '' : opts.color.trim()
    if (want) {
      const c = parseColorToken(want)
      if (!c) return { ok: false, error: 'badColor' }
      newLine = withColor(newLine, c.toUpperCase())
    } else {
      newLine = withColor(newLine, null)
    }
  }

  const ops: { from: number; to: number; text: string }[] = []
  let changes = 0
  if (nextName !== code) {
    const re = refRe(code)
    for (const r of refRanges(doc)) {
      const part = text.slice(r.from, r.to)
      const next = part.replace(re, () => {
        changes++
        return nextName
      })
      if (next !== part) ops.push({ from: r.from, to: r.to, text: next })
    }
  }
  if (newLine !== line) ops.push({ from: def.from, to: def.to, text: newLine })
  if (!ops.length) return { ok: true, text, changes: 0 }

  // 从后往前改，前面的偏移量才不会被打乱
  ops.sort((a, b) => b.from - a.from)
  let out = text
  for (const op of ops) out = out.slice(0, op.from) + op.text + out.slice(op.to)
  return { ok: true, text: out, changes }
}
