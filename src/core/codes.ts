/**
 * 音效代号（code）的命名与键盘映射。
 *
 * 正文里的代号只用英文字母，大小写都行、大小写敏感（`a` 和 `A` 是两个代号）：
 *   - 普通代号：`Aa`、`abc`、`ABc`、`aBc` ……
 *   - 数字 / 符号：正文里写成驼峰英文名（`One`、`Slash`、`AtSign`），
 *     网格里显示按键本身（`1`、`/`、`@`）。
 *
 * 这样正文不用为标点加转义，网格又能一个键落一个音效。
 * `=` 不在表里：它是「白板音效 / 休止符」，不能当代号。
 */

export interface CodeKey {
  /** 键盘上按出来的字符 */
  key: string
  /** 正文里的名字 */
  name: string
}

/** 数字键 0–9 */
const DIGITS: CodeKey[] = [
  { key: '0', name: 'Zero' },
  { key: '1', name: 'One' },
  { key: '2', name: 'Two' },
  { key: '3', name: 'Three' },
  { key: '4', name: 'Four' },
  { key: '5', name: 'Five' },
  { key: '6', name: 'Six' },
  { key: '7', name: 'Seven' },
  { key: '8', name: 'Eight' },
  { key: '9', name: 'Nine' },
]

/** 英文键盘上的符号（不含 `=`，它和白板音效冲突） */
const SYMBOLS: CodeKey[] = [
  { key: '`', name: 'Backtick' },
  { key: '~', name: 'Tilde' },
  { key: '!', name: 'Exclamation' },
  { key: '@', name: 'AtSign' },
  { key: '#', name: 'Hash' },
  { key: '$', name: 'Dollar' },
  { key: '%', name: 'Percent' },
  { key: '^', name: 'Caret' },
  { key: '&', name: 'Ampersand' },
  { key: '*', name: 'Asterisk' },
  { key: '(', name: 'LeftParen' },
  { key: ')', name: 'RightParen' },
  { key: '-', name: 'Minus' },
  { key: '_', name: 'Underscore' },
  { key: '+', name: 'Plus' },
  { key: '[', name: 'LeftBracket' },
  { key: ']', name: 'RightBracket' },
  { key: '{', name: 'LeftBrace' },
  { key: '}', name: 'RightBrace' },
  { key: '\\', name: 'Backslash' },
  { key: '|', name: 'Pipe' },
  { key: ';', name: 'Semicolon' },
  { key: ':', name: 'Colon' },
  { key: "'", name: 'Apostrophe' },
  { key: '"', name: 'DoubleQuote' },
  { key: ',', name: 'Comma' },
  { key: '.', name: 'Period' },
  { key: '<', name: 'LessThan' },
  { key: '>', name: 'GreaterThan' },
  { key: '/', name: 'Slash' },
  { key: '?', name: 'Question' },
]

/** 所有「一个键 = 一个代号」的映射（数字 + 符号） */
export const CODE_KEYS: CodeKey[] = [...DIGITS, ...SYMBOLS]

const KEY_TO_NAME = new Map<string, string>(CODE_KEYS.map((k) => [k.key, k.name]))
const NAME_TO_KEY = new Map<string, string>(CODE_KEYS.map((k) => [k.name, k.key]))

/**
 * 按键 → 正文代号。
 * 字母原样返回（大小写敏感），数字/符号返回驼峰名；其余（含 `=`）返回 null。
 */
export function codeNameFromKey(key: string): string | null {
  if (/^[A-Za-z]$/.test(key)) return key
  return KEY_TO_NAME.get(key) ?? null
}

/** 正文代号 → 网格里显示的字符（`One`→`1`、`Slash`→`/`）；普通代号原样 */
export function codeGlyph(name: string): string {
  return NAME_TO_KEY.get(name) ?? name
}

/** 这个代号是不是特殊的数字/符号名（网格里显示成符号） */
export function isGlyphCode(name: string): boolean {
  return NAME_TO_KEY.has(name)
}

/** 正文代号是否合法：只允许英文字母，大小写不限 */
export function isCodeName(name: string): boolean {
  return /^[A-Za-z]+$/.test(name)
}

/**
 * 把输入框里的一串字符规整成合法代号。
 *
 * - 单字符是数字/符号 → 换成正文名（`1` → `One`、`/` → `Slash`）；
 * - 其余只保留英文字母，大小写原样保留（不再强行首字母大写）；
 * - `=` 不映射，会被过滤成空串。
 */
export function normalizeCodeInput(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const one = codeNameFromKey(s)
  if (one && [...s].length === 1) return one
  return s.replace(/[^A-Za-z]/g, '')
}

/** 网格里这个代号对应的快捷键（特殊代号给符号，其余给正文名） */
export function codeShortcut(name: string): string {
  return codeGlyph(name)
}

/**
 * 代号是否「必须靠一个键直接敲出来」：单字符代号（`A`、`a`、`One` 这种映射名）。
 * 多字母代号仍可敲前缀匹配，只是不能一键落笔。
 */
export function isSingleKeyCode(name: string): boolean {
  if (isGlyphCode(name)) return true
  return /^[A-Za-z]$/.test(name)
}

/** 所有可用的「一键代号」总数：52 字母 + 10 数字 + 31 符号 */
export const SINGLE_KEY_CODE_COUNT = 52 + CODE_KEYS.length

/** 显示用：把一串代号按网格习惯拼起来（`One Ab` → `1+Ab`） */
export function codeGlyphs(names: string[], sep = '+'): string {
  return names.map(codeGlyph).join(sep)
}
