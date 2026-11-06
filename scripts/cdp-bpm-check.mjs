// 注入变速谱面，读出时间轴上刻度线的实际 x 坐标，验证疏密随 BPM 变化
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9337
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--mute-audio', '--no-first-run', '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-bpm', 'about:blank'],
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
// 放大视口，否则时间轴太窄只能看到开头
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, sid)
await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, sid)
await new Promise((r) => setTimeout(r, 3500))

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 }, sid)
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

// 注入：120BPM(500ms/拍) 走 4 小节 → 240BPM(250ms/拍)
const src = [
  '[Metadata]',
  'Title = BPM Test',
  '',
  '[Define]',
  'hitsound custom K = default.normal-hitnormal',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '4000,bpm(240),4,0,0',
  '',
  '[Hitsound]',
  '/K K K K/',
  '/K K K K/',
  '/K K K K/',
  '/K K K K/',
  '/K K K K/',
  '/K K K K/',
  '/K K K K/',
  '/K K K K/',
].join('\n')

const seeded = await ev(`(() => {
  const store = window.__store
  if (!store) return { err: 'no store' }
  const id = store.getState().newFile ? null : null
  store.getState().newFile('bpm-test.hs.txt', ${JSON.stringify(src)})
  store.getState().reparse()
  const st = store.getState()
  return {
    measures: st.doc.measures.slice(0, 8).map(m => [Math.round(m.start), Math.round(m.end), Math.round(m.beatLength)]),
  }
})()`)
console.log('measures [start,end,beatLength]:')
for (const m of seeded.measures || []) console.log('  ', m)

await new Promise((r) => setTimeout(r, 800))

// 缩放以便看清：把 ppsec 调到较小值，让 8 小节都进画面
const scaled = await ev(`(() => {
  const inputs = Array.from(document.querySelectorAll('input[type=number]'))
  // 第一个 number input 是「细分」，找到范围更大的那个作为缩放（如果有的话）
  return inputs.length
})()`)
console.log('number inputs:', scaled)

// 读画布上「整拍黑线」的 x 坐标：扫描 header 之下的一行像素，找深色竖线
const lines = await ev(`(() => {
  const c = document.querySelectorAll('.timeline-wrap canvas')[0]
  if (!c) return null
  const off = document.createElement('canvas')
  off.width = c.width; off.height = c.height
  const ctx = off.getContext('2d')
  ctx.drawImage(c, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  const W = off.width, H = off.height
  // 取 header 之下的一行（lane 区域中部）找竖线：像素明显偏离该行背景
  const y = Math.round(H * 0.55)
  const xs = []
  for (let x = 80; x < W; x++) {
    const i = (y * W + x) * 4
    const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3]
    if (a < 200) continue
    // 竖线：与左右邻居差异明显
    const li = (y * W + (x - 1)) * 4
    const ri = (y * W + (x + 1)) * 4
    const dLeft = Math.abs(d[li] - r) + Math.abs(d[li+1] - g) + Math.abs(d[li+2] - b)
    const dRight = Math.abs(d[ri] - r) + Math.abs(d[ri+1] - g) + Math.abs(d[ri+2] - b)
    if (dLeft + dRight > 60) xs.push(x)
  }
  return { W, H, xs }
})()`)
if (!lines) { console.log('no canvas'); ws.close(); chrome.kill(); process.exit(2) }
console.log('canvas', lines.W + 'x' + lines.H)
console.log('vertical line x positions:', lines.xs.join(','))
if (lines.xs.length > 2) {
  const gaps = []
  for (let i = 1; i < lines.xs.length; i++) gaps.push(lines.xs[i] - lines.xs[i - 1])
  console.log('gaps between lines:', gaps.join(','))
  const uniq = [...new Set(gaps)].sort((a, b) => a - b)
  console.log('distinct gaps:', uniq.join(','), uniq.length > 1 ? '=> 刻度疏密有变化 OK' : '=> 恒定间距（可能未生效）')
}
console.log('ERRORS:', errs.length ? errs.join('\n') : '(none)')

ws.close()
chrome.kill()
process.exit(0)
