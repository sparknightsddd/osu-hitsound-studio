// 把示例清空、缩放到 1 小节只有几个等分、扫刻度颜色直方图
import { spawn } from 'node:child_process'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9336
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-tickcheck', 'about:blank'],
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
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
await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, sid)
await new Promise((r) => setTimeout(r, 3500))

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 }, sid)
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

// 1) 切到亮色；2) 清空正文（保留 [Timing] 一行 bpm(120) 4/4）；3) 细分=8
const seed = await ev(`(() => {
  const html = document.documentElement
  if (html.dataset.theme === 'dark' || html.classList.contains('dark')) {
    const btns = Array.from(document.querySelectorAll('button'))
    const theme = btns.find(b => /主题|theme/i.test(b.title || '') || /明|亮|暗/.test(b.textContent || ''))
    theme?.click()
  }
  const store = (window).__store.getState()
  const id = store.activeId
  const src = store.files.find(f => f.id === id).content
  // 保留 metadata/settings/define/timing，扔掉 hitsound 后所有内容
  const m = src.split(/\\[Hitsound\\]/i)
  const emptyBars = Array(8).fill('/ /').join('\n')
  const newSrc = m[0] + '\\n[Hitsound]\\n' + emptyBars
  store.updateContent(id, newSrc)
  store.reparse()
  const inp = document.querySelector('input[type=number]')
  if (inp) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, '8')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return {
    theme: html.dataset.theme,
    gridLen: (window).__store.getState().doc.measures.length,
    eventsLen: (window).__store.getState().doc.events.length,
  }
})()`)
console.log('seed:', seed)
await new Promise((r) => setTimeout(r, 1500))

const out = await ev(`(() => {
  function hex(r,g,b){return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}
  const c = document.querySelectorAll('.timeline-wrap canvas')[0]
  if (!c) return null
  const off = document.createElement('canvas')
  off.width = c.width; off.height = c.height
  const ctx = off.getContext('2d')
  ctx.drawImage(c, 0, 0)
  const img = ctx.getImageData(0, 0, off.width, off.height)
  const data = img.data
  const W = off.width, H = off.height
  const headerEnd = Math.round(H * 0.16)
  const bottom = H - 22
  const hist = new Map()
  for (let y = headerEnd; y < bottom; y++) {
    for (let x = 90; x < W; x++) {
      const i = (y * W + x) * 4
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3]
      if (a < 200) continue
      const mn = Math.min(r,g,b), mx = Math.max(r,g,b)
      if (r > 235 && g > 235 && b > 235) continue
      if (r < 30 && g < 30 && b < 30) continue
      if (mx - mn < 22) continue
      const k = hex(r,g,b)
      hist.set(k, (hist.get(k) || 0) + 1)
    }
  }
  const strips = []
  let prev = null
  for (let x = 90; x < W; x++) {
    for (let y = headerEnd; y < bottom; y++) {
      const i = (y * W + x) * 4
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3]
      if (a < 200) continue
      const mn = Math.min(r,g,b), mx = Math.max(r,g,b)
      if (mx - mn < 25) continue
      const k = hex(r,g,b)
      if (k !== prev) { strips.push(k); prev = k }
      break
    }
    if (strips.length > 60) break
  }
  return { W, H, hist: [...hist.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 16), strips }
})()`)
console.log('image', out.W + 'x' + out.H)
console.log('top colors (non-bg):')
for (const [k, c] of out.hist) console.log(' ', k, c)
console.log('color sequence first strips:', out.strips.slice(0, 20).join(' → '))

ws.close()
chrome.kill()
process.exit(0)
