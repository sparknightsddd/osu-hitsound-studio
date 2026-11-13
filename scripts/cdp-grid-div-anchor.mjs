/**
 * 改「细分」时保持视图锚点：
 *   - 有选区：选区第一格所在行停在原来的屏幕位置，且选中的音（时间）不变；
 *   - 没选区：视口中线所在行停在原来的位置。
 * 和调格大小共用一套 cellAnchor / pendingSel 逻辑，这里用真实 Electron 验证。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9521
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: USERDATA }
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
async function waitFor(expr, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true
    await wait(150)
  }
  return false
}
let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const LINES = [
  '[Metadata]',
  'Title = Div Anchor',
  'Artist = Tester',
  '',
  '[Files]',
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitclap A = default.soft-hitclap',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/A = = =/',
]
for (let i = 1; i < 40; i++) LINES.push(`#${i * 2000}`, '/A = = =/')
const CHART = LINES.join('\n')

await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

await ev(`(() => {
  window.__i18n.setLang('zh-CN')
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('div-anchor.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setEditorMode('grid')
  s.setDiv(4)
  return 'ok'
})()`)
await wait(1200)
T('网格已铺开', (await ev(`document.querySelectorAll('.gd-scroll .gd-cell').length`)) > 40)

// 用真实的时间轴「细分」输入框改，而不是只调 store：这才是用户实际走的路径
const setDivViaUi = (v) =>
  ev(`(() => {
    const lab = [...document.querySelectorAll('.tl-toolbar label')].find((l) => /细分|Subdivision/.test(l.textContent))
    const inp = lab?.querySelector('input[type=number]')
    if (!inp) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(inp, String(${v}))
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return inp.value
  })()`)
await ev(`window.__store.setState({ panel: 'timeline', panelOpen: true })`)
await wait(600)
T('时间轴面板里有细分输入框', (await ev(`(() => {
  const lab = [...document.querySelectorAll('.tl-toolbar label')].find((l) => /细分|Subdivision/.test(l.textContent))
  return !!lab?.querySelector('input[type=number]')
})()`)) === true)

// 定位滚动容器和中心点
const box = () =>
  ev(`(() => {
    const el = document.querySelector('.gd-scroll')
    if (!el) return 'null'
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, top: el.scrollTop })
  })()`).then((s) => (s === 'null' ? null : JSON.parse(s)))

const clickAt = async (x, y, modifiers = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers })
  await wait(350)
}

const scrollTo = async (top) => {
  await ev(`(() => { const el = document.querySelector('.gd-scroll'); el.scrollTop = ${top}; el.dispatchEvent(new Event('scroll')); return el.scrollTop })()`)
  await wait(350)
}

// ---- 1) 有选区：选中的格子停在原来的屏幕位置 ----
let b = await box()
await scrollTo(700)
b = await box()

// 点视口中间那一格
await clickAt(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2))
const selBefore = JSON.parse(
  await ev(`(() => {
    const c = document.querySelector('.gd-scroll .gd-cell.sel')
    if (!c) return 'null'
    const r = c.getBoundingClientRect()
    return JSON.stringify({ y: r.y, top: Math.round(r.top), title: c.getAttribute('title') || '', label: (c.querySelector('.gd-label') || {}).textContent || '', scroll: document.querySelector('.gd-scroll').scrollTop })
  })()`),
)
T('点到了格子（有 sel）', !!selBefore, JSON.stringify(selBefore))
const timeBefore = (selBefore?.title || '').split(' · ')[0]
const labelBefore = (selBefore?.label || '').trim()

const divInput = await setDivViaUi(8)
T('细分输入框改到 8', divInput === '8', String(divInput))
await wait(700)
const selAfter = JSON.parse(
  await ev(`(() => {
    const c = document.querySelector('.gd-scroll .gd-cell.sel')
    if (!c) return 'null'
    const r = c.getBoundingClientRect()
    return JSON.stringify({ y: r.y, title: c.getAttribute('title') || '', label: (c.querySelector('.gd-label') || {}).textContent || '', scroll: document.querySelector('.gd-scroll').scrollTop, cells: document.querySelector('.gd-row')?.querySelectorAll('.gd-cell').length })
  })()`),
)
const timeAfter = (selAfter?.title || '').split(' · ')[0]
console.log('SEL', JSON.stringify({ before: { y: selBefore?.y, time: timeBefore, scroll: selBefore?.scroll }, after: { y: selAfter?.y, time: timeAfter, scroll: selAfter?.scroll, cells: selAfter?.cells } }))
T('细分改到 8 后每行格子变多', (selAfter?.cells || 0) > 16, String(selAfter?.cells))
T('选中的还是同一个时间点', timeAfter === timeBefore, `${timeBefore} -> ${timeAfter}`)
T('选中的还是原来那个音（格子内容没变）', (selAfter?.label || '').trim() === labelBefore, `${labelBefore} -> ${(selAfter?.label || '').trim()}`)
T('选中格子的屏幕 Y 没动（±2px）', Math.abs((selAfter?.y ?? 0) - (selBefore?.y ?? 0)) <= 2, `${selBefore?.y} -> ${selAfter?.y}`)
T('scrollTop 确实调整过', Math.abs((selAfter?.scroll ?? 0) - (selBefore?.scroll ?? 0)) > 0.5, `${selBefore?.scroll} -> ${selAfter?.scroll}`)

// 再改回去：光标仍然钉在同一个音上
await setDivViaUi(4)
await wait(700)
const selBack = JSON.parse(
  await ev(`(() => {
    const c = document.querySelector('.gd-scroll .gd-cell.sel')
    if (!c) return 'null'
    const r = c.getBoundingClientRect()
    return JSON.stringify({ y: r.y, title: c.getAttribute('title') || '', label: (c.querySelector('.gd-label') || {}).textContent || '' })
  })()`),
)
T('改回 4 后还是同一个时间点', (selBack?.title || '').split(' · ')[0] === timeBefore, `${timeBefore} -> ${(selBack?.title || '').split(' · ')[0]}`)
T('改回 4 后还是原来那个音', (selBack?.label || '').trim() === labelBefore, `${labelBefore} -> ${(selBack?.label || '').trim()}`)

// ---- 1b) 选中的是 1/8 的格子，切成 1/3（这个时间点在新网格里不存在）：光标不能丢 ----
await setDivViaUi(8)
await wait(600)
const eighth = await ev(`(() => {
  const c = [...document.querySelectorAll('.gd-scroll .gd-cell')].find((x) => (x.getAttribute('title') || '').includes('+1/8'))
  if (!c) return 'null'
  const r = c.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: c.getAttribute('title') })
})()`)
if (eighth === 'null') {
  T('找到 1/8 的格子（+1/8）', false, 'not visible')
} else {
  const q = JSON.parse(eighth)
  await clickAt(q.x, q.y)
  await setDivViaUi(3)
  await wait(700)
  const snap = await ev(`(() => {
    const c = document.querySelector('.gd-scroll .gd-cell.sel')
    if (!c) return 'null'
    return JSON.stringify({ title: c.getAttribute('title') || '', label: (c.querySelector('.gd-label') || {}).textContent || '' })
  })()`)
  T('1/8 → 1/3 后光标没丢', snap !== 'null', String(snap))
  if (snap !== 'null') {
    const sp = JSON.parse(snap)
    T('落到包含它的 1/3 格（拍首）', (sp.title || '').startsWith('01:02:000') && !(sp.title || '').includes('+'), sp.title)
  }
}

// ---- 1c) Ctrl 多选：改细分后每个选中格仍对应同一个时间点 ----
await setDivViaUi(4)
await wait(500)
const multi = JSON.parse(
  await ev(`(() => {
    const el = document.querySelector('.gd-scroll')
    const r = el.getBoundingClientRect()
    const mid = r.y + r.height / 2
    let row = null
    let best = 1e9
    for (const rr of el.querySelectorAll('.gd-row')) {
      const b = rr.getBoundingClientRect()
      if (!b.height) continue
      const d = Math.abs(b.y + b.height / 2 - mid)
      if (d < best) { best = d; row = rr }
    }
    const cells = row ? row.querySelectorAll('.gd-cell') : []
    const pick = (i) => { const b = cells[i].getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } }
    return JSON.stringify({ a: pick(0), b: pick(8) })
  })()`),
)
await clickAt(multi.a.x, multi.a.y)
await clickAt(multi.b.x, multi.b.y, 2)
const multiTimes = () =>
  ev(`JSON.stringify([...document.querySelectorAll('.gd-scroll .gd-cell.sel, .gd-scroll .gd-cell.insel')].map((c) => (c.getAttribute('title') || '').split(' · ')[0]))`)
const mt0 = JSON.parse(await multiTimes())
T('Ctrl 多选到两个格子', mt0.length === 2, JSON.stringify(mt0))
await setDivViaUi(8)
await wait(700)
const mt1 = JSON.parse(await multiTimes())
T(
  '改细分后多选仍是同一组时间',
  JSON.stringify([...mt1].sort()) === JSON.stringify([...mt0].sort()),
  `${JSON.stringify(mt0)} -> ${JSON.stringify(mt1)}`,
)

// ---- 2) 没选区：视口中线那一行停在原来的位置 ----
await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('div-anchor-clean.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  return 'ok'
})()`)
await wait(900)
await scrollTo(700)
const centerCell = () =>
  ev(`(() => {
    const el = document.querySelector('.gd-scroll')
    const r = el.getBoundingClientRect()
    const mid = r.y + r.height / 2
    let best = null, bestD = 1e9
    for (const c of el.querySelectorAll('.gd-cell')) {
      const cr = c.getBoundingClientRect()
      if (!cr.height) continue
      const d = Math.abs(cr.y + cr.height / 2 - mid)
      if (d < bestD) { bestD = d; best = c }
    }
    if (!best) return 'null'
    const br = best.getBoundingClientRect()
    return JSON.stringify({ y: br.y, title: best.getAttribute('title') || '', scroll: el.scrollTop })
  })()`)
const cBefore = JSON.parse(await centerCell())
const cTime = (cBefore?.title || '').split(' · ')[0]
const hasSel = await ev(`!!document.querySelector('.gd-scroll .gd-cell.sel')`)
T('新谱面没有选区', hasSel === false, String(hasSel))

await ev(`window.__store.getState().setDiv(8)`)
await wait(700)
const cAfter = JSON.parse(
  await ev(`(() => {
    const el = document.querySelector('.gd-scroll')
    const key = ${JSON.stringify(cTime)}
    for (const c of el.querySelectorAll('.gd-cell')) {
      const title = c.getAttribute('title') || ''
      if (title.split(' · ')[0] !== key) continue
      const r = c.getBoundingClientRect()
      return JSON.stringify({ y: r.y, title, scroll: el.scrollTop })
    }
    return 'null'
  })()`),
)
console.log('CENTER', JSON.stringify({ before: cBefore, after: cAfter }))
T('没选区时中线那一行还是同一个时间点', (cAfter?.title || '').split(' · ')[0] === cTime, `${cTime} -> ${(cAfter?.title || '').split(' · ')[0]}`)
T('中线那一行的屏幕 Y 没动（±3px）', Math.abs((cAfter?.y ?? 0) - (cBefore?.y ?? 0)) <= 3, `${cBefore?.y} -> ${cAfter?.y}`)

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
