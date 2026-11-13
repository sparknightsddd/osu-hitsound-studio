/**
 * 导入 → 导出的「音频文件零改动」检查（真实谱面集成测试）。
 *
 * 用法：
 *   npx tsx scripts/test-roundtrip-files.ts <谱面目录> [.osu 文件名]
 *
 * 不给参数时用下面这个开发机路径；目录不存在就跳过（不算失败）。
 *
 * 判定标准：
 *  - plan.files 里每个目标文件都必须已经存在，且内容与源文件一致（导出时会被跳过）；
 *  - 不能出现「同名但内容不同」（导出会中止）；
 *  - 不能有目标文件缺失（导出会新写一个音频文件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { osuToHs } from '../src/core/osuToHs'
import { parseChart } from '../src/core/parse'
import { planOsuExport } from '../src/core/osuExport'

const DEFAULT_DIR = 'E:/osu/Songs/1002019 SAMString - Forget The Promise'
const dir = process.argv[2] || DEFAULT_DIR
const osuArg = process.argv[3]
const osuFile = osuArg || (fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.osu')) : '')

if (!osuFile || !fs.existsSync(dir)) {
  console.log(`跳过：找不到谱面目录 ${dir}`)
  process.exit(0)
}

const srcPath = path.join(dir, osuFile)
const src = fs.readFileSync(srcPath, 'utf8')
const join = (rel: string) =>
  /^[a-z]:[\\/]/i.test(rel) || rel.startsWith('/') ? rel : path.join(dir, rel)
const hash = (p: string) =>
  crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')

const env = {
  dir,
  filePath: srcPath,
  fileName: osuFile,
  fileExists: async (_d: string, rel: string) => fs.existsSync(join(rel)),
  hashFile: async (_d: string, rel: string) => hash(join(rel)),
  wavMeta: async () => null,
  audioDurationMs: async () => 0,
}

const res = await osuToHs(src, env, { path: dir })
const doc = parseChart(res.text)
const plan = planOsuExport(doc)

const missing: string[] = []
const conflicts: string[] = []
const matched: string[] = []
for (const f of plan.files) {
  const target = path.join(dir, f.to)
  if (!fs.existsSync(target)) {
    missing.push(f.to)
    continue
  }
  if (f.mix) {
    // 混音结果无法直接按字节比较，只要求目标已存在（不新写文件）
    matched.push(f.to)
    continue
  }
  const from = f.from[0]
  if (!from) {
    matched.push(f.to)
    continue
  }
  if (fs.readFileSync(target).equals(fs.readFileSync(from))) matched.push(f.to)
  else conflicts.push(f.to)
}

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

console.log(`谱面：${osuFile}`)
console.log(
  `音效 ${res.sounds.length} 个 · 代号 ${res.codes.length} 个 · 编号组 ${plan.groups.length} 个 · 文件任务 ${plan.files.length} 个\n`,
)
T('没有「会新写」的音频文件', missing.length === 0, missing.slice(0, 12).join(', '))
T('没有同名不同内容的冲突', conflicts.length === 0, conflicts.slice(0, 12).join(', '))
T('至少有一个文件任务被验证', plan.files.length > 0 && matched.length === plan.files.length, `${matched.length}/${plan.files.length}`)
T('导出计划没有阻塞性错误', plan.errors.length === 0, plan.errors.slice(0, 4).join(' | '))
T('编号组都是正数', plan.groups.every((g) => Number.isInteger(g.index) && g.index >= 1))
T('文件任务没有重名', new Set(plan.files.map((f) => f.to)).size === plan.files.length)

console.log(`\n${fail ? `${fail} 项失败` : '全部通过'}（${pass} 项）`)
process.exit(fail ? 1 : 0)
