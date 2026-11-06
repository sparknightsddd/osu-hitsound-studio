/** 格子视图：排版规则 / 边框配色 / 点击定位 的端到端验证。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9431
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
  throw new Error('CDP 未就绪')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
ws.onmessage = (msg) => {
  const m = JSON.parse(msg.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) => {
  const m = { id: ++id, method, params }
  ws.send(JSON.stringify(m))
  return new Promise((res) => pending.set(m.id, res))
}
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const shot = async (file, extra = {}) => {
  for (let i = 0; i < 3; i++) {
    const s = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: i % 2 === 0, ...extra }),
      new Promise((r) => setTimeout(() => r(null), 15000)),
    ])
    if (s?.result?.data) {
      fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'))
      return true
    }
    console.log('SHOT_RETRY', i)
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))

// 4 小节 4/4 + 1 小节 11/4（每小节都写成 16 / 44 个 token，正好一格一个 1/16）
const body = await ev(`(() => {
  const hit = (n) => Array.from({ length: n }, (_, i) => (i % 4 === 0 ? (i % 8 === 0 ? 'Aa' : 'Ab') : '=')).join(' ')
  const text = [
    '[Metadata]',
    'Title = grid test',
    '',
    '[Files]',
    'path = ""',
    'audio = ""',
    '',
    '[Define]',
    'hitsound custom Aa = default.soft-hitnormal red',
    'hitsound custom Ab = default.soft-hitclap green',
    '',
    '[Timing]',
    '0,bpm(120),4,0,0',
    '8000,bpm(120),11,1,0',
    '',
    '[Hitsound]',
    '#0',
    '/' + hit(16) + '/',
    '/' + hit(16) + '/',
    '/' + hit(16) + '/',
    '/' + hit(16) + '/',
    '/' + hit(44) + '/',
    '',
  ].join('\\n')
  const s = window.__store.getState()
  const id = s.addFile('grid.hs', text)
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return JSON.stringify({
    measures: window.__store.getState().doc.measures.map(m => ({ n: m.index + 1, meter: m.meter, start: Math.round(m.start), end: Math.round(m.end) })),
    events: window.__store.getState().doc.events.length,
    diags: window.__store.getState().doc.diagnostics.filter(d => d.severity === 'error').map(d => d.message),
  })
})()`)
console.log('SETUP', body)
await new Promise((r) => setTimeout(r, 900))

console.log(
  'ROWS',
  await ev(`JSON.stringify({
  rows: [...document.querySelectorAll('.gd-row')].map(r => ({
    gutter: r.querySelector('.gd-gutter')?.textContent,
    cells: r.querySelectorAll('.gd-cell').length,
  })),
  perRow: document.querySelector('.gd-toolbar .mono:last-child')?.textContent,
})`),
)

console.log(
  'CELLS',
  await ev(`(() => {
  const row0 = document.querySelectorAll('.gd-row')[0]
  const cs = [...row0.querySelectorAll('.gd-cell')]
  const pick = (i) => {
    const c = cs[i]
    const st = getComputedStyle(c)
    return { i, border: st.borderColor, w: st.borderTopWidth, bg: st.backgroundColor, text: c.textContent }
  }
  return JSON.stringify({ filled: document.querySelectorAll('.gd-cell.filled').length, samples: [pick(0), pick(1), pick(2), pick(4), pick(5)] })
})()`),
)

// 点第 3 行第 5 格，看看是否定位 + 底部信息
console.log(
  'CLICK',
  await ev(`(() => {
  const row = document.querySelectorAll('.gd-row')[2]
  const cell = row.querySelectorAll('.gd-cell')[5]
  cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return new Promise((res) => setTimeout(() => res(JSON.stringify({
    foot: document.querySelector('.gd-foot')?.textContent,
    sel: document.querySelectorAll('.gd-cell.sel').length,
  })), 200))
})()`),
)

await shot(path.join(ROOT, 'ui-grid.png'))

// 换细分 3（每小节 12 格）验证排版随之变化
console.log('DIV3', await ev(`(() => {
  window.__store.getState().setDiv(3)
  return new Promise((res) => setTimeout(() => res(JSON.stringify({
    rows: [...document.querySelectorAll('.gd-row')].slice(0, 4).map(r => ({ g: r.querySelector('.gd-gutter')?.textContent, n: r.querySelectorAll('.gd-cell').length })),
    info: document.querySelector('.gd-toolbar .mono:last-child')?.textContent,
  })), 400))
})()`))
await shot(path.join(ROOT, 'ui-grid-div3.png'))

// 真实大谱（161 个小节标记）的渲染耗时
console.log('BIG', await ev(`(async () => {
  window.__store.getState().setDiv(4)
  await new Promise(r => setTimeout(r, 300))
  const r = await window.desktop.readText('E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)/__test_out.hs')
  if (!r.ok) return 'read-failed'
  const t0 = performance.now()
  const s = window.__store.getState()
  const id = s.addFile('starlight.hs', r.text)
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
  const t1 = performance.now()
  const st2 = window.__store.getState()
  return JSON.stringify({
    ms: Math.round(t1 - t0),
    measures: st2.doc.measures.length,
    events: st2.doc.events.length,
    rowsRendered: document.querySelectorAll('.gd-row').length,
    cellsRendered: document.querySelectorAll('.gd-cell').length,
    info: document.querySelector('.gd-toolbar .mono:last-child')?.textContent,
  })
})()`))
await new Promise((r) => setTimeout(r, 600))
await shot(path.join(ROOT, 'ui-grid-real.png'))

// 回到时间轴，确认抽出配色模块后时间轴照常挂载
console.log('TIMELINE', await ev(`(() => {
  const st = window.__store.getState()
  st.setEditorMode('text')
  if (!st.panelOpen) st.togglePanel()
  return new Promise((res) => setTimeout(() => res(JSON.stringify({
    canvases: document.querySelectorAll('.timeline-wrap canvas').length,
    toolbar: !!document.querySelector('.tl-toolbar'),
    legend: document.querySelectorAll('.tl-toolbar select').length,
  })), 900))
})()`))
child.kill()
process.exit(0)
