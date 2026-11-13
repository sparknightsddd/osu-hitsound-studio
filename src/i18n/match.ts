/**
 * 系统语言 → 内置语言包的匹配规则。
 *
 * 单独放在这里是为了能脱离 `?raw` 语言包做单元测试；浏览器/Electron 的
 * `navigator.languages` 顺序就是用户偏好顺序，取第一个能匹配上的。
 */

/** 选择「跟随系统」时存进 localStorage 的值 */
export const AUTO_LANG = 'auto'

/** 内置语言包 id（顺序只影响列表展示，listLangs 会再排序） */
export const BUILTIN_LANG_IDS = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'ru-RU'] as const

export type BuiltinLangId = (typeof BUILTIN_LANG_IDS)[number]

/**
 * 把一个 BCP-47 标签映射到内置语言包 id；不支持的语言返回 null。
 *
 * 中文按文字/地区分流：
 *   zh-Hant / zh-TW / zh-HK / zh-MO → zh-TW
 *   zh-Hans / zh-CN / zh-SG / 其他 zh → zh-CN
 */
export function matchLangTag(tag: string): BuiltinLangId | null {
  const t = String(tag || '')
    .trim()
    .replace(/_/g, '-')
    .toLowerCase()
  if (!t) return null
  if (t === 'zh' || t.startsWith('zh-')) {
    // 繁体：脚本、地区任一命中就算
    if (t.includes('hant') || /(^|-)tw($|-)/.test(t) || /(^|-)hk($|-)/.test(t) || /(^|-)mo($|-)/.test(t)) {
      return 'zh-TW'
    }
    return 'zh-CN'
  }
  if (t === 'ja' || t.startsWith('ja-')) return 'ja-JP'
  if (t === 'ko' || t.startsWith('ko-')) return 'ko-KR'
  if (t === 'ru' || t.startsWith('ru-')) return 'ru-RU'
  if (t === 'en' || t.startsWith('en-')) return 'en-US'
  return null
}

/** 按偏好顺序挑一个内置语言；都不支持就英文 */
export function pickSystemLang(tags: readonly string[]): BuiltinLangId {
  for (const tag of tags) {
    const id = matchLangTag(tag)
    if (id) return id
  }
  return 'en-US'
}

/** 当前环境的系统语言偏好（Electron / 浏览器都走 navigator） */
export function systemLangTags(): string[] {
  if (typeof navigator === 'undefined') return []
  const nav = navigator as Navigator & { languages?: readonly string[] }
  const list = nav.languages && nav.languages.length ? [...nav.languages] : [nav.language]
  return list.map((x) => String(x || '').trim()).filter(Boolean)
}
