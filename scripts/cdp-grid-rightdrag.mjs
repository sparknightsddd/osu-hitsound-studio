/**
 * 格子视图：右键拖动矩形框选 + 竖排复制粘贴保持形状。
 *
 * 验证点：
 *  1. 右键拖过多个格子 → 矩形选区（选中的是同一列的三行，不是中间整段）；
 *  2. 松手后不弹右键菜单；再按一次右键（不拖）才弹；
 *  3. 复制竖排 → 日志显示 3×1 矩形；
 *  4. 粘贴到另一列 → 三格纵向排开（相隔两小节），不是横排（相隔 1/4 拍）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9734
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
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

// 12 小节 4/4：足够排出多行；每行小节数取决于窗口宽度，测试里按实际 DOM 找格子
// 第 1/3/5 小节第 1 拍各放一个音效（一行两小节时正好是第一列的三行）
const measures = Array.from({ length: 12 }, (_, i) => {
  const name = i === 0 ? 'Aa' : i === 2 ? 'Ab' : i === 4 ? 'Aa' : ''
  return `/${name} = = = = = = = = = = = = = = =/`
})
const CHART = [
  '[Metadata]',
  'Title = right drag',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = "a.wav"',
  'hitsound soft-hitnormal Ab = "b.wav"',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  ...measures,
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('rightdrag.hs', ${JSON.stringify(CHART)})
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
  const selected = () => [...document.querySelectorAll('.gd-cell.sel, .gd-cell.insel')].map((e) => e.title)
  const menu = () => !!document.querySelector('.edit-menu')
  const logs = (n = 3) => window.__store.getState().output.slice(-n)
  const events = () => window.__store.getState().doc.events.map((e) => [Math.round(e.time), e.names.join('+')])
  return { rows: rows.map((r) => r.length), at, selected, menu, logs, events }
})()`

const info = await ev(`${INFO}`)
console.log('ROWS', JSON.stringify(info.rows))
T('至少 4 行格子', info.rows.length >= 4, JSON.stringify(info.rows))

async function rightDrag(from, to, steps = 3) {
  const a = await ev(`${INFO}.at(${from[0]}, ${from[1]})`)
  const b = await ev(`${INFO}.at(${to[0]}, ${to[1]})`)
  if (!a || !b) throw new Error('找不到格子')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'right', buttons: 2, clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(a.x + ((b.x - a.x) * i) / steps)
    const y = Math.round(a.y + ((b.y - a.y) * i) / steps)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 2 })
    await wait(40)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'right', buttons: 0, clickCount: 1 })
  await wait(350)
}
async function rightClick(row, col) {
  const a = await ev(`${INFO}.at(${row}, ${col})`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'right', buttons: 2, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'right', buttons: 0, clickCount: 1 })
  await wait(350)
}
async function leftClick(row, col) {
  const a = await ev(`${INFO}.at(${row}, ${col})`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(250)
}
async function key(k, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: k, code, windowsVirtualKeyCode: vk })
  await wait(400)
}

// 1) 右键从 (0,0) 拖到 (2,0)：应是同一列的 3 格，不是区间里的整段
await rightDrag([0, 0], [2, 0])
const sel1 = JSON.parse(await ev(`JSON.stringify(${INFO}.selected())`))
console.log('SEL1', JSON.stringify(sel1))
T('矩形选区只选中 3 格', sel1.length === 3, `实际 ${sel1.length}`)
T('松手后没有弹右键菜单', (await ev(`${INFO}.menu()`)) === false)
// 三格的「第 N 拍」应一样（同一列），「小节」不同
const beats = sel1.map((t) => (/第 (\d+) 拍/.exec(t) || [])[1])
const ms = sel1.map((t) => (/小节 (\d+)/.exec(t) || [])[1])
T('三格在同一列（拍号一致）', new Set(beats).size === 1, JSON.stringify(beats))
T('三格在不同小节', new Set(ms).size === 3, JSON.stringify(ms))

// 2) 复制 → 日志里的形状应该是 3×1
await key('c', 'KeyC', 67)
const log2 = await ev(`JSON.stringify(${INFO}.logs(1))`)
console.log('COPY_LOG', log2)
T('复制日志写明 3×1 矩形', String(log2).includes('3×1'), log2)

// 3) 点另一个单元格再粘贴：竖排应保持竖排（相隔两小节 = 4000ms），不是横排（125ms）
await leftClick(0, 1)
await key('v', 'KeyV', 86)
await wait(600)
const evs = JSON.parse(await ev(`JSON.stringify(${INFO}.events())`))
console.log('EVENTS', JSON.stringify(evs))
const times = evs.map((e) => e[0]).sort((a, b) => a - b)
T('粘贴后共 6 个事件（原来 3 + 新 3）', times.length === 6, JSON.stringify(times))
const fresh = evs.filter((e) => ![0, 4000, 8000].includes(e[0])).sort((a, b) => a[0] - b[0])
console.log('FRESH', JSON.stringify(fresh))
T('新事件正好 3 个', fresh.length === 3, JSON.stringify(fresh))
if (fresh.length === 3) {
  const d1 = fresh[1][0] - fresh[0][0]
  const d2 = fresh[2][0] - fresh[1][0]
  T('纵向相隔两小节（~4000ms）', Math.abs(d1 - 4000) < 60 && Math.abs(d2 - 4000) < 60, `${d1} / ${d2}`)
  T('不是横排的 1/4 拍间隔', d1 > 1000 && d2 > 1000, `${d1} / ${d2}`)
  T('三格内容按竖排顺序粘贴', fresh.map((e) => e[1]).join(',') === 'Aa,Ab,Aa', JSON.stringify(fresh))
}
console.log('PASTE_LOG', await ev(`JSON.stringify(${INFO}.logs(2))`))

// 4) 再按一次右键（不拖）应弹菜单
await rightClick(1, 1)
T('框选后再右键（不拖）弹菜单', (await ev(`${INFO}.menu()`)) === true)
// 关掉菜单：点空白处
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', buttons: 0, clickCount: 1 })
await wait(250)

// 5) 普通右键（没拖过）也应弹菜单
await rightClick(2, 2)
T('普通右键弹菜单', (await ev(`${INFO}.menu()`)) === true)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await wait(200)

// 6) 2×3 矩形框选：6 格（不是中间整段）
await rightDrag([1, 2], [2, 4])
const sel3 = JSON.parse(await ev(`JSON.stringify(${INFO}.selected())`))
console.log('SEL3', JSON.stringify(sel3))
T('2×3 矩形选中 6 格', sel3.length === 6, `实际 ${sel3.length}`)
T('矩形框选后仍不弹菜单', (await ev(`${INFO}.menu()`)) === false)

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
// 截图：2×3 矩形选区（高亮格子）
const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (sh?.result?.data) {
  const out = path.join(ROOT, 'ui-grid-rect-select.png')
  fs.writeFileSync(out, Buffer.from(sh.result.data, 'base64'))
  console.log('SHOT', out)
}
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
