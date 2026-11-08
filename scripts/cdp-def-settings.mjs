/**
 * ① 格子视图下拉里的「音效设置」：列代号/槽位、试听、左键选中、改槽位和代号（同步正文）。
 * ② 导入 `default.soft-hitnormal` 这类内置音效时，弹窗默认勾上同名槽位。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9461
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: USERDATA }
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

const CHART = `[Metadata]
Title = def settings

[Files]
audio = ""

[Define]
hitsound soft-hitnormal|normal-hitnormal Aa = "a.wav" #FF8800
hitsound custom Bb = "b.wav"
keysound custom piano = ("piano/<loop("C","H","D","I","E","F","J","G","K","A","L","B")><int((i+9)/12)>.wav", C4, B6)

[Timing]
0,bpm(120),4,0,0

[Keysound]
{piano}
/4C D E F/

[Hitsound]
/Aa [Aa Bb] Aa/
/Aa = = =
`

await ev(`(() => {
  const s = window.__store.getState()
  for (const f of [...s.files]) if (f.name === 'example.hs') s.closeFile(f.id)
  const id = s.addFile('defs.hs', ${JSON.stringify(CHART)})
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
await wait(1500)

// 下拉里要有「音效设置」
const opts = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.gd-inst-sel option')].map((o) => ({ v: o.value, t: o.textContent })))`),
)
console.log('OPTS', JSON.stringify(opts))
T('下拉里有「音效设置」', opts.some((o) => o.v === '@define' && o.t === '音效设置'), opts.map((o) => `${o.v}:${o.t}`).join(' | '))

// 选中它 → 弹窗
await ev(`(() => {
  const sel = document.querySelector('.gd-inst-sel')
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  set.call(sel, '@define')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await wait(700)

const first = JSON.parse(
  await ev(`(() => {
    const dlg = document.querySelector('.gd-def-dlg')
    return JSON.stringify({
      open: !!dlg,
      title: dlg?.querySelector('.gd-vol-title')?.textContent || '',
      rows: [...document.querySelectorAll('.gd-def-row')].map((r) => ({
        code: r.querySelector('.gd-def-code')?.textContent || '',
        slots: r.querySelector('.gd-def-slots')?.textContent || '',
        on: r.classList.contains('on'),
      })),
      name: dlg?.querySelector('.gd-def-name input')?.value || '',
      checked: [...document.querySelectorAll('.gd-def-slotgrid .as-cell.on')].map((c) => c.title),
      applyDisabled: !!dlg?.querySelector('.gd-vol-foot .btn.accent')?.disabled,
      selectValue: document.querySelector('.gd-inst-sel')?.value,
    })
  })()`),
)
console.log('FIRST', JSON.stringify(first))
T('弹窗打开了，标题是「音效设置」', first.open && first.title === '音效设置', first.title)
T('只列 hitsound 定义（Aa、Bb），不列 keysound 的 piano', first.rows.map((r) => r.code).join(',') === 'Aa,Bb', first.rows.map((r) => r.code).join(','))
T('槽位文本正确', first.rows[0]?.slots === 'soft-hitnormal|normal-hitnormal' && first.rows[1]?.slots === 'custom', JSON.stringify(first.rows.map((r) => r.slots)))
T('默认选中第一条', first.rows[0]?.on === true && first.rows[1]?.on === false)
T('编辑器填的是第一条的代号/槽位', first.name === 'Aa' && first.checked.join(',') === 'soft-hitnormal,normal-hitnormal', `${first.name} / ${first.checked.join(',')}`)
T('下拉在弹窗打开时显示「音效设置」', first.selectValue === '@define')

// 左键选中第二条
await ev(`(() => {
  const row = [...document.querySelectorAll('.gd-def-row')].find((r) => r.querySelector('.gd-def-code')?.textContent === 'Bb')
  row.click()
  return 'ok'
})()`)
await wait(400)
const second = JSON.parse(
  await ev(`JSON.stringify((() => ({
    name: document.querySelector('.gd-def-name input')?.value || '',
    checked: [...document.querySelectorAll('.gd-def-slotgrid .as-cell.on')].map((c) => c.title),
    on: [...document.querySelectorAll('.gd-def-row.on .gd-def-code')].map((x) => x.textContent),
  }))())`),
)
console.log('SECOND', JSON.stringify(second))
T('左键选中 Bb 后编辑区跟着切换', second.name === 'Bb' && second.on.join(',') === 'Bb', JSON.stringify(second))
T('Bb 是 custom，槽位一个都没勾', second.checked.length === 0, second.checked.join(','))

// 颜色：乱填 → 不能应用；填对 → 可以
await ev(`(() => {
  const inp = document.querySelector('.gd-def-color')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, 'notacolor')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await wait(300)
const badColor = JSON.parse(
  await ev(`JSON.stringify({
    disabled: !!document.querySelector('.gd-def-dlg .gd-vol-foot .btn.accent')?.disabled,
    hint: document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.textContent || '',
    err: document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.className || '',
  })`),
)
console.log('BAD_COLOR', JSON.stringify(badColor))
T('颜色认不出来时不能应用', badColor.disabled === true, badColor.hint)
T('颜色错误提示是红色那类', badColor.err.includes('si-err') && badColor.hint.includes('颜色'), badColor.hint)

await ev(`(() => {
  const inp = document.querySelector('.gd-def-color')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, '#3366ff')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await wait(300)
T('改成合法颜色后可以应用', (await ev(`!document.querySelector('.gd-def-dlg .gd-vol-foot .btn.accent')?.disabled`)) === true)

// 勾上 drum-hitclap + 改名为 Cc
await ev(`(() => {
  const cell = [...document.querySelectorAll('.gd-def-slotgrid .as-cell')].find((c) => c.title === 'drum-hitclap')
  cell.querySelector('input').click()
  return 'ok'
})()`)
await wait(250)
await ev(`(() => {
  const inp = document.querySelector('.gd-def-name input')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, 'Cc')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await wait(250)
const beforeApply = JSON.parse(
  await ev(`JSON.stringify((() => ({
    checked: [...document.querySelectorAll('.gd-def-slotgrid .as-cell.on')].map((c) => c.title),
    hint: document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.textContent || '',
    refs: [...document.querySelectorAll('.gd-def-name .hint')].map((x) => x.textContent).join(''),
    disabled: !!document.querySelector('.gd-def-dlg .gd-vol-foot .btn.accent')?.disabled,
  }))())`),
)
console.log('BEFORE_APPLY', JSON.stringify(beforeApply))
T('勾选槽位生效', beforeApply.checked.join(',') === 'drum-hitclap', beforeApply.checked.join(','))
T('显示正文引用数（Bb 1 处）', beforeApply.refs.includes('1'), beforeApply.refs)

await ev(`document.querySelector('.gd-def-dlg .gd-vol-foot .btn.accent')?.click()`)
// doc 是 180ms 防抖重解析的：等列表里真的出现 Cc，别用固定 sleep
for (let i = 0; i < 30; i++) {
  const ok = await ev(`[...document.querySelectorAll('.gd-def-row .gd-def-code')].some((x) => x.textContent === 'Cc')`)
  if (ok) break
  await wait(150)
}
await wait(200)

const applied = JSON.parse(
  await ev(`(() => {
    const s = window.__store.getState()
    const f = s.files.find((x) => x.id === s.activeId)
    const lines = f.content.split('\\n')
    const a = lines.findIndex((l) => l.trim() === '[Hitsound]')
    return JSON.stringify({
      content: f.content,
      body: lines.slice(a).join('\\n'),
      define: lines.find((l) => /^hitsound\\s+drum-hitclap\\s+Cc\\s*=/.test(l)) || '',
      rows: [...document.querySelectorAll('.gd-def-row .gd-def-code')].map((x) => x.textContent),
      on: [...document.querySelectorAll('.gd-def-row.on .gd-def-code')].map((x) => x.textContent),
      name: document.querySelector('.gd-def-name input')?.value || '',
      hint: document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.textContent || '',
      err: s.doc.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    })
  })()`),
)
console.log('APPLIED', JSON.stringify({ define: applied.define, body: applied.body, rows: applied.rows, hint: applied.hint }))
T('定义行改成 drum-hitclap Cc + 新颜色', applied.define === 'hitsound drum-hitclap Cc = "b.wav" #3366FF', applied.define)
T('正文里的 Bb 同步成 Cc', applied.body.includes('[Aa Cc]') && !/\\bBb\\b/.test(applied.body), applied.body.split('\\n')[1])
T('列表里也换成了 Cc', applied.rows.join(',') === 'Aa,Cc', applied.rows.join(','))
T('应用后仍选着 Cc', applied.on.join(',') === 'Cc' && applied.name === 'Cc', `${applied.on.join(',')}/${applied.name}`)
T('提示写了同步几处', /1/.test(applied.hint), applied.hint)
T('改完没有解析错误', applied.err.length === 0, applied.err.join(' | '))

// 颜色也能删回默认：选中 Aa → 点「默认」→ 应用
await ev(`(() => {
  const row = [...document.querySelectorAll('.gd-def-row')].find((r) => r.querySelector('.gd-def-code')?.textContent === 'Aa')
  row.click()
  return 'ok'
})()`)
await wait(350)
T('Aa 原来的颜色读进了输入框', (await ev(`document.querySelector('.gd-def-color')?.value`)) === '#FF8800', await ev(`document.querySelector('.gd-def-color')?.value`))
await ev(`document.querySelector('.gd-def-dlg .as-color-clear')?.click()`)
await wait(250)
await ev(`document.querySelector('.gd-def-dlg .gd-vol-foot .btn.accent')?.click()`)
for (let i = 0; i < 30; i++) {
  const done = await ev(`!/#FF8800/.test(window.__store.getState().files.find((x) => x.id === window.__store.getState().activeId).content)`)
  if (done) break
  await wait(150)
}
const cleared = await ev(`window.__store.getState().files.find((x) => x.id === window.__store.getState().activeId).content.split('\\n').find((l) => /^hitsound \\S+ Aa =/.test(l)) || ''`)
console.log('CLEARED', cleared)
T('颜色可以删掉（回到默认色）', cleared === 'hitsound soft-hitnormal|normal-hitnormal Aa = "a.wav"', cleared)
T('删颜色后输入框变空', (await ev(`document.querySelector('.gd-def-color')?.value`)) === '')

// 重名：Aa -> Cc 应该不给点应用
await ev(`(() => {
  const row = [...document.querySelectorAll('.gd-def-row')].find((r) => r.querySelector('.gd-def-code')?.textContent === 'Aa')
  row.click()
  return 'ok'
})()`)
await wait(350)
// 换行之后单独改输入框：和真实操作一致，避免同一帧里 click + input 互相覆盖
await ev(`(() => {
  const inp = document.querySelector('.gd-def-name input')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, 'Cc')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await wait(400)
const dup = JSON.parse(
  await ev(`JSON.stringify((() => ({
    disabled: !!document.querySelector('.gd-def-dlg .gd-vol-foot .btn.accent')?.disabled,
    hint: document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.textContent || '',
    err: document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.className || '',
    name: document.querySelector('.gd-def-name input')?.value || '',
    sel: [...document.querySelectorAll('.gd-def-row.on .gd-def-code')].map((x) => x.textContent).join(','),
    rows: [...document.querySelectorAll('.gd-def-row .gd-def-code')].map((x) => x.textContent).join(','),
  }))())`),
)
console.log('DUP', JSON.stringify(dup))
T('重名时「应用」不可点', dup.disabled === true)
T('重名提示可见', dup.hint.includes('已经被占用'), dup.hint)

// 代号清空 → 也不能应用
await ev(`(() => {
  const inp = document.querySelector('.gd-def-name input')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, '')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await wait(300)
const empty = JSON.parse(
  await ev(`JSON.stringify({
    disabled: !!document.querySelector('.gd-def-dlg .gd-vol-foot .btn.accent')?.disabled,
    hint: document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.textContent || '',
  })`),
)
T('代号为空时不能应用', empty.disabled === true, empty.hint)
T('空代号有提示', empty.hint.includes('英文字母'), empty.hint)

// 试听：没绑样本 → 提示去音效库
await ev(`(() => {
  const row = [...document.querySelectorAll('.gd-def-row')].find((r) => r.querySelector('.gd-def-code')?.textContent === 'Aa')
  row.querySelector('.gd-def-play').click()
  return 'ok'
})()`)
await wait(500)
const prev = await ev(`document.querySelector('.gd-def-dlg .gd-vol-foot .hint')?.textContent || ''`)
console.log('PREVIEW', prev)
T('试听没样本时给出提示', prev.includes('音效库'), prev)

// Esc 关闭
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await wait(400)
T('Esc 关掉弹窗', (await ev(`!!document.querySelector('.gd-def-dlg')`)) === false)
T('关掉后下拉回到 Hitsound', (await ev(`document.querySelector('.gd-inst-sel')?.value`)) === '')

// ② 内置默认音效：default.soft-hitnormal 的 + 应预选 soft-hitnormal
await ev(`window.__store.getState().setSidebar('sounds')`)
await wait(900)
await ev(`(() => {
  const rows = [...document.querySelectorAll('.sl-item.builtin')]
  const row = rows.find((r) => r.querySelector('.sl-name')?.textContent === 'default.soft-hitnormal')
  row.querySelector('.sl-btn.add').click()
  return 'ok'
})()`)
await wait(700)
const preset = JSON.parse(
  await ev(`(() => {
    const dlg = document.querySelector('.as-dialog')
    return JSON.stringify({
      open: !!dlg,
      checked: [...document.querySelectorAll('.as-dialog .as-cell.on')].map((c) => c.title),
      value: [...document.querySelectorAll('.as-dialog .as-preview')].map((x) => x.textContent).join(''),
    })
  })()`),
)
console.log('PRESET', JSON.stringify(preset))
T('点 + 打开了添加音效弹窗', preset.open === true)
T('自动勾上 soft-hitnormal', preset.checked.join(',') === 'soft-hitnormal', preset.checked.join(','))
T('预览行是 default.soft-hitnormal', preset.value.includes('default.soft-hitnormal'), preset.value)

// 关掉弹窗（取消）
await ev(`document.querySelector('.as-dialog .osu-diff-cancel')?.click()`)
await wait(400)
T('取消后没有写进 [Define]', (await ev(`window.__store.getState().doc.hitsounds.length`)) === 3, String(await ev(`window.__store.getState().doc.hitsounds.length`)))

console.log('ERRORS', JSON.stringify(errors.slice(0, 4)))
console.log(`RESULT ${pass} passed, ${fail} failed`)
child.kill()
process.exit(fail ? 1 : 0)
