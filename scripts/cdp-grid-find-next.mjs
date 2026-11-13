/**
 * 网格查找替换：查找下一项。
 *   - 从当前光标往后跳，命中依次为 00:00:250 / 00:10:875 / 00:24:000 / 00:39:875，然后回到第一个；
 *   - 跳过去会滚动到可见；
 *   - 查找框里按 Enter = 查找下一项（不再触发全部替换）；
 *   - 无命中时按钮禁用；
 *   - 多选打开时范围会冻结，查找下一项改选区后不会缩成整谱/一格。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9541
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
  if (d.method === 'Runtime.exceptionThrown')
    errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || 'exception')
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

const bodyAt = (k) => {
  const toks = []
  for (let i = 0; i < 16; i++) toks.push(i === k ? '[Aa Ab]' : '=')
  return '/' + toks.join(' ') + '/'
}
const chart = [
  '[Metadata]',
  'Title = find next',
  '',
  '[Files]',
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitclap Aa = default.soft-hitclap',
  'hitsound soft-hitwhistle Ab = default.soft-hitwhistle',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  bodyAt(2),
  '#10000',
  bodyAt(7),
  '#24000',
  bodyAt(0),
  '#38000',
  bodyAt(15),
].join('\n')

const load = async (name) => {
  await ev(`(() => {
    const s = window.__store.getState()
    for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
    const id = s.addFile(${JSON.stringify(name)}, ${JSON.stringify(chart)})
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    window.__store.getState().setDiv(4)
    return 'ok'
  })()`)
  await wait(900)
}

const ctrlF = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 })
  await wait(350)
}

const setFind = async (v) => {
  await ev(`(() => {
    const el = document.querySelector('.gd-find-input')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(v)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await wait(350)
}

const clickBtn = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.gd-find-dlg .btn')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return 'ok'
  })()`)
  await wait(450)
  return r
}

const selInfo = () =>
  ev(`(() => {
    const c = document.querySelector('.gd-scroll .gd-cell.sel')
    if (!c) return 'null'
    const s = document.querySelector('.gd-scroll')
    const a = c.getBoundingClientRect()
    const b = s.getBoundingClientRect()
    return JSON.stringify({
      title: c.getAttribute('title') || '',
      visible: a.top >= b.top - 1 && a.bottom <= b.bottom + 1,
    })
  })()`)

const selTime = async () => {
  const s = await selInfo()
  return s === 'null' ? '' : (JSON.parse(s).title.split(' · ')[0] || '')
}
const selVisible = async () => {
  const s = await selInfo()
  return s === 'null' ? false : JSON.parse(s).visible === true
}

const status = () => ev(`document.querySelector('.gd-find-dlg .gd-vol-foot .hint')?.textContent || ''`)
const body = () =>
  ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    return (f.content.split('[Hitsound]')[1] || '').trim()
  })()`)

// ---- 1) 顺序查找 ----
await load('find-next.hs')
await ctrlF()
T('Ctrl+F 打开查找', (await ev(`!!document.querySelector('.gd-find-dlg')`)) === true)
await setFind('Aa Ab')
T('命中 4 格', (await status()).includes('匹配 4 格'), await status())

const expected = ['00:00:250', '00:10:875', '00:24:000', '00:39:875']
for (let i = 0; i < expected.length; i++) {
  const r = await clickBtn('查找下一项')
  T(`第 ${i + 1} 次查找下一项`, r === 'ok' && (await selTime()) === expected[i], `${r} / ${await selTime()}`)
  T(`第 ${i + 1} 个命中滚动到可见`, await selVisible())
}
await clickBtn('查找下一项')
T('到底后回到第一个', (await selTime()) === '00:00:250', await selTime())

{
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (sh?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-grid-find-next.png'), Buffer.from(sh.result.data, 'base64'))
}

// ---- 2) 查找框按 Enter ----
const before = await body()
await ev(`document.querySelector('.gd-find-input').focus(); 'ok'`)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await wait(450)
T('Enter 跳到下一个命中', (await selTime()) === '00:10:875', await selTime())
T('Enter 没有触发全部替换', (await body()) === before)

// ---- 3) 无命中时按钮禁用 ----
await setFind('Zz')
T('无命中时按钮禁用', (await clickBtn('查找下一项')) === 'disabled')
await setFind('Aa Ab')

// ---- 4) 多选打开时范围冻结 ----
await clickBtn('关闭')
await wait(250)
// 选第 1 小节的 0..4 格（包含 k=2 的命中）
const cellPos = (col, row = 0) =>
  ev(`(() => {
    const c = document.querySelectorAll('.gd-row')[${row}]?.querySelectorAll('.gd-cell')[${col}]
    const r = c.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  })()`).then((s) => JSON.parse(s))
const p0 = await cellPos(0)
const p4 = await cellPos(4)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p4.x, y: p4.y, button: 'left', buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p4.x, y: p4.y, button: 'left', buttons: 0, clickCount: 1 })
await wait(350)
await ctrlF()
await setFind('Aa Ab')
const scoped = await status()
T('多选范围提示还在', (await ev(`!!document.querySelector('.gd-find-scope')`)) === true, scoped)
T('范围内命中 1 格', scoped.includes('匹配 1 格'), scoped)
await clickBtn('查找下一项')
T('查找到范围内的命中', (await selTime()) === '00:00:250', await selTime())
const afterScope = await status()
T(
  '改选区后范围仍冻结（仍是 1 格）',
  (await ev(`!!document.querySelector('.gd-find-scope')`)) === true && afterScope.includes('匹配 1 格'),
  afterScope,
)

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
