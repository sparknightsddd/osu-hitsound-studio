/**
 * 验证「白板音效 + 自定义代号」的导入结果。
 *
 * 用法：npx tsx scripts/test-whiteboard.ts "path/to/x.osu"
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { renderOsuSoundsHs } from '../src/core/osuToHs'
import { extractOsuSounds, soundCodeKey } from '../src/core/osuSounds'
import { parseChart } from '../src/core/parse'
import { normalizeSoundName } from '../src/components/SoundImportDialog'

const src = process.argv[2]
const dir = dirname(src)
const text = readFileSync(src, 'utf8')
const lower = new Map<string, string>()
for (const f of readdirSync(dir)) {
  const p = join(dir, f)
  if (statSync(p).isFile()) lower.set(f.toLowerCase(), p)
}
const env = {
  dir,
  fileName: basename(src),
  filePath: src,
  fileExists: async (_d: string, r: string) => lower.has(r.toLowerCase()),
  hashFile: async (_d: string, r: string) => {
    const p = lower.get(r.toLowerCase())
    return p ? createHash('sha1').update(readFileSync(p)).digest('hex') : 'missing'
  },
}

let bad = 0
const ok = (cond: boolean, msg: string) => {
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
}

// 1) 代号规整
ok(normalizeSoundName('ab') === 'Ab', `ab -> Ab`)
ok(normalizeSoundName('AB') === 'Ab', `AB -> Ab（Caps Lock 不影响）`)
ok(normalizeSoundName('aBcD') === 'Abcd', `aBcD -> Abcd`)
ok(normalizeSoundName('a1!_b') === 'Ab', `a1!_b -> Ab（数字/符号被丢掉）`)
ok(normalizeSoundName('123') === '', `纯数字 -> 空`)

const res = await extractOsuSounds(text, env)
if (!res.codes.length) {
  console.log('SKIP  该谱没有显式音效事件（全是 hitSound=0），无法测试白板')
  process.exit(0)
}
ok(res.codes.length > 0, `提取到 ${res.codes.length} 个音效`)

// 白板选出现最多的 hitnormal
const counts = new Map<string, number>()
for (const s of res.sounds) counts.set(soundCodeKey(s.code), (counts.get(soundCodeKey(s.code)) || 0) + 1)
const ranked = res.codes.slice().sort((a, b) => (counts.get(soundCodeKey(b)) || 0) - (counts.get(soundCodeKey(a)) || 0))
const wb = ranked.find((c) => c.hitType === 'hitnormal') || ranked[0]
const wbKey = soundCodeKey(wb)

// 给第二个代码一个自定义名，验证正文和 [Define] 都用它
const other = res.codes.find((c) => soundCodeKey(c) !== wbKey)
const names: Record<string, string> = {}
if (other) names[soundCodeKey(other)] = 'Zz'

const hs = renderOsuSoundsHs(res, { path: dir, whiteboard: wbKey, codeNames: names })
const lines = hs.text.split(/\r?\n/)
const defineIdx = lines.findIndex((l) => l.trim() === '[Define]')
const bodyIdx = lines.findIndex((l) => l.trim() === '[Hitsound]')
const define = lines.slice(defineIdx + 1, bodyIdx).filter((l) => l.startsWith('hitsound'))
const body = lines.slice(bodyIdx + 1).join('\n')

const wbLine = define.find((l) => l.includes(wb.slot) && !/ [A-Z][a-z]* = /.test(l))
ok(!!wbLine, `[Define] 里白板是无名定义：${wbLine || '(没有找到)'}`)
ok(!define.some((l) => l.includes(` ${wb.name} =`)), `白板原来的代号 ${wb.name} 没有出现在 [Define]`)
ok(!new RegExp(`(^|[\\s/\\[])${wb.name}([\\s/\\]]|$)`).test(body), `正文里不再出现白板代号 ${wb.name}`)

if (other) {
  ok(define.some((l) => l.includes(' Zz =')), `自定义代号 Zz 写进了 [Define]`)
  ok(new RegExp(`(^|[\\s/\\[])Zz([\\s/\\]]|$)`).test(body), '自定义代号 Zz 写进了正文')
}

// 回读：白板位置变成休止符，时间仍然对得上
const back = parseChart(hs.text)
ok(back.diagnostics.filter((d) => d.severity === 'error').length === 0, '回读没有 error 诊断')
ok(back.hitsounds.some((h) => !h.name), '解析器能识别无名 hitsound 定义')

// 白板事件现在变成了休止符，不参与发声比对
const a = res.sounds
  .filter((s) => soundCodeKey(s.code) !== wbKey)
  .map((s) => s.time)
  .sort((x, y) => x - y)
const b = back.events.map((e) => e.time).sort((x, y) => x - y)
let j = 0
let maxErr = 0
for (const t of a) {
  while (j < b.length - 1 && b[j] < t) j++
  let bd = Infinity
  for (let k = Math.max(0, j - 2); k < Math.min(b.length, j + 3); k++) bd = Math.min(bd, Math.abs(b[k] - t))
  if (Number.isFinite(bd)) maxErr = Math.max(maxErr, bd)
}
ok(maxErr < 60, `时间误差最大 ${maxErr.toFixed(1)}ms`)

const wbCount = res.sounds.filter((s) => soundCodeKey(s.code) === wbKey).length
console.log(
  `\n白板：${wb.slot}（${wb.file || wb.value}），${wbCount} 个事件 / 共 ${res.sounds.length}；` +
    `正文 ${body.length} 字符，回读 ${back.events.length} 个发声事件（白板不计）`,
)
process.exit(bad ? 1 : 0)
