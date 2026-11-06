/**
 * 把 .wav 拖进窗口 → 弹出和音效库「+」一样的「添加到 [Define]」窗口。
 *
 * 用 CDP 的 Input.dispatchDragEvent 合成一次带真实磁盘路径的拖放。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9721
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
/** 拖放用的临时目录（同时也是谱面的 [Files] path） */
const DROP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsdrop-'))

function writeWav(p, seconds = 0.2, rate = 8000) {
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(p, Buffer.concat([h, data]))
}
const WAV = path.join(DROP_DIR, 'kick.wav')
writeWav(WAV)
const TXT = path.join(DROP_DIR, 'readme.txt')
fs.writeFileSync(TXT, 'not a sound')

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
  const define = () => (text().split('[Define]')[1] || '').split('[Timing]')[0].split('\\n').filter((l) => l.trim()).join(' | ')
  const logs = (n = 3) => JSON.stringify(window.__store.getState().output.slice(-n))
  const dlg = () => !!document.querySelector('.as-dialog')
  const hint = () => !!document.querySelector('.drop-hint')
  const setName = (v) => {
    const el = document.querySelector('.as-dialog .si-code-input')
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  const ok = () => {
    const b = document.querySelector('.as-dialog .si-ok')
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  const nameValue = () => (document.querySelector('.as-dialog .si-code-input') || {}).value || ''
  return { text, define, logs, dlg, hint, setName, ok, nameValue }
})()`

const chart = [
  '[Metadata]',
  'Title = drop',
  '',
  '[Files]',
  `path = "${DROP_DIR.replace(/\\/g, '/')}"`,
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = default.soft-hitnormal',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/Aa = = =/',
  '',
].join('\n')

console.log(
  'LOAD',
  await ev(`(() => {
    const s = window.__store.getState()
    const id = s.addFile('drop.hs', ${JSON.stringify(chart)})
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    return 'ok'
  })()`),
)
await wait(1500)

const X = 620
const Y = 320
const dragData = { items: [], files: [WAV], dragOperationsMask: 1 }

// 1) 拖进来 → 显示提示，还没弹窗
await send('Input.dispatchDragEvent', { type: 'dragEnter', x: X, y: Y, data: dragData })
await wait(250)
console.log('HINT', await ev(`${MOD}.hint()`))
T('拖动中显示提示', (await ev(`${MOD}.hint()`)) === true)
T('松手前不弹窗', (await ev(`${MOD}.dlg()`)) === false)
console.log('SHOT_HINT', await shotEl('.drop-hint .drop-card', 'ui-filedrop-hint.png', 2, 12))

// 2) 松手 → 弹出「添加到 [Define]」
await send('Input.dispatchDragEvent', { type: 'dragOver', x: X, y: Y, data: dragData })
await send('Input.dispatchDragEvent', { type: 'drop', x: X, y: Y, data: dragData })
await wait(600)
console.log('DLG', await ev(`${MOD}.dlg()`))
T('松手后弹出添加音效窗口', (await ev(`${MOD}.dlg()`)) === true)
T('提示已消失', (await ev(`${MOD}.hint()`)) === false)
console.log('SHOT_DLG', await shotEl('.as-dialog', 'ui-filedrop-dialog.png', 2, 12))

// 3) 填代号 → 确定 → 写进 [Define]
console.log('SET_NAME', await ev(`${MOD}.setName('Kc')`))
await wait(250)
console.log('NAME', await ev(`${MOD}.nameValue()`))
console.log('OK', await ev(`${MOD}.ok()`))
await wait(900)
console.log('DEFINE', await ev(`${MOD}.define()`))
{
  const d = await ev(`${MOD}.define()`)
  T('写进 [Define]', /hitsound custom Kc = "kick\.wav"/.test(d), d)
  T('弹窗已关闭', (await ev(`${MOD}.dlg()`)) === false)
}
console.log('LOGS', await ev(`${MOD}.logs(3)`))

// 4) 拖一个非音频文件：不弹窗，只记一条日志
await send('Input.dispatchDragEvent', { type: 'dragEnter', x: X, y: Y, data: { items: [], files: [TXT], dragOperationsMask: 1 } })
await send('Input.dispatchDragEvent', { type: 'drop', x: X, y: Y, data: { items: [], files: [TXT], dragOperationsMask: 1 } })
await wait(500)
T('非音频不弹窗', (await ev(`${MOD}.dlg()`)) === false)
console.log('LOG_TXT', await ev(`${MOD}.logs(1)`))
T('日志说明只支持 wav/ogg', String(await ev(`${MOD}.logs(1)`)).includes('.wav'))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DROP_DIR, { recursive: true, force: true })
process.exit(0)
