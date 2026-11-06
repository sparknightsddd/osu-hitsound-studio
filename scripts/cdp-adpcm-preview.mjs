/**
 * 真实 IMA ADPCM 立体声音效的绑定/试听（Chromium 的 decodeAudioData 不支持，走 wav.ts 兜底）。
 * 参考文件：E:/osu/Songs/Monster Siren Record-MSR - Innocence/soft-hitnormal.wav
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9742
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsadpcm-'))
const SRC = 'E:/osu/Songs/Monster Siren Record-MSR - Innocence/soft-hitnormal.wav'
const FILE = path.join(DIR, 'soft-hitnormal.wav')
fs.copyFileSync(SRC, FILE)

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
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
await send('Runtime.enable')
await wait(2800)

const info = await ev(`(async () => {
  const r = await window.desktop.readBinary(${JSON.stringify(FILE)})
  if (!r.ok) return { err: 'read failed' }
  const f = new File([r.data], 'soft-hitnormal.wav')
  try {
    await window.__engine.bindSample('T', f, false)
  } catch (e) {
    return { err: String(e) }
  }
  const i = window.__engine.sampleInfo('T')
  return { info: i, play: window.__engine.playSample('T', 80) }
})()`)
console.log('INFO', JSON.stringify(info))
T('IMA ADPCM 能绑定（没抛解码错误）', !!info?.info, JSON.stringify(info))
T('时长约 185ms', !!info?.info && Math.abs(info.info.duration - 0.1851) < 0.01, String(info?.info?.duration))
T('立体声 / 44.1kHz', info?.info?.channels === 2 && info?.info?.sampleRate === 44100, JSON.stringify(info?.info))
T('可以播放', info?.play === true, String(info?.play))
console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
await wait(500)
try { fs.rmSync(USERDATA, { recursive: true, force: true }); fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
process.exit(0)
