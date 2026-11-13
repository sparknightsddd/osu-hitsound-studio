/**
 * 导出音效包：槽位错误的语言跟随界面（端到端）。
 *
 * 用临时 userData + settings.cfg 把界面切成 en-US，放一份「w/f/c 跨采样组」的谱面，
 * 点「Export sound package」后检查输出面板：
 *   - 汇总行是英文（sound-slot problem）；
 *   - 具体组合报错是英文（has no valid slot），带上组合名与时间；
 *   - 不再出现中文原文。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9481
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
fs.writeFileSync(
  path.join(USERDATA, 'settings.cfg'),
  ['# test settings', '[Language]', 'Lang = "en-US"', ''].join('\n'),
  'utf8',
)
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
const T = (n, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`)
}

await send('Runtime.enable')
await wait(3000)

// 界面语言应是英文
const langUi = await ev(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export sound package')`)
T('界面按 settings.cfg 切成 en-US', langUi === true)

const CHART = `[Metadata]
Title = slot i18n
Artist = tester
Creator = tester

[Files]
audio = ""

[Define]
hitsound soft-hitwhistle w = default.soft-hitwhistle
hitsound normal-hitfinish x = default.normal-hitfinish

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/[w x] = = = = = = = = = = = = = = =/
`
await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) s.closeFile(f.id)
  const id = s.addFile('slot.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.clearLog()
  return 'ok'
})()`)
await wait(600)

await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Export sound package')
  if (b) b.click()
  return !!b
})()`)
await wait(900)

const logs = JSON.parse(
  await ev(`JSON.stringify(window.__store.getState().output.slice(-12))`),
)
const text = logs.join('\n')
T('汇总行已翻译', /sound-slot problem/.test(text), logs[0] || '')
T('具体槽位错误已翻译', /has no valid slot/.test(text), logs.find((l) => l.includes('no valid slot')) || '')
T('报错里带组合名与时间', /Combo \[w x\]/.test(text) && /\d\d:\d\d:\d\d\d/.test(text), text.slice(0, 200))
T('不再出现中文槽位原文', !text.includes('没有合法的槽位') && !text.includes('个音效槽位问题'))
T('页面没有异常', errors.length === 0, errors.join(' | '))

ws.close()
child.kill()
try {
  fs.rmSync(USERDATA, { recursive: true, force: true })
} catch {}
console.log(`\nRESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
