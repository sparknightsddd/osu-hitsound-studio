/**
 * 切到深色模式并截图，同时扫描 DOM 里「背景仍是浅色」的元素，定位未主题化的样式。
 * 用法：node scripts/cdp-theme.mjs [输出路径] [light|dark]
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9339
const OUT = process.argv[2] || 'C:/Users/31443/WorkBuddy/2026-09-08-00-44-02/ui-dark.png'
const THEME = process.argv[3] || 'dark'
const W = 1680
const H = 1050
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
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-theme',
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
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false }, sid)
await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, sid)
await new Promise((r) => setTimeout(r, 4000))

// 切主题
const set = await send(
  'Runtime.evaluate',
  { expression: `(() => { const s = window.__store; if (!s) return 'NO_STORE'; s.getState().setTheme('${THEME}'); return s.getState().theme })()`, returnByValue: true },
  sid,
)
console.log('THEME_SET', set.result?.result?.value)
await new Promise((r) => setTimeout(r, 1500))

// 扫描浅色残留
const scan = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const isLight = (c) => {
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(c)
        if (!m) return false
        const [r, g, b] = [+m[1], +m[2], +m[3]]
        const a = m[4] === undefined ? 1 : +m[4]
        if (a < 0.5) return false
        return (r * 0.299 + g * 0.587 + b * 0.114) > 200
      }
      const out = []
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el)
        const bg = cs.backgroundColor
        const bgi = cs.backgroundImage
        const hasImg = bgi && bgi !== 'none'
        if (isLight(bg) || (hasImg && /linear-gradient|radial-gradient/.test(bgi) && isLight(bg))) {
          const b = el.getBoundingClientRect()
          if (b.width < 2 || b.height < 2) continue
          out.push({ cls: (String(el.className) || el.tagName).toString().slice(0, 40), bg, w: Math.round(b.width), h: Math.round(b.height), txt: (el.textContent || '').trim().slice(0, 18) })
        }
      }
      // 去重按 cls+bg
      const seen = new Set()
      const uniq = []
      for (const o of out) { const k = o.cls + '|' + o.bg; if (seen.has(k)) continue; seen.add(k); uniq.push(o) }
      return JSON.stringify({ theme: document.documentElement.getAttribute('data-theme'), bodyBg: getComputedStyle(document.body).backgroundColor, lightCount: uniq.length, items: uniq.slice(0, 40) })
    })()`,
    returnByValue: true,
  },
  sid,
)
console.log('SCAN', scan.result?.result?.value)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, sid)
const data = shot.result?.data
if (data) {
  writeFileSync(OUT, Buffer.from(data, 'base64'))
  console.log('SAVED', OUT, Buffer.from(data, 'base64').length, 'bytes')
} else {
  console.log('SHOT_FAILED')
}
ws.close()
chrome.kill()
process.exit(0)
