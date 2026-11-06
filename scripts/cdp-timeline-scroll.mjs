/** 验证时间轴：1) 音符不再盖住左侧音效名栏；2) 名字栏里滚轮 = 上下滚泳道。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9387
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
  throw new Error('CDP 未就绪')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const shot = async (file) => {
  const s = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), new Promise((r) => setTimeout(r, 6000))])
  if (s?.result?.data) fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'))
}

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))
await shot(path.join(ROOT, 'tl-a.png'))

// 固定切到含音效的谱，再切到时间轴面板
const fixed = await ev(`(() => {
  const s = window.__store.getState()
  const f = s.files.find((x) => /Pinky Hook/.test(x.name)) || s.files[s.files.length - 1]
  if (f) s.setActive(f.id)
  const st = window.__store.getState()
  if (st.panel !== 'timeline') st.setPanel('timeline')
  if (!st.panelOpen) st.togglePanel()
  return JSON.stringify({ file: f?.name, events: window.__store.getState().doc.events.length })
})()`)
console.log('FIXED', fixed)
console.log('LOGS', await ev(`JSON.stringify((window.__store.getState().output || []).slice(-6))`))
await new Promise((r) => setTimeout(r, 1200))

const info = await ev(`(() => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  return JSON.stringify({ canvases: cs.length, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) })
})()`)
console.log('CANVAS', info)
const { left, top, h } = JSON.parse(info)

// 先滚到中间，让左边的音符“越界”到名字栏
await ev(`(() => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  const fire = (x, y, dy) => main.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: dy, bubbles: true, cancelable: true }))
  // 指针放在网格里：滚轮 = 挪光标，这里只用来把视野移开 0 点
  for (let i = 0; i < 12; i++) fire(r.left + 400, r.top + 80, 120)
  return 1
})()`)
await new Promise((r) => setTimeout(r, 800))
await shot(path.join(ROOT, 'tl-b.png'))

// 取「名字栏」和「网格左侧 40px」两块的像素，检查名字栏里没有青色音符块
const before = await ev(`(() => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const ctx = main.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const g = (x, y, w, hh) => Array.from(ctx.getImageData(x * dpr, y * dpr, w * dpr, hh * dpr).data)
  return JSON.stringify({ gutter: g(2, 30, 66, 60).length })
})()`)
console.log('PIX', before)

// 在名字栏里滚轮 -> 应该上下滚动（画布像素变化），而不是挪光标
const lanesInfo = await ev(`(() => {
  const s = window.__store.getState()
  const names = []
  for (const h of s.doc.hitsounds) if (h.name && !names.includes(h.name)) names.push(h.name)
  for (const e of s.doc.events) for (const n of e.names) if (!names.includes(n)) names.push(n)
  return JSON.stringify({ lanes: names.length, names: names.slice(0, 12) })
})()`)
console.log('LANES', lanesInfo)

const gridWheel = await ev(`(() => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  const t = () => (window.__store.getState().cursor?.time ?? -1) + '|' + (document.querySelector('.tl-toolbar .mono')?.textContent || '')
  const a = t()
  main.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 400, clientY: r.top + 100, deltaY: 120, bubbles: true, cancelable: true }))
  return new Promise((res) => setTimeout(() => res(JSON.stringify({ before: a, after: t(), changed: a !== t() })), 300))
})()`)
console.log('GRID_WHEEL', gridWheel)

const scrolled = await ev(`(() => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  const ctx = main.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const snap = () => Array.from(ctx.getImageData(0, 60 * dpr, 200 * dpr, 80 * dpr).data).join(',')
  const a = snap()
  main.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 20, clientY: r.top + 100, deltaY: 120, bubbles: true, cancelable: true }))
  return new Promise((res) => setTimeout(() => res(JSON.stringify({ changed: snap() !== a })), 300))
})()`)
console.log('GUTTER_WHEEL', scrolled)
await new Promise((r) => setTimeout(r, 300))
await shot(path.join(ROOT, 'tl-c.png'))
// 放大到最大，让 0 点附近的音符“越界”到名字栏左侧，检查有没有盖住标签
await ev(`(() => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  for (let i = 0; i < 24; i++) {
    main.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 300, clientY: r.top + 80, deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }))
  }
  return 1
})()`)
await new Promise((r) => setTimeout(r, 800))
await shot(path.join(ROOT, 'tl-d.png'))
child.kill()
process.exit(0)
