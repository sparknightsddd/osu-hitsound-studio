/**
 * 连到已经在跑的 Electron（--remote-debugging-port=9355），
 * 检查 window.desktop 注入 / 界面渲染 / IPC 可用性，并截图。
 * 用法：node scripts/cdp-probe-electron.mjs [输出png]
 */
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default

const PORT = Number(process.env.CDP_PORT || 9355)
const OUT = process.argv[2] || path.join(process.cwd(), 'electron-app.png')
const LOG = path.join(process.cwd(), 'electron-probe.log')
const lines = []
const say = (...a) => {
  const s = a.join(' ')
  lines.push(s)
  fs.appendFileSync(LOG, s + '\n')
}
try {
  fs.unlinkSync(LOG)
} catch {}

process.on('uncaughtException', (e) => {
  say('UNCAUGHT ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  say('NO_PAGE')
  process.exit(1)
}
say('URL', page.url)
say('TITLE', page.title)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let id = 0
const pending = new Map()
const consoleLogs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  } else if (m.method === 'Runtime.consoleAPICalled') {
    consoleLogs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleLogs.push(`[EXC] ${m.params.exceptionDetails.text}`)
  }
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 1500))

const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const d = window.desktop;
    return JSON.stringify({
      hasDesktop: !!d,
      isElectron: d ? d.isElectron : false,
      desktopKeys: d ? Object.keys(d) : [],
      url: location.href,
      title: document.title,
      rootChildren: document.getElementById('root')?.children.length ?? -1,
      hasEditor: !!document.querySelector('.cm-editor'),
      canvases: document.querySelectorAll('canvas').length,
      menuButtons: [...document.querySelectorAll('.titlebar .menu > div > button')].map(b=>b.textContent),
      saveBtn: [...document.querySelectorAll('.tb-btn')].map(b=>b.textContent.trim()),
      textLen: (document.body.innerText||'').length,
    })
  })()`,
  returnByValue: true,
})
say('PROBE', probe.result?.result?.value)

// 真实 IPC 往返：问主进程版本号
const ver = await send('Runtime.evaluate', {
  expression: `window.desktop ? window.desktop.version().then(v=>JSON.stringify(v)).catch(e=>'ERR:'+e.message) : Promise.resolve('no-desktop')`,
  awaitPromise: true,
  returnByValue: true,
})
say('IPC_VERSION', ver.result?.result?.value)

// 再测一条：读 userData 里的 prefs（走 fs 通道）
const prefs = await send('Runtime.evaluate', {
  expression: `window.desktop ? window.desktop.getPrefs().then(v=>JSON.stringify(v)).catch(e=>'ERR:'+e.message) : Promise.resolve('no-desktop')`,
  awaitPromise: true,
  returnByValue: true,
})
say('IPC_PREFS', prefs.result?.result?.value)

// 无 GPU 环境下 fromSurface:true 会挂住，走 surface=false
const shot = await Promise.race([
  send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
  new Promise((r) => setTimeout(() => r({ result: {} }), 15000)),
])
const data = shot.result?.data
if (data) {
  fs.writeFileSync(OUT, Buffer.from(data, 'base64'))
  say('SAVED', OUT, Buffer.from(data, 'base64').length, 'bytes')
} else {
  say('SHOT_FAILED', JSON.stringify(shot).slice(0, 300))
}

say('\n=== 页面 console ===')
say(consoleLogs.length ? consoleLogs.slice(0, 25).join('\n') : '(无)')
ws.close()
process.exit(0)
