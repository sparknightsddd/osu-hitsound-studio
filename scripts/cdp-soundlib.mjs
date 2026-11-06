/** 音效库：列表 / 试听 / 添加到 [Define] 的端到端验证。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9407
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
const shot = async (file) => {
  const s = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), new Promise((r) => setTimeout(r, 6000))])
  if (s?.result?.data) fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'))
}

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))

// 先指定音效目录，再切到音效库
const setup = await ev(`(async () => {
  await window.desktop.setPrefs({ soundFolder: 'E:/osu/Songs/1572565 Momo Asakura - Pinky Hook' })
  const s = window.__store.getState()
  // 用一份干净的新谱，方便检查 [Define] 插入
  const id = s.addFile('libtest.hs', '[Metadata]\\nTitle = lib test\\n\\n[Files]\\npath = ""\\naudio = ""\\n\\n[Timing]\\n0,bpm(120),4,0,0\\n\\n[Hitsound]\\n/Aa/\\n')
  s.setActive(id)
  window.__store.getState().setSidebar('sounds')
  return 'ok'
})()`)
console.log('SETUP', setup)
await new Promise((r) => setTimeout(r, 2500))

const list = await ev(`JSON.stringify({
  items: document.querySelectorAll('.sl-item').length,
  first: document.querySelector('.sl-item .sl-name')?.textContent || '',
  count: document.querySelector('.sl-count')?.textContent || '',
})`)
console.log('LIST', list)

// 试听第一个
const play = await ev(`(async () => {
  const btn = document.querySelector('.sl-item .sl-btn')
  if (!btn) return 'no-btn'
  btn.click()
  await new Promise(r => setTimeout(r, 120))
  const hit = !!document.querySelector('.sl-item.playing')
  await new Promise(r => setTimeout(r, 1500))
  const logs = (window.__store.getState().output || []).filter(l => l.includes('试听'))
  return JSON.stringify({ playing: hit, failLogs: logs })
})()`)
console.log('PLAY', play)

// 点 + 打开弹窗
await ev(`(() => { const b = document.querySelector('.sl-item .sl-btn.add'); b && b.click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 500))
const dlg = await ev(`JSON.stringify({
  open: !!document.querySelector('.as-dialog'),
  cells: document.querySelectorAll('.as-cell').length,
  preview: document.querySelector('.as-preview')?.textContent || '',
})`)
console.log('DIALOG', dlg)

// 勾 soft-hitclap + drum-hitclap，填代号
const filled = await ev(`(() => {
  const cells = [...document.querySelectorAll('.as-cell')]
  const pick = (t) => { const c = cells.find(x => x.textContent.trim() === t); if (c) { c.querySelector('input').click() } }
  pick('soft-hitclap'); pick('drum-hitclap')
  const inp = document.querySelector('.as-name input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(inp, 'k1!K')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return JSON.stringify({ checked: [...document.querySelectorAll('.as-cell.on')].map(c => c.textContent.trim()), name: inp.value })
})()`)
console.log('FILLED', filled)

await shot(path.join(ROOT, 'ui-soundlib-dialog.png'))

await ev(`(() => { document.querySelector('.si-ok')?.click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 1200))

const result = await ev(`(() => {
  const s = window.__store.getState()
  const f = s.files.find(x => x.id === s.activeId)
  const defineLines = (f?.content || '').split('\\n').filter(l => l.trim().startsWith('hitsound') || l.trim() === '[Define]')
  return JSON.stringify({ defineLines, hs: (s.doc.hitsounds || []).map(h => (h.name||'') + '=' + h.value), bindings: Object.keys(s.bindings||{}).length, log: (s.output||[]).slice(-2) })
})()`)
console.log('RESULT', result)
// 相对路径用例：[Files] path 指到同一个目录
const rel = await ev(`(async () => {
  const s = window.__store.getState()
  const id = s.addFile('reltest.hs', '[Metadata]\nTitle = rel\n\n[Files]\npath = "E:/osu/Songs/1572565 Momo Asakura - Pinky Hook"\naudio = ""\n\n[Define]\nhitsound custom Aa = default.normal-hitnormal\n\n[Timing]\n0,bpm(120),4,0,0\n\n[Hitsound]\n/Aa/\n')
  s.setActive(id)
  return 'ok'
})()`)
await new Promise((r) => setTimeout(r, 400))
await ev(`(() => { document.querySelectorAll('.sl-item .sl-btn.add')[1]?.click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 400))
await ev(`(() => {
  const inp = document.querySelector('.as-name input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(inp, 'zz'); inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 1
})()`)
await new Promise((r) => setTimeout(r, 200))
await ev(`(() => { document.querySelector('.si-ok')?.click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 900))
const relOut = await ev(`(() => {
  const s = window.__store.getState()
  const f = s.files.find(x => x.id === s.activeId)
  return JSON.stringify((f?.content || '').split('\n').filter(l => l.startsWith('hitsound')))
})()`)
console.log('RELPATH', rel, relOut)
child.kill()
process.exit(0)
