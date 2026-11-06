import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { osuToHs, blankHitsoundHs } from '../src/core/osuToHs'
import { extractOsuSounds } from '../src/core/osuSounds'
import { parseChart } from '../src/core/parse'

const src = process.argv[2]
const dir = dirname(src)
const text = readFileSync(src, 'utf8')

// 构造 env：模拟 Electron 侧能力
const lower = new Map<string, string>()
for (const f of readdirSync(dir)) {
  const p = join(dir, f)
  if (statSync(p).isFile()) lower.set(f.toLowerCase(), p)
}
const env = {
  dir,
  fileName: src.split(/[\\/]/).pop() || '',
  filePath: src,
  fileExists: async (_d: string, rel: string) => lower.has(rel.toLowerCase()),
  hashFile: async (_d: string, rel: string) => {
    const p = lower.get(rel.toLowerCase())
    if (!p) return 'missing'
    return createHash('sha1').update(readFileSync(p)).digest('hex')
  },
}

const res = await extractOsuSounds(text, env)
console.log('=== 提取结果 ===')
console.log('物件数(timing点):', res.timing.length, ' 音频:', res.audioFilename)
console.log('音效代码数:', res.codes.length)
for (const c of res.codes) {
  console.log(`  ${c.name}  slot=${c.slot.padEnd(18)} idx=${String(c.index).padEnd(3)} val=${c.value}`)
}
console.log('音效事件数:', res.sounds.length, ' 无timing跳过:', res.skippedNoTiming)
const bySource: Record<string, number> = {}
for (const s of res.sounds) bySource[s.source] = (bySource[s.source] || 0) + 1
console.log('按来源:', bySource)

const hs = await osuToHs(text, env, { path: dir })
console.log('\n=== 渲染 ===')
console.log('placed:', hs.placed, ' unplaced:', hs.unplaced, ' splitVolume:', hs.splitVolume)
writeFileSync(join(dir, '__test_out.hs'), hs.text)
console.log('已写出', join(dir, '__test_out.hs'))

// 回读校验：解析生成的 .hs，确认时间与音量对得上
const back = parseChart(hs.text)
console.log('\n=== 回读校验 ===')
console.log('诊断:', back.diagnostics.filter(d => d.severity !== 'info').length)
for (const d of back.diagnostics.slice(0, 12)) console.log(`  [${d.severity}] ${d.message} (${d.code})`)
console.log('解析出的 hitsound 定义:', back.hitsounds.length, ' 事件:', back.events.length)
console.log('未定义音效名:', back.undefinedNames)

let maxErr = 0
let n = 0
for (const e of back.events) {
  const orig = hs.sounds.filter((s) => hs.codes.some(c => c.name === e.names[0]))
  for (const o of orig) {
    if (o.code.name !== e.names[0]) continue
    const err = Math.abs(o.time - e.time)
    if (err <= 30) { n++; if (err > maxErr) maxErr = err }
  }
}
console.log(`时间对齐: ${n} 个事件误差 <=30ms，最大误差 ${maxErr.toFixed(1)}ms`)
console.log('\n===== 生成内容预览 =====')
console.log(hs.text.split('\n').slice(0, 40).join('\n'))
console.log('...')
console.log(hs.text.split('\n').slice(-14).join('\n'))