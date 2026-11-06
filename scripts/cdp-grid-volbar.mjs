/** 格子音量显示三态：显示数字 / 显示音量条 / 不显示（间距与音量条配色）。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9611
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
async function shotEl(sel, name, scale = 3, pad = 4) {
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
/** 只截左边一段，放大看缝隙里的线 */
async function shotLeft(name, width = 320, scale = 8) {
  const box = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector('.gd-row').getBoundingClientRect()
      return JSON.stringify({ x: Math.max(0, Math.floor(r.x)), y: Math.floor(r.y) - 2, width: ${width}, height: Math.ceil(r.height) + 4 })
    })()`),
  )
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

const MOD = `(() => {
  const bars = () => [...document.querySelectorAll('.gd-vbar')].map((b) => {
    const cell = b.parentElement
    const r = b.getBoundingClientRect()
    const cr = cell.getBoundingClientRect()
    const cs = getComputedStyle(b)
    return {
      vol: (cell.getAttribute('title') || '').match(/音量 (\\d+)/)?.[1] || '',
      w: +r.width.toFixed(2),
      h: +r.height.toFixed(2),
      // 条子右边缘到格子左边缘的距离（负数 = 压在格子上）
      toCell: +(cr.left - r.right).toFixed(2),
      bg: cs.backgroundImage,
    }
  })
  const nums = () => [...document.querySelectorAll('.gd-vol')].map((e) => e.textContent)
  const gapPx = () => {
    const c = document.querySelector('.gd-cells')
    return c ? getComputedStyle(c).gap : ''
  }
  return { bars, nums, gapPx }
})()`

console.log(
  'LOAD',
  await ev(`(() => {
    localStorage.removeItem('hsstudio.display')
    const lines = ['[Metadata]','Title = vbar','','[Files]','path = ""','audio = ""','',
      '[Define]','hitsound soft-hitclap Aa = default.soft-hitclap','',
      '[Timing]','0,bpm(120),4,0,0','',
      '[Hitsound]','#0','/<v=58> Aa = = =/','#2000','/Aa = = =/','#4000','/<v=30> = = = Aa/','#6000','/<v=0> = = = Aa/','#8000','/<v=100> Aa = =/', '']
    const s = window.__store.getState()
    const id = s.addFile('vbar.hs', lines.join('\\n'))
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    return 'ok'
  })()`),
)
await wait(1500)

console.log('MODE0', await ev(`localStorage.getItem('hsstudio.display')`))
console.log('BAR_MODE', await ev(`JSON.stringify({ gap: ${MOD}.gapPx(), nums: ${MOD}.nums().length, bars: ${MOD}.bars() })`))
console.log(
  'BARBOX',
  await ev(`JSON.stringify((() => {
    const b = document.querySelector('.gd-vbar')
    const c = b.parentElement
    const br = b.getBoundingClientRect()
    const cr = c.getBoundingClientRect()
    return {
      cell: { w: +cr.width.toFixed(1), h: +cr.height.toFixed(1) },
      bar: { w: br.width, h: br.height },
      dyTop: +(br.top - cr.top).toFixed(1),
      dyBot: +(cr.bottom - br.bottom).toFixed(1),
    }
  })())`),
)
await shotEl('.gd-row', 'ui-grid-vbar.png', 3, 6)
console.log('ZOOM', await shotLeft('ui-grid-vbar-zoom.png', 120, 16))

// 切到「显示数字」
async function openTimingTab() {
  console.log('OPEN', await ev(`(() => { window.__openAppSettings(); return 'ok' })()`))
  await wait(600)
  console.log(
    'TAB',
    await ev(`(() => {
      const b = [...document.querySelectorAll('.set-tab')].find((x) => x.textContent.trim() === 'Timing')
      if (!b) return 'no-tab'
      b.click()
      return 'ok'
    })()`),
  )
  await wait(350)
}
async function pickMode(label) {
  console.log(
    'PICK',
    label,
    await ev(`(() => {
      const b = [...document.querySelectorAll('.set-seg button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return 'no-btn'
      b.click()
      return document.querySelector('.set-seg button.on')?.textContent.trim() || '?'
    })()`),
  )
  await wait(200)
  console.log('SAVE', await ev(`(() => { document.querySelector('.si-ok')?.click(); return 'ok' })()`))
  await wait(700)
}

await openTimingTab()
console.log('SEGS', await ev(`JSON.stringify([...document.querySelectorAll('.set-seg button')].map((b) => b.textContent.trim()))`))
console.log('SEG_ACTIVE', await ev(`document.querySelector('.set-seg button.on')?.textContent.trim()`))
await shotEl('.set-body', 'ui-settings-volmode.png', 2, 6)
await pickMode('显示数字')
console.log('NUMBER_MODE', await ev(`JSON.stringify({ gap: ${MOD}.gapPx(), nums: ${MOD}.nums(), bars: ${MOD}.bars().length })`))
await shotEl('.gd-row', 'ui-grid-volnum.png', 3, 6)

await openTimingTab()
await pickMode('不显示')
console.log('NONE_MODE', await ev(`JSON.stringify({ gap: ${MOD}.gapPx(), nums: ${MOD}.nums().length, bars: ${MOD}.bars().length })`))

await openTimingTab()
await pickMode('显示音量条')
console.log('BACK_BAR', await ev(`JSON.stringify({ gap: ${MOD}.gapPx(), bars: ${MOD}.bars().length })`))
console.log('STORED', await ev(`localStorage.getItem('hsstudio.display')`))

// 深色模式下音量条的对比度
await ev(`document.documentElement.dataset.theme = 'dark'; 1`)
await wait(400)
console.log('DARK', await ev(`getComputedStyle(document.querySelector('.gd-vbar')).backgroundImage`))
console.log('ZOOM_DARK', await shotLeft('ui-grid-vbar-zoom.png', 120, 16))

// 浅色模式下音量条的对比度（只改根节点变量，够看颜色）
await ev(`document.documentElement.dataset.theme = 'light'; 1`)
await wait(400)
console.log(
  'LIGHT',
  await ev(`JSON.stringify({
    bar: getComputedStyle(document.querySelector('.gd-vbar')).backgroundImage,
    bg: getComputedStyle(document.body).backgroundColor,
  })`),
)
console.log('ZOOM_LIGHT', await shotLeft('ui-grid-vbar-light.png', 120, 16))
await ev(`document.documentElement.dataset.theme = 'dark'; 1`)

// 收尾：清掉测试写入的偏好
await ev(`localStorage.removeItem('hsstudio.display'); 1`)
console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
process.exit(0)
