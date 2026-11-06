/** 格子视图写「两段之间的空洞」：真实 UI 下点格子能不能落笔。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9541
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
async function shot(name) {
  await send('Page.bringToFront')
  for (let i = 0; i < 4; i++) {
    const sh = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: i % 2 === 0 }),
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ])
    if (sh?.result?.data) {
      fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
      return
    }
    console.log('SHOT_TRY_FAIL', name, JSON.stringify(sh).slice(0, 300))
    await wait(500)
  }
  console.log('SHOT_FAILED', name)
}
await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const rows = () => [...document.querySelectorAll('.gd-row')]
  const rowAt = (n) => rows().find((r) => (r.querySelector('.gd-gutter')?.textContent || '').trim() === String(n))
  const cells = (r) => [...r.querySelectorAll('.gd-cell')]
  const mouse = (el, type, extra = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...extra }))
  const findCell = (mi, beat = 1) => {
    for (const r of rows()) {
      for (const c of cells(r)) {
        const t = c.getAttribute('title') || ''
        if (t.includes('小节 ' + mi + ' · 第 ' + beat + ' 拍')) return c
      }
    }
    return null
  }
  const clickCell = (mi, beat = 1) => {
    const c = findCell(mi, beat)
    if (!c) return 'no-cell'
    mouse(c, 'mousedown')
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return 'ok'
  }
  const brush = (i = 0) => {
    const b = document.querySelectorAll('.gd-brush')[i]
    if (!b) return 'no-brush'
    b.click()
    return 'ok'
  }
  return { text, rows, rowAt, cells, findCell, clickCell, brush }
})()`

const LOAD = await ev(`(() => {
  const lines = ['[Metadata]','Title = gap','','[Files]','path = ""','audio = ""','',
    '[Define]','hitsound custom Aa = default.soft-hitnormal red','hitsound custom Ab = default.soft-hitclap green','',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0','/Aa = = =/','#16000','/Aa = = =/','']
  const s = window.__store.getState()
  const id = s.addFile('gap.hs', lines.join('\\n'))
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
console.log('LOAD', LOAD)
await wait(1200)

console.log(
  'ROWS',
  await ev(`JSON.stringify({
    rows: ${MOD}.rows().length,
    labels: ${MOD}.rows().map((r) => (r.querySelector('.gd-gutter')?.textContent || '').trim()).slice(0, 14),
    mode: window.__store.getState().editorMode,
    used: window.__store.getState().doc.usedMeasures,
  })`),
)

// 点第 4 小节第 2 格 → 点画笔 Aa
console.log('PICK', await ev(`${MOD}.clickCell(4, 2)`))
await wait(200)
console.log('BRUSH1', await ev(`${MOD}.brush(0)`))
await wait(700)
console.log(
  'AFTER1',
  await ev(`JSON.stringify({
    tail: ${MOD}.text().split('\\n').slice(-8).join(' | '),
    has6000: ${MOD}.text().includes('#6000'),
    hits: window.__store.getState().doc.events.filter((e) => e.measure === 4).map((e) => [e.time, e.names.join('+')]),
    log: (window.__store.getState().output || []).slice(-3),
  })`),
)
await shot('ui-grid-gap.png')

// 再点第 3 小节，用 Ab
console.log('PICK2', await ev(`${MOD}.clickCell(3, 1)`))
await wait(200)
console.log('BRUSH2', await ev(`${MOD}.brush(1)`))
await wait(700)
console.log(
  'AFTER2',
  await ev(`JSON.stringify({
    body: ${MOD}.text().split('[Hitsound]')[1].split('\\n').filter((l) => l.trim()).join(' | '),
    m3: window.__store.getState().doc.events.filter((e) => e.measure === 3).map((e) => [e.time, e.names.join('+')]),
    m4: window.__store.getState().doc.events.filter((e) => e.measure === 4).map((e) => [e.time, e.names.join('+')]),
    m9: window.__store.getState().doc.events.filter((e) => e.measure === 9).map((e) => [e.time, e.names.join('+')]),
    log: (window.__store.getState().output || []).slice(-3),
  })`),
)

// 撤销：两次操作能不能各回一步
console.log(
  'UNDO',
  await ev(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      has6000: ${MOD}.text().includes('#6000'),
      has4000: ${MOD}.text().includes('#4000'),
      body: ${MOD}.text().split('[Hitsound]')[1].split('\\n').filter((l) => l.trim()).join(' | '),
    })), 500))
  })()`),
)
await shot('ui-grid-gap-undo.png')
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
