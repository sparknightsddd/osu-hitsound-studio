/**
 * 文本驱动的音频自动加载：文本里出现 [Files] path/audio 或 [Define] 音效路径后，
 * 不点任何按钮，音频应立即从磁盘载入。
 *
 * 验证：歌曲载入（engine.hasSong / songName / durationMs）、
 * hitsound 与单一 keysound 样本绑定（boundSampleNames / bindings）、
 * 路径写错时日志提示一次、改对后自动补载。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9732
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsautoload-'))

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
const SONG = path.join(DIR, 'song.wav')
writeWav(SONG, 440, 2.5)
const FX = path.join(DIR, 'fx.wav')
writeWav(FX, 660)
const KS = path.join(DIR, 'ks.wav')
writeWav(KS, 880)
const SONG2 = path.join(DIR, 'song2.wav')
writeWav(SONG2, 330, 2.0)

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
  const st = () => window.__store.getState()
  const active = () => {
    const s = st()
    return s.files.find((f) => f.id === s.activeId)
  }
  // 模拟编辑器输入：整份替换文本（会触发 updateContent -> reparse -> 自动加载）
  const setText = (text) => st().updateContent(active().id, text)
  const audio = () => {
    const e = window.__engine
    return { has: e.hasSong, name: e.songName, dur: Math.round(e.durationMs) }
  }
  const bound = () => JSON.stringify(window.__engine.boundSampleNames())
  const binds = () => JSON.stringify(st().bindings)
  const logs = (n = 3) => JSON.stringify(st().output.slice(-n))
  return { setText, audio, bound, binds, logs }
})()`

// 起始谱面：没有 [Files]，也没有任何路径
const chart0 = [
  '[Metadata]',
  'Title = autoload text',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = ""',
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
  const id = s.addFile('autoload.hs', ${JSON.stringify(chart0)})
  s.setActive(id)
  return 'ok'
})()`)
await wait(800)
T('初始无歌曲', (await ev(`${MOD}.audio()`)).has === false)

// 1) 在文本里写下 [Files] path + audio → 歌曲应自动载入
const dirFwd = DIR.replace(/\\/g, '/')
await ev(`${MOD}.setText(${JSON.stringify(
  chart0.replace('[Metadata]', `[Files]\npath = "${dirFwd}"\naudio = "song.wav"\n\n[Metadata]`),
)})`)
await wait(1800)
const a1 = await ev(`${MOD}.audio()`)
T('写完 [Files] audio 后歌曲自动载入', a1.has === true, JSON.stringify(a1))
T('歌曲名正确', a1.name === 'song.wav')
T('时长 > 2 秒', a1.dur > 2000, `dur=${a1.dur}ms`)
console.log('LOG', await ev(`${MOD}.logs(1)`))

// 2) 给音效补上路径 → 立即绑定
await ev(`${MOD}.setText(${JSON.stringify(
  chart0.replace('[Metadata]', `[Files]\npath = "${dirFwd}"\naudio = "song.wav"\n\n[Metadata]`).replace('Aa = ""', 'Aa = "fx.wav"'),
)})`)
await wait(1500)
T('hitsound Aa 自动绑定', String(await ev(`${MOD}.bound()`)).includes('Aa'))
console.log('BIND', await ev(`${MOD}.binds()`))

// 3) 单一 keysound 也走路径自动绑定
await ev(`${MOD}.setText(${JSON.stringify(
  chart0
    .replace('[Metadata]', `[Files]\npath = "${dirFwd}"\naudio = "song.wav"\n\n[Metadata]`)
    .replace('Aa = ""', 'Aa = "fx.wav"')
    .replace('[Timing]', 'keysound custom piano = "ks.wav"\n\n[Timing]'),
)})`)
await wait(1500)
console.log('DEFS3', await ev(`JSON.stringify(window.__store.getState().doc.hitsounds.map(h => [h.kind, h.name, h.value, h.resolvedPath || '']))`))
const bound3 = String(await ev(`${MOD}.bound()`))
T('keysound piano 自动绑定', /ks:piano/i.test(bound3), bound3)

// 4) 路径写错 → 日志提示一次；改成另一首 → 换曲重载
await ev(`${MOD}.setText(${JSON.stringify(
  chart0.replace('[Metadata]', `[Files]\npath = "${dirFwd}"\naudio = "missing.wav"\n\n[Metadata]`),
)})`)
await wait(1500)
const logs4 = String(await ev(`${MOD}.logs(2)`))
T('读不到的路径有日志提示', logs4.includes('读不到'), logs4.slice(-120))
await ev(`${MOD}.setText(${JSON.stringify(
  chart0.replace('[Metadata]', `[Files]\npath = "${dirFwd}"\naudio = "song2.wav"\n\n[Metadata]`),
)})`)
await wait(1800)
const a4 = await ev(`${MOD}.audio()`)
T('改成 song2.wav 后换曲重载', a4.has === true && a4.name === 'song2.wav', JSON.stringify(a4))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
