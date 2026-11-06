/**
 * 滑条折返标记：每段边界画一个「→」。
 * 例：1/2 拍、2 段（来回一次）和 1/2 拍、1 段的总长一样，靠折返箭头区分。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9740
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsrepeat-'))

// SliderMultiplier 1.4 / 500ms 拍：length 70 = 250ms；length 35 = 125ms/段
const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Repeat
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,2,0,B|300:192,1,70,0|0,0:0|0:0,0:0:0:0:
256,192,500,2,0,B|300:192,2,35,0|0,0:0|0:0,0:0:0:0:
256,192,1000,2,0,B|300:192,4,35,0|0,0:0|0:0,0:0:0:0:
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
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
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
  'Title = repeat',
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
  const id = s.addFile('repeat.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  s.setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const DATA = `(() => {
  const lane = document.querySelector('.gd-objlane')
  const sliders = [...lane.querySelectorAll('.gd-obj.slider')].map((g) => {
    const d = g.querySelector('path').getAttribute('d')
    const reps = [...g.querySelectorAll('.gd-rep')].map((p) => {
      const n = Number(/^M ([\\d.-]+)/.exec(p.getAttribute('d'))[1])
      return Math.round((n + 3.2) * 10) / 10
    })
    return { d, reps, tip: g.querySelector('title').textContent }
  })
  return { sliders }
})()`
const d = await ev(DATA)
console.log('DATA', JSON.stringify(d))
const [a, b, c] = d.sliders

T('1 段滑条没有折返箭头', a && a.reps.length === 0, JSON.stringify(a))
T('2 段滑条有 1 个箭头（1/2 拍处）', b && b.reps.length === 1 && Math.abs(b.reps[0] - 163) <= 1, JSON.stringify(b))
T('4 段滑条有 3 个箭头（1125/1250/1375ms）', c && c.reps.length === 3 && Math.abs(c.reps[0] - 283) <= 1 && Math.abs(c.reps[1] - 313) <= 1 && Math.abs(c.reps[2] - 343) <= 1, JSON.stringify(c))
T('提示里写明折返次数', String(b?.tip).includes('折返 1 次') && String(c?.tip).includes('折返 3 次'), JSON.stringify([b?.tip, c?.tip]))
T('两种滑条总长一致（对照）', a && b && a.d.includes('H 73') && b.d.includes('H 193'), JSON.stringify([a?.d, b?.d]))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
const box = JSON.parse(await ev(`(() => {
  const row = document.querySelector('.gd-row.has-obj')
  const r = row.getBoundingClientRect()
  return JSON.stringify({ x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: Math.min(520, window.innerWidth - r.x), height: r.height + 8, scale: 3 })
})()`))
const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: box })
if (z?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-slider-repeat.png'), Buffer.from(z.result.data, 'base64'))
  console.log('SHOT ok')
}
child.kill()
await wait(500)
try { fs.rmSync(USERDATA, { recursive: true, force: true }); fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
process.exit(0)
