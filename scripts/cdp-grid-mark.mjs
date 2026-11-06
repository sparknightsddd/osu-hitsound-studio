/** 格子里红线（Timing）/ 蓝线（书签）的显示验证。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9471
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
async function waitWs() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const p = (await r.json()).find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl } } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('cdp')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
const send = (method, params = {}) => { const msg = { id: ++id, method, params }; ws.send(JSON.stringify(msg)); return new Promise((r) => pending.set(msg.id, r)) }
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))

await ev(`(() => {
  const hit = 'Aa = = = Ab = = = Aa = = = Ab = = ='
  const text = [
    '[Metadata]','Title = marks','',
    '[Settings]','Bookmarks = 2000, 4000, 5250','',
    '[Files]','path = ""','audio = ""','',
    '[Define]','hitsound custom Aa = default.soft-hitnormal red','hitsound custom Ab = default.soft-hitclap green','',
    '[Timing]','0,bpm(120),4,0,0','4000,bpm(120),4,1,0','',
    '[Hitsound]','#0','/'+hit+'/','/'+hit+'/','/'+hit+'/','/'+hit+'/',''
  ].join('\\n')
  const s = window.__store.getState(); const id = s.addFile('marks.hs', text); s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 1
})()`)
await new Promise((r) => setTimeout(r, 900))

console.log('MARKS', await ev(`(() => {
  const rows = [...document.querySelectorAll('.gd-row')]
  const dump = rows.slice(0, 3).map((r, ri) => {
    const cells = [...r.querySelectorAll('.gd-cell')]
    const hits = []
    cells.forEach((c, i) => {
      const rd = !!c.querySelector('.gd-mark.red')
      const bl = !!c.querySelector('.gd-mark.blue')
      if (rd || bl) hits.push({
        i, red: rd, blue: bl,
        // 几何检查：线必须在格子外面（右侧 <= 格子左边），且落在和前一格的缝隙里
        geom: (() => {
          const cr = c.getBoundingClientRect()
          const prev = cells[i - 1]?.getBoundingClientRect()
          const out = []
          for (const [k, m] of [['r', c.querySelector('.gd-mark.red')], ['b', c.querySelector('.gd-mark.blue')]]) {
            if (!m) continue
            const mr = m.getBoundingClientRect()
            out.push({ k, w: +mr.width.toFixed(2), outside: mr.right <= cr.left + 0.01, gapLeft: prev ? +(mr.left - prev.right).toFixed(2) : null, gapRight: +(cr.left - mr.right).toFixed(2) })
          }
          return out
        })(),
      })
    })
    return { row: ri, label: r.querySelector('.gd-gutter')?.textContent, cells: cells.length, marks: hits }
  })
  return JSON.stringify({ rows: dump, legend: [...document.querySelectorAll('.gd-legend .gd-leg')].map(e => e.textContent.trim()) })
})()`))

console.log('TIP', await ev(`(() => {
  const c = document.querySelectorAll('.gd-row')[1].querySelectorAll('.gd-cell')[0]
  c.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
  return new Promise((res) => setTimeout(() => res(JSON.stringify({
    title: c.getAttribute('title'),
    foot: document.querySelector('.gd-foot')?.textContent,
  })), 300))
})()`))

const s = await Promise.race([send('Page.bringToFront').then(() => send('Page.captureScreenshot', { format: 'png', fromSurface: true })), new Promise((r) => setTimeout(r, 15000))])
if (s?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-grid-marks.png'), Buffer.from(s.result.data, 'base64'))
else console.log('SHOT_FAILED')

// 放大看细节（clip 截图偶发失败，多重试几次）
const shotAt = async (rowIdx, colIdx, name, span = 2, scale = 4) => {
  const raw = await ev(`(() => {
    const r = document.querySelectorAll('.gd-row')[${rowIdx}].querySelectorAll('.gd-cell')[${colIdx}].getBoundingClientRect()
    return JSON.stringify({ x: Math.floor(r.x) - 12, y: Math.floor(r.y) - 5, width: Math.ceil(r.width) * ${span} + 12, height: Math.ceil(r.height) + 10 })
  })()`)
  const rr = JSON.parse(raw)
  for (let k = 0; k < 4; k++) {
    const sh = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...rr, scale } }),
      new Promise((r) => setTimeout(() => r(null), 10000)),
    ])
    if (sh?.result?.data) {
      fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('ZOOM_FAILED', name)
  return false
}
await shotAt(0, 16, 'ui-grid-mark-blue.png')
await shotAt(1, 0, 'ui-grid-mark-both.png')
child.kill()
process.exit(0)
