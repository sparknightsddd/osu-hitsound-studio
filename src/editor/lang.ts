import { StreamLanguage, HighlightStyle, syntaxHighlighting, LanguageSupport } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

interface St {
  section: string
  afterEq: boolean
  valueDone: boolean
}

const BODY_SECTIONS = new Set(['hitsound', 'keysound', 'hitobjects'])
const INDEX_LEFT = new Set([' ', '\t', '/', '|', '[', '(', '>'])

const musictxt = StreamLanguage.define<St>({
  name: 'musictxt',
  startState: () => ({ section: '', afterEq: false, valueDone: false }),
  token(stream, state) {
    let atLineStart = false
    if (stream.sol()) {
      const sec = stream.match(/^\s*\[[A-Za-z]+\]/) as RegExpMatchArray | null
      if (sec) {
        state.section = sec[0].trim().slice(1, -1).toLowerCase()
        state.afterEq = false
        return 'section'
      }
      state.afterEq = false
      state.valueDone = false
      atLineStart = true
    }
    if (stream.eatSpace()) return null

    if (stream.peek() === '#') {
      // "##" 是注释；正文里单个 "#" 开头是段落标记
      if (!stream.match('##') && atLineStart && BODY_SECTIONS.has(state.section)) {
        if (
          stream.match(
            /^#\s*(?:\d+(?::[0-5]?\d[:.]\d{1,3})?|bookmark\s*\(\s*\d+\s*\)|timing\s*\(\s*\d+\s*\))/i,
          )
        ) {
          return 'marker'
        }
      }
      stream.skipToEnd()
      return 'comment'
    }

    const ch = stream.peek() ?? ''

    // ---------- 正文 ----------
    if (BODY_SECTIONS.has(state.section)) {
      if (ch === '/') {
        stream.next()
        return 'bar'
      }
      if (ch === '-') {
        stream.next()
        return 'dash'
      }
      if (ch === '=') {
        stream.next()
        return 'rest'
      }
      if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '|') {
        stream.next()
        return 'bracket'
      }
      if (ch === '*') {
        stream.next()
        return 'star'
      }
      if (ch === '^' || ch === '_') {
        // 相对八度记号（仅 [Keysound] 正文有效）
        stream.match(/^[\^_]+/)
        return 'octave'
      }
      if (ch === '{') {
        // [Keysound] 首行的乐器列表 {piano | guitar}
        if (stream.match(/^\{[^{}]*\}?/)) return 'braceList'
        stream.next()
        return null
      }
      if (ch === '<') {
        stream.match(/^<[^>]*>?/)
        return 'directive'
      }
      if (ch === '@') {
        stream.next()
        stream.match(/^[A-Za-z0-9_]*/)
        return 'phraseName'
      }
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        // 代号大小写不限，一整段连续字母就是一个代号
        stream.match(/^[A-Za-z]+/)
        return 'note'
      }
      if (ch >= '0' && ch <= '9') {
        const col = stream.column()
        const prev = col > 0 ? stream.string.charAt(stream.pos - 1) : ' '
        stream.match(/^\d+/)
        return col === 0 || INDEX_LEFT.has(prev) ? 'indexNumber' : 'number'
      }
      stream.next()
      return null
    }

    // ---------- 键值对（Metadata / Settings） ----------
    if (state.section === 'metadata' || state.section === 'settings' || state.section === 'files') {
      if (!state.afterEq) {
        if (ch === '=') {
          stream.next()
          state.afterEq = true
          return 'operator'
        }
        if (stream.match(/^[A-Za-z][A-Za-z0-9]*/)) return 'propertyName'
        stream.next()
        return null
      }
      if (stream.match(/^(true|false)/i)) return 'bool'
      if (stream.match(/^"[^"]*"?/)) return 'string'
      if (stream.match(/^'[^']*'?/)) return 'string'
      if (stream.match(/^-?\d+(\.\d+)?/)) return 'number'
      if (stream.match(/^\{(.*?)\}?/)) return 'braceList'
      if (stream.match(/^[A-Za-z][A-Za-z0-9.]*/)) return 'enumValue'
      stream.next()
      return null
    }

    // ---------- Define ----------
    if (state.section === 'define') {
      if (stream.match(/^(hitsound|keysound)\b/)) return 'keyword'
      if (stream.match(/^list\b/)) return 'keyword'
      if (stream.match(/^(int|float|string)\b/)) return 'typeName'
      if (stream.match(/^default\.[A-Za-z0-9.-]+/)) return 'enumValue'
      if (ch === '@') {
        stream.next()
        stream.match(/^[A-Za-z0-9_]*/)
        return 'phraseName'
      }
      if (stream.match(/^(soft|normal|drum)(-(hitnormal|hitwhistle|hitfinish|hitclap|sliderside|slidertick))?/))
        return 'slot'
      if (stream.match(/^(sliderside|slidertick)\b/)) return 'slot'
      if (stream.match(/^(custom)\b/)) return 'slot'
      if (stream.match(/^\{([\d,()\s]*)\}?/)) return 'braceList'
      if (ch === '|') {
        stream.next()
        return 'operator'
      }
      if (ch === '=') {
        stream.next()
        return 'operator'
      }
      if (stream.match(/^"[^"]*"?/)) return 'string'
      if (stream.match(/^'[^']*'?/)) return 'string'
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        stream.match(/^[A-Za-z]+/)
        return 'noteDef'
      }
      if (stream.match(/^-?\d+(\.\d+)?/)) return 'number'
      stream.next()
      return null
    }

    // ---------- Timing ----------
    if (state.section === 'timing') {
      if (stream.match(/^(bpm|beat)\(/i)) return 'keyword'
      if (stream.match(/^-?\d+(\.\d+)?/)) return 'number'
      if (ch === ',' || ch === ')' || ch === '(') {
        stream.next()
        return 'punctuation'
      }
      stream.next()
      return null
    }

    stream.next()
    return null
  },
  languageData: {
    commentTokens: { line: '##' },
  },
  tokenTable: {
    section: t.definitionKeyword,
    bar: t.strong,
    dash: t.operator,
    rest: t.atom,
    bracket: t.bracket,
    star: t.operatorKeyword,
    directive: t.meta,
    phraseName: t.special(t.variableName),
    note: t.variableName,
    noteDef: t.definition(t.variableName),
    indexNumber: t.special(t.number),
    number: t.number,
    propertyName: t.propertyName,
    enumValue: t.atom,
    bool: t.bool,
    string: t.string,
    braceList: t.special(t.string),
    keyword: t.keyword,
    typeName: t.typeName,
    slot: t.typeName,
    operator: t.operator,
    punctuation: t.punctuation,
    comment: t.comment,
    marker: t.labelName,
    octave: t.special(t.keyword),
  },
})

export const musictxtHighlight = HighlightStyle.define([
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.definitionKeyword, color: '#000080', fontWeight: '600' },
  { tag: t.keyword, color: '#af00db' },
  { tag: t.typeName, color: '#267f99' },
  { tag: t.variableName, color: '#d16b16', fontWeight: '600' },
  { tag: t.definition(t.variableName), color: '#001080', fontWeight: '700' },
  { tag: t.special(t.variableName), color: '#9a3b8f', fontWeight: '600' },
  { tag: t.propertyName, color: '#8b1a1a' },
  { tag: t.number, color: '#098658' },
  { tag: t.special(t.number), color: '#b5509c' },
  { tag: t.string, color: '#a31515' },
  { tag: t.special(t.string), color: '#0b7285' },
  { tag: t.atom, color: '#795e26' },
  { tag: t.bool, color: '#0000ff' },
  { tag: t.operator, color: '#383838' },
  { tag: t.operatorKeyword, color: '#af00db' },
  { tag: t.bracket, color: '#383838', fontWeight: '600' },
  { tag: t.strong, color: '#0a7bd4', fontWeight: '700' },
  { tag: t.punctuation, color: '#383838' },
  { tag: t.special(t.keyword), color: '#0078d4', fontWeight: '700' },
  { tag: t.meta, color: '#0b7285' },
  { tag: t.labelName, color: '#0451a5', fontWeight: '700' },
])

export const musictxtHighlightDark = HighlightStyle.define([
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.definitionKeyword, color: '#c586c0', fontWeight: '600' },
  { tag: t.keyword, color: '#c586c0' },
  { tag: t.typeName, color: '#4ec9b0' },
  { tag: t.variableName, color: '#e5c07b', fontWeight: '600' },
  { tag: t.definition(t.variableName), color: '#9cdcfe', fontWeight: '700' },
  { tag: t.special(t.variableName), color: '#dcdcaa', fontWeight: '600' },
  { tag: t.propertyName, color: '#9cdcfe' },
  { tag: t.number, color: '#b5cea8' },
  { tag: t.special(t.number), color: '#c586c0' },
  { tag: t.string, color: '#ce9178' },
  { tag: t.special(t.string), color: '#4ec9b0' },
  { tag: t.atom, color: '#d7ba7d' },
  { tag: t.bool, color: '#569cd6' },
  { tag: t.operator, color: '#d4d4d4' },
  { tag: t.operatorKeyword, color: '#c586c0' },
  { tag: t.bracket, color: '#ffd700', fontWeight: '600' },
  { tag: t.strong, color: '#569cd6', fontWeight: '700' },
  { tag: t.punctuation, color: '#d4d4d4' },
  { tag: t.special(t.keyword), color: '#4fc1ff', fontWeight: '700' },
  { tag: t.meta, color: '#4ec9b0' },
  { tag: t.labelName, color: '#4fc1ff', fontWeight: '700' },
])

export function musictxtLanguage(theme: 'light' | 'dark') {
  return new LanguageSupport(musictxt, [
    syntaxHighlighting(theme === 'dark' ? musictxtHighlightDark : musictxtHighlight),
  ])
}
