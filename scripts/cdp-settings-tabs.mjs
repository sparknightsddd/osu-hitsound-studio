/** 设置窗：分页 + 12 个槽位的颜色块能否改、能存。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9561
const env = { ...process.env, NODE_ENV: 'production' }
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
async function shot(name) {
  await send('Page.bringToFront')
  for (let i = 0; i < 4; i++) {
    const sh = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: i % 2 === 0 }),
      new Promise((r) => setTimeout(r, 12000)),
    ])
    if (sh?.result?.data) {
      fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
      return
    }
    await wait(400)
  }
  console.log('SHOT_FAILED', name)
}
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)
// 断言用的是中文文案：先强制中文，避免上次运行留下的 en-US 影响
await ev(`window.__i18n.setLang('zh-CN'); 1`)
await wait(400)

// 先清掉可能残留的偏好，从默认状态开始
await ev(`localStorage.removeItem('hsstudio.importColors'); localStorage.removeItem('hsstudio.importCodes'); 1`)

console.log('OPEN', await ev(`(() => { window.__openAppSettings(); return 'ok' })()`))
await wait(700)
console.log(
  'TABS',
  await ev(`JSON.stringify({
    tabs: [...document.querySelectorAll('.set-tab')].map((b) => b.textContent.trim()),
    active: document.querySelector('.set-tab.on')?.textContent.trim(),
    colors: document.querySelectorAll('.set-color').length,
    swatches: [...document.querySelectorAll('.set-color')].map((e) => getComputedStyle(e).getPropertyValue('--cc').trim()),
    inputs: document.querySelectorAll('.set-cell .set-input').length,
  })`),
)
await shot('ui-settings-tabs-import.png')

// 切到别的页看一下
for (const label of ['常规', 'Timing', '导出']) {
  console.log(
    'TAB',
    label,
    await ev(`(() => {
      const b = [...document.querySelectorAll('.set-tab')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return 'no-tab'
      b.click()
      return new Promise((r) => setTimeout(() => r(JSON.stringify({
        active: document.querySelector('.set-tab.on')?.textContent.trim(),
        sections: [...document.querySelectorAll('.set-section-title')].map((x) => x.textContent.trim()),
        sub: document.querySelector('.osu-diff-sub')?.textContent.trim(),
      })), 200))
    })()`),
  )
}
await shot('ui-settings-tabs-general.png')

// 回到「导入」，改 soft-hitclap 的颜色（第 4 个色块）
console.log(
  'PICK',
  await ev(`(() => {
    const b = [...document.querySelectorAll('.set-tab')].find((x) => x.textContent.trim() === '导入')
    b.click()
    return 'ok'
  })()`),
)
await wait(250)
console.log(
  'SETCOLOR',
  await ev(`(() => {
    const el = document.querySelectorAll('.set-color input[type=color]')[3]
    if (!el) return 'no-color'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '#ff0066')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`),
)
await wait(300)
console.log(
  'SWATCH_AFTER',
  await ev(`getComputedStyle(document.querySelectorAll('.set-color')[3]).getPropertyValue('--cc').trim()`),
)
await shot('ui-settings-tabs-color.png')

console.log('SAVE', await ev(`(() => { document.querySelector('.si-ok')?.click(); return 'clicked' })()`))
await wait(600)
console.log('OPEN_AFTER_SAVE', await ev(`!!document.querySelector('.set-dialog')`))
console.log('STORED', await ev(`localStorage.getItem('hsstudio.importColors')`))

// 重新打开：页签回到上次的「导入」，颜色还在
console.log('REOPEN', await ev(`(() => { window.__openAppSettings(); return 'ok' })()`))
await wait(600)
console.log(
  'AFTER_REOPEN',
  await ev(`JSON.stringify({
    active: document.querySelector('.set-tab.on')?.textContent.trim(),
    swatch: getComputedStyle(document.querySelectorAll('.set-color')[3]).getPropertyValue('--cc').trim(),
  })`),
)

// 恢复默认按钮
console.log(
  'RESET',
  await ev(`(() => {
    const b = [...document.querySelectorAll('.set-dialog .btn')].find((x) => x.textContent.includes('恢复默认'))
    if (!b) return 'no-btn'
    b.click()
    return new Promise((r) => setTimeout(() => r(getComputedStyle(document.querySelectorAll('.set-color')[3]).getPropertyValue('--cc').trim()), 250))
  })()`),
)

// 清理测试写入的偏好
await ev(`localStorage.removeItem('hsstudio.importColors'); localStorage.removeItem('hsstudio.importCodes'); 1`)
await ev(`(() => { const b = [...document.querySelectorAll('.osu-diff-cancel')][0]; b?.click(); return 'closed' })()`)
console.log('CLEANED', await ev(`localStorage.getItem('hsstudio.importColors')`))
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
