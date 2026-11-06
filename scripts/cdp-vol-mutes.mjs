/**
 * 时间轴音量条：去掉「总」字，静音键从 1 个变成 4 个（总 / 音乐 / 音效 / 节拍器）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9741
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

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
async function shotEl(sel, name, scale = 2, pad = 8) {
  const box = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.max(0, Math.floor(r.x) - ${pad}), y: Math.max(0, Math.floor(r.y) - ${pad}), width: Math.ceil(r.width) + ${pad * 2}, height: Math.ceil(r.height) + ${pad * 2} })
    })()`),
  )
  if (!box) return 'no-el'
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...box, scale } })
  if (sh?.result?.data) {
    fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
    return 'ok'
  }
  return 'fail'
}
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const chart = [
  '[Metadata]',
  'Title = vol',
  '',
  '[Files]',
  'path = ""',
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitclap Aa = default.soft-hitclap',
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
  const id = s.addFile('vol.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const MOD = `(() => {
  const ctl = () => document.querySelector('.vol-ctl')
  const btns = () => [...document.querySelectorAll('.vol-ctl .vol-mute')]
  const state = () => btns().map((b) => ({ title: b.getAttribute('title'), muted: b.className.includes('muted') }))
  const click = (i) => { const b = btns()[i]; if (!b) return 'no-btn'; b.click(); return 'ok' }
  const ctlText = () => (ctl() ? ctl().textContent : '')
  const slider = () => { const r = ctl() && ctl().querySelector('input[type=range]'); return r ? r.value : '' }
  const ls = (k) => localStorage.getItem('hss.vol.' + k)
  const labelTexts = () => [...document.querySelectorAll('.vol-ctl .vol-label')].map((x) => x.textContent)
  return { btns, state, click, ctlText, slider, ls, labelTexts }
})()`

console.log('COUNT', await ev(`${MOD}.btns().length`))
console.log('STATE0', await ev(`JSON.stringify(${MOD}.state())`))
T('静音键 4 个', (await ev(`${MOD}.btns().length`)) === 4)
T('控件里没有「总」字', !String(await ev(`${MOD}.ctlText()`)).includes('总'), await ev(`${MOD}.ctlText()`))
console.log('SHOT0', await shotEl('.vol-ctl', 'ui-vol-mutes.png', 3, 10))

const titles = JSON.parse(await ev(`JSON.stringify(${MOD}.state().map((s) => s.title))`))
T(
  '标题对应四条通道',
  titles.join('|') === '静音总音量|静音音乐|静音音效|静音节拍器',
  titles.join('|'),
)

// 逐个点：静音 → class + localStorage；再点恢复
for (const [i, key, label] of [
  [0, 'muted', '总音量'],
  [1, 'mutedSong', '音乐'],
  [2, 'mutedSfx', '音效'],
  [3, 'mutedMetro', '节拍器'],
]) {
  await ev(`${MOD}.click(${i})`)
  await wait(180)
  const st = JSON.parse(await ev(`JSON.stringify(${MOD}.state())`))[i]
  const raw = await ev(`${MOD}.ls('${key}')`)
  T(`${label} 静音：按钮变灰 + 记住`, st.muted === true && raw === '1', `muted=${st.muted} ls=${raw}`)
  await ev(`${MOD}.click(${i})`)
  await wait(180)
  const st2 = JSON.parse(await ev(`JSON.stringify(${MOD}.state())`))[i]
  T(`${label} 再点恢复`, st2.muted === false && (await ev(`${MOD}.ls('${key}')`)) === '0')
}

// 只静音音乐：总音量滑杆 / 数字不受影响；静音总音量才把滑杆压到 0
const before = await ev(`${MOD}.slider()`)
await ev(`${MOD}.click(1)`)
await wait(150)
T('只静音音乐时滑杆不变', (await ev(`${MOD}.slider()`)) === before, `${before} → ${await ev(`${MOD}.slider()`)}`)
await ev(`${MOD}.click(0)`)
await wait(150)
T('静音总音量后滑杆归 0', (await ev(`${MOD}.slider()`)) === '0')
console.log('SHOT1', await shotEl('.vol-ctl', 'ui-vol-mutes-on.png', 3, 10))

// 展开面板里的四条滑杆还在
await ev(`${MOD}.click(0)`)
await wait(120)
await ev(`(() => { const b = [...document.querySelectorAll('.vol-ctl .tl-btn')].find((x) => x.textContent.includes('音量')); b && b.click(); return 'ok' })()`)
await wait(250)
console.log('ROWS', await ev(`JSON.stringify(${MOD}.labelTexts())`))
T('展开后四条滑杆齐全', JSON.parse(await ev(`JSON.stringify(${MOD}.labelTexts())`)).join('|') === '总音量|音乐|音效|节拍器')

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
