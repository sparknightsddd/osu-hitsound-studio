/**
 * 末尾「刚好」落在下一行首格的滑条 / 转盘 —— 也要按跨行显示：
 *   上一行开口画到行尾，下一行从行首接着画，并在首格中心收尾。
 *
 * 行 = 2 小节 = 4000ms（bpm120 / 4/4）：
 *   slider  3600 → 4000（长度 112 = 400ms，正好停在行首格）
 *   spinner 3400 → 4000
 *
 * 改之前：两个物件都只在第一行画完整胶囊，第二行什么都没有。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9741
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsbound-'))

// SliderMultiplier 1.4：length 112 → 400ms
const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Boundary Test
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,3600,2,0,B|300:192,1,112,0|0,0:0|0:0,0:0:0:0:
256,192,3400,8,0,4000,0:0:0:0:
`
fs.writeFileSync(path.join(DIR, 'map.osu'), OSU)

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)
async function waitWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const p = (await r.json()).find((t) => t.type === 'page')
        if (p) return p.webSocketDebuggerUrl
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('cdp')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.text || 'exception')
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    errors.push(d.params.args?.map((a) => a.value ?? a.description).join(' '))
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const dirFwd = DIR.replace(/\\/g, '/')
const CHART = [
  '[Metadata]',
  'Title = boundary',
  '',
  '[Files]',
  `path = "${dirFwd}"`,
  'audio = ""',
  'ImportOsu = "map.osu"',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = ""',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/Aa = = = = = = = = = = = = = = =/',
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('boundary.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  s.setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const DATA = `(() => {
  const lanes = [...document.querySelectorAll('.gd-objlane')]
  const read = (lane) => {
    if (!lane) return null
    const slider = lane.querySelector('.gd-obj.slider')
    const spin = lane.querySelector('.gd-obj.spinner')
    return {
      w: Math.round(lane.getBoundingClientRect().width),
      slider: slider
        ? {
            head: !!slider.querySelector('circle'),
            tip: slider.querySelector('title')?.textContent || '',
            paths: [...slider.querySelectorAll('path')].map((p) => p.getAttribute('d')),
          }
        : null,
      spinner: spin
        ? {
            tip: spin.querySelector('title')?.textContent || '',
            paths: [...spin.querySelectorAll('path')].map((p) => ({
              d: p.getAttribute('d'),
              fill: p.getAttribute('fill'),
            })),
          }
        : null,
    }
  }
  return {
    n: lanes.length,
    cell: document.querySelector('.gd-cell')?.getBoundingClientRect().width || 0,
    rows: lanes.slice(0, 4).map(read),
  }
})()`
const d = await ev(DATA)
console.log('DATA', JSON.stringify(d))
const cellW = d.cell || 24
const row0 = d.rows[0]
const row1 = d.rows[1]
const row2 = d.rows[2]

/** 从收尾路径里取弧心的 x（`A 4.2 4.2 0 0 1 <x> <y>`） */
const arcX = (p) => {
  const m = /A [\d.]+ [\d.]+ 0 0 1 ([\d.]+)/.exec(p || '')
  return m ? Number(m[1]) : NaN
}

T('至少 2 条行轨道', d.n >= 2, String(d.n))
T(
  '第一行 slider：有头、到行尾开口（不在这里收尾）',
  !!row0.slider && row0.slider.head && !row0.slider.paths[0].includes(' A ') && row0.slider.paths[0].includes('H ' + row0.w),
  JSON.stringify(row0.slider),
)
const p0s = row0.spinner ? row0.spinner.paths[row0.spinner.paths.length - 1].d : ''
T(
  '第一行 spinner：左端 U、右端开口到行尾',
  !!row0.spinner && row0.spinner.paths.some((p) => p.fill && p.fill.includes('gd-hatch')) && (p0s.match(/A/g) || []).length === 1 && p0s.includes('H ' + row0.w),
  JSON.stringify(row0.spinner),
)
T(
  '第一行物件提示为跨行',
  !!row0.slider && row0.slider.tip.includes('跨行'),
  row0.slider?.tip,
)
T(
  '第二行 slider：从行首接着画、无头、在首格内收尾',
  !!row1?.slider && !row1.slider.head && row1.slider.paths[0].startsWith('M 0 ') && row1.slider.paths[0].includes(' A ') && arcX(row1.slider.paths[0]) <= cellW * 0.75,
  JSON.stringify(row1?.slider),
)
const p1s = row1?.spinner ? row1.spinner.paths[row1.spinner.paths.length - 1].d : ''
T(
  '第二行 spinner：从行首接着画、在首格内收尾',
  !!row1?.spinner && p1s.startsWith('M 0 ') && p1s.includes(' A ') && arcX(p1s) <= cellW * 0.75,
  JSON.stringify(row1?.spinner),
)
T('第三行没有这两个物件', row2 ? row2.slider === null && row2.spinner === null : true, JSON.stringify(row2))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (sh?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-obj-boundary.png'), Buffer.from(sh.result.data, 'base64'))
  console.log('SHOT ok')
}
const box = JSON.parse(
  await ev(`(() => {
    const row = document.querySelector('.gd-row.has-obj')
    const r = row.getBoundingClientRect()
    return JSON.stringify({ x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: Math.min(1000, window.innerWidth - r.x), height: 300, scale: 2 })
  })()`),
)
const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: box })
if (z?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-obj-boundary-zoom.png'), Buffer.from(z.result.data, 'base64'))
  console.log('ZOOM ok')
}
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
