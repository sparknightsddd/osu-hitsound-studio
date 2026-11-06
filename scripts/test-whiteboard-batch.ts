/** 批量跑白板导入：每份谱把出现最多的音效设为白板，检查回读无错、时间对齐。 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { renderOsuSoundsHs } from '../src/core/osuToHs'
import { extractOsuSounds, soundCodeKey } from '../src/core/osuSounds'
import { parseChart } from '../src/core/parse'

function pick(d: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...pick(p))
    else if (/\.osu$/i.test(e.name)) out.push(p)
    if (out.length > 2000) return out
  }
  return out
}

const files = pick(process.argv[2]).slice(0, Number(process.argv[3] || 120))
let maps = 0
let withWb = 0
let err = 0
let maxErr = 0
let total = 0

for (const src of files) {
  const dir = dirname(src)
  let text: string
  try {
    text = readFileSync(src, 'utf8')
  } catch {
    continue
  }
  const lower = new Map<string, string>()
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    try {
      if (statSync(p).isFile()) lower.set(f.toLowerCase(), p)
    } catch {
      /* ignore */
    }
  }
  const env = {
    dir,
    fileName: basename(src),
    filePath: src,
    fileExists: async (_d: string, r: string) => lower.has(r.toLowerCase()),
    hashFile: async (_d: string, r: string) => {
      const p = lower.get(r.toLowerCase())
      return p ? 'h:' + p : 'm'
    },
  }
  const res = await extractOsuSounds(text, env as never)
  if (!res.codes.length) continue
  maps++
  const counts = new Map<string, number>()
  for (const s of res.sounds) counts.set(soundCodeKey(s.code), (counts.get(soundCodeKey(s.code)) || 0) + 1)
  const wb = res.codes.slice().sort((a, b) => (counts.get(soundCodeKey(b)) || 0) - (counts.get(soundCodeKey(a)) || 0))[0]
  const wbKey = soundCodeKey(wb)
  withWb++
  const hs = renderOsuSoundsHs(res, { path: dir, whiteboard: wbKey })
  const back = parseChart(hs.text)
  const e = back.diagnostics.filter((d) => d.severity === 'error').length
  if (e) {
    err++
    console.log('ERR', src, back.diagnostics.filter((d) => d.severity === 'error').slice(0, 2))
  }
  const a = res.sounds.filter((s) => soundCodeKey(s.code) !== wbKey).map((s) => s.time).sort((x, y) => x - y)
  const b = back.events.map((ev) => ev.time).sort((x, y) => x - y)
  let j = 0
  for (const t of a) {
    while (j < b.length - 1 && b[j] < t) j++
    let bd = Infinity
    for (let k = Math.max(0, j - 2); k < Math.min(b.length, j + 3); k++) bd = Math.min(bd, Math.abs(b[k] - t))
    if (Number.isFinite(bd)) {
      total++
      maxErr = Math.max(maxErr, bd)
    }
  }
}
console.log(`谱面 ${maps}（都设了白板 ${withWb}），回读 error 谱数 ${err}，非白板音符 ${total}，最大误差 ${maxErr.toFixed(1)}ms`)
