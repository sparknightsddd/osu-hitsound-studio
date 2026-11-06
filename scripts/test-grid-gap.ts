/**
 * 格子视图写「两段之间的空洞」单测。
 *
 * 场景：谱面里两段之间空了很多小节，正文里这些小节的行的确不存在。
 * 之前会被误判成「和别的小节写在同一行」而拒绝写入。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdits, readMeasureCells } from '../src/core/gridEdit'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const HEAD = `[Metadata]
Title = gap

[Files]
path = ""
audio = ""

[Define]
hitsound custom Aa = default.soft-hitnormal red
hitsound custom Ab = default.soft-hitclap green

[Timing]
0,bpm(120),4,0,0

[Hitsound]
`

/** 小节 = 2000ms（120 BPM / 4 拍），div=4 时一格 125ms */
const GAP = HEAD + '#0\n/Aa = = =/\n#16000\n/Aa = = =/\n'

// 1) 两段之间的空洞：能不能写进去
{
  const d = parseChart(GAP)
  ok(d.usedMeasures === 9, `正文用到第 9 小节：${d.usedMeasures}`)
  ok(d.measures[3].body === undefined, '第 4 小节（0 起 3）在正文里没有行')

  const r = applyCellEdits(d, [{ mi: 3, k: 1, next: ['Ab'] }], 4)
  ok(r.ok, `中间空洞可以写入：${r.reason ?? 'ok'}`)
  if (r.ok) {
    const d2 = parseChart(r.text!)
    const hit = d2.events.filter((e) => e.measure === 4 && Math.abs(e.time - 6125) < 2)
    ok(hit.length === 1 && hit[0].names.includes('Ab'), `第 4 小节 6125ms 有 Ab：${JSON.stringify(hit[0]?.names)}`)
    // 前后两段还在原位
    ok(d2.events.some((e) => e.measure === 1 && Math.abs(e.time - 0) < 2), '第 1 小节内容没动')
    ok(d2.events.some((e) => e.measure === 9 && Math.abs(e.time - 16000) < 2), '第 9 小节内容没动')
    const lines = r.text!.split('\n').filter((l) => l.trim().startsWith('/'))
    ok(lines.length === 3, `正文变成 3 行：${lines.length}`)
  }
}

// 2) 一次拖选多个空小节（同一段空洞）
{
  const d = parseChart(GAP)
  const r = applyCellEdits(
    d,
    [
      { mi: 2, k: 0, next: ['Ab'] },
      { mi: 3, k: 0, next: ['Ab'] },
      { mi: 5, k: 4, next: ['Ab'] },
    ],
    4,
  )
  ok(r.ok, `多个空洞小节一次写入：${r.reason ?? 'ok'}`)
  if (r.ok) {
    const d2 = parseChart(r.text!)
    for (const [mi, t] of [
      [2, 4000],
      [3, 6000],
      [5, 10500],
    ] as const) {
      const hit = d2.events.filter((e) => e.measure === mi + 1 && Math.abs(e.time - t) < 2)
      ok(hit.length === 1 && hit[0].names.includes('Ab'), `第 ${mi + 1} 小节 ${t}ms 写入成功`)
    }
    ok(d2.events.some((e) => e.measure === 9 && Math.abs(e.time - 16000) < 2), '后面那段仍在第 9 小节')
    // 单独写出的行数 = 原有 2 行 + 补的 3 行
    ok(r.text!.split('\n').filter((l) => l.trim().startsWith('/')).length === 5, '补了 3 行')
  }
}

// 3) 谱面开头的空洞（[Hitsound] 后面第一行就是 #4000）
{
  const src = HEAD + '#4000\n/Aa = = =/\n'
  const d = parseChart(src)
  const r = applyCellEdits(d, [{ mi: 1, k: 2, next: ['Ab'] }], 4)
  ok(r.ok, `开头空洞可以写入：${r.reason ?? 'ok'}`)
  if (r.ok) {
    const d2 = parseChart(r.text!)
    ok(d2.events.some((e) => e.measure === 2 && Math.abs(e.time - 2250) < 2), '第 2 小节 2250ms 写入成功')
    ok(d2.events.some((e) => e.measure === 3 && Math.abs(e.time - 4000) < 2), '原有内容仍在第 3 小节')
  }
}

// 4) 谱面末尾的空小节（原有行为不能坏）
{
  const src = HEAD + '#0\n/Aa = = =/\n'
  const d = parseChart(src)
  const r = applyCellEdits(d, [{ mi: 6, k: 0, next: ['Ab'] }], 4)
  ok(r.ok, `末尾空小节可以写入：${r.reason ?? 'ok'}`)
  if (r.ok) {
    const d2 = parseChart(r.text!)
    ok(d2.events.some((e) => e.measure === 7 && Math.abs(e.time - 12000) < 2), '第 7 小节 12000ms 写入成功')
  }
}

// 5) 被跨度覆盖的小节仍然拒绝（不能乱插行）
{
  const src = HEAD + '#0\n/Aa/\n/3/\n/Ab/\n'
  const d = parseChart(src)
  ok(d.measures[1].coveredBy !== undefined, '第 2 小节被跨度覆盖')
  const r = applyCellEdits(d, [{ mi: 1, k: 0, next: ['Ab'] }], 4)
  ok(!r.ok, `跨度小节拒绝写入：${r.reason}`)
}

// 6) 空小节写入沿用前面的音量（不该突然变 100）
{
  const src = HEAD + '#0\n/<v=42> Aa = = =/\n#16000\n/Aa = = =/\n'
  const d = parseChart(src)
  const r = applyCellEdits(d, [{ mi: 4, k: 0, next: ['Ab'] }], 4)
  ok(r.ok, `写入成功：${r.reason ?? 'ok'}`)
  if (r.ok) {
    const d2 = parseChart(r.text!)
    const e = d2.events.find((x) => x.measure === 5 && Math.abs(x.time - 8000) < 2)
    ok(!!e && e.volume === 42, `沿用前面的音量 42：${e?.volume}`)
  }
}

// 7) 读格子：空洞小节也要能复制
{
  const d = parseChart(GAP)
  const got = readMeasureCells(d, 4, 4)
  ok(got.ok && got.cells.length === 16, `空洞小节读出 16 格：${got.ok ? got.cells.length : got.reason}`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
