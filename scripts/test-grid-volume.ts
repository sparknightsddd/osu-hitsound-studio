/**
 * 右键「修改音量」：写 `<v=xx>`，已有就只改数值、不重复加；空格子也会补一条。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdits, volumeSpanFrom } from '../src/core/gridEdit'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const HEAD = (body: string) => `[Metadata]
Title = vol
Artist = tester

[Files]
path = ""
audio = ""

[Define]
hitsound soft-hitclap Aa = default.soft-hitclap
hitsound soft-hitwhistle Ab = default.soft-hitwhistle

[Timing]
0,bpm(120),4,0,0

[Hitsound]
${body}
`

const line = (text: string) => (text.split('[Hitsound]')[1] || '').split('\n').filter((l) => l.trim())[1] || ''

/** 造一小节 16 格的正文：spec 是指定格的代号，vols 是指定格前面的 <v> */
function body16(spec: Record<number, string>, vols: Record<number, number> = {}): string {
  const toks: string[] = []
  for (let k = 0; k < 16; k++) {
    if (vols[k] !== undefined) toks.push(`<v=${vols[k]}>`)
    toks.push(spec[k] ?? '=')
  }
  return `/${toks.join(' ')}/`
}

function setVol(text: string, mi: number, k: number, v: number) {
  const doc = parseChart(text)
  const r = applyCellEdits(doc, [{ mi, k, next: (c: string[]) => c, volume: v, volumeForce: true }], 4)
  return r
}

// 1) 有音效的格子：写成 <v=42>
{
  const doc = parseChart(HEAD('#0\n/Aa = = =/'))
  const r = setVol(doc.text, 0, 2, 42)
  ok(r.ok, `写回成功：${r.ok ? '' : r.reason}`)
  const l = line(r.text!)
  ok(l.includes('<v=42>'), `有 <v=42>：${l}`)
  ok((l.match(/<v=/g) || []).length === 1, `只有一条 <v>：${l}`)
  ok(l.split(/\s+/)[2] === '<v=42>', '音量就标在那一格前面')
}

// 2) 再改一次：只改数值，不重复加
{
  const once = setVol(parseChart(HEAD('#0\n/Aa = = =/')).text, 0, 2, 42).text!
  const twice = setVol(once, 0, 2, 30).text!
  const l = line(twice)
  ok(l.includes('<v=30>'), `改成 30：${l}`)
  ok(!l.includes('<v=42>'), '旧值没了')
  ok((l.match(/<v=/g) || []).length === 1, `仍然只有一条 <v>：${l}`)
}

// 3) 空格子：也补一条 <v>，后面照旧是 =
{
  const doc = parseChart(HEAD('#0\n/Aa = = =/'))
  const r = setVol(doc.text, 0, 10, 55)
  ok(r.ok, `空格子写回成功：${r.ok ? '' : r.reason}`)
  const l = line(r.text!)
  ok(l.includes('<v=55>'), `空格子也有 <v=55>：${l}`)
  ok((l.match(/<v=/g) || []).length === 1, `只有一条 <v>：${l}`)
}

// 4) 和上一格音量相同时，也照样写（用户明确要求这个位置有 <v>）
{
  const doc = parseChart(HEAD('#0\n/<v=60> Aa = = =/'))
  const r = setVol(doc.text, 0, 1, 60)
  ok(r.ok, '写回成功')
  const l = line(r.text!)
  ok(l.includes('<v=60>'), `仍然保留 <v=60>：${l}`)
}

// 5) 跨小节/多选：每一格各写一条
{
  const doc = parseChart(HEAD('#0\n/Aa = = =/\n#2000\n/Aa = = =/'))
  const r = applyCellEdits(
    doc,
    [
      { mi: 0, k: 3, next: (c: string[]) => c, volume: 33, volumeForce: true },
      { mi: 1, k: 3, next: (c: string[]) => c, volume: 44, volumeForce: true },
    ],
    4,
  )
  ok(r.ok, '多小节写回成功')
  const body = (r.text || '').split('[Hitsound]')[1] || ''
  ok(body.includes('<v=33>') && body.includes('<v=44>'), `两处各有音量：${body.trim()}`)
}

// 6) 普通写回（不带 volumeForce）不会被塞满 <v>
{
  const doc = parseChart(HEAD('#0\n/Aa = = =/'))
  const r = applyCellEdits(doc, [{ mi: 0, k: 5, next: () => ['Ab'] }], 4)
  ok(r.ok, '普通写回成功')
  const l = line(r.text!)
  ok(!l.includes('<v='), `没有凭空多出 <v>：${l}`)
}

// 7) 删除音量：第一格前面的 <v> 消失，后面的格子回到上一段的音量
{
  const doc = parseChart(HEAD('#0\n/<v=58> Aa = = =/'))
  const r = applyCellEdits(doc, [{ mi: 0, k: 0, next: (c: string[]) => c, volumeClear: true }], 4)
  ok(r.ok, `删除成功：${r.ok ? '' : r.reason}`)
  const l = line(r.text!)
  ok(!l.includes('<v='), `<v> 被删掉：${l}`)
  ok(l.startsWith('/Aa'), `音效还在：${l}`)
}

// 8) 删中间那条：只删它，前面那条留着，后面的空格子不会补出新的 <v>
{
  const doc = parseChart(HEAD(`#0\n${body16({ 0: 'Aa', 8: 'Aa' }, { 0: 58, 4: 30 })}`))
  const r = applyCellEdits(doc, [{ mi: 0, k: 4, next: (c: string[]) => c, volumeClear: true }], 4)
  ok(r.ok, '删除成功')
  const l = line(r.text!)
  ok(l.includes('<v=58>'), `前一条留着：${l}`)
  ok(!l.includes('<v=30>'), `30 被删掉：${l}`)
  ok((l.match(/<v=/g) || []).length === 1, `只剩一条 <v>：${l}`)
}

// 9) 空格子上的 <v> 也能删，删完就是一个普通的 =
{
  const doc = parseChart(HEAD('#0\n/<v=55> = = = Aa/'))
  const r = applyCellEdits(doc, [{ mi: 0, k: 0, next: (c: string[]) => c, volumeClear: true }], 4)
  ok(r.ok, '删除成功')
  const l = line(r.text!)
  ok(!l.includes('<v='), `空格子上的 <v> 也删掉：${l}`)
  ok(l.startsWith('/='), `空格子还是 =：${l}`)
}

// 10) 小节开头删 <v>：继承上一小节的音量，不会多写一条
{
  const doc = parseChart(HEAD('#0\n/<v=40> Aa = = =/\n#2000\n/<v=58> Aa = = =/'))
  const r = applyCellEdits(doc, [{ mi: 1, k: 0, next: (c: string[]) => c, volumeClear: true }], 4)
  ok(r.ok, '删除成功')
  const body = (r.text || '').split('[Hitsound]')[1] || ''
  const second = body.split('\n').filter((x) => x.trim() && x.includes('/'))[1] || ''
  ok(!second.includes('<v='), `第二小节不再写 <v>（继承 40）：${second}`)
  ok(second.includes('Aa'), '音效还在')
}

// 11) 一次删多格：两条都消失，只留前面那条
{
  const doc = parseChart(HEAD(`#0\n${body16({ 0: 'Aa', 8: 'Aa' }, { 0: 58, 4: 30, 7: 55 })}`))
  const r = applyCellEdits(
    doc,
    [
      { mi: 0, k: 4, next: (c: string[]) => c, volumeClear: true },
      { mi: 0, k: 7, next: (c: string[]) => c, volumeClear: true },
    ],
    4,
  )
  ok(r.ok, '多格删除成功')
  const l = line(r.text!)
  ok(l.includes('<v=58>') && !l.includes('<v=30>') && !l.includes('<v=55>'), `只剩 58：${l}`)
  ok((l.match(/<v=/g) || []).length === 1, `只有一条 <v>：${l}`)
}

// 12) 删一个本来就没有 <v> 的格子：内容不变（不会误删别的）
{
  const doc = parseChart(HEAD(`#0\n${body16({ 0: 'Aa', 8: 'Aa' }, { 0: 58 })}`))
  const r = applyCellEdits(doc, [{ mi: 0, k: 5, next: (c: string[]) => c, volumeClear: true }], 4)
  ok(r.ok, '删除成功')
  const l = line(r.text!)
  ok(l.includes('<v=58>'), `没有误删前面的 <v>：${l}`)
  ok((l.match(/<v=/g) || []).length === 1, `仍然只有一条 <v>：${l}`)
}

// 13) volumeSpanFrom：单选改音量从这一格管到下一条 <v> 之前
{
  const doc = parseChart(HEAD(`#0\n${body16({ 0: 'Aa', 4: 'Aa', 8: 'Aa' }, { 0: 58, 4: 30, 8: 55 })}`))
  ok(volumeSpanFrom(doc, 0, 0, 4).join(',') === '0,1,2,3', `第 1 格到 30 之前：${volumeSpanFrom(doc, 0, 0, 4).join(',')}`)
  ok(volumeSpanFrom(doc, 0, 4, 4).join(',') === '4,5,6,7', `30 那一格到 55 之前：${volumeSpanFrom(doc, 0, 4, 4).join(',')}`)
  ok(
    volumeSpanFrom(doc, 0, 9, 4).join(',') === '9,10,11,12,13,14,15',
    `最后一格之后没有标记：${volumeSpanFrom(doc, 0, 9, 4).join(',')}`,
  )
  const bare = parseChart(HEAD(`#0\n${body16({ 0: 'Aa' })}`))
  ok(volumeSpanFrom(bare, 0, 3, 4).length === 13, `没有后续 <v> 就一直到小节末：${volumeSpanFrom(bare, 0, 3, 4).length}`)
}

// 14) 单选写回：整段只写一条 <v>，段尾后面的音量自动补回来
{
  const doc = parseChart(HEAD(`#0\n${body16({ 0: 'Aa', 8: 'Aa' }, { 0: 58, 4: 30 })}`))
  const span = volumeSpanFrom(doc, 0, 0, 4)
  const r = applyCellEdits(
    doc,
    span.map((k, i) => ({ mi: 0, k, next: (c: string[]) => c, volume: 70, volumeForce: i === 0 })),
    4,
  )
  ok(r.ok, '写回成功')
  const l = line(r.text!)
  ok(l.startsWith('/<v=70> Aa'), `这一段从 70 开始：${l}`)
  ok((l.match(/<v=/g) || []).length === 2, `整段只有一条 <v=70>（外加原来的 30）：${l}`)
  ok(l.includes('<v=30>'), `下一条 <v=30> 原样保留：${l}`)
  ok(l.split(/\s+/).slice(2, 4).join(' ') === '= =', `段内没有多余的 <v>：${l}`)
}

// 15) 多选是连续段时：只在段首写一条，段尾后面补回原音量
{
  const doc = parseChart(HEAD(`#0\n${body16({ 0: 'Aa', 8: 'Aa' }, { 0: 58 })}`))
  const r = applyCellEdits(
    doc,
    [8, 9, 10, 11].map((k, i) => ({ mi: 0, k, next: (c: string[]) => c, volume: 30, volumeForce: i === 0 })),
    4,
  )
  const l = line(r.text!)
  ok((l.match(/<v=30>/g) || []).length === 1, `段首只有一条 <v=30>：${l}`)
  ok(l.includes('<v=58>'), `段尾后面补回 58：${l}`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
if (bad) process.exit(1)
