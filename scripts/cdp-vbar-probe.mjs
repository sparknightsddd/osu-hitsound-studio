/** 临时探针：查清音量条到底画在哪一格、和所属格子的几何关系 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9671
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
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
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
async function shotEl(sel, name, scale = 3, pad = 6) {
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
  'Title = vbar probe',
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
  '/Aa = <v=40> [Ab Ac] =/',
  '#2000',
  '/<v=70> Aa = = =/',
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('vbar-probe.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

console.log(
  'CELLS',
  await ev(`JSON.stringify((() => {
    const rows = [...document.querySelectorAll('.gd-row')]
    return rows.slice(0, 2).map((row) => [...row.querySelectorAll('.gd-cell')].map((c, i) => {
      const r = c.getBoundingClientRect()
      return {
        i,
        x: +r.x.toFixed(1),
        w: +r.width.toFixed(1),
        title: (c.getAttribute('title') || '').split('\\n').filter((s) => s.startsWith('音量')).join(''),
        bar: !!c.querySelector('.gd-vbar'),
        txt: (c.textContent || '').trim(),
      }
    }))
  })())`),
)
console.log(
  'BARS',
  await ev(`JSON.stringify([...document.querySelectorAll('.gd-vbar')].map((b) => {
    const r = b.getBoundingClientRect()
    const c = b.parentElement
    const cr = c.getBoundingClientRect()
    const cs = getComputedStyle(c)
    return {
      barX: +r.x.toFixed(1), barW: +r.width.toFixed(1),
      cellX: +cr.x.toFixed(1), cellW: +cr.width.toFixed(1),
      gapLeft: +(cr.x - r.right).toFixed(1),
      border: cs.borderLeftWidth,
      vol: b.style.background.match(/var\\(--vbar-on\\) 0 (\\d+)%/)?.[1] || '',
      cellIndex: [...c.parentElement.querySelectorAll('.gd-cell')].indexOf(c),
      text: (c.textContent || '').trim(),
    }
  }))`),
)
console.log('SHOT_ROW', await shotEl('.gd-row', 'ui-vbar-gap-row.png', 3, 6))
console.log('SHOT_CELL', await shotEl('.gd-cell:nth-child(9)', 'ui-vbar-gap-cell.png', 8, 6))
await ev(`document.documentElement.dataset.theme = 'dark'; 1`)
await wait(400)
console.log('SHOT_DARK', await shotEl('.gd-row', 'ui-vbar-gap-dark.png', 3, 6))
console.log('SHOT_DARK_CELL', await shotEl('.gd-cell:nth-child(9)', 'ui-vbar-gap-dark-cell.png', 8, 6))
console.log('SHOT_ROW', await shotEl('.gd-row', 'ui-vbar-gap-row.png', 3, 6))
console.log('SHOT_CELL', await shotEl('.gd-cell:nth-child(9)', 'ui-vbar-gap-cell.png', 8, 6))
await ev(`document.documentElement.dataset.theme = 'dark'; 1`)
await wait(400)
console.log('SHOT_DARK', await shotEl('.gd-row', 'ui-vbar-gap-dark.png', 3, 6))
console.log('SHOT_DARK_CELL', await shotEl('.gd-cell:nth-child(9)', 'ui-vbar-gap-dark-cell.png', 8, 6))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
