/**
 * 音效库上下分层：
 *  - 上半层 = 音效文件夹里的文件（原样）；
 *  - 分隔线之后，下半层 = 内置默认音效 default.*；
 *  - 下半层的 ▶ 能试听、+ 会把 `= default.xxx` 写进 [Define]；
 *  - 过滤词同时作用于两层。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9419
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

// 造一个音效文件夹：根目录 2 个文件 + 子目录 1 个（用内置 wav 复制，保证能解码）
const SOUNDS = fs.mkdtempSync(path.join(os.tmpdir(), 'hssounds-'))
const SRC = path.join(ROOT, 'public', 'osudefaulthitsound')
fs.copyFileSync(path.join(SRC, 'default.soft-hitnormal.wav'), path.join(SOUNDS, 'alpha-hit.wav'))
fs.copyFileSync(path.join(SRC, 'default.drum-hitclap.wav'), path.join(SOUNDS, 'beta-hit.wav'))
fs.mkdirSync(path.join(SOUNDS, 'extra'), { recursive: true })
fs.copyFileSync(path.join(SRC, 'default.normal-hitfinish.wav'), path.join(SOUNDS, 'extra', 'gamma-hit.wav'))

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

await send('Runtime.enable')
await send('Page.enable')
await wait(3000)

// 指定音效目录 → 切到音效库
await ev(`(async () => {
  await window.desktop.setPrefs({ soundFolder: ${JSON.stringify(SOUNDS)} })
  const s = window.__store.getState()
  const ex = s.files.find((f) => f.name === 'example.hs')
  if (ex) s.closeFile(ex.id)
  const id = s.addFile('layers.hs', '[Metadata]\\nTitle = layers\\n\\n[Files]\\npath = ""\\naudio = ""\\n\\n[Timing]\\n0,bpm(120),4,0,0\\n\\n[Hitsound]\\n/Aa/\\n')
  s.setActive(id)
  window.__store.getState().setSidebar('sounds')
  return 'ok'
})()`)
await wait(2500)

// 展开根层的「本目录」和 extra 子目录，让上半层把 3 个文件都列出来
await ev(`(() => {
  const rows = [...document.querySelectorAll('.sl-folder')]
  for (const r of rows) {
    const n = r.querySelector('.sl-fname')?.textContent || ''
    if (n.includes('本目录') || n === 'extra') r.click()
  }
  return 'ok'
})()`)
await wait(600)

const info = JSON.parse(
  await ev(`(() => {
    const list = document.querySelector('.sl-list')
    const kids = [...(list?.children || [])]
    const splitIdx = kids.findIndex((k) => k.classList.contains('sl-split'))
    const fileRows = [...document.querySelectorAll('.sl-item:not(.builtin)')]
    const betRows = [...document.querySelectorAll('.sl-item.builtin')]
    const split = document.querySelector('.sl-split')
    return JSON.stringify({
      splitIdx,
      splitLabel: document.querySelector('.sl-split-label')?.textContent || '',
      splitCount: document.querySelector('.sl-split-count')?.textContent || '',
      files: fileRows.map((r) => r.querySelector('.sl-name')?.textContent || ''),
      fileIdx: fileRows.map((r) => kids.indexOf(r)),
      builtinCount: betRows.length,
      builtinNames: betRows.map((r) => r.querySelector('.sl-name')?.textContent || ''),
      builtinIdx: betRows.map((r) => kids.indexOf(r)),
      builtinAfterSplit: betRows.every((r) => split && r.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_PRECEDING),
      splitAfterFiles: fileRows.every((r) => split && r.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING),
      badges: [...new Set([...document.querySelectorAll('.sl-item.builtin .sl-badge')].map((b) => b.textContent))],
      truncated: betRows
        .filter((r) => {
          const n = r.querySelector('.sl-name')
          return n && n.scrollWidth > n.clientWidth + 1
        })
        .map((r) => r.querySelector('.sl-name')?.textContent || ''),
    })
  })()`),
)
console.log('INFO', JSON.stringify({ files: info.files, splitIdx: info.splitIdx, builtinCount: info.builtinCount }))

T('上半层列出音效文件夹里的 3 个文件', info.files.length === 3, info.files.join(', '))
T('分隔线在文件之后', info.splitIdx >= 0 && info.splitAfterFiles && info.builtinIdx.every((i) => i > info.splitIdx))
T('分隔线标题是「默认音效」', info.splitLabel === '默认音效', info.splitLabel)
T('分隔线右侧显示内置数量 22', info.splitCount === '22', info.splitCount)
T('下半层列出 22 个内置默认音效', info.builtinCount === 22, String(info.builtinCount))
T('第一项是 default.soft-hitnormal', info.builtinNames[0] === 'default.soft-hitnormal', info.builtinNames[0])
T('最后一项是 default.blank（静音）', info.builtinNames[info.builtinNames.length - 1] === 'default.blank', info.builtinNames.at(-1))
T('名称都带 default. 前缀', info.builtinNames.every((n) => n.startsWith('default.')))
T('最后一项标「静音」', info.badges.length === 1 && info.badges[0] === '静音', info.badges.join('/'))
T('默认宽度下名字不被截断', info.truncated.length === 0, info.truncated.join(', '))

await shot(path.join(ROOT, 'ui-soundlib-layers.png'))

// 放大分隔线附近，方便看线/对齐
const box = JSON.parse(
  await ev(`(() => {
    const el = document.querySelector('.sl-split')
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 96), width: 236, height: 190, scale: 3 })
  })()`),
)
const zoom = await send('Page.captureScreenshot', { format: 'png', clip: box, fromSurface: true })
if (zoom?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-soundlib-layers-zoom.png'), Buffer.from(zoom.result.data, 'base64'))
  console.log('ZOOM ok')
}

// ▶ 试听内置音效：会加载 public 里的 wav
const play = JSON.parse(
  await ev(`(async () => {
    const rows = [...document.querySelectorAll('.sl-item.builtin')]
    const row = rows.find((r) => r.querySelector('.sl-name')?.textContent === 'default.normal-hitclap')
    row.querySelector('.sl-btn').click()
    await new Promise((r) => setTimeout(r, 900))
    const hit = row.classList.contains('playing')
    const logs = (window.__store.getState().output || []).filter((l) => l.includes('试听'))
    return JSON.stringify({ hit, logs })
  })()`),
)
T('内置音效 ▶ 能试听', play.logs.length === 0, JSON.stringify(play.logs))

// + 添加内置音效：弹窗预览应写 default.xxx（不带引号）
const dlg = JSON.parse(
  await ev(`(async () => {
    const rows = [...document.querySelectorAll('.sl-item.builtin')]
    const row = rows.find((r) => r.querySelector('.sl-name')?.textContent === 'default.normal-hitnormal')
    row.querySelector('.sl-btn.add').click()
    await new Promise((r) => setTimeout(r, 400))
    return JSON.stringify({
      open: !!document.querySelector('.as-dialog'),
      sub: document.querySelector('.as-dialog .osu-diff-sub')?.textContent || '',
      preview: document.querySelector('.as-preview')?.textContent || '',
    })
  })()`),
)
console.log('DIALOG', JSON.stringify(dlg))
T('内置音效的 + 打开添加弹窗', dlg.open)
T('弹窗标题右侧显示 default.<ref>', dlg.sub.includes('default.normal-hitnormal'), dlg.sub)
T('预览写的是 = default.xxx（无引号）', dlg.preview.includes('= default.normal-hitnormal') && !dlg.preview.includes('"default.'), dlg.preview)

const added = JSON.parse(
  await ev(`(async () => {
    const inp = document.querySelector('.as-name input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(inp, 'Dz')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
    document.querySelector('.si-ok')?.click()
    await new Promise((r) => setTimeout(r, 1200))
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    const lines = (f?.content || '').split('\\n').filter((l) => l.trim().startsWith('hitsound'))
    const def = (s.doc.hitsounds || []).find((h) => h.name === 'Dz')
    return JSON.stringify({ lines, ref: def?.defaultRef || '', value: def?.value || '', total: (s.doc.hitsounds || []).length })
  })()`),
)
console.log('ADDED', JSON.stringify(added))
T('写进 [Define] 的是 = default.normal-hitnormal', added.lines.some((l) => /\bDz = default\.normal-hitnormal\b/.test(l)), added.lines.join(' | '))
T('解析出 defaultRef = normal-hitnormal', added.ref === 'normal-hitnormal', added.ref)
T('新代号没有把原来的定义挤掉', added.total === 1, String(added.total))

// 过滤词同时作用于两层
const filtered = JSON.parse(
  await ev(`(async () => {
    const inp = document.querySelector('.ms-search')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(inp, 'hitclap')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    return JSON.stringify({
      builtin: [...document.querySelectorAll('.sl-item.builtin .sl-name')].map((n) => n.textContent),
      count: document.querySelector('.sl-count')?.textContent || '',
    })
  })()`),
)
console.log('FILTER', JSON.stringify(filtered))
T('过滤词筛内置音效', filtered.builtin.length === 3 && filtered.builtin.every((n) => n.includes('hitclap')), filtered.builtin.join(', '))

// 英文界面：分层标题/徽标也要跟着翻译
const en = JSON.parse(
  await ev(`(async () => {
    // 先清掉过滤词，否则 blank 那一行被筛掉了
    const q = document.querySelector('.ms-search')
    const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setVal.call(q, '')
    q.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    await window.__i18n.setLang('en-US')
    await new Promise((r) => setTimeout(r, 600))
    const out = {
      label: document.querySelector('.sl-split-label')?.textContent || '',
      badge: document.querySelector('.sl-item.builtin .sl-badge')?.textContent || '',
      title: document.querySelector('.sl-split')?.getAttribute('title') || '',
    }
    await window.__i18n.setLang('zh-CN')
    await new Promise((r) => setTimeout(r, 400))
    return JSON.stringify(out)
  })()`),
)
console.log('EN', JSON.stringify(en))
T('英文下分隔线标签是 Default sounds', en.label === 'Default sounds', en.label)
T('英文下静音徽标是 Silent', en.badge === 'Silent', en.badge)
T('英文下分隔线提示没有中文', !/[一-龥]/.test(en.title), en.title)

// 空音效目录：上层为空，下半层照常出现
await ev(`(async () => {
  const inp = document.querySelector('.ms-search')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(inp, '')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  await window.desktop.setPrefs({ soundFolder: ${JSON.stringify(path.join(USERDATA, 'nope'))} })
  window.__store.getState().setSidebar('explorer')
  await new Promise((r) => setTimeout(r, 200))
  window.__store.getState().setSidebar('sounds')
  return 'ok'
})()`)
await wait(1800)
const noFolder = JSON.parse(
  await ev(`JSON.stringify({
    builtin: document.querySelectorAll('.sl-item.builtin').length,
    split: !!document.querySelector('.sl-split'),
    msg: [...document.querySelectorAll('.ms-msg')].map((m) => m.textContent.trim()),
  })`),
)
console.log('EMPTY', JSON.stringify(noFolder))
T('没有音效目录时下半层仍然列出 22 个', noFolder.builtin === 22 && noFolder.split, String(noFolder.builtin))

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
