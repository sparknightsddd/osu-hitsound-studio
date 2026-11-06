/** 真实谱（Starlight 导入结果）下的格子交互冒烟测试：渲染、拖选、Ctrl+A、控制台报错。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9521
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
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

const file = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)/__test_out.hs'
const load = await ev(`(async () => {
  const r = await window.desktop.readText(${JSON.stringify(file)})
  if (!r.ok) return 'read-failed:' + r.error
  const s = window.__store.getState()
  const id = s.addFile('starlight-grid.hs', r.text)
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
console.log('LOAD', load)
await wait(1600)

console.log(
  'RENDER',
  await ev(`JSON.stringify({
    measures: window.__store.getState().doc.measures.length,
    events: window.__store.getState().doc.events.length,
    rows: document.querySelectorAll('.gd-row').length,
    cells: document.querySelectorAll('.gd-cell').length,
    brushes: document.querySelectorAll('.gd-brush').length,
    selected: document.querySelectorAll('.gd-cell.sel, .gd-cell.insel').length,
    foot: document.querySelector('.gd-foot')?.textContent?.trim().slice(0, 50),
  })`),
)

// 拖选一行里的 9 格
console.log(
  'DRAG',
  await ev(`(() => {
    const row = document.querySelectorAll('.gd-row')[0]
    const cells = [...row.querySelectorAll('.gd-cell')]
    const opt = (el, extra = {}) => new MouseEvent(el, { bubbles: true, cancelable: true, button: 0, ...extra })
    cells[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    for (let i = 1; i <= 8; i++) cells[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: cells[i - 1] }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      sel: document.querySelectorAll('.gd-cell.sel').length,
      insel: document.querySelectorAll('.gd-cell.insel').length,
      foot: document.querySelector('.gd-foot')?.textContent?.trim().slice(0, 60),
    })), 300))
  })()`),
)

// Ctrl+A 后点一个音效：先把选区收缩回来，避免真的重写整首谱
console.log(
  'ALL',
  await ev(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      selected: document.querySelectorAll('.gd-cell.sel, .gd-cell.insel').length,
      foot: document.querySelector('.gd-foot')?.textContent?.trim().slice(0, 40),
    })), 400))
  })()`),
)

await send('Page.bringToFront')
const shot = await Promise.race([
  send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
  new Promise((r) => setTimeout(() => r(null), 15000)),
])
if (shot?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-grid-real2.png'), Buffer.from(shot.result.data, 'base64'))

console.log(
  'CLIPBOARD',
  await ev(`(async () => {
    const has = typeof window.desktop.clipboardReadText === 'function'
    await window.desktop.clipboardWriteText('hss-test')
    const read = await window.desktop.clipboardReadText()
    return JSON.stringify({ has, read })
  })()`),
)

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
