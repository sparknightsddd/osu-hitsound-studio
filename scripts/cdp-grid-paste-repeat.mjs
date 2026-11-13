/**
 * 片段 + Ctrl 多选锚点的粘贴：
 *   复制 ABCD（4 格），Ctrl 点第 5/9/13 格 → 每处各贴一份，得到 ABCD×4；
 *   若锚点间距放不下整段（第 5、8 格），退回原来的「只贴第一处」。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9535
const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-')) }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)

async function waitWs() {
  for (let i = 0; i < 100; i++) {
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
await wait(3000)

const base = [
  '[Metadata]',
  'Title = paste repeat',
  '',
  '[Files]',
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitclap A = default.soft-hitclap',
  'hitsound soft-hitclap B = default.soft-hitclap',
  'hitsound soft-hitclap C = default.soft-hitclap',
  'hitsound soft-hitclap D = default.soft-hitclap',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/A B C D = = = = = = = = = = = =/',
].join('\n')

let n = 0
const newChart = async () => {
  n++
  await ev(`(() => {
    const s = window.__store.getState()
    const id = s.addFile('paste-${n}.hs', ${JSON.stringify(base)})
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    window.__store.getState().setDiv(4)
    return 'ok'
  })()`)
  await wait(900)
}

const cellPos = (col, row = 0) =>
  ev(`(() => {
    const c = document.querySelectorAll('.gd-row')[${row}]?.querySelectorAll('.gd-cell')[${col}]
    if (!c) return 'null'
    const r = c.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  })()`).then((s) => JSON.parse(s))

const mouse = async (type, p, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', ...extra })

const click = async (col, ctrl = false) => {
  const p = await cellPos(col)
  const modifiers = ctrl ? 2 : 0
  await mouse('mousePressed', p, { buttons: 1, clickCount: 1, modifiers })
  await mouse('mouseReleased', p, { buttons: 0, clickCount: 1, modifiers })
  await wait(220)
}

const dragSelect = async (from, to) => {
  const a = await cellPos(from)
  const b = await cellPos(to)
  await mouse('mousePressed', a, { buttons: 1, clickCount: 1 })
  await mouse('mouseMoved', b, { buttons: 1 })
  await mouse('mouseReleased', b, { buttons: 0, clickCount: 1 })
  await wait(280)
}

const hotkey = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: 2,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: 2,
  })
  await wait(350)
}

const line = () =>
  ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    return (f.content.split('\\n').find((l) => l.startsWith('/')) || '').trim()
  })()`)

const copyPaste = async (anchorCols) => {
  await dragSelect(0, 3)
  T('选中 ABCD 四格', (await ev(`document.querySelectorAll('.gd-scroll .gd-cell.sel, .gd-scroll .gd-cell.insel').length`)) === 4)
  await hotkey('c', 'KeyC', 67)
  for (const c of anchorCols) await click(c, true)
  await hotkey('v', 'KeyV', 86)
}

// 1) 锚点 5/9/13 → 每处各贴一份
await newChart()
await copyPaste([4, 8, 12])
const l1 = await line()
T('ABCD × 4 一次贴好', l1 === '/A B C D A B C D A B C D A B C D/', l1)
T('日志写明贴了 3 份', await ev(`window.__store.getState().output.some((x) => x.includes('粘贴了 3 份'))`) === true)

// 2) 锚点 5、8 → 放不下整段，退回原来的逻辑（只贴第一处）
await newChart()
await copyPaste([4, 7])
const l2 = await line()
T('放不下时退回只贴第一处', l2 === '/A B C D A B C D = = = = = = = =/', l2)

// 3) 只选一个锚点 → 粘贴一次（老行为不变）
await newChart()
await copyPaste([4])
const l3 = await line()
T('单锚点仍然只贴一次', l3 === '/A B C D A B C D = = = = = = = =/', l3)

// 4) 先普通点一下再 Ctrl 选（源选区已清空）→ 同样重复
await newChart()
await dragSelect(0, 3)
await hotkey('c', 'KeyC', 67)
await click(4)
await click(8, true)
await click(12, true)
await hotkey('v', 'KeyV', 86)
const l4 = await line()
T('源选区清空后同样重复', l4 === '/A B C D A B C D A B C D A B C D/', l4)

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
