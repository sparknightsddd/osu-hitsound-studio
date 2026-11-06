/**
 * 「音量条偏移 1 格」回归：小节里有 `[A B]` 叠音格时，`<v>` 换算出的格子序号不能漂。
 *
 * 老实现用 `split(/\s+/)` 切正文，`[Ab Ac]` 会被当成两个 token，
 * 于是它**后面**的 `<v>` 全部左移一格 —— 正是用户看到的「条子跑到上一格」。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdits, measureVolumeMarks, volumeSpanFrom } from '../src/core/gridEdit'

const head = `[Metadata]
Title = vbar shift

[Files]
path = ""
audio = ""

[Define]
hitsound soft-hitclap Aa = default.soft-hitclap
hitsound soft-hitnormal Ab = default.soft-hitnormal
hitsound soft-hitwhistle Ac = default.soft-hitwhistle

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
`
const body = (line: string) => `${head}${line}\n`
let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

/** 在一小节里改第 k 格的音量，返回换算回来的标记位置 */
function markAfter(mi: number, k: number, line: string, vol = 50) {
  const doc = parseChart(body(line))
  const res = applyCellEdits(doc, [{ mi, k, next: (c) => c, volume: vol, volumeForce: true }], 4)
  if (!res.ok) return { ok: false as const, reason: res.reason }
  const d2 = parseChart(res.text!)
  return { ok: true as const, marks: measureVolumeMarks(d2, mi, 4), text: res.text! }
}

// 1) 叠音格在标记**后面**（老实现就是这里左移一格）
for (const k of [4, 8, 12, 5, 15]) {
  const r = markAfter(0, k, '/Aa = [Ab Ac] =/')
  if (!r.ok) {
    T(`叠音格在后：第 ${k} 格`, false, r.reason || '')
    continue
  }
  T(`叠音格在后：第 ${k} 格`, r.marks.get(k) === 50, `marks=${[...r.marks.entries()].join(' ')}`)
}

// 2) 叠音格在标记前面
for (const k of [0, 4, 8]) {
  const r = markAfter(0, k, '/[Ab Ac] Aa = =/')
  if (!r.ok) {
    T(`叠音格在前：第 ${k} 格`, false, r.reason || '')
    continue
  }
  T(`叠音格在前：第 ${k} 格`, r.marks.get(k) === 50, `marks=${[...r.marks.entries()].join(' ')}`)
}

// 3) 多个叠音格 + 竖线分隔
{
  const r = markAfter(0, 12, '/[Aa Ab] = | [Ab Ac] =/')
  if (!r.ok) T('两个叠音格 + 竖线：第 12 格', false, r.reason || '')
  else T('两个叠音格 + 竖线：第 12 格', r.marks.get(12) === 50, `marks=${[...r.marks.entries()].join(' ')}`)
}

// 4) 连续改三格，位置都要稳
{
  let doc = parseChart(body('/Aa = [Ab Ac] =/'))
  const ks = [2, 7, 13]
  for (const [i, k] of ks.entries()) {
    const res = applyCellEdits(doc, [{ mi: 0, k, next: (c) => c, volume: 20 + i * 10, volumeForce: true }], 4)
    if (!res.ok) break
    doc = parseChart(res.text!)
  }
  const marks = measureVolumeMarks(doc, 0, 4)
  const ok = ks.every((k, i) => marks.get(k) === 20 + i * 10)
  T('连续改三格都在原位', ok, `marks=${[...marks.entries()].join(' ')}`)
  console.log('  line:', doc.text.split('[Hitsound]')[1].split('\n').filter((l) => l.trim()).join(' | '))
}

// 5) 手写 `<volume=50>` 也要认
{
  const doc = parseChart(body('/Aa = <volume=40> = =/'))
  const marks = measureVolumeMarks(doc, 0, 4)
  T('认 <volume=40> 写法', marks.get(8) === 40, `marks=${[...marks.entries()].join(' ')}`)
}

// 6) 「单选改音量」的作用范围也基于同一套标记
{
  const doc = parseChart(body('/Aa = [Ab Ac] <v=30> =/'))
  const span = volumeSpanFrom(doc, 0, 0, 4)
  T('volumeSpanFrom 停在下一条 <v> 之前', span.length === 12 && span[11] === 11, `len=${span.length}`)
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
