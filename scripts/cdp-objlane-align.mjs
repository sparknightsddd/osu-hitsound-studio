/**
 * 物件轨道对位：圆心/U 形弧心对齐格子中心竖线；更细分（1/8 对 1/4）落在缝隙中间；整体灰色。
 *
 * 网格：div=4（每格 125ms）、格 26px、缝 4px → 格中心 13，缝隙中心 28。
 * .osu 里放 0 / 63 / 125 / 188ms 的 circle（1/4 与 1/8 交替），
 * 再加 slider 0→63ms、spinner 0→125ms 验证 U 形位置。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9737
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsalign-'))

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Align Test
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,1,0,0:0:0:0:
256,192,63,1,0,0:0:0:0:
256,192,1000,1,0,0:0:0:0:
256,192,1063,1,0,0:0:0:0:
256,192,1938,1,0,0:0:0:0:
256,192,2000,1,0,0:0:0:0:
256,192,500,2,0,B|300:192,1,100,0|0,0:0|0:0,0:0:0:0:
256,192,1500,8,0,1875,0:0:0:0:
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
  'Title = align',
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
  const id = s.addFile('align.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  s.setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const DATA = `(() => {
  const lane = document.querySelector('.gd-objlane')
  if (!lane) return { lane: false }
  const circles = [...lane.querySelectorAll('.gd-obj.circle circle')].map((c) => Math.round(Number(c.getAttribute('cx')) * 10) / 10)
  const slider = lane.querySelector('.gd-obj.slider')
  const spin = lane.querySelector('.gd-obj.spinner')
  return {
    lane: true,
    circles,
    sliderHead: slider ? Math.round(Number(slider.querySelector('circle').getAttribute('cx')) * 10) / 10 : null,
    sliderD: slider ? slider.querySelector('path').getAttribute('d') : '',
    spinD: spin ? spin.querySelector('path').getAttribute('d') : '',
    color: getComputedStyle(lane).color,
    cellW: Math.round(document.querySelector('.gd-cell').getBoundingClientRect().width),
    cell15Left: document.querySelectorAll('.gd-row .gd-cell')[15].offsetLeft,
    cell16Left: document.querySelectorAll('.gd-row .gd-cell')[16].offsetLeft,
    laneW: Math.round(lane.getBoundingClientRect().width),
  }
})()`
const d = await ev(DATA)
console.log('DATA', JSON.stringify(d))
T('轨道存在', d.lane === true)
// 0ms → 第 1 格中心 13；63ms → 缝隙中心 28；125ms → 第 2 格中心 43；188ms → 缝隙中心 58
T('1/4 音符在格子中心（13 / 253）', d.circles[0] === 13 && d.circles[2] === 253, JSON.stringify(d.circles))
T('1/8 音符在缝隙中间（≈28 / 268）', Math.abs(d.circles[1] - 28) <= 1 && Math.abs(d.circles[3] - 268) <= 1, JSON.stringify(d.circles))
T('滑条头圆也对齐格子中心（133）', d.sliderHead === 133, String(d.sliderHead))
const tailX = Number((/H ([\d.]+)/.exec(d.sliderD) || [])[1])
T('滑条尾弧心按时间落在 1/8 缝附近（≈219）', tailX > 210 && tailX < 228, d.sliderD)
T('转盘两端都是向右/左鼓的半圆（胶囊形）', (d.spinD.match(/A [\d.]+ [\d.]+ 0 0 1/g) || []).length === 2, d.spinD)
T('转盘左右 U 弧心分别在 373 / 463', d.spinD.startsWith('M 373 ') && d.spinD.includes('H 463'), d.spinD)
// 跨小节：第 16 格前面多一个 6px 缝隙元素，应从 490 开始（不是 480）
T('小节边界后格子起点含缝隙（490）', d.cell16Left === 490, String(d.cell16Left))
T('跨小节正拍对齐格子中心（503）', d.circles[5] === 503, JSON.stringify(d.circles))
T('跨小节的 1/8 落在加宽缝隙中心（≈483）', Math.abs(d.circles[4] - 483) <= 1.5, JSON.stringify(d.circles))
T('轨道宽度也算上小节缝隙（966）', d.laneW === 966, String(d.laneW))
T('物件线条是灰色（rgb(97,97,97)）', d.color.replace(/\s/g, '') === 'rgb(97,97,97)', d.color)

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (sh?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-obj-align.png'), Buffer.from(sh.result.data, 'base64'))
  console.log('SHOT ok')
}
// 放大第一行，方便看对齐
const box = JSON.parse(
  await ev(`(() => {
    const row = document.querySelector('.gd-row.has-obj')
    const r = row.getBoundingClientRect()
    return JSON.stringify({ x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: 620, height: r.height + 8, scale: 3 })
  })()`),
)
const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: box })
if (z?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-obj-align-zoom.png'), Buffer.from(z.result.data, 'base64'))
  console.log('ZOOM ok')
}
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
