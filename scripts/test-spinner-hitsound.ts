/**
 * 转盘音效应当落在**转盘尾**（endTime），不是转盘头。
 *
 * osu! 的 spinner 在转完的那一刻才播 hitSample；把音效放在开头会导致
 * 整段转盘期间音效提前响（听感上「音效位置错了」）。
 */
import { extractOsuSounds } from '../src/core/osuSounds'

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Spinner Test
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,1,2,0:0:0:0:
256,192,1000,8,2,5000,0:0:0:0:
256,192,6000,1,0,0:0:0:0:
`

const res = await extractOsuSounds(OSU)
const rows = res.sounds.map((s) => ({
  time: s.time,
  source: s.source,
  hit: s.code.hitType,
  set: s.code.sampleSet,
}))
console.log('SOUNDS', JSON.stringify(rows))

let pass = 0
let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

const spinner = rows.filter((r) => r.source === '转盘')
const others = rows.filter((r) => r.source !== '转盘')

T('转盘只产出一个音效（不补 hitnormal）', spinner.length === 1, JSON.stringify(spinner))
T('转盘音效在转盘尾 5000ms', spinner[0]?.time === 5000, String(spinner[0]?.time))
T('转盘音效不在转盘头 1000ms', spinner.every((r) => r.time !== 1000), JSON.stringify(spinner.map((r) => r.time)))
T('转盘音效类型是 whistle', spinner[0]?.hit === 'hitwhistle', String(spinner[0]?.hit))
// 普通 circle 会同时补基础 hitnormal + 显式 whistle，所以 0ms 有两条
T('普通物件时间不受影响', [...new Set(others.map((r) => r.time))].join(',') === '0,6000', JSON.stringify(others.map((r) => r.time)))

console.log(`RESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
