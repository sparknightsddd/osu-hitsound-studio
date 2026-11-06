/**
 * 回归：批量导入 .osu → .hs，再回读，统计
 *   1) 每个小节的时值单位数是否 = 拍数 × 单位；
 *   2) 回读后的音符时间与原始时间的误差分布。
 *
 * 用法：npx tsx scripts/test-fit.ts "E:/osu/Songs" 300
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { osuToHs, osuTimingLines } from '../src/core/osuToHs'
import { MeasureGrid, measureBeatLayout } from '../src/core/measures'
import { extractOsuSounds } from '../src/core/osuSounds'
import { parseChart } from '../src/core/parse'

const root = process.argv[2]
const limit = Number(process.argv[3] || 300)
const ALLOWED_UNITS = new Set([1, 2, 3, 4, 6, 8, 12, 16, 9, 5, 7, 24, 32])

function pick(d: string): string[] {
  const out: string[] = []
  let ents: import('node:fs').Dirent[]
  try {
    ents = readdirSync(d, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...pick(p))
    else if (/\.osu$/i.test(e.name)) out.push(p)
    if (out.length > 4000) return out
  }
  return out
}

const files = pick(root).slice(0, limit)
const buckets = [0.5, 1, 2, 5, 10, 15, 30, 60, 1000, 1e9]
const hist = new Map<number, number>()
const unitStat = new Map<number, number>()
const badUnit = new Map<string, number>()
let totalNotes = 0
let measures = 0
let unplacedAll = 0
let placedAll = 0
let fail = 0
const badSamples: string[] = []
let sumErr = 0
let maxErr = 0
const worst: { f: string; dt: number; t: number }[] = []

const origLog = console.log
console.log = () => {}

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
    fileName: src.split(/[\\/]/).pop() || '',
    filePath: src,
    fileExists: async (_d: string, rel: string) => lower.has(rel.toLowerCase()),
    hashFile: async (_d: string, rel: string) => {
      const p = lower.get(rel.toLowerCase())
      return p ? createHash('sha1').update(readFileSync(p)).digest('hex') : 'missing'
    },
  }

  let hs: Awaited<ReturnType<typeof osuToHs>>
  let res: Awaited<ReturnType<typeof extractOsuSounds>>
  try {
    res = await extractOsuSounds(text, env as never)
    hs = await osuToHs(text, env as never, { path: dir })
  } catch (e) {
    fail++
    if (fail <= 3) origLog('FAIL', src, (e as Error).message)
    continue
  }

  unplacedAll += hs.unplaced
  placedAll += hs.placed

  // --- 单位数校验 ---
  const { points } = osuTimingLines(res.timing, res.songEnd)
  const grid = new MeasureGrid(points, [])
  const lines = hs.text.split(/\r?\n/)
  let cur: { ms: number; n: number } | null = null
  for (const l of lines) {
    const t = l.trim()
    const mk = /^#(\d+)$/.exec(t)
    if (mk) {
      cur = { ms: Number(mk[1]), n: -1 }
      continue
    }
    if (t.startsWith('/') && t.endsWith('/') && cur && cur.n < 0) {
      const n = t
        .slice(1, -1)
        .replace(/\[[^\]]*\]/g, 'X')
        .replace(/<[^>]*>/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((x) => x && !/^\d+$/.test(x)).length
      cur.n = n
      const m = grid.get(grid.indexAt(cur.ms))
      const beats = measureBeatLayout(m).beats
      measures++
      // 合法：存在某个候选单位 u，使 total = round(beats*u)
      let ok = -1
      for (const u of ALLOWED_UNITS) {
        if (Math.abs(n - beats * u) <= 0.5 + 1e-6) {
          ok = u
          break
        }
      }
      if (ok > 0) {
        unitStat.set(ok, (unitStat.get(ok) || 0) + 1)
      } else {
        const k = `beats=${beats} n=${n}`
        badUnit.set(k, (badUnit.get(k) || 0) + 1)
        if (badSamples.length < 6) badSamples.push(`${src.split(/[\\/]/).slice(-1)[0]} #${cur.ms} beats=${beats} n=${n} :: ${t.slice(0, 120)}`)
      }
    }
  }

  // --- 回读时间误差 ---
  let back: ReturnType<typeof parseChart>
  try {
    back = parseChart(hs.text)
  } catch (e) {
    fail++
    if (fail <= 3) origLog('PARSE FAIL', src, (e as Error).message)
    continue
  }
  const a = res.sounds.map((s) => s.time).sort((x, y) => x - y)
  const b = back.events.map((e) => e.time).sort((x, y) => x - y)
  // 用「排序数组里最近的元素」算误差：不消费、不滑动，避免丢一个音符后
  // 整条序列错位、把后续所有音符都算成大误差。
  let j = 0
  for (const t of a) {
    while (j < b.length - 1 && b[j] < t) j++
    let best = -1
    let bd = Infinity
    for (let k = Math.max(0, j - 2); k < Math.min(b.length, j + 3); k++) {
      const d = Math.abs(b[k] - t)
      if (d < bd) {
        bd = d
        best = k
      }
    }
    if (best < 0) continue
    totalNotes++
    sumErr += bd
    if (bd > maxErr) maxErr = bd
    for (let i = 0; i < buckets.length; i++) {
      if (bd < buckets[i]) {
        hist.set(buckets[i], (hist.get(buckets[i]) || 0) + 1)
        break
      }
    }
    if (bd > 20) worst.push({ f: src.split(/[\\/]/).slice(-2).join('/'), dt: bd, t })
  }
}

console.log = origLog
origLog('谱数:', files.length, ' 失败:', fail, ' 小节数:', measures)
origLog('已放置:', placedAll, ' 未放置:', unplacedAll)
origLog('音符数:', totalNotes, ' 平均误差:', (sumErr / Math.max(1, totalNotes)).toFixed(2), 'ms 最大:', maxErr.toFixed(1), 'ms')
origLog('误差分布:')
let acc = 0
for (const bk of buckets) {
  const c = hist.get(bk) || 0
  acc += c
  origLog(
    `  < ${bk}ms\t${c}\t${((c / Math.max(1, totalNotes)) * 100).toFixed(2)}%\t累计 ${((acc / Math.max(1, totalNotes)) * 100).toFixed(2)}%`,
  )
}
origLog('时值单位分布:')
;[...unitStat.entries()]
  .sort((x, y) => x[0] - y[0])
  .forEach(([k, v]) => origLog(`  1/${k}\t${v}`))
origLog('不合法的单位数:')
if (!badUnit.size) origLog('  （无）')
;[...badUnit.entries()]
  .sort((x, y) => y[1] - x[1])
  .slice(0, 12)
  .forEach(([k, v]) => origLog(`  ${k}\t${v}`))
badSamples.forEach((l) => origLog(`  · ${l}`))
origLog('最差样本:')
worst
  .sort((a, b) => b.dt - a.dt)
  .slice(0, 12)
  .forEach((w) => origLog(`  ${w.dt.toFixed(1)}ms\t${w.t}\t${w.f}`))
