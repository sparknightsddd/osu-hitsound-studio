/**
 * 音效库 + 按钮：代号已经用过时改成「替换」而不是拒绝。
 *
 * 检查：弹窗标题/原来-换成两行、槽位沿用、确定后 [Define] 只留一条（原地替换，行号不变）、
 * 正文里的引用不变；换一个没用过的代号仍然是「添加」（追加一行）。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9621
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

// 素材目录：两个同长度的 wav，好分辨「原来 / 换成」
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hsadd-'))
const SRC = path.join(ROOT, 'public', 'osudefaulthitsound', 'default.drum-hitclap.wav')
for (const n of ['old-clap.wav', 'new-clap.wav']) fs.copyFileSync(SRC, path.join(DIR, n))
const DIR_POSIX = DIR.replace(/\\/g, '/')
/** 独立 userData：这个用例会真的绑定样本，别写进真实用户目录 */
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))

const child = spawn(
  ELECTRON,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USERDATA}`,
    '--remote-allow-origins=*',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
  ],
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
await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const define = () => (text().split('[Define]')[1] || '').split('[')[0]
  const body = () => (text().split('[Hitsound]')[1] || '').trim()
  const rows = () => [...document.querySelectorAll('.sl-item')]
  const addBtn = (file) => {
    const row = rows().find((r) => (r.querySelector('.sl-name') || {}).textContent === file)
    if (!row) return 'no-row'
    const b = row.querySelector('.sl-btn.add')
    if (!b) return 'no-add'
    b.click()
    return 'ok'
  }
  const setName = (v) => {
    const el = document.querySelector('.as-dialog .si-code-input')
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  const dlg = () =>
    document.querySelector('.as-dialog')
      ? {
          head: document.querySelector('.osu-diff-head')?.textContent.trim() || '',
          old: document.querySelector('.as-preview.as-old')?.textContent.trim() || '',
          new: document.querySelector('.as-preview.as-new')?.textContent.trim() || '',
          slots: [...document.querySelectorAll('.as-cell.on')].map((c) => c.getAttribute('title')),
          hint: document.querySelector('.osu-diff-hint')?.textContent.trim() || '',
          color: document.querySelectorAll('.as-dialog .si-code-input')[1]?.value || '',
          okDisabled: !!document.querySelector('.si-ok')?.disabled,
        }
      : null
  const ok = () => {
    const b = document.querySelector('.si-ok')
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  return { text, define, body, rows, addBtn, setName, dlg, ok }
})()`

console.log(
  'SETUP',
  await ev(`(async () => {
    await window.desktop.setPrefs({ soundFolder: ${JSON.stringify(DIR_POSIX)} })
    const chart = [
      '[Metadata]',
      'Title = add',
      'Artist = tester',
      '',
      '[Files]',
      'path = "${DIR_POSIX}"',
      'audio = ""',
      '',
      '[Define]',
      'hitsound soft-hitclap Aa = "old-clap.wav" #FF3B30',
      'hitsound soft-hitwhistle Ba = "old-clap.wav"',
      '',
      '[Timing]',
      '0,bpm(120),4,0,0',
      '',
      '[Hitsound]',
      '#0',
      '/Aa Ba = = = = = = = = = = = = = = =/',
      '',
    ].join('\\n')
    const s = window.__store.getState()
    const id = s.addFile('add.hs', chart)
    s.setActive(id)
    window.__store.getState().setSidebar('sounds')
    return 'ok'
  })()`),
)
await wait(1400)
console.log('ROWS', await ev(`JSON.stringify(${MOD}.rows().map((r) => (r.querySelector('.sl-name') || {}).textContent))`))

// 1) 用已经用过的代号 Aa → 弹窗应当是「替换」
console.log('ADD1', await ev(`${MOD}.addBtn('new-clap.wav')`))
await wait(500)
console.log('SETNAME', await ev(`${MOD}.setName('A')`))
await wait(150)
console.log('HALF', await ev(`JSON.stringify(${MOD}.dlg())`))
console.log('SETNAME2', await ev(`${MOD}.setName('Aa')`))
await wait(250)
console.log('REPLACE_DLG', await ev(`JSON.stringify(${MOD}.dlg())`))
console.log('SHOT', await shotEl('.as-dialog', 'ui-add-sound-replace.png', 2, 10))
console.log('BEFORE_DEFINE', await ev(`JSON.stringify(${MOD}.define())`))
console.log('CONFIRM', await ev(`${MOD}.ok()`))
await wait(900)
console.log('AFTER_DEFINE', await ev(`JSON.stringify(${MOD}.define())`))
console.log('AFTER_BODY', await ev(`JSON.stringify(${MOD}.body())`))
console.log('DLG_CLOSED', await ev(`!document.querySelector('.as-dialog')`))
console.log('LOG', await ev(`JSON.stringify((window.__store.getState().output || []).slice(-2))`))

// 2) 换一个没用过的代号 → 还是「添加」，追加一行
console.log('ADD2', await ev(`${MOD}.addBtn('old-clap.wav')`))
await wait(500)
console.log('SETNAME3', await ev(`${MOD}.setName('Ca')`))
await wait(250)
console.log('NEW_DLG', await ev(`JSON.stringify(${MOD}.dlg())`))
console.log('CONFIRM2', await ev(`${MOD}.ok()`))
await wait(900)
console.log('FINAL_DEFINE', await ev(`JSON.stringify(${MOD}.define())`))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
child.kill()
fs.rmSync(DIR, { recursive: true, force: true })
fs.rmSync(USERDATA, { recursive: true, force: true })
process.exit(0)
