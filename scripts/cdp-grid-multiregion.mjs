/**
 * 格子编辑器：多选区（Ctrl+拖动，左键 / 右键都要能加）。
 *
 * 验证：
 *  1. 左键拖出第一个选区；
 *  2. Ctrl+左键再拖一个，第一个仍在；
 *  3. Ctrl+右键框一个矩形，前两个仍在，且松手不弹菜单；
 *  4. Ctrl+点击取消/加选单格；
 *  5. 复制数量 = 所有选区格子之和；
 *  6. 普通点击清空全部附加选区；
 *  7. 改格大小后多选区仍然保持（端点用 mi:k 存）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9744
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

const measures = Array.from({ length: 12 }, (_, i) =>
  i === 0 ? '/Aa = = = = = = = = = = = = = = =/' : '/= = = = = = = = = = = = = = = =/',
)
const CHART = [
  '[Metadata]',
  'Title = multi region',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = "a.wav"',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  ...measures,
  '',
].join('\n')

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

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('multiregion.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  s.setEditorMode('grid')
  return 'ok'
})()`)
await wait(1200)

const INFO = `(() => {
  const rows = [...document.querySelectorAll('.gd-row')].map((r) => [...r.querySelectorAll('.gd-cell')])
  const at = (ri, ci) => {
    const el = rows[ri] && rows[ri][ci]
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), title: el.title }
  }
  const selected = () => [...document.querySelectorAll('.gd-cell.sel, .gd-cell.insel')].map((e) => e.title.split('\\n')[0])
  const menu = () => !!document.querySelector('.edit-menu')
  const logs = (n = 2) => window.__store.getState().output.slice(-n)
  return { rows: rows.map((r) => r.length), at, selected, menu, logs }
})()`

const rows = await ev(`${INFO}.rows`)
console.log('ROWS', JSON.stringify(rows))
T('至少有 4 行格子', rows.length >= 4, JSON.stringify(rows))

async function drag(from, to, { button = 'left', ctrl = false, steps = 4 } = {}) {
  const a = await ev(`${INFO}.at(${from[0]}, ${from[1]})`)
  const b = await ev(`${INFO}.at(${to[0]}, ${to[1]})`)
  if (!a || !b) throw new Error('找不到格子')
  const modifiers = ctrl ? 2 : 0
  const buttons = button === 'right' ? 2 : 1
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button, buttons, clickCount: 1, modifiers })
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(a.x + ((b.x - a.x) * i) / steps)
    const y = Math.round(a.y + ((b.y - a.y) * i) / steps)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons, modifiers })
    await wait(35)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button, buttons: 0, clickCount: 1, modifiers })
  await wait(350)
}

async function click(row, col, { button = 'left', ctrl = false } = {}) {
  const a = await ev(`${INFO}.at(${row}, ${col})`)
  const modifiers = ctrl ? 2 : 0
  const buttons = button === 'right' ? 2 : 1
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button, buttons, clickCount: 1, modifiers })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button, buttons: 0, clickCount: 1, modifiers })
  await wait(300)
}

const sel = async () => JSON.parse(await ev(`JSON.stringify(${INFO}.selected())`))

// 1) 左键拖出 3 格
await drag([0, 0], [0, 2])
const s1 = await sel()
console.log('SEL1', JSON.stringify(s1))
T('左键拖选 3 格', s1.length === 3, `实际 ${s1.length}`)

// 2) Ctrl+左键再拖 2 格
await drag([1, 0], [1, 1], { ctrl: true })
const s2 = await sel()
console.log('SEL2', JSON.stringify(s2))
T('Ctrl+左键拖动再加一个选区（3+2=5）', s2.length === 5, `实际 ${s2.length}：${JSON.stringify(s2)}`)
T('第一个选区仍在', s1.every((t) => s2.includes(t)), JSON.stringify(s2))

// 3) Ctrl+右键框 2 格
await drag([2, 0], [2, 1], { button: 'right', ctrl: true })
const s3 = await sel()
console.log('SEL3', JSON.stringify(s3))
T('Ctrl+右键拖动再加矩形（5+2=7）', s3.length === 7, `实际 ${s3.length}：${JSON.stringify(s3)}`)
T('前两个选区仍在', s2.every((t) => s3.includes(t)), JSON.stringify(s3))
T('右键框选松手不弹菜单', (await ev(`${INFO}.menu()`)) === false)

// 4) Ctrl+点击取消一格 / 加一格
const dropTitle = (await ev(`${INFO}.at(1, 1)`))?.title?.split('\n')[0] || ''
await click(1, 1, { ctrl: true })
const s4 = await sel()
console.log('SEL4', JSON.stringify(s4))
T('Ctrl+点击取消一格（7-1=6）', s4.length === 6, `实际 ${s4.length}`)
T('取消的正是那一格', !!dropTitle && !s4.includes(dropTitle), `${dropTitle} / ${JSON.stringify(s4)}`)

await click(3, 0, { ctrl: true })
const s5 = await sel()
console.log('SEL5', JSON.stringify(s5))
T('Ctrl+点击加一格（6+1=7）', s5.length === 7, `实际 ${s5.length}`)

// 5) 复制：数量应是所有选区之和
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 })
await wait(400)
const logs = await ev(`JSON.stringify(${INFO}.logs(1))`)
console.log('COPY', logs)
T('复制的是 7 格', String(logs).includes('复制了 7 格'), logs)

// 6) 改格大小后附加选区保持
const beforeResize = await sel()
await ev(`(() => {
  const el = document.querySelector('.gd-toolbar input[type=range]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '32')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`)
await wait(900)
const afterResize = await sel()
console.log('RESIZE', JSON.stringify({ before: beforeResize.length, after: afterResize.length }))
T('改格大小后选区数量不变（7）', afterResize.length === 7, `${beforeResize.length} → ${afterResize.length}`)
T('改格大小后选中的还是同一批音', afterResize.slice().sort().join('|') === beforeResize.slice().sort().join('|'), JSON.stringify(afterResize))

// 7) 普通点击清空附加选区
await click(2, 3)
const s6 = await sel()
console.log('SEL6', JSON.stringify(s6))
T('普通点击只剩 1 格', s6.length === 1, `实际 ${s6.length}`)

// 截图：先重新造两块选区
await drag([0, 0], [0, 2])
await drag([1, 0], [1, 1], { ctrl: true })
await drag([2, 0], [2, 2], { button: 'right', ctrl: true })
await wait(300)
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (shot?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-multi-region.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('SHOT ok')
}
const box = JSON.parse(
  await ev(`(() => {
    const row = document.querySelector('.gd-row')
    const r = row.getBoundingClientRect()
    return JSON.stringify({ x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 6), width: 340, height: 130, scale: 4 })
  })()`),
)
const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: box })
if (z?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-multi-region-zoom.png'), Buffer.from(z.result.data, 'base64'))
  console.log('ZOOM ok')
}

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
await wait(500)
try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch {}
process.exit(0)
