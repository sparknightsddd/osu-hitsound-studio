/** 设置窗里的「导出音效 · 槽位优先级」：显示、校验、保存后持久化。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9561
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
  throw new Error('cdp')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.text || 'exception')
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(name) {
  await send('Page.bringToFront')
  for (let i = 0; i < 4; i++) {
    const sh = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ])
    if (sh?.result?.data) {
      fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
      return
    }
    await wait(400)
  }
  console.log('SHOT_FAILED', name)
}
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

await ev(`localStorage.removeItem('hsstudio.export'); window.__openAppSettings(); 1`)
await wait(500)

console.log(
  'UI',
  await ev(`JSON.stringify({
    sections: [...document.querySelectorAll('.set-section-title')].map((e) => e.textContent),
    value: ([...document.querySelectorAll('.set-dialog input.mono')] || []).map((e) => e.value).filter((v) => v.includes('hitwhistle'))[0] || '',
    restore: [...document.querySelectorAll('.set-dialog .btn')].some((b) => b.textContent.includes('恢复默认')),
    cleanOld: [...document.querySelectorAll('.set-dialog .set-check')].map((l) => l.textContent.trim().slice(0, 20)),
  })`),
)
await shot('ui-export-settings.png')

const setter = `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`
// 1) 非法：少一个
console.log(
  'BAD',
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('.set-dialog input.mono')]
    const el = inputs.find((e) => (e.placeholder || '').includes('hitwhistle'))
    if (!el) return 'no-input'
    ${setter}.call(el, 'sw, sf, sc, nw, nf, nc, dw')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      disabled: document.querySelector('.si-ok')?.disabled,
      hint: document.querySelector('.osu-diff-hint')?.textContent?.slice(0, 60),
    })), 250))
  })()`),
)

// 2) 合法且自定义顺序 + 勾选清理旧导出（分步执行，避免嵌套 Promise 卡住）
console.log(
  'FILL',
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('.set-dialog input.mono')]
    const el = inputs.find((e) => (e.placeholder || '').includes('hitwhistle'))
    ${setter}.call(el, 'nw, nc, nf, sw, sc, sf, dw, dc, df')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    const check = [...document.querySelectorAll('.set-dialog .set-check input')].find(
      (x) => x.type === 'checkbox' && (x.closest('.set-check')?.textContent || '').includes('EZHS'),
    )
    if (!check) return 'no-checkbox'
    if (!check.checked) check.click()
    return 'ok'
  })()`),
)
await wait(400)
console.log('BTNSTATE', await ev(`JSON.stringify({ disabled: document.querySelector('.si-ok')?.disabled })`))
console.log('CLICK', await ev(`(() => { const b = document.querySelector('.si-ok'); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`))
await wait(600)
console.log('STORED', await ev(`localStorage.getItem('hsstudio.export')`))
console.log('OPEN', await ev(`!!document.querySelector('.set-dialog')`))

// 3) 重开确认持久化
await wait(400)
await ev(`window.__openAppSettings(); 1`)
await wait(400)
console.log(
  'REOPEN',
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('.set-dialog input.mono')]
    const el = inputs.find((e) => (e.placeholder || '').includes('hitwhistle'))
    return JSON.stringify({ value: el?.value || '' })
  })()`),
)
// 清理本次测试写入的偏好，别影响真实使用
await ev(`localStorage.removeItem('hsstudio.export'); 1`)
console.log('CLEANED', await ev(`localStorage.getItem('hsstudio.export')`))
console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
process.exit(0)
