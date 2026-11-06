/**
 * 同一小节里的混合节奏（1/4 混 1/6、1/3 混 1/4）：
 * 写回时按「一拍一个括号、括号内取最小公倍数」组织正文。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdits, measureVolumeMarks, readMeasureCells } from '../src/core/gridEdit'

let bad = 0
const T = (cond: boolean, name: string, extra = '') => {
  if (!cond) {
    bad++
    console.log(`FAIL  ${name} ${extra}`)
  } else console.log(`ok    ${name} ${extra}`)
}

const HEAD = `[Metadata]
Title = grid group

[Files]
path = ""
audio = ""

[Define]
hitsound custom Aa = default.soft-hitnormal red
hitsound custom Ab = default.soft-hitclap green
hitsound custom Ac = default.soft-hitfinish blue

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
`
/** 120 BPM：一拍 500ms，4/4 一小节 2000ms */
const chart = (...lines: string[]) => HEAD + lines.join('\n') + '\n'
/** n 个时值单位的一行，第 i 个填 code */
const row = (n: number, at?: Record<number, string>) =>
  '/' +
  Array.from({ length: n }, (_, i) => at?.[i] ?? '=').join(' ') +
  '/'
/** 第 1 行的正文（`/.../`） */
const line1 = (text: string) => (text.split('\n').find((l) => l.startsWith('/')) || '').trim()
/** 回读第 1 小节所有事件的 `时间:代号` */
const stamps = (text: string) =>
  parseChart(text)
    .events.filter((e) => e.measure === 1)
    .map((e) => `${Math.round(e.time)}:${e.names.join('+')}`)
    .join(' ')

// 1) 已经下了 1/4，再下 1/6（细分切到 6）—— 以前这一步直接被拒
{
  const doc = parseChart(chart(row(16, { 1: 'Aa' }))) // 125ms 处一个 Aa（第 1 拍的 1/4）
  T(!!doc.events.length, '输入解析正常', stamps(chart(row(16, { 1: 'Aa' }))))
  const before = applyCellEdits(doc, [{ mi: 0, k: 1, next: (c) => [...c, 'Ab'] }], 6)
  T(before.ok, '1/4 混 1/6 可以写回（细分=6）', before.reason || '')
  const out = line1(before.text || '')
  console.log('      ->', out)
  // 1/4 = 3/12、1/6 = 2/12 → 这一拍取 1/12；其余拍没有内容 → 一个时值单位，不加括号
  T(out === '/(= = Ab Aa = = = = = = = =) = = =/', '第 1 拍 1/12 细分、空拍不加括号', out)
  T(stamps(before.text || '') === '83:Ab 125:Aa', '回读时间正确（83ms / 125ms）', stamps(before.text || ''))
}

// 2) 同一拍有 1/3 和 1/4 → 1/12（细分=4 时）
{
  const doc = parseChart(chart(row(16)))
  const r = applyCellEdits(
    doc,
    [
      { mi: 0, k: 1, next: () => ['Aa'] }, // 第 1 拍 1/4
      { mi: 0, k: 6, next: () => ['Ab'] }, // 第 2 拍 1/2
    ],
    4,
  )
  T(r.ok, '纯 1/4 节奏可以写', r.reason || '')
  T(line1(r.text || '') === '/= Aa = = = = Ab = = = = = = = = =/', '纯 1/4 保持一格一个 token', line1(r.text || ''))
}

// 3) 细分=12 时同一拍摆 1/3 + 1/4
{
  const doc = parseChart(chart(row(48)))
  const r = applyCellEdits(
    doc,
    [
      { mi: 0, k: 4, next: () => ['Aa'] }, // 1/3 拍
      { mi: 0, k: 3, next: () => ['Ab'] }, // 1/4 拍
      { mi: 0, k: 24, next: () => ['Ac'] }, // 第 3 拍开头
    ],
    12,
  )
  T(r.ok, '细分=12 时 1/3 + 1/4 同拍可写', r.reason || '')
  const out = line1(r.text || '')
  console.log('      ->', out)
  // 这一拍有 1/3 → 非 1/4 节奏 → 一拍一个括号、括号内 1/12；只占一份的拍不加括号
  T(
    out === '/(= = = Ab Aa = = = = = = =) = Ac =/',
    '1/3+1/4 同拍 → 括号里 1/12；单份的拍不加括号',
    out,
  )
  T(stamps(r.text || '') === '125:Ab 167:Aa 1000:Ac', '回读：1/4=125ms、1/3=167ms、第 3 拍=1000ms', stamps(r.text || ''))
}

// 4) 细分=4 时文本里已经有 1/6（括号写法），继续按 1/4 改别的拍
{
  const doc = parseChart(chart('/(= Ab = = = =) = = =/'))
  T(stamps(chart('/(= Ab = = = =) = = =/')) === '83:Ab', '括号写法解析出 1/6 的音', stamps(chart('/(= Ab = = = =) = = =/')))
  const r = applyCellEdits(doc, [{ mi: 0, k: 8, next: () => ['Aa'] }], 4) // 第 3 拍开头
  T(r.ok, '括号小节可以按 1/4 细分继续写', r.reason || '')
  const out = line1(r.text || '')
  console.log('      ->', out)
  T(stamps(r.text || '') === '83:Ab 1000:Aa', '1/6 的 Ab 没被量化掉', stamps(r.text || ''))
}

// 5) 括号里的 <v=xx>：位置要读得对，改写后还要留着
{
  const doc = parseChart(chart('/(= = <v=40> Aa) = = =/'))
  const marks = measureVolumeMarks(doc, 0, 4)
  T(marks.get(2) === 40, '<v> 在这一拍第 3 份 → 第 2 格', JSON.stringify([...marks]))
  const r = applyCellEdits(doc, [{ mi: 0, k: 12, next: () => ['Ab'] }], 4)
  T(r.ok, '带括号+音量的小节可以继续改', r.reason || '')
  console.log('      ->', line1(r.text || ''))
  const back = parseChart(r.text || '').events.filter((e) => e.measure === 1)
  T(
    back.some((e) => e.names.includes('Aa') && e.volume === 40),
    '改写后 Aa 的音量还是 40',
    JSON.stringify(back.map((e) => `${e.names}:${e.volume}`)),
  )
  T(line1(r.text || '').includes('<v=40>'), '<v=40> 还在正文里', line1(r.text || ''))
}

// 6) 写出来的括号再读一遍：内容和位置都不变（幂等）
{
  const first = applyCellEdits(parseChart(chart(row(16, { 1: 'Aa' }))), [{ mi: 0, k: 1, next: (c) => [...c, 'Ab'] }], 6)
  const second = applyCellEdits(parseChart(first.text!), [{ mi: 0, k: 1, next: (c) => [...c, 'Ab'] }], 6)
  T(line1(first.text || '') === line1(second.text || ''), '再改一次结果不变', `${line1(first.text || '')} | ${line1(second.text || '')}`)
}

// 7) 噪声位置（1/17 拍这种）不给面子，维持原来的报错
{
  const doc = parseChart(chart(row(17, { 1: 'Aa' }))) // 2000/17 ≈ 117.6ms
  const r = applyCellEdits(doc, [{ mi: 0, k: 2, next: () => ['Ab'] }], 4)
  T(!r.ok, '奇怪的位置仍然拒绝写回（不会把小节撑爆）', r.ok ? line1(r.text || '') : r.reason || '')
}

// 8) 读格子：4/4 拍还是 16 格
{
  const got = readMeasureCells(parseChart(chart('/(= = Ab Aa = = = = = = = =) = = =/')), 0, 4)
  T(got.ok, '可以读格子', got.ok ? '' : got.reason)
  if (got.ok) T(got.cells.length === 16, '4/4 拍 → 16 格', String(got.cells.length))
}

console.log(bad ? `\n${bad} FAILED` : '\nALL PASS')
