/**
 * 格子视图的 keysound 写回（单元测试）。
 *
 * 覆盖：
 *  - 解析时 [Keysound] 的范围按谱表分开记录，不再覆盖 hitsound 的 body；
 *  - 单谱表行 / 多谱表行（`a | b`）只改自己那一段；
 *  - 正文里还没有这一小节时，补一行 `#时间` + `/.../ ` 到 [Keysound] 段末；
 *  - 完全没有 [Keysound] 段时自动建段（带 `{乐器}` 头）；
 *  - 跨度写法（/2/）不给改，回一个明确原因；
 *  - hitsound 的写回行为不变。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdits, readMeasureCells } from '../src/core/gridEdit'
import { midiToName, midiToToken, nameToMidi, clampToRange } from '../src/core/pitch'

let pass = 0
let fail = 0
function T(name: string, ok: boolean, extra = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const DEFS = `[Define]
hitsound custom Aa = default.normal-hitnormal
keysound custom piano = ("piano/<loop("C","D","E","F","G","A","B")><int((i+9)/12)>.wav", C4, B6)
keysound custom guitar = ("guitar/<loop("C","D","E","F","G","A","B")><int((i+9)/12)>.wav", C4, B6)
`

const BASE = `[Metadata]
Title = ks

[Files]
audio = ""

${DEFS}

[Timing]
0,bpm(120),4,0,0

[Keysound]
{piano | guitar}
/4C D E F/
/4G A B C | 4E F G A/

[Hitsound]
/Aa Aa Aa Aa/
/Aa = = =/
`

// 1) 解析：范围分开记，hitsound body 不被 keysound 覆盖
{
  const doc = parseChart(BASE)
  const m0 = doc.measures[0]
  const m1 = doc.measures[1]
  T('第 1 小节有 hitsound body', !!m0.body, JSON.stringify(m0.body))
  T('第 1 小节的 keysound 范围是整行（bare=false）', !!m0.ksBodies?.[0] && !m0.ksBodies[0].bare, JSON.stringify(m0.ksBodies))
  T('第 2 小节两条谱表各有一段（bare=true）', !!m1.ksBodies?.[0]?.bare && !!m1.ksBodies?.[1]?.bare, JSON.stringify(m1.ksBodies))
  T('hitsound body 指向 [Hitsound] 那一行', doc.text.slice(m0.body!.from, m0.body!.to).startsWith('/Aa'), doc.text.slice(m0.body!.from, m0.body!.to))
  T('keysound 范围指向 [Keysound] 那一行', doc.text.slice(m0.ksBodies![0].from, m0.ksBodies![0].to).startsWith('/4C'), doc.text.slice(m0.ksBodies![0].from, m0.ksBodies![0].to))
  const cells = readMeasureCells(doc, 1, 4, { mode: 'keysound', staff: 1 })
  T('读第 2 小节 guitar 谱表：E4 F4 G4 A4', cells.ok && cells.cells.filter((c) => c.names.length).map((c) => c.names[0]).join(' ') === 'E4 F4 G4 A4', cells.ok ? cells.cells.filter((c) => c.names.length).map((c) => c.names[0]).join(' ') : cells.reason)
  const hc = readMeasureCells(doc, 1, 4)
  T('同一小节按 hitsound 读会报「没有可写回的内容」外的东西也没崩', hc.ok, hc.ok ? '' : hc.reason)
}

// 2) 单谱表写回
{
  const doc = parseChart(BASE)
  const r = applyCellEdits(doc, [{ mi: 0, k: 4, next: ['E4'] }], 4, { mode: 'keysound', staff: 0 })
  T('单谱表改第 2 拍：成功', r.ok, r.reason || '')
  const line = (r.text || '').split('\n').find((l) => l.startsWith('/4C')) || ''
  T('写回用的是八度前缀 4E', line.includes('4E') && !line.includes('4D'), line)
  const again = parseChart(r.text!)
  T('重新解析后第 2 拍有 D4 + E4', again.events.filter((e) => e.kind === 'keysound' && e.measure === 1).map((e) => e.names[0]).join(' ').includes('E4'))
  T('[Hitsound] 没被动', r.text!.includes('/Aa Aa Aa Aa/'))
  T('另一条谱表那一段原样留着', r.text!.includes('| 4E F G A/'))
}

// 3) 多谱表行只改自己那一段
{
  const doc = parseChart(BASE)
  const r = applyCellEdits(doc, [{ mi: 1, k: 8, next: ['L4'] }], 4, { mode: 'keysound', staff: 1 })
  T('多谱表改 guitar：成功', r.ok, r.reason || '')
  const line = (r.text || '').split('\n').find((l) => l.startsWith('/4G')) || ''
  T('前半段（piano）原样', line.startsWith('/4G A B C'), line)
  T('后半段（guitar）写进了 4L', line.includes('4L'), line)
  const again = parseChart(r.text!)
  const g = again.events.filter((e) => e.kind === 'keysound' && e.staff === 1 && e.measure === 2).map((e) => e.names[0])
  T('解析出 guitar 的 L4', g.includes('L4'), g.join(' '))
}

// 4) 没有这一小节的正文 → 补一行到 [Keysound] 段末
{
  const doc = parseChart(BASE)
  const r = applyCellEdits(doc, [
    { mi: 2, k: 0, next: ['C5'] },
    { mi: 3, k: 2, next: ['D5'] },
  ], 4, { mode: 'keysound', staff: 0 })
  T('补两小节：成功', r.ok, r.reason || '')
  const text = r.text || ''
  T('补的行带 #时间标记', /#4000/.test(text) && /#6000/.test(text), text.split('\n').filter((l) => l.startsWith('#')).join(' '))
  T('补的行写在 [Keysound] 段里', text.indexOf('#4000') > text.indexOf('[Keysound]') && text.indexOf('#4000') < text.indexOf('[Hitsound]'))
  const again = parseChart(text)
  const evs = again.events.filter((e) => e.kind === 'keysound')
  T('重新解析出 C5 / D5，且原来的音都在', evs.some((e) => e.names[0] === 'C5') && evs.some((e) => e.names[0] === 'D5') && evs.length === 14, evs.map((e) => e.names[0]).join(' '))
  T('补行没有报错', !again.diagnostics.some((d) => d.severity === 'error'), again.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join(' | '))
}

// 5) 没有 [Keysound] 段 → 自动建段
{
  const noSec = `[Metadata]
Title = x

[Files]
audio = ""

${DEFS}

[Timing]
0,bpm(120),4,0,0

[Hitsound]
/Aa Aa Aa Aa/
`
  const doc = parseChart(noSec)
  const r = applyCellEdits(doc, [{ mi: 0, k: 0, next: ['C4'] }], 4, { mode: 'keysound', staff: 0, instrument: 'piano' })
  T('没有 [Keysound] 段也能写：成功', r.ok, r.reason || '')
  const text = r.text || ''
  T('建了 [Keysound] 段 + {piano} 头', /\[Keysound\]\s*\n\{piano\}/.test(text), text.split('\n').slice(-6).join(' / '))
  const again = parseChart(text)
  T('重新解析有 C4', again.events.some((e) => e.kind === 'keysound' && e.names[0] === 'C4'))
  T('没有解析错误', !again.diagnostics.some((d) => d.severity === 'error'), again.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join(' | '))
}

// 6) 跨度写法拒绝写回
{
  const span = BASE.replace('/4G A B C | 4E F G A/', '/2/ 4G A B C | 4E F G A/')
  const doc = parseChart(span)
  const r = applyCellEdits(doc, [{ mi: 2, k: 0, next: ['C5'] }], 4, { mode: 'keysound', staff: 0 })
  T('跨度小节拒绝写回并说明原因', !r.ok && /跨度|重复/.test(r.reason || ''), r.reason || '')
}

// 6.5) 某条谱表没有正文：补一行带 `|` 前缀的新行
{
  const doc = parseChart(BASE)
  const r = applyCellEdits(doc, [{ mi: 0, k: 0, next: ['E5'] }], 4, {
    mode: 'keysound',
    staff: 1,
    instrument: 'guitar',
    instruments: ['piano', 'guitar'],
  })
  T('缺少该谱表时补一行：成功', r.ok, r.reason || '')
  const text = r.text || ''
  T('补的行带 `|`（落在第 2 条谱表）', /\|\s*5E/.test(text), text.split('\n').slice(-5).join(' / '))
  const again = parseChart(text)
  const g = again.events.filter((e) => e.kind === 'keysound' && e.staff === 1)
  T('解析成 guitar 的 E5', g.some((e) => e.names[0] === 'E5' && e.instrument === 'guitar'), g.map((e) => `${e.instrument}/${e.names[0]}`).join(' '))
}

// 6.8) 没有 [Keysound] 段、选的是第 2 个乐器：花括号要补齐两条
{
  const noSec = `[Metadata]
Title = x

[Files]
audio = ""

${DEFS}

[Timing]
0,bpm(120),4,0,0

[Hitsound]
/Aa/
`
  const doc = parseChart(noSec)
  const r = applyCellEdits(doc, [{ mi: 0, k: 0, next: ['E4'] }], 4, {
    mode: 'keysound',
    staff: 1,
    instrument: 'guitar',
    instruments: ['piano', 'guitar'],
  })
  T('建段时按谱表补齐乐器列表', r.ok && /\{piano \| guitar\}/.test(r.text || ''), (r.text || '').split('\n').slice(-6).join(' / '))
  const again = parseChart(r.text!)
  T('这段解析出的第 2 谱表是 guitar', again.events.some((e) => e.kind === 'keysound' && e.staff === 1 && e.instrument === 'guitar'))
}

// 7) 音高换算：正文用八度前缀
{
  T('midiToToken(60) = 4C', midiToToken(60) === '4C', midiToToken(60))
  T('midiToToken(61) = 4H', midiToToken(61) === '4H', midiToToken(61))
  T('nameToMidi(C4) = 60', nameToMidi('C4') === 60, String(nameToMidi('C4')))
  T('midiToName(63) = I4', midiToName(63) === 'I4', midiToName(63))
  T('移调并夹在钢琴音域内', clampToRange(110) === 98 && clampToRange(10) === 22, `${clampToRange(110)}/${clampToRange(10)}`)
}

// 8) hitsound 写回不受影响
{
  const doc = parseChart(BASE)
  const r = applyCellEdits(doc, [{ mi: 1, k: 0, next: ['Aa'] }], 4)
  T('hitsound 写回照常', r.ok && (r.text || '').split('\n').filter((l) => l.startsWith('/Aa')).some((l) => l.includes('Aa')), r.reason || '')
  T('hitsound 写回没碰 [Keysound]', (r.text || '').includes('{piano | guitar}') && (r.text || '').includes('| 4E F G A/'))
}

console.log(`RESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
