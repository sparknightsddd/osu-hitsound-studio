/** 系统语言标签 → 内置语言包的匹配规则 */
import { AUTO_LANG, matchLangTag, pickSystemLang } from '../src/i18n/match'

let pass = 0
let fail = 0
const T = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const cases: [string, string | null][] = [
  ['zh-CN', 'zh-CN'],
  ['zh-Hans', 'zh-CN'],
  ['zh-Hans-CN', 'zh-CN'],
  ['zh-SG', 'zh-CN'],
  ['zh', 'zh-CN'],
  ['zh-TW', 'zh-TW'],
  ['zh-HK', 'zh-TW'],
  ['zh-MO', 'zh-TW'],
  ['zh-Hant', 'zh-TW'],
  ['zh-Hant-HK', 'zh-TW'],
  ['ja', 'ja-JP'],
  ['ja-JP', 'ja-JP'],
  ['ko', 'ko-KR'],
  ['ko-KR', 'ko-KR'],
  ['ru', 'ru-RU'],
  ['ru-RU', 'ru-RU'],
  ['en', 'en-US'],
  ['en-GB', 'en-US'],
  ['fr-FR', null],
  ['de', null],
  ['', null],
  ['ZH_tw', 'zh-TW'],
]
for (const [tag, want] of cases) {
  const got = matchLangTag(tag)
  T(`${tag || '(空)'} → ${want ?? '不支持'}`, got === want, String(got))
}

T('按偏好顺序取第一个支持的语言', pickSystemLang(['fr-FR', 'ja-JP', 'en-US']) === 'ja-JP')
T('第一个语言不支持时继续往后找', pickSystemLang(['de-DE', 'ko-KR']) === 'ko-KR')
T('都不支持 → 英文', pickSystemLang(['fr-FR', 'de-DE']) === 'en-US')
T('空列表 → 英文', pickSystemLang([]) === 'en-US')
T('auto 是固定的持久化值', AUTO_LANG === 'auto')

console.log(`\nRESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
