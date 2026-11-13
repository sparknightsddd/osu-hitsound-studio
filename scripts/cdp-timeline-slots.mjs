/**
 * 时间轴「槽位」视图：
 *  - 工具栏出现第三个视图按钮，点击后 4 行固定槽位（hitnormal / hitwhistle / hitfinish / hitclap）
 *  - 每个音符落在自己槽位对应的行里，方块颜色 = 采样组（soft/normal/drum）
 *  - 标签是「槽位缩写 + 音效组编号」，编号必须和导出计划一致
 *
 * 谱面（bpm120 / 4/4）：
 *   0ms    [Aa Bb]  soft-hitwhistle + soft-hitfinish → 1 号
 *   1125ms [Cc Dd]  另一个 soft-hitwhistle + soft-hitclap → 2 号（sw 被占用，不能共用）
 *   1500ms [Ee]     drum-hitclap → 复用 1 号；用来验证颜色按采样组区分
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9744
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)
let PAGE = null
async function waitWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const p = (await r.json()).find((t) => t.type === 'page')
        if (p) {
          PAGE = p
          return p.webSocketDebuggerUrl
        }
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
await send('Page.enable')
// 测试窗口可能被别的窗口盖住 / 最小化（visibilityState=hidden → ResizeObserver 不回调，
// 画布会停在 300x150）。试着让页面保持 active，像素采样才有意义。
try {
  await send('Page.setWebLifecycleState', { state: 'active' })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
} catch (e) {
  console.log('WAKE err', String(e).slice(0, 120))
}
await send('Page.bringToFront')
await wait(2800)

await ev(`window.__i18n.setLang('zh-CN')`)
await wait(200)

const CHART = [
  '[Metadata]',
  'Title = slot view',
  '',
  '[Files]',
  'path = ""',
  'audio = ""',
  '',
  '[Define]',
  'hitsound soft-hitwhistle Aa = "a.wav"',
  'hitsound soft-hitfinish Bb = "b.wav"',
  'hitsound soft-hitwhistle Cc = "c.wav"',
  'hitsound soft-hitclap Dd = "d.wav"',
  'hitsound drum-hitclap Ee = "e.wav"',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  '/[Aa Bb] = = = = = = = = [Cc Dd] = = [Ee] = = =/',
  '',
].join('\n')

const created = await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('slots.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  const st = window.__store.getState()
  if (st.panel !== 'timeline') st.setPanel('timeline')
  if (!st.panelOpen) st.togglePanel()
  return JSON.stringify({ events: window.__store.getState().doc.events.length })
})()`)
console.log('CREATED', created)
await wait(1200)

const segs = await ev(`JSON.stringify([...document.querySelectorAll('.tl-seg')].map(b => b.textContent.trim()))`)
console.log('SEGS', segs)
T('工具栏有三个视图按钮', JSON.parse(segs).length === 3 && JSON.parse(segs).includes('槽位'), segs)

await ev(`(() => {
  const b = [...document.querySelectorAll('.tl-seg')].find(x => x.textContent.trim() === '槽位')
  b.click()
  return 1
})()`)
// 等画布拿到实际尺寸：窗口不可见时 ResizeObserver 不回调，画布会停在 300x150（读出来全黑）。
for (let i = 0; i < 50; i++) {
  const w = await ev(`(() => {
    const cv = document.querySelector('.timeline-wrap canvas')
    if (!cv) return 0
    const r = cv.getBoundingClientRect()
    cv.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width / 2, clientY: r.top + 60, bubbles: true }))
    return cv.width
  })()`)
  if (w > 600) break
  await wait(100)
}
await wait(500)

const state = await ev(`(() => {
  const on = document.querySelector('.tl-seg.on')
  return JSON.stringify({ on: on ? on.textContent.trim() : null })
})()`)
console.log('STATE', state)
const st = JSON.parse(state)
T('槽位按钮处于选中态', st.on === '槽位', String(st.on))

const PIX = `(() => {
  const cv = document.querySelector('.timeline-wrap canvas')
  const ctx = cv.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const grab = (x, y) => {
    const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
    return [d[0], d[1], d[2]]
  }
  const near = (c, want, tol = 45) =>
    Math.abs(c[0] - want[0]) <= tol && Math.abs(c[1] - want[1]) <= tol && Math.abs(c[2] - want[2]) <= tol
  const laneY = (i) => 22 + i * 24 + 12
  const xAt = (t) => 74 + t * 0.09
  const soft = [62, 197, 255]
  const normal = [255, 179, 71]
  const drum = [139, 231, 139]
  const GUT = 74
  return JSON.stringify({
    dpr,
    lane0: grab(xAt(0) + 5, laneY(0)),
    whistle0: grab(xAt(0) + 5, laneY(1)),
    finish0: grab(xAt(0) + 5, laneY(2)),
    clap0: grab(xAt(0) + 5, laneY(3)),
    whistle1: grab(xAt(1125) + 5, laneY(1)),
    clap1: grab(xAt(1125) + 5, laneY(3)),
    drumClap: grab(xAt(1500) + 5, laneY(3)),
    normalAt1125: grab(xAt(1125) + 5, laneY(0)),
    softOk: [near(grab(xAt(0) + 5, laneY(1)), soft), near(grab(xAt(0) + 5, laneY(2)), soft), near(grab(xAt(1125) + 5, laneY(1)), soft), near(grab(xAt(1125) + 5, laneY(3)), soft)],
    drumOk: near(grab(xAt(1500) + 5, laneY(3)), drum),
    laneQuiet: !near(grab(xAt(0) + 5, laneY(0)), soft) && !near(grab(xAt(1125) + 5, laneY(0)), soft),
    legendOk: [near(grab(12, 130), soft), near(grab(12, 143), normal), near(grab(12, 156), drum)],
    rowSpan: cv.getBoundingClientRect().width - GUT,
  })
})()`
const px = JSON.parse(await ev(PIX))
console.log('PIX', JSON.stringify(px))
T(
  'whistle 行的两个音效都是 soft 色（sw1 / sw2）',
  px.softOk[0] && px.softOk[2],
  JSON.stringify([px.whistle0, px.whistle1]),
)
T('finish 0ms 是 soft 色（sf1）', px.softOk[1], JSON.stringify(px.finish0))
T('clap 1125ms 是 soft 色（sc2）', px.softOk[3], JSON.stringify(px.clap1))
T('clap 1500ms 是 drum 色（dc1）', px.drumOk, JSON.stringify(px.drumClap))
T('hitnormal 行没有误画音符', px.laneQuiet, JSON.stringify([px.lane0, px.normalAt1125]))
T('四行都画得下（行高 24）', px.rowSpan > 200, String(px.rowSpan))
T('名字栏下方有 soft / normal / drum 图例', px.legendOk.every(Boolean), JSON.stringify(px.legendOk))

// 点击 whistle 行 1125ms 的音符：应收听并跳到那个时间
const click = await ev(`(async () => {
  const cv = document.querySelector('.timeline-wrap canvas')
  const r = cv.getBoundingClientRect()
  const x = r.left + 74 + 1125 * 0.09 + 5
  const y = r.top + 22 + 1 * 24 + 12
  cv.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 }))
  await new Promise((res) => setTimeout(res, 300))
  return JSON.stringify({ now: Math.round(window.__engine.nowMs()) })
})()`)
console.log('CLICK', click)
const now = JSON.parse(click).now
T('点击槽位方块跳到 1125ms 附近', Math.abs(now - 1125) <= 130, String(now))

await wait(300)
const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (sh?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-timeline-slots.png'), Buffer.from(sh.result.data, 'base64'))
  console.log('SHOT ok')
}
const box = JSON.parse(
  await ev(`(() => {
    const el = document.querySelector('.timeline-wrap')
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.max(0, r.x - 2), y: Math.max(0, r.y - 30), width: Math.min(1100, window.innerWidth - r.x), height: Math.min(320, window.innerHeight - r.y), scale: 2 })
  })()`),
)
const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: box })
if (z?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-timeline-slots-zoom.png'), Buffer.from(z.result.data, 'base64'))
  console.log('ZOOM ok')
}

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
