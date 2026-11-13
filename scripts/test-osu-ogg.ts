/**
 * 从 .osu 导入音效时对 .ogg 的支持：
 *  - 标准命名 soft-hitnormal.ogg / soft-hitwhistle1.ogg 能被认出来（以前只找 .wav）
 *  - 同一槽位同时有 .wav 和 .ogg 时仍优先 .wav（和 osu! 一致）
 *  - hitSample 里写的自定义 .ogg 文件名也能用
 *  - 编号文件不存在时回落到不带编号的 .ogg
 */
import { extractOsuSounds, sampleFileCandidates } from '../src/core/osuSounds'
import { renderOsuSoundsHs } from '../src/core/osuToHs'
import { parseChart } from '../src/core/parse'

let bad = 0
function ok(cond: boolean, name: string, extra = '') {
  if (!cond) {
    bad++
    console.log(`FAIL ${name} ${extra}`)
  } else console.log(`ok   ${name} ${extra}`)
}

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
SampleSet: Soft
Mode: 0

[Metadata]
Title:Ogg
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,1,2,0:0:0:0:
256,192,500,1,8,0:0:0:0:custom-clap.ogg
256,192,1000,1,2,0:0:1:0:
256,192,1500,1,1,0:0:0:0:
256,192,2000,1,4,0:0:0:0:
256,192,2500,1,8,0:0:0:0:
256,192,3000,1,8,0:0:0:0:clap-a.ogg
256,192,3500,1,8,0:0:0:0:clap-b.ogg
`

/** 模拟磁盘目录：只有 ogg（外加一个同槽位的 wav 用来验证优先级） */
const FILES = new Set([
  'soft-hitwhistle.ogg',
  'soft-hitfinish.ogg',
  'soft-hitnormal.ogg',
  'soft-hitclap.wav',
  'soft-hitclap.ogg',
  'custom-clap.ogg',
  'clap-a.ogg',
  'clap-b.ogg',
])

const env = {
  dir: 'E:/songs/ogg-test',
  fileExists: async (_d: string, rel: string) => FILES.has(rel.toLowerCase()),
  hashFile: async (_d: string, rel: string) => `hash:${rel.toLowerCase()}`,
}

const res = await extractOsuSounds(OSU, env)
const byFile = new Map(res.codes.map((c) => [c.file.toLowerCase(), c]))

ok(!!byFile.get('soft-hitwhistle.ogg'), '标准命名 soft-hitwhistle.ogg 被导入')
ok(!!byFile.get('soft-hitnormal.ogg'), 'hitnormal 的 .ogg 被导入')
ok(!!byFile.get('custom-clap.ogg'), 'hitSample 里的自定义 .ogg 被导入')
ok(!!byFile.get('soft-hitclap.wav'), '同槽位同时有 wav/ogg 时优先 wav')
ok(!byFile.get('soft-hitclap.ogg'), '有 wav 时不再把同槽位的 ogg 当成另一份音效')
ok(
  byFile.get('soft-hitwhistle.ogg')?.slot === 'soft-hitwhistle',
  `槽位写对：${byFile.get('soft-hitwhistle.ogg')?.slot}`,
)
ok(
  byFile.get('soft-hitwhistle.ogg')?.value === '"soft-hitwhistle.ogg"',
  `[Define] 的值带 .ogg：${byFile.get('soft-hitwhistle.ogg')?.value}`,
)

// 编号 1 的 whistle 不存在，应回落到不带编号的 soft-hitwhistle.ogg
const indexed = res.sounds.filter((s) => s.sampleIndex === 1 && s.code.hitType === 'hitwhistle')
ok(indexed.length > 0, `有 sampleIndex=1 的 whistle 事件：${indexed.length}`)
ok(
  indexed.every((s) => s.code.file.toLowerCase() === 'soft-hitwhistle.ogg'),
  `编号缺失时回落到基础 .ogg：${indexed.map((s) => s.code.file).join(', ')}`,
)

// 同一槽位 / 编号下，每个物件自己的自定义文件名不能被合并成一个
const claps = res.sounds.filter((s) => (s.time === 3000 || s.time === 3500) && s.code.hitType === 'hitclap')
ok(claps.length === 2, `两个自定义 clap 事件：${claps.length}`)
ok(
  claps[0]?.code.file !== claps[1]?.code.file,
  `不同自定义文件要拆成不同 code：${claps.map((s) => s.code.file).join(' / ')}`,
)
ok(
  claps[0]?.code.file.toLowerCase() === 'clap-a.ogg' && claps[1]?.code.file.toLowerCase() === 'clap-b.ogg',
  `事件指向各自的文件：${claps.map((s) => s.code.file).join(' / ')}`,
)

// 生成的 .hs 里 [Define] 必须保留 .ogg
const hs = await renderOsuSoundsHs(res, { path: 'E:/songs/ogg-test' })
const back = parseChart(hs.text)
const files = back.hitsounds.map((h) => h.value.toLowerCase())
ok(files.some((v) => v.includes('soft-hitwhistle.ogg')), '[Define] 保留 .ogg 路径')
ok(files.some((v) => v.includes('custom-clap.ogg')), '[Define] 保留自定义 .ogg 路径')
ok(
  !files.some((v) => v.includes('soft-hitwhistle.wav')),
  `没有编出不存在的 .wav：${files.join(' | ')}`,
)

ok(
  sampleFileCandidates('soft', 'hitwhistle', 0).join(',') ===
    'soft-hitwhistle.wav,soft-hitwhistle.ogg,soft-hitwhistle.mp3',
  '查找顺序 wav → ogg → mp3',
)
ok(
  sampleFileCandidates('drum', 'hitclap', 12)[1] === 'drum-hitclap12.ogg',
  '带编号的 ogg 候选名正确',
)

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
