/**
 * 从 .osu 导入音效时，自动把 ImportOsu = "<相对 path 的文件名>" 写进 [Files]。
 *
 * 验证：
 *  1. 导入后生成的 .hs 的 [Files] 里有 ImportOsu，值是相对 [Files] path 的路径；
 *  2. 解析出的 doc.importOsuPath 指向磁盘上的 .osu；
 *  3. 网格模式直接出现物件轨道（说明 ImportOsu 被真正用起来了）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9736
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsimportfill-'))

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Autofill Test
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,1,2,0:0:0:60:hitnormal.wav
256,192,500,2,0,B|300:192,1,100,0|0,0:0|0:0,0:0:0:0:
256,192,1500,8,2,3000,0:0:0:60:
256,192,2500,1,0,0:0:0:0:
`
// 让 extractOsuSounds 能挑出一个真实音效代码（否则走「无音效」骨架分支，测不到设置框）
function writeWav(p, freq, seconds = 0.1, rate = 44100) {
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
writeWav(path.join(DIR, 'hitnormal.wav'), 880)
const FILE = path.join(DIR, 'song.osu')
fs.writeFileSync(FILE, OSU)

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
await send('Page.enable')
await wait(2800)

// 直接调导入命令（原生文件对话框没法用 CDP 操作）
await ev(`(() => { window.__importDone = 'pending'; window.__importOsuFile(${JSON.stringify(FILE)}).then((v) => { window.__importDone = String(v) }); return 'started' })()`)
let hasDlg = false
for (let i = 0; i < 20; i++) {
  await wait(150)
  hasDlg = await ev(`!!document.querySelector('.si-dialog')`)
  if (hasDlg) break
}
console.log('DONE_BEFORE_CLICK', await ev(`window.__importDone`))
console.log('DIALOG', hasDlg)
if (hasDlg) {
  await ev(`document.querySelector('.si-dialog .si-ok')?.click()`)
  await wait(1200)
}

const OUT = `(() => {
  const s = window.__store.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  return { name: f?.name, path: s.doc.settings.Path, importOsu: s.doc.settings.ImportOsu, resolved: s.doc.importOsuPath, text: (f?.content || '').split('[Settings]')[0] }
})()`
const out = await ev(OUT)
console.log('OUT', JSON.stringify({ ...out, text: undefined }))
console.log('LOGS', JSON.stringify((await ev(`window.__store.getState().output.slice(-8)`))))
console.log('FILES_BLOCK', JSON.stringify(out.text))
T('导入后激活的是新文件', String(out.name).endsWith('.hs'), out.name)
T('[Files] 里写了 ImportOsu', /(^|\n)\s*ImportOsu\s*=\s*"song\.osu"/i.test(out.text), out.text)
T('ImportOsu 是相对路径（没有盘符/目录）', out.importOsu === 'song.osu', out.importOsu)
T('ImportOsu 解析成绝对路径', /song\.osu$/i.test(out.resolved) && out.resolved.includes('hsimportfill-'), out.resolved)

// 用起来：网格模式下方应出现物件轨道
await ev(`(() => { const s = window.__store.getState(); s.setEditorMode('grid'); s.setDiv(4); return 'ok' })()`)
await wait(1200)
const lanes = await ev(`document.querySelectorAll('.gd-objlane').length`)
const objs = await ev(`(() => {
  const one = document.querySelector('.gd-objlane')
  return one ? { c: one.querySelectorAll('.gd-obj.circle').length, s: one.querySelectorAll('.gd-obj.slider').length, p: one.querySelectorAll('.gd-obj.spinner').length } : null
})()`)
console.log('LANE', lanes, JSON.stringify(objs))
T('网格里出现 ImportOsu 物件轨道', lanes >= 1)
T('circle/slider/spinner 都画出来', objs && objs.c >= 1 && objs.s === 1 && objs.p === 1, JSON.stringify(objs))

// 转盘（1500–3000ms）的 whistle 必须落在转盘尾 3000ms，而不是开头 1500ms
const evs = await ev(`(() => {
  const d = window.__store.getState().doc
  return d.events.map((e) => ({ t: e.time, n: e.names.join('+'), v: e.volume }))
})()`)
console.log('EVENTS', JSON.stringify(evs))
T('转盘音效落在转盘尾（3000ms）', (evs || []).some((e) => e.t === 3000), JSON.stringify(evs))
T('转盘头（1500ms）没有多出的音效', !(evs || []).some((e) => e.t === 1500), JSON.stringify(evs))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
