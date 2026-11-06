/** 分节符端到端验证：缝隙 + Enter、段落名、换行标识删除、行距变大。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9531
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
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  }
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(name) {
  for (let i = 0; i < 4; i++) {
    const sh = await Promise.race([
      send('Page.bringToFront').then(() => send('Page.captureScreenshot', { format: 'png', fromSurface: i % 2 === 0 })),
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ])
    if (sh?.result?.data) {
      fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
      return
    }
    await wait(500)
  }
  console.log('SHOT_FAILED', name)
}
await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const secLine = () => text().split('\\n').find((l) => l.startsWith('Sections =')) || ''
  const rows = () => [...document.querySelectorAll('.gd-row')]
  const wraps = () => [...document.querySelectorAll('.gd-rowwrap')]
  const nameInput = () => document.querySelector('.gd-section-name')
  const mark = () => document.querySelector('.gd-section-mark')
  const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
  const down = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  const setValue = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return { text, secLine, rows, wraps, nameInput, mark, key, down, setValue }
})()`

await ev(`(() => {
  const text = ['[Metadata]','Title = sections','','[Settings]','Mode = default','','[Files]','path = ""','audio = ""','',
    '[Define]','hitsound custom Aa = default.soft-hitnormal red','',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0',
    '/Aa = = = = = = = = = = = = = = =/',
    '/= = = = = = = = = = = = = = = =/',
    '/= = = = = = = = = = = = = = = =/',
    '/= = = = = = = = = = = = = = = =/',''].join('\\n')
  const s = window.__store.getState()
  const id = s.addFile('sections.hs', text)
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 1
})()`)
await wait(900)

console.log(
  'LAYOUT0',
  await ev(`JSON.stringify({
    rows: ${MOD}.rows().length,
    gaps: document.querySelectorAll('.gd-gap').length,
    inRow: document.querySelectorAll('.gd-gap:not(.edge)').length,
    rowLabels: ${MOD}.rows().map((r) => r.querySelector('.gd-gutter')?.textContent),
    h0: Math.round(${MOD}.wraps()[0]?.getBoundingClientRect().height || 0),
  })`),
)

// 行首/行尾缝隙：目标小节要对，且第一行没有行首、最后一行没有行尾
console.log(
  'EDGES',
  await ev(`(async () => {
    const { rows, down, key } = ${MOD}
    const all = rows()
    const out = {}
    const clickGap = (el, name) => new Promise((res) => {
      if (!el) { out[name] = 'missing'; res(); return }
      down(el)
      setTimeout(() => {
        out[name] = document.querySelector('.gd-foot')?.textContent?.slice(0, 32) || ''
        key(document.querySelector('.gd-wrap'), 'Escape')
        setTimeout(res, 80)
      }, 140)
    })
    await clickGap(all[0].querySelector('.gd-gap.edge.start'), 'topStart')
    await clickGap(all[0].querySelector('.gd-gap.edge.end'), 'row0End')
    await clickGap(all[1].querySelector('.gd-gap.edge.start'), 'row1Start')
    await clickGap(all[all.length - 1].querySelector('.gd-gap.edge.end'), 'lastEnd')
    return JSON.stringify(out)
  })()`),
)

// 点第 1、2 小节之间的缝隙 → Enter
console.log(
  'GAP',
  await ev(`(() => {
    const { rows, down, key } = ${MOD}
    const gap = rows()[0].querySelector('.gd-gap:not(.edge)')
    if (!gap) return 'no-gap'
    down(gap)
    return new Promise((r) => setTimeout(() => {
      const foot = document.querySelector('.gd-foot')?.textContent || ''
      key(document.querySelector('.gd-wrap'), 'Enter')
      setTimeout(() => r(JSON.stringify({
        foot: foot.slice(0, 50),
        sec: (window.__store.getState().files.find(f => f.id === window.__store.getState().activeId).content.split('\\n')).find(l => l.startsWith('Sections =')) || '',
      })), 500)
    }, 150))
  })()`),
)

console.log(
  'LAYOUT1',
  await ev(`JSON.stringify({
    rows: ${MOD}.rows().length,
    labels: ${MOD}.rows().map((r) => r.querySelector('.gd-gutter')?.textContent),
    bands: document.querySelectorAll('.gd-section').length,
    bandH: Math.round(document.querySelector('.gd-section')?.getBoundingClientRect().height || 0),
    wrapH: Math.round(${MOD}.wraps()[1]?.getBoundingClientRect().height || 0),
    rowH: Math.round(${MOD}.rows()[1]?.getBoundingClientRect().height || 0),
    inputFocused: document.activeElement === ${MOD}.nameInput(),
  })`),
)
await shot('ui-sections-created.png')

// 输入段落名
console.log(
  'NAME',
  await ev(`(() => {
    const { nameInput, setValue, secLine } = ${MOD}
    const inp = nameInput()
    if (!inp) return 'no-input'
    setValue(inp, '主歌 A')
    inp.blur()
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      line: secLine(),
      reparse: window.__store.getState().doc.settings.Sections,
    })), 500))
  })()`),
)

// 点标识 → Delete 删除分节符
console.log(
  'DELETE',
  await ev(`(() => {
    const { mark, key, secLine } = ${MOD}
    const m = mark()
    if (!m) return 'no-mark'
    m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    m.focus()
    key(m, 'Delete')
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      line: secLine(),
      bands: document.querySelectorAll('.gd-section').length,
      rows: ${MOD}.rows().length,
      labels: ${MOD}.rows().map((x) => x.querySelector('.gd-gutter')?.textContent),
      log: (window.__store.getState().output || []).slice(-2),
    })), 500))
  })()`),
)

// 输入框里按 Backspace 不能清空格子
console.log(
  'GUARD',
  await ev(`(() => {
    const { nameInput, key, rows, down } = ${MOD}
    // 先重新创建一个分节符，拿到输入框
    const gap = rows()[0].querySelector('.gd-gap:not(.edge)')
    if (!gap) return 'no-gap'
    down(gap)
    return new Promise((r) => setTimeout(() => {
      key(document.querySelector('.gd-wrap'), 'Enter')
      setTimeout(() => {
        const inp = nameInput()
        if (!inp) return r('no-input-2')
        const before = (window.__store.getState().files.find(f => f.id === window.__store.getState().activeId).content)
        inp.focus()
        key(inp, 'Backspace')
        setTimeout(() => {
          const after = (window.__store.getState().files.find(f => f.id === window.__store.getState().activeId).content)
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(inp, '主歌 A')
          inp.dispatchEvent(new Event('input', { bubbles: true }))
          inp.blur()
          setTimeout(() => r(JSON.stringify({ unchanged: before === after })), 400)
        }, 350)
      }, 450)
    }, 120))
  })()`),
)
await shot('ui-sections-named.png')
console.log(
  'SCROLLCHK',
  await ev(`JSON.stringify({
    scroll: !!document.querySelector('.gd-scroll'),
    rows: document.querySelectorAll('.gd-row').length,
    mode: window.__store.getState().editorMode,
    line: (window.__store.getState().files.find(f => f.id === window.__store.getState().activeId).content.split('\\n')).find(l => l.startsWith('Sections =')) || '',
  })`),
)

// 多分节符下的滚动：行高不统一，底部/中部都要能正确虚拟化
console.log(
  'SCROLL',
  await ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    const line = 'Sections = { ( 2000 , "A" ) , ( 4000 , "B" ) , ( 6000 , "C" ) , ( 8000 , "D" ) }'
    const lines = f.content.split('\\n')
    const i = lines.findIndex((l) => l.startsWith('Sections ='))
    if (i >= 0) lines[i] = line
    else {
      const si = lines.findIndex((l) => l.trim() === '[Settings]')
      lines.splice(si + 1, 0, line)
    }
    s.updateContent(f.id, lines.join('\\n'))
    return new Promise((res) => setTimeout(() => {
      const el = document.querySelector('.gd-scroll')
      const bands = document.querySelectorAll('.gd-section').length
      const h = el.scrollHeight
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
      setTimeout(() => {
        const bottom = [...document.querySelectorAll('.gd-row')].map((r) => r.querySelector('.gd-gutter')?.textContent)
        const max = el.scrollHeight - el.clientHeight
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
        el.scrollTop = Math.floor(max / 2)
        el.dispatchEvent(new Event('scroll'))
        setTimeout(() => {
          const mid = [...document.querySelectorAll('.gd-row')].map((r) => r.querySelector('.gd-gutter')?.textContent)
          res(JSON.stringify({
            bands,
            h,
            max,
            atBottom,
            bottomLast: bottom[bottom.length - 1],
            midFirst: mid[0],
            midRows: mid.length,
          }))
        }, 350)
      }, 350)
    }, 800))
  })()`),
)

// 4x 放大分节条（名称 + 右侧换行标识）
{
  const raw = await ev(`(() => {
    const r = document.querySelector('.gd-section').getBoundingClientRect()
    return JSON.stringify({ x: Math.floor(r.x), y: Math.floor(r.y) - 4, width: Math.ceil(r.width), height: Math.ceil(r.height) + 8 })
  })()`)
  const clip = JSON.parse(raw)
  for (let i = 0; i < 3; i++) {
    const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...clip, scale: 4 } })
    if (z?.result?.data) {
      fs.writeFileSync(path.join(ROOT, 'ui-section-zoom.png'), Buffer.from(z.result.data, 'base64'))
      break
    }
    await wait(400)
  }
}



console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
