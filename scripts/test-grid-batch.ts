/**
 * 格子批量编辑 / 撤销 / 剪贴板数据 单测（不启动 Electron）。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdits, readMeasureCells } from '../src/core/gridEdit'
import { canRedo, canUndo, recordEdit, redoEdit, undoEdit, clearHistory } from '../src/core/gridHistory'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const HEAD = `[Metadata]
Title = batch

[Files]
path = ""
audio = ""

[Define]
hitsound custom Aa = default.soft-hitnormal red
hitsound custom Ab = default.soft-hitclap green

[Timing]
0,bpm(120),4,0,0
4000,bpm(120),4,0,0

[Hitsound]
#0
`
const M = '/Aa = = = Ab = = = Aa = = = Ab = = =/'
const doc = parseChart(HEAD + M + '\n' + M + '\n')

// 1) 跨小节批量：两行一起改，只产生一份文本
{
  const r = applyCellEdits(
    doc,
    [
      { mi: 0, k: 0, next: (cur) => [...cur, 'Ab'] },
      { mi: 0, k: 5, next: [] },
      { mi: 1, k: 2, next: ['Ab'] },
      { mi: 1, k: 2, next: (cur) => [...cur, 'Aa'] },
    ],
    4,
  )
  ok(r.ok, '批量写回成功')
  const lines = (r.text || '').split('\n').filter((l) => l.startsWith('/'))
  ok(lines.length === 2, `只有两行正文：${lines.length}`)
  ok(/\[\s*Aa Ab\s*\]/.test(lines[0] || ''), `第一小节第 1 格变 [Aa Ab]：${lines[0]}`)
  const d2 = parseChart(r.text || '')
  ok(
    !d2.events.some((x) => x.measure === 1 && Math.abs(x.time - 625) < 2),
    '第一小节第 6 格已清空',
  )
  const at = d2.events.filter((x) => x.measure === 2 && Math.abs(x.time - 2250) < 2)
  ok(at.length === 2, `第二小节第 3 格有两个音（同刻两条）：${at.map((x) => x.names.join('+')).join(' ')}`)
}

// 2) 读格子：音量 / 编号
{
  const t = HEAD + '/<v=60> <i=2> Aa = = = Ab = = = Aa = = = Ab = = =/\n'
  const d = parseChart(t)
  const got = readMeasureCells(d, 0, 4)
  ok(got.ok, '读小节成功')
  if (got.ok) {
    ok(got.cells[0].volume === 60 && got.cells[0].index === 2, `第 1 格 v/i：${JSON.stringify(got.cells[0])}`)
    ok(got.cells[1].names.length === 0 && got.cells[1].volume === 100, '空格读出默认音量 100（复制用）')
  }
}

// 3) 粘贴：连音量一起写
{
  const src = parseChart(HEAD + '/<v=42> Aa = = = Ab = = = Aa = = = Ab = = =/\n' + M + '\n')
  const got = readMeasureCells(src, 0, 4)
  const clip = got.ok ? got.cells.slice(0, 4) : []
  const r = applyCellEdits(
    src,
    clip.map((c, i) => ({ mi: 1, k: i, next: c.names, volume: c.volume, index: c.index })),
    4,
  )
  ok(r.ok, '粘贴写回成功')
  const d2 = parseChart(r.text || '')
  const e = d2.events.find((x) => x.measure === 2 && Math.abs(x.time - 2000) < 2)
  ok(!!e && e.volume === 42, `粘贴保留音量：${e?.volume}`)
}

// 4) 撤销 / 重做：文本被别处改过就作废
{
  clearHistory()
  const before = doc.text
  const r = applyCellEditText(doc, 0, 0, ['Aa', 'Ab'])
  recordEdit('f1', before, r)
  ok(canUndo('f1', r), '刚改完可以撤销')
  const back = undoEdit('f1', r)
  ok(back === before, '撤销回到改前')
  ok(canRedo('f1', before), '撤销后可以重做')
  const again = redoEdit('f1', before)
  ok(again === r, '重做回到改后')

  clearHistory()
  recordEdit('f1', before, r)
  ok(!canUndo('f1', r + '\n// 手工改过'), '文本被别处改过 → 不可撤销')
  ok(undoEdit('f1', r + '\n// 手工改过') === null, '撤销返回 null')
  ok(!canUndo('f1', r + '\n// 手工改过'), '历史已作废')
}

function applyCellEditText(d: ReturnType<typeof parseChart>, mi: number, k: number, next: string[]) {
  const res = applyCellEdits(d, [{ mi, k, next }], 4)
  if (!res.ok) throw new Error(res.reason)
  return res.text!
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
