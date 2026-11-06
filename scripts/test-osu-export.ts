/**
 * 音效谱 → .osu 导出规划单测（纯计算，不写盘）。
 *
 * 重点验证用户给的几条规则：
 *  - 4 种叠音组合 → 4 个音效组编号；槽位能按 s/n/d 分开时编号数会下降
 *  - 同一槽位两个代号 → 混音任务
 *  - w/f/c 跨 set 叠加 → 报错
 *  - 时间向下取整、hitSound 位、normalSet/additionSet、编号 1 不带后缀
 */
import { parseChart } from '../src/core/parse'
import { applyHitsoundTiming, osuFileName, planOsuExport } from '../src/core/osuExport'
import type { OsuExportPlan } from '../src/core/osuExport'
import type { ChartDoc } from '../src/core/types'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

/** 这个时刻生效的音效组编号 / 音量（来自 [TimingPoints]，物件本体是 0:0） */
function at(plan: OsuExportPlan, time: number): { index: number; volume: number } {
  let index = 0
  let volume = 100
  for (const t of [...plan.timing].sort((a, b) => a.offset - b.offset || b.uninherited - a.uninherited)) {
    if (t.offset > time) break
    index = t.sampleIndex
    volume = t.volume
  }
  return { index, volume }
}
const timeOf = (line: string) => Number(line.split(',')[2])

const HEAD = (define: string, body: string, timing = '0,bpm(120),4,0,0') => `[Metadata]
Title = export
Artist = tester
Creator = tester

[Files]
path = "E:/tmp"
audio = "audio.mp3"

[Define]
${define}

[Timing]
${timing}

[Hitsound]
#0
${body}
`

/** 直接给事件指定时间/代号，测取整与字段拼装（planOsuExport 不依赖小节） */
function withEvents(doc: ChartDoc, spec: { time: number; names: string[] }[]): ChartDoc {
  const base = doc.events[0]
  return { ...doc, events: spec.map((s) => ({ ...base, time: s.time, names: s.names })) }
}

// 1) 两个 whistle × 两个 clap，固定 soft：4 种组合 → 4 个编号
{
  const doc = parseChart(
    HEAD(
      [
        'hitsound soft-hitwhistle Aa = "a.wav"',
        'hitsound soft-hitwhistle Ab = "b.wav"',
        'hitsound soft-hitclap Ac = "c.wav"',
        'hitsound soft-hitclap Ad = "d.wav"',
      ].join('\n'),
      '/[Aa Ac] [Ab Ac] [Aa Ad] [Ab Ad]/',
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `没有报错：${plan.errors.join(' / ')}`)
  ok(plan.groups.length === 4, `4 种组合 → 4 个编号：${plan.groups.length}`)
  ok(plan.hitObjects.length === 4, `4 个物件：${plan.hitObjects.length}`)
  ok(
    plan.files.every((f) => /^(soft-hitwhistle|soft-hitclap)[1-4]?\.wav$/.test(f.to)),
    `文件名符合标准格式：${plan.files.map((f) => f.to).join(', ')}`,
  )
  ok(
    plan.files.some((f) => f.to === 'soft-hitwhistle.wav') && !plan.files.some((f) => f.to.includes('1.')) ,
    '1 号编号不带数字后缀',
  )
}

// 2) 只写 hitwhistle / hitclap：编号能复用，4 种组合只要 2 个
{
  const doc = parseChart(
    HEAD(
      [
        'hitsound hitwhistle Aa = "a.wav"',
        'hitsound hitwhistle Ab = "b.wav"',
        'hitsound hitclap Ac = "c.wav"',
        'hitsound hitclap Ad = "d.wav"',
      ].join('\n'),
      '/[Aa Ac] [Ab Ac] [Aa Ad] [Ab Ad]/',
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `没有报错：${plan.errors.join(' / ')}`)
  ok(plan.groups.length === 2, `槽位可分散到 s/n/d，编号降到 2 个：${plan.groups.length}`)
}

// 3) 同一槽位两个代号 → 混音
{
  const doc = parseChart(
    HEAD(
      ['hitsound soft-hitwhistle Aa = "a.wav"', 'hitsound soft-hitwhistle Ab = "b.wav"'].join('\n'),
      '/[Aa Ab] Aa/',
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `没有报错：${plan.errors.join(' / ')}`)
  ok(plan.mixCount === 1, `[Aa Ab] 产生 1 个混音任务：${plan.mixCount}`)
  const mixed = plan.files.find((f) => f.mix)
  ok(!!mixed && mixed.from.length === 2, `混音源是两份：${mixed?.from.join(' + ')}`)
  ok(!!mixed && mixed.to === 'soft-hitwhistle.wav', `混音输出用标准名：${mixed?.to}`)
}

// 4) default 音效不复制，也不参与混音
{
  const doc = parseChart(
    HEAD(
      ['hitsound soft-hitwhistle Aa = "a.wav"', 'hitsound normal-hitnormal Ak = default.normal-hitnormal'].join('\n'),
      '/[Aa Ak]/',
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `没有报错：${plan.errors.join(' / ')}`)
  ok(plan.files.length === 1 && plan.files[0].to === 'soft-hitwhistle.wav', `只复制自定义那份：${plan.files.map((f) => f.to).join(', ')}`)
  ok(plan.files[0].defaults.length === 0 && !plan.files[0].mix, 'default 不复制、不混音')
  const line = plan.hitObjects[0]
  ok(line.endsWith(',1:2:0:0:'), `hitnormal 用 normalSet=1，addition 用 soft=2：${line}`)
  const g = at(plan, timeOf(line))
  ok(g.index === 1 && g.volume === 100, `编号/音量在绿线上：${g.index}/${g.volume}`)
}

// 4b) 只有 clap 的组合：osu 仍会播基础 hitnormal，不能串到别人的 hitnormal 槽位
{
  const doc = parseChart(
    HEAD(
      [
        'hitsound soft-hitwhistle Aa = "a.wav"',
        'hitsound soft-hitclap Bb = "b.wav"',
        'hitsound soft-hitnormal Cc = "c.wav"',
      ].join('\n'),
      '/[Aa Cc] Bb/',
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `没有报错：${plan.errors.join(' / ')}`)
  const withNormal = plan.hitObjects.find((l) => l.includes(',3,')) || ''
  const onlyClap = plan.hitObjects.find((l) => l.includes(',8,')) || ''
  ok(withNormal.endsWith(',2:2:0:0:'), `第一个组合 hitnormal 用 soft：${withNormal}`)
  ok(at(plan, timeOf(withNormal)).index === 1, `第一个组合用 1 号：${at(plan, timeOf(withNormal)).index}`)
  ok(onlyClap.endsWith(',2:2:0:0:'), `只有 clap 的组合用白板 hitnormal：${onlyClap}`)
  ok(at(plan, timeOf(onlyClap)).index === 2, `只有 clap 的组合单独一个编号：${at(plan, timeOf(onlyClap)).index}`)
  ok(
    !plan.files.some((f) => f.to === 'soft-hitnormal.wav' && !f.from.some((p) => p.endsWith('c.wav'))),
    'soft-hitnormal.wav 只放 Cc',
  )
  ok(!plan.files.some((f) => f.to === 'soft-hitnormal2.wav'), '白板是默认音效，不复制 hitnormal 文件')
}

// 5) 槽位冲突：soft-hitwhistle + normal-hitclap
{
  const doc = parseChart(
    HEAD(
      ['hitsound soft-hitwhistle Aa = "a.wav"', 'hitsound normal-hitclap Ab = "b.wav"'].join('\n'),
      '/[Aa Ab]/',
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.some((e) => e.includes('槽位')), `跨 set 叠音报错：${plan.errors.join(' / ')}`)
  ok(plan.hitObjects.length === 0, '冲突的组合不导出物件')
}

// 6) 时间向下取整 + hitSound 位
{
  const doc = parseChart(
    HEAD(
      ['hitsound soft-hitwhistle Aa = "a.wav"', 'hitsound soft-hitclap Ab = "b.wav"'].join('\n'),
      '/[Aa Ab] Aa/',
    ),
  )
  const timed = withEvents(doc, [
    { time: 57279.67, names: ['Aa', 'Ab'] },
    { time: 60000.2, names: ['Aa'] },
  ])
  const plan = planOsuExport(timed)
  ok(plan.hitObjects[0].startsWith('256,192,57279,1,10,'), `向下取整到 57279 且 hitSound=10：${plan.hitObjects[0]}`)
  ok(plan.hitObjects[1].startsWith('256,192,60000,1,2,'), `第二个 60000 且 hitSound=2：${plan.hitObjects[1]}`)
}

// 7) 显式 alt 顺序：soft-hitwhistle|normal-hitwhistle 优先 soft
{
  const doc = parseChart(
    HEAD(
      [
        'hitsound soft-hitwhistle|normal-hitwhistle Aa = "a.wav"',
        'hitsound normal-hitclap|soft-hitclap Ab = "b.wav"',
      ].join('\n'),
      '/[Aa Ab]/',
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `显式 alt 不报错：${plan.errors.join(' / ')}`)
  // Aa 优先 soft，Ab 优先 normal → 冲突；只有把 Ab 退到 soft 才能成立
  const line = plan.hitObjects[0] || ''
  ok(line.includes(',10,'), `最终落在同一 set：${line}`)
}

// 8) 自定义白板：无名定义是 soft-hitnormal，导出时每个用到的编号都要带一份
{
  const doc = parseChart(
    HEAD(['hitsound soft-hitnormal = "wb.wav"', 'hitsound soft-hitclap Bb = "b.wav"'].join('\n'), '/Bb/'),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `没有报错：${plan.errors.join(' / ')}`)
  const wb = plan.files.find((f) => f.to === 'soft-hitnormal.wav')
  ok(!!wb && wb.from.some((p) => p.endsWith('wb.wav')), `白板音效被复制成 soft-hitnormal.wav：${wb?.from.join(', ')}`)
  ok(plan.files.some((f) => f.to === 'soft-hitclap.wav'), 'clap 也在同一个编号里')
}

// 9) PreferredIndex：编号按 11, 45, 14, 1, 2…
{
  const head = `[Metadata]
Title = order
Artist = tester
Creator = tester

[Files]
path = "E:/tmp"
audio = "audio.mp3"

[Settings]
PreferredIndex = {11, 45, 14}

[Define]
hitsound soft-hitwhistle Aa = "a.wav"
hitsound soft-hitclap Ab = "b.wav"
hitsound soft-hitwhistle Ac = "c.wav"
hitsound soft-hitclap Ad = "d.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/[Aa Ab] [Ac Ab] [Aa Ad] [Ac Ad]/
`
  const plan = planOsuExport(parseChart(head))
  ok(plan.groups.map((g) => g.index).join(',') === '11,45,14,1', `编号顺序：${plan.groups.map((g) => g.index).join(',')}`)
  ok(
    plan.hitObjects[0].endsWith(':0:0:') && at(plan, timeOf(plan.hitObjects[0])).index === 11,
    `第一行用 11 号（在绿线上）：${plan.hitObjects[0]}`,
  )
  ok(plan.files.some((f) => f.to === 'soft-hitwhistle11.wav'), '文件也按 11 命名')
  ok(plan.files.some((f) => f.to === 'soft-hitclap45.wav'), '第二个编号 45')
}

// 10) 「另存为」用的默认文件名
{
  const doc = parseChart(HEAD(['hitsound soft-hitclap Aa = "a.wav"'].join('\n'), '/Aa/'))
  ok(osuFileName(doc) === 'tester - export (tester) [[EZHS]].osu', `标准文件名：${osuFileName(doc)}`)
  const noCreator = { ...doc, metadata: { ...doc.metadata, Creator: '' } }
  ok(osuFileName(noCreator) === 'tester - export [[EZHS]].osu', `没有 creator：${osuFileName(noCreator)}`)
  const dirty = { ...doc, metadata: { ...doc.metadata, Title: 'A/B: C?' } }
  ok(osuFileName(dirty) === 'tester - A_B_ C_ (tester) [[EZHS]].osu', `非法字符被替换：${osuFileName(dirty)}`)
}

// 11) 编号/音量搬到绿线：[HitObjects] 一律以 :0:0: 结尾
{
  const doc = parseChart(
    HEAD(
      [
        'hitsound soft-hitclap Aa = "a.wav"',
        'hitsound soft-hitwhistle Ab = "b.wav"',
        'hitsound soft-hitclap Ac = "c.wav"',
      ].join('\n'),
      [
        '#0',
        '/<v=58> [Aa Ab] = = = = = = = = = = = = = = = =/',
        '#4000',
        '/<v=30> [Ac Ab]/',
        '#8000',
        '/<v=45> [Aa Ab]/',
      ].join('\n'),
    ),
  )
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `没有报错：${plan.errors.join(' / ')}`)
  const hs = plan.hitObjects.map((l) => l.split(',')[5].split(':'))
  ok(hs.every((x) => x[2] === '0' && x[3] === '0'), '[HitObjects] 全部以 :0:0: 结尾')
  // 0ms 正好落在红线上 → 改红线，不额外加线
  ok(plan.timing[0].sampleIndex === 1 && plan.timing[0].volume === 58, '落在红线上的音效改红线')
  ok(plan.timing.filter((t) => t.uninherited === 0).length === 2, `后面两次音量变化各补一条绿线：${plan.greenLines}`)
  const line = plan.text.split('[TimingPoints]')[1].split('[HitObjects]')[0]
  ok(/,58,1,0/.test(line), '58% 音量写在红线上')
  ok(/,30,0,0/.test(line) && /,45,0,0/.test(line), '30% / 45% 音量写在绿线上')
}

// 12) applyHitsoundTiming：只在编号/音量变了才加线
{
  const base = [
    { offset: 0, beatLength: 500, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 1 as const, effects: 0 },
  ]
  const r = applyHitsoundTiming(base, [
    { time: 100, index: 11, volume: 58, set: 2 },
    { time: 500, index: 11, volume: 58, set: 2 }, // 兼容，复用
    { time: 900, index: 11, volume: 30, set: 2 }, // 只音量变
    { time: 1300, index: 45, volume: 30, set: 3 }, // 编号变
  ])
  ok(r.added === 3 && r.retargeted === 0, `加了 3 条绿线：added=${r.added} retargeted=${r.retargeted}`)
  ok(r.lines.length === 4, `红线 1 + 绿线 3：${r.lines.length}`)
  const greens = r.lines.filter((l) => l.uninherited === 0)
  ok(greens.every((l) => l.beatLength === -100), 'SV 用 -100（1.0x），不影响滑条速度')
  ok(greens[1].volume === 30 && greens[1].sampleIndex === 11, '音量变化保留原编号')
  ok(greens[2].sampleIndex === 45 && greens[2].sampleSet === 3, '编号变化带上新的采样组')
  ok(
    r.lines.every((l, i, arr) => i === 0 || arr[i - 1].offset <= l.offset),
    '按时间排好序',
  )
}

// 13) 物件正好落在红线上：改红线，不加绿线
{
  const lines = [
    { offset: 0, beatLength: 500, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 1 as const, effects: 0 },
    { offset: 1000, beatLength: 400, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 1 as const, effects: 0 },
  ]
  const r = applyHitsoundTiming(lines, [{ time: 1000, index: 11, volume: 58, set: 2 }])
  ok(r.added === 0 && r.retargeted === 1, `改红线而不是加绿线：added=${r.added}`)
  const red = r.lines.find((l) => l.offset === 1000)!
  ok(red.sampleIndex === 11 && red.volume === 58 && red.sampleSet === 2, '红线的编号/音量被改写')
  ok(red.beatLength === 400 && red.uninherited === 1, 'BPM 不受影响')
}

// 14) 红绿线重叠：两条都要改成一样的编号/音量
{
  const lines = [
    { offset: 0, beatLength: 500, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 1 as const, effects: 0 },
    { offset: 1000, beatLength: 400, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 1 as const, effects: 0 },
    { offset: 1000, beatLength: -50, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 0 as const, effects: 0 },
  ]
  const r = applyHitsoundTiming(lines, [{ time: 1000, index: 14, volume: 40, set: 1 }])
  const both = r.lines.filter((l) => l.offset === 1000)
  ok(both.length === 2, `同一时刻两条线：${both.length}`)
  ok(both.every((l) => l.sampleIndex === 14 && l.volume === 40), '两条线都改成 14 号 / 40%')
  ok(both.find((l) => l.uninherited === 0)!.beatLength === -50, '绿线原来的 SV 保留')
}

// 15) 之后的绿线沿用当前 SV，不会把滑条速度打回 1.0
{
  const lines = [
    { offset: 0, beatLength: 500, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 1 as const, effects: 0 },
    { offset: 500, beatLength: -50, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 80, uninherited: 0 as const, effects: 0 },
  ]
  const r = applyHitsoundTiming(lines, [{ time: 900, index: 11, volume: 30, set: 2 }])
  const added = r.lines.find((l) => l.offset === 900)!
  ok(added.beatLength === -50, `新绿线沿用 -50（2.0x）：${added.beatLength}`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
