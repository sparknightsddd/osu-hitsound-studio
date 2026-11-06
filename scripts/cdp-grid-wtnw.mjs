/**
 * 用用户报的那份谱面验证三处格子问题：
 *   1) 01:47.787 那格（小节最后一格）落笔后不再跳回前一格，也能删除；
 *   2) 01:47.884 ~ 01:49.598 之间（原来「中途变过 BPM」）可以写音符；
 *   3) 01:49.598 的 10ms 碎片小节不再被画成一整拍。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9691
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

const FILE = 'E:/osu/Songs/seatrus - Welcome to the New World/seatrus - Welcome to the New World (TNTlealu) [Ultimate].hs'
const chart = fs.readFileSync(FILE, 'utf8')

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
await send('Page.enable')
await wait(2800)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const line = () => {
    const t = text()
    const sec = (t.split('[Hitsound]')[1] || '')
    return sec.split('\\n').filter((l) => l.trim() && !l.startsWith('#')).slice(-3).join(' | ')
  }
  /** 第 71 小节（#107884）那一行的正文 —— 谱面会被用户改，行数会变，不能取「最后三行」 */
  const lineAt = (ms) => {
    const t = text()
    const sec = (t.split('[Hitsound]')[1] || '')
    const lines = sec.split('\\n')
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '#' + ms) { idx = i; break }
    }
    if (idx < 0) return '(no marker #' + ms + ')'
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i].trim()
      if (!l) continue
      if (l.startsWith('#')) return '(no body after #' + ms + ')'
      return l
    }
    return '(empty after #' + ms + ')'
  }
  const cells = () => [...document.querySelectorAll('.gd-cell')]
  const cellByTime = (label) => {
    const c = cells().find((x) => (x.getAttribute('title') || '').startsWith(label))
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: (c.getAttribute('title') || '').split('\\n')[0] }
  }
  const cellsWithTitle = (label) => cells().filter((x) => (x.getAttribute('title') || '').startsWith(label)).length
  const brush = (name) => {
    const b = cells().length ? [...document.querySelectorAll('.gd-brush')].find((x) => x.textContent.trim() === name) : null
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  const countCells = () => cells().length
  const eventsAt = (ms) =>
    JSON.stringify(window.__store.getState().doc.events.filter((e) => Math.abs(e.time - ms) < 3).map((e) => e.names.join('+')))
  return { text, line, lineAt, eventsAt, cellByTime, cellsWithTitle, brush, countCells }
})()`

console.log(
  'LOAD',
  await ev(`(() => {
    const s = window.__store.getState()
    const id = s.addFile('wtnw.hs', ${JSON.stringify(chart)})
    s.setActive(id)
    window.__store.getState().setEditorMode('grid')
    return 'ok'
  })()`),
)
await wait(2200)

console.log('TOTAL_CELLS', await ev(`${MOD}.countCells()`))
console.log('SAMPLE_TITLES', await ev(`JSON.stringify([...document.querySelectorAll('.gd-cell')].slice(0, 3).map((c) => (c.getAttribute('title') || '').split('\\n')[0]))`))
console.log('SCROLLER', await ev(`JSON.stringify((() => { const s = document.querySelector('.gd-scroll'); return { h: s.scrollHeight, top: s.scrollTop, ch: s.clientHeight } })())`))
/* 滚动到目标时间所在行（网格是虚拟滚动的，DOM 里只有可见行） */
async function scrollToLabel(label) {
  const info = JSON.parse(await ev(`JSON.stringify((() => { const s = document.querySelector('.gd-scroll'); return { h: s.scrollHeight, ch: s.clientHeight } })())`))
  for (let top = 0; top < info.h; top += Math.max(200, info.ch * 0.8)) {
    await ev(`(() => { const s = document.querySelector('.gd-scroll'); s.scrollTop = ${top}; s.dispatchEvent(new Event('scroll', { bubbles: true })); return s.scrollTop })()`)
    await wait(90)
    const t = await ev(`JSON.stringify(${MOD}.cellByTime(${JSON.stringify(label)}))`)
    if (t === 'null') continue
    // 目标行可能刚好在可视区外（虚拟滚动仍会渲染一点点缓冲），再微调一次
    const r = JSON.parse(t)
    const box = JSON.parse(await ev(`JSON.stringify((() => { const s = document.querySelector('.gd-scroll'); const b = s.getBoundingClientRect(); return { top: b.top, bottom: b.bottom } })())`))
    if (r.y > box.bottom - 30) {
      await ev(`(() => { const s = document.querySelector('.gd-scroll'); s.scrollTop += ${Math.round(r.y - box.bottom + 60)}; s.dispatchEvent(new Event('scroll', { bubbles: true })); return s.scrollTop })()`)
      await wait(120)
      const t2 = await ev(`JSON.stringify(${MOD}.cellByTime(${JSON.stringify(label)}))`)
      if (t2 !== 'null') return JSON.parse(t2)
    }
    if (r.y < box.top + 30) {
      await ev(`(() => { const s = document.querySelector('.gd-scroll'); s.scrollTop -= ${Math.round(box.top + 60 - r.y)}; s.dispatchEvent(new Event('scroll', { bubbles: true })); return s.scrollTop })()`)
      await wait(120)
      const t2 = await ev(`JSON.stringify(${MOD}.cellByTime(${JSON.stringify(label)}))`)
      if (t2 !== 'null') return JSON.parse(t2)
    }
    return r
  }
  return null
}

/** 敲一个代号（走键盘落笔这条路，不碰画笔按钮） */
async function typeCode(ch) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.charCodeAt(0) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.charCodeAt(0) })
}


async function click(p) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(260)
}

// 1) 点 01:47.778（原 01:47.787）那一格 → 点画笔 D
const c1 = await scrollToLabel('01:47:7')
console.log('SCROLLED_1', JSON.stringify(c1))
await click(c1)
console.log('ELEMENT_AT', await ev(`(() => { const e = document.elementFromPoint(${c1.x}, ${c1.y}); return e ? e.className + ' | ' + (e.getAttribute('title') || '').slice(0, 40) : 'none' })()`))
console.log('SEL_COUNT', await ev(`document.querySelectorAll('.gd-cell.sel').length`))
console.log('SEL_NOW', await ev(`document.querySelectorAll('.gd-cell.sel').length`))
await typeCode('D')
await wait(900)
console.log('LOG1', await ev(`JSON.stringify(window.__store.getState().output.slice(-3))`))
console.log('AFTER_ADD_1', await ev(`${MOD}.lineAt(107884)`))
T(
  '最后一格能落笔',
  String(await ev(`${MOD}.eventsAt(107777)`)).includes('D'),
  await ev(`${MOD}.eventsAt(107777)`),
)

// 2) 01:48 区间（原来完全不能输入）
const c2 = await scrollToLabel('01:48:')
await click(c2)
await typeCode('W')
await wait(900)
console.log('LOG2', await ev(`JSON.stringify(window.__store.getState().output.slice(-4))`))
console.log('AFTER_ADD_2', await ev(`${MOD}.lineAt(107884)`), await ev(`${MOD}.lineAt(108854)`))
T(
  '01:48 区间能输入',
  String(await ev(`${MOD}.eventsAt(108100)`)).includes('W'),
  await ev(`${MOD}.eventsAt(108100)`),
)
console.log(
  'BODY_TAIL',
  await ev(`${MOD}.text().split('[Hitsound]')[1].split('\\n').filter((l) => l.trim()).slice(-4).join(' | ')`),
)

// 3) 删除刚才这两格
const c3 = await scrollToLabel('01:47:7')
await click(c3)
await typeCode('Z')
await wait(900)
console.log('AFTER_DEL', await ev(`${MOD}.lineAt(107884)`))

// 4) 看 01:49.598→01:49.609 那块还有没有碎片小节
const c4 = await scrollToLabel('01:49:5')
console.log('CELL_1495', JSON.stringify(c4))
console.log('CELLS_AT_1496', await ev(`${MOD}.cellsWithTitle('01:49:6')`))
console.log('CELLS_AT_1497', await ev(`${MOD}.cellsWithTitle('01:49:7')`))
console.log('SHOT', await shotEl('.gd-wrap', 'ui-grid-wtnw.png', 1.2, 2))
console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
