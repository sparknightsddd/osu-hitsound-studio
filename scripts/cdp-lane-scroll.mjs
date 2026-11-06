/**
 * 时间轴竖向滚动验证（用一份 30 个泳道的合成谱，结果确定）：
 *  1) 名字栏里滚轮 → 泳道上下滚动（画布变化），且不挪光标；
 *  2) 网格区里滚轮 → 不滚泳道（还是原来的吸附光标）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9391
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

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const names = [...LETTERS].slice(0, 12).flatMap((a) => ['a', 'b', 'c'].map((b) => a + b)).slice(0, 30)
const define = names.map((n) => `hitsound custom ${n} = default.normal-hitnormal`).join('\n')
const content = `[Metadata]
Title = lane test
Artist = test
[Files]
path = ""
audio = ""
[Define]
${define}
[Timing]
0,bpm(120),4,0,0
[Hitsound]
#0
/${names.slice(0, 8).join(' ')}/
`

const created = await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('lanetest.hs', ${JSON.stringify(content)})
  s.setActive(id)
  const st = window.__store.getState()
  if (st.panel !== 'timeline') st.setPanel('timeline')
  if (!st.panelOpen) st.togglePanel()
  return JSON.stringify({ id, events: window.__store.getState().doc.events.length })
})()`)
console.log('CREATED', created)
await new Promise((r) => setTimeout(r, 1200))
await shot(path.join(ROOT, 'tl-lanes-before.png'))

const scrollOnly = await ev(`(async () => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  main.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 20, clientY: r.top + 100, deltaY: 360, bubbles: true, cancelable: true }))
  return new Promise((res) => setTimeout(() => res('scrolled'), 400))
})()`)
console.log('SCROLLED', scrollOnly)
await shot(path.join(ROOT, 'tl-lanes-scrolled.png'))
// 回顶
await ev(`(() => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  for (let i = 0; i < 5; i++) main.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 20, clientY: r.top + 100, deltaY: -360, bubbles: true, cancelable: true }))
  return 1
})()`)
await new Promise((r) => setTimeout(r, 400))

const result = await ev(`(async () => {
  const cs = [...document.querySelectorAll('.timeline-wrap canvas')]
  const main = cs[0]
  const r = main.getBoundingClientRect()
  const ctx = main.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  // 取左边名字栏整列做指纹
  const snap = () => Array.from(ctx.getImageData(0, 24 * dpr, 70 * dpr, 150 * dpr).data).join(',')
  const wheel = (x, dy) =>
    main.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + x, clientY: r.top + 100, deltaY: dy, bubbles: true, cancelable: true }))
  const wait = (ms) => new Promise((res) => setTimeout(res, ms))

  // 先确认监听器在：Ctrl+滚轮应该改变缩放滑杆
  const zoomEl = () => [...document.querySelectorAll('.tl-toolbar input[type=range]')].pop()
  const z0 = zoomEl()?.value
  main.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 400, clientY: r.top + 100, deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }))
  await wait(200)
  const z1 = zoomEl()?.value

  const a0 = snap()
  wheel(20, 120)          // 名字栏里滚
  await wait(300)
  const a1 = snap()

  wheel(400, 120)         // 网格区滚（不该动泳道）
  await wait(300)
  const a2 = snap()

  wheel(20, -120)         // 再滚回去
  await wait(300)
  const a3 = snap()

  return JSON.stringify({
    gutterScroll: a0 !== a1,
    gridNoLaneScroll: a1 === a2,
    back: a2 !== a3,
    canvases: cs.length,
    zoomWorked: z0 !== z1,
    zoom: [z0, z1],
  })
})()`)
console.log('RESULT', result)
await shot(path.join(ROOT, 'tl-lanes-after.png'))
child.kill()
process.exit(0)
