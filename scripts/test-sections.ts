/**
 * [Settings] Sections 的解析 / 回写单测（不启动 Electron）。
 */
import { parseChart } from '../src/core/parse'
import { formatSections, updateSectionsText } from '../src/core/sections'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const BASE = `[Metadata]
Title = sections

[Settings]
Mode = default
Bookmarks = 1000, 2000

[Files]
path = ""
audio = ""

[Define]
hitsound custom Aa = default.soft-hitnormal red

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa = = = = = = = = = = = = = = =/
`

// 1) 解析
{
  const text = BASE.replace(
    'Bookmarks = 1000, 2000',
    'Bookmarks = 1000, 2000\nSections = { ( 0 , "Intro" ) , ( 2000 , "Chorus" ) }',
  )
  const doc = parseChart(text)
  ok(doc.settings.Sections.length === 2, `解析出 2 个分节符：${doc.settings.Sections.length}`)
  ok(
    doc.settings.Sections[0].name === 'Intro' &&
      doc.settings.Sections[0].time === 0 &&
      doc.settings.Sections[1].name === 'Chorus' &&
      doc.settings.Sections[1].time === 2000,
    `时间/名称正确：${JSON.stringify(doc.settings.Sections)}`,
  )
}

// 2) 格式化（和需求里的例子一致）
{
  const line = formatSections([
    { time: 345678, name: 'uvwxyz' },
    { time: 123456, name: 'abcdef' },
  ])
  ok(
    line === 'Sections = { ( 123456 , "abcdef" ) , ( 345678 , "uvwxyz" ) }',
    `格式与排序：${line}`,
  )
  ok(formatSections([]) === '', '空列表返回空串')
}

// 3) 已有 Sections 行 → 替换
{
  const text = BASE.replace(
    'Bookmarks = 1000, 2000',
    'Bookmarks = 1000, 2000\nSections = { ( 0 , "Old" ) }',
  )
  const out = updateSectionsText(text, [{ time: 2000, name: 'New' }])
  ok(out.includes('Sections = { ( 2000 , "New" ) }'), '替换已有行')
  ok(!out.includes('"Old"'), '旧值被移除')
  ok(out.includes('Bookmarks = 1000, 2000'), '其它 Settings 行不变')
  ok(out.split('\n').filter((l) => /^Sections\s*=/.test(l)).length === 1, '只有一行 Sections')
}

// 4) 没有 Sections 行 → 追加到 [Settings] 末尾（下一段之前）
{
  const out = updateSectionsText(BASE, [{ time: 4000, name: 'Bridge' }])
  ok(out.includes('Bookmarks = 1000, 2000\nSections = { ( 4000 , "Bridge" ) }\n'), '追加在 Settings 末尾')
  const iS = out.indexOf('[Settings]')
  const iF = out.indexOf('[Files]')
  const iSec = out.indexOf('Sections =')
  ok(iS >= 0 && iSec > iS && iSec < iF, '位置在 [Settings] 与 [Files] 之间')
  const doc = parseChart(out)
  ok(doc.settings.Sections.length === 1 && doc.settings.Sections[0].name === 'Bridge', '回读正确')
}

// 5) 列表清空 → 删除整行
{
  const text = BASE.replace(
    'Bookmarks = 1000, 2000',
    'Bookmarks = 1000, 2000\nSections = { ( 0 , "Old" ) }',
  )
  const out = updateSectionsText(text, [])
  ok(!/^\s*Sections\s*=/m.test(out), '空列表删掉 Sections 行')
  ok(out.includes('Bookmarks = 1000, 2000'), '其它行保留')
}

// 6) 名字里的引号 / 反斜杠
{
  const out = updateSectionsText(BASE, [{ time: 1000, name: 'A "B" \\ C' }])
  const line = out.split('\n').find((l) => l.startsWith('Sections')) || ''
  ok(line.includes('\\"B\\"') && line.includes('\\\\'), `引号/反斜杠转义：${line}`)
  const doc = parseChart(out)
  ok(doc.settings.Sections[0]?.name === 'A "B" \\ C', `转义后回读：${doc.settings.Sections[0]?.name}`)
}

// 7) 没有 [Settings] → 补一段
{
  const text = `[Metadata]
Title = no settings

[Define]
hitsound custom Aa = default.soft-hitnormal

[Timing]
0,bpm(120),4,0,0

[Hitsound]
/Aa/
`
  const out = updateSectionsText(text, [{ time: 0, name: 'Start' }])
  ok(out.includes('[Settings]\nSections = { ( 0 , "Start" ) }'), '补出 [Settings] 段')
  ok(out.indexOf('[Settings]') < out.indexOf('[Define]'), '[Settings] 在 [Define] 之前')
  const doc = parseChart(out)
  ok(doc.settings.Sections.length === 1, '回读成功')
}

// 8) 乱写的 Sections 不崩，给 warning
{
  const doc = parseChart(BASE.replace('Bookmarks = 1000, 2000', 'Bookmarks = 1000, 2000\nSections = { oops }'))
  ok(doc.settings.Sections.length === 0, '非法格式解析为空')
  ok(
    doc.diagnostics.some((d) => d.code === 'set-sections'),
    '有 set-sections 警告',
  )
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
