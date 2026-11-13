/**
 * 音效设置里改代号后，新的样本名要能自动加载。
 *
 * 复现路径：Aa = "fx.wav" 先自动绑定 → 在「音效设置」里把代号改成 Bb
 * → 正文同步成 /Bb .../ → 新代号 Bb 也必须从同一个文件重新解码绑定。
 *
 * 以前的自动加载缓存只按文件路径去重：路径没变、代号变了，就被当成
 * 「已经处理过」直接跳过，表现是改名后音效不加载。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9503
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsrename-'))

function writeWav(p, freq, seconds = 0.3, rate = 8000) {
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2)
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
writeWav(path.join(DIR, 'fx.wav'), 660)

const dirFwd = DIR.replace(/\\/g, '/')
const CHART = `[Metadata]
Title = rename load

[Files]
path = "${dirFwd}"
audio = ""

[Define]
hitsound custom Aa = "fx.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa = = =/
`

const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: USERDATA }
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
  throw new Error('CDP 未就绪')
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
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(expr, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true
    await wait(150)
  }
  return false
}
let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

await send('Runtime.enable')
await send('Page.enable')
await wait(3200)

await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('rename.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setEditorMode('grid')
  return 'ok'
})()`)

const bound = () => ev(`JSON.stringify(window.__engine.boundSampleNames())`)
T('改名之前 Aa 自动绑定', await waitFor(`window.__engine.boundSampleNames().includes('Aa')`), String(await bound()))

// 打开「音效设置」：格子视图左上角的下拉选 @define
await ev(`(() => {
  const sel = document.querySelector('.gd-inst-sel')
  if (!sel) return 'no-select'
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, '@define')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await wait(400)
T('音效设置弹窗打开', !!(await ev(`!!document.querySelector('.gd-def-dlg')`)))

// 把代号 Aa 改成 Bb
const nameVal = await ev(`(() => {
  const input = document.querySelector('.gd-def-name .si-code-input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Bb')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input.value
})()`)
await wait(250)
T('代号输入框接受 Bb', nameVal === 'Bb', String(nameVal))

const applied = await ev(`(() => {
  const b = document.querySelector('.gd-vol-foot .btn.accent')
  if (!b) return 'no-btn'
  if (b.disabled) return 'disabled'
  b.click()
  return 'clicked'
})()`)
await wait(500)
T('点应用成功', applied === 'clicked', String(applied))

const text = String(await ev(`(() => {
  const s = window.__store.getState()
  return s.files.find((f) => f.id === s.activeId)?.content || ''
})()`))
T('正文同步成 Bb', text.includes('/Bb = = =/') && !text.includes('/Aa = = =/'), (text.split('\n').find((l) => l.startsWith('/')) || ''))

T('改名后 Bb 重新绑定', await waitFor(`window.__engine.boundSampleNames().includes('Bb')`), String(await bound()))
const info = JSON.parse(
  String(await ev(`JSON.stringify(window.__engine.sampleInfo('Bb') || null)`)),
)
T('Bb 样本能解码（时长 > 0）', !!info && info.duration > 0, JSON.stringify(info))
T('没有运行时报错', errors.length === 0, errors.join(' | ').slice(0, 160))

console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
await wait(500)
try {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.rmSync(DIR, { recursive: true, force: true })
} catch {}
process.exit(fail ? 1 : 0)
