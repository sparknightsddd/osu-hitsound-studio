/**
 * 导出音效包的落盘测试：用真实导入谱跑一遍「写 .osu + 复制/混音音效」，
 * 逻辑和 electron/main.cjs 里的 export:osuPackage 一致（不弹对话框）。
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { parseChart } from '../src/core/parse'
import { planOsuExport } from '../src/core/osuExport'
import { extractOsuSounds } from '../src/core/osuSounds'

const require2 = createRequire(import.meta.url)
const { readWav, mixFilesTo } = require2('../electron/wav-mix.cjs')

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const SRC = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)/__test_out.hs'
if (!existsSync(SRC)) {
  console.log(`skip：找不到测试谱 ${SRC}`)
  process.exit(0)
}

const doc = parseChart(readFileSync(SRC, 'utf8'))
const plan = planOsuExport(doc)
ok(plan.errors.length === 0, `规划无报错：${plan.errors.join(' / ')}`)

const dir = mkdtempSync(join(tmpdir(), 'hsexport-'))
try {
  const osuPath = join(dir, 'test [Hitsound].osu')
  writeFileSync(osuPath, plan.text, 'utf8')
  const text = readFileSync(osuPath, 'utf8')
  const hitSection = text.split('[HitObjects]')[1] || ''
  const lines = hitSection.split(/\r?\n/).filter((l) => l.trim())
  ok(lines.length === plan.objectCount, `[HitObjects] 行数与规划一致：${lines.length}/${plan.objectCount}`)
  ok(lines.every((l) => /^256,192,\d+,1,\d+,\d+:\d+:\d+:\d+:$/.test(l)), '每行都是 256,192,时间,1,音效位,组信息')

  let copied = 0
  let mixed = 0
  const problems: string[] = []
  for (const f of plan.files) {
    const to = join(dir, f.to)
    if (f.mix) {
      const sources = [...f.from]
      // 测试里没有内置 default 目录，defaults 先跳过（真实导出会用它混音）
      if (sources.length === 1) {
        copyFileSync(sources[0], to)
        copied++
      } else {
        const r = mixFilesTo(sources, to, f.mixMeta)
        if (r.ok) mixed++
        else problems.push(`${f.to}: ${r.errors.join('；')}`)
      }
    } else {
      copyFileSync(f.from[0], to)
      copied++
    }
    if (!existsSync(to)) problems.push(`${f.to} 没写出来`)
    const w = readWav(to)
    if (!w || !w.data[0].length) problems.push(`${f.to} 读回来是空的`)
  }
  ok(problems.length === 0, `文件全部落盘且可读：${problems.slice(0, 3).join(' / ')}`)
  ok(copied + mixed === plan.files.length, `复制 ${copied} + 混音 ${mixed} = ${plan.files.length}`)
  ok(mixed === plan.mixCount, `混音数与规划一致：${mixed}`)
  {
    const g1 = plan.groups.find((g) => g.index === 1)
    if (g1) {
      const badName = [...g1.slots.keys()].some((k) => plan.files.some((f) => f.to === `${k}1.wav`))
      ok(!badName, '1 号编号没有写成 xxx1.wav')
    } else {
      ok(true, '本次编号从 PreferredIndex 开始（没有 1 号）')
    }
  }

  // 抽查：文件名去重、没有别的格式混进来
  const names = plan.files.map((f) => f.to)
  ok(new Set(names).size === names.length, '目标文件名没有重复')
  console.log('  示例：', names.slice(0, 6).join(', '))

  // 重新导入导出的 .osu：混音文件应当拆回混合前的多个音效
  const isAbs = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('/')
  const env = {
    dir,
    fileName: 'roundtrip.osu',
    fileExists: async (d: string, rel: string) => existsSync(isAbs(rel) ? rel : join(d, rel)),
    hashFile: async (_d: string, rel: string) => 'p:' + rel,
    wavMeta: async (d: string, rel: string) => {
      try {
        const w = readWav(isAbs(rel) ? rel : join(d, rel))
        return w?.meta ?? null
      } catch {
        return null
      }
    },
  }
  const back = await extractOsuSounds(text, env as never)
  const mixedTask = plan.files.find((f) => f.mix)
  const srcNames = (mixedTask?.from || []).map((p) => p.split(/[\\/]/).pop() || '')
  const restored = srcNames.filter((n) => back.codes.some((c) => c.file.endsWith(n)))
  ok(
    srcNames.length > 0 && restored.length === srcNames.length,
    `混音文件拆回源音效：${srcNames.join(' + ')} → ${restored.join(' + ')}`,
  )
  ok(!back.codes.some((c) => c.file === mixedTask?.to), `不再把 ${mixedTask?.to} 当成独立音效`)
  ok(back.codes.length > 0 && back.sounds.length >= plan.objectCount, `重新导入有 ${back.sounds.length} 条音效`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
