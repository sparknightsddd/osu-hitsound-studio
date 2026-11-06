/**
 * [Settings] 默认值：解析/生成/覆盖，以及新建与 .osu 导入是否真的用上了。
 */
import {
  DEFAULT_CHART_DEFAULTS,
  applyChartSettings,
  applyChartSettingsToText,
  chartSettingsLines,
  formatIndexList,
  parseIndexList,
} from '../src/core/chartDefaults'
import { blankHitsoundHs } from '../src/core/osuToHs'
import { fromOsu } from '../src/core/exporter'
import { TEMPLATE } from '../src/samples/demo'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

// 1) PreferredIndex 解析
ok(JSON.stringify(parseIndexList('11, 45, 14')) === '[11,45,14]', '逗号分隔')
ok(JSON.stringify(parseIndexList('{11,45,14}')) === '[11,45,14]', '带大括号')
ok(JSON.stringify(parseIndexList('11 45 14')) === '[11,45,14]', '空格分隔')
ok(JSON.stringify(parseIndexList('')) === '[]', '空 = 空列表')
ok(JSON.stringify(parseIndexList('11, x')) === 'null', '非数字返回 null')
ok(formatIndexList([11, 45, 14]) === '{11, 45, 14}', `写回大括号：${formatIndexList([11, 45, 14])}`)

// 2) 生成 [Settings] 行
{
  const lines = chartSettingsLines(DEFAULT_CHART_DEFAULTS)
  ok(lines.length === 7, `6 个开关 + 1 个编号：${lines.length}`)
  ok(lines[0] === 'AutoHitsoundIndex = true', lines[0])
  ok(lines[6] === 'PreferredIndex = {11, 45, 14}', lines[6])
  const custom = chartSettingsLines({ ...DEFAULT_CHART_DEFAULTS, SliderTickHitsound: true, PreferredIndex: [3, 2, 1] })
  ok(custom.includes('SliderTickHitsound = true'), '自定义开关')
  ok(custom.includes('PreferredIndex = {3, 2, 1}'), '自定义编号顺序')
}

// 3) 覆盖已有的 [Settings] 块：有的就地替换、位置不变，缺的补上，别的键保留
{
  const lines = ['Mode = taiko', 'AutoHitsoundIndex = false', 'Key = {1,2}', 'TimingAdsorb = beat(0,1)']
  const out = applyChartSettings(lines, { ...DEFAULT_CHART_DEFAULTS, AutoHitsoundIndex: true })
  ok(out[0] === 'Mode = taiko' && out[2] === 'Key = {1,2}', '其它键原样保留、顺序不变')
  ok(out[1] === 'AutoHitsoundIndex = true', `同键就地替换：${out[1]}`)
  ok(out.filter((l) => /^AutoHitsoundIndex/i.test(l)).length === 1, '不会重复插入')
  ok(out.some((l) => l === 'StandardFormat = false'), '缺的补在末尾')
}

// 4) 整份文本：只动 [Settings] 段
{
  const text = applyChartSettingsToText(TEMPLATE, {
    ...DEFAULT_CHART_DEFAULTS,
    SpinnerHitsound: true,
    PreferredIndex: [7],
  })
  const block = text.split('[Settings]')[1].split('[Define]')[0]
  ok(/SpinnerHitsound = true/.test(block), '写进了新值')
  ok(/PreferredIndex = \{7\}/.test(block), '编号也换了')
  ok(text.includes('[Define]\nhitsound custom D = default.normal-hitnormal'), '[Define] 没被动')
  ok(text.includes('[Timing]\n0,bpm(120),4,0,0'), '[Timing] 没被动')
  ok(!text.includes('\n\n\n'), '没有多出空行')
}

// 5) 空白音效谱 / .osu 导入也用默认值
{
  const blank = blankHitsoundHs()
  const block = blank.split('[Settings]')[1].split('[Define]')[0]
  ok(/AutoHitsoundIndex = true/.test(block), '空白谱带 AutoHitsoundIndex')
  ok(/PreferredIndex = \{11, 45, 14\}/.test(block), '空白谱带 PreferredIndex')

  const osu = `osu file format v14

[General]
AudioFilename: a.mp3

[Metadata]
Title:T
Artist:A
Creator:C

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,1,0,0:0:0:0:
`
  const imp = fromOsu(osu, TEMPLATE)
  const sblock = imp.text.split('[Settings]')[1].split('[Define]')[0]
  ok(/AutoHitsoundIndex = true/.test(sblock), '.osu 导入带 AutoHitsoundIndex')
  ok(/SliderTicketHitsound/.test(sblock) === false, '没有拼错的键')
  ok(/PreferredIndex = \{11, 45, 14\}/.test(sblock), '.osu 导入带 PreferredIndex')
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
if (bad) process.exit(1)
