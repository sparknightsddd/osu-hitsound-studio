/**
 * 拖 .osu 进窗口 = 导入音效；txt 改名的假 .osu 要被挡掉。
 *
 * 用 CDP 的 Input.dispatchDragEvent 真的走一遍浏览器拖放（files 指向磁盘上的临时文件），
 * 这样 webUtils.getPathForFile 也能拿到路径，和用户手拖完全一致。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9491
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsosudrop-'))

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Drop Test
Artist:Someone
Creator:Me
Version:Hard

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,80,1,0

[HitObjects]
256,192,0,1,0,0:0:0:0:
256,192,500,1,0,0:0:0:0:
256,192,1000,1,0,0:0:0:0:
`
const validPath = path.join(DIR, 'valid.osu')
fs.writeFileSync(validPath, OSU, 'utf8')
const fakePath = path.join(DIR, 'fake.osu')
fs.writeFileSync(fakePath, '这只是一个 txt\n第二行\n第三行\n', 'utf8')

const DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hsosudrop2-'))
const hardPath = path.join(DIR2, 'hard.osu')
fs.writeFileSync(hardPath, OSU, 'utf8')
fs.writeFileSync(path.join(DIR2, 'insane.osu'), OSU.replace('Version:Hard', 'Version:Insane'), 'utf8')
fs.writeFileSync(path.join(DIR2, 'junk.osu'), 'not an osu file at all\n', 'utf8')

const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: USERDATA, HSS_TEST_MESSAGEBOX: '0' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)

let wsUrl = ''
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    if (r.ok) {
      const p = (await r.json()).find((t) => t.type === 'page')
      if (p) {
        wsUrl = p.webSocketDebuggerUrl
        break
      }
    }
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 300))
}
const ws = new WebSocket(wsUrl)
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
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

await send('Runtime.enable')
await send('Page.enable')
await wait(3200)

const size = JSON.parse(await ev(`JSON.stringify({ w: innerWidth, h: innerHeight })`))
const at = { x: Math.round(size.w / 2), y: Math.round(size.h * 0.6) }

/** 真的走一遍 dragenter → dragover → drop */
const dropFile = async (p, shotPath) => {
  const uri = 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20')
  const data = {
    items: [{ mimeType: 'text/uri-list', data: uri }],
    files: [p],
    dragOperationsMask: 1,
  }
  await send('Input.dispatchDragEvent', { type: 'dragEnter', x: at.x, y: at.y, data })
  await wait(250)
  const hint = await ev(`!!document.querySelector('.drop-hint')`)
  if (shotPath && hint) {
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: false })
    if (shot.result?.data) fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
  }
  await send('Input.dispatchDragEvent', { type: 'dragOver', x: at.x, y: at.y, data })
  await send('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data })
  await wait(300)
  return hint
}

const state = () =>
  ev(`JSON.stringify({
    files: window.__store.getState().files.map((f) => f.name),
    logs: window.__store.getState().output.slice(-12),
  })`).then(JSON.parse)

const before = await state()
console.log('BEFORE', JSON.stringify(before.files))

// 1) 假 .osu：拖进去要有提示、不加标签
const hint = await dropFile(fakePath, path.join(ROOT, 'ui-drop-osu.png'))
console.log('HINT', hint)
T('拖到窗口上会显示「松手导入」提示', hint === true)
await wait(1200)
const afterFake = await state()
console.log('AFTER_FAKE', JSON.stringify(afterFake.logs.slice(-4)))
T('假 .osu 没有被当成谱面导入', afterFake.files.length === before.files.length, afterFake.files.join(','))
T('假 .osu 给出「不是有效的 osu! 谱面」提示', afterFake.logs.some((l) => l.includes('不是有效的 osu! 谱面') && l.includes('fake.osu')), afterFake.logs.slice(-3).join(' | '))

// 2) 真 .osu：导入成新谱（有音效会先弹「白板与代号」窗口，点导入）
const hint2 = await dropFile(validPath)
T('真 .osu 也能触发拖放提示', hint2 === true)

let clicked = false
for (let i = 0; i < 40; i++) {
  const st = JSON.parse(
    await ev(`JSON.stringify({
      si: !!document.querySelector('.si-dialog'),
      files: window.__store.getState().files.map((f) => f.name),
    })`),
  )
  if (st.si && !clicked) {
    clicked = true
    await ev(`document.querySelector('.si-dialog .si-ok')?.click()`)
  }
  if (st.files.includes('valid.hs')) break
  await wait(300)
}
await wait(800)
const afterReal = await state()
console.log('AFTER_REAL', JSON.stringify(afterReal.files), JSON.stringify(afterReal.logs.slice(-4)))
T('真的 .osu 导入成了 valid.hs', afterReal.files.includes('valid.hs'), afterReal.files.join(','))
T('导入日志里有音效信息', afterReal.logs.some((l) => l.includes('valid.osu') || l.includes('valid.hs')), afterReal.logs.slice(-4).join(' | '))
T('假 .osu 始终没混进来', !afterReal.files.includes('fake.hs'), afterReal.files.join(','))

const info = JSON.parse(
  await ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.name === 'valid.hs')
    const c = f ? f.content : ''
    return JSON.stringify({
      hasTiming: /\\[Timing\\]/.test(c),
      defines: (c.match(/^hitsound /gm) || []).length,
      importOsu: /ImportOsu\\s*=/.test(c),
      docTiming: s.doc.timing.length,
    })
  })()`),
)
console.log('INFO', JSON.stringify(info))
T('导入的谱面带 [Timing] 段', info.hasTiming)
T('导入了 hitsound 定义', info.defines > 0, String(info.defines))
T('写入了 [Files] ImportOsu', info.importOsu)
T('当前文档解析出了 Timing 点', info.docTiming > 0, String(info.docTiming))

// 3) 同目录多个难度时，难度列表里不能出现假 .osu
await dropFile(hardPath)
await wait(1800)
const picker = JSON.parse(
  await ev(`JSON.stringify({
    open: !!document.querySelector('.osu-diff'),
    names: [...document.querySelectorAll('.osu-diff-row .osu-diff-name')].map((x) => x.textContent),
  })`),
)
console.log('PICKER', JSON.stringify(picker))
T('同目录有 2 个真难度 → 弹出选择器', picker.open === true)
T('假 .osu 没出现在难度列表里', picker.names.length === 2, picker.names.join(','))
T('列表里没有 junk', !picker.names.some((n) => /junk/i.test(n)), picker.names.join(','))
await ev(`document.querySelector('.osu-diff-cancel')?.click()`)
await wait(400)
T('取消后没有多出标签', (await state()).files.length === afterReal.files.length, (await state()).files.join(','))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
