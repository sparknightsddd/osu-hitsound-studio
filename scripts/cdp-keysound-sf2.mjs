/**
 * keysound 新语法 + SoundFont preset 的端到端：
 *  - 用真实 GM.sf2，写 `keysound ... = "piano.sf2" {bank=0,program=1}`
 *  - 自动载入后，日志应显示选中 preset "002"
 *  - 引擎里 60 号音高有样本，格子试听不报错
 *
 * 没有 D:/Downloads/GM.sf2 时跳过。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const SF2 = 'D:/Downloads/GM.sf2'
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
if (!fs.existsSync(SF2)) {
  console.log('SKIP 没有 D:/Downloads/GM.sf2')
  process.exit(0)
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hssf2-'))
fs.copyFileSync(SF2, path.join(DIR, 'piano.sf2'))
const PORT = 9424
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
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
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
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

const dir = DIR.replace(/\\/g, '/')
const CHART = `[Metadata]
Title = sf2 preset

[Files]
path = "${dir}"
audio = ""

[Define]
keysound custom piano = "piano.sf2"
{mode=singlefile,bank=0,preset=0,program=1,percussion=false}

[Timing]
0,bpm(120),4,0,0

[Keysound]
{piano}
/4C D E F G A B C/

[Hitsound]
/= = = =/
`
await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('sf2.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(5000)

const info = JSON.parse(await ev(`(() => {
  const s = window.__store.getState()
  const logs = s.output.slice(-80)
  const at = Math.max(0, logs.findLastIndex((l) => l.includes('切换到 sf2.hs')))
  const recent = logs.slice(at)
  return JSON.stringify({
    lib: recent.filter((l) => l.includes('乐器 piano')),
    errors: s.doc.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    has60: window.__engine.hasKeySample('piano', 60),
    has108: window.__engine.hasKeySample('piano', 108),
    buffers: window.__engine.boundSampleNames().filter((n) => n.startsWith('sf:')),
  })
})()`))
console.log('INFO', JSON.stringify(info))
T('谱面没有解析错误', info.errors.length === 0, info.errors.join(' | '))
T('选中了 program=1 的 preset "002"', info.lib.some((l) => l.includes('002')), info.lib.join(' | ').slice(0, 180))
T('60 号音高有真实样本', info.has60 === true)
T('108 号音高也有样本', info.has108 === true)
T('载入了 SF2 的 sample buffer', info.buffers.length > 0, String(info.buffers.length))

// 切到 piano 并点一格试听
await ev(`(() => { const sel = document.querySelector('.gd-inst-sel'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(sel,'0:piano'); sel.dispatchEvent(new Event('change',{bubbles:true})); return 1 })()`)
await wait(500)
const p = JSON.parse(await ev(`(() => { const c = document.querySelectorAll('.gd-cell')[4]; const r = c.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}) })()`))
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
await wait(900)
const after = JSON.parse(await ev(`(() => {
  const s = window.__store.getState()
  const all = s.output.slice(-40)
  const at = Math.max(0, all.findLastIndex((l) => l.includes('切换到 sf2.hs')))
  return JSON.stringify({
    logs: all.slice(at),
    cells: [...document.querySelectorAll('.gd-cell')].slice(0, 4).map((c) => c.querySelector('.gd-label')?.textContent || ''),
  })
})()`))
T('格子显示音符', after.cells.join('|').includes('C4') && after.cells.join('|').includes('D4'), after.cells.join('|'))
T('试听没有报错', !after.logs.some((l) => l.includes('✗')), after.logs.join(' | ').slice(0, 180))
T('页面没有异常', errors.length === 0, errors.join(' | '))

ws.close()
child.kill()
try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch {}
console.log(`\nRESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
