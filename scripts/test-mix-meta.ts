/**
 * 混音元数据往返测试：
 *   两个音效 → 混音导出（带 HSSM）→ 重新导入 → 拆回两个音效。
 *
 * 这是「导出后再导入还能还原」的核心：HSSM 块记录源代号/槽位/文件名，
 * 源文件还在就展开成同刻叠加，源文件不在就保留混合文件并在 [Define] 里注明。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { extractOsuSounds } from '../src/core/osuSounds'
import { renderOsuSoundsHs } from '../src/core/osuToHs'

const require2 = createRequire(import.meta.url)
const { mixFilesTo, readWav } = require2('../electron/wav-mix.cjs')

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const SRC = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)'
if (!existsSync(join(SRC, 'soft-hitnormal8.wav'))) {
  console.log('skip：找不到测试音效')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'hsmixmeta-'))
try {
  copyFileSync(join(SRC, 'soft-hitnormal8.wav'), join(dir, 'a.wav'))
  copyFileSync(join(SRC, 'normal-hitclap18.wav'), join(dir, 'b.wav'))

  const meta = {
    v: 1,
    app: 'osu-hitsound-studio',
    sources: [
      { code: 'Aa', set: 'soft', hit: 'hitwhistle', index: 1, file: 'a.wav', path: join(dir, 'a.wav') },
      { code: 'Ab', set: 'soft', hit: 'hitwhistle', index: 1, file: 'b.wav', path: join(dir, 'b.wav') },
    ],
  }
  const mix = mixFilesTo([join(dir, 'a.wav'), join(dir, 'b.wav')], join(dir, 'soft-hitwhistle.wav'), meta)
  ok(mix.ok, `混音写盘：${mix.errors.join('；')}`)
  const back = readWav(join(dir, 'soft-hitwhistle.wav'))
  ok(!!back?.meta && back.meta.sources.length === 2, `HSSM 块读得回来：${back?.meta?.sources?.length}`)

  const osu = `[General]
AudioFilename: audio.mp3

[Metadata]
Title:mix
Version:Hard
Creator:tester

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
0,500,4,0,0,60,1,0
0,-100,4,0,0,60,0,0

[HitObjects]
0,0,0,1,2,2:2:0:60:
`
  const env = {
    dir,
    fileName: 'mix.osu',
    fileExists: async (d: string, rel: string) => existsSync(join(d, rel)),
    hashFile: async (_d: string, rel: string) => 'p:' + rel,
    wavMeta: async (d: string, rel: string) => {
      try {
        const w = readWav(join(d, rel))
        return w?.meta ?? null
      } catch {
        return null
      }
    },
  }

  // 1) 源文件都在 → 拆回两个音效
  {
    const res = await extractOsuSounds(osu, env as never)
    const custom = res.codes.filter((c) => c.file === 'a.wav' || c.file === 'b.wav')
    ok(custom.length === 2, `拆回两个音效：${res.codes.map((c) => c.file || c.slot).join(', ')}`)
    ok(
      custom.every((c) => c.sampleSet === 'soft' && c.hitType === 'hitwhistle'),
      `槽位沿用混合前的定义：${custom.map((c) => `${c.sampleSet}-${c.hitType}`).join(' + ')}`,
    )
    const sameTime = res.sounds.filter((s) => s.time === 0 && s.code.file)
    ok(sameTime.length === 2, `同一时刻两条音效：${sameTime.length}`)
    ok(!res.codes.some((c) => c.file === 'soft-hitwhistle.wav'), '不再保留混合文件本身')

    const hs = renderOsuSoundsHs(res).text
    ok(
      /hitsound soft-hitwhistle \w+ = "a.wav"/.test(hs) && /hitsound soft-hitwhistle \w+ = "b.wav"/.test(hs),
      '[Define] 写成两条独立定义（槽位沿用混合前的 soft-hitwhistle）',
    )
    ok(!hs.includes('无法拆回'), '正常还原时不出现「无法拆回」提示')
  }

  // 2) 源文件丢了 → 保留混合文件并注明来源
  {
    unlinkSync(join(dir, 'a.wav'))
    const res = await extractOsuSounds(osu, env as never)
    const mixed = res.codes.find((c) => c.file === 'soft-hitwhistle.wav')
    ok(!!mixed, '保留混合文件作为一个音效')
    ok(!!mixed?.mix && mixed.mix.sources.length === 2, `混音信息还在：${mixed?.mix?.sources?.map((s) => s.code).join('+')}`)
    const hs = renderOsuSoundsHs(res).text
    ok(/混合而成（源文件不在目录里，无法拆回）/.test(hs), '[Define] 注释说明无法拆回')
    ok(hs.includes('Aa + Ab'), `注释里有来源代号：${/##.*混合而成/.exec(hs)?.[0] || ''}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
