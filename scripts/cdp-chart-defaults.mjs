/** 设置「谱面」页：6 个开关 + PreferredIndex，保存后新建的谱面要用上新值。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9571
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
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    errors.push(d.params.args?.map((a) => a.value ?? a.description).join(' '))
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(name) {
  await send('Page.bringToFront')
  for (let i = 0; i < 4; i++) {
    const sh = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: i % 2 === 0 }),
      new Promise((r) => setTimeout(r, 12000)),
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

await ev(`localStorage.removeItem('hsstudio.chartDefaults'); 1`)
console.log('OPEN', await ev(`(() => { window.__openAppSettings(); return 'ok' })()`))
await wait(600)
console.log('TABS', await ev(`JSON.stringify([...document.querySelectorAll('.set-tab')].map((b) => b.textContent.trim()))`))
console.log(
  'GO',
  await ev(`(() => {
    const b = [...document.querySelectorAll('.set-tab')].find((x) => x.textContent.trim() === '谱面')
    if (!b) return 'no-tab'
    b.click()
    return 'ok'
  })()`),
)
await wait(350)
console.log(
  'PAGE',
  await ev(`JSON.stringify({
    sub: document.querySelector('.osu-diff-sub')?.textContent.trim(),
    checks: [...document.querySelectorAll('.set-body .set-check')].map((l) => ({
      key: l.querySelector('.mono')?.textContent.trim(),
      on: l.querySelector('input')?.checked,
    })),
    index: [...document.querySelectorAll('.set-body input')].find((i) => i.value.includes('{'))?.value,
  })`),
)
await shot('ui-settings-chart-defaults.png')

// 改：SpinnerHitsound 勾上、PreferredIndex 改成 7, 8
console.log(
  'EDIT',
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.set-body .set-check')]
    const row = rows.find((l) => (l.querySelector('.mono')?.textContent || '').includes('SpinnerHitsound'))
    if (!row) return 'no-spinner'
    const box = row.querySelector('input')
    if (!box.checked) box.click()
    const idx = [...document.querySelectorAll('.set-body input')].find((i) => i.value.includes('{'))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(idx, '7, 8')
    idx.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`),
)
await wait(300)
console.log('SAVE', await ev(`(() => { document.querySelector('.si-ok')?.click(); return 'clicked' })()`))
await wait(600)
console.log('STORED', await ev(`localStorage.getItem('hsstudio.chartDefaults')`))

// 新建一份谱：默认内容应该带上新值
console.log(
  'NEW',
  await ev(`(() => {
    const s = window.__store.getState()
    s.newFile('__defaults_test.hs')
    const st = window.__store.getState()
    const f = st.files.find((x) => x.name === '__defaults_test.hs')
    const block = (f?.content || '').split('[Settings]')[1]?.split('[')[0] || ''
    return JSON.stringify({
      spinner: /SpinnerHitsound = true/.test(block),
      index: /PreferredIndex = \\{7, 8\\}/.test(block),
      block,
    })
  })()`),
)
await shot('ui-settings-chart-defaults-applied.png')

// 清理：删掉测试文件、清掉偏好
await ev(`(() => {
  const st = window.__store.getState()
  const f = st.files.find((x) => x.name === '__defaults_test.hs')
  if (f) st.closeFile(f.id)
  localStorage.removeItem('hsstudio.chartDefaults')
  return 'ok'
})()`)
console.log('CLEANED', await ev(`localStorage.getItem('hsstudio.chartDefaults')`))
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
