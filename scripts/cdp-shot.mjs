/**
 * 截取 127.0.0.1:5173 的完整界面，输出 PNG。
 * 用法：node scripts/cdp-shot.mjs [输出路径] [宽] [高]
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9336
const OUT = process.argv[2] || 'C:/Users/31443/WorkBuddy/2026-09-08-00-44-02/ui-preview.png'
const W = Number(process.argv[3] || 1680)
const H = Number(process.argv[4] || 1050)
const { spawn } = await import('node:child_process')
const { writeFileSync } = await import('node:fs')

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-shot',
    `--window-size=${W},${H}`,
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
  throw new Error('chrome ws 未就绪')
}

const wsUrl = await waitWs()
const ws = new WebSocket(wsUrl)
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
// 固定视口，保证每次截图尺寸一致
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: W, height: H, deviceScaleFactor: 2, mobile: false },
  sid,
)
await send('Page.navigate', { url: process.env.SHOT_URL || 'http://127.0.0.1:5173/' }, sid)
// 等首屏渲染 + demo 谱面解析完成
await new Promise((r) => setTimeout(r, 4500))

const probe = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const q = (s) => !!document.querySelector(s)
      return JSON.stringify({
        title: document.title,
        canvas: document.querySelectorAll('canvas').length,
        hasEditor: q('.cm-editor'),
        hasTimeline: q('.timeline-wrap') || document.querySelectorAll('canvas').length > 0,
        textLen: (document.body.innerText || '').length,
      })
    })()`,
    returnByValue: true,
  },
  sid,
)
console.log('PROBE', probe.result?.result?.value)

const shot = await send(
  'Page.captureScreenshot',
  { format: 'png', captureBeyondViewport: false, fromSurface: true },
  sid,
)
const data = shot.result?.data
if (!data) {
  console.log('SHOT_FAILED', JSON.stringify(shot).slice(0, 400))
} else {
  writeFileSync(OUT, Buffer.from(data, 'base64'))
  console.log('SAVED', OUT, Buffer.from(data, 'base64').length, 'bytes')
}

ws.close()
chrome.kill()
process.exit(0)
