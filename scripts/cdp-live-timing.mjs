// 模拟真实编辑：正文只有 2 小节，[Timing] 在 40s 处变速，
// 验证时间轴网格覆盖到变速点且刻度疏密有变化；再改一次 BPM 看是否立即更新。
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9338
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--mute-audio', '--no-first-run', '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-live', 'about:blank'],
  { stdio: 'ignore' },
)
async function waitWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no ws')
}
const wsUrl = await waitWs()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const errs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}, sid) {
  const msg = { id: ++id, method, params }
  if (sid) msg.sessionId = sid
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}
const { result } = await send('Target.createTarget', { url: 'about:blank' })
const { result: att } = await send('Target.attachToTarget', { targetId: result.targetId, flatten: true })
const sid = att.sessionId
await send('Runtime.enable', {}, sid)
await send('Page.enable', {}, sid)
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, sid)
await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, sid)
await new Promise((r) => setTimeout(r, 3500))

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 }, sid)
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

const base = [
  '[Metadata]',
  'Title = Live Timing',
  '',
  '[Define]',
  'hitsound custom K = default.normal-hitnormal',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '40000,bpm(240),4,0,0',
  '',
  '[Hitsound]',
  '/K K K K/',
  '/K K K K/',
].join('\n')

const seeded = await ev(`(() => {
  const store = window.__store
  if (!store) return { err: 'no store' }
  store.getState().newFile('live.hs.txt', ${JSON.stringify(base)})
  store.getState().reparse()
  const d = store.getState().doc
  return {
    used: d.usedMeasures,
    grid: d.measures.length,
    lastEnd: Math.round(d.measures[d.measures.length - 1].end),
    bpmAt: d.measures.filter(m => m.start >= 40000).slice(0, 2).map(m => Math.round(60000 / m.beatLength)),
  }
})()`)
console.log('正文 2 小节 / Timing 40s 处变 240BPM:')
console.log('  usedMeasures =', seeded.used, '| grid =', seeded.grid, '| 网格末尾 =', seeded.lastEnd + 'ms')
console.log('  40s 之后的 BPM =', seeded.bpmAt.join(','), seeded.bpmAt[0] === 240 ? 'OK 变速已反映' : '✗ 未反映')

// 把 240 改成 60，验证改完立即生效
const changed = await ev(`(() => {
  const store = window.__store
  const st = store.getState()
  const id = st.activeId
  const src = st.files.find(f => f.id === id).content.replace('40000,bpm(240),4,0,0', '40000,bpm(60),4,0,0')
  st.updateContent(id, src)
  st.reparse()
  const d = store.getState().doc
  return {
    bpmAt: d.measures.filter(m => m.start >= 40000).slice(0, 2).map(m => Math.round(60000 / m.beatLength)),
  }
})()`)
console.log('改成 60BPM 后：40s 之后的 BPM =', changed.bpmAt.join(','), changed.bpmAt[0] === 60 ? 'OK 立即更新' : '✗ 未更新')

console.log('ERRORS:', errs.length ? errs.join('\n') : '(none)')
ws.close()
chrome.kill()
process.exit(0)
