/**
 * 格子视图的 keysound 支持：
 *  - 工具栏下拉在 Hitsound / [Keysound] 乐器之间切换；
 *  - 切到乐器后出现钢琴键盘（含八度音名，黑键 H I J K L）；
 *  - A~L 输入 12 个半音、数字/Ctrl+↑↓ 换八度、Ctrl+←→ 移范围/移调；
 *  - 写回只动 [Keysound]，[Hitsound] 一个字都不改。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9421
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
const shot = async (file) => {
  const s = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), wait(6000)])
  if (s?.result?.data) fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'))
}

let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const CHART = `[Metadata]
Title = ks grid

[Files]
audio = ""

[Define]
hitsound custom Aa = default.normal-hitnormal
keysound custom piano = ("piano/<loop("C","D","E","F","G","A","B")><int((i+9)/12)>.wav", C4, B6)
keysound custom guitar = ("guitar/<loop("C","D","E","F","G","A","B")><int((i+9)/12)>.wav", C4, B6)

[Timing]
0,bpm(120),4,0,0

[Keysound]
{piano | guitar}
/4C D E F | 4E F G A/

[Hitsound]
/Aa Aa Aa Aa/
/Aa = = =/
`

await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

// 建谱 → 切格子视图
await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('ksgrid.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1600)

const before = await ev(`(() => {
  const s = window.__store.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  return JSON.stringify({ names: [...document.querySelectorAll('.gd-brush')].map((b) => b.textContent), opts: [...document.querySelectorAll('.gd-inst-sel option')].map((o) => o.value + ':' + o.textContent), content: f.content })
})()`)
const B = JSON.parse(before)
console.log('BEFORE', JSON.stringify({ opts: B.opts, brushes: B.names.length }))
T('下拉框有 Hitsound + 两个 keysound 乐器 + 音效设置', B.opts.length === 4 && B.opts[0] === ':Hitsound' && B.opts[3] === '@define:音效设置', B.opts.join(' | '))
T('默认是 Hitsound 模式（显示音效圆按钮）', B.names.length === 1, B.names.join(','))

// 切到 piano
await ev(`(() => {
  const sel = document.querySelector('.gd-inst-sel')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, '0:piano')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await wait(900)

const piano = JSON.parse(
  await ev(`(() => {
    const keys = [...document.querySelectorAll('.gd-pkey')]
    return JSON.stringify({
      total: keys.length,
      white: keys.filter((k) => k.classList.contains('white')).length,
      black: keys.filter((k) => k.classList.contains('black')).length,
      names: keys.map((k) => k.querySelector('.gd-pkey-name')?.textContent || ''),
      brushes: document.querySelectorAll('.gd-brush').length,
      cells: [...document.querySelectorAll('.gd-cell')].slice(0, 8).map((c) => c.querySelector('.gd-label')?.textContent || ''),
    })
  })()`),
)
console.log('PIANO', JSON.stringify(piano))
T('钢琴键盘是整台 88 键（A0–C8）', piano.total === 88, String(piano.total))
T('52 白键 + 36 黑键', piano.white === 52 && piano.black === 36, `${piano.white}/${piano.black}`)
T(
  '只有 C 键标八度音名（C1–C8）',
  piano.names.filter((n) => /^C\d+$/.test(n)).join(' ') === 'C1 C2 C3 C4 C5 C6 C7 C8',
  piano.names.filter((n) => /^C\d+$/.test(n)).join(' '),
)

/** 当前八度那 12 个键（in-oct）、它们的位置、以及外面的高亮框 */
const octState = async () =>
  JSON.parse(
    await ev(`(() => {
      const rect = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 }
      }
      const keys = [...document.querySelectorAll('.gd-pkey')]
      const inOct = keys.filter((k) => k.classList.contains('in-oct'))
      const f = document.querySelector('.gd-piano-oct')
      const nav = [...document.querySelectorAll('.gd-piano-nav')]
      const el = document.querySelector('.gd-piano')
      return JSON.stringify({
        inOct: inOct.length,
        midis: inOct.map((k) => Number(k.dataset.midi)),
        labels: inOct.map((k) => k.textContent),
        frame: rect(f),
        c60: rect(document.querySelector('.gd-pkey[data-midi="60"]')),
        c72: rect(document.querySelector('.gd-pkey[data-midi="72"]')),
        c84: rect(document.querySelector('.gd-pkey[data-midi="84"]')),
        scroll: el ? el.scrollLeft : -1,
        scrollMax: el ? el.scrollWidth - el.clientWidth : -1,
        navCount: nav.length,
      })
    })()`),
  )

let oct = await octState()
T(
  '当前八度 12 个键都标了输入字母',
  oct.inOct === 12 && oct.midis[0] === 60 && oct.midis[11] === 71 && oct.labels.slice(1).join('') === 'HDIEFJGKALB',
  `${oct.midis[0]}–${oct.midis[11]} / ${oct.labels.join('')}`,
)
T(
  '当前八度外面有高亮框，左右边缘贴着 C4/C5',
  !!oct.frame && Math.abs(oct.frame.left - oct.c60.left) <= 2 && Math.abs(oct.frame.right - oct.c72.left) <= 2,
  `frame ${JSON.stringify(oct.frame)} · C4 ${JSON.stringify(oct.c60)} · C5 ${JSON.stringify(oct.c72)}`,
)
T('88 键放不下时提供 ◀▶ 滚动按钮', oct.navCount === 2 && oct.scrollMax > 0, `${oct.navCount} / max ${oct.scrollMax}`)

// ▶ 只挪视野，不改输入八度
const navBefore = (await octState()).scroll
await ev(`document.querySelectorAll('.gd-piano-nav')[1].click()`)
await wait(900)
const afterNav = await octState()
T(
  '▶ 把键盘往右滚，但不改输入八度',
  afterNav.scroll > navBefore && afterNav.midis[0] === 60,
  `scroll ${navBefore} → ${afterNav.scroll} · base ${afterNav.midis[0]}`,
)
T(
  '滚动后高亮框跟着琴键一起走',
  Math.abs(afterNav.frame.left - afterNav.c60.left) <= 2 && Math.abs(afterNav.frame.right - afterNav.c72.left) <= 2,
  `frame ${JSON.stringify(afterNav.frame)}`,
)
T('钢琴模式下不再显示音效圆按钮', piano.brushes === 0, String(piano.brushes))
T('格子里显示已有的 keysound 音名（每个音占 4 格）', piano.cells.slice(0, 5).join('|') === 'C4||||D4', piano.cells.join('|'))

// 点第 1 格，按 B → 加 B4（再按一次取消）
const cell0 = JSON.parse(await ev(`(() => {
  const c = document.querySelectorAll('.gd-cell')[0]
  const r = c.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
})()`))
const clickCell = async (i) => {
  const p = JSON.parse(
    await ev(`(() => {
      const c = document.querySelectorAll('.gd-cell')[${i}]
      const r = c.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`),
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  await wait(350)
}
const key = async (k, opts = {}) => {
  const { ctrl = false, shift = false } = opts
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27 }[k]
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: k,
    code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    text: k.length === 1 ? k : undefined,
    modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0),
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k,
    code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0),
  })
  await wait(400)
}
const ksText = async () =>
  JSON.parse(
    await ev(`(() => {
      const s = window.__store.getState()
      const f = s.files.find((x) => x.id === s.activeId)
      const lines = f.content.split('\\n')
      const a = lines.findIndex((l) => l.trim() === '[Keysound]')
      const b = lines.findIndex((l, i) => i > a && /^\\[/.test(l.trim()))
      return JSON.stringify({ ks: lines.slice(a, b < 0 ? undefined : b).join('\\n'), all: f.content })
    })()`),
  )

await clickCell(0)
await key('b')
let txt = await ksText()
console.log('AFTER_B', JSON.stringify(txt.ks))
T('按 B 给这一格加上 B4', /4C.*4B|\[4C 4B\]/.test(txt.ks), txt.ks.split('\n').slice(-2).join(' / '))

await key('b')
txt = await ksText()
T('再按一次 B 取消 B4', !/4B/.test(txt.ks), txt.ks.split('\n').slice(-2).join(' / '))

// 数字换八度：5 → C5，点第 5 格按 A
await key('5')
const oct5 = await octState()
T(
  '按 5 把输入范围换到第 5 八度',
  oct5.inOct === 12 && oct5.midis[0] === 72 && oct5.midis[11] === 83,
  `${oct5.midis[0]}–${oct5.midis[11]}`,
)
T(
  '按 5 后高亮框跟着移到 C5',
  Math.abs(oct5.frame.left - oct5.c72.left) <= 2 && Math.abs(oct5.frame.right - oct5.c84.left) <= 2,
  `frame ${JSON.stringify(oct5.frame)} · C5 ${JSON.stringify(oct5.c72)} · C6 ${JSON.stringify(oct5.c84)}`,
)
await clickCell(4)
await key('a')
txt = await ksText()
T('按 A 在新八度写 A5', /5A/.test(txt.ks), txt.ks.split('\n').slice(-2).join(' / '))

// 选中时 Ctrl+→ 移调 +1 半音：A5 → L5（A#5）
await key('ArrowRight', { ctrl: true })
txt = await ksText()
T('选中时 Ctrl+→ 把 A5 移成 L5', /5L/.test(txt.ks) && !/5A/.test(txt.ks), txt.ks.split('\n').slice(-2).join(' / '))

// Esc 取消选区 → Ctrl+→ 只滚动视野（快捷键音高不变）
await key('Escape')
await ev(`document.querySelector('.gd-wrap').focus()`)
await wait(600)
const scrollBefore = (await octState()).scroll
await key('ArrowRight', { ctrl: true })
const afterScroll = await octState()
T(
  '没选区时 Ctrl+→ 只滚动键盘，输入八度还是 C5',
  afterScroll.midis[0] === 72 && afterScroll.scroll > scrollBefore,
  `scroll ${scrollBefore} → ${afterScroll.scroll} · base ${afterScroll.midis[0]}`,
)

// 点钢琴键 D5 落笔（88 键里按 data-midi 找，别按音名找）
await clickCell(5)
await ev(`(() => {
  const k = document.querySelector('.gd-pkey[data-midi="74"]')
  k.click()
  return 'ok'
})()`)
await wait(500)
txt = await ksText()
T('点钢琴键把音符落进选中格', /5D/.test(txt.ks), txt.ks.split('\n').slice(-2).join(' / '))
T('[Hitsound] 一个字都没改', txt.all.includes('/Aa Aa Aa Aa/') && txt.all.includes('/Aa = = =/'))

// 切回 Hitsound：恢复音效按钮、格子回到 hitsound 显示
await ev(`(() => {
  const sel = document.querySelector('.gd-inst-sel')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, '')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await wait(700)
const back = JSON.parse(
  await ev(`JSON.stringify({
    brushes: document.querySelectorAll('.gd-brush').length,
    piano: document.querySelectorAll('.gd-pkey').length,
    cells: [...document.querySelectorAll('.gd-cell')].slice(0, 4).map((c) => c.querySelector('.gd-label')?.textContent || ''),
  })`),
)
console.log('BACK', JSON.stringify(back))
T('切回 Hitsound 后音效按钮回来、钢琴消失', back.brushes === 1 && back.piano === 0, `${back.brushes}/${back.piano}`)
T('格子回到 hitsound 内容', back.cells.join(' ').startsWith('Aa'), back.cells.join(' '))

// 切回 piano 再截个图
await ev(`(() => {
  const sel = document.querySelector('.gd-inst-sel')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, '0:piano')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await wait(800)
await shot(path.join(ROOT, 'ui-grid-keysound.png'))

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
