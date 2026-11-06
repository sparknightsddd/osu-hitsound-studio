/** 谱面库冒烟：验证第 5 个图标、Songs 探测、MV 排序、current mapset。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9371
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

console.log('API', await ev(`JSON.stringify(Object.keys(window.desktop||{}).filter(k=>k.startsWith('osu')))`))

const detected = await ev(
  `(async () => JSON.stringify(await window.desktop.osuDetectSongsFolder()))()`,
  true,
)
console.log('DETECT', detected)

const page = await ev(
  `(async () => JSON.stringify(await window.desktop.osuListMapsets({ limit: 6 })))()`,
  true,
)
const p1 = JSON.parse(page || '{}')
console.log('LIST', JSON.stringify({
  ok: p1.ok, songsFolder: p1.songsFolder, total: p1.total, count: p1.mapsets?.length, hasMore: p1.hasMore, error: p1.error,
}))
console.log('TOP6', JSON.stringify((p1.mapsets || []).map((m) => ({
  f: m.folder, t: m.title, a: m.artist, d: m.diffCount, ago: Math.round((Date.now() - m.mtimeMs) / 60000),
}))))

const cur = await ev(
  `(async () => JSON.stringify(await window.desktop.osuCurrentMapset({})))()`,
  true,
)
console.log('CURRENT', cur)

// 点左栏第 5 个图标（索引 1）
await ev(`document.querySelectorAll('.activitybar button')[1].click(); 1`)
await new Promise((r) => setTimeout(r, 4000))
const ui = await ev(`JSON.stringify({
  title: document.querySelector('.sidebar-title')?.textContent,
  items: document.querySelectorAll('.ms-item').length,
  first: document.querySelector('.ms-item .ms-title')?.textContent,
  head: document.querySelector('.ms-list-head')?.textContent,
  current: document.querySelector('.ms-current')?.textContent,
  path: document.querySelector('.ms-path-text')?.textContent,
  msg: document.querySelector('.ms-msg')?.textContent || '',
})`)
console.log('UI', ui)

const shot = await send('Page.captureScreenshot', { format: 'png' })
const out = process.argv[2] || path.join(ROOT, 'ui-mapsets.png')
if (shot.result?.data) fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log('SHOT', out)

// 点第一行 -> 应直接进入导入流程（弹出音效代号对话框）
const before = await ev(`window.__store.getState().files.length`)
await ev(`document.querySelector('.ms-item').click(); 1`)
await new Promise((r) => setTimeout(r, 6000))
console.log('IMPORT', await ev(`JSON.stringify({
  dialog: !!document.querySelector('.si-dialog'),
  dialogHead: document.querySelector('.osu-diff-head')?.textContent?.slice(0, 60),
  difficultyDialog: !!document.querySelector('.osu-diff:not(.si-dialog):not(.set-dialog)'),
  filesBefore: ${before},
  filesAfter: window.__store.getState().files.length,
  log: window.__store.getState().output.slice(-3),
})`))
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
if (shot2.result?.data) fs.writeFileSync(String(out).replace(/\.png$/, '-import.png'), Buffer.from(shot2.result.data, 'base64'))
child.kill()
process.exit(0)
