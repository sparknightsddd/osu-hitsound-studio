/**
 * 右键「将音效 <代号> 复制到其他谱面」端到端：
 *  1. 单选一个有音效的格子，右键菜单出现这一项；
 *  2. 点击后弹出已打开谱面列表（不含源谱）；
 *  3. 选中另一份谱面 → 切过去并弹出「输入代号/选槽位」窗口，代号与槽位预填源谱的；
 *  4. 确定后目标谱面的 [Define] 多出这一条，源谱不变；
 *  5. 多选时菜单里没有这一项；取消选择器不会切谱。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9745
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hscopy-'))

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
const A_WAV = path.join(DIR, 'a.wav')
const B_WAV = path.join(DIR, 'b.wav')
writeWav(A_WAV, 880)
writeWav(B_WAV, 660)
const fwd = (p) => p.replace(/\\/g, '/')

const CHART1 = `[Metadata]
Title = one

[Define]
hitsound soft-hitnormal|normal-hitnormal Aa = "${fwd(A_WAV)}" #FF8800

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa = = = = = = = = = = = = = = =/
`
const CHART2 = `[Metadata]
Title = two

[Define]
hitsound drum-hitclap Bb = "${fwd(B_WAV)}"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Bb = = = = = = = = = = = = = = =/
`
const F1 = path.join(DIR, 'one.hs')
const F2 = path.join(DIR, 'two.hs')
fs.writeFileSync(F1, CHART1)
fs.writeFileSync(F2, CHART2)

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
await send('Page.enable')
await wait(2800)

const IDS = await ev(`(() => {
  const s = window.__store.getState()
  const a = s.addFile('one.hs', ${JSON.stringify(CHART1)})
  const b = s.addFile('two.hs', ${JSON.stringify(CHART2)})
  const ex = s.files.find((f) => f.name === 'example.hs')
  if (ex) s.closeFile(ex.id)
  s.attachPath(a, ${JSON.stringify(F1)}, ${JSON.stringify(CHART1)})
  s.attachPath(b, ${JSON.stringify(F2)}, ${JSON.stringify(CHART2)})
  s.setActive(a)
  s.setDiv(4)
  s.setEditorMode('grid')
  return { a, b }
})()`)
await wait(1200)
console.log('IDS', JSON.stringify(IDS))

const INFO = `(() => {
  const rows = [...document.querySelectorAll('.gd-row')].map((r) => [...r.querySelectorAll('.gd-cell')])
  const at = (ri, ci) => {
    const el = rows[ri] && rows[ri][ci]
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  }
  const menuLabels = () => [...document.querySelectorAll('.edit-menu .edit-menu-item')].map((b) => b.textContent.trim())
  const activeName = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.name || ''
  }
  const dlgName = () => document.querySelector('.as-dialog .as-name input')?.value || ''
  const dlgSlots = () => [...document.querySelectorAll('.as-dialog .as-cell.on')].map((e) => e.getAttribute('title'))
  const pickRows = () => [...document.querySelectorAll('.chart-pick-row')].map((b) => b.textContent)
  return { at, menuLabels, activeName, dlg: () => !!document.querySelector('.as-dialog'), dlgName, dlgSlots, pickRows }
})()`

async function rightClick(row, col) {
  const a = await ev(`${INFO}.at(${row}, ${col})`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'right', buttons: 2, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'right', buttons: 0, clickCount: 1 })
  await wait(350)
}
async function leftClick(row, col) {
  const a = await ev(`${INFO}.at(${row}, ${col})`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(250)
}
async function drag(from, to) {
  const a = await ev(`${INFO}.at(${from[0]}, ${from[1]})`)
  const b = await ev(`${INFO}.at(${to[0]}, ${to[1]})`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 3; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(a.x + ((b.x - a.x) * i) / 3),
      y: Math.round(a.y + ((b.y - a.y) * i) / 3),
      button: 'none',
      buttons: 1,
    })
    await wait(40)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(300)
}

// 1) 单选有音效的格子 → 右键有这一项
await leftClick(0, 0)
await rightClick(0, 0)
const labels = await ev(`${INFO}.menuLabels()`)
console.log('MENU', JSON.stringify(labels))
T('右键菜单有「将音效 Aa 复制到其他谱面」', labels.some((l) => l.includes('将音效 Aa 复制到其他谱面')), JSON.stringify(labels))

// 2) 点击 → 谱面选择器只列另一份
await ev(`[...document.querySelectorAll('.edit-menu .edit-menu-item')].find((b) => b.textContent.includes('复制到其他谱面'))?.click()`)
await wait(500)
const pickRows = await ev(`${INFO}.pickRows()`)
console.log('PICK', JSON.stringify(pickRows))
T('弹出谱面选择器', pickRows.length === 1, JSON.stringify(pickRows))
T('列表里只有另一份谱面 two.hs', pickRows.length === 1 && pickRows[0].includes('two.hs'), JSON.stringify(pickRows))
T('不列出源谱面 one.hs', !pickRows.some((r) => r.includes('one.hs')), JSON.stringify(pickRows))

// 截图：选择器
const shot1 = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (shot1?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-copy-sound-picker.png'), Buffer.from(shot1.result.data, 'base64'))
  console.log('SHOT1 ok')
}

// 3) 选中 two.hs → 切谱 + 预填弹窗
await ev(`document.querySelector('.chart-pick-row')?.click()`)
await wait(700)
const state = await ev(`(() => ({ name: ${INFO}.activeName(), open: ${INFO}.dlg(), code: ${INFO}.dlgName(), slots: ${INFO}.dlgSlots() }))()`)
console.log('DIALOG', JSON.stringify(state))
T('已切到 two.hs', state.name === 'two.hs', state.name)
T('弹出输入代号/槽位窗口', state.open === true)
T('代号预填 Aa', state.code === 'Aa', state.code)
T('槽位预填 soft-hitnormal + normal-hitnormal', JSON.stringify(state.slots.slice().sort()) === JSON.stringify(['normal-hitnormal', 'soft-hitnormal']), JSON.stringify(state.slots))

// 截图：预填弹窗
const shot2 = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (shot2?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-copy-sound-dialog.png'), Buffer.from(shot2.result.data, 'base64'))
  console.log('SHOT2 ok')
}

// 4) 确定 → 目标谱面多出定义
await ev(`document.querySelector('.as-dialog .si-ok')?.click()`)
await wait(900)
const after = await ev(`(() => {
  const s = window.__store.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  const d = s.doc.hitsounds.find((h) => h.name === 'Aa')
  return {
    name: f?.name,
    hasAa: !!d,
    slots: d ? d.alts.filter((a) => !a.custom).map((a) => a.sampleSet + '-' + a.hitType) : [],
    resolved: d?.resolvedPath || '',
    line: d ? f.content.split('\\n').find((l) => l.includes(' Aa ')) : '',
  }
})()`)
console.log('AFTER', JSON.stringify(after))
T('确定后仍停在 two.hs', after.name === 'two.hs', after.name)
T('two.hs 的 [Define] 里出现 Aa', after.hasAa === true)
T('槽位跟随源谱（soft/normal hitnormal）', JSON.stringify(after.slots.slice().sort()) === JSON.stringify(['normal-hitnormal', 'soft-hitnormal']), JSON.stringify(after.slots))
T('定义解析回源文件（同目录写成相对路径）', String(after.resolved).replace(/\\/g, '/').toLowerCase() === fwd(A_WAV).toLowerCase(), `${after.line} → ${after.resolved}`)

// 源谱没有被改动
const src = fs.readFileSync(F1, 'utf8')
T('源谱文件未被改动', src === CHART1)

// 5) 多选时没有这一项
await ev(`window.__store.getState().setActive(${JSON.stringify(IDS.a)})`)
await wait(600)
await drag([0, 0], [0, 2])
await rightClick(0, 0)
const labels2 = await ev(`${INFO}.menuLabels()`)
console.log('MENU2', JSON.stringify(labels2))
T('多选时没有「复制到其他谱面」', !labels2.some((l) => l.includes('复制到其他谱面')), JSON.stringify(labels2))
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await wait(250)

// 6) 取消选择器不切谱
await leftClick(0, 0)
await rightClick(0, 0)
await ev(`[...document.querySelectorAll('.edit-menu .edit-menu-item')].find((b) => b.textContent.includes('复制到其他谱面'))?.click()`)
await wait(400)
await ev(`document.querySelector('.osu-diff-cancel')?.click()`)
await wait(400)
T('取消选择器后仍停在 one.hs', (await ev(`${INFO}.activeName()`)) === 'one.hs', await ev(`${INFO}.activeName()`))

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
await wait(500)
try { fs.rmSync(USERDATA, { recursive: true, force: true }); fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
process.exit(0)
