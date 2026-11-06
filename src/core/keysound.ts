/**
 * keysound 路径模板展开：把 ("piano/<loop(...)><int(...)>.wav", A0, C8) 这种定义
 * 按每个半音展开成实际文件名，供「按目录自动载入」匹配。
 *
 * 指令规则见语法 0.3.1.2：
 * - <list(L)>        列表第 i 项（循环取值），L 是 [Define] 里 list 定义的名字
 * - <loop(a,b,c)>    穷举的循环序列，同样按 i 循环取值
 * - <int(公式)>       公式可用变量 i（最低音=0，每升半音 +1）与 m（直接是 MIDI 编号），
 *                    支持 + - * / % 与括号，结果向下取整；第二个参数是位数，不足补 0
 * 每个音高展开时，i = m - 最低音。
 */
import type { Diagnostic } from './types'
import { midiToName } from './pitch'

export interface ExpandInput {
  pattern: string
  low: number
  high: number
  tune: number
  /** [Define] 里定义的列表：名字 -> 项 */
  lists: Map<string, string[]>
}

export interface ExpandOutput {
  /** MIDI 编号 -> 展开后的路径 */
  files: Map<number, string>
  errors: string[]
}

/** 取平衡括号内的内容（允许内部嵌套同类括号） */
function readParen(s: string, start: number): { inner: string; end: number } | null {
  // start 指向 '('
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') {
      depth--
      if (depth === 0) return { inner: s.slice(start + 1, i), end: i }
    }
  }
  return null
}

/** 按顶层逗号切分（忽略括号与引号内的逗号） */
export function splitTemplateArgs(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inQ: string | null = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQ) {
      cur += c
      if (c === inQ) inQ = null
      continue
    }
    if (c === '"' || c === "'") {
      inQ = c
      cur += c
      continue
    }
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter((x) => x !== '')
}

/** 去掉一层多余引号 */
export function unquote(s: string): string {
  const m = /^\s*"(.*)"\s*$/.exec(s) || /^\s*'(.*)'\s*$/.exec(s)
  return m ? m[1] : s.trim()
}

// ---------- 算式求值 ----------

type Tok = { t: 'num' | 'id' | 'op'; v: string }

function lexExpr(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      out.push({ t: 'num', v: src.slice(i, j) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      out.push({ t: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    if ('+-*/%()'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    return null
  }
  return out
}

/** 递归下降求值：expr -> term (('+'|'-') term)* */
function evalExpr(src: string, vars: Record<string, number>): number | null {
  const lexed = lexExpr(src)
  if (!lexed) return null
  const toks = lexed
  let p = 0
  const peek = () => toks[p]
  const eat = (v?: string) => (v ? peek()?.v === v : peek()) && toks[p++]

  function primary(): number | null {
    const t = peek()
    if (!t) return null
    if (eat('(')) {
      const v = expr()
      if (!eat(')') || v === null) return null
      return v
    }
    if (t.t === 'num') {
      p++
      return Number(t.v)
    }
    if (t.t === 'id') {
      p++
      return vars[t.v] ?? NaN
    }
    if (t.v === '-') {
      p++
      const v = primary()
      return v === null ? null : -v
    }
    return null
  }
  function term(): number | null {
    let a = primary()
    if (a === null) return null
    while (peek() && (peek()!.v === '*' || peek()!.v === '/' || peek()!.v === '%')) {
      const op = toks[p++].v
      const b = primary()
      if (b === null) return null
      a = op === '*' ? a * b : op === '/' ? a / b : a % b
    }
    return a
  }
  function expr(): number | null {
    let a = term()
    if (a === null) return null
    while (peek() && (peek()!.v === '+' || peek()!.v === '-')) {
      const op = toks[p++].v
      const b = term()
      if (b === null) return null
      a = op === '+' ? a + b : a - b
    }
    return a
  }
  const v = expr()
  if (v === null || !Number.isFinite(v) || p !== toks.length) return null
  return v
}

// ---------- 模板展开 ----------

/**
 * 把模板里的一条 <...> 指令展开成字符串。
 * i/m 的含义见文件头注释。
 */
function expandDirective(
  inner: string,
  vars: Record<string, number>,
  lists: Map<string, string[]>,
  errors: string[],
): string {
  const name = /^([A-Za-z]+)\s*\(/.exec(inner)?.[1]?.toLowerCase()
  const paren = inner.indexOf('(')
  const body = paren >= 0 ? readParen(inner, paren) : null
  if (!name || !body) {
    errors.push(`无法识别的模板指令 <${inner}>`)
    return ''
  }
  const argsStr = body.inner
  switch (name) {
    case 'list': {
      const items = lists.get(unquote(argsStr))
      if (!items || !items.length) {
        errors.push(`list(${unquote(argsStr)}) 没有对应的列表定义`)
        return ''
      }
      return String(items[vars.i % items.length])
    }
    case 'loop': {
      const items = splitTemplateArgs(argsStr).map(unquote)
      if (!items.length) {
        errors.push('loop() 里至少要有一个值')
        return ''
      }
      return String(items[vars.i % items.length])
    }
    case 'int': {
      const args = splitTemplateArgs(argsStr)
      if (!args.length) {
        errors.push('int() 需要一个公式')
        return ''
      }
      const v = evalExpr(args[0], vars)
      if (v === null) {
        errors.push(`int("${args[0]}") 的公式无法计算`)
        return ''
      }
      const n = Math.floor(v)
      const width = args.length > 1 ? Number(args[1]) : 0
      if (width > 0 && Number.isFinite(width)) return String(Math.abs(n)).padStart(width, '0')
      return String(n)
    }
    default:
      errors.push(`暂不支持的模板指令 <${name}(...)>`)
      return ''
  }
}

/** 对一个音高展开整条模板 */
function render(template: string, midi: number, lowMidi: number, lists: Map<string, string[]>, errors: string[]): string {
  const vars = { i: midi - lowMidi, m: midi }
  let out = ''
  let i = 0
  while (i < template.length) {
    if (template[i] === '<') {
      // 指令以 '>' 结束（文档约定 < 与 > 不计入嵌套括号）
      const j = template.indexOf('>', i)
      if (j < 0) {
        out += template.slice(i)
        break
      }
      out += expandDirective(template.slice(i + 1, j), vars, lists, errors)
      i = j + 1
      continue
    }
    out += template[i]
    i++
  }
  return out
}

/**
 * 展开 keysound 的路径模板。
 * @returns MIDI -> 路径（相对路径，后续按 [Files] 的 path 解析）
 */
export function expandKeysoundPath(input: ExpandInput): ExpandOutput {
  const files = new Map<number, string>()
  const errors: string[] = []
  const lo = Math.min(input.low, input.high)
  const hi = Math.max(input.low, input.high)
  for (let m = lo; m <= hi; m++) {
    files.set(m, render(input.pattern, m, lo, input.lists, errors))
  }
  // 去重错误信息，避免每个音高报同一条
  return { files, errors: [...new Set(errors)] }
}

/** 把形如 A0 / C8 / int 的名称解析成 MIDI 编号 */
export function parsePitchToken(raw: string): number | null {
  const s = raw.trim().replace(/^["']|["']$/g, '')
  if (/^\d+$/.test(s)) return Number(s)
  const m = /^([A-Ga-g])([#s]?)(-?\d)$/.exec(s)
  if (m) {
    const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
    const semi = base[m[1].toUpperCase()] + (m[2] ? 1 : 0)
    return (Number(m[3]) + 1) * 12 + semi
  }
  return null
}

/** keysound 每个音高的样本在引擎里的内部名字 */
export function keySampleName(instrument: string, midi: number): string {
  return `ks:${instrument}#${midi}`
}

/** keysound 单一文件（音色库 .sf2/.sf3 或整个乐器一个 wav）的内部名字 */
export function singleKeyName(instrument: string): string {
  return `ks:${instrument}`
}

/** 从内部名字反解乐器与音高 */
export function parseKeySampleName(name: string): { instrument: string; midi: number } | null {
  const m = /^ks:([^#]+)#(-?\d+)$/.exec(name)
  return m ? { instrument: m[1], midi: Number(m[2]) } : null
}

/** 给 UI 用：把展开结果概括成一行说明 */
export function describeKeysoundFiles(files: Map<number, string>, limit = 3): string {
  const keys = [...files.keys()].sort((a, b) => a - b)
  if (!keys.length) return '（无）'
  const first = keys.slice(0, limit).map((m) => `${midiToName(m)}→${files.get(m)}`)
  const rest = keys.length - limit
  return `${keys.length} 个音高：${first.join('，')}${rest > 0 ? ` …等 ${rest} 个` : ''}`
}

/** 把诊断信息写进 docs 时会用到的辅助（保持类型干净） */
export function pushErrors(diags: Diagnostic[], from: number, to: number, errors: string[]) {
  for (const e of errors) diags.push({ from, to, severity: 'error', message: e, code: 'ks-pattern' })
}
