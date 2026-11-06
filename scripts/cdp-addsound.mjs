/** 「添加到 [Define]」弹窗：网格排版 + 颜色输入 的端到端验证。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9421
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const shot = async (file, extra = {}) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: true, ...extra }),
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ])
    if (s?.result?.data) {
      fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'))
      return true
    }
    console.log('SHOT_RETRY', attempt, JSON.stringify(s ?? 'timeout').slice(0, 120))
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))

console.log(
  'SETUP',
  await ev(`(async () => {
  await window.desktop.setPrefs({ soundFolder: 'E:/osu/Songs/1572565 Momo Asakura - Pinky Hook' })
  const s = window.__store.getState()
  const id = s.addFile('addsound.hs', '[Metadata]\\nTitle = addsound\\n\\n[Files]\\npath = ""\\naudio = ""\\n\\n[Timing]\\n0,bpm(120),4,0,0\\n\\n[Hitsound]\\n/\\n')
  s.setActive(id)
  window.__store.getState().setSidebar('sounds')
  return 'ok'
})()`),
)
await new Promise((r) => setTimeout(r, 2500))

await ev(`(() => { const b = document.querySelector('.sl-item .sl-btn.add'); b && b.click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 600))

// 1) 网格：12 个格子排成 3 行 × 4 列
console.log(
  'GRID',
  await ev(`(() => {
  const cells = [...document.querySelectorAll('.as-cell')]
  const rects = cells.map(c => { const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) } })
  const rows = [...new Set(rects.map(r => r.y))].sort((a,b)=>a-b)
  const cols = [...new Set(rects.map(r => r.x))].sort((a,b)=>a-b)
  return JSON.stringify({
    cells: cells.length,
    rows: rows.length,
    cols: cols.length,
    rowLabels: [...document.querySelectorAll('.as-row')].map(e => e.textContent),
    colLabels: [...document.querySelectorAll('.as-col')].map(e => e.textContent),
    cellText: cells.map(c => c.textContent.trim()).join('|'),
    placeholder: document.querySelector('.as-name input')?.placeholder,
    footHint: document.querySelector('.osu-diff-hint')?.textContent,
    okDisabled: document.querySelector('.si-ok')?.disabled,
    hasSwatch: !!document.querySelector('.as-swatch'),
    labelX: [...document.querySelectorAll('.as-name label')].map(e => Math.round(e.getBoundingClientRect().x)),
    inputX: [...document.querySelectorAll('.as-name input.si-code-input')].map(e => Math.round(e.getBoundingClientRect().x)),
    inputW: [...document.querySelectorAll('.as-name input.si-code-input')].map(e => Math.round(e.getBoundingClientRect().width)),
  })
})()`),
)
console.log('HINT', await ev(`(() => {
  const h = document.querySelector('.as-color-hint')
  const d = document.querySelector('.as-dialog')
  const hs = h ? { sw: h.scrollWidth, cw: h.clientWidth, right: Math.round(h.getBoundingClientRect().right), text: h.textContent } : null
  return JSON.stringify({ hint: hs, dialogRight: d ? Math.round(d.getBoundingClientRect().right) : null, dialogW: d ? Math.round(d.getBoundingClientRect().width) : null })
})()`))
await shot(path.join(ROOT, 'ui-addsound-empty.png'))

// 2) 勾两个格子 + 填代号 + 填颜色（分步做，避免一次 evaluate 里套 Promise 被截断）
await ev(`(() => {
  const c = [...document.querySelectorAll('.as-cell')]
  c[3].querySelector('input').click()
  c[11].querySelector('input').click()
  return 1
})()`)
await new Promise((r) => setTimeout(r, 250))
await ev(`(() => {
  const [n, c] = [...document.querySelectorAll('.as-name input')]
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(n, 'k1!K'); n.dispatchEvent(new Event('input', { bubbles: true }))
  set.call(c, 'red'); c.dispatchEvent(new Event('input', { bubbles: true }))
  c.focus(); c.blur()
  return 1
})()`)
await new Promise((r) => setTimeout(r, 350))
console.log(
  'FILL',
  await ev(`JSON.stringify({
  on: [...document.querySelectorAll('.as-cell.on')].length,
  name: document.querySelectorAll('.as-name input')[0]?.value,
  color: document.querySelectorAll('.as-name input')[1]?.value,
  swatch: document.querySelector('.as-swatch')?.value,
  preview: document.querySelector('.as-preview')?.textContent,
  hint: document.querySelector('.osu-diff-hint')?.textContent,
  okDisabled: document.querySelector('.si-ok')?.disabled,
})`),
)
await shot(path.join(ROOT, 'ui-addsound-filled.png'))
// 2 倍放大截弹窗本体，方便看细节
{
  const raw = await ev(`(() => { const r = document.querySelector('.as-dialog').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }) })()`)
  const rr = JSON.parse(raw)
  const s2 = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...rr, scale: 2 } })
  if (s2?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-addsound-zoom.png'), Buffer.from(s2.result.data, 'base64'))
  else console.log('ZOOM_FAILED')
}

// 3) 确认写入
await ev(`(() => { document.querySelector('.si-ok')?.click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 1200))
console.log(
  'RESULT',
  await ev(`(() => {
  const s = window.__store.getState()
  const f = s.files.find(x => x.id === s.activeId)
  return JSON.stringify({
    lines: (f?.content || '').split('\\n').filter(l => l.trim().startsWith('hitsound')),
    hs: (s.doc.hitsounds || []).map(h => ({ name: h.name, color: h.color || '-' })),
  })
})()`),
)

// 4) 清空颜色 → 预览里不该有颜色段
await ev(`(() => { document.querySelectorAll('.sl-item .sl-btn.add')[1]?.click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 500))
console.log(
  'NOCLR',
  await ev(`(() => {
  const [nameInp] = [...document.querySelectorAll('.as-name input')]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(nameInp, 'Kk'); nameInp.dispatchEvent(new Event('input', { bubbles: true }))
  return new Promise((res) => setTimeout(() => res(JSON.stringify({
    preview: document.querySelector('.as-preview')?.textContent,
    hint: document.querySelector('.osu-diff-hint')?.textContent,
    okDisabled: document.querySelector('.si-ok')?.disabled,
    emptyFoot: document.querySelector('.as-color-clear') ? 'has-clear-btn' : 'no-clear-btn',
  })), 150))
})()`),
)

child.kill()
process.exit(0)
