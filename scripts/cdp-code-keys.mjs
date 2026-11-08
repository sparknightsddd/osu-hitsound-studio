/**
 * 网格模式的新代号规则：
 *  - 52 个字母（区分大小写）+ 10 个数字 + 英文符号都能一键落笔；
 *  - 正文里写数字/符号的名字（One / Slash / AtSign），格子里显示符号（1 / / / @）；
 *  - 多字母代号仍可按前缀输入（Aa）；大小写不同是不同代号。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
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
const shot = async (file) => {
  const s = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(6000)])
  if (s?.result?.data) fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'))
}

let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const CHART = `[Metadata]
Title = code keys

[Files]
audio = ""

[Define]
hitsound custom Aa = default.normal-hitnormal
hitsound custom aa = default.normal-hitwhistle
hitsound custom A = default.drum-hitnormal
hitsound custom a = default.drum-hitclap
hitsound custom One = default.soft-hitnormal
hitsound custom Slash = default.soft-hitclap
hitsound custom AtSign = default.soft-hitfinish
hitsound custom Minus = default.soft-hitwhistle

[Timing]
0,bpm(120),4,0,0

[Hitsound]
/= = = = = = = = = = = = = = = =/
`

await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('codes.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1600)

const brushes = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.gd-brush')].map((b) => b.textContent))`),
)
console.log('BRUSHES', JSON.stringify(brushes))
T(
  '画笔按网格习惯显示：1 / / @ -',
  brushes.join('|') === 'Aa|aa|A|a|1|/|@|-',
  brushes.join('|'),
)

const clickCell = async (i) => {
  const p = JSON.parse(
    await ev(`(() => {
      const c = document.querySelectorAll('.gd-cell')[${i}]
      const r = c.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`),
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(250)
}

const VK = { '1': 49, '/': 191, '@': 50, A: 65, a: 65 }
const CODE = { '1': 'Digit1', '/': 'Slash', '@': 'Digit2', A: 'KeyA', a: 'KeyA' }
const press = async (key, shift = false) => {
  const vk = VK[key]
  const code = CODE[key]
  const mods = shift ? 8 : 0
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      text: type === 'keyDown' ? key : undefined,
      modifiers: mods,
    })
  }
  await wait(300)
}

const cellText = () => ev(`document.querySelector('.gd-cell.sel .gd-label')?.textContent || ''`)
const lineTokens = async () => {
  const txt = await ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    const ls = f.content.split('\\n')
    const i = ls.findIndex((l) => l.trim() === '[Hitsound]')
    const body = ls.slice(i + 1).find((l) => l.startsWith('/')) || ''
    return body
  })()`)
  return { line: txt, toks: txt.replace(/^\/|\/$/g, '').split(/\s+/).filter(Boolean) }
}

// 1 → One
await clickCell(0)
await press('1')
let st = await lineTokens()
T('按 1 写进正文的是 One', st.toks[0] === 'One', st.line)
T('格子里显示 1', (await cellText()) === '1', await cellText())

// / → Slash
await clickCell(1)
await press('/')
st = await lineTokens()
T('按 / 写进正文的是 Slash', st.toks[1] === 'Slash', st.line)
T('格子里显示 /', (await cellText()) === '/', await cellText())

// @ → AtSign（Shift+2）
await clickCell(2)
await press('@', true)
st = await lineTokens()
T('按 @ 写进正文的是 AtSign', st.toks[2] === 'AtSign', st.line)
T('格子里显示 @', (await cellText()) === '@', await cellText())

// a → a（小写）
await clickCell(3)
await press('a')
st = await lineTokens()
T('按 a 写的是小写代号 a', st.toks[3] === 'a', st.line)
T('格子里显示 a', (await cellText()) === 'a', await cellText())

// Shift+A → 大写 A（和 a 是两个代号，单键立即落笔）
await clickCell(4)
await press('A', true)
await wait(200)
st = await lineTokens()
T('按 Shift+A 写的是大写代号 A', st.toks[4] === 'A', st.line)
T('格子里显示 A', (await cellText()) === 'A', await cellText())

await shot(path.join(ROOT, 'ui-code-keys.png'))

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
