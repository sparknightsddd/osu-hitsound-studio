/**
 * 跨行的滑条 / 转盘：每行只画到行尾，上一行以开口的「=」结束，下一行以「=」开头接着画，
 * 只有真正结束的那一行才画右半圆弧收尾。
 *
 * 行 = 2 小节 = 4000ms（bpm120 / 4/4）：
 *   slider  3800 → 4200（跨 1 行）
 *   spinner 3500 → 8500（跨 3 行：起始行 / 中间行 / 结束行）
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9738
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsspan-'))

// SliderMultiplier 1.4：length 112 → 400ms
const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Span Test
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,3800,2,0,B|300:192,1,112,0|0,0:0|0:0,0:0:0:0:
256,192,3500,8,0,8500,0:0:0:0:
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
  'Title = span',
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
  const id = s.addFile('span.hs', ${JSON.stringify(CHART)})
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
            paths: [...slider.querySelectorAll('path')].map((p) => p.getAttribute('d')),
          }
        : null,
      spinner: spin
        ? {
            paths: [...spin.querySelectorAll('path')].map((p) => ({
              d: p.getAttribute('d'),
              fill: p.getAttribute('fill'),
            })),
          }
        : null,
    }
  }
  return { n: lanes.length, rows: lanes.slice(0, 4).map(read) }
})()`
const d = await ev(DATA)
console.log('DATA', JSON.stringify(d))
const row0 = d.rows[0]
const row1 = d.rows[1]
const row2 = d.rows[2]

T('至少出现 3 条行轨道（起始/中间/结束行）', d.n >= 3, String(d.n))
T('第一行 slider：有头圆、到行尾开口、无尾巴', !!row0.slider && row0.slider.head && !row0.slider.paths[0].includes(' A ') && row0.slider.paths[0].includes('H ' + row0.w), JSON.stringify(row0.slider))
const p0 = row0.spinner ? row0.spinner.paths[row0.spinner.paths.length - 1].d : ''
T('第一行 spinner：左端有 U、右端开口到行尾、内部有阴影', !!row0.spinner && row0.spinner.paths.some((p) => p.fill && p.fill.includes('gd-hatch')) && (p0.match(/A/g) || []).length === 1 && p0.includes('H ' + row0.w), JSON.stringify(row0.spinner))
T('第二行 slider：开头是 =（无头圆）、结尾有半圆弧', !!row1.slider && !row1.slider.head && row1.slider.paths[0].startsWith('M 0 ') && row1.slider.paths[0].includes(' A '), JSON.stringify(row1.slider))
T('第二行 spinner：中间行两头都开口（纯 = ）', !!row1.spinner && row1.spinner.paths[row1.spinner.paths.length - 1].d.startsWith('M 0 ') && !row1.spinner.paths[row1.spinner.paths.length - 1].d.includes(' A '), JSON.stringify(row1.spinner))
T('第三行 spinner：开头是 =、结尾有半圆弧', !!row2.spinner && row2.spinner.paths[row2.spinner.paths.length - 1].d.startsWith('M 0 ') && row2.spinner.paths[row2.spinner.paths.length - 1].d.includes(' A '), JSON.stringify(row2.spinner))
T('第三行没有 slider（它 4200ms 就结束了）', row2.slider === null)

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (sh?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-obj-span.png'), Buffer.from(sh.result.data, 'base64'))
  console.log('SHOT ok')
}
// 放大前三行
const box = JSON.parse(
  await ev(`(() => {
    const row = document.querySelector('.gd-row.has-obj')
    const r = row.getBoundingClientRect()
    return JSON.stringify({ x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: Math.min(1000, window.innerWidth - r.x), height: 340, scale: 2 })
  })()`),
)
const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: box })
if (z?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-obj-span-zoom.png'), Buffer.from(z.result.data, 'base64'))
  console.log('ZOOM ok')
}
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
