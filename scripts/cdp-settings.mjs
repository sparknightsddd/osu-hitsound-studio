/** 打开设置窗、填几个值、保存，再重新打开确认持久化。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9368
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
async function waitWs() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const p = (await r.json()).find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl } } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('CDP 未就绪')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0; const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => { const msg = { id: ++id, method, params }; ws.send(JSON.stringify(msg)); return new Promise((res) => pending.set(msg.id, res)) }
const ev = async (expr, awaitPromise = false) => (await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await new Promise((r) => setTimeout(r, 2500))
try { await send('Page.captureScreenshot', { format: 'png' }) } catch {}
await new Promise((r) => setTimeout(r, 300))

await ev(`localStorage.removeItem('hsstudio.importCodes'); window.__openAppSettings(); 1`)
await new Promise((r) => setTimeout(r, 400))

// 填：soft-hitnormal = "Kk, ="; normal-hitwhistle = "Ka, Kb, Kc"
await ev(`(() => {
  const ins = [...document.querySelectorAll('.set-input')]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  // 行顺序 soft,normal,drum；列顺序 hitnormal,hitwhistle,hitfinish,hitclap
  const idx = (r, c) => r * 4 + c
  const fill = (i, v) => { setter.call(ins[i], v); ins[i].dispatchEvent(new Event('input', { bubbles: true })) }
  fill(idx(0, 0), 'Kk, =')
  fill(idx(1, 1), 'ka, kB, kc1!')
  return ins.length
})()`)
await new Promise((r) => setTimeout(r, 300))
const state = await ev(`JSON.stringify({
  inputs: document.querySelectorAll('.set-input').length,
  whistle: document.querySelectorAll('.set-input')[5].value,
  bad: document.querySelectorAll('.set-input.is-bad').length,
})`)
console.log('STATE', state)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const out = process.argv[2] || path.join(ROOT, 'ui-settings.png')
if (shot.result?.data) fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log('SHOT', out)

// 保存
await ev(`document.querySelector('.si-ok')?.click(); 1`)
await new Promise((r) => setTimeout(r, 300))
const saved = await ev(`localStorage.getItem('hsstudio.importCodes')`)
console.log('SAVED', saved)
const closed = await ev(`!document.querySelector('.set-input')`)
console.log('CLOSED', closed)
child.kill(); process.exit(0)
