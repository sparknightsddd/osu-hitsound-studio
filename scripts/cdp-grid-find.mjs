/**
 * 格子查找替换（Ctrl+F）：精确/包含匹配、仅替换匹配项 / 完全替换 / 留空删除。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9651
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

const child = spawn(
  ELECTRON,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USERDATA}`,
    '--remote-allow-origins=*',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
  ],
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
  const body = () => (text().split('[Hitsound]')[1] || '').split('\\n').filter((l) => l.trim()).join(' | ')
  const open = () => !!document.querySelector('.gd-find-dlg')
  const inputs = () => [...document.querySelectorAll('.gd-find-input')]
  const checks = () => [...document.querySelectorAll('.gd-find-opts input')]
  const setInput = (i, v) => {
    const el = inputs()[i]
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  const toggle = (i) => {
    const el = checks()[i]
    if (!el) return 'no-check'
    if (el.disabled) return 'disabled'
    el.click()
    return 'ok'
  }
  const status = () => (document.querySelector('.gd-find-dlg .gd-vol-foot .hint') || {}).textContent || ''
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
  const state = () => JSON.stringify({
    open: open(),
    find: inputs()[0] ? inputs()[0].value : '',
    repl: inputs()[1] ? inputs()[1].value : '',
    exact: checks()[0] ? checks()[0].checked : null,
    only: checks()[1] ? checks()[1].checked : null,
    onlyDisabled: checks()[1] ? checks()[1].disabled : null,
    status: status(),
    hits: hits(),
  })
  const ctrlF = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))
    return 'ok'
  }
  const undo = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    return 'ok'
  }
  return { text, body, open, setInput, toggle, status, hits, replace, close, state, ctrlF, undo }
})()`

console.log(
  'LOAD',
  await ev(`(() => {
    const cells = ['[Aa Ab]', '[Aa Ab Ac]', '[Aa Ac]', '[Ab]', 'Aa']
    while (cells.length < 16) cells.push('=')
    const lines = ['[Metadata]','Title = find','','[Files]','path = ""','audio = ""','',
      '[Define]',
      'hitsound soft-hitclap Aa = default.soft-hitclap',
      'hitsound soft-hitwhistle Ab = default.soft-hitwhistle',
      'hitsound soft-hitfinish Ac = default.soft-hitfinish',
      'hitsound soft-hitnormal Ad = default.soft-hitnormal',
      '',
      '[Timing]','0,bpm(120),4,0,0','',
      '[Hitsound]','#0','/' + cells.join(' ') + '/', '']
    const s = window.__store.getState()
    const id = s.addFile('find.hs', lines.join('\\n'))
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    return 'ok'
  })()`),
)
await wait(1400)
console.log('BEFORE', await ev(`JSON.stringify(${JSON.stringify('')})`), await ev(`${MOD}.body()`))

// 1) Ctrl+F 打开，输入两个代号
console.log('CTRL_F', await ev(`${MOD}.ctrlF()`))
await wait(400)
console.log('OPENED', await ev(`${MOD}.state()`))
console.log('FIND', await ev(`${MOD}.setInput(0, 'Aa Ab')`))
await wait(350)
console.log('CONTAINS', await ev(`${MOD}.state()`))
console.log(
  'HIT_TITLES',
  await ev(`JSON.stringify([...document.querySelectorAll('.gd-cell.find-hit')].map((c) => (c.getAttribute('title') || '').split('·')[1].trim()))`),
)
console.log('SHOT1', await shotEl('.gd-find-dlg', 'ui-grid-find.png', 2, 12))
console.log('SHOT_FULL', await shotEl('.gd-wrap', 'ui-grid-find-full.png', 1.5, 2))

// 2) 精确匹配
console.log('EXACT_ON', await ev(`${MOD}.toggle(0)`))
await wait(300)
console.log('EXACT_STATE', await ev(`${MOD}.state()`))

// 3) 精确替换：整格换成 Cd
console.log('REPL', await ev(`${MOD}.setInput(1, 'Cd')`))
await wait(250)
console.log('REPLACE_EXACT', await ev(`${MOD}.replace()`))
await wait(700)
console.log('AFTER_EXACT', await ev(`${MOD}.body()`))

// 4) 撤销 → 回到包含匹配 + 完全替换
console.log('CLOSE', await ev(`${MOD}.close()`))
await wait(250)
console.log('UNDO1', await ev(`${MOD}.undo()`))
await wait(600)
console.log('BACK1', await ev(`${MOD}.body()`))
console.log('REOPEN', await ev(`${MOD}.ctrlF()`))
await wait(350)
console.log('REMEMBER', await ev(`${MOD}.state()`))
console.log('EXACT_OFF', await ev(`${MOD}.toggle(0)`))
await wait(200)
console.log('ONLY_OFF', await ev(`${MOD}.toggle(1)`))
await wait(200)
console.log('FULL_MODE', await ev(`${MOD}.state()`))
console.log('REPLACE_FULL', await ev(`${MOD}.replace()`))
await wait(700)
console.log('AFTER_FULL', await ev(`${MOD}.body()`))

// 5) 撤销 → 仅替换匹配项，Aa → Bc
console.log('CLOSE2', await ev(`${MOD}.close()`))
await wait(200)
console.log('UNDO2', await ev(`${MOD}.undo()`))
await wait(600)
console.log('REOPEN2', await ev(`${MOD}.ctrlF()`))
await wait(350)
console.log('SET_FIND', await ev(`${MOD}.setInput(0, 'Aa')`))
console.log('SET_REPL', await ev(`${MOD}.setInput(1, 'Bc')`))
await wait(250)
console.log('ONLY_ON', await ev(`${MOD}.toggle(1)`))
await wait(250)
console.log('ONLY_MODE', await ev(`${MOD}.state()`))
console.log('REPLACE_ONLY', await ev(`${MOD}.replace()`))
await wait(700)
console.log('AFTER_ONLY', await ev(`${MOD}.body()`))

// 6) 留空 = 删除
console.log('CLOSE3', await ev(`${MOD}.close()`))
await wait(200)
console.log('UNDO3', await ev(`${MOD}.undo()`))
await wait(600)
console.log('REOPEN3', await ev(`${MOD}.ctrlF()`))
await wait(350)
console.log('EMPTY_REPL', await ev(`${MOD}.setInput(1, '')`))
await wait(300)
console.log('EMPTY_MODE', await ev(`${MOD}.state()`))
console.log('REPLACE_EMPTY', await ev(`${MOD}.replace()`))
await wait(700)
console.log('AFTER_EMPTY', await ev(`${MOD}.body()`))
console.log('CLOSE4', await ev(`${MOD}.close()`))
await wait(200)
console.log('HITS_AFTER_CLOSE', await ev(`${MOD}.hits()`))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
