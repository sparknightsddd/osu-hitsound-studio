/**
 * 小节网格：红线落在小节自然结束点附近时的处理。
 *
 * 用户报的谱面（01:47.884 / 01:49.609）里同时踩到了三种情况：
 *   1) 红线比自然结束点早 10ms → 小节被截成 3.976 拍，格子原来按整拍排，
 *      点最后一格写出来的音符会掉回前一格、整个小节还会「音符不在格子上」拒绝编辑；
 *   2) 红线比自然结束点晚 10ms → 切出一个 10.7ms 的碎片小节，被画成一整拍（多 3 格）；
 *   3) 同 BPM 的继承型 Timing 落在小节中间 → 不拆段；
 *   4) 真变速 + 红线提前截断 → token 仍精确落在拍点，不能整体提前一格。
 */
import { parseChart } from '../src/core/parse'
import { measureBeatLayout, measureTicks } from '../src/core/measures'
import { applyCellEdits, readMeasureCells } from '../src/core/gridEdit'

let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

const head = (timing: string[], body: string[]) =>
  [
    '[Metadata]',
    'Title = snap',
    '',
    '[Files]',
    'path = ""',
    'audio = ""',
    '',
    '[Define]',
    'hitsound soft-hitclap Aa = default.soft-hitclap',
    '',
    '[Timing]',
    ...timing,
    '',
    '[Hitsound]',
    ...body,
    '',
  ].join('\n')

const BL = 428.571429
const fmt = (t: number) => (t / 1000).toFixed(3)

// ---- 1) 红线早 10ms（截断小节）----
{
  const text = head(['0,428.571429,4,0,0', '1703.857,428.571429,4,1,0'], ['#0', '/Aa = = =/'])
  const doc = parseChart(text)
  const m = doc.measures[0]
  T('截断小节长度 3.976 拍', Math.abs(measureBeatLayout(m).beats - 1703.857 / BL) < 0.01, `${(1703.857 / BL).toFixed(3)}`)
  const ticks = measureTicks(m, 4)
  T('16 格', ticks.length === 16, `n=${ticks.length}`)
  T(
    '最后一格正好落在小节末尾前 1 格',
    Math.abs(ticks[15] - (m.start + (15 * (m.end - m.start)) / 16)) < 0.01,
    `${fmt(ticks[15])}`,
  )
  // 在第 15 格写音符：读回的位置必须还是第 15 格（以前会掉到第 14 格）
  const res = applyCellEdits(doc, [{ mi: 0, k: 15, next: (c) => [...c, 'Aa'] }], 4)
  T('截断小节可以写第 15 格', res.ok, res.ok ? '' : res.reason)
  if (res.ok) {
    const d2 = parseChart(res.text!)
    const ev = d2.events.find((e) => e.time > d2.measures[0].start + 1500)
    const t15 = measureTicks(d2.measures[0], 4)[15]
    T('写出来的音符就在第 15 格', !!ev && Math.abs(ev.time - t15) < 0.01, ev ? `${fmt(ev.time)} vs ${fmt(t15)}` : 'no event')
    const rd = readMeasureCells(d2, 0, 4)
    T('读格不再报「音符不在格子上」', rd.ok, rd.ok ? '' : rd.reason)
  }
}

// ---- 2) 红线晚 10ms（不产生碎片小节）----
{
  // 和用户谱面同构：第 1 条红线早 10ms 截断小节 0，下一条红线比小节 1 的自然结束点晚 10ms
  const text = head(['0,428.571429,4,0,0', '1703.857,428.571429,4,1,0', '3428.3,428.571429,4,1,0'], ['#0', '/Aa = = =/'])
  const doc = parseChart(text)
  const spans = doc.measures.slice(0, 3).map((m) => m.end - m.start)
  T('没有 < 1 拍的碎片小节', spans.every((s) => s > 1000), `spans=${spans.map((s) => s.toFixed(1)).join(',')}`)
  T('第二小节被延到红线', Math.abs(doc.measures[1].end - 3428.3) < 0.01, fmt(doc.measures[1].end))
  T('第三小节从红线开始', Math.abs(doc.measures[2].start - 3428.3) < 0.01, fmt(doc.measures[2].start))
}

// ---- 3) 同 BPM 的继承型 Timing ----
{
  const text = head(['0,428.571429,4,0,0', '1000,428.571429,4,0,2.702'], ['#0', '/Aa = = =/'])
  const doc = parseChart(text)
  T('同 BPM 不拆段', !doc.measures[0].segments, `seg=${doc.measures[0].segments?.length ?? 0}`)
  const rd = readMeasureCells(doc, 0, 4)
  T('这一小节可以读格', rd.ok, rd.ok ? '' : rd.reason)
  const res = applyCellEdits(doc, [{ mi: 0, k: 5, next: () => ['Aa'] }], 4)
  T('这一小节可以写回', res.ok, res.ok ? '' : res.reason)
}

// ---- 4) 真变速：拆段，并且可以正常读写格子 ----
{
  const text = head(['0,500,4,0,0', '1000,250,4,0,2'], ['#0', '/Aa = = =/'])
  const doc = parseChart(text)
  T('真变速仍拆段', (doc.measures[0].segments?.length ?? 0) === 2)
  T('第三拍起点是 1000ms', Math.abs(measureTicks(doc.measures[0], 4)[8] - 1000) < 1e-6)
  const rd = readMeasureCells(doc, 0, 4)
  T('真变速小节可以读格', rd.ok, rd.ok ? '' : rd.reason)

  // 在第三拍第一格（k=8）写一个音效：正文要落在 1000ms，而不是均分的 750ms
  const res = applyCellEdits(doc, [{ mi: 0, k: 8, next: () => ['Aa'] }], 4)
  T('真变速小节可以写回', res.ok, res.ok ? '' : res.reason)
  if (res.ok) {
    const d2 = parseChart(res.text!)
    const ev = d2.events.find((e) => e.names.includes('Aa') && Math.abs(e.time - 1000) < 1)
    T('第三拍写入落在 1000ms', !!ev, d2.events.map((e) => `${fmt(e.time)}:${e.names.join('+')}`).join(' '))

    // 再把这个格子删掉
    const del = applyCellEdits(d2, [{ mi: 0, k: 8, next: () => [] }], 4)
    T('第三拍的音效删得掉', del.ok, del.ok ? '' : del.reason)
    if (del.ok) {
      const d3 = parseChart(del.text!)
      T('删掉后 1000ms 没有音符', !d3.events.some((e) => Math.abs(e.time - 1000) < 1))
    }
  }
}

// ---- 4b) 16 个 token 的正文：第 9 个 token 必须在第三拍 1000ms ----
{
  const tokens = Array.from({ length: 16 }, (_, i) => (i === 8 ? 'Aa' : '='))
  const text = head(['0,500,4,0,0', '1000,250,4,0,2'], ['#0', '/' + tokens.join(' ') + '/'])
  const doc = parseChart(text)
  const ev = doc.events.find((e) => e.names.includes('Aa'))
  T('16 格里第 9 格解析为 1000ms', !!ev && Math.abs(ev.time - 1000) < 1e-6, ev ? fmt(ev.time) : 'none')
  T('这一格读到第 8 格（1/4 细分）', (() => {
    const rd = readMeasureCells(doc, 0, 4)
    return rd.ok && rd.cells[8]?.names.includes('Aa')
  })())
}

// ---- 4c) 变速 + 红线提前截断：16 个 token 不能整体提前一格 ----
{
  const tokens = Array.from({ length: 16 }, (_, i) => ([6, 8, 12].includes(i) ? 'Aa' : '='))
  const text = head(
    ['0,555.555556,4,0,0', '1110.87302,550.458716,4,0,2', '2210,555.555556,4,1,0'],
    ['#0', '/' + tokens.join(' ') + '/'],
  )
  const doc = parseChart(text)
  const m = doc.measures[0]
  const ticks = measureTicks(m, 4)
  T('变速+截断小节仍拆段', (m.segments?.length ?? 0) === 2)
  const evs = doc.events.filter((e) => e.names.includes('Aa'))
  T(
    '三个音都精确落在拍点上',
    evs.length === 3 && evs.every((e) => ticks.some((t) => Math.abs(t - e.time) < 1e-6)),
    evs.map((e) => e.time.toFixed(3)).join(','),
  )
  const rd = readMeasureCells(doc, 0, 4)
  T('读格落在第 7/9/13 格', rd.ok && [6, 8, 12].every((k) => rd.cells[k]?.names.includes('Aa')))

  const del7 = applyCellEdits(doc, [{ mi: 0, k: 7, next: () => [] }], 4)
  T('删空格子不会误删别的音', del7.ok && parseChart(del7.text!).events.filter((e) => e.names.includes('Aa')).length === 3)
  const del8 = applyCellEdits(doc, [{ mi: 0, k: 8, next: () => [] }], 4)
  T(
    '删第 9 格能删掉第三拍那个音',
    del8.ok && !parseChart(del8.text!).events.some((e) => Math.abs(e.time - ticks[8]) < 1e-6),
  )
}

// ---- 5) 完整小节：格子位置一点没变 ----
{
  const text = head(['0,428.571429,4,0,0'], ['#0', '/Aa = = =/'])
  const doc = parseChart(text)
  const ticks = measureTicks(doc.measures[0], 4)
  const ok = ticks.every((t, i) => Math.abs(t - i * 107.14285725) < 1e-6)
  T('完整小节的 1/4 格仍是 107.1429ms', ok, `t3=${fmt(ticks[3])}`)
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
