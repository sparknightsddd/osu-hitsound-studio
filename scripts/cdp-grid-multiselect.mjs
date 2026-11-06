/**
 * 格子模式的多选：Ctrl+点击加选/取消、Shift+点击连选，行为对齐资源管理器。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9581
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
async function shotEl(sel, name, scale = 3, pad = 6) {
  const box = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect()
      return JSON.stringify({ x: Math.floor(r.x) - ${pad}, y: Math.floor(r.y) - ${pad}, width: Math.ceil(r.width) + ${pad * 2}, height: Math.ceil(r.height) + ${pad * 2} })
    })()`),
  )
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
  const rows = () => [...document.querySelectorAll('.gd-row')]
  const cells = (r) => [...r.querySelectorAll('.gd-cell')]
  const findCell = (mi, beat = 1) => {
    for (const r of rows()) {
      for (const c of cells(r)) {
        const t = c.getAttribute('title') || ''
        if (t.includes('小节 ' + mi + ' · 第 ' + beat + ' 拍')) return c
      }
    }
    return null
  }
  const click = (mi, beat = 1, mods = {}) => {
    const c = findCell(mi, beat)
    if (!c) return 'no-cell'
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...mods }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return 'ok'
  }
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  /** 选中的格子（data-sel=1；光标格可能没选中） */
  const sel = () =>
    [...document.querySelectorAll('.gd-cell[data-sel="1"]')]
      .map((c) => (c.getAttribute('title') || '').split(' · ').slice(1, 3).join(' '))
      .slice(0, 6)
  const count = () => document.querySelectorAll('.gd-cell[data-sel="1"]').length
  const foot = () => document.querySelector('.gd-foot')?.textContent || ''
  return { text, rows, cells, findCell, click, key, sel, count, foot }
})()`

const LOAD = await ev(`(() => {
  const lines = ['[Metadata]','Title = multi','','[Files]','path = ""','audio = ""','',
    '[Define]','hitsound soft-hitclap Aa = default.soft-hitclap','hitsound soft-hitwhistle Ab = default.soft-hitwhistle','',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0','/= = = =/','']
  const s = window.__store.getState()
  const id = s.addFile('multi.hs', lines.join('\\n'))
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
console.log('LOAD', LOAD)
await wait(1200)

const state = async (label) =>
  console.log(label, await ev(`JSON.stringify({ n: ${MOD}.count(), sel: ${MOD}.sel(), foot: ${MOD}.foot().slice(0, 40) })`))

// 1) 单击 = 单选
console.log('C1', await ev(`${MOD}.click(2, 1)`))
await wait(150)
await state('AFTER_CLICK')

// 2) Ctrl+点击另一格 = 加选（不连续）
console.log('C2', await ev(`${MOD}.click(3, 2, { ctrlKey: true })`))
await wait(150)
await state('AFTER_CTRL_ADD')

// 3) 再 Ctrl+点击第三格
console.log('C3', await ev(`${MOD}.click(5, 1, { ctrlKey: true })`))
await wait(150)
await state('AFTER_CTRL_ADD2')
await shot('ui-grid-multiselect.png')
console.log('ZOOM', await shotEl('.gd-cell[data-sel="1"]', 'ui-grid-multiselect-zoom.png', 4, 10))

// 4) Ctrl+点击已选中的格子 = 取消
console.log('C4', await ev(`${MOD}.click(3, 2, { ctrlKey: true })`))
await wait(150)
await state('AFTER_CTRL_REMOVE')
console.log('CURCLASS', await ev(`document.querySelector('.gd-cell.cur')?.className || 'none'`))
console.log('ZOOM_CUR', await shotEl('.gd-cell.cur', 'ui-grid-multiselect-cursor.png', 4, 10))

// 5) Shift+点击 = 从锚点连选（替换掉零散选择）
console.log('C5', await ev(`${MOD}.click(7, 1, { shiftKey: true })`))
await wait(150)
await state('AFTER_SHIFT')

// 6) 普通点击 = 回到单选
console.log('C6', await ev(`${MOD}.click(2, 3)`))
await wait(150)
await state('AFTER_PLAIN')

// 7) 零散多选后敲代号：只落在选中的格子上
console.log('C7', await ev(`${MOD}.click(2, 1)`))
await wait(100)
console.log('C8', await ev(`${MOD}.click(4, 3, { ctrlKey: true })`))
await wait(100)
console.log('C9', await ev(`${MOD}.click(6, 2, { ctrlKey: true })`))
await wait(150)
await state('BEFORE_KEY')
console.log('KEY', await ev(`${MOD}.key('a')`))
await wait(80)
console.log('KEY2', await ev(`${MOD}.key('a')`))
await wait(500)
console.log(
  'AFTER_KEY',
  await ev(`JSON.stringify(window.__store.getState().doc.events.map((e) => [e.time, e.names.join('+')]))`),
)

// 8) Ctrl+点击后再拖动：不应改选区
console.log('C10', await ev(`${MOD}.click(2, 1, { ctrlKey: true })`))
await wait(200)
await state('AFTER_CTRL_IN_DRAG')

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
