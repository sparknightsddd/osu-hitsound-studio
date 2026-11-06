/**
 * 格子右键「在 osu! Editor 中打开」：单格可用、多选置灰，链接是 osu://edit/mm:ss:xxx。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9701
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
await wait(2800)

const chart = [
  '[Metadata]',
  'Title = osu link',
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
  const id = s.addFile('osulink.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

// 探针：window.desktop 能不能被替换（能的话就可以截获 openExternal，不真的去唤起 osu!）
console.log(
  'DESKTOP_PROBE',
  await ev(`(() => {
    const d = Object.getOwnPropertyDescriptor(window, 'desktop')
    let writable = 'no-descriptor'
    try {
      const before = window.desktop
      window.desktop = { ...before, openExternal: (u) => { window.__opened = u; return Promise.resolve({ ok: true }) } }
      writable = window.desktop.openExternal !== before.openExternal ? 'replaced' : 'same'
    } catch (e) { writable = 'throw: ' + e.message }
    return JSON.stringify({ desc: d ? { w: d.writable, c: d.configurable } : null, writable })
  })()`),
)

const MENU = `(() => {
  const items = () => [...document.querySelectorAll('.edit-menu-item')]
  const find = () => items().find((x) => (x.textContent || '').startsWith('在 osu! Editor'))
  const info = () => {
    const it = find()
    if (!it) return null
    const h = it.querySelector('.hint')
    return { label: it.querySelector('span').textContent, hint: h ? h.textContent : '', disabled: it.className.includes('disabled') }
  }
  const click = () => { const it = find(); if (!it) return 'no-item'; it.click(); return 'ok' }
  const close = () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok' }
  const cells = () => [...document.querySelectorAll('.gd-cell')]
  const cellRect = (i) => { const r = cells()[i].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: (cells()[i].getAttribute('title') || '').split('\\n')[0] } }
  const selected = () => cells().filter((c) => { const cl = ' ' + c.className + ' '; return cl.includes(' sel ') || cl.includes(' insel ') }).length
  const titles = (n) => cells().slice(0, n).map((c) => (c.getAttribute('title') || '').split(' · ')[0] + '#' + (c.className || ''))
  const status = () => (document.querySelector('.gd-status') || {}).textContent || ''
  return { info, click, close, cellRect, selected, titles, status }
})()`

async function rightClick(p, mods = 0) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1, modifiers: mods })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1, modifiers: mods })
  await wait(450)
}

// 1) 单格右键
const c0 = JSON.parse(await ev(`JSON.stringify(${MENU}.cellRect(0))`))
console.log('CELL0', JSON.stringify(c0))
await rightClick(c0)
console.log('SINGLE', await ev(`JSON.stringify(${MENU}.info())`))
console.log('SHOT_MENU', await shotEl('.edit-menu', 'ui-grid-osu-menu.png', 2, 10))
{
  const info = JSON.parse((await ev(`JSON.stringify(${MENU}.info())`)) || 'null')
  T('单格时可用', !!info && !info.disabled)
  T('hint 显示这一格的时间', !!info && info.hint === c0.title.split(' · ')[0], info ? info.hint : '')
}
// 点这一项会真的唤起 osu!，默认跳过；要验证「唤起之后的日志/链接」就设 HS_TEST_OSU_LINK=1
if (process.env.HS_TEST_OSU_LINK === '1') {
  console.log('CLICK', await ev(`${MENU}.click()`))
  // openExternal 走主进程，等日志里出现链接（同时也就证明了 URL 拼对了）
  let logLine = ''
  for (let i = 0; i < 15 && !logLine.includes('osu://edit/'); i++) {
    await wait(300)
    logLine = String(await ev(`JSON.stringify(window.__store.getState().output.slice(-1))`))
  }
  console.log('LOG', logLine)
  const link = /osu:\/\/edit\/\d{2}:\d{2}:\d{3}/.exec(logLine)
  T('链接格式 osu://edit/mm:ss:xxx', !!link, link ? link[0] : logLine)
} else {
  console.log('SKIP  实际唤起 osu!（设 HS_TEST_OSU_LINK=1 才测）')
  await ev(`${MENU}.close()`)
  await wait(200)
}

// 2) 多选后右键：应该置灰
await wait(200)
console.log('TITLES', await ev(`JSON.stringify(${MENU}.titles(4))`))
const c1 = JSON.parse(await ev(`JSON.stringify(${MENU}.cellRect(1))`))
const c2 = JSON.parse(await ev(`JSON.stringify(${MENU}.cellRect(2))`))
console.log('C1C2', JSON.stringify(c1), JSON.stringify(c2))
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c1.x, y: c1.y, button: 'none', buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c1.x, y: c1.y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c1.x, y: c1.y, button: 'left', buttons: 0, clickCount: 1 })
await wait(150)
// Ctrl+点击第二格（只点一次：再点一次就是取消选中了）
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c2.x, y: c2.y, button: 'none', buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c2.x, y: c2.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c2.x, y: c2.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 })
await wait(200)
console.log('SEL_AFTER_PLAIN', await ev(`${MENU}.selected()`))
console.log('SEL_COUNT', await ev(`${MENU}.selected()`), await ev(`JSON.stringify(${MENU}.titles(4))`))
await rightClick(c2)
console.log('MULTI', await ev(`JSON.stringify(${MENU}.info())`))
{
  const info = JSON.parse((await ev(`JSON.stringify(${MENU}.info())`)) || 'null')
  T('多选时置灰', !!info && info.disabled)
  T('多选时提示「仅单选」', !!info && info.hint === '仅单选', info ? info.hint : '')
}
await ev(`${MENU}.close()`)
console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
