/**
 * 音效组编号的「原样往返」规则。
 *
 * 重点是导入的 `.hs` 正文里带着 `<n>`（原 .osu 的 sampleIndex）时：
 *  - 导出必须沿用这个编号，不能按 PreferredIndex 另起一套；
 *  - 同名音效在不同编号下要拆成两组（对应不同的音频文件）；
 *  - 源文件本来就是无编号基础名时，不复制成带编号的新文件（osu 会回落）；
 *  - 编号真的被冲突占用时才换号，并给出 warning。
 */
import { parseChart } from '../src/core/parse'
import {
  DEFAULT_SLOT_ORDER,
  fileSampleIndex,
  planOsuExport,
  planSlotAssignments,
  setExportTranslator,
} from '../src/core/osuExport'

// 这个测试想按「原谱编号被占用」的**内容**判断，而不是中文原文。
// 注入一个把占位符替换成真实参数的翻译（和应用的 t() 同一套语义），
// 这样断言看编号值，不依赖文案语言。
setExportTranslator((msg, vars) =>
  msg.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m)),
)

let pass = 0
let fail = 0
function T(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

function chart(body: string, defs: string[], settings: string[] = []): string {
  return [
    '[Metadata]',
    'Title = t',
    '[Files]',
    'path = "E:/map"',
    'audio = ""',
    '[Settings]',
    'Mode = default',
    ...settings,
    '[Define]',
    ...defs,
    '[Timing]',
    '0,bpm(120),4,0,0',
    '[Hitsound]',
    body,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 文件名 → 编号
// ---------------------------------------------------------------------------
{
  T('soft-hitclap.ogg 是编号 1', fileSampleIndex('soft-hitclap.ogg') === 1)
  T('soft-hitclap2.ogg 是编号 2', fileSampleIndex('soft-hitclap2.ogg') === 2)
  T('drum-hitwhistle44.wav 是编号 44', fileSampleIndex('drum-hitwhistle44.wav') === 44)
  T('非标准命名返回 null', fileSampleIndex('clap-a.ogg') === null)
}

// ---------------------------------------------------------------------------
// 1) 正文里的编号会被沿用（不是 PreferredIndex 的 11）
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart(
      '/2 Aa = = = = = = =/',
      ['hitsound soft-hitwhistle Aa = "soft-hitwhistle44.ogg"'],
      ['PreferredIndex = {11, 45, 14}'],
    ),
  )
  const plan = planSlotAssignments(doc)
  T('事件读到了编号 2', doc.events[0]?.index === 2, String(doc.events[0]?.index))
  T('组合记录了 want=2', plan.combos[0]?.want === 2, String(plan.combos[0]?.want))
  T('编号组用的是 2 而不是 11', plan.groups[0]?.index === 2, JSON.stringify(plan.groups))
  const out = planOsuExport(doc)
  T(
    '导出的文件名是 soft-hitwhistle2.ogg（编号 2）',
    out.files[0]?.to === 'soft-hitwhistle2.ogg',
    JSON.stringify(out.files.map((f) => f.to)),
  )
  T('物件/绿线也写编号 2', out.hitObjects[0]?.endsWith(',2:2:0:0:') === true && out.timing.some((t) => t.sampleIndex === 2), out.hitObjects[0])
}

// ---------------------------------------------------------------------------
// 2) 同样的音效、不同编号 → 两组，各自对应自己的文件
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart(
      '/2 Aa = = = 3 Aa = = =/',
      ['hitsound soft-hitwhistle Aa = "soft-hitwhistle2.ogg"'],
      ['PreferredIndex = {11}'],
    ),
  )
  const plan = planSlotAssignments(doc)
  T('拆成两个组合', plan.combos.length === 2, String(plan.combos.length))
  T(
    '两个编号组 2 / 3',
    plan.groups.map((g) => g.index).sort((a, b) => a - b).join(',') === '2,3',
    JSON.stringify(plan.groups.map((g) => g.index)),
  )
  const out = planOsuExport(doc)
  T(
    '文件名分别是 2 / 3',
    out.files.map((f) => f.to).sort().join(',') === 'soft-hitwhistle2.ogg,soft-hitwhistle3.ogg',
    JSON.stringify(out.files.map((f) => f.to)),
  )
}

// ---------------------------------------------------------------------------
// 3) 文件本来就叫基础名（无编号）→ 不再复制一份带编号的
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart(
      '/44 Aa = = =/',
      ['hitsound soft-hitclap Aa = "soft-hitclap.ogg"'],
      ['PreferredIndex = {11}'],
    ),
  )
  const out = planOsuExport(doc)
  T('编号仍是 44', out.groups[0]?.index === 44, JSON.stringify(out.groups))
  T('没有生成 soft-hitclap44 文件任务', out.files.length === 0, JSON.stringify(out.files.map((f) => f.to)))
}
{
  const doc = parseChart(
    chart('/1 Aa = = =/', ['hitsound soft-hitclap Aa = "soft-hitclap.ogg"']),
  )
  const out = planOsuExport(doc)
  T('编号 1 时照常写基础名', out.files[0]?.to === 'soft-hitclap.ogg', JSON.stringify(out.files.map((f) => f.to)))
}

// ---------------------------------------------------------------------------
// 4) 编号被冲突占用 → 换号 + warning（只在真的排不下时）
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart(
      '/5 Aa = = = 5 Bb = = =/',
      [
        'hitsound soft-hitclap Aa = "soft-hitclap5.ogg"',
        'hitsound soft-hitclap Bb = "soft-hitclap6.ogg"',
      ],
      ['PreferredIndex = {11}'],
    ),
  )
  const out = planOsuExport(doc)
  const idx = out.groups.map((g) => g.index).sort((a, b) => a - b)
  T('第一组保住 5，第二组换到 11', idx.join(',') === '5,11', JSON.stringify(idx))
  T(
    '给出换号提示',
    out.warnings.some((w) => w.includes('编号 5') && w.includes('编号 11')),
    out.warnings.join(' | '),
  )
}

// ---------------------------------------------------------------------------
// 5) 没写编号（手写谱）→ 仍然按 PreferredIndex 分配
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart('/Aa = = =/', ['hitsound soft-hitclap Aa = "soft-hitclap.ogg"'], ['PreferredIndex = {45, 11}']),
  )
  const out = planOsuExport(doc)
  T('没有编号时用 PreferredIndex 第一个值 45', out.groups[0]?.index === 45, JSON.stringify(out.groups))
}

// ---------------------------------------------------------------------------
// 6) 同一个编号下多个槽位可以共存（soft-hitclap2 + soft-hitwhistle2）
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart(
      '/2 [Aa Bb] = = =/',
      [
        'hitsound soft-hitclap Aa = "soft-hitclap2.ogg"',
        'hitsound soft-hitwhistle Bb = "soft-hitwhistle2.ogg"',
      ],
    ),
  )
  const out = planOsuExport(doc)
  T('只有一个编号组', out.groups.length === 1 && out.groups[0].index === 2, JSON.stringify(out.groups))
  T(
    '两个槽位各写自己的文件',
    out.files.map((f) => f.to).sort().join(',') === 'soft-hitclap2.ogg,soft-hitwhistle2.ogg',
    JSON.stringify(out.files.map((f) => f.to)),
  )
}

// ---------------------------------------------------------------------------
// 7) 默认槽位顺序不受 [Define] 书写顺序影响（编号只看正文）
// ---------------------------------------------------------------------------
{
  const defsA = [
    'hitsound soft-hitclap Aa = "soft-hitclap7.ogg"',
    'hitsound soft-hitwhistle Bb = "soft-hitwhistle7.ogg"',
  ]
  const defsB = [...defsA].reverse()
  const body = '/7 [Aa Bb] = = =/'
  const a = planSlotAssignments(parseChart(chart(body, defsA)))
  const b = planSlotAssignments(parseChart(chart(body, defsB)))
  T('换 [Define] 顺序，编号不变', a.groups[0]?.index === b.groups[0]?.index && a.groups[0]?.index === 7)
  T(
    '换 [Define] 顺序，槽位映射不变',
    JSON.stringify([...(a.groups[0]?.slots || [])].sort()) === JSON.stringify([...(b.groups[0]?.slots || [])].sort()),
  )
  T('默认槽位顺序仍是 9 个', DEFAULT_SLOT_ORDER.length === 9)
}

// ---------------------------------------------------------------------------
// 8) 原谱编号不会锁死后续修改
//    a) 新音效用的是 5 号还没有的槽位 → 直接并进 5 号
//    b) 5 号同一槽位已经有一份不同的音色 → 整组换号（并提示），不会串音
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart(
      '/5 [Aa Bb]/',
      [
        'hitsound soft-hitclap Aa = "soft-hitclap5.ogg"',
        'hitsound soft-hitwhistle Bb = "soft-hitwhistle5.ogg"',
      ],
      ['PreferredIndex = {11, 45}'],
    ),
  )
  const out = planOsuExport(doc)
  T('5 号没有的槽位直接并进去（编号仍是 5）', out.groups.length === 1 && out.groups[0].index === 5, JSON.stringify(out.groups.map((g) => g.index)))
  T(
    '5 号原来 + 新增槽位各一份文件',
    out.files.map((f) => f.to).sort().join(',') === 'soft-hitclap5.ogg,soft-hitwhistle5.ogg',
    JSON.stringify(out.files.map((f) => f.to)),
  )
}
{
  const doc = parseChart(
    chart(
      '/5 [Aa Bb] = 5 Cc/',
      [
        'hitsound soft-hitclap Aa = "soft-hitclap5.ogg"',
        'hitsound soft-hitwhistle Bb = "soft-hitwhistle5.ogg"',
        'hitsound soft-hitclap Cc = "soft-hitclap6.ogg"',
      ],
      ['PreferredIndex = {11, 45}'],
    ),
  )
  const out = planOsuExport(doc)
  T('同一槽位冲突时整组换号（5 / 11）', out.groups.map((g) => g.index).sort((a, b) => a - b).join(',') === '5,11', JSON.stringify(out.groups.map((g) => g.index)))
  T(
    '旧音效仍用 5 号的文件',
    out.files.some((f) => f.to === 'soft-hitclap5.ogg' && f.from.some((p) => p.endsWith('soft-hitclap5.ogg'))),
    JSON.stringify(out.files.map((f) => f.to)),
  )
  T(
    '新音效写到 11 号（不覆盖 5 号）',
    out.files.some((f) => f.to === 'soft-hitclap11.ogg' && f.from.some((p) => p.endsWith('soft-hitclap6.ogg'))),
    JSON.stringify(out.files.map((f) => f.to)),
  )
  T('换号有提示', out.warnings.some((w) => w.includes('编号 5') && w.includes('编号 11')), out.warnings.join(' | '))
}

// ---------------------------------------------------------------------------
// 9) 两个代号指向同一个文件 = 同一个声音，可以共用编号
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    chart(
      '/5 Aa = 5 Bb/',
      [
        'hitsound soft-hitclap Aa = "soft-hitclap5.ogg"',
        'hitsound soft-hitclap Bb = "soft-hitclap5.ogg"',
      ],
      ['PreferredIndex = {11}'],
    ),
  )
  const out = planOsuExport(doc)
  T('同文件不同代号共用一个编号', out.groups.length === 1 && out.groups[0].index === 5, JSON.stringify(out.groups.map((g) => g.index)))
  T('只产生一个文件名', out.files.map((f) => f.to).join(',') === 'soft-hitclap5.ogg', JSON.stringify(out.files.map((f) => f.to)))
}

console.log(`\n${fail ? `${fail} 项失败` : '全部通过'}（${pass} 项）`)
process.exit(fail ? 1 : 0)
