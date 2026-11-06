/**
 * 格子查找替换：多选时只作用于选中的格子，未选/单选时仍是整份谱面。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9711
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
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
async function shotEl(sel, name, scale = 2, pad = 10) {
  const box = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.max(0, Math.floor(r.x) - ${pad}), y: Math.max(0, Math.floor(r.y) - ${pad}), width: Math.ceil(r.width) + ${pad * 2}, height: Math.ceil(r.height) + ${pad * 2} })
    })()`),
  )
  if (!box) return 'no-el'
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...box, scale } })
  if (sh?.result?.data) {
    fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
    return 'ok'
  }
  return 'fail'
}
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const body = () =>
    (text().split('[Hitsound]')[1] || '').split('\\n').filter((l) => l.trim() && !l.startsWith('#')).join(' | ')
  const open = () => !!document.querySelector('.gd-find-dlg')
  const inputs = () => [...document.querySelectorAll('.gd-find-input')]
  const setInput = (i, v) => {
    const el = inputs()[i]
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  const status = () => (document.querySelector('.gd-find-dlg .gd-vol-foot .hint') || {}).textContent || ''
  const scopeLine = () => (document.querySelector('.gd-find-scope') || {}).textContent || ''
  const hits = () => document.querySelectorAll('.gd-cell.find-hit').length
  const replace = () => {
    const b = [...document.querySelectorAll('.gd-find-dlg .btn')].find((x) => x.textContent.trim() === '全部替换')
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  const close = () => {
    const b = [...document.querySelectorAll('.gd-find-dlg .btn')].find((x) => x.textContent.trim() === '关闭')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  const state = () => JSON.stringify({ open: open(), status: status(), scope: scopeLine(), hits: hits() })
  const ctrlF = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))
    return 'ok'
  }
  const undo = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    return 'ok'
  }
  const cellRect = (i) => {
    const c = [...document.querySelectorAll('.gd-cell')][i]
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: (c.getAttribute('title') || '').split(' · ')[0] }
  }
  const selCount = () =>
    [...document.querySelectorAll('.gd-cell')].filter((c) => {
      const cl = ' ' + c.className + ' '
      return cl.includes(' sel ') || cl.includes(' insel ')
    }).length
  return { text, body, setInput, status, scopeLine, hits, replace, close, state, ctrlF, undo, cellRect, selCount }
})()`

const chart = [
  '[Metadata]',
  'Title = find scope',
  '',
  '[Files]',
  'path = ""',
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitclap Aa = default.soft-hitclap',
  'hitsound soft-hitwhistle Ab = default.soft-hitwhistle',
  'hitsound soft-hitfinish Cc = default.soft-hitfinish',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/Aa = [Aa Ab] = Aa = = = = = = = = = = =/',
  '#2000',
  '/Aa = Aa = = = = = = = = = = = = = =/',
  '',
].join('\n')

console.log(
  'LOAD',
  await ev(`(() => {
    const s = window.__store.getState()
    const id = s.addFile('findscope.hs', ${JSON.stringify(chart)})
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    return 'ok'
  })()`),
)
await wait(1500)
console.log('BEFORE', await ev(`${MOD}.body()`))

async function clickCell(i, mods = 0) {
  const p = JSON.parse(await ev(`JSON.stringify(${MOD}.cellRect(${i}))`))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, modifiers: mods })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, modifiers: mods })
  await wait(220)
}

// 1) 未多选：整份谱面（4 个 Aa）
await clickCell(0)
console.log('SEL1', await ev(`${MOD}.selCount()`))
await ev(`${MOD}.ctrlF()`)
await wait(350)
await ev(`${MOD}.setInput(0, 'Aa')`)
await wait(300)
console.log('WHOLE', await ev(`${MOD}.state()`))
T('单选/未多选 → 整份谱面（5 格）', (await ev(`${MOD}.hits()`)) === 5, `hits=${await ev(`${MOD}.hits()`)}`)
T('没有范围提示', (await ev(`${MOD}.scopeLine()`)) === '')
await ev(`${MOD}.close()`)
await wait(200)

// 2) Shift 连选 0..4 格（含 2 个 Aa）→ 只在这 5 格里找
await clickCell(0)
await clickCell(4, 8)
console.log('SEL5', await ev(`${MOD}.selCount()`))
T('选中 5 格', (await ev(`${MOD}.selCount()`)) === 5)
await ev(`${MOD}.ctrlF()`)
await wait(350)
await ev(`${MOD}.setInput(0, 'Aa')`)
await wait(300)
console.log('SCOPED', await ev(`${MOD}.state()`))
T('多选 → 只命中 3 格', (await ev(`${MOD}.hits()`)) === 3, `hits=${await ev(`${MOD}.hits()`)}`)
T('显示范围提示', (await ev(`${MOD}.scopeLine()`)).includes('5'), await ev(`${MOD}.scopeLine()`))
console.log('SHOT', await shotEl('.gd-find-dlg', 'ui-grid-find-scope.png', 2, 12))

// 3) 替换：只改选中的两格
await ev(`${MOD}.setInput(1, 'Cc')`)
await wait(200)
console.log('REPLACE', await ev(`${MOD}.replace()`))
await wait(700)
console.log('AFTER', await ev(`${MOD}.body()`))
{
  const b = await ev(`${MOD}.body()`)
  T(
    '只改选中的 3 格，后面和下一小节原样',
    b === '/Cc = [Cc Ab] = Cc = = = = = = = = = = =/ | /Aa = Aa = = = = = = = = = = = = = =/',
    b,
  )
}
await ev(`${MOD}.close()`)
await wait(200)

// 4) 撤销回到原样
await ev(`${MOD}.undo()`)
await wait(700)
console.log('UNDO', await ev(`${MOD}.body()`))
T('撤销回到原样', (await ev(`${MOD}.body()`)) === (await ev(`(() => ${JSON.stringify(chart)}.split('[Hitsound]')[1].split('\\n').filter((l) => l.trim() && !l.startsWith('#')).join(' | '))()`)))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
