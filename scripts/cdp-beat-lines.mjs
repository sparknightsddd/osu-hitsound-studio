/** 小节第一拍（动）粗线、其它拍细线：网格 + 时间轴两张对照图。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9591
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
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
async function shotEl(sel, name, scale = 3, pad = 4, nth = 0) {
  const box = JSON.parse(
    await ev(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(sel)})
      const el = els[${nth}]
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.max(0, Math.floor(r.x) - ${pad}), y: Math.max(0, Math.floor(r.y) - ${pad}), width: Math.ceil(r.width) + ${pad * 2}, height: Math.ceil(r.height) + ${pad * 2} })
    })()`),
  )
  if (!box) return 'no-el'
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...box, scale } })
  if (sh?.result?.data) {
    fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
    return 'ok'
  }
  return 'fail'
}
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const LOAD = await ev(`(() => {
  const lines = ['[Metadata]','Title = beats','','[Files]','path = ""','audio = ""','',
    '[Define]','hitsound soft-hitclap Aa = default.soft-hitclap','',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0','/= = = =/','#8000','/= = = =/','']
  const s = window.__store.getState()
  const id = s.addFile('beats.hs', lines.join('\\n'))
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
console.log('LOAD', LOAD)
await wait(1200)

// 网格：抓第一行（4 拍 × 4 等分）
console.log('GRID', await shotEl('.gd-row', 'ui-beat-lines-grid.png', 3, 6))
console.log(
  'GRIDINFO',
  await ev(`(() => {
    const row = document.querySelectorAll('.gd-row')[0]
    const cells = [...row.querySelectorAll('.gd-cell')].slice(0, 9)
    return JSON.stringify(cells.map((c) => getComputedStyle(c).borderTopWidth + '/' + getComputedStyle(c).borderTopColor))
  })()`),
)

// 时间轴：底部面板（默认就是时间轴页，别去点它，点了会切走）
console.log('PANELS', await ev(`JSON.stringify({ canvases: document.querySelectorAll('canvas').length, wrap: !!document.querySelector('.timeline-wrap'), tabs: [...document.querySelectorAll('.bp-tab')].map((b) => b.textContent.trim()) })`))
console.log('TL', await shotEl('.timeline-wrap', 'ui-beat-lines-timeline.png', 3, 2, 0))
{
  const box = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector('.timeline-wrap').getBoundingClientRect()
      return JSON.stringify({ x: Math.max(0, Math.floor(r.x)), y: Math.floor(r.y), width: 460, height: Math.ceil(r.height) })
    })()`),
  )
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...box, scale: 5 } })
  if (sh?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-beat-lines-timeline-zoom.png'), Buffer.from(sh.result.data, 'base64'))
  console.log('TLZOOM', box.width, box.height)
}
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
