/**
 * 「将所有音效复制到谱面文件夹内」端到端：
 *   - 音效复制成 <代号>.<原扩展名>，源文件保持原名、原位置；
 *   - [Define] 路径改写，[Files] path 删除；
 *   - .hs 移动到谱面文件夹；
 *   - 重开解析后 baseDir = .hs 所在目录，音效仍能定位；
 *   - 「打开谱面文件夹」在没有 path 时也用 .hs 所在目录。
 *
 * 原生确认框用 HSS_TEST_MESSAGEBOX 自动点第一个按钮；openPath 用 HSS_TEST_OPENPATH 跳过。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9743
const env = { ...process.env, NODE_ENV: 'production', HSS_TEST_MESSAGEBOX: '0', HSS_TEST_OPENPATH: '1' }
delete env.ELECTRON_RUN_AS_NODE

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hsbundle-'))
const PROJ = path.join(WORK, 'proj')
const TARGET = path.join(WORK, 'target')
const SRC = path.join(WORK, 'src')
for (const d of [PROJ, TARGET, SRC]) fs.mkdirSync(d, { recursive: true })

function writeWav(p, freq, seconds = 0.08, rate = 44100) {
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(p, Buffer.concat([h, data]))
}

const HIT = path.join(SRC, 'hitnormal.wav')
const CLAP = path.join(SRC, 'clap.ogg')
const SONG = path.join(TARGET, 'song.wav')
writeWav(HIT, 880)
writeWav(CLAP, 1320)
writeWav(SONG, 440, 2)

const fwd = (p) => p.replace(/\\/g, '/')
const TEXT = `[Metadata]
Title = bundle e2e
Artist = test
Creator = test
Version = test

[Files]
path = "${fwd(TARGET)}"
audio = "song.wav"

[Define]
hitsound soft-hitnormal Aa = "${fwd(HIT)}"
hitsound soft-hitclap Ab = "${fwd(CLAP)}"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa = Ab = = = =/`

const CHART = path.join(PROJ, 'pack.hs')
fs.writeFileSync(CHART, TEXT)

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

// 模拟「打开一份位于 proj/ 的 .hs」
await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('pack.hs', ${JSON.stringify(TEXT)})
  s.attachPath(id, ${JSON.stringify(CHART)}, ${JSON.stringify(TEXT)})
  s.setActive(id)
  s.clearLog()
  return 'ok'
})()`)
await wait(800)

const before = await ev(`(() => {
  const s = window.__store.getState()
  return { events: s.doc.events.length, path: s.files.find((x) => x.id === s.activeId)?.path, base: s.doc.baseDir }
})()`)
console.log('BEFORE', JSON.stringify(before))

await ev(`window.__bundleSounds()`)
await wait(800)

// ---- 磁盘结果 ----
const exists = (p) => fs.existsSync(p)
T('目标文件夹里有 Aa.wav', exists(path.join(TARGET, 'Aa.wav')))
T('目标文件夹里有 Ab.ogg', exists(path.join(TARGET, 'Ab.ogg')))
T('目标文件夹里有 song.wav（没被碰）', exists(SONG))
T('.hs 已移动到谱面文件夹', exists(path.join(TARGET, 'pack.hs')) && !exists(CHART))
T('源音效仍保持原名（未被重命名）', exists(HIT) && exists(CLAP), `${exists(HIT)} / ${exists(CLAP)}`)
T('源音效内容未改', Buffer.compare(fs.readFileSync(HIT), fs.readFileSync(path.join(TARGET, 'Aa.wav'))) === 0)
T('ogg 内容一致', Buffer.compare(fs.readFileSync(CLAP), fs.readFileSync(path.join(TARGET, 'Ab.ogg'))) === 0)
T('目录里没有多出多余文件', fs.readdirSync(TARGET).sort().join(',') === 'Aa.wav,Ab.ogg,pack.hs,song.wav', fs.readdirSync(TARGET).join(','))

const out = fs.readFileSync(path.join(TARGET, 'pack.hs'), 'utf8')
console.log('CHART', JSON.stringify(out))
T('[Files] path 行已删除', !/^\s*path\s*=/im.test(out), out)
T('Aa 定义改成 "Aa.wav"', /hitsound\s+soft-hitnormal\s+Aa\s*=\s*"Aa\.wav"/.test(out), out)
T('Ab 定义改成 "Ab.ogg"', /hitsound\s+soft-hitclap\s+Ab\s*=\s*"Ab\.ogg"/.test(out), out)
T('audio 行保留', /audio\s*=\s*"song\.wav"/.test(out))

// ---- 重解析：没 path 时以 .hs 目录为准 ----
const after = await ev(`(() => {
  const s = window.__store.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  const d = s.doc
  return {
    path: f?.path,
    settingsPath: d.settings.Path,
    baseDir: d.baseDir,
    audioPath: d.audioPath,
    defs: d.hitsounds.map((h) => ({ n: h.name, r: h.resolvedPath })),
    events: d.events.length,
  }
})()`)
console.log('AFTER', JSON.stringify(after))
const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase()
T('激活文件路径指向新位置', norm(after?.path) === norm(path.join(TARGET, 'pack.hs')), after?.path)
T('[Files] path 解析为空', after?.settingsPath === '', String(after?.settingsPath))
T('baseDir = 谱面文件夹', norm(after?.baseDir) === norm(TARGET), after?.baseDir)
T('音频仍按谱面文件夹解析', norm(after?.audioPath) === norm(SONG), after?.audioPath)
T('Aa 解析到 Aa.wav', norm(after?.defs?.find((d) => d.n === 'Aa')?.r) === norm(path.join(TARGET, 'Aa.wav')), JSON.stringify(after?.defs))
T('Ab 解析到 Ab.ogg', norm(after?.defs?.find((d) => d.n === 'Ab')?.r) === norm(path.join(TARGET, 'Ab.ogg')), JSON.stringify(after?.defs))
T('音效事件数量不变', after?.events === before?.events, `${before?.events} → ${after?.events}`)

// ---- 打开谱面文件夹（没有 path 时用 .hs 目录） ----
await ev(`window.__openChartDir()`)
await wait(400)
const logs = await ev(`window.__store.getState().output.slice(-4)`)
console.log('LOGS', JSON.stringify(logs))
T('打开谱面文件夹的日志指向目标目录', (logs || []).some((l) => l.includes('已打开谱面文件夹') && l.includes(TARGET)), JSON.stringify(logs))

// ---- 再来一次：幂等 ----
await ev(`window.__bundleSounds()`)
await wait(500)
const logs2 = await ev(`window.__store.getState().output.slice(-3)`)
console.log('LOGS2', JSON.stringify(logs2))
T('重复执行提示「已经收在」', (logs2 || []).some((l) => l.includes('已经收在')), JSON.stringify(logs2))
T('重复执行没有产生多余文件', fs.readdirSync(TARGET).length === 4, fs.readdirSync(TARGET).join(','))

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))

// 截图：文本模式下的 [Define] + 输出面板的打包日志
await ev(`(() => {
  const s = window.__store.getState()
  s.setEditorMode('text')
  s.setPanel('output')
  return 'ok'
})()`)
await wait(900)
await ev(`(() => {
  const el = [...document.querySelectorAll('*')].find((n) => n.className && String(n.className).includes('out-log'))
  if (el) el.scrollTop = el.scrollHeight
  const pre = document.querySelector('.panel pre, .output pre')
  if (pre) pre.scrollTop = pre.scrollHeight
  return 'ok'
})()`)
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (shot?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-bundle-sounds.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('SHOT ok')
}

child.kill()
await wait(500)
try { fs.rmSync(USERDATA, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(0)
