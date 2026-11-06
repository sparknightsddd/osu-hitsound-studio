/**
 * 导出音效包：检测到需要混音时，先弹确认框并列出重复槽位的 mm:ss:ms。
 *
 * 系统消息框是原生模态，CDP 点不掉，所以这里验证：
 *   1) 点「导出音效包」后日志里出现混音清单（带 mm:ss:ms）；
 *   2) 目录里还没有写出任何 .osu（提示在写盘之前）。
 * 然后杀掉进程。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9751
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsmix-'))

function writeWav(p, freq = 440, seconds = 0.08, rate = 8000) {
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2)
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
writeWav(path.join(DIR, 'z.wav'), 440)
writeWav(path.join(DIR, 'l.wav'), 660)

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

const chart = `[Metadata]
Title = Mix Prompt
Artist = Tester
Creator = Me

[Files]
path = "${DIR.replace(/\\/g, '/')}"
audio = ""

[Define]
hitsound soft-hitclap Z = "z.wav"
hitsound soft-hitclap L = "l.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/[Z L] = = =/
#2000
/Z = = =/
#4000
/[Z L] = = =/
`

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('mix.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  return 'ok'
})()`)
await wait(900)

async function shotEl(sel, name, scale = 2, pad = 8) {
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

// 打开底部面板，方便截到混音清单
await ev(`(() => {
  const st = window.__store.getState()
  if (!st.panelOpen) st.togglePanel()
  st.setPanel('output')
  return 'ok'
})()`)
await wait(400)

console.log(
  'BTN',
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('导出音效包'))
    if (!b) return 'missing'
    b.click()
    return 'clicked'
  })()`),
)
await wait(1500)

const logs = String(await ev(`JSON.stringify(window.__store.getState().output.slice(-8))`))
console.log('LOGS', logs)
T('日志提示需要混音', logs.includes('个槽位需要混音'), '')
T('日志里有 00:00:000', logs.includes('00:00:000'), '')
T('日志里有 00:04:000', logs.includes('00:04:000'), '')
T('日志里没有 00:02:000（那一格没叠音）', !logs.includes('00:02:000'), '')

console.log('DOM', await ev(`JSON.stringify([...document.querySelectorAll('.panel, .output, .bottom-panel, .bp')].map((e) => e.className))`))
console.log('SHOT', await shotEl('.panel', 'ui-export-mix-log.png', 2, 8))

const files = fs.readdirSync(DIR).sort()
console.log('FILES', JSON.stringify(files))
T('还没写出 .osu（提示在写盘之前）', !files.some((f) => f.endsWith('.osu')), files.join(','))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
