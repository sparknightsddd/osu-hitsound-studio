/** 导入出来的谱：自动绑定样本是否成功（点格子能不能试听）。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9551
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
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

const FILE = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)/__test_out.hs'
console.log(
  'LOAD',
  await ev(`(async () => {
    const r = await window.desktop.readText(${JSON.stringify(FILE)})
    if (!r.ok) return 'read-failed:' + r.error
    const s = window.__store.getState()
    const id = s.addFile('bind-test.hs', r.text)
    s.setActive(id)
    return 'ok'
  })()`),
)
await wait(4000)

console.log(
  'DEFS',
  await ev(`JSON.stringify(window.__store.getState().doc.hitsounds.map((h) => [h.name, h.slot, h.value, h.defaultRef || '']))`),
)
console.log(
  'BOUND',
  await ev(`JSON.stringify({
    names: window.__engine.boundSampleNames(),
    hasAb: window.__engine.hasSound('Ab'),
    hasAa: window.__engine.hasSound('Aa'),
    hasAc: window.__engine.hasSound('Ac'),
    bindings: Object.keys(window.__store.getState().bindings),
    log: (window.__store.getState().output || []).slice(-6),
  })`),
)
console.log(
  'PLAY',
  await ev(`JSON.stringify({
    ab: window.__engine.playSample('Ab', 80),
    aa: window.__engine.playSample('Aa', 80),
    missing: window.__engine.playSample('Zz', 80),
  })`),
)
const DIR = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)'
console.log(
  'ASSETS',
  await ev(`(async () => {
    const res = await window.desktop.resolveChartAssets({ chartPath: '', dir: ${JSON.stringify(DIR)}, audio: 'audio.mp3' })
    const hit = (res.assets || []).filter((a) => /hitnormal/.test(a.name))
    const read = {}
    for (const n of ['soft-hitnormal8.wav', 'drum-hitnormal18.wav', 'normal-hitnormal8.wav']) {
      const r = await window.desktop.readBinary(${JSON.stringify(DIR)} + '/' + n)
      read[n] = r.ok ? (r.data ? 'ok:' + r.data.length : 'ok:empty') : 'fail:' + r.error
    }
    return JSON.stringify({ count: res.assets?.length, hit, read })
  })()`),
)
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
