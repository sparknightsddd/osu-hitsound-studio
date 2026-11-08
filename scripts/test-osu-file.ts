/**
 * `.osu` 内容校验的单元测试：挡住「txt 改名」。
 */
import { isOsuFileText, osuFileProblem } from '../src/core/osuFile'

let pass = 0
let fail = 0
const T = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const VALID = `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Metadata]
Title:Test
Artist:Someone
Creator:Me
Version:Easy

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
`

T('正常 .osu 通过', isOsuFileText(VALID) && osuFileProblem(VALID) === null)
T('带 BOM 也能认', isOsuFileText('\uFEFF' + VALID))
T('CRLF 也能认', isOsuFileText(VALID.replace(/\n/g, '\r\n')))
T('开头有 // 注释也能认', isOsuFileText('// exported by something\n' + VALID))
T('版本号更大也能认', isOsuFileText(VALID.replace('v14', 'v128')))
T('段名前有空格也能认', isOsuFileText(VALID.replace('[General]', '  [General]  ')))

// 反例
T('纯文本没有头 → header', osuFileProblem('随便写的一点东西\n第二行\n') === 'header')
T('空文件 → empty', osuFileProblem('') === 'empty' && osuFileProblem('   \n\n') === 'empty')
T('只有头、没有段落 → sections', osuFileProblem('osu file format v14\n\n// nothing\n') === 'sections')
T('头写错了（v 后面没数字）→ header', osuFileProblem('osu file format\n[General]\n') === 'header')
T('头前面夹了别的话 → header', osuFileProblem('hello\nosu file format v14\n[General]\n') === 'header')
T('JSON 改后缀 → header', osuFileProblem('{\n  "a": 1,\n  "b": [1,2,3]\n}\n') === 'header')
T('未知段落不算数', osuFileProblem('osu file format v14\n\n[Whatever]\nx: 1\n') === 'sections')
T('大小写混着写也认', isOsuFileText('OSU File Format v14\r\n\r\n[GENERAL]\r\nMode: 0\r\n'))

console.log(`RESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
