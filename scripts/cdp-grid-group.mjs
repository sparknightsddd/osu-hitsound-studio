/**
 * 格子视图：同一小节里 1/4 混 1/6。
 * - 细分=4 时正常落 1/4 的音
 * - 切到细分=6 再落一个 1/6 的音 → 正文改成「一拍一个括号，括号内取最小公倍数」
 * - 回读：两个音都还在（1/6 的没被量化掉）
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9573
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
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
async function shotEl(sel, name, scale = 3, pad = 10) {
  const box = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.max(0, Math.floor(r.x) - ${pad}), y: Math.max(0, Math.floor(r.y) - ${pad}), width: Math.ceil(r.width) + ${pad * 2}, height: Math.ceil(r.height) + ${pad * 2}, scale: ${scale} })
    })()`),
  )
  if (!box) return 'no-el'
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
  const body = () => (text().split('[Hitsound]')[1] || '').trim().split('\\n').filter((l) => l.startsWith('/')).join(' | ')
  /** 按标题里的时间找格子（标题形如 00:00:125 · 小节 1 · 第 1 拍 +1/4） */
  const cellAt = (clock) => {
    for (const c of document.querySelectorAll('.gd-cell')) {
      if ((c.getAttribute('title') || '').startsWith(clock)) return c
    }
    return null
  }
  const rect = (clock) => {
    const c = cellAt(clock)
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }
  const pick = (clock) => {
    const c = cellAt(clock)
    if (!c) return 'no-cell'
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return 'ok'
  }
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  const events = () => JSON.stringify(window.__store.getState().doc.events.map((e) => [Math.round(e.time), e.names.join('+')]))
  const logs = (n) => JSON.stringify(window.__store.getState().output.slice(-n))
  return { text, body, cellAt, rect, pick, key, events, logs }
})()`

const LOAD = await ev(`(() => {
  const lines = ['[Metadata]','Title = group','','[Files]','path = ""','audio = ""','',
    '[Define]',
    'hitsound soft-hitclap A = default.soft-hitclap',
    'hitsound soft-hitwhistle B = default.soft-hitwhistle',
    '',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0','/= = = = = = = = = = = = = = = =/','']
  const s = window.__store.getState()
  const id = s.addFile('group.hs', lines.join('\\n'))
  s.setActive(id)
  s.setEditorMode('grid')
  s.setDiv(4)
  return 'ok'
})()`)
console.log('LOAD', LOAD)
await wait(1200)

// 1) 细分=4：在第 1 拍的 1/4 处（125ms）敲 A
console.log('PICK_125', await ev(`${MOD}.pick('00:00:125')`))
await wait(250)
await ev(`${MOD}.key('a')`)
await wait(600)
console.log('BODY_1', await ev(`${MOD}.body()`))
T('细分=4：1/4 的音落在 125ms', (await ev(`${MOD}.events()`)) === '[[125,"A"]]', await ev(`${MOD}.events()`))
T('细分=4：正文是一格一个 token', (await ev(`${MOD}.body()`)) === '/= A = = = = = = = = = = = = = =/', await ev(`${MOD}.body()`))

// 2) 切到细分=6：网格里出现了 1/6 的格（83ms）
await ev(`window.__store.getState().setDiv(6)`)
await wait(600)
const r83 = JSON.parse(await ev(`JSON.stringify(${MOD}.rect('00:00:083'))`))
console.log('RECT_83', JSON.stringify(r83))
T('细分=6 时有 1/6 的格子', !!r83, JSON.stringify(r83))

// 3) 在 1/6 处敲 B —— 以前这一步会直接被拒
console.log('PICK_83', await ev(`${MOD}.pick('00:00:083')`))
await wait(250)
await ev(`${MOD}.key('b')`)
await wait(700)
const body2 = await ev(`${MOD}.body()`)
console.log('BODY_2', body2)
console.log('EVENTS_2', await ev(`${MOD}.events()`))
console.log('LOG_2', await ev(`${MOD}.logs(2)`))
T('1/6 的音能落进去', String(await ev(`${MOD}.events()`)).includes('83'), await ev(`${MOD}.events()`))
T('原来 1/4 的音还在（没被量化）', String(await ev(`${MOD}.events()`)).includes('[125,"A"]'), await ev(`${MOD}.events()`))
T('正文改成一拍一个括号', body2.startsWith('/(= = B A'), body2)
T('空拍不加括号', /(^|\s)=\s=\s=$/.test(body2.replace(/\/|\(|\)/g, ' ').trim().replace(/\s+/g, ' ')) || body2.endsWith(') = = =/'), body2)

// 4) 再切回细分=4：还能继续改（不会报错）
await ev(`window.__store.getState().setDiv(4)`)
await wait(600)
console.log('PICK_1000', await ev(`${MOD}.pick('00:01:000')`))
await wait(250)
await ev(`${MOD}.key('a')`)
await wait(700)
const body3 = await ev(`${MOD}.body()`)
console.log('BODY_3', body3, await ev(`${MOD}.events()`))
T('切回细分=4 还能继续落笔', String(await ev(`${MOD}.events()`)).includes('[1000,"A"]'), await ev(`${MOD}.events()`))
T('改完 1/6 的音依然在', String(await ev(`${MOD}.events()`)).includes('83'), await ev(`${MOD}.events()`))

console.log('SHOT', await shotEl('.gd-wrap', 'ui-grid-group.png', 2, 6))
console.log('ERRORS', JSON.stringify(errors.slice(0, 3)))
child.kill()
process.exit(0)
