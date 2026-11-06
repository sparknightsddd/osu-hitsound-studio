/**
 * 模拟拖拽侧栏分隔条（CDP Input.dispatchMouseEvent -> pointer 事件），
 * 验证：宽度跟随、localStorage 持久化、双击恢复默认。
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9339
const { spawn } = await import('node:child_process')
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-drag',
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
async function waitWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no ws')
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
function send(method, params = {}, sid) {
  const msg = { id: ++id, method, params }
  if (sid) msg.sessionId = sid
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}
const { result } = await send('Target.createTarget', { url: 'about:blank' })
const { result: att } = await send('Target.attachToTarget', { targetId: result.targetId, flatten: true })
const sid = att.sessionId
await send('Page.enable', {}, sid)
await send('Runtime.enable', {}, sid)
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false }, sid)
await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, sid)
await new Promise((r) => setTimeout(r, 4500))

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid)
  return r.result?.result?.value
}
const widthOf = () => ev(`document.querySelector('.sidebar').getBoundingClientRect().width`)
const ls = () => ev(`localStorage.getItem('hss.sidebarWidth')`)

console.log('初始宽度', await widthOf(), 'ls=', await ls())

// 在分隔条中心 (308, 500) 按下，向右拖 200px
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)

const startX = 308
const startY = 500
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 }, sid)
for (let x = startX + 20; x <= startX + 200; x += 20) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: startY, button: 'left', buttons: 1 }, sid)
  await new Promise((r) => setTimeout(r, 16))
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 200, y: startY, button: 'left', buttons: 0, clickCount: 1 }, sid)
await new Promise((r) => setTimeout(r, 100))

const w1 = await widthOf()
T('向右拖 200px -> 宽度 460', Math.abs(w1 - 460) < 1, 'w=' + w1)
T('拖拽后写入 localStorage', (await ls()) === '460', 'ls=' + (await ls()))
T('拖拽后仍可交互（body class 已清）', (await ev(`document.body.className`)) === '', 'body=' + (await ev(`document.body.className`)))

// 向左拖回 260
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 508, y: startY, button: 'left', buttons: 1, clickCount: 1 }, sid)
for (let x = 508 - 20; x >= 308; x -= 20) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: startY, button: 'left', buttons: 1 }, sid)
  await new Promise((r) => setTimeout(r, 16))
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 308, y: startY, button: 'left', buttons: 0, clickCount: 1 }, sid)
await new Promise((r) => setTimeout(r, 100))
console.log('拖回后宽度', await widthOf())

// 双击恢复默认
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 308, y: startY, button: 'left', buttons: 1, clickCount: 1 }, sid)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 308, y: startY, button: 'left', buttons: 0, clickCount: 1 }, sid)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 308, y: startY, button: 'left', buttons: 1, clickCount: 2 }, sid)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 308, y: startY, button: 'left', buttons: 0, clickCount: 2 }, sid)
await new Promise((r) => setTimeout(r, 150))
const w2 = await widthOf()
T('双击恢复默认 260', Math.abs(w2 - 260) < 1, 'w=' + w2)

// 极限拖拽（拖到 2000px）应被钳制
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 308, y: startY, button: 'left', buttons: 1, clickCount: 1 }, sid)
for (let x = 328; x <= 2000; x += 40) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: startY, button: 'left', buttons: 1 }, sid)
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2000, y: startY, button: 'left', buttons: 0, clickCount: 1 }, sid)
await new Promise((r) => setTimeout(r, 100))
const w3 = await widthOf()
T('拖到屏幕边缘被钳制（<=720）', w3 <= 720 && w3 > 500, 'w=' + w3)

// 刷新后宽度保持
await ev(`location.reload()`)
await new Promise((r) => setTimeout(r, 3000))
const w4 = await widthOf()
T('刷新后宽度保持', Math.abs(w4 - w3) < 1, 'w=' + w4)

ws.close()
chrome.kill()
process.exit(0)
