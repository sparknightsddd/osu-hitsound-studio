/** 打开设置窗、填几个值、保存，再重新打开确认持久化。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9371
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

await ev(`window.__pickSoundPlan(
  [
    { code: { name: 'Aa', sampleSet: 'soft', hitType: 'hitnormal', index: 0, file: 'soft-hitnormal.wav', slot: 'soft-hitnormal', value: '"soft-hitnormal.wav"' }, key: 'soft|hitnormal|0|soft-hitnormal', count: 412 },
    { code: { name: 'Ab', sampleSet: 'soft', hitType: 'hitclap', index: 0, file: '', slot: 'soft-hitclap', value: 'default.soft-hitclap' }, key: 'soft|hitclap|0|soft-hitclap', count: 33 },
    { code: { name: 'Ac', sampleSet: 'soft', hitType: 'hitwhistle', index: 0, file: '', slot: 'soft-hitwhistle', value: 'default.soft-hitwhistle' }, key: 'soft|hitwhistle|0|soft-hitwhistle', count: 12 }
  ],
  'Soft Test [Test].osu',
  { whiteboard: 'soft|hitnormal|0|soft-hitnormal', names: { 'soft|hitclap|0|soft-hitclap': 'Ha', 'soft|hitwhistle|0|soft-hitwhistle': 'Wh' } }
); 1`)
await new Promise((r) => setTimeout(r, 500))
const state = await ev(`JSON.stringify({
  rows: document.querySelectorAll('.si-row').length,
  slots: [...document.querySelectorAll('.si-slot')].map(e => e.textContent),
  badges: document.querySelectorAll('.si-badge').length,
  sum: document.querySelector('.si-sum')?.textContent,
  blankInput: document.querySelectorAll('.si-code-input')[0]?.value,
  disabled: document.querySelectorAll('.si-code-input')[0]?.disabled,
})`)
console.log('STATE', state)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const out = process.argv[2] || path.join(ROOT, 'ui-settings.png')
if (shot.result?.data) fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log('SHOT', out)

child.kill(); process.exit(0)
child.kill(); process.exit(0)
