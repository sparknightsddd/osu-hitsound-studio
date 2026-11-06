/** 时间格式 `mm:ss:xxx` 的三处验证：时间轴工具条 / 标尺 / 格子 tooltip。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9461
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
async function waitWs() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const p = (await r.json()).find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl } } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('cdp')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
const send = (method, params = {}) => { const msg = { id: ++id, method, params }; ws.send(JSON.stringify(msg)); return new Promise((r) => pending.set(msg.id, r)) }
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))

await ev(`(() => {
  const text = ['[Metadata]','Title = t','','[Files]','path = ""','audio = ""','','[Define]','hitsound custom Aa = default.soft-hitnormal red','hitsound custom Ab = default.soft-hitclap green','','[Timing]','0,bpm(120),4,0,0','','[Hitsound]','#0','/Aa = = = Ab = = = Aa = = = Ab = = =/','/Aa = = = Ab = = = Aa = = = Ab = = =/',''].join('\\n')
  const s = window.__store.getState(); const id = s.addFile('timefmt.hs', text); s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 1
})()`)
await new Promise((r) => setTimeout(r, 900))

console.log('GRID_TIP', await ev(`(() => {
  const c = document.querySelectorAll('.gd-row')[0].querySelectorAll('.gd-cell')[4]
  c.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
  return new Promise((res) => setTimeout(() => res(JSON.stringify({
    title: c.getAttribute('title'),
    foot: document.querySelector('.gd-foot')?.textContent,
  })), 300))
})()`))

await ev(`(() => { window.__store.getState().setEditorMode('text'); return 1 })()`)
await new Promise((r) => setTimeout(r, 500))
console.log('TIMELINE', await ev(`JSON.stringify({
  clock: [...document.querySelectorAll('.tl-toolbar .mono')].map(e => e.textContent).slice(0, 2),
  status: [...document.querySelectorAll('.statusbar .item, .status .item')].map(e => e.textContent).join(' | '),
})`))

const s = await Promise.race([send('Page.captureScreenshot', { format: 'png', fromSurface: true }), new Promise((r) => setTimeout(r, 12000))])
if (s?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-timefmt.png'), Buffer.from(s.result.data, 'base64'))
else console.log('SHOT_FAILED')
child.kill()
process.exit(0)
