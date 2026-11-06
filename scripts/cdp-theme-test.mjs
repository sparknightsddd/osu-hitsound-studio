/**
 * 验证主题三态：light / dark / auto（跟随系统）。
 * 用 CDP Emulation.setEmulatedMedia 模拟系统 prefers-color-scheme。
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9340
const { spawn } = await import('node:child_process')
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-themetest',
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
async function waitWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no ws')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
function send(method, params = {}, sid) {
  const msg = { id: ++id, method, params }
  if (sid) msg.sessionId = sid
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}
function evalJs(expression, sid) {
  return send('Runtime.evaluate', { expression, returnByValue: true }, sid)
}

const { result } = await send('Target.createTarget', { url: 'about:blank' })
const { result: att } = await send('Target.attachToTarget', { targetId: result.targetId, flatten: true })
const sid = att.sessionId
await send('Page.enable', {}, sid)
await send('Runtime.enable', {}, sid)
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false }, sid)

// 导航前就模拟系统深色，保证 matchMedia 初值正确
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
}, sid)
await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, sid)
await new Promise((r) => setTimeout(r, 4000))

let pass = 0
let fail = 0
function T(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

// 1) auto + 系统深色 → data-theme=dark
await evalJs(`window.__store.getState().setTheme('auto')`, sid)
await new Promise((r) => setTimeout(r, 300))
let r = await evalJs(`JSON.stringify({
  dt: document.documentElement.getAttribute('data-theme'),
  body: getComputedStyle(document.body).backgroundColor,
  sb: [...document.querySelectorAll('.statusbar .item')].map(e=>e.textContent).find(t=>t&&t.includes('主题')),
})`, sid)
let v = JSON.parse(r.result.result.value)
T('auto + 系统深色 → 深色', v.dt === 'dark' && /rgb\(31, 31, 31\)/.test(v.body), JSON.stringify(v))

// 2) 系统切浅色（不重载，靠 change 事件）→ data-theme=light
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
}, sid)
await new Promise((r) => setTimeout(r, 500))
r = await evalJs(`JSON.stringify({
  dt: document.documentElement.getAttribute('data-theme'),
  body: getComputedStyle(document.body).backgroundColor,
  sb: [...document.querySelectorAll('.statusbar .item')].map(e=>e.textContent).find(t=>t&&t.includes('主题')),
})`, sid)
v = JSON.parse(r.result.result.value)
T('auto + 切系统浅色 → 浅色（实时跟随）', v.dt === 'light' && /rgb\(255, 255, 255\)/.test(v.body), JSON.stringify(v))

// 3) 手动深色覆盖 auto
await evalJs(`window.__store.getState().setTheme('dark')`, sid)
await new Promise((r) => setTimeout(r, 300))
r = await evalJs(`document.documentElement.getAttribute('data-theme')`, sid)
T('手动选深色 → 深色（即使系统浅色）', r.result.result.value === 'dark', r.result.result.value)

// 4) 刷新后偏好保持（localStorage），系统仍是浅色 → 还是深色
await send('Page.reload', {}, sid)
await new Promise((r) => setTimeout(r, 3500))
r = await evalJs(`JSON.stringify({
  dt: document.documentElement.getAttribute('data-theme'),
  pref: window.__store.getState().theme,
})`, sid)
v = JSON.parse(r.result.result.value)
T('刷新后主题偏好保持', v.dt === 'dark' && v.pref === 'dark', JSON.stringify(v))

// 5) auto + 刷新 + 系统浅色 → 浅色
await evalJs(`window.__store.getState().setTheme('auto')`, sid)
await send('Page.reload', {}, sid)
await new Promise((r) => setTimeout(r, 3500))
r = await evalJs(`document.documentElement.getAttribute('data-theme')`, sid)
T('auto + 系统浅色 + 刷新 → 浅色', r.result.result.value === 'light', r.result.result.value)

// 6) 菜单三项存在
r = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.titlebar button')]
  return btns.map(b=>b.textContent).join('|')
})()`, sid)
console.log('TITLEBAR_BUTTONS', r.result.result.value)

console.log(`\\n${pass} PASS, ${fail} FAIL`)
ws.close()
chrome.kill()
process.exit(fail ? 1 : 0)
