/**
 * 调整「格大小」时保持锚点行不动：
 *  - 有选区：固定选区第一格所在行；
 *  - 无选区：固定视口正中间那一行。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9741
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
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
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
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
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const measure = '/Aa = = = = = = = = = = = = = = =/'
const CHART = [
  '[Metadata]',
  'Title = zoom anchor',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = ""',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  ...Array(40).fill(measure),
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('zoomanchor.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  s.setEditorMode('grid')
  window.__store.getState().setPanelHeight(420)
  return 'ok'
})()`)
await wait(1200)

const SNAP = `(() => {
  const sc = document.querySelector('.gd-scroll')
  const sr = sc.getBoundingClientRect()
  const rows = [...document.querySelectorAll('.gd-row')]
  const midY = sr.top + sr.height / 2
  const row = rows.find((r) => { const b = r.getBoundingClientRect(); return b.top <= midY && b.bottom >= midY }) || rows[0]
  const cell = row && row.querySelector('.gd-cell')
  return {
    label: row ? row.querySelector('.gd-gutter').textContent : '',
    title: cell ? cell.title.split('\\n')[0] : '',
    top: row ? Math.round(row.getBoundingClientRect().top - sr.top) : null,
    scrollTop: Math.round(sc.scrollTop),
    sel: (document.querySelector('.gd-cell.sel') || {}).title || '',
  }
})()`
const FIND = (needle) => `(() => {
  const sc = document.querySelector('.gd-scroll')
  const sr = sc.getBoundingClientRect()
  const rows = [...document.querySelectorAll('.gd-row')]
  const row = rows.find((r) => [...r.querySelectorAll('.gd-cell')].some((c) => c.title.split('\\n')[0] === ${JSON.stringify(needle)}))
  if (!row) return null
  return {
    top: Math.round(row.getBoundingClientRect().top - sr.top),
    label: row.querySelector('.gd-gutter').textContent,
    scrollTop: Math.round(sc.scrollTop),
    hasSel: !!row.querySelector('.gd-cell.sel'),
  }
})()`

const setCell = async (v) => {
  await ev(`(() => {
    const el = document.querySelector('.gd-toolbar input[type=range]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '${v}')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
  await wait(700)
}

// 1) 无选区：视口中间那一行保持不动
const before = await ev(SNAP)
console.log('BEFORE', JSON.stringify(before))
const midMeasure = Number((/小节 (\d+)/.exec(before.title) || [])[1])
await setCell(40)
const after = await ev(FIND(before.title))

console.log('AFTER40', JSON.stringify(after))
T('无选区：中间行仍是同一个小节的起始格', !!midMeasure, before.title)
T('无选区：缩放后锚点行屏幕位置不变（±2px）', after && Math.abs(after.top - before.top) <= 2, `${before.top} → ${after?.top}`)

// 2) 有选区：选区第一格所在行保持不动（先换成小格，让放大后有滚动余量）
await setCell(16)
await ev(`(() => { document.querySelector('.gd-scroll').scrollTop = 0; return 'ok' })()`)
await wait(600)
const pos = await ev(`(() => {
  const cell = [...document.querySelectorAll('.gd-cell')].find((c) => c.title.includes('小节 5 ') && c.title.includes('第 2 拍'))
  if (!cell) return null
  const b = cell.getBoundingClientRect()
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
})()`)
console.log('CLICK_AT', JSON.stringify(pos))
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
await wait(400)
const selInfo = await ev(`(() => {
  const sc = document.querySelector('.gd-scroll')
  const sr = sc.getBoundingClientRect()
  const cell = document.querySelector('.gd-cell.sel')
  if (!cell) return null
  const row = cell.closest('.gd-row')
  return { title: cell.title.split('\\n')[0], top: Math.round(row.getBoundingClientRect().top - sr.top), scrollTop: Math.round(sc.scrollTop) }
})()`)
console.log('SEL_BEFORE', JSON.stringify(selInfo))
T('点击后有一格被选中', !!selInfo, JSON.stringify(selInfo))

await setCell(40)
const selAfter = await ev(FIND(selInfo.title))
console.log('SEL_AFTER40', JSON.stringify(selAfter))
T('有选区：缩放后选中行屏幕位置不变（±2px）', selAfter && Math.abs(selAfter.top - selInfo.top) <= 2, `${selInfo.top} → ${selAfter?.top}`)
T('有选区：选中格子仍在（选区按时间保留）', !!selAfter && selAfter.hasSel, JSON.stringify(selAfter))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
await wait(500)
try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch {}
process.exit(0)
