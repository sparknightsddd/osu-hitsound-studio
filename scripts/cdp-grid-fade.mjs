/**
 * 右键「添加渐变音量…」：连续选区 → 填始末音量 + 间隔 → 写成一组 <v>。
 * 同时验证：
 *   - 区域里原有的 <v>（不在关键帧上）会被清掉；
 *   - 区域结束后恢复原来的音量；
 *   - 非连续选区时菜单项禁用。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9537
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

const toks = []
for (let i = 0; i < 16; i++) {
  if (i === 2) toks.push('<v=20>')
  toks.push('=')
}
const chart = [
  '[Metadata]',
  'Title = fade',
  '',
  '[Files]',
  'audio = ""',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/' + toks.join(' ') + '/',
  '#2000',
  '/= = = =/',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('fade.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  s.setEditorMode('grid')
  s.setDiv(4)
  return 'ok'
})()`)
await wait(1000)

const cellPos = (col, row = 0) =>
  ev(`(() => {
    const c = document.querySelectorAll('.gd-row')[${row}]?.querySelectorAll('.gd-cell')[${col}]
    if (!c) return 'null'
    const r = c.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  })()`).then((s) => JSON.parse(s))

const mouse = (type, p, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', ...extra })

const dragSelect = async (from, to, row = 0) => {
  const a = await cellPos(from, row)
  const b = await cellPos(to, row)
  await mouse('mousePressed', a, { buttons: 1, clickCount: 1 })
  await mouse('mouseMoved', b, { buttons: 1 })
  await mouse('mouseReleased', b, { buttons: 0, clickCount: 1 })
  await wait(300)
}

const rightClick = async (col, row = 0) => {
  const p = await cellPos(col, row)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 })
  await wait(350)
}

const menuItem = (label) =>
  [...document.querySelectorAll('.edit-menu-item')].find((x) => x.textContent.includes(label))

const line = (n = 0) =>
  ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    const lines = f.content.split('\\n').filter((l) => l.startsWith('/'))
    return lines[${n}] || ''
  })()`)

// 1) 连续选区 → 菜单项可用 → 打开弹窗
await dragSelect(0, 15)
await rightClick(8)
const hasItem = await ev(`!![...document.querySelectorAll('.edit-menu-item')].find((x) => x.textContent.includes('添加渐变音量'))`)
T('连续选区右键有「添加渐变音量…」', hasItem === true)
const enabled = await ev(`(() => {
  const it = [...document.querySelectorAll('.edit-menu-item')].find((x) => x.textContent.includes('添加渐变音量'))
  return !!it && !it.classList.contains('disabled')
})()`)
T('菜单项可用', enabled === true)
await ev(`(() => {
  const it = [...document.querySelectorAll('.edit-menu-item')].find((x) => x.textContent.includes('添加渐变音量'))
  it?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return 'ok'
})()`)
await wait(300)
const dlgTitle = await ev(`document.querySelector('.gd-vol-title')?.textContent || ''`)
T('弹窗打开', dlgTitle.includes('添加渐变音量'), dlgTitle)

// 2) 填 100 / 0 / 5
const filled = await ev(`(() => {
  const inputs = [...document.querySelectorAll('.gd-fade-grid input')]
  if (inputs.length !== 3) return 'count=' + inputs.length
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const vals = ['100', '0', '5']
  inputs.forEach((inp, i) => {
    set.call(inp, vals[i])
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return 'ok'
})()`)
T('三个输入框都填上', filled === 'ok', filled)
await wait(250)
// 清空结束音量不能被当成 0
await ev(`(() => {
  const inp = document.querySelectorAll('.gd-fade-grid input')[1]
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, '')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await wait(200)
T('清空结束音量时「确定」不可用', (await ev(`document.querySelector('.gd-vol-foot .btn.accent')?.disabled`)) === true)
await ev(`(() => {
  const inp = document.querySelectorAll('.gd-fade-grid input')[1]
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, '0')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await wait(200)
const preview = await ev(`[...document.querySelectorAll('.gd-vol-foot .hint')].map((x) => x.textContent).join(' | ')`)
T('预览 4 个位置', /4 个位置/.test(preview), preview)
{
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (sh?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-fade-dialog.png'), Buffer.from(sh.result.data, 'base64'))
}
await ev(`(() => {
  const b = [...document.querySelectorAll('.gd-vol-foot .btn')].find((x) => x.textContent.trim() === '确定')
  b?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return 'ok'
})()`)
await wait(500)

const l0 = await line(0)
// 间隔 5 格：关键帧在 0/5/10/15；每个 <v> 写在它那一格的 token 前面
const expect = '/<v=100> = = = = = <v=67> = = = = = <v=33> = = = = = <v=0> =/'
T('渐变写成 0/5/10/15 四个 <v>', l0 === expect, l0)
T('区域里原有的 <v=20> 被清掉', !l0.includes('<v=20>'), l0)
const l1 = await line(1)
T(
  '区域之后恢复原来的音量（<v=20>）',
  l1.trim().startsWith('/<v=20> ') && !l1.includes('<v=0>') && true,
  l1.trim(),
)

// 3) 撤销回到原样
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
await wait(450)
T('一次撤销回到渐变前', (await line(0)).includes('<v=20>') && !(await line(0)).includes('<v=100>'), await line(0))

// 4) 非连续选区：菜单项禁用
await ev(`window.__store.setState({})`)
await dragSelect(0, 0)
const p4 = await cellPos(4)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p4.x, y: p4.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p4.x, y: p4.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 })
await wait(250)
await rightClick(0)
const disabled = await ev(`(() => {
  const it = [...document.querySelectorAll('.edit-menu-item')].find((x) => x.textContent.includes('添加渐变音量'))
  return !!it && it.classList.contains('disabled') && it.textContent.includes('仅连续选区')
})()`)
T('非连续选区时菜单项禁用并提示', disabled === true)

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
