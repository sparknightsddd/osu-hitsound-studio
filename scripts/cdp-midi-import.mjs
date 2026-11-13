/**
 * 「导入 MIDI / musictxt 到 [Keysound]」端到端：
 *  - 文件菜单里能找到入口；
 *  - 拖一个 .mid 进窗口 → 对话框列出轨道（默认选音符最多的那条）；
 *  - 点导入 → 音符按 1/16 量化写进 [Keysound]，并切到格子视图；
 *  - 再拖一个 musictxt（.txt）→ 勾「清空目标谱表」→ 原来那批音被替换。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9431
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
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
const T = (n, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`)
}

// ---------- 造一个两轨 MIDI ----------
function vlq(n) {
  const out = [n & 0x7f]
  n >>= 7
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80)
    n >>= 7
  }
  return out
}
function track(events, name) {
  const body = []
  if (name) {
    const text = [...name].map((c) => c.charCodeAt(0))
    body.push(0, 0xff, 0x03, ...vlq(text.length), ...text)
  }
  for (const e of events) body.push(...vlq(e.delta), ...e.bytes)
  body.push(0, 0xff, 0x2f, 0)
  return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body]
}
function midiFile(ppq, tracks) {
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (ppq >> 8) & 255, ppq & 255]
  return Buffer.from([...head, ...tracks.flat()])
}

// 120 BPM / 480 tick：0 / 500 / 1000 ms 三个音
const melody = track(
  [
    { delta: 0, bytes: [0x90, 60, 100] },
    { delta: 480, bytes: [0x80, 60, 0] },
    { delta: 0, bytes: [0x90, 64, 90] },
    { delta: 480, bytes: [0x80, 64, 0] },
    { delta: 0, bytes: [0x90, 67, 80] },
    { delta: 480, bytes: [0x80, 67, 0] },
  ],
  'Melody',
)
const bass = track(
  [
    { delta: 0, bytes: [0x90, 48, 70] },
    { delta: 1920, bytes: [0x80, 48, 0] },
  ],
  'Bass',
)
const MIDI_B64 = midiFile(480, [melody, bass]).toString('base64')

const CHART = `[Metadata]
Title = midi import

[Files]
audio = ""

[Define]
keysound custom piano = ("piano/<loop("C","H","D","I","E","F","J","G","K","A","L","B")><int((i+9)/12)>.wav", A0, C8)

[Timing]
0,bpm(120),4,0,0

[Keysound]
{piano}
/= = = = = = = = = = = = = = =/

[Hitsound]
/= = = =/
`

const SOURCE_TXT = `[Metadata]
Title = source

[Files]
audio = ""

[Define]
keysound custom violin = ("violin/<loop("C","H","D","I","E","F","J","G","K","A","L","B")><int((i+9)/12)>.wav", A0, C8)

[Timing]
0,bpm(120),4,0,0

[Keysound]
{violin}
/5C = 5E = 5G = = = = = = = = = = = = =/
`

await send('Runtime.enable')
await wait(2800)

// 载入测试谱面
await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) s.closeFile(f.id)
  const id = s.addFile('midi.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  return 'ok'
})()`)
await wait(700)

// ---------- 1) 菜单入口（Electron 是原生菜单，改查源码里的接线） ----------
console.log('\n[1] 菜单入口')
const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8')
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'useDesktop.ts'), 'utf8')
const barSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'TitleBar.tsx'), 'utf8')
T('原生菜单有入口', mainSrc.includes("act('importKeysound')") && mainSrc.includes('导入 MIDI / musictxt 到 [Keysound]'))
T('菜单动作接到对话框', bridgeSrc.includes("case 'importKeysound'") && bridgeSrc.includes('openKeysoundImport'))
T('浏览器菜单也有入口', barSrc.includes('导入 MIDI / musictxt 到 [Keysound]'))

// ---------- 2) 拖 MIDI ----------
console.log('\n[2] 拖入 MIDI')
await ev(`(() => {
  const arr = Uint8Array.from(atob(${JSON.stringify(MIDI_B64)}), c => c.charCodeAt(0))
  const file = new File([arr], 'melody.mid')
  const dt = new DataTransfer()
  dt.items.add(file)
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  return 'ok'
})()`)
await wait(900)
const dlg = JSON.parse(
  await ev(`(() => {
    const box = document.querySelector('.ki-dialog')
    return JSON.stringify({
      open: !!box,
      head: box?.querySelector('.osu-diff-head')?.textContent || '',
      tracks: [...document.querySelectorAll('.ki-track')].map(t => t.textContent.replace(/\\s+/g, ' ').trim()),
      checked: [...document.querySelectorAll('.ki-track input')].filter(i => i.checked).length,
      okDisabled: document.querySelector('.ki-dialog .si-ok')?.disabled,
      preview: document.querySelector('.ki-preview')?.textContent || '',
    })
  })()`),
)
T('对话框打开', dlg.open === true)
T('标题是导入 MIDI', dlg.head.includes('导入 MIDI / musictxt'), dlg.head)
T('列出两条轨道', dlg.tracks.length === 2, JSON.stringify(dlg.tracks))
T('默认只勾音符最多的旋律轨', dlg.checked === 1, String(dlg.checked))
T('预览显示 3 个音符', dlg.preview.includes('3'), dlg.preview.slice(0, 100))

// ---------- 3) 导入 ----------
console.log('\n[3] 导入到 [Keysound]')
await ev(`document.querySelector('.ki-dialog .si-ok')?.click()`)
await wait(1200)
const after = JSON.parse(
  await ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find(x => x.id === s.activeId)
    const ks = s.doc.events.filter(e => e.kind === 'keysound').map(e => [Math.round(e.time), e.pitch, e.staff])
    return JSON.stringify({
      open: !!document.querySelector('.ki-dialog'),
      ks,
      text: f.content.split('[Keysound]')[1]?.split('[Hitsound]')[0] || '',
      mode: s.editorMode,
      ksInst: s.ksInst,
      logs: s.output.slice(-6),
      errors: s.doc.diagnostics.filter(d => d.severity === 'error').map(d => d.message),
    })
  })()`),
)
T('导入后对话框关闭', after.open === false)
T('3 个音符按 500ms 间隔写入', after.ks.map((x) => x[0]).join(',') === '0,500,1000', JSON.stringify(after.ks))
T('音高正确（C4/E4/G4）', after.ks.map((x) => x[1]).join(',') === '60,64,67', JSON.stringify(after.ks))
T('正文按 1/16 铺平', /\/4C = = = 4E = = = 4G =/.test(after.text), after.text.replace(/\s+/g, ' ').slice(0, 120))
T('切到格子视图并选中 piano', after.mode === 'grid' && after.ksInst === '0:piano', `${after.mode} ${after.ksInst}`)
T('日志有导入统计', after.logs.some((l) => l.includes('Keysound 导入') && l.includes('3 个音符')), after.logs.join(' | '))
T('没有解析错误', after.errors.length === 0, after.errors.join(' | '))

// 撤销一步应该回到导入前（导入记进了格子的撤销栈）
const press = async (modifiers, key, code) =>
  send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers,
    key,
    code,
    windowsVirtualKeyCode: 90,
    nativeVirtualKeyCode: 90,
  })
await press(2, 'z', 'KeyZ')
await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 })
await wait(700)
const undone = await ev(`window.__store.getState().doc.events.filter(e => e.kind === 'keysound').length`)
T('Ctrl+Z 能整步撤销导入', undone === 0, String(undone))
await press(10, 'Z', 'KeyZ')
await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 10, key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 })
await wait(700)
const redoInfo = JSON.parse(await ev(`(() => {
  const s = window.__store.getState()
  return JSON.stringify({ n: s.doc.events.filter(e => e.kind === 'keysound').length, logs: s.output.slice(-4) })
})()`))
T('Ctrl+Shift+Z 能重做', redoInfo.n === 3, JSON.stringify(redoInfo))

// ---------- 4) 拖 musictxt + 清空 ----------
console.log('\n[4] 拖入 musictxt（清空目标谱表）')
await ev(`(() => {
  const file = new File([${JSON.stringify(SOURCE_TXT)}], 'source.txt', { type: 'text/plain' })
  window.__openKeysoundImport({ file })
  return 'ok'
})()`)
await wait(900)
const dlg2 = JSON.parse(
  await ev(`(() => {
    const box = document.querySelector('.ki-dialog')
    return JSON.stringify({
      open: !!box,
      staves: [...document.querySelectorAll('.ki-track')].map(t => t.textContent.replace(/\\s+/g, ' ').trim()),
      target: document.querySelector('.ki-dialog select.set-input')?.value,
      withDefs: !!document.querySelector('.ki-check input')?.checked,
    })
  })()`),
)
T('musictxt 对话框打开', dlg2.open === true)
T('列出 violin 谱表', dlg2.staves.length === 1 && dlg2.staves[0].includes('violin'), JSON.stringify(dlg2.staves))
T('目标自动选了 violin', dlg2.target === 'violin', dlg2.target)
T('默认勾选「一并导入定义」', dlg2.withDefs === true)

// 勾上「导入前清空目标谱表」
await ev(`(() => {
  const all = [...document.querySelectorAll('.ki-check input')]
  const box = all[all.length - 1]
  if (!box.checked) box.click()
  return box.checked
})()`)
await wait(200)
await ev(`document.querySelector('.ki-dialog .si-ok')?.click()`)
await wait(1300)
const after2 = JSON.parse(
  await ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find(x => x.id === s.activeId)
    return JSON.stringify({
      ks: s.doc.events.filter(e => e.kind === 'keysound').map(e => [Math.round(e.time), e.pitch, e.staff]),
      defs: s.doc.hitsounds.filter(h => h.kind === 'keysound').map(h => h.name),
      header: s.doc.keyInstruments.map(k => k.name),
      text: f.content.split('[Keysound]')[1]?.split('[Hitsound]')[0] || '',
      errors: s.doc.diagnostics.filter(d => d.severity === 'error').map(d => d.message),
      logs: s.output.slice(-5),
    })
  })()`),
)
T('清空只作用于目标谱表（piano 不受影响）', after2.ks.some((x) => x[2] === 0 && x[1] === 60), JSON.stringify(after2.ks))
T('violin 的 3 个音写进去', after2.ks.filter((x) => x[2] === 1).length === 3, JSON.stringify(after2.ks))
T('来源定义一并导入', after2.defs.includes('violin'), JSON.stringify(after2.defs))
T('谱表头补上 violin', after2.header.join('|') === 'piano|violin', JSON.stringify(after2.header))
T('没有解析错误', after2.errors.length === 0, after2.errors.join(' | '))

// ---------- 5) 再导一次：目标 piano + 清空 ----------
console.log('\n[5] 导入到已有乐器 + 清空')
await ev(`(() => {
  const file = new File([${JSON.stringify(SOURCE_TXT)}], 'source.txt', { type: 'text/plain' })
  window.__openKeysoundImport({ file })
  return 'ok'
})()`)
await wait(900)
const dlg3 = JSON.parse(
  await ev(`(() => {
    const sel = document.querySelector('.ki-dialog select.set-input')
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    set.call(sel, 'piano')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return JSON.stringify({ target: sel.value })
  })()`),
)
T('可以改选已有的 piano', dlg3.target === 'piano', dlg3.target)
await wait(200)
await ev(`(() => {
  const all = [...document.querySelectorAll('.ki-check input')]
  const box = all[all.length - 1]
  if (!box.checked) box.click()
  return box.checked
})()`)
await wait(200)
await ev(`document.querySelector('.ki-dialog .si-ok')?.click()`)
await wait(1300)
const after3 = JSON.parse(
  await ev(`(() => {
    const s = window.__store.getState()
    return JSON.stringify({
      staff0: s.doc.events.filter(e => e.kind === 'keysound' && (e.staff ?? 0) === 0).map(e => [Math.round(e.time), e.pitch]),
      staff1: s.doc.events.filter(e => e.kind === 'keysound' && (e.staff ?? 0) === 1).map(e => [Math.round(e.time), e.pitch]),
      errors: s.doc.diagnostics.filter(d => d.severity === 'error').map(d => d.message),
    })
  })()`),
)
T(
  'piano 谱表被清空后写入 C5/E5/G5',
  JSON.stringify(after3.staff0) === JSON.stringify([[0, 72], [250, 76], [500, 79]]),
  JSON.stringify(after3.staff0),
)
T('violin 谱表不受影响', after3.staff1.length === 3, JSON.stringify(after3.staff1))
T('没有解析错误', after3.errors.length === 0, after3.errors.join(' | '))
T('页面没有异常', errors.length === 0, errors.join(' | '))

ws.close()
child.kill()
try {
  fs.rmSync(USERDATA, { recursive: true, force: true })
} catch {}
console.log(`\nRESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
