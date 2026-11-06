/**
 * 重启后已加载的自定义音效还在不在。
 *
 * 场景：谱面目录里有 inside.wav（能按文件自动配对），另外 [Define] 里还有一条
 * 指向目录外面的 outside.wav（只能靠 IndexedDB 里的持久化副本恢复）。
 * 重新加载页面 = 重启程序，检查两个都还在。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9631
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const SRC = path.join(ROOT, 'public', 'osudefaulthitsound', 'default.drum-hitclap.wav')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hspersist-'))
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'hsoutside-'))
fs.copyFileSync(SRC, path.join(DIR, 'inside.wav'))
fs.copyFileSync(SRC, path.join(OUT, 'outside.wav'))
const DIR_POSIX = DIR.replace(/\\/g, '/')
const OUT_POSIX = OUT.replace(/\\/g, '/')
/** 用独立的 userData，别把测试音效写进真实用户目录 */
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
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const STATE = `(async () => {
  const s = window.__store.getState()
  const eng = window.__engine
  const names = ['Aa', 'Bb']
  return JSON.stringify({
    active: (s.files.find((f) => f.id === s.activeId) || {}).name || '',
    bindings: Object.keys(s.bindings || {}),
    has: names.map((n) => n + ':' + (eng.hasSample(n) ? 'y' : 'n')),
    info: names.map((n) => {
      const i = eng.sampleInfo(n)
      return n + ':' + (i ? Math.round(i.duration * 1000) + 'ms' : '-')
    }),
    output: (s.output || []).slice(-4).map((l) => String(l).slice(0, 90)),
  })
})()`

console.log('ENV', await ev(`JSON.stringify({ href: location.href, origin: location.origin, idb: typeof indexedDB })`))
console.log(
  'IDB_TEST',
  await ev(`new Promise((r) => {
    const q = indexedDB.open('probe', 1)
    q.onsuccess = () => r('ok')
    q.onerror = () => r('err:' + (q.error && q.error.name) + ':' + (q.error && q.error.message))
    q.onblocked = () => r('blocked')
    setTimeout(() => r('timeout'), 2000)
  })`),
)

console.log(
  'SETUP',
  await ev(`(async () => {
    const chart = [
      '[Metadata]',
      'Title = persist',
      '',
      '[Files]',
      'path = "${DIR_POSIX}"',
      'audio = ""',
      '',
      '[Define]',
      'hitsound soft-hitclap Aa = "inside.wav"',
      'hitsound custom Bb = "${OUT_POSIX}/outside.wav"',
      '',
      '[Timing]',
      '0,bpm(120),4,0,0',
      '',
      '[Hitsound]',
      '#0',
      '/Aa Bb = = = = = = = = = = = = = = =/',
      '',
    ].join('\\n')
    const s = window.__store.getState()
    const id = s.addFile('persist.hs', chart)
    s.setActive(id)
    return 'ok'
  })()`),
)
await wait(1600)
console.log('AUTOLOAD', await ev(STATE))

// 手动绑目录外的那个（模拟用音效库 + 加进来的）
console.log(
  'BIND_OUTSIDE',
  await ev(`(async () => {
    const bin = await window.desktop.readBinary('${OUT_POSIX}/outside.wav')
    const file = new File([bin.data], 'outside.wav')
    await window.__engine.bindSample('Bb', file)
    const s = window.__store.getState()
    s.setBindings({ ...s.bindings, Bb: { name: 'Bb', fileName: 'outside.wav', size: file.size, auto: true } })
    return 'ok'
  })()`),
)
await wait(600)
console.log('BEFORE', await ev(STATE))

// 重新加载页面 = 重开程序
await send('Page.reload', { ignoreCache: false })
await wait(1600)
await send('Runtime.enable')
await wait(3000)
console.log('AFTER', await ev(STATE))

console.log(
  'SAMPLES_ON_DISK',
  JSON.stringify(fs.existsSync(path.join(USERDATA, 'samples')) ? fs.readdirSync(path.join(USERDATA, 'samples')) : null),
)
console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(DIR, { recursive: true, force: true })
fs.rmSync(OUT, { recursive: true, force: true })
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
