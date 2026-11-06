/**
 * 格子模式顶部音效画笔：拖动调整顺序，并同步写回 [Define]。
 *
 * 覆盖：
 *   - 拖动中的插入竖线（截图，松手落在工具条外，不改顺序）
 *   - 拖动 Aa 到 Ac 后面 → 画笔顺序变化 + [Define] 行顺序变化（注释跟着自己那行走）
 *   - 无名定义 / @乐句 原地不动
 *   - Ae 拖到最前；Ctrl+Z 撤销
 *   - 拖动结束后单击画笔不再误判成「刚拖过」而吞掉落笔
 *   - 拖到工具条外松手 = 取消
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9661
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
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)

await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const define = () =>
    (text().split('[Define]')[1] || '').split('[Timing]')[0].split('\\n').filter((l) => l.trim()).join(' | ')
  const brushes = () => [...document.querySelectorAll('.gd-brush')]
  const order = () => brushes().map((b) => b.textContent.trim()).join(' ')
  const rects = () =>
    brushes().map((b) => {
      const r = b.getBoundingClientRect()
      return { name: b.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right }
    })
  const classes = () => brushes().map((b) => b.className).join(' | ')
  const body = () =>
    (text().split('[Hitsound]')[1] || '').split('\\n').filter((l) => l.trim() && !l.startsWith('#')).join(' | ')
  const cellRect = () => {
    const c = document.querySelector('.gd-cell')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  return { text, define, order, rects, classes, body, cellRect }
})()`

const chart = [
  '[Metadata]',
  'Title = brush order',
  '',
  '[Files]',
  'path = ""',
  'audio = ""',
  '',
  '[Define]',
  '## 音效定义',
  'hitsound soft-hitnormal Aa = default.soft-hitnormal  ## 底鼓',
  'hitsound custom = "blank.wav"',
  'hitsound soft-hitclap Ab = default.soft-hitclap',
  'hitsound soft-hitfinish Ac = default.soft-hitfinish',
  'hitsound soft-hitwhistle Ae = default.soft-hitwhistle',
  '',
  '## 乐句',
  '@Fill = /Aa (Ab)/',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/Aa/',
  '',
].join('\n')

console.log(
  'LOAD',
  await ev(`(() => {
    const s = window.__store.getState()
    const id = s.addFile('brush-order.hs', ${JSON.stringify(chart)})
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    return 'ok'
  })()`),
)
await wait(1400)

console.log('INIT_ORDER', await ev(`${MOD}.order()`))
console.log('INIT_DEFINE', await ev(`${MOD}.define()`))

const rects = JSON.parse(await ev(`JSON.stringify(${MOD}.rects())`))
const byName = Object.fromEntries(rects.map((r) => [r.name, r]))
console.log('RECTS', JSON.stringify(rects))

async function press(p) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: p.x,
    y: p.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
}
async function moveTo(a, b, steps = 8) {
  for (let i = 1; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps
    const y = a.y + ((b.y - a.y) * i) / steps
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await wait(30)
  }
}
async function release(p) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: p.x,
    y: p.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  await wait(250)
}

// 0) 摆拍：拖到一半截图，然后松手到工具条外（取消），不影响后面的断言
const fromAa = byName['Aa']
const toAfterAc = { x: byName['Ac'].x + 12, y: byName['Ac'].y }
await press(fromAa)
await moveTo(fromAa, toAfterAc)
await wait(120)
console.log('DRAG_CLASSES', await ev(`${MOD}.classes()`))
console.log('SHOT_DRAG', await shotEl('.gd-brushes', 'ui-grid-brush-drag.png', 3, 14))
await release({ x: toAfterAc.x, y: toAfterAc.y + 260 })
await wait(700)
console.log('ORDER_AFTER_SCREENSHOT_DRAG', await ev(`${MOD}.order()`))

// 1) Aa → Ac 后面
await press(fromAa)
await moveTo(fromAa, toAfterAc)
await release(toAfterAc)
await wait(700)
console.log('ORDER_1', await ev(`${MOD}.order()`))
console.log('DEFINE_1', await ev(`${MOD}.define()`))
T('拖动后画笔顺序 = Ab Ac Aa Ae', (await ev(`${MOD}.order()`)) === 'Ab Ac Aa Ae')
{
  const d = await ev(`${MOD}.define()`)
  T('Aa 行（含注释）挪到 Ac 后面', d.indexOf('Ac') < d.indexOf('Aa') && /Aa = default\.soft-hitnormal\s+## 底鼓/.test(d))
  T('无名定义留在原来那一行', d.split(' | ')[2].startsWith('hitsound custom ='))
  T('@乐句没被搬动', d.endsWith('@Fill = /Aa (Ab)/'))
}

// 2) Ae → 最前
const rects2 = JSON.parse(await ev(`JSON.stringify(${MOD}.rects())`))
const by2 = Object.fromEntries(rects2.map((r) => [r.name, r]))
const fromAe = by2['Ae']
const toFront = { x: by2['Ab'].x - 12, y: by2['Ab'].y }
await press(fromAe)
await moveTo(fromAe, toFront)
await release(toFront)
await wait(700)
console.log('ORDER_2', await ev(`${MOD}.order()`))
console.log('DEFINE_2', await ev(`${MOD}.define()`))
T('Ae 拖到最前', (await ev(`${MOD}.order()`)) === 'Ae Ab Ac Aa')

// 3) Ctrl+Z 撤销
await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); return 'ok' })()`)
await wait(700)
console.log('ORDER_UNDO', await ev(`${MOD}.order()`))
T('撤销回到上一步顺序', (await ev(`${MOD}.order()`)) === 'Ab Ac Aa Ae')

// 4) 拖动之后单击画笔仍然能落笔（Aa 格子里再加一个 Ab）
const cell = JSON.parse(await ev(`JSON.stringify(${MOD}.cellRect())`))
await press(cell)
await release(cell)
await wait(300)
const rects3 = JSON.parse(await ev(`JSON.stringify(${MOD}.rects())`))
const by3 = Object.fromEntries(rects3.map((r) => [r.name, r]))
await press(by3['Ab'])
await release(by3['Ab'])
await wait(600)
console.log('BODY_AFTER_CLICK', await ev(`${MOD}.body()`))
T('拖动之后单击画笔仍落笔', (await ev(`${MOD}.body()`)).includes('[Aa Ab]'))

// 5) 拖到工具条外 = 取消
const before = await ev(`${MOD}.order()`)
const bodyBefore = await ev(`${MOD}.body()`)
const fromAb = by3['Ab']
await press(fromAb)
await moveTo(fromAb, { x: fromAb.x, y: fromAb.y + 260 })
await release({ x: fromAb.x, y: fromAb.y + 260 })
await wait(600)
console.log('ORDER_AFTER_CANCEL', await ev(`${MOD}.order()`))
T('拖出工具条松手不改变顺序', (await ev(`${MOD}.order()`)) === before)
T('取消后没有多余的落笔', (await ev(`${MOD}.body()`)) === bodyBefore)

console.log('FULL_SHOT', await shotEl('.gd-wrap', 'ui-grid-brush-order.png', 1.5, 2))
console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
