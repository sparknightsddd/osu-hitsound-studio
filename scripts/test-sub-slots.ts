/**
 * 副槽位单测：语法 / 优先级 / 目标谱落点 / 绿线与文件。
 */
import { parseChart } from '../src/core/parse'
import { editHitsoundDefineText } from '../src/core/defineEdit'
import { slotLabel } from '../src/core/exporter'
import { planOsuExport, type ComboSample } from '../src/core/osuExport'
import { parseOsuTargetTimeline, patchOsuText } from '../src/core/osuPatch'
import { planSubSlots } from '../src/core/subSlotPlan'

let pass = 0
let fail = 0
const T = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const HEAD = (define: string, body: string) => `[Metadata]
Title = sub slots

[Files]
path = ""
audio = ""

[Define]
${define}

[Timing]
0,bpm(120),4,0,0

[Hitsound]
${body}
`

// ---------------------------------------------------------------------------
// 1) 语法规则
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    HEAD(
      [
        'hitsound custom|sliderside Aa = "a.wav"',
        'hitsound soft-hitwhistle|successor|slidertick Bb = "b.wav"',
        'hitsound sliderside = default.blank',
        'hitsound slidertick|sliderside = default.blank',
        'hitsound soft-hitclap Dd = "d.wav"',
      ].join('\n'),
      '/Aa Bb Dd/',
    ),
  )
  const by = new Map(doc.hitsounds.filter((h) => h.name).map((h) => [h.name!, h]))
  T('custom|sliderside：主槽位 custom + 副槽位 sliderside', by.get('Aa')?.alts[0]?.custom === true && by.get('Aa')?.subSlots.join() === 'sliderside')
  T(
    '副槽位按固定顺序判定（书写顺序 successor|slidertick 不影响）',
    by.get('Bb')?.subSlots.join() === 'slidertick,successor',
    by.get('Bb')?.subSlots.join(),
  )
  T(
    '白板 sliderside 合法（无主槽位）',
    doc.hitsounds.some((h) => !h.name && h.subSlots.join() === 'sliderside'),
  )
  T(
    '白板可以同时 sliderside + slidertick',
    doc.hitsounds.some((h) => !h.name && h.subSlots.join() === 'slidertick,sliderside'),
  )
  T('普通主槽位定义没有副槽位', by.get('Dd')?.subSlots.length === 0)
  T('语法诊断没有错误', doc.diagnostics.filter((d) => d.severity === 'error').length === 0, doc.diagnostics.map((d) => d.message).join(' | '))
  T('slotLabel 带上副槽位', slotLabel(by.get('Aa')!) === 'custom|sliderside', slotLabel(by.get('Aa')!))
  const edited = editHitsoundDefineText(
    HEAD('hitsound custom|sliderside Aa = "a.wav"\nhitsound soft-hitclap Dd = "d.wav"', '/Aa Dd/'),
    'Aa',
    { name: 'Ee', slots: ['soft-hitwhistle'], color: '#ff0000' },
  )
  T('改代号/主槽位/颜色时副槽位不丢', !!edited.text && edited.text.includes('hitsound soft-hitwhistle|sliderside Ee = "a.wav" #FF0000'), edited.text?.split('\n').find((l) => l.includes('Ee')))

  const bad = parseChart(
    HEAD(
      ['hitsound sliderside Cc = "c.wav"', 'hitsound custom|successor = default.blank'].join('\n'),
      '/Dd/',
    ),
  )
  const errs = bad.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)
  T('有代号但只有副槽位 → 报错', errs.includes('sub-slot-needs-main'), errs.join())
  T('successor 不能做白板 → 报错', errs.includes('sub-slot-successor-whiteboard'), errs.join())
}

// ---------------------------------------------------------------------------
// 2) 目标谱：滑条 500 → 1500，SliderTickRate=2 → 滑条点 750 / 1000 / 1250
// ---------------------------------------------------------------------------
const TARGET = `osu file format v14

[General]
AudioFilename: audio.mp3
SampleSet: Soft
Mode: 0

[Metadata]
Title:target
Artist:t
Creator:t
Version:t

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:2

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,1,1,0:0:0:0:
256,192,500,2,0,B|300:192,1,280,0|0:0|0:0,0:0:0:0:
256,192,2000,1,1,0:0:0:0:
`
const timeline = parseOsuTargetTimeline(TARGET)
T('目标节点：0 / 滑条头 500 / 滑条尾 1500 / 2000', [...timeline.nodes].sort((a, b) => a - b).join(',') === '0,500,1500,2000', [...timeline.nodes].join())
T('滑条点：750 / 1000 / 1250', timeline.sliders[0]?.ticks.join(',') === '750,1000,1250', timeline.sliders[0]?.ticks.join())
T('滑条身分段：500→1500', timeline.sliders[0]?.spans.map((s) => `${s.start}-${s.end}`).join() === '500-1500')

// 音效：0 主槽位、750 滑条点、1125 滑条身、1250 滑条点、2000 主槽位、2250 后继
const CHART = HEAD(
  [
    'hitsound soft-hitwhistle|sliderside Aa = "side.wav"',
    'hitsound soft-hitclap|slidertick Bb = "tick.wav"',
    'hitsound soft-hitclap|successor Cc = "succ.wav"',
    'hitsound soft-hitnormal Dd = "d.wav"',
  ].join('\n'),
  ['#0', '/Aa = = = = = Bb = = Aa Bb = = = = =/', '#2000', '/Dd = Cc = = = = = = = = = = = = =/'].join('\n'),
)
const doc = parseChart(CHART)
const plan = planOsuExport(doc)
T('导出规划无错误', plan.errors.length === 0, plan.errors.join(' | '))
T(
  '音效时刻：0/750/1125/1250/2000/2250',
  [...plan.samples.keys()].sort((a, b) => a - b).join(',') === '0,750,1125,1250,2000,2250',
  [...plan.samples.keys()].join(),
)

const sub = planSubSlots(doc, plan.samples, timeline, {
  usedIndices: [...plan.groups.map((g) => g.index)],
})
const byTime = new Map(sub.placements.map((p) => [p.time, p]))
T('0ms 留在主槽位', sub.samples.has(0))
T('2000ms 留在主槽位', sub.samples.has(2000))
T('750ms → slidertick', byTime.get(750)?.slot === 'slidertick', JSON.stringify(byTime.get(750)))
T('1125ms → sliderside（在滑条身里）', byTime.get(1125)?.slot === 'sliderside', JSON.stringify(byTime.get(1125)))
T('1250ms → slidertick', byTime.get(1250)?.slot === 'slidertick', JSON.stringify(byTime.get(1250)))
T('2250ms → successor（挂在前一个 2000ms）', byTime.get(2250)?.slot === 'successor' && byTime.get(2250)?.of === 2000, JSON.stringify(byTime.get(2250)))
T('2250 的延迟是 250ms', byTime.get(2250)?.delay === 250, String(byTime.get(2250)?.delay))
T('被副槽位接走的 4 个时刻从 samples 里移除', [750, 1125, 1250, 2250].every((t) => !sub.samples.has(t) && sub.removed.includes(t)))
T('samples 只剩 0 / 2000', [...sub.samples.keys()].sort((a, b) => a - b).join() === '0,2000', [...sub.samples.keys()].join())

const fileNames = sub.files.map((f) => f.to)
T('滑条点文件 soft-slidertick*.wav', fileNames.filter((n) => n.includes('slidertick')).length === 2, fileNames.join(', '))
T('滑条身文件 soft-sliderslide*.wav', fileNames.some((n) => n.includes('sliderslide')), fileNames.join(', '))
T('滑条尾 1500 有恢复绿线', sub.moves.some((m) => m.time === 1500), JSON.stringify(sub.moves.filter((m) => m.time === 1500)))
T('successor 在 2000 覆盖编号', sub.moves.some((m) => m.time === 2000 && m.index === byTime.get(2250)?.index), JSON.stringify(sub.moves.filter((m) => m.time === 2000)))

const succTask = sub.files.find((f) => f.to.startsWith('soft-hitnormal') && f.mix && f.delays?.some((d) => d === 250))
T('successor 生成延迟混音文件', !!succTask, JSON.stringify(sub.files.filter((f) => f.mix)))
T(
  'successor 混音源：Dd 在 0ms、Cc 在 250ms',
  !!succTask && succTask.from.some((p) => p.endsWith('d.wav')) && succTask.from.some((p) => p.endsWith('succ.wav')) && JSON.stringify(succTask.delays) === '[0,250]',
  JSON.stringify(succTask),
)

// ---------------------------------------------------------------------------
// 3) 全局白板副槽位：三个采样组各写一份
// ---------------------------------------------------------------------------
{
  const gdoc = parseChart(
    HEAD(
      ['hitsound sliderside = default.blank', 'hitsound slidertick = default.blank', 'hitsound custom Dd = "d.wav"'].join('\n'),
      '#0\n/Dd/',
    ),
  )
  const gplan = planOsuExport(gdoc)
  const gsub = planSubSlots(gdoc, gplan.samples, timeline, { usedIndices: [1] })
  const names = gsub.files.map((f) => f.to).sort()
  T(
    '白板 sliderside 写 soft/normal/drum-sliderslide.wav',
    ['soft-sliderslide.wav', 'normal-sliderslide.wav', 'drum-sliderslide.wav'].every((n) => names.includes(n)),
    names.join(', '),
  )
  T(
    '白板 slidertick 写 soft/normal/drum-slidertick.wav',
    ['soft-slidertick.wav', 'normal-slidertick.wav', 'drum-slidertick.wav'].every((n) => names.includes(n)),
    names.join(', '),
  )
  T(
    '白板文件来自 default.blank',
    gsub.files.every((f) => f.defaults.includes('blank') && f.mix),
  )
  T('全局白板允许覆盖同名文件', gsub.files.every((f) => f.overwrite === true))
}

// ---------------------------------------------------------------------------
// 4) patchOsuText：副槽位绿线写进目标谱
// ---------------------------------------------------------------------------
{
  const res = patchOsuText(TARGET, sub.samples, { extraMoves: sub.moves })
  T('补丁成功', res.ok, res.error || '')
  const text = res.text || ''
  const timing = text.split('[TimingPoints]')[1].split('[HitObjects]')[0].split(/\r?\n/).filter((l) => l.trim())
  const at = (t: number) => timing.find((l) => Number(l.split(',')[0]) === t) || ''
  T(`750ms 绿线 sampleSet=2 / sampleIndex=${byTime.get(750)!.index}`, at(750).includes(`,2,${byTime.get(750)!.index},`), at(750))
  T(`1125ms 绿线 sampleSet=2 / sampleIndex=${byTime.get(1125)!.index}`, at(1125).includes(`,2,${byTime.get(1125)!.index},`), at(1125))
  T(`1250ms 绿线 sampleSet=2 / sampleIndex=${byTime.get(1250)!.index}`, at(1250).includes(`,2,${byTime.get(1250)!.index},`), at(1250))
  T(
    '滑条点之后恢复采样组（751ms / 1251ms）',
    at(751).includes(',2,0,') && at(1251).includes(',2,0,'),
    `${at(751)} / ${at(1251)}`,
  )
  const succIndex = byTime.get(2250)!.index
  T(`2000ms 绿线指向 successor 文件编号 ${succIndex}`, at(2000).includes(`,2,${succIndex},`), at(2000))
}

// 5) successor 挂到前一个滑条点上：tick 文件直接被扩展成「tick + 延迟 B」
{
  const tickDoc = parseChart(
    HEAD(
      [
        'hitsound soft-hitclap|slidertick Bb = "tick.wav"',
        'hitsound soft-hitclap|successor Cc = "succ.wav"',
      ].join('\n'),
      '#0\n/= = = = = = Bb = Cc = = = = = = =/',
    ),
  )
  const tickPlan = planOsuExport(tickDoc)
  const tickSub = planSubSlots(tickDoc, tickPlan.samples, timeline, { usedIndices: [1] })
  const tickPlace = tickSub.placements.find((p) => p.slot === 'slidertick')!
  const succ = tickSub.placements.find((p) => p.slot === 'successor')!
  const tickFile = tickSub.files.find((f) => f.to === `soft-slidertick${tickPlace.index}.wav`)
  T('滑条点上的后继挂在这个点（1000ms）', succ.of === tickPlace.time && succ.delay === 250, JSON.stringify(succ))
  T(
    '滑条点文件被扩展成 tick + 延迟 B',
    !!tickFile && tickFile.mix && tickFile.from.some((p) => p.endsWith('tick.wav')) && tickFile.from.some((p) => p.endsWith('succ.wav')) && JSON.stringify(tickFile.delays) === '[0,250]',
    JSON.stringify(tickFile),
  )
}

// 6) 只有滑条身音效时，恢复线必须落在滑条尾 1500
{
  const sideDoc = parseChart(
    HEAD('hitsound soft-hitwhistle|sliderside Aa = "side.wav"', '#0\n/= = = = = = = = = Aa = = = = = =/'),
  )
  const sidePlan = planOsuExport(sideDoc)
  const sideSub = planSubSlots(sideDoc, sidePlan.samples, timeline, { usedIndices: [1] })
  const r = patchOsuText(TARGET, sideSub.samples, { extraMoves: sideSub.moves, allowEmpty: true })
  const lines = (r.text || '').split('[TimingPoints]')[1].split('[HitObjects]')[0].split(/\r?\n/).filter((l) => l.trim())
  const atTail = lines.find((l) => Number(l.split(',')[0]) === 1500) || ''
  T('只有 sliderside 时在滑条尾 1500 恢复', atTail.includes(',2,0,'), atTail)
}

console.log(`\n${fail ? `${fail} 项失败` : '全部通过'}（${pass} 项）`)
process.exit(fail ? 1 : 0)
