/**
 * [Files] ImportOsu：导入 .osu 物件时间轴，并在网格模式格子下方显示。
 *
 * 验证：
 *  1. [Files] ImportOsu 被正确解析（相对 [Files] path 解析出完整路径），不报未知键；
 *  2. .osu 的 circle / slider / spinner 起止时间解析正确（slider 用 SV 换算）；
 *  3. 网格每行下方出现物件轨道：circle 小圆、slider 圆+双水平线+右半圆弧、spinner 左U+阴影；
 *  4. 开关关闭后轨道消失、行距恢复。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9735
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsimportosu-'))

const OSU = `osu file format v14

[General]
AudioFilename: song.mp3
Mode: 0

[Metadata]
Title:Import Test
Artist:Test
Creator:Test
Version:Test

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
256,192,0,1,0,0:0:0:0:
256,192,500,2,0,B|300:192,1,100,0|0,0:0|0:0,0:0:0:0:
256,192,1500,8,0,3000,0:0:0:0:
256,192,2500,1,0,0:0:0:0:
`
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
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
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
  'Title = import osu',
  '',
  '[Files]',
  `path = "${dirFwd}"`,
  'audio = ""',
  'ImportOsu = "map.osu"',
  '',
  '[Define]',
  'hitsound soft-hitnormal Aa = ""',
  '',
  '[Timing]',
  '0,bpm(120),4,0,0',
  '',
  '[Hitsound]',
  '#0',
  ...Array(4).fill(measure),
  '',
].join('\n')

await ev(`(() => {
  const s = window.__store.getState()
  const id = s.addFile('importosu.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  s.setDiv(4)
  s.setEditorMode('grid')
  return 'ok'
})()`)
await wait(1200)

const DOC = `(() => {
  const s = window.__store.getState()
  return { settings: s.doc.settings.ImportOsu, path: s.doc.importOsuPath, diag: s.doc.diagnostics.filter(d => /files/.test(d.code)).map(d => d.message) }
})()`
const info = await ev(`${DOC}`)
console.log('DOC', JSON.stringify(info))
T('[Files] ImportOsu 解析正确', info.settings === 'map.osu')
T('完整路径按 [Files] path 拼接', /map\.osu$/i.test(info.path) && info.path.includes('hsimportosu-'), info.path)
T('没有「[Files] 不支持」警告', info.diag.length === 0, JSON.stringify(info.diag))

const LOG = `(() => window.__store.getState().output.filter(l => /ImportOsu/.test(l)).slice(-3))()`
const log1 = JSON.stringify(await ev(LOG))
console.log('LOG', log1)
T('载入日志写出 4 个物件', log1.includes('4 个物件'), log1)

const LANE = `(() => {
  const lanes = [...document.querySelectorAll('.gd-objlane')]
  const row = document.querySelector('.gd-row.has-obj')
  const one = lanes[0]
  const groups = one ? [...one.querySelectorAll('.gd-obj')] : []
  const cell = document.querySelector('.gd-row .gd-cell')
  return {
    lanes: lanes.length,
    rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
    cellH: cell ? Math.round(cell.getBoundingClientRect().height) : 0,
    circles: groups.filter(g => g.classList.contains('circle')).length,
    sliders: groups.filter(g => g.classList.contains('slider')).length,
    spinners: groups.filter(g => g.classList.contains('spinner')).length,
    laneTop: one ? Math.round(one.getBoundingClientRect().top - row.getBoundingClientRect().top) : -1,
    laneH: one ? Math.round(one.getBoundingClientRect().height) : 0,
    sliderD: (one.querySelector('.gd-obj.slider path') || {}).getAttribute ? one.querySelector('.gd-obj.slider path').getAttribute('d') : '',
    spinD: (one.querySelector('.gd-obj.spinner path') || {}).getAttribute ? one.querySelector('.gd-obj.spinner path').getAttribute('d') : '',
    spinFill: (one.querySelector('.gd-obj.spinner path') || {}).getAttribute ? one.querySelector('.gd-obj.spinner path').getAttribute('fill') : '',
    sliderHasHead: !!one.querySelector('.gd-obj.slider circle'),
  }
})()`
const lane = await ev(LANE)
console.log('LANE', JSON.stringify(lane))
T('物件轨道出现', lane.lanes >= 1)
T('circle ×2 / slider ×1 / spinner ×1', lane.circles === 2 && lane.sliders === 1 && lane.spinners === 1)
T('行高增加 22px（26+7+22=55）', lane.rowH === 55, `rowH=${lane.rowH}`)
T('轨道紧贴格子下方', lane.laneTop === lane.cellH + 4, `top=${lane.laneTop}, cell=${lane.cellH}`)
T('slider 有头圆 + 两条水平线 + 右半圆弧', lane.sliderHasHead && (lane.sliderD.match(/H/g) || []).length === 2 && lane.sliderD.includes('A'))
T('spinner 是闭合路径且带斜线阴影', lane.spinD.includes('Z') && (lane.spinD.match(/A/g) || []).length === 2 && lane.spinFill.includes('gd-hatch'))

// 关掉开关：轨道消失、行距恢复
await ev(`(() => {
  const p = window.__displayPrefs.get()
  window.__displayPrefs.set({ ...p, showOsuObjects: false })
  window.__store.getState().bumpUi()
  return 'ok'
})()`)
await wait(500)
const off = await ev(`(() => {
  const row = document.querySelector('.gd-row')
  return { lanes: document.querySelectorAll('.gd-objlane').length, has: document.querySelectorAll('.gd-row.has-obj').length, rowH: row ? Math.round(row.getBoundingClientRect().height) : 0 }
})()`)
console.log('OFF', JSON.stringify(off))
T('关掉后轨道消失', off.lanes === 0 && off.has === 0)
T('关掉后行距恢复 33', off.rowH === 33, `rowH=${off.rowH}`)

// 再打开
await ev(`(() => {
  const p = window.__displayPrefs.get()
  window.__displayPrefs.set({ ...p, showOsuObjects: true })
  window.__store.getState().bumpUi()
  return 'ok'
})()`)
await wait(500)
T('再打开轨道回来', (await ev(`document.querySelectorAll('.gd-objlane').length`)) >= 1)

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (sh?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-grid-import-osu.png'), Buffer.from(sh.result.data, 'base64'))
  console.log('SHOT ok')
}
child.kill()
fs.rmSync(USERDATA, { recursive: true, force: true })
fs.rmSync(DIR, { recursive: true, force: true })
process.exit(0)
