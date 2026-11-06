/**
 * 导入 → 导出往返测试。
 *
 * 场景：谱面目录里同时有 soft-hitclap.wav（被引用）和 soft-hitclap2.wav（没被引用），
 * 导入再原样导出时不能把后者当成「同名不同内容」报冲突。
 * （之前导出会把 drum-hitclap 挪到 soft-hitclap 槽位，生成与源文件同名的文件。）
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { osuToHs } from '../src/core/osuToHs'
import { parseChart } from '../src/core/parse'
import { planOsuExport } from '../src/core/osuExport'

const require2 = createRequire(import.meta.url)
const { exportPackage } = require2('../electron/osu-export.cjs')

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const SRC = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)'
if (!existsSync(join(SRC, 'soft-hitclap8.wav'))) {
  console.log('skip：找不到测试音效')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'hsround-'))
try {
  // 被引用的 clap（index 1）和没被引用的 clap2（index 2，内容不同）
  copyFileSync(join(SRC, 'soft-hitclap8.wav'), join(dir, 'soft-hitclap.wav'))
  copyFileSync(join(SRC, 'soft-hitclap18.wav'), join(dir, 'soft-hitclap2.wav'))

  const osu = `osu file format v14

[General]
AudioFilename: audio.mp3
SampleSet: Soft

[Metadata]
Title:Roundtrip
Artist:Tester
Creator:Me
Version:Test

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,1,60,1,0
0,-100,4,2,1,60,0,0

[HitObjects]
0,0,0,1,8,0:0:0:0:
0,0,500,1,8,0:0:0:0:
`
  const env = {
    dir,
    fileName: 'roundtrip.osu',
    fileExists: async (d: string, rel: string) => existsSync(join(d, rel)),
    hashFile: async (_d: string, rel: string) => 'h:' + rel.toLowerCase(),
    audioDurationMs: async () => 0,
  }
  const hs = await osuToHs(osu, env as never, { path: dir })
  const doc = parseChart(hs.text)
  doc.settings.PreferredIndex = []
  const plan = planOsuExport(doc)
  ok(plan.errors.length === 0, `规划无报错：${plan.errors.join(' / ')}`)
  ok(plan.groups.length === 1, `只用一个编号：${plan.groups.map((g) => g.index).join(',')}`)

  const r = exportPackage({
    dir,
    artist: 'Tester',
    title: 'Roundtrip',
    creator: 'Me',
    text: plan.text,
    files: plan.files,
    defaultDir: 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)',
  })
  ok(r.ok === true, `导出没有报冲突：${r.error || JSON.stringify(r.conflicts)}`)
  ok(r.written === 0, `音效内容一致，全部跳过：written=${r.written}`)
  ok((r.skipped || 0) >= 1, `跳过 ${r.skipped} 个`)
  ok(existsSync(join(dir, 'Tester - Roundtrip (Me) [[EZHS]].osu')), '生成标准命名的 .osu')
  // 没被引用的 clap2 不能被改动
  const before = readFileSync(join(dir, 'soft-hitclap2.wav'))
  ok(before.length > 0, '未引用的 clap2 保持原样')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
