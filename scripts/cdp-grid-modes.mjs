/**
 * 格子视图新交互的端到端验证（CDP，真实 Electron 窗口）：
 *   双击型 / 单击型、绿勾、拖选、Ctrl+C/X/V/A/Z、右键菜单（格子 + 文本）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9511
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
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(name) {
  const sh = await Promise.race([
    send('Page.bringToFront').then(() => send('Page.captureScreenshot', { format: 'png', fromSurface: true })),
    new Promise((r) => setTimeout(() => r(null), 15000)),
  ])
  if (sh?.result?.data) fs.writeFileSync(path.join(ROOT, name), Buffer.from(sh.result.data, 'base64'))
  else console.log('SHOT_FAILED', name)
}

await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

const MOD = `(() => {
  const click = (el, detail) => el.dispatchEvent(new MouseEvent('click', { detail, bubbles: true, cancelable: true, button: 0 }))
  const down = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  const up = () => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  const hover = (el, from) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
  const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
  const cell = (row, col) => document.querySelectorAll('.gd-row')[row]?.querySelectorAll('.gd-cell')[col]
  const brush = (name) => [...document.querySelectorAll('.gd-brush')].find((b) => b.textContent.replace('✓','').trim() === name)
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const lines = () => text().split('\\n').filter((l) => l.startsWith('/'))
  return { click, down, up, hover, key, cell, brush, text, lines }
})()`

await ev(`(() => {
  const text = ['[Metadata]','Title = modes','','[Files]','path = ""','audio = ""','',
    '[Define]',
    'hitsound custom Aa = default.soft-hitnormal red',
    'hitsound custom Ab = default.soft-hitclap green',
    'hitsound custom Ac = default.soft-hitfinish #3b82f6','',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0',
    '/Aa = = = = = = = = = = = = = = =/',
    '/= = = = = = = = = = = = = = = =/',
    '/= = = = = = = = = = = = = = = =/',
    '/= = = = = = = = = = = = = = = =/',''].join('\\n')
  const s = window.__store.getState()
  const id = s.addFile('modes.hs', text)
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 1
})()`)
await wait(900)

console.log(
  'INIT',
  await ev(`JSON.stringify({
    mode: window.__store.getState().brushMode,
    pin: window.__store.getState().brushPin,
    brushes: [...document.querySelectorAll('.gd-brush')].length,
    muted: document.querySelectorAll('.gd-brush.muted').length,
    cells: document.querySelectorAll('.gd-cell').length,
    selected: document.querySelectorAll('.gd-cell.sel').length,
  })`),
)

// 1) 双击 Ab → 双击型，其它按钮变灰
console.log(
  'DBL',
  await ev(`(() => {
    const { click, brush } = ${MOD}
    const b = brush('Ab')
    click(b, 1)
    click(b, 2)
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      mode: window.__store.getState().brushMode,
      pin: window.__store.getState().brushPin,
      on: document.querySelectorAll('.gd-brush.on').length,
      muted: document.querySelectorAll('.gd-brush.muted').length,
      mutedColor: getComputedStyle(document.querySelector('.gd-brush.muted')).color,
    })), 80))
  })()`),
)

// 2) 点第 6 格 → 直接落 Ab（双击型）
console.log(
  'PAINT',
  await ev(`(() => {
    const { down, up, cell, lines } = ${MOD}
    down(cell(0, 5)); up()
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      line: lines()[0],
      checks: [...document.querySelectorAll('.gd-brush')].filter(b => b.querySelector('.gd-brush-check')).map(b => b.textContent.trim()),
    })), 350))
  })()`),
)
await shot('ui-grid-dbl.png')
{
  const raw = await ev(`(() => {
    const r = document.querySelector('.gd-brushes').getBoundingClientRect()
    return JSON.stringify({ x: Math.floor(r.x) - 6, y: Math.floor(r.y) - 6, width: Math.ceil(r.width) + 12, height: Math.ceil(r.height) + 12 })
  })()`)
  const clip = JSON.parse(raw)
  const z = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...clip, scale: 4 } })
  if (z?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-grid-dbl-zoom.png'), Buffer.from(z.result.data, 'base64'))
}

// 3) 单击 Ac → 回到单击型，并把 Ac 落到刚才选中的格子
console.log(
  'SINGLE',
  await ev(`(() => {
    const { click, brush, lines } = ${MOD}
    click(brush('Ac'), 1)
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      mode: window.__store.getState().brushMode,
      pin: window.__store.getState().brushPin,
      on: document.querySelectorAll('.gd-brush.on').length,
      muted: document.querySelectorAll('.gd-brush.muted').length,
      line: lines()[0],
      checks: [...document.querySelectorAll('.gd-brush')].filter(b => b.querySelector('.gd-brush-check')).map(b => b.textContent.trim()),
    })), 500))
  })()`),
)

// 4) 单击型：点第 1 格（有 Aa），点 Aa → 一起移除
console.log(
  'TOGGLE',
  await ev(`(() => {
    const { down, up, cell, click, brush, lines } = ${MOD}
    down(cell(0, 0)); up()
    return new Promise((r) => setTimeout(() => {
      click(brush('Aa'), 1)
      setTimeout(() => r(JSON.stringify({
        line: lines()[0],
        checks: [...document.querySelectorAll('.gd-brush')].filter(b => b.querySelector('.gd-brush-check')).length,
      })), 450)
    }, 140))
  })()`),
)

// 4.5) 快速连点两个音效：两个都要落上（单击队列不能丢）
console.log(
  'RAPID',
  await ev(`(() => {
    const { down, up, cell, click, brush, lines } = ${MOD}
    down(cell(0, 8)); up()
    return new Promise((r) => setTimeout(() => {
      click(brush('Aa'), 1)
      click(brush('Ab'), 1)
      setTimeout(() => r(JSON.stringify({ line: lines()[0] })), 700)
    }, 150))
  })()`),
)

// 5) 拖选 4 格（拖到别的格子不落笔），再点 Ab 批量补到 4 格
console.log(
  'DRAG',
  await ev(`(() => {
    const { down, up, hover, cell, click, brush, lines } = ${MOD}
    down(cell(0, 2))
    for (let i = 3; i <= 5; i++) hover(cell(0, i), cell(0, i - 1))
    up()
    return new Promise((r) => setTimeout(() => {
      const info = {
        sel: document.querySelectorAll('.gd-cell.sel').length,
        insel: document.querySelectorAll('.gd-cell.insel').length,
        foot: document.querySelector('.gd-foot')?.textContent?.trim().slice(0, 40),
      }
      click(brush('Ab'), 1)
      setTimeout(() => r(JSON.stringify({ ...info, line: lines()[0] })), 450)
    }, 220))
  })()`),
)

// 6) Ctrl+C 复制 4 格，点第 16 格，Ctrl+V 粘贴（会跨小节）
console.log(
  'CLIP',
  await ev(`(() => {
    const { down, up, cell, key, lines } = ${MOD}
    const root = document.querySelector('.gd-wrap')
    key(root, 'c', { ctrlKey: true })
    down(cell(0, 15)); up()
    return new Promise((r) => setTimeout(() => {
      key(root, 'v', { ctrlKey: true })
      setTimeout(() => r(JSON.stringify({
        l0: lines()[0],
        l1: lines()[1],
        log: (window.__store.getState().output || []).slice(-3),
      })), 480)
    }, 180))
  })()`),
)

// 7) Ctrl+Z 撤销 → 回到粘贴前
console.log(
  'UNDO',
  await ev(`(() => {
    const { key, lines } = ${MOD}
    key(document.querySelector('.gd-wrap'), 'z', { ctrlKey: true })
    return new Promise((r) => setTimeout(() => r(JSON.stringify({ l0: lines()[0], l1: lines()[1] })), 420))
  })()`),
)

// 8) Ctrl+A 全选
console.log(
  'ALL',
  await ev(`(() => {
    const { key } = ${MOD}
    key(document.querySelector('.gd-wrap'), 'a', { ctrlKey: true })
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      selected: document.querySelectorAll('.gd-cell.sel, .gd-cell.insel').length,
      foot: document.querySelector('.gd-foot')?.textContent?.trim().slice(0, 40),
    })), 280))
  })()`),
)

// 8.5) Ctrl+X 剪切一格，Ctrl+V 粘贴回来
console.log(
  'CUT',
  await ev(`(() => {
    const { down, up, cell, key, lines } = ${MOD}
    const root = document.querySelector('.gd-wrap')
    down(cell(0, 2)); up()
    return new Promise((r) => setTimeout(() => {
      const before = lines()[0]
      key(root, 'x', { ctrlKey: true })
      setTimeout(() => {
        const cut = lines()[0]
        key(root, 'v', { ctrlKey: true })
        setTimeout(() => r(JSON.stringify({ before, cut, pasted: lines()[0] })), 450)
      }, 450)
    }, 200))
  })()`),
)

// 9) 右键菜单（格子）
console.log(
  'MENU',
  await ev(`(() => {
    const { cell } = ${MOD}
    const c = cell(1, 3)
    const r = c.getBoundingClientRect()
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }))
    return new Promise((res) => setTimeout(() => res(JSON.stringify({
      open: !!document.querySelector('.edit-menu'),
      items: [...document.querySelectorAll('.edit-menu-item')].map(e => e.textContent.trim()),
    })), 200))
  })()`),
)
await shot('ui-grid-menu.png')

// 10) 文本模式右键菜单
console.log(
  'TEXTMENU',
  await ev(`(() => {
    window.__store.getState().setEditorMode('text')
    return new Promise((r) => setTimeout(() => {
      const cm = document.querySelector('.cm-content')
      const rect = cm.getBoundingClientRect()
      cm.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 30 }))
      setTimeout(() => r(JSON.stringify({
        open: !!document.querySelector('.edit-menu'),
        items: [...document.querySelectorAll('.edit-menu-item')].map(e => e.textContent.trim()),
      })), 220)
    }, 700))
  })()`),
)
await shot('ui-grid-textmenu.png')

// 11) 文本右键菜单的「全选」真的全选了
console.log(
  'TEXTSEL',
  await ev(`(() => {
    const items = [...document.querySelectorAll('.edit-menu-item')]
    const all = items.find((e) => e.textContent.trim().startsWith('全选'))
    all?.click()
    const v = window.__cmView
    return new Promise((r) => setTimeout(() => r(JSON.stringify({
      menuClosed: !document.querySelector('.edit-menu'),
      from: v?.state.selection.main.from,
      to: v?.state.selection.main.to,
      len: v?.state.doc.length,
    })), 250))
  })()`),
)

child.kill()
process.exit(0)
