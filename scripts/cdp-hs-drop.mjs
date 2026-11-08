/**
 * 拖 .hs 进窗口 = 直接打开成新标签（关联磁盘路径、可写回），
 * 不会把内容插进当前文本编辑器；不支持的类型要提示。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9493
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hshsdrop-'))

const CHART = `[Metadata]
Title = Dropped Chart
Artist = Someone

[Files]
audio = ""

[Define]
hitsound custom Aa = default.normal-hitnormal

[Timing]
0,bpm(120),4,0,0

[Hitsound]
/Aa = = =/`
const hsPath = path.join(DIR, 'drop-me.hs')
fs.writeFileSync(hsPath, CHART, 'utf8')
const txtPath = path.join(DIR, 'notes.txt')
fs.writeFileSync(txtPath, 'not a chart', 'utf8')

const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: USERDATA }
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

let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

await send('Runtime.enable')
await send('Page.enable')
await wait(3200)

const size = JSON.parse(await ev(`JSON.stringify({ w: innerWidth, h: innerHeight })`))
const at = { x: Math.round(size.w / 2), y: Math.round(size.h * 0.6) }

const dropFile = async (p, shotPath) => {
  const uri = 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20')
  const data = { items: [{ mimeType: 'text/uri-list', data: uri }], files: [p], dragOperationsMask: 1 }
  await send('Input.dispatchDragEvent', { type: 'dragEnter', x: at.x, y: at.y, data })
  await wait(250)
  const hint = await ev(`(document.querySelector('.drop-hint')?.textContent || '')`)
  if (shotPath && hint) {
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: false })
    if (shot.result?.data) fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
  }
  await send('Input.dispatchDragEvent', { type: 'dragOver', x: at.x, y: at.y, data })
  await send('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data })
  await wait(1500)
  return hint
}

const state = () =>
  ev(`JSON.stringify({
    files: window.__store.getState().files.map((f) => ({ name: f.name, path: f.path || '' })),
    active: window.__store.getState().files.find((f) => f.id === window.__store.getState().activeId),
    logs: window.__store.getState().output.slice(-8),
  })`).then((s) => JSON.parse(s))

const before = await state()
const oldExample = await ev(`(() => {
  const s = window.__store.getState()
  return s.files.find((f) => f.name === 'example.hs')?.content || ''
})()`)

const hint = await dropFile(hsPath, path.join(ROOT, 'ui-hs-drop.png'))
T('拖 .hs 时提示里有“打开谱面”', hint.includes('打开谱面'), hint.replace(/\s+/g, ' '))

const after = await state()
console.log('AFTER', JSON.stringify({ files: after.files, active: after.active?.name }))
T('拖 .hs 打开成新标签', after.files.some((f) => f.name === 'drop-me.hs'), after.files.map((f) => f.name).join(','))
T('新标签被激活', after.active?.name === 'drop-me.hs', after.active?.name || '')
T('新标签关联了磁盘路径', /drop-me\.hs$/.test(after.active?.path || ''), after.active?.path || '')
T('内容来自拖入的文件', /Title = Dropped Chart/.test(after.active?.content || ''), (after.active?.content || '').slice(0, 40))
T(
  '没有把文件内容插进原来的文本框',
  (await ev(`(() => {
    const s = window.__store.getState()
    return s.files.find((f) => f.name === 'example.hs')?.content || ''
  })()`)) === oldExample,
)

// 不支持的类型：不新增标签，日志里给提示
const n = (await state()).files.length
await dropFile(txtPath)
const afterTxt = await state()
T('拖 .txt 不会新增标签', afterTxt.files.length === n, String(afterTxt.files.length - n))
T(
  '拖 .txt 给出支持类型提示',
  afterTxt.logs.some((l) => l.includes('只支持拖入')),
  afterTxt.logs.slice(-1)[0] || '',
)

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
