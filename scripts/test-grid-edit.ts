/**
 * 格子写回（gridEdit）单测：不启动 Electron，直接跑解析 → 改 → 再解析。
 */
import { parseChart } from '../src/core/parse'
import { applyCellEdit } from '../src/core/gridEdit'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const HEAD = `[Metadata]
Title = grid edit

[Files]
path = ""
audio = ""

[Define]
hitsound custom Aa = default.soft-hitnormal red
hitsound custom Ab = default.soft-hitclap green

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
`

const M1 = '/Aa = = = Ab = = = Aa = = = Ab = = =/'
const doc = parseChart(HEAD + M1 + '\n' + M1 + '\n')

// 1) 空格子加音效
{
  const r = applyCellEdit(doc, 0, 5, 4, ['Aa'])
  ok(r.ok, '空格子可以加代号')
  const line = (r.text || '').split('\n').find((l) => l.startsWith('/'))
  ok(line === '/Aa = = = Ab Aa = = Aa = = = Ab = = =/', `写入位置正确：${line}`)
  // 再解析：第 6 格确实有 Aa
  const d2 = parseChart(r.text!)
  ok(d2.events.some((e) => e.measure === 1 && Math.abs(e.time - 625) < 2 && e.names.includes('Aa')), '回读时间正确')
}

// 2) 同一格再加一个代号（并存）
{
  const r = applyCellEdit(doc, 0, 5, 4, ['Aa', 'Ab'])
  const line = (r.text || '').split('\n').find((l) => l.startsWith('/'))
  ok(line === '/Aa = = = Ab [Aa Ab] = = Aa = = = Ab = = =/', `多代号写成 [Aa Ab]：${line}`)
  const d2 = parseChart(r.text!)
  const at = d2.events.filter((x) => x.measure === 1 && Math.abs(x.time - 625) < 2)
  ok(at.length === 2 && at.some((x) => x.names[0] === 'Aa') && at.some((x) => x.names[0] === 'Ab'), '回读是两个音效（同刻两条）')
}

// 3) 清空一格
{
  const r = applyCellEdit(doc, 0, 0, 4, [])
  const line = (r.text || '').split('\n').find((l) => l.startsWith('/'))
  ok(line === '/= = = = Ab = = = Aa = = = Ab = = =/', `清空写成 =：${line}`)
  const d2 = parseChart(r.text!)
  ok(!d2.events.some((x) => x.measure === 1 && x.time < 1), '回读该格没有音效')
}

// 4) 第二轮编辑基于第一轮的结果（连续点击）
{
  const r1 = applyCellEdit(doc, 0, 1, 4, ['Aa'])
  const d2 = parseChart(r1.text!)
  const r2 = applyCellEdit(d2, 0, 2, 4, ['Ab'])
  const line = (r2.text || '').split('\n').find((l) => l.startsWith('/'))
  ok(line === '/Aa Aa Ab = Ab = = = Aa = = = Ab = = =/', `连续两次编辑都保留：${line}`)
}

// 5) 音量/编号保留
{
  const src = HEAD + '/<v=60> <i=2> Aa = = = Ab = = = Aa = = = Ab = = =/\n'
  const d = parseChart(src)
  const r = applyCellEdit(d, 0, 5, 4, ['Aa'])
  const line = (r.text || '').split('\n').find((l) => l.startsWith('/'))
  ok(
    (line || '').split('<v=').length - 1 === 1 && (line || '').split('<i=').length - 1 === 1,
    `音量/编号只写一次：${line}`,
  )
  const d2 = parseChart(r.text!)
  const e = d2.events.find((x) => Math.abs(x.time - 625) < 2)
  ok(e?.volume === 60 && e?.index === 2, '回读音量与编号')
}

// 6) 一小节 17 个 token（不是整格）→ 拒绝
{
  const off = parseChart(HEAD + '/Aa = Ab = = Ab = = = Aa = = = Ab = = =/\n')
  const r = applyCellEdit(off, 0, 3, 4, ['Aa'])
  ok(!r.ok && /不在格子上/.test(r.reason || ''), `非整格拒绝：${r.reason}`)
}

// 7) 一行多小节 → 没有 body 范围，拒绝（或用 # 标记补写）
{
  const multi = parseChart(HEAD + '/Aa = = = Ab = = = Aa = = = Ab = = =/Ab = = = Aa = = = Ab = = = Ab = = =/\n')
  const r = applyCellEdit(multi, 1, 0, 4, ['Aa'])
  ok(!r.ok && /同一行/.test(r.reason || ''), `多小节一行拒绝：${r.reason}`)
}

// 8) 谱面末尾自动延伸出来的空小节 → 补 # 标记 + 一行
{
  const d = parseChart(HEAD + M1 + '\n')
  const mi = 4
  const m = d.measures[mi]
  const r = applyCellEdit(d, mi, 0, 4, ['Aa'])
  ok(r.ok, '空小节可以写入')
  const d2 = parseChart(r.text!)
  ok(d2.events.some((e) => e.measure === mi + 1 && e.names.includes('Aa')), '补写后回读到该小节')
  console.log('     marker =', (r.text || '').split('\n').filter((l) => l.startsWith('#')).slice(-1)[0], '→ start', Math.round(m.start))
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
