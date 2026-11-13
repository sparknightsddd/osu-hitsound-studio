/**
 * 有「无法表示的叠音组合」时：弹窗确认后跳过它们，其余音效照常写入。
 * 目标用绝对路径写进 [Files] ImportOsu；两次弹窗都选第一个按钮（仍然写入 / 另存为）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9497
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hswriteosu-'))
const TARGET = path.join(DIR, 'target.osu')
const NEW = path.join(DIR, 'Saved [HS].osu')
let mainLog = ''

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

const BODY = Array.from({ length: 16 }, (_, i) => (i === 0 ? '[w x]' : i === 8 ? 'C' : '=')).join(' ')
const CHART = `[Metadata]
Title = writer

[Files]
audio = ""
ImportOsu = "${TARGET.replace(/\\/g, '/')}"

[Define]
hitsound soft-hitclap C = default.soft-hitclap
hitsound soft-hitwhistle w = default.soft-hitwhistle
hitsound normal-hitfinish x = default.normal-hitfinish

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
  HSS_TEST_MESSAGEBOX: '0,0',
  HSS_TEST_SAVE_FILE: NEW,
}
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)

child.stdout.on('data', (d) => {
  mainLog += String(d)
})

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

T('另存为生成了新文件', fs.existsSync(NEW))
T('原文件没有被动过', fs.readFileSync(TARGET, 'utf8') === OSU)

const after = fs.readFileSync(NEW, 'utf8')
const lines = after.split(/\r?\n/)
const objs = lines.filter((l) => l.startsWith('256,192,'))
console.log('OBJS', JSON.stringify(objs))
T('合法组合照常写入第 2 个物件', objs[1]?.split(',')[4] === '8' && objs[1].endsWith('2:2:1:100:'), objs[1] || '')
T('被跳过的物件保持原样', objs[0] === '256,192,0,1,0,0:0:0:0:', objs[0] || '')

const logs = await ev(`JSON.stringify(window.__store.getState().output.slice(-10))`)
T('弹窗提示了无法写入的组合', mainLog.includes('仍然写入（跳过这些组合）'), (mainLog.match(/\[messagebox\].*/) || [''])[0].slice(0, 160))
T('日志里写明跳过了几个组合', String(logs).includes('跳过了 1 个无法表示的叠音组合'), String(logs).slice(-160))
T('没有运行时报错', errors.length === 0, errors.join(' | ').slice(0, 160))

console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
