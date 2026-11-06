/**
 * 裁剪截取左侧区域，1:1 输出便于确认排版。
 * 用法：node scripts/cdp-crop.mjs [x] [y] [w] [h] [输出]
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9338
const X = Number(process.argv[2] ?? 0)
const Y = Number(process.argv[3] ?? 0)
const W = Number(process.argv[4] ?? 420)
const H = Number(process.argv[5] ?? 700)
const OUT = process.argv[6] || 'C:/Users/31443/WorkBuddy/2026-09-08-00-44-02/crop-left.png'
const { spawn } = await import('node:child_process')
const { writeFileSync } = await import('node:fs')
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-crop',
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
const shot = await send(
  'Page.captureScreenshot',
  { format: 'png', clip: { x: X, y: Y, width: W, height: H, scale: 1 }, captureBeyondViewport: true },
  sid,
)
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
console.log('SAVED', OUT)
ws.close()
chrome.kill()
process.exit(0)
