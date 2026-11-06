/**
 * keysound 的真实音频链路：从 GM.sf2 导出钢琴 wav → [Files] path → 自动载入 → 试听。
 *
 * 没有 GM.sf2 或 python 时直接跳过（打印 SKIP），不影响其它测试。
 */
const { spawn, spawnSync } = await import('node:child_process')
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

const SAMPLES = fs.mkdtempSync(path.join(os.tmpdir(), 'hssamples-'))
const gen = spawnSync('python', [path.join(ROOT, 'scripts', 'sf2-to-wav.py'), SF2, SAMPLES, 'C4', 'B5', 'piano'], {
  encoding: 'utf8',
})
if (gen.status !== 0) {
  console.log('SKIP 生成 wav 失败', gen.stderr || gen.stdout)
  process.exit(0)
}
const wavs = fs.readdirSync(path.join(SAMPLES, 'piano'))
console.log('SAMPLES', wavs.length, wavs.slice(0, 4).join(','))

const PORT = 9423
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
const send = (method, params = {}) => { const msg = { id: ++id, method, params }; ws.send(JSON.stringify(msg)); return new Promise((res) => pending.set(msg.id, res)) }
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`) }

await send('Runtime.enable')
await wait(3000)

const dir = SAMPLES.replace(/\\/g, '/')
const CHART = `[Metadata]
Title = ks audio

[Files]
path = "${dir}"
audio = ""

[Define]
keysound custom piano = ("piano/<loop("C","H","D","I","E","F","J","G","K","A","L","B")><int(4)>.wav", C4, B4)

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
  const id = s.addFile('ksaudio.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(4000)

const info = JSON.parse(await ev(`(() => {
  const s = window.__store.getState()
  const logs = s.output.slice(-60)
  // 只看切到本谱之后的日志：工作区里别的谱可能留着旧的载入失败
  const at = Math.max(0, logs.findLastIndex((l) => l.includes('切换到 ksaudio.hs')))
  const recent = logs.slice(at)
  return JSON.stringify({
    loaded: recent.filter((l) => l.includes('自动载入') && l.includes('piano(')).map((l) => l.slice(0, 160)),
    failed: recent.filter((l) => l.includes('✗') && l.includes('piano')),
    errors: s.doc.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
  })
})()`))
console.log('INFO', JSON.stringify(info))
T('从 GM.sf2 生成了 24 个样本', wavs.length === 24, String(wavs.length))
T('自动载入了 keysound 样本', info.loaded.length > 0 && /piano\((60|72)\)/.test(info.loaded.join(' ')), info.loaded.join(' ').slice(0, 120))
T('没有载入失败', info.failed.length === 0, info.failed.join(' | '))
T('谱面没有解析错误', info.errors.length === 0, info.errors.join(' | '))

// 切到 piano，点一格试听（不应报错）
await ev(`(() => { const sel = document.querySelector('.gd-inst-sel'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(sel,'0:piano'); sel.dispatchEvent(new Event('change',{bubbles:true})); return 1 })()`)
await wait(600)
const p = JSON.parse(await ev(`(() => { const c = document.querySelectorAll('.gd-cell')[4]; const r = c.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}) })()`))
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
await wait(900)
const after = JSON.parse(await ev(`(() => {
  const s = window.__store.getState()
  const all = s.output.slice(-30)
  const at = Math.max(0, all.findLastIndex((l) => l.includes('切换到 ksaudio.hs')))
  const logs = all.slice(at)
  return JSON.stringify({ logs, cells: [...document.querySelectorAll('.gd-cell')].slice(0, 6).map((c) => c.querySelector('.gd-label')?.textContent || '') })
})()`))
console.log('AFTER', JSON.stringify(after))
T('格子显示 D4（第 2 个音）', after.cells.join('|').includes('D4'), after.cells.join('|'))
T('试听没有报错', !after.logs.some((l) => l.includes('✗')), after.logs.join(' | ').slice(0, 160))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
