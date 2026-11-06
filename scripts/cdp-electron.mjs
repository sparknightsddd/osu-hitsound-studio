/**
 * Electron 客户端实测：以 --remote-debugging-port 启动，连 CDP 检查
 * window.desktop 是否注入、界面是否渲染、IPC 是否可用，并截图。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

// 约定：在项目根目录运行
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
process.on('uncaughtException', (e) => {
  fs.appendFileSync(path.join(ROOT, 'electron-probe.log'), 'UNCAUGHT ' + e.stack + '\n')
  process.exit(1)
})
const PORT = 9355
const OUT = process.argv[2] || path.join(ROOT, 'electron-app.png')
const LOG = path.join(ROOT, 'electron-probe.log')
const lines = []
/** stdout 在重定向到文件时是异步的，process.exit 会丢输出，所以同步写一份日志 */
const say = (...a) => { const s = a.join(' '); lines.push(s); fs.appendFileSync(LOG, s + '\n') }

// ELECTRON_RUN_AS_NODE=1 会让 electron 退化成纯 node（本沙箱环境里就是 1），必须去掉
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)

const logs = []
child.stdout.on('data', (d) => logs.push('[out] ' + d.toString().trim()))
child.stderr.on('data', (d) => logs.push('[err] ' + d.toString().trim()))

async function waitWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page')
        if (page) return page.webSocketDebuggerUrl
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('electron CDP 未就绪')
}

;(async () => {
  const wsUrl = await waitWs()
  const ws = new WebSocket(wsUrl)
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
  const send = (method, params = {}, sid) => {
    const msg = { id: ++id, method, params }
    if (sid) msg.sessionId = sid
    ws.send(JSON.stringify(msg))
    return new Promise((res) => pending.set(msg.id, res))
  }

  // Electron 的 target 本身就能直接 Runtime.evaluate
  await send('Runtime.enable')
  // 等应用渲染
  await new Promise((r) => setTimeout(r, 2500))

  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const d = window.desktop;
      const store = window.__store;
      return JSON.stringify({
        hasDesktop: !!d,
        desktopKeys: d ? Object.keys(d).slice(0, 30) : [],
        isElectron: d ? d.isElectron : false,
        title: document.title,
        rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
        hasEditor: !!document.querySelector('.cm-editor'),
        canvases: document.querySelectorAll('canvas').length,
        menuCount: document.querySelectorAll('.titlebar .menu button').length,
        textLen: (document.body.innerText||'').length,
      })
    })()`,
    returnByValue: true,
  })
  say('PROBE', probe.result?.result?.value)

  // 测一条真实 IPC：拿版本号（走 ipcRenderer -> ipcMain）
  const ver = await send('Runtime.evaluate', {
    expression: `window.desktop ? window.desktop.version().then(v => JSON.stringify(v)) : Promise.resolve('no-desktop')`,
    awaitPromise: true,
    returnByValue: true,
  })
  say('VERSION', ver.result?.result?.value)

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const data = shot.result?.data
  if (data) {
    fs.writeFileSync(OUT, Buffer.from(data, 'base64'))
    say('SAVED', OUT)
  } else {
    say('SHOT_FAILED', JSON.stringify(shot).slice(0, 300))
  }

  say('\n=== 页面 console ===')
  say(consoleLogs.length ? consoleLogs.slice(0, 25).join('\n') : '(无)')
  ws.close()
  child.kill()
  process.exit(0)
})().catch((e) => {
  say('FAILED', e.message)
  say(logs.slice(-25).join('\n'))
  child.kill()
  process.exit(1)
})
