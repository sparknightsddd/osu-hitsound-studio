/**
 * 时间轴「槽位」视图的数据来源单测：
 * planSlotAssignments 只做装箱，但必须和 planOsuExport 得到完全一样的槽位 / 音效组编号。
 */
import { parseChart } from '../src/core/parse'
import { planOsuExport, planSlotAssignments } from '../src/core/osuExport'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const HEAD = (define: string, body: string, timing = '0,bpm(120),4,0,0') => `[Metadata]
Title = slot
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
${body}`

const DEF = [
  'hitsound soft-hitwhistle Aa = "a.wav"',
  'hitsound soft-hitfinish Bb = "b.wav"',
  'hitsound soft-hitwhistle Cc = "c.wav"',
  'hitsound soft-hitclap Dd = "d.wav"',
].join('\n')

// 1) 两个叠音组合：sw 槽位被不同音色占用，必须分成两个编号
{
  const doc = parseChart(HEAD(DEF, '/[Aa Bb] = = = = = = = = [Cc Dd] = = = = = =/'))
  const sp = planSlotAssignments(doc)
  const plan = planOsuExport(doc)
  ok(sp.errors.length === 0, `没有报错：${sp.errors.join(' / ')}`)
  ok(plan.errors.length === 0, `导出也没有报错：${plan.errors.join(' / ')}`)
  ok(sp.combos.length === 2, `两个组合：${sp.combos.length}`)
  ok(sp.groups.length === 2, `两个音效组编号：${sp.groups.length}`)
  ok(sp.groups.length === plan.groups.length, '和导出计划的编号数一致')

  const c0 = sp.combos.find((c) => c.names.includes('Aa'))!
  const c1 = sp.combos.find((c) => c.names.includes('Cc'))!
  ok(c0.group === 1, `第一个组合用 1 号：${c0.group}`)
  ok(c1.group === 2, `第二个组合的 sw 冲突，单独用 2 号：${c1.group}`)
  ok(c0.assign?.byName.get('Aa') === 'soft-hitwhistle', `Aa 落 sw：${c0.assign?.byName.get('Aa')}`)
  ok(c0.assign?.byName.get('Bb') === 'soft-hitfinish', `Bb 落 sf：${c0.assign?.byName.get('Bb')}`)
  ok(c1.assign?.byName.get('Cc') === 'soft-hitwhistle', `Cc 落 sw：${c1.assign?.byName.get('Cc')}`)
  ok(c1.assign?.byName.get('Dd') === 'soft-hitclap', `Dd 落 sc：${c1.assign?.byName.get('Dd')}`)

  // 时间轴视图就是按 occurrences 的 time 找到 combo，再读 group / byName
  for (const o of sp.occurrences) {
    const sample = plan.samples.get(o.time)
    ok(!!sample, `${o.time}ms 有导出样本`)
    ok(sample?.group === o.combo.group, `${o.time}ms 编号与视图一致：${sample?.group}/${o.combo.group}`)
    ok(
      (sample?.names || []).join('+') === o.combo.names.join('+'),
      `${o.time}ms 组合成员一致：${sample?.names.join('+')}`,
    )
  }

  // 同一组合出现两次：编号要复用
  const doc2 = parseChart(HEAD(DEF, '/[Aa Bb] = = = = = = = = [Aa Bb] = = = = = =/'))
  const sp2 = planSlotAssignments(doc2)
  ok(sp2.combos.length === 1, `相同组合合并成一个：${sp2.combos.length}`)
  ok(sp2.groups.length === 1, `复用同一个编号：${sp2.groups.length}`)
  ok(sp2.combos[0].count === 2, `出现 2 次：${sp2.combos[0].count}`)
}

// 2) 排不出合法槽位的组合：视图里 group 为空（画成虚线 + ?），导出也会跳过
{
  const doc = parseChart(
    HEAD(
      ['hitsound soft-hitwhistle Aa = "a.wav"', 'hitsound normal-hitclap Bb = "b.wav"'].join('\n'),
      '/[Aa Bb]/',
    ),
  )
  const sp = planSlotAssignments(doc)
  const plan = planOsuExport(doc)
  ok(sp.errors.some((e) => e.includes('槽位')), `有槽位错误：${sp.errors.join(' / ')}`)
  ok(plan.errors.join('|') === sp.errors.join('|'), '导出错误与视图数据一致')
  ok(sp.skippedCombos.length === 1, `跳过 1 个组合：${sp.skippedCombos.length}`)
  ok(sp.combos[0].group === undefined && !sp.combos[0].assign, '冲突组合没有编号 / 槽位')
  ok(plan.samples.size === 0, `冲突组合不导出样本：${plan.samples.size}`)
}

// 3) 编号优先顺序也一致：PreferredIndex 先 11 / 45
{
  const doc = parseChart(
    HEAD(
      DEF,
      '/[Aa Bb] = = = = = = = = [Cc Dd] = = = = = =/',
      '0,bpm(120),4,0,0',
    ).replace('[Timing]\n', '[Settings]\nPreferredIndex = {11,45}\n\n[Timing]\n'),
  )
  const sp = planSlotAssignments(doc)
  ok(sp.groups[0]?.index === 11, `第一个编号用 11：${sp.groups[0]?.index}`)
  ok(sp.groups[1]?.index === 45, `第二个编号用 45：${sp.groups[1]?.index}`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
