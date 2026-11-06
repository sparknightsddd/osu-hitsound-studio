/**
 * 量取关键布局元素的 bounding rect，确认当前实际排版。
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9337
const { spawn } = await import('node:child_process')
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-probe',
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

const r = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const pick = (sel) => {
        const e = document.querySelector(sel)
        if (!e) return null
        const b = e.getBoundingClientRect()
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
      }
      const wb = document.querySelector('.workbench')
      const rs = document.querySelector('.sidebar-resizer')
      return JSON.stringify({
        workbenchChildren: wb ? [...wb.children].map((c) => ({ cls: String(c.className).split(' ')[0], w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height), x: Math.round(c.getBoundingClientRect().x) })) : [],
        sidebar: pick('.sidebar'),
        sidebarTitle: pick('.sidebar-title'),
        sidebarBody: pick('.sidebar-body'),
        main: pick('.main'),
        resizer: pick('.sidebar-resizer'),
        resizerCursor: rs ? getComputedStyle(rs).cursor : null,
        resizerTouchAction: rs ? getComputedStyle(rs).touchAction : null,
      })
    })()`,
    returnByValue: true,
  },
  sid,
)
console.log(r.result?.result?.value)
ws.close()
chrome.kill()
process.exit(0)
