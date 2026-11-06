/** 编辑器连字检查：>= / <= / != 必须按原样显示，不能被渲染成 ≥ ≤ ≠。 */
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
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const chart = `[Metadata]
Title = ligature
Artist = t
Creator = t

[Files]
path = ""
audio = ""

[Timing]
0,bpm(120),4,0,0

[Hitsound]
## 比较符测试：a >= b, c <= d, e != f, x -> y
#0
/Aa/
`
await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('lig.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  window.__store.getState().setEditorMode('text')
  return 'ok'
})()`)
await wait(1200)

const box = JSON.parse(
  await ev(`(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('比较符'))
    const r = (line || document.querySelector('.cm-editor')).getBoundingClientRect()
    return JSON.stringify({ x: Math.floor(r.x), y: Math.floor(r.y) - 2, width: Math.min(560, Math.ceil(r.width)), height: Math.ceil(r.height) + 4 })
  })()`),
)
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...box, scale: 4 } })
if (shot?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-ligature.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('SHOT ok', JSON.stringify(box))
} else {
  console.log('SHOT failed')
}
console.log('TEXT', await ev(`(() => [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('比较符'))?.textContent || '')()`))
child.kill()
process.exit(0)
