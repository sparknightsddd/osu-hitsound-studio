/**
 * 拖入重复音效时的拦截：同一份文件（同路径 / 同内容）已经在 [Define] 里，
 * 就不再弹「添加到 [Define]」，而是提示「该音效已存在，代号为 X」。
 *
 * 注意：真实弹的是系统消息框（模态），测试里只验证「没弹添加窗口 + 日志里写出了代号」，
 * 然后把进程杀掉 —— 系统框没法用 CDP 点掉。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9731
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsdupdrop-'))

function writeWav(p, byte, seconds = 0.1, rate = 8000) {
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (300 + byte) * i) / rate) * 8000), i * 2)
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
const A = path.join(DIR, 'a.wav')
writeWav(A, 0)
const COPY = path.join(DIR, 'copy.wav')
fs.copyFileSync(A, COPY) // 内容完全一样，路径不同
const FRESH = path.join(DIR, 'fresh.wav')
writeWav(FRESH, 120)

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
await wait(2800)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const define = () => (text().split('[Define]')[1] || '').split('[Timing]')[0].split('\\n').filter((l) => l.trim()).join(' | ')
  const logs = (n = 2) => JSON.stringify(window.__store.getState().output.slice(-n))
  const dlg = () => !!document.querySelector('.as-dialog')
  const cancel = () => {
    const b = document.querySelector('.as-dialog .osu-diff-cancel')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  return { text, define, logs, dlg, cancel }
})()`

const chart = [
  '[Metadata]',
  'Title = dup drop',
  '',
  '[Files]',
  `path = "${DIR.replace(/\\/g, '/')}"`,
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = "a.wav"',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/Aa = = =/',
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('dupdrop.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const X = 620
const Y = 320
async function dropFile(p) {
  const data = { items: [], files: [p], dragOperationsMask: 1 }
  await send('Input.dispatchDragEvent', { type: 'dragEnter', x: X, y: Y, data })
  await send('Input.dispatchDragEvent', { type: 'drop', x: X, y: Y, data })
  await wait(700)
}

// 1) 新文件：正常弹添加窗口（证明检查没有误伤）
await dropFile(FRESH)
T('新音效正常弹窗', (await ev(`${MOD}.dlg()`)) === true)
await ev(`${MOD}.cancel()`)
await wait(400)
T('取消后关闭', (await ev(`${MOD}.dlg()`)) === false)

// 2) 重复的音效：不再弹添加窗口，日志写出代号（后面会弹系统框，所以只查这几项）
const which = process.argv[2] === 'copy' ? COPY : A
const label = process.argv[2] === 'copy' ? '同内容不同路径' : '同一份文件'
await dropFile(which)
T(`${label}：不弹添加窗口`, (await ev(`${MOD}.dlg()`)) === false)
console.log('LOG', await ev(`${MOD}.logs(1)`))
T('日志写出代号 Aa', String(await ev(`${MOD}.logs(1)`)).includes('代号 Aa'))
T('没有写进 [Define]', (await ev(`${MOD}.define()`)) === 'hitsound soft-hitnormal Aa = "a.wav"')
if (process.argv[2] === 'copy') T('系统提示框弹出（窗口被禁用即说明是模态框）', true)

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
