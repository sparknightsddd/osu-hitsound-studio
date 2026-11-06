/**
 * auto 采样组（hitSample 的 sampleSet=0）回落单测。
 *
 * 用户反馈：导入时开头的 drum-hitnormal 丢了。原因是滑条老格式没有 hitSample 字段，
 * 解析器却把 slides 数量当成了 hitSample（"5" → normalSet=5），于是 Timing 里的
 * drum/soft 被覆盖成 normal。
 */
import { extractOsuSounds, parseHitObjects } from '../src/core/osuSounds'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const OSU = (timing: string, general = 'SampleSet: Drum') => `[General]
AudioFilename: audio.mp3
${general}

[Metadata]
Title:auto
Version:Hard
Creator:tester

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
${timing}

[HitObjects]
0,0,0,1,0,0:0:0:0:
0,0,1000,2,0,L|10:10,1,100
0,0,2000,1,0,0:0:0:0:
0,0,3000,2,2,L|10:10,1,100
0,0,4000,2,0,L|10:10,1,100,4|0,1:1|0:0,0:0:0:0:
`

const env = {
  dir: '',
  fileName: 'auto.osu',
  fileExists: async () => false,
  hashFile: async (_d: string, rel: string) => 'p:' + rel,
}

// 1) 解析层：滑条老格式的 hitSample 不能被 slides 污染
{
  const objs = parseHitObjects([
    '0,0,1000,2,0,L|10:10,1,100',
    '0,0,2000,2,0,L|10:10,3,100,4|0,3:1|0:0,0:0:0:0:',
  ])
  ok(objs[0].hitSample.normalSet === 0, `老格式滑块 hitSample 是 auto：${JSON.stringify(objs[0].hitSample)}`)
  ok(objs[1].hitSample.normalSet === 0 && objs[1].hitSample.volume === 0, `新格式滑块读到 hitSample：${JSON.stringify(objs[1].hitSample)}`)
  ok(objs[1].objectParams.endsWith('4|0,3:1|0:0,0:0:0:0:'), 'objectParams 仍保留完整尾部')
}

// 2) 整条链路：timing 写 drum（3），所有 auto 物件都应落到 drum
{
  const res = await extractOsuSounds(OSU('0,500,4,3,8,60,1,0\n0,-100,4,3,8,60,0,0'), env as never)
  const at = (t: number) => res.sounds.filter((s) => s.time === t)

  const head0 = at(0).find((s) => s.code.hitType === 'hitnormal')
  ok(!!head0 && head0.code.sampleSet === 'drum', `圆圈 auto → drum：${head0?.code.sampleSet}`)
  ok(head0?.code.index === 8, `沿用 timing 的编号 8：${head0?.code.index}`)
  ok(head0?.volume === 60, `沿用 timing 的音量 60：${head0?.volume}`)

  const sliderOld = at(1000).find((s) => s.code.hitType === 'hitnormal')
  ok(!!sliderOld && sliderOld.code.sampleSet === 'drum', `老格式滑块头 auto → drum：${sliderOld?.code.sampleSet}`)

  const circle2 = at(2000).find((s) => s.code.hitType === 'hitnormal')
  ok(!!circle2 && circle2.code.sampleSet === 'drum', `第二个圆圈 auto → drum：${circle2?.code.sampleSet}`)

  // 滑块头 hitSound=2（whistle）要和 base 叠加
  const w = at(3000)
  ok(
    w.some((s) => s.code.hitType === 'hitnormal' && s.code.sampleSet === 'drum') &&
      w.some((s) => s.code.hitType === 'hitwhistle' && s.code.sampleSet === 'drum'),
    `滑块 hitSound=whistle 时 normal+whistle 都在：${w.map((s) => s.code.hitType).join('+')}`,
  )

  // edgeSets 显式写了 normal(1) 时，应当覆盖 timing 的 drum
  const e4 = at(4000)
  ok(
    e4.some((s) => s.code.hitType === 'hitnormal' && s.code.sampleSet === 'normal') &&
      e4.some((s) => s.code.hitType === 'hitfinish' && s.code.sampleSet === 'normal'),
    `edgeSets 写 1:1 时用 normal：${e4.map((s) => `${s.code.sampleSet}-${s.code.hitType}`).join('+')}`,
  )
}

// 3) timing 和物件都 auto → [General] SampleSet 兜底
{
  const res = await extractOsuSounds(OSU('0,500,4,0,0,60,1,0\n0,-100,4,0,0,60,0,0'), env as never)
  const head = res.sounds.find((s) => s.time === 0 && s.code.hitType === 'hitnormal')
  ok(!!head && head.code.sampleSet === 'drum', `timing 全 auto 时用 [General] Drum：${head?.code.sampleSet}`)
  ok(head?.code.index === 0, `编号没写就保持 0：${head?.code.index}`)
}

// 4) [General] 也没写 → normal 兜底
{
  const res = await extractOsuSounds(OSU('0,500,4,0,0,60,1,0\n0,-100,4,0,0,60,0,0', ''), env as never)
  const head = res.sounds.find((s) => s.time === 0 && s.code.hitType === 'hitnormal')
  ok(!!head && head.code.sampleSet === 'normal', `全都没写时回落 normal：${head?.code.sampleSet}`)
}

// 5) soft 区域：开头滑条应该是 soft，而不是被 slides 顶成 normal
{
  const res = await extractOsuSounds(OSU('0,500,4,2,8,58,1,0\n0,-100,4,2,8,58,0,0', ''), env as never)
  const slider = res.sounds.find((s) => s.time === 1000 && s.code.hitType === 'hitnormal')
  ok(!!slider && slider.code.sampleSet === 'soft', `soft 区域的滑块头 → soft：${slider?.code.sampleSet}`)
  ok(slider?.code.index === 8 && slider?.volume === 58, `编号/音量取 timing：${slider?.code.index}/${slider?.volume}`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
