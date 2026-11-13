/**
 * 直接写入 .osu 的单测：圆圈 / 滑条头 / 折返点 / 滑条尾 / 转盘尾 / 绿线 / Version。
 * 不启动 Electron，纯文本进、纯文本出。
 */
import { parseChart } from '../src/core/parse'
import { planOsuExport, type ComboSample } from '../src/core/osuExport'
import { collectOsuSampleIndices, patchOsuText } from '../src/core/osuPatch'
import { parseHitObjects, parseTimingPoints } from '../src/core/osuSounds'

let pass = 0
let fail = 0
const T = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const BODY1 = Array.from({ length: 16 }, (_, i) => ([0, 4, 8, 12, 14].includes(i) ? 'C' : '=')).join(' ')
const BODY2 = Array.from({ length: 16 }, (_, i) => (i === 12 ? 'C' : '=')).join(' ')
const CHART = `[Metadata]
Title = patch test

[Files]
audio = ""

[Define]
hitsound soft-hitclap C = default.soft-hitclap

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/${BODY1}/
#2000
/${BODY2}/
`

const TARGET = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Target
Artist:Someone
Creator:Me
Version:Hard

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,80,1,0

[HitObjects]
256,192,0,1,0,0:0:0:0:
256,192,500,2,0,B|300:200,2,140,0|0|0,0:0|0:0|0:0,0:0:0:0:
256,192,1000,1,0,0:0:0:0:
256,192,3000,8,0,3500,0:0:0:0:
`

const doc = parseChart(CHART)
const plan = planOsuExport(doc)
T('导出分配没有报错', plan.errors.length === 0, plan.errors.join(' | '))
T('样本时间齐全', [...plan.samples.keys()].sort((a, b) => a - b).join(',') === '0,500,1000,1500,1750,3500', [...plan.samples.keys()].join(','))

const res = patchOsuText(TARGET, plan.samples)
T('补丁成功', res.ok, res.error || '')
T('统计：6 个时刻命中 5 个', res.stats.eventTimes === 6 && res.stats.matchedTimes === 5, JSON.stringify(res.stats))
T('1750 没有目标节点，记为未匹配', res.stats.missingTimes.includes(1750), res.stats.missingTimes.join(','))
T('改了 4 个物件 / 6 个节点', res.stats.objectsPatched === 4 && res.stats.nodesPatched === 6, JSON.stringify(res.stats))
T('其中 2 个滑条边缘节点', res.stats.edgeNodesPatched === 2, String(res.stats.edgeNodesPatched))

const text = res.text!
const objs = parseHitObjects(text.split(/\r?\n/).filter((_, i, all) => {
  const a = all.findIndex((l) => l.trim() === '[HitObjects]')
  return i > a
}))
T('解析出 4 个物件', objs.length === 4, String(objs.length))

const circle = objs.find((o) => o.time === 0)!
T('圆圈 hitSound = clap（8）', circle.hitSound === 8, String(circle.hitSound))
T('圆圈 hitSample = soft:soft:1:100', `${circle.hitSample.normalSet}:${circle.hitSample.additionSet}:${circle.hitSample.index}:${circle.hitSample.volume}` === '2:2:1:100')

const slider = objs.find((o) => o.time === 500)!
T('滑条头 hitSound = clap', slider.hitSound === 8, String(slider.hitSound))
T('滑条头 hitSample 正确', `${slider.hitSample.normalSet}:${slider.hitSample.additionSet}:${slider.hitSample.index}:${slider.hitSample.volume}` === '2:2:1:100')
T('滑条参数里能看到边缘音效', /,0\|8\|8,0:0\|2:2\|2:2,/.test(text), text.split(/\r?\n/).find((l) => l.includes(',500,2,')) || '')

const circle2 = objs.find((o) => o.time === 1000)!
T('滑条折返点旁边的圆圈也被写入', circle2.hitSound === 8 && circle2.hitSample.index === 1)

const spinner = objs.find((o) => o.time === 3000)!
T('转盘尾按 3500 匹配，但不改物件头（音效靠绿线在尾部生效）', spinner.hitSound === 0 && spinner.hitSample.index === 0, `${spinner.hitSound}/${spinner.hitSample.index}`)

const tps = parseTimingPoints(
  text
    .split(/\r?\n/)
    .slice(
      text.split(/\r?\n/).findIndex((l) => l.trim() === '[TimingPoints]') + 1,
      text.split(/\r?\n/).findIndex((l) => l.trim() === '[HitObjects]'),
    ),
)
T('红线带上音效组 1 / 音量 100', tps.length === 1 && tps[0].time === 0 && tps[0].sampleIndex === 1 && tps[0].volume === 100, tps.map((p) => `${p.time}:${p.sampleIndex}:${p.volume}`).join(' '))
T('全程同一个编号时不需要额外绿线', res.stats.greenLines === 0, String(res.stats.greenLines))

// 两个不同组合 → 不同编号/音量，应该在 500ms 插一条绿线
{
  const u2 = Array.from({ length: 16 }, (_, i) => (i === 0 ? 'C' : i === 4 ? 'D' : '='))
  const body2 = u2.map((u, i) => (i === 4 ? `<v=40> ${u}` : u)).join(' ')
  const chart2 = `[Metadata]
Title = two groups

[Files]
audio = ""

[Define]
hitsound soft-hitclap C = default.soft-hitclap
hitsound soft-hitwhistle D = default.soft-hitwhistle

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/${body2}/
`
  const p2 = planOsuExport(parseChart(chart2))
  const r2 = patchOsuText(TARGET, p2.samples)
  const lines2 = r2.text!.split(/\r?\n/)
  const a2 = lines2.findIndex((l) => l.trim() === '[TimingPoints]')
  const b2 = lines2.findIndex((l) => l.trim() === '[HitObjects]')
  const t2 = parseTimingPoints(lines2.slice(a2 + 1, b2))
  T('音量变化在 500ms 插绿线', r2.stats.greenLines === 1 && t2.some((p) => p.time === 500 && !p.uninherited && p.volume === 40), t2.map((p) => `${p.time}:${p.sampleIndex}:${p.volume}`).join(' '))
}

// 目标谱已有的编号要留给它自己
{
  const targetUsed = TARGET.replace('0,500,4,2,0,80,1,0', '0,500,4,2,1,80,1,0').replace(
    '256,192,0,1,0,0:0:0:0:',
    '256,192,0,1,0,0:0:2:80:',
  )
  T('collectOsuSampleIndices 读到已用编号', collectOsuSampleIndices(targetUsed).join(',') === '1,2', collectOsuSampleIndices(targetUsed).join(','))
  const shifted = planOsuExport(doc, { reservedIndices: [1, 2] })
  T('新音效组跳过 1/2，从 3 开始', shifted.groups[0]?.index === 3, String(shifted.groups[0]?.index))
}

const withVersion = patchOsuText(TARGET, plan.samples, { version: 'Hard [HS]' })
T('另存为时可改 Version', !!withVersion.text && /^Version:Hard \[HS\]$/m.test(withVersion.text), withVersion.text?.split(/\r?\n/).find((l) => l.startsWith('Version:')) || '')

// 转盘：头写物件行，尾靠绿线（osu 的转盘行没有单独的尾部音效字段）
{
  const SPIN = `osu file format v14

[General]

[Metadata]
Title:Spin
Version:Hard

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
256,192,1000,12,0,3000,0:0:0:0:
`
  const mk = (bits: number, group: number, volume: number): ComboSample => ({
    bits,
    normalSet: 'soft',
    additionSet: 'soft',
    normalSetNum: 2,
    additionSetNum: 2,
    group,
    volume,
    names: ['C'],
  })
  const spin = patchOsuText(SPIN, new Map([
    [1000, mk(8, 1, 100)],
    [3000, mk(2, 2, 40)],
  ]))
  const spinLine = (spin.text || '').split(/\r?\n/).find((l) => l.startsWith('256,192,1000')) || ''
  T('转盘头写入 hitSound + hitSample', spinLine.split(',')[4] === '8' && spinLine.endsWith('2:2:1:100:'), spinLine)
  T('转盘尾也算匹配', spin.stats.matchedTimes === 2, `${spin.stats.matchedTimes}/${spin.stats.eventTimes}`)
  const sl = (spin.text || '').split(/\r?\n/)
  const a = sl.findIndex((l) => l.trim() === '[TimingPoints]')
  const b = sl.findIndex((l) => l.trim() === '[HitObjects]')
  const tps = parseTimingPoints(sl.slice(a + 1, b))
  T('转盘尾插绿线换编号/音量', tps.some((p) => p.time === 3000 && !p.uninherited && p.sampleIndex === 2 && p.volume === 40), tps.map((p) => `${p.time}:${p.sampleIndex}:${p.volume}`).join(' '))

  const onlyTail = patchOsuText(SPIN, new Map([[3000, mk(2, 2, 40)]]))
  const onlyLine = (onlyTail.text || '').split(/\r?\n/).find((l) => l.startsWith('256,192,1000')) || ''
  T('只有转盘尾音效时不崩、物件行不动', onlyTail.ok && onlyLine === '256,192,1000,12,0,3000,0:0:0:0:', onlyLine)
}

// 无法表示的叠音组合：报错同时记进 skippedCombos，供写入时确认跳过
{
  const SKIP = `[Metadata]
Title = skip

[Files]
audio = ""

[Define]
hitsound soft-hitwhistle w = default.soft-hitwhistle
hitsound normal-hitfinish x = default.normal-hitfinish

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/[w x] = = = = = = = = = = = = = = =/
`
  const sp = planOsuExport(parseChart(SKIP))
  T('非法叠音组合记入 skippedCombos', sp.skippedCombos.length === 1 && sp.skippedCombos[0].count === 1, sp.skippedCombos.map((c) => `${c.names.join('+')}×${c.count}`).join(','))
  T('非法叠音仍在 errors 里（导出仍然拦下）', sp.errors.some((e) => e.includes('没有合法的槽位')), sp.errors[0] || '')
  T('非法组合不产生样本', sp.samples.size === 0, String(sp.samples.size))
}

console.log(`RESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
