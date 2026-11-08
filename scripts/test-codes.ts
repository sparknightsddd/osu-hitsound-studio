/**
 * 代号规则单测：
 *   - 大小写不限 / 大小写敏感（abc、ABc、aBc、a、A 都合法且不同）；
 *   - 数字/符号在正文里用驼峰名（One / Slash / AtSign），网格显示符号；
 *   - 正文里连续字母是一个代号（AaAa 不再拆成两个 Aa）；
 *   - 数字/符号代号能解析、能写回、能改名。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdit } from '../src/core/gridEdit'
import { editHitsoundDefineText } from '../src/core/defineEdit'
import {
  CODE_KEYS,
  SINGLE_KEY_CODE_COUNT,
  codeGlyph,
  codeGlyphs,
  codeNameFromKey,
  isCodeName,
  normalizeCodeInput,
} from '../src/core/codes'

let bad = 0
function ok(cond: boolean, name: string, extra = '') {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`)
  } else console.log(`ok   ${name}${extra ? ' — ' + extra : ''}`)
}

// 1) 合法性
ok(isCodeName('abc') && isCodeName('ABc') && isCodeName('aBc'), '小写开头、大小写混排都合法')
ok(isCodeName('a') && isCodeName('A'), '单字母大小写都合法')
ok(!isCodeName('a1') && !isCodeName('a-b') && !isCodeName(''), '数字/符号/空串不是代号名')

// 2) 按键映射
ok(codeNameFromKey('a') === 'a' && codeNameFromKey('A') === 'A', '字母按键区分大小写')
ok(codeNameFromKey('1') === 'One' && codeNameFromKey('0') === 'Zero', '数字 → 驼峰名')
ok(codeNameFromKey('/') === 'Slash' && codeNameFromKey('@') === 'AtSign', '符号 → 驼峰名')
ok(codeNameFromKey('=') === null && codeNameFromKey(' ') === null, '= 和空格不能当代号')
ok(CODE_KEYS.length === 41 && SINGLE_KEY_CODE_COUNT === 93, `一键代号共 ${SINGLE_KEY_CODE_COUNT} 个（52+41）`, String(CODE_KEYS.length))

// 3) 网格显示
ok(codeGlyph('One') === '1' && codeGlyph('Slash') === '/' && codeGlyph('AtSign') === '@', '特殊代号在网格显示成符号')
ok(codeGlyph('Aa') === 'Aa' && codeGlyph('abc') === 'abc', '普通代号原样显示')
ok(codeGlyphs(['One', 'Aa']) === '1+Aa', '多个代号按网格习惯拼接')

// 4) 输入规整
ok(normalizeCodeInput('abc') === 'abc' && normalizeCodeInput('aBc') === 'aBc', '输入保留大小写')
ok(normalizeCodeInput('1') === 'One' && normalizeCodeInput('/') === 'Slash', '单个数字/符号转名字')
ok(normalizeCodeInput('a1') === 'a' && normalizeCodeInput('=') === '', '其余只留字母')

// 5) 解析：小写代号 + 数字/符号名
const HEAD = `[Metadata]
Title = codes

[Files]
path = ""
audio = ""

[Define]
hitsound custom abc = default.soft-hitnormal
hitsound custom ABc = default.soft-hitclap
hitsound custom One = default.soft-hitwhistle
hitsound custom Slash = default.soft-hitfinish
hitsound custom Aa = default.drum-hitnormal

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
`
const doc = parseChart(HEAD + '/abc ABc One Slash Aa = =\n')
const errs = doc.diagnostics.filter((d) => d.severity === 'error')
ok(errs.length === 0, '小写/数字/符号代号解析无错误', errs.map((d) => d.message).join(' | '))
ok(
  doc.events.length >= 5 &&
    doc.events
      .slice(0, 5)
      .map((e) => e.names.join(' '))
      .join(' ') === 'abc ABc One Slash Aa',
  '五个代号按空格分开读成五个音',
  doc.events
    .slice(0, 5)
    .map((e) => e.names.join(' '))
    .join(' '),
)

// 6) 连写不再拆开：AaAa 是一个（未定义的）代号，并提示加空格
const joined = parseChart(HEAD + '/AaAa = =\n')
const ev = joined.events[0]?.names.join(' ') || ''
ok(ev === 'AaAa', 'AaAa 被当成一个代号', ev)
const warn = joined.diagnostics.find((d) => d.code === 'hs-undefined')
ok(!!warn && /Aa Aa/.test(warn.message), '未定义提示里给出空格写法', warn?.message)

// 7) 写回：数字/符号代号写进正文用名字
{
  const d = parseChart(HEAD + '/= = = = = = = = = = = = = = = =/\n')
  const r = applyCellEdit(d, 0, 5, 4, ['One'])
  const line = (r.text || '').split('\n').find((l) => l.startsWith('/')) || ''
  ok(r.ok && line.split(/[\/ ]+/).filter(Boolean)[5] === 'One', '写入 One 时正文写名字（不是 1）', line)
  const d2 = parseChart(r.text!)
  const cell = d2.events.find((e) => Math.abs(e.time - 625) < 2)
  ok(!!cell && cell.names.includes('One'), '回读仍是 One（网格会显示成 1）', cell?.names.join(' '))
}

// 8) 改代号：One → SlashX（字母名同样能全改正文）
{
  const renamed = editHitsoundDefineText(HEAD + '/One = One One = =\n', 'One', { name: 'SlashX' })
  ok(renamed.ok && renamed.changes === 3, '改名同步正文 3 处', String(renamed.changes))
  ok(!!renamed.text && !/One/.test(renamed.text), '旧代号全部消失')
}

console.log(bad ? `\n${bad} FAILED` : '\n全部通过')
process.exit(bad ? 1 : 0)
