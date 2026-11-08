/**
 * [Define] 编辑 + 槽位识别 的单元测试：
 *   - 改代号：定义行和 [Hitsound] 正文一起换，别的代号不误伤，[Keysound] 不碰；
 *   - 改槽位：只换槽位 token，值 / 颜色 / 行尾原样保留；
 *   - 校验：重名、非法代号、找不到；
 *   - slotFromFileName：`soft-hitnormal.wav` / `default.normal-hitclap` 认得出，`hitclap.wav` 不认。
 */
import { parseChart } from '../src/core/parse'
import { editHitsoundDefineText } from '../src/core/defineEdit'
import { slotFromFileName } from '../src/core/soundSlots'

let pass = 0
let fail = 0
const T = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const BASE = `[Metadata]
Title = edit test

[Files]
audio = ""

[Define]
hitsound soft-hitnormal|normal-hitnormal Aa = "a.wav" #FF8800
hitsound custom Bb = "b.wav"
keysound custom Kk = ("k/<int(4)>.wav", C4, B4)
@Fill = /Aa Aa/

[Timing]
0,bpm(120),4,0,0

[Keysound]
{Kk}
/4C 4D/

[Hitsound]
/Aa [Aa Bb] Aa<v=80>/
/Aab Aa/
/@Fill Aab Aa/
`

const bodyOf = (text: string, sec: string) => {
  const lines = text.split('\n')
  const a = lines.findIndex((l) => l.trim().toLowerCase() === `[${sec.toLowerCase()}]`)
  if (a < 0) return ''
  const b = lines.findIndex((l, i) => i > a && /^\s*\[[A-Za-z]/.test(l))
  return lines.slice(a + 1, b < 0 ? undefined : b).join('\n')
}
const defLine = (text: string, code: string) =>
  text.split('\n').find((l) => new RegExp(`^hitsound\\s+\\S+\\s+${code}\\s*=`).test(l)) || ''

// 1) 改名 Aa -> Zz
{
  const r = editHitsoundDefineText(BASE, 'Aa', { name: 'Zz' })
  T('改名成功', r.ok, r.error || '')
  const text = r.text || ''
  T('定义行改成了 Zz', /^hitsound soft-hitnormal\|normal-hitnormal Zz = "a\.wav" #FF8800$/.test(defLine(text, 'Zz')), defLine(text, 'Zz'))
  T('旧代号的定义行消失', defLine(text, 'Aa') === '')
  const body = bodyOf(text, 'Hitsound')
  T('正文 + 乐句 7 处引用全部改名', r.changes === 7, String(r.changes))
  T('和弦里的代号也改了', body.includes('[Zz Bb]'), body.split('\n')[1])
  T('带音量的 token 也改了', body.includes('Zz<v=80>'), body.split('\n')[1])
  T('Aa 不再出现在正文里', !/\bAa\b/.test(body), body)
  T('Aab 没被误伤', body.includes('Aab'), body.split('\n')[2])
  T('[Keysound] 一个字都没动', bodyOf(text, 'Keysound') === bodyOf(BASE, 'Keysound'), bodyOf(text, 'Keysound'))
  T('乐句 body 里的代号也改了', text.includes('@Fill = /Zz Zz/'), text.split('\n').find((l) => l.startsWith('@Fill')) || '')
  T('@Fill 这种乐句引用没被改名', body.includes('@Fill'), body.split('\n')[3])
  T('颜色原样保留', defLine(text, 'Zz').endsWith('#FF8800'), defLine(text, 'Zz'))
  // 改完还能解析回同样的内容
  const again = parseChart(text)
  T('改完解析没有错误', again.diagnostics.filter((d) => d.severity === 'error').length === 0, again.diagnostics.map((d) => d.message).join(' | '))
  T('解析出的定义名是 Zz', again.hitsounds.some((h) => h.name === 'Zz' && h.kind === 'hitsound'))
}

// 2) 只改槽位（代号不动）
{
  const r = editHitsoundDefineText(BASE, 'Aa', { slots: ['drum-hitclap'] })
  T('只改槽位成功', r.ok, r.error || '')
  const text = r.text || ''
  T('槽位换成 drum-hitclap', /^hitsound drum-hitclap Aa = "a\.wav" #FF8800$/.test(defLine(text, 'Aa')), defLine(text, 'Aa'))
  T('正文一处都没改', r.changes === 0 && bodyOf(text, 'Hitsound') === bodyOf(BASE, 'Hitsound'))
  const again = parseChart(text)
  T('解析出单个槽位', again.hitsounds.find((h) => h.name === 'Aa')?.alts.filter((a) => !a.custom).length === 1)
}

// 3) 槽位清空 -> custom
{
  const r = editHitsoundDefineText(BASE, 'Aa', { slots: [] })
  T('不勾槽位写成 custom', /^hitsound custom Aa = /.test(defLine(r.text || '', 'Aa')), defLine(r.text || '', 'Aa'))
  T('解析成 custom', parseChart(r.text || '').hitsounds.find((h) => h.name === 'Aa')?.alts.some((a) => a.custom) === true)
}

// 4) 代号和槽位一起改
{
  const r = editHitsoundDefineText(BASE, 'Bb', { name: 'Cc', slots: ['soft-hitfinish', 'drum-hitfinish'] })
  const text = r.text || ''
  T('同时改代号与槽位', r.ok && /^hitsound soft-hitfinish\|drum-hitfinish Cc = "b\.wav"$/.test(defLine(text, 'Cc')), defLine(text, 'Cc'))
  T('Bb 的正文引用同步（1 处）', r.changes === 1 && bodyOf(text, 'Hitsound').includes('[Aa Cc]'), String(r.changes))
}

// 5) 校验
{
  const dup = editHitsoundDefineText(BASE, 'Aa', { name: 'Bb' })
  T('重名被拦下', !dup.ok && dup.error === 'dup', JSON.stringify(dup))
  const bad = editHitsoundDefineText(BASE, 'Aa', { name: 'a1' })
  T('非法代号被拦下', !bad.ok && bad.error === 'badName', JSON.stringify(bad))
  const lower = editHitsoundDefineText(BASE, 'Aa', { name: 'aa' })
  T(
    '小写开头的代号合法，正文同步换掉',
    lower.ok && !!lower.text && lower.text.includes('hitsound soft-hitnormal|normal-hitnormal aa') && lower.text.includes('/aa [aa Bb]'),
    JSON.stringify(lower),
  )
  const miss = editHitsoundDefineText(BASE, 'Qq', { name: 'Rr' })
  T('找不到代号', !miss.ok && miss.error === 'notFound', JSON.stringify(miss))
  const noop = editHitsoundDefineText(BASE, 'Aa', { name: 'Aa', slots: ['soft-hitnormal', 'normal-hitnormal'] })
  T('没改动时原样返回', noop.ok && noop.text === BASE && noop.changes === 0)
}

// 6) 键音定义不归这里管
{
  const r = editHitsoundDefineText(BASE, 'Kk', { name: 'Ll' })
  T('keysound 定义不会被当成 hitsound 改', !r.ok && r.error === 'notFound')
}

// 6.5) 颜色：改 / 加 / 删，注释不能被吃掉
{
  const green = editHitsoundDefineText(BASE, 'Aa', { color: '#00ff00' })
  T('换颜色', green.ok && defLine(green.text || '', 'Aa') === 'hitsound soft-hitnormal|normal-hitnormal Aa = "a.wav" #00FF00', defLine(green.text || '', 'Aa'))
  T('只改颜色不动正文', green.changes === 0)

  const named = editHitsoundDefineText(BASE, 'Bb', { color: 'blue' })
  T('英文颜色名归一成 hex', /#0000FF$/.test(defLine(named.text || '', 'Bb')), defLine(named.text || '', 'Bb'))

  const removed = editHitsoundDefineText(BASE, 'Aa', { color: null })
  T('颜色可以删掉（回到默认色）', defLine(removed.text || '', 'Aa') === 'hitsound soft-hitnormal|normal-hitnormal Aa = "a.wav"', defLine(removed.text || '', 'Aa'))
  T('删颜色后能重新解析（没有颜色）', parseChart(removed.text || '').hitsounds.find((h) => h.name === 'Aa')?.color === undefined)

  const bad = editHitsoundDefineText(BASE, 'Aa', { color: 'notacolor' })
  T('颜色认不出来时被拦下', !bad.ok && bad.error === 'badColor', JSON.stringify(bad))

  const commented = BASE.replace('hitsound custom Bb = "b.wav"', 'hitsound custom Bb = "b.wav" ## 备选')
  const withC = editHitsoundDefineText(commented, 'Bb', { color: '#112233' })
  T('加颜色时保留行尾注释', defLine(withC.text || '', 'Bb') === 'hitsound custom Bb = "b.wav" #112233 ## 备选', defLine(withC.text || '', 'Bb'))
  const stillC = editHitsoundDefineText(withC.text || '', 'Bb', { color: null })
  T('删颜色也保留注释', defLine(stillC.text || '', 'Bb') === 'hitsound custom Bb = "b.wav" ## 备选', defLine(stillC.text || '', 'Bb'))

  const combo = editHitsoundDefineText(BASE, 'Aa', { name: 'Zz', color: '#123456' })
  T('改名 + 换颜色一起生效', /^hitsound soft-hitnormal\|normal-hitnormal Zz = "a\.wav" #123456$/.test(defLine(combo.text || '', 'Zz')) && combo.changes === 7, defLine(combo.text || '', 'Zz'))
}

// 7) 文件名 / 引用名 -> 槽位
{
  T('soft-hitnormal.wav', slotFromFileName('soft-hitnormal.wav') === 'soft-hitnormal')
  T('大写扩展名也行', slotFromFileName('DRUM-HITCLAP.OGG') === 'drum-hitclap')
  T('default.normal-hitclap', slotFromFileName('default.normal-hitclap') === 'normal-hitclap')
  T('带目录的 default.*.wav', slotFromFileName('D:/songs/x/default.soft-hitwhistle.wav') === 'soft-hitwhistle')
  T('hitclap.wav 没有采样组，不认', slotFromFileName('hitclap.wav') === null)
  T('普通文件名不认', slotFromFileName('kick_01.wav') === null)
  T('default.blank 不是槽位', slotFromFileName('default.blank') === null)
}

console.log(`RESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
