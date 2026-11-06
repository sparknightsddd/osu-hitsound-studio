/**
 * 审阅：三个报告页 + 点时间跳时间轴。
 *
 * 原生菜单点不到，所以用 window.__openReview(kind) 打开（和菜单走同一入口）。
 * 验证：
 *   1) 三页都在，角标数字对；
 *   2) 使用次数：A 3 次、B/C 未使用、按次数降序；
 *   3) 槽位冲突：[D E] 一条，带 00:00:004；
 *   4) 重复槽位：[soft-hitclap.wav] 一条，带 00:00:000 / 00:08:000；
 *   5) 点时间 → 窗口关掉、播放头到 8000、底部切到时间轴。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9757
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsreview-'))

function writeWav(p, freq = 440, seconds = 0.08) {
  const rate = 8000
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(p, Buffer.concat([h, data]))
}
for (const [f, hz] of [
  ['a.wav', 440],
  ['b.wav', 550],
  ['c.wav', 660],
  ['d.wav', 700],
  ['e.wav', 800],
  ['z.wav', 900],
  ['l.wav', 1000],
]) writeWav(path.join(DIR, f), hz)
writeWav(path.join(DIR, 'song.wav'), 220, 12)

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
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
await send('Runtime.enable')
await wait(2600)

const chart = `[Metadata]
Title = Review
Artist = Tester
Creator = Me

[Files]
path = "${DIR.replace(/\\/g, '/')}"
audio = "song.wav"

[Define]
hitsound soft-hitclap A = "a.wav"
hitsound soft-hitwhistle B = "b.wav"
hitsound drum-hitfinish C = "c.wav"
hitsound soft-hitclap D = "d.wav"
hitsound drum-hitwhistle E = "e.wav"
hitsound soft-hitclap Z = "z.wav"
hitsound soft-hitclap L = "l.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/[Z L] = = =/
#2000
/A = = =/
#4000
/A = [D E] =/
#6000
/A = = =/
#8000
/[Z L] = = =/
`

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('review.hs', ${JSON.stringify(chart)})
  s.setActive(id)
  return 'ok'
})()`)
await wait(900)
// HS_DARK=1 → 切深色主题再截图（只影响截图，不影响断言）
const SUF = process.env.HS_DARK ? '-dark' : ''
if (SUF) {
  await ev(`window.__store.getState().setTheme('dark')`)
  await wait(450)
}

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

const MOD = `(() => {
  const dlg = () => document.querySelector('.rv-dialog')
  const tabs = () => [...document.querySelectorAll('.rv-tabs .set-tab')]
  const tab = (label) => tabs().find((b) => b.textContent.includes(label))
  const rows = () => [...document.querySelectorAll('.rv-row')]
  const rowOf = (code) => rows().find((r) => (r.querySelector('.rv-code .mono') || {}).textContent === code)
  const cards = () => [...document.querySelectorAll('.rv-card')]
  const chips = () => [...document.querySelectorAll('.rv-chip')].map((b) => b.textContent.trim())
  const texts = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.trim())
  return { dlg, tabs, tab, rows, rowOf, cards, chips, texts,
    open: (k) => window.__openReview(k),
    close: () => { const b = [...document.querySelectorAll('.rv-dialog .si-ok')][0]; if (b) b.click(); return 'ok' },
  }
})()`

// 1) 使用次数
await ev(`window.__openReview('usage')`)
await wait(500)
console.log('OPEN', await ev(`!!document.querySelector('.rv-dialog')`))
T('审阅窗口打开', (await ev(`!!document.querySelector('.rv-dialog')`)) === true)
console.log('TABS', await ev(`JSON.stringify(${MOD}.tabs().map((b) => b.textContent.trim()))`))
T('三页都在', (await ev(`${MOD}.tabs().length`)) === 3, String(await ev(`${MOD}.tabs().length`)))
console.log('BADGES', await ev(`JSON.stringify(${MOD}.tabs().map((b) => (b.querySelector('.rv-badge') || {}).textContent))`))
T('使用次数角标 = 7', (await ev(`${MOD}.tabs()[0].querySelector('.rv-badge').textContent`)) === '7')
T('冲突角标 = 1', (await ev(`${MOD}.tabs()[1].querySelector('.rv-badge').textContent`)) === '1')
T('重复槽位角标 = 1', (await ev(`${MOD}.tabs()[2].querySelector('.rv-badge').textContent`)) === '1')

const usageRows = JSON.parse(
  await ev(`JSON.stringify(${MOD}.rows().map((r) => ({ code: r.querySelector('.rv-code .mono').textContent, n: r.querySelector('.rv-num').textContent, tags: [...r.querySelectorAll('.rv-tag')].map((t) => t.textContent), times: [...r.querySelectorAll('.rv-chip')].map((b) => b.textContent.trim()) })))`),
)
console.log('USAGE', JSON.stringify(usageRows))
const rowA = usageRows.find((r) => r.code === 'A')
const rowC = usageRows.find((r) => r.code === 'C')
T('A 用了 3 次', rowA?.n === '3', JSON.stringify(rowA))
T('C 标了未使用', rowC?.tags.includes('未使用') === true, JSON.stringify(rowC))
T('降序：第一个不是 C', usageRows[0].code !== 'C', usageRows.map((r) => `${r.code}:${r.n}`).join(','))
T('A 的首次是 00:02:000', rowA?.times[0] === '00:02:000', JSON.stringify(rowA?.times))
console.log('SHOT_USAGE', await shotEl('.rv-dialog', 'ui-review-usage' + SUF + '.png', 2, 6))

// 2) 槽位冲突
await ev(`${MOD}.tab('槽位冲突').click()`)
await wait(350)
console.log(
  'CONFLICT',
  await ev(`JSON.stringify({ cards: ${MOD}.cards().length, reason: ${MOD}.texts('.rv-reason'), chips: ${MOD}.chips() })`),
)
T('冲突页一张卡片', (await ev(`${MOD}.cards().length`)) === 1, String(await ev(`${MOD}.cards().length`)))
T('卡片里写着 [D E]', (await ev(`document.querySelector('.rv-card .rv-names').textContent`)) === '[D E]')
T('原因提到同属一个采样组', String(await ev(`${MOD}.texts('.rv-reason')[0]`)).includes('同属'), String(await ev(`${MOD}.texts('.rv-reason')[0]`)))
T('冲突时间 00:05:000（第 3 格）', (await ev(`JSON.stringify(${MOD}.chips())`)) === '["00:05:000"]', String(await ev(`JSON.stringify(${MOD}.chips())`)))
console.log('SHOT_CONFLICT', await shotEl('.rv-dialog', 'ui-review-conflict' + SUF + '.png', 2, 6))

// 3) 重复槽位
await ev(`${MOD}.tab('重复槽位').click()`)
await wait(350)
console.log(
  'DUP',
  await ev(`JSON.stringify({ cards: ${MOD}.cards().length, names: ${MOD}.texts('.rv-card .rv-names'), chips: ${MOD}.chips(), note: ${MOD}.texts('.rv-note') })`),
)
T('重复槽位页一张卡片', (await ev(`${MOD}.cards().length`)) === 1, String(await ev(`${MOD}.cards().length`)))
T(
  '文件名带 soft-hitclap 槽位',
  String(await ev(`document.querySelector('.rv-card .rv-names').textContent`)).startsWith('soft-hitclap'),
  String(await ev(`document.querySelector('.rv-card .rv-names').textContent`)),
)
T(
  '两个落点 00:00:000 / 00:08:000',
  (await ev(`JSON.stringify(${MOD}.chips())`)) === '["00:00:000","00:08:000"]',
  String(await ev(`JSON.stringify(${MOD}.chips())`)),
)
T('导出错误提示也在', String(await ev(`(${MOD}.texts('.rv-note')[0]) || ''`)).includes('问题'), '')
console.log('SHOT_DUP', await shotEl('.rv-dialog', 'ui-review-dup' + SUF + '.png', 2, 6))

// 4) 点时间 → 关闭 + 跳时间轴
// 先把播放头放到 0，确保后面的 8000 是「点时间」这一下 seek 的
console.log('ENGINE_BEFORE', await ev(`JSON.stringify({ song: window.__engine.songName, dur: window.__engine.durationMs, now: Math.round(window.__engine.nowMs()) })`))
await ev(`(() => { window.__engine.seek(0); return 0 })()`)
await wait(150)
const before = await ev(`JSON.stringify({ panel: window.__store.getState().panel, open: window.__store.getState().panelOpen })`)
await ev(`(() => { const b = [...document.querySelectorAll('.rv-chip')].find((x) => x.textContent.includes('00:08:000')); b.click(); return 'ok' })()`)
await wait(500)
const after = await ev(`JSON.stringify({ dlg: !!document.querySelector('.rv-dialog'), panel: window.__store.getState().panel, open: window.__store.getState().panelOpen, now: Math.round(window.__engine.nowMs()) })`)
console.log('JUMP', before, '->', after)
T('点时间后窗口关闭', JSON.parse(after).dlg === false, after)
T('底部切到时间轴', JSON.parse(after).panel === 'timeline' && JSON.parse(after).open === true, after)
T('播放头到了 8000ms', JSON.parse(after).now === 8000, after)
console.log('STATUS', await ev(`(document.querySelector('.statusbar') || {}).textContent || ''`))

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
