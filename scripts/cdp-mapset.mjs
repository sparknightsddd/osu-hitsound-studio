/** 从「谱面库」直接导入一个谱面集，打印日志，看音频有没有正常挂上。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9381
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
const ev = async (expr, awaitPromise = false) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))
try {
  await Promise.race([send('Page.captureScreenshot', { format: 'png' }), new Promise((r) => setTimeout(r, 4000))])
} catch {}

// 打开谱面库
const opened = await ev(`(() => {
  const b = [...document.querySelectorAll('.activity-bar button, .activity button, button')]
    .find((x) => (x.getAttribute('title') || '').includes('谱面库'))
  if (!b) return 'no-button ' + [...document.querySelectorAll('button')].map(x=>x.getAttribute('title')||x.textContent).slice(0,12).join('|')
  b.click()
  return 'ok'
})()`)
console.log('OPEN', opened)
await new Promise((r) => setTimeout(r, 2500))

const list = await ev(`JSON.stringify({
  items: document.querySelectorAll('.ms-item').length,
  first: document.querySelector('.ms-item .ms-title')?.textContent || '',
  folder: document.querySelector('.ms-item .ms-sub')?.textContent || '',
})`)
console.log('LIST', list)

// 点第一个谱面集
const clicked = await ev(`(() => {
  const el = document.querySelector('.ms-item')
  if (!el) return 'none'
  el.click()
  return 'clicked'
})()`)
console.log('CLICK', clicked)
await new Promise((r) => setTimeout(r, 1500))

// 选难度
const diff = await ev(`JSON.stringify({
  rows: document.querySelectorAll('.osu-diff-row').length,
  first: document.querySelector('.osu-diff-row .osu-diff-name')?.textContent || '',
})`)
console.log('DIFF', diff)
const picked = await ev(`(() => {
  const b = [...document.querySelectorAll('.osu-diff-row')].find(x => (x.textContent||'').includes('On the Stage'))
  const el = b || document.querySelector('.osu-diff-row')
  if (!el) return 'no-diff'
  el.click()
  return (el.querySelector('.osu-diff-name')?.textContent || 'picked')
})()`)
console.log('PICK', picked)
await new Promise((r) => setTimeout(r, 2500))
const plan = await ev(`(() => {
  const rows = document.querySelectorAll('.si-row').length
  const ok = document.querySelector('.si-ok')
  if (!ok) return 'no-plan-dialog rows=' + rows
  ok.click()
  return 'plan-ok rows=' + rows
})()`)
console.log('PLAN', plan)
await new Promise((r) => setTimeout(r, 7000))

await ev(`(async () => {
  const s = window.__store.getState()
  const dir = String(s.doc.settings.Path || '').replace(/^["']|["']$/g, '')
  const r = await window.desktop.resolveChartAssets({ chartPath: '', dir, audio: s.doc.settings.Audio || '' })
  window.__assetProbe = { ok: r.ok, n: (r.assets || []).length, song: r.songPath, names: (r.assets || []).slice(0, 6).map(a => a.relPath) }
})()`, true)
const out = await ev(`(() => {
  const s = window.__store.getState()
  return JSON.stringify({
    active: s.files.find(f => f.id === s.activeId)?.name,
    files: s.files.map(f => f.name),
    audioPath: s.doc.audioPath || '',
    filesPath: s.doc.settings.Path || '',
    bindings: Object.keys(s.bindings || {}).length,
    hs: (s.doc.hitsounds || []).map(h => (h.name || '') + '=' + (h.value || '') + (h.defaultRef ? ' (default)' : '')),
    assets: window.__assetProbe || null,
    output: (s.output || []).slice(-14),
  })
})()`)
console.log('OUT', out)

const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), new Promise((r) => setTimeout(r, 5000))])
if (shot?.result?.data) fs.writeFileSync(process.argv[2] || path.join(ROOT, 'ui-mapset-check.png'), Buffer.from(shot.result.data, 'base64'))
child.kill()
process.exit(0)
