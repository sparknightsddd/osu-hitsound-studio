/**
 * 小节起点带小数毫秒时的边界问题（回归用例）。
 *
 * 场景：BPM 174 → 每拍 344.827586ms，小节起点是 1379.31 / 2758.62 / 4137.93…
 *   1) osu 物件时间是整数毫秒：2758ms 比小节起点早 0.62ms，不能被画到上一行行尾；
 *   2) 点小节头（第 2758.62ms 那格）后播放头不能掉回上一行最后一格（看起来像多了一个选中框）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9739
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsboundary-'))

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Boundary
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,344.827586206897,4,2,0,60,1,0

[HitObjects]
256,192,0,1,0,0:0:0:0:
256,192,2758,1,0,0:0:0:0:
256,192,2758,2,0,B|300:192,1,56,0|0,0:0|0:0,0:0:0:0:
256,192,5517,1,0,0:0:0:0:
`
function writeWav(p, seconds = 8, rate = 44100) {
  const n = Math.floor(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 4000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(p, Buffer.concat([h, data]))
}
writeWav(path.join(DIR, 'song.wav'))
fs.writeFileSync(path.join(DIR, 'map.osu'), OSU)

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
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const dirFwd = DIR.replace(/\\/g, '/')
const measure = '/Aa = = = = = = = = = = = = = = =/'
const CHART = [
  '[Metadata]',
  'Title = boundary',
  '',
  '[Files]',
  `path = "${dirFwd}"`,
  'audio = "song.wav"',
  'ImportOsu = "map.osu"',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = ""',
  '',
  '[Timing]',
  '0,bpm(174),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  ...Array(8).fill(measure),
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('boundary.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  s.setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

const LAYOUT = `(() => {
  return [...document.querySelectorAll('.gd-row')].slice(0, 4).map((row, ri) => {
    const lane = row.querySelector('.gd-objlane')
    const objs = lane ? [...lane.querySelectorAll('.gd-obj')].map((g) => {
      const head = g.querySelector('circle')
      const p = g.querySelector('path')
      return {
        cls: g.getAttribute('class'),
        head: head ? Math.round(Number(head.getAttribute('cx')) * 10) / 10 : null,
        d: p ? p.getAttribute('d') : '',
      }
    }) : []
    return { ri, label: (row.querySelector('.gd-gutter') || {}).textContent, objs }
  })
})()`
const rows = await ev(LAYOUT)
console.log('LAYOUT', JSON.stringify(rows))
T('第 1 行不再出现「提前一格」的物件', rows[0].objs.length === 1 && rows[0].objs[0].cls.includes('circle'), JSON.stringify(rows[0].objs))
T('2758ms 的 circle 落在下一行第 1 格中心', rows[1].objs.some((o) => o.cls.includes('circle') && Math.abs(o.head - 13.1) < 1), JSON.stringify(rows[1].objs))
T('2758ms 的滑条头也在下一行第 1 格', rows[1].objs.some((o) => o.cls.includes('slider') && Math.abs(o.head - 13.1) < 1), JSON.stringify(rows[1].objs))

const PICK = `(() => {
  const cells = [...document.querySelectorAll('.gd-row .gd-cell')]
  return cells.map((c, i) => ({ i, cls: c.className })).filter((x) => /\\b(sel|insel|cur|play)\\b/.test(x.cls))
})()`
async function clickCell(index) {
  const pos = JSON.parse(
    await ev(`(() => {
      const c = document.querySelectorAll('.gd-row .gd-cell')[${index}]
      const b = c.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) })
    })()`),
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(400)
}
// 第 3 小节头 = 第 32 格（第 2 行第 1 格，小节起点 2758.62ms）
await clickCell(32)
const pick32 = await ev(PICK)
console.log('PICK32', JSON.stringify(pick32))
T('点小节头只选中/定位这一格，前面一格没有多余框', pick32.length === 1 && pick32[0].i === 32 && /play/.test(pick32[0].cls), JSON.stringify(pick32))

for (const t of [2758.0, 2758.62]) {
  await ev(`window.__engine.seek(${t})`)
  await wait(450)
  const play = JSON.parse(JSON.stringify(await ev(PICK))).filter((x) => /play/.test(x.cls))
  console.log('SEEK', t, JSON.stringify(play))
  T(`seek ${t}ms 播放头在小节第 1 格（32）`, play.length === 1 && play[0].i === 32, JSON.stringify(play))
}

// 换格子大小让一行小节数变化，物件仍应落在正确位置
const setCellSize = async (v) => {
  await ev(`(() => {
    const el = document.querySelector('.gd-toolbar input[type=range]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '${v}')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
  await wait(800)
}
await setCellSize(40)
const rows40 = await ev(LAYOUT)
console.log('ROWS40', JSON.stringify(rows40))
T('一行 1 小节时物件落在第 3 行第 1 格', rows40[2] && rows40[2].objs.some((o) => o.cls.includes('slider') && Math.abs(o.head - 20.2) < 1.5), JSON.stringify(rows40[2]))
await setCellSize(16)
const rows16 = await ev(LAYOUT)
console.log('ROWS16', JSON.stringify(rows16))
T('一行 3 小节时物件仍在第一行、位置正确', rows16[0] && rows16[0].objs.length === 3, JSON.stringify(rows16[0]))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
await wait(600)
try {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.rmSync(DIR, { recursive: true, force: true })
} catch {}
process.exit(0)
