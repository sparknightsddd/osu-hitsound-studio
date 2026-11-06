/**
 * Keysound 端到端校验：加载 demo -> 检查 keysound 事件 -> 切换钢琴卷帘 -> 截图
 * 用法：node scripts/cdp-keysound.mjs
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9341
const DIR = 'C:/Users/31443/WorkBuddy/2026-09-08-00-44-02'
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
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-ks',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function waitWs() {
  for (let i = 0; i < 80; i++) {
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
const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push(`[EXC] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`)
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
await new Promise((r) => setTimeout(r, 5000))

const shot = async (name) => {
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sid)
  const data = res.result?.data
  if (!data) return console.log('SHOT_FAILED', name)
  writeFileSync(`${DIR}/${name}`, Buffer.from(data, 'base64'))
  console.log('SAVED', `${DIR}/${name}`)
}

// 1) 探测 keysound 状态：通过侧栏文本与 store
const probe = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const txt = document.body.innerText || '';
      const segs = [...document.querySelectorAll('.tl-seg')].map(b => ({ t: b.textContent.trim(), on: b.classList.contains('on') }));
      const canvases = [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height }));
      return JSON.stringify({
        hasKeysoundSection: txt.includes('[Keysound]'),
        hasPianoRollBtn: segs.some(s => s.t.includes('钢琴卷帘')),
        segs, canvases,
        textSample: txt.slice(0, 0),
      })
    })()`,
    returnByValue: true,
  },
  sid,
)
console.log('PROBE1', probe.result?.result?.value)

// 2) 点击「钢琴卷帘」
const click = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const b = [...document.querySelectorAll('.tl-seg')].find(x => x.textContent.includes('钢琴卷帘'));
      if (!b) return 'NO_BTN';
      b.click();
      return 'CLICKED';
    })()`,
    returnByValue: true,
  },
  sid,
)
console.log('CLICK', click.result?.result?.value)
await new Promise((r) => setTimeout(r, 1200))

const probe2 = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const segs = [...document.querySelectorAll('.tl-seg')].map(b => ({ t: b.textContent.trim(), on: b.classList.contains('on') }));
      return JSON.stringify({ segs })
    })()`,
    returnByValue: true,
  },
  sid,
)
console.log('PROBE2', probe2.result?.result?.value)

await shot('keysound-roll.png')

// 3) 切回音效行
await send(
  'Runtime.evaluate',
  { expression: `(() => { const b = [...document.querySelectorAll('.tl-seg')].find(x => x.textContent.includes('音效行')); if (b) b.click(); return 'ok' })()`, returnByValue: true },
  sid,
)
await new Promise((r) => setTimeout(r, 1000))
await shot('keysound-lanes.png')

console.log('\n=== console 日志 ===')
console.log(logs.length ? logs.slice(0, 40).join('\n') : '(无)')

ws.close()
chrome.kill()
process.exit(0)
