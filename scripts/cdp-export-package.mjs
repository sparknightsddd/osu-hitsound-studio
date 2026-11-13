/**
 * 端到端：点标题栏「导出音效包」→ 直接写进 [Files] path。
 * 用一个临时目录当谱面目录，避免污染真实 Songs。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
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
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsui-'))
const src = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)/soft-hitclap8.wav'
fs.copyFileSync(src, path.join(dir, 'src.wav'))

const chart = `[Metadata]
Title = UI Test
Artist = Tester
Creator = Me

[Files]
path = ${JSON.stringify(dir.replace(/\\/g, '/'))}
audio = ""

[Define]
hitsound soft-hitclap Aa = "src.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa/
`

console.log(
  'LOAD',
  await ev(`(() => {
    const s = window.__store.getState()
    const id = s.addFile('ui-export.hs', ${JSON.stringify(chart)})
    s.setActive(id)
    return 'ok'
  })()`),
)
await wait(900)

// 先打开「文件」菜单，再点「导出音效包」（标题栏没有常驻按钮）
console.log(
  'BTN',
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /导出音效包|Export sound package/.test(x.textContent))
    if (!b) return 'missing'
    b.click()
    return 'clicked'
  })()`),
)
await wait(2500)

const files = fs.readdirSync(dir).sort()
console.log('FILES', JSON.stringify(files))
const osu = files.find((f) => f.endsWith('.osu'))
console.log('OSUNAME', osu || '(none)')
if (osu) {
  const text = fs.readFileSync(path.join(dir, osu), 'utf8')
  console.log('VERSION', /Version:.*/.exec(text)?.[0])
  console.log('HIT', (text.split('[HitObjects]')[1] || '').trim().split(/\r?\n/)[0])
}
console.log('LOG', await ev(`JSON.stringify((window.__store.getState().output || []).slice(-4))`))
console.log('ERRORS', JSON.stringify(errors.slice(0, 3)))
child.kill()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
