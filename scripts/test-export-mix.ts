/**
 * 导出计划：混音槽位的落点（mm:ss:ms 列表用的数据）。
 *
 * 两个代号落在同一个槽位（比如都是 soft-hitclap），同一时刻叠在一起就必须混音；
 * `mixTimes` 要列出这些时刻，导出前的提示框直接拿它显示。
 */
import { parseChart } from '../src/core/parse'
import { planOsuExport } from '../src/core/osuExport'

let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

const chart = `[Metadata]
Title = mix

[Files]
path = "C:/fake"
audio = ""

[Define]
hitsound soft-hitclap Z = "z.wav"
hitsound soft-hitclap L = "l.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/[Z L] = = =/
#2000
/Z = = =/
#4000
/[Z L] = = =/
`
const doc = parseChart(chart)
const plan = planOsuExport(doc)
console.log('errors:', plan.errors)
console.log('mixCount:', plan.mixCount)
console.log(
  'files:',
  JSON.stringify(plan.files.map((f) => ({ to: f.to, mix: f.mix, times: f.mixTimes }))),
)

T('没有槽位错误', plan.errors.length === 0, plan.errors.join(' | '))
T('混音任务 1 个', plan.mixCount === 1, String(plan.mixCount))

const mix = plan.files.find((f) => f.mix)
T('找到混音文件', !!mix, mix ? mix.to : 'none')
T('混音文件是 soft-hitclap', !!mix && mix.to.startsWith('soft-hitclap'), mix ? mix.to : '')
T(
  '落点是 0ms 与 4000ms（2000ms 那格只有一个音效）',
  !!mix && JSON.stringify(mix.mixTimes) === '[0,4000]',
  mix ? JSON.stringify(mix.mixTimes) : '',
)
T(
  '混音来源记下了两个代号',
  !!mix && (mix.mixMeta?.sources || []).map((s) => s.code).sort().join('+') === 'L+Z',
  mix ? (mix.mixMeta?.sources || []).map((s) => s.code).join('+') : '',
)

// 没有叠音时不该有 mixTimes
const plain = planOsuExport(
  parseChart(`[Metadata]
Title = plain

[Files]
path = "C:/fake"
audio = ""

[Define]
hitsound soft-hitclap Z = "z.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Z = = =/
`),
)
T('没有叠音时 mixCount = 0', plain.mixCount === 0, String(plain.mixCount))
T('没有叠音时没有 mixTimes', plain.files.every((f) => !f.mixTimes), JSON.stringify(plain.files.map((f) => f.mixTimes)))

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
