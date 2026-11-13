/**
 * 直接把音效写进目标 .osu（覆盖模式，自动备份 .bak）。
 * 目标用绝对路径写进 [Files] ImportOsu，点「覆盖原文件」按钮（HSS_TEST_MESSAGEBOX=1）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9495
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hswriteosu-'))
const TARGET = path.join(DIR, 'target.osu')

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Write Target
Artist:Someone
Creator:Me
Version:Hard

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,80,1,0

[HitObjects]
256,192,0,1,0,0:0:0:0:
256,192,1000,1,0,0:0:0:0:
`
fs.writeFileSync(TARGET, OSU, 'utf8')

const BODY = Array.from({ length: 16 }, (_, i) => (i === 0 || i === 8 ? 'C' : '=')).join(' ')
const CHART = `[Metadata]
Title = writer

[Files]
audio = ""
ImportOsu = "${TARGET.replace(/\\/g, '/')}"

[Define]
hitsound soft-hitclap C = default.soft-hitclap

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/${BODY}/
`

const env = {
  ...process.env,
  NODE_ENV: 'production',
  HSS_USER_DATA: USERDATA,
  HSS_TEST_MESSAGEBOX: '1',
}
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
    errors.push((d.params.args || []).map((a) => a.value || a.description || '').join(' '))
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

await send('Runtime.enable')
await send('Page.enable')
await wait(3200)

await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('writer.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  return 'ok'
})()`)
await wait(1200)

const ok = await ev(`window.__writeOsuHitsounds()`)
T('动作返回成功', ok === true, String(ok))
await wait(1200)

const after = fs.readFileSync(TARGET, 'utf8')
const lines = after.split(/\r?\n/)
const objs = lines.filter((l) => l.startsWith('256,192,'))
console.log('OBJS', JSON.stringify(objs))
T('两个圆圈都写上 clap 位', objs.length === 2 && objs.every((l) => l.split(',')[4] === '8'), objs.join(' | '))
T('两个圆圈都带 soft:soft:1:100', objs.every((l) => l.endsWith('2:2:1:100:')), objs.join(' | '))
T('红线被改成编号 1 / 音量 100', /\n0,500,4,2,1,100,1,0/.test(after), lines.find((l) => l.startsWith('0,500')) || '')
T('Version 保持 Hard', /^Version:Hard$/m.test(after), lines.find((l) => l.startsWith('Version:')) || '')

const bak = TARGET + '.bak'
T('覆盖前生成了 .bak', fs.existsSync(bak))
T('.bak 是原始内容', fs.existsSync(bak) && fs.readFileSync(bak, 'utf8') === OSU)

const logs = await ev(`JSON.stringify(window.__store.getState().output.slice(-8))`)
T('日志里有“已写入音效”', String(logs).includes('已写入音效'), String(logs).slice(-120))
T('没有运行时报错', errors.length === 0, errors.join(' | ').slice(0, 160))

console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
