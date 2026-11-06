/**
 * 格子视图：键盘敲代号落笔。
 * - 单字母代号 A：敲 a 立刻落笔
 * - 多字母代号 Bb/Bc：敲 b（显示候选）→ 敲 c → 落在 Bc
 * - 多选：拖选两格后敲 a，两格一起加
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9551
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
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ])
    if (sh?.result?.data) {
      fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
      return
    }
    await wait(500)
  }
  console.log('SHOT_FAILED', name)
}
async function shotEl(sel, name, scale = 3) {
  const box = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect()
      return JSON.stringify({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height), scale: ${scale} })
    })()`),
  )
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: box })
  if (sh?.result?.data) {
    fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
    return 'ok'
  }
  return 'fail'
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
  const clickCell = (mi, beat = 1, shift = false) => {
    const c = findCell(mi, beat)
    if (!c) return 'no-cell'
    mouse(c, 'mousedown', shift ? { shiftKey: true } : {})
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return 'ok'
  }
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  const foot = () => document.querySelector('.gd-foot')?.textContent || ''
  const typed = () => document.querySelector('.gd-typed')?.textContent || ''
  const cellNames = (mi, beat = 1) => {
    const c = findCell(mi, beat)
    return c ? c.getAttribute('data-names') || c.className : ''
  }
  return { text, rows, cells, findCell, clickCell, key, foot, typed, cellNames }
})()`

const LOAD = await ev(`(() => {
  const lines = ['[Metadata]','Title = keytype','','[Files]','path = ""','audio = ""','',
    '[Define]',
    'hitsound soft-hitclap A = default.soft-hitclap',
    'hitsound soft-hitwhistle Bb = default.soft-hitwhistle',
    'hitsound soft-hitfinish Bc = default.soft-hitfinish',
    '',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0','/= = = =/','']
  const s = window.__store.getState()
  const id = s.addFile('keytype.hs', lines.join('\\n'))
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
console.log('LOAD', LOAD)
await wait(1200)

const namesAt = (mi, beat) =>
  ev(`JSON.stringify(window.__store.getState().doc.events.filter((e) => e.measure === ${mi} && e.time === ${(mi - 1) * 2000 + (beat - 1) * 500}).map((e) => [e.time, e.names.join('+')]))`)

// 1) 没选格子 → 敲字母不接管
console.log('KEY_NOSEL', await ev(`${MOD}.key('a')`))
await wait(200)
console.log('AFTER_NOSEL', await ev(`${MOD}.text().includes('[Hitsound]\\n#0\\n/= = = =/')`))

// 2) 选中第 3 小节第 2 格，敲 a（单字母代号 A 应立即落笔）
console.log('PICK1', await ev(`${MOD}.clickCell(3, 2)`))
await wait(250)
console.log('KEY_A', await ev(`${MOD}.key('a')`))
await wait(500)
console.log('AFTER_A', await namesAt(3, 2), await ev(`${MOD}.text().split('[Hitsound]')[1].split('\\n').slice(1, 4).join(' | ')`))

// 3) 第 5 小节第 1 格：敲 b（多候选）→ 再敲 c → 落在 Bc
console.log('PICK2', await ev(`${MOD}.clickCell(5, 1)`))
await wait(250)
console.log('KEY_B', await ev(`${MOD}.key('b')`))
await wait(150)
console.log('TYPED', await ev(`${MOD}.typed()`), '|', await ev(`${MOD}.foot()`))
await shot('ui-grid-keytype-prefix.png')
console.log('FOOTSHOT', await shotEl('.gd-foot', 'ui-grid-keytype-foot.png', 3))
console.log('KEY_C', await ev(`${MOD}.key('c')`))
await wait(500)
console.log('AFTER_BC', await namesAt(5, 1))

// 4) 多选：第 7 小节 1-3 拍拖选，敲 a
console.log('PICK3', await ev(`${MOD}.clickCell(7, 1)`))
await wait(150)
console.log('PICK4', await ev(`${MOD}.clickCell(7, 3, true)`))
await wait(200)
console.log('KEY_A2', await ev(`${MOD}.key('a')`))
await wait(600)
console.log(
  'AFTER_MULTI',
  await ev(`JSON.stringify(window.__store.getState().doc.events.filter((e) => e.time >= 11000 && e.time <= 13000).map((e) => [e.time, e.names.join('+')]))`),
)

// 5) 再敲一次 a：全有的应该一起移除
console.log('KEY_A3', await ev(`${MOD}.key('a')`))
await wait(600)
console.log(
  'AFTER_TOGGLE_OFF',
  await ev(`JSON.stringify(window.__store.getState().doc.events.filter((e) => e.time >= 11000 && e.time <= 13000).map((e) => [e.time, e.names.join('+')]))`),
)

// 6) 输入框里敲字母不能落笔
console.log(
  'KEY_IN_INPUT',
  await ev(`(() => {
    const i = document.querySelector('.gd-wrap input[type=range]') || document.querySelector('.tl-toolbar input')
    if (!i) return 'no-input'
    i.focus()
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    return 'ok'
  })()`),
)
await wait(400)
console.log(
  'AFTER_INPUT',
  await ev(`JSON.stringify(window.__store.getState().doc.events.filter((e) => e.time >= 11000 && e.time <= 13000).map((e) => [e.time, e.names.join('+')]))`),
)
// 7) 有多个候选时只敲到一半就等：不能乱落笔
console.log('PICK5', await ev(`${MOD}.clickCell(9, 1)`))
await wait(200)
console.log('KEY_B_ONLY', await ev(`${MOD}.key('b')`))
await wait(1100)
console.log(
  'AFTER_AMBIGUOUS',
  await ev(`JSON.stringify({
    typed: document.querySelector('.gd-typed')?.textContent || '',
    evs: window.__store.getState().doc.events.filter((e) => e.time >= 16000 && e.time <= 17000).map((e) => [e.time, e.names.join('+')]),
  })`),
)

await shot('ui-grid-keytype.png')
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
