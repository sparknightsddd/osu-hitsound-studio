/**
 * 音量条位置校验：右键某一格改音量后，`<v>` 写在哪个 token、条子画在哪个格子。
 *
 * 目的是排查「音量条偏移 1 格」：把鼠标真实点在某格上，走完整的
 * 右键 → 修改音量 → 输入 → 确定 流程，再看文本与条子的归属是否一致。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9681
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
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
await send('Runtime.enable')
await wait(2800)

const chart = [
  '[Metadata]',
  'Title = vbar offset',
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
  '/Aa = [Ab Ac] =/',
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('vbar-offset.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const bodyLines = () => (text().split('[Hitsound]')[1] || '').split('\\n').filter((l) => l.trim() && !l.startsWith('#'))
  const cells = () => [...document.querySelectorAll('.gd-row')][0] ? [...[...document.querySelectorAll('.gd-row')][0].querySelectorAll('.gd-cell')] : []
  const rects = () => cells().map((c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  const barAt = () => cells().map((c, i) => (c.querySelector('.gd-vbar') ? i : -1)).filter((i) => i >= 0)
  const titleAt = () => cells().map((c, i) => ((c.getAttribute('title') || '').includes('音量') ? i : -1)).filter((i) => i >= 0)
  const menuItem = (label) => {
    const it = [...document.querySelectorAll('.edit-menu-item')].find((x) => x.textContent.trim().startsWith(label))
    if (!it) return 'no-item'
    it.click()
    return 'ok'
  }
  const hasMenu = () => !!document.querySelector('.edit-menu')
  const setVol = (v) => {
    const el = document.querySelector('.gd-vol-input')
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  const confirm = () => {
    const b = [...document.querySelectorAll('.gd-vol-dlg .btn')].find((x) => x.textContent.trim() === '确定')
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  return { text, bodyLines, rects, barAt, titleAt, menuItem, hasMenu, setVol, confirm }
})()`

async function rightClick(p) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 })
}

for (const target of [5, 0, 15, 10]) {
  const barsBefore = JSON.parse((await ev(`JSON.stringify(${MOD}.barAt())`)) || '[]')
  // 右键偶尔会被上一轮弹窗的收尾吞掉，重试几次
  let opened = false
  let rects = []
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await wait(250)
    rects = JSON.parse(await ev(`JSON.stringify(${MOD}.rects())`))
    await rightClick(rects[target])
    await wait(500)
    opened = await ev(`${MOD}.hasMenu()`)
  }
  const picked = await ev(`${MOD}.menuItem('修改音量')`)
  await wait(400)
  await ev(`${MOD}.setVol(${40 + target})`)
  await wait(150)
  const ok = await ev(`${MOD}.confirm()`)
  await wait(800)
  const line = (await ev(`${MOD}.bodyLines()`))[0]
  const bars = await ev(`JSON.stringify(${MOD}.barAt())`)
  const titles = await ev(`JSON.stringify(${MOD}.titleAt())`)
  const toks = (line.match(/\/[^/]*\//)?.[0] || '').slice(1, -1).trim().split(/\s+/)
  const rawIdx = toks.findIndex((t) => t === `<v=${40 + target}>`)
  // <v>/<i> 不是格子 token，算格子序号时要把它们去掉
  // 只数「占一格」的 token：[Ab Ac] 是一格（用括号感知的方式切）
  const before = toks.slice(0, rawIdx < 0 ? 0 : rawIdx)
  let tokIdx = 0
  for (let i = 0; i < before.length; i++) {
    const t = before[i]
    if (/^</.test(t)) continue
    if (/^\[/.test(t)) {
      while (i < before.length && !/\]$/.test(before[i])) i++
      tokIdx++
      continue
    }
    tokIdx++
  }
  if (rawIdx < 0) tokIdx = -1
  const barsNow = JSON.parse(bars)
  const added = barsNow.filter((i) => !barsBefore.includes(i))
  console.log(
    `CELL ${target}: menu=${opened} pick=${picked} ok=${ok} tokenIndex=${tokIdx} added=${JSON.stringify(added)} bars=${bars} line=${line}`,
  )
  T(`第 ${target} 格：<v> 落在第 ${target} 个 token`, tokIdx === target)
  T(`第 ${target} 格：新条子正好在这一格`, added.join(',') === String(target), `added=${added.join(',')}`)
  T(`第 ${target} 格：这一格 title 标了音量`, JSON.parse(titles).includes(target))
}

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
