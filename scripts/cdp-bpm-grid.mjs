/**
 * 小节中途变速（继承型 Timing 改 BPM）时的格子编辑：
 * 4/4 开 1/4 细分，第三拍应该落在 1000ms，点第 9 格写入/删除都要正常。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9425
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

const CHART = `[Metadata]
Title = bpm mid

[Files]
audio = ""

[Define]
hitsound custom Aa = default.normal-hitnormal

[Timing]
0,bpm(120),4,0,0
1000,bpm(240),4,0,2,0

[Hitsound]
#0
/= = = = = = = = = = = = = = = =/
`

await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('bpm.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const cells = await ev(`document.querySelector('.gd-row')?.querySelectorAll('.gd-cell').length || 0`)
T('首行至少铺出 16 格（1/4 细分）', cells >= 16, String(cells))

const tickX = async (i) =>
  JSON.parse(
    await ev(`(() => {
      const c = document.querySelectorAll('.gd-cell')[${i}]
      const r = c.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`),
  )
const clickCell = async (i) => {
  const p = await tickX(i)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(250)
}

// 点第三拍第一格，按两次 a 落笔（Aa 的前缀输入）
await clickCell(8)
for (let i = 0; i < 2; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: 'a' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await wait(120)
}
await wait(1000)

const state = () =>
  ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    const d = s.doc
    const body = f.content.split('\\n').find((l) => l.startsWith('/')) || ''
    const evs = d.events.map((e) => ({ t: Math.round(e.time), n: e.names.join('+') }))
    const labels = [...document.querySelectorAll('.gd-cell')].map((c) => c.querySelector('.gd-label')?.textContent || '')
    return JSON.stringify({ body, evs, labels })
  })()`).then((s) => JSON.parse(s))

let st = await state()
console.log('AFTER_WRITE', JSON.stringify({ evs: st.evs, labels: st.labels.join('|') }))
T('写入的音效在 1000ms（第三拍）', st.evs.some((e) => e.t === 1000 && e.n === 'Aa'), JSON.stringify(st.evs))
T('亮起的是第 9 格，不是前一个格子', st.labels[8] === 'Aa', `idx8=${st.labels[8]}, idx6=${st.labels[6]}`)
T('第 7 格没有被误写', !st.labels[6], `idx6=${st.labels[6]}`)

// 删除刚写的格子
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 })
await wait(900)
st = await state()
console.log('AFTER_DEL', JSON.stringify({ evs: st.evs, labels: st.labels.join('|') }))
T('删掉后 1000ms 没有音效', !st.evs.some((e) => e.t === 1000), JSON.stringify(st.evs))
T('第 9 格已经清空', !st.labels[8], `idx8=${st.labels[8]}`)

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
