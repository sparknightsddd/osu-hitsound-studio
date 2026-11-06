/** 画格右键「修改音量」+ 格子左侧音量数值。 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9601
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
async function shotEl(sel, name, scale = 3, pad = 4) {
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
/** 设置 → Timing → 「格子里音量」三选一 */
async function setVolMode(label) {
  console.log('OPEN_SETTINGS', await ev(`(() => { window.__openAppSettings(); return 'ok' })()`))
  await wait(600)
  console.log(
    'GO_TIMING',
    await ev(`(() => {
      const b = [...document.querySelectorAll('.set-tab')].find((x) => x.textContent.trim() === 'Timing')
      if (!b) return 'no-tab'
      b.click()
      return 'ok'
    })()`),
  )
  await wait(320)
  console.log(
    'PICK_MODE',
    label,
    await ev(`(() => {
      const b = [...document.querySelectorAll('.set-seg button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return 'no-btn'
      b.click()
      return 'ok'
    })()`),
  )
  await wait(220)
  console.log('SAVE', await ev(`(() => { document.querySelector('.si-ok')?.click(); return 'ok' })()`))
  await wait(700)
}

await send('Runtime.enable')
await send('Page.enable')
await wait(2800)

const MOD = `(() => {
  const text = () => {
    const s = window.__store.getState()
    return s.files.find((f) => f.id === s.activeId)?.content || ''
  }
  const body = () => (text().split('[Hitsound]')[1] || '').split('\\n').filter((l) => l.trim()).join(' | ')
  const rows = () => [...document.querySelectorAll('.gd-row')]
  const findCell = (mi, beat = 1, sub = 0) => {
    for (const r of rows()) {
      for (const c of r.querySelectorAll('.gd-cell')) {
        const t = c.getAttribute('title') || ''
        const want = '小节 ' + mi + ' · 第 ' + beat + ' 拍' + (sub ? ' +' + sub + '/4' : '')
        if (t.includes(want)) return c
      }
    }
    return null
  }
  const ctx = (mi, beat = 1, sub = 0) => {
    const c = findCell(mi, beat, sub)
    if (!c) return 'no-cell'
    const r = c.getBoundingClientRect()
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    return 'ok'
  }
  const menuItem = (label) => {
    const it = [...document.querySelectorAll('.edit-menu-item')].find((x) => x.textContent.includes(label))
    if (!it) return 'no-item'
    it.click()
    return 'ok'
  }
  const mouse = (el, type, extra = {}) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...extra }))
  const clickAt = (mi, beat, sub = 0, extra = {}) => {
    const c = findCell(mi, beat, sub)
    if (!c) return 'no-cell'
    mouse(c, 'mousedown', extra)
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return 'ok'
  }
  const clickCell = (mi, beat = 1, extra = {}) => {
    const c = findCell(mi, beat)
    if (!c) return 'no-cell'
    mouse(c, 'mousedown', extra)
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return 'ok'
  }
  const menu = () => [...document.querySelectorAll('.edit-menu-item')].map((x) => x.textContent.trim())
  const selCount = () => document.querySelectorAll('.gd-cell[data-sel="1"]').length
  const volLabels = () => [...document.querySelectorAll('.gd-vol')].map((e) => e.textContent)
  const dlg = () => {
    const d = document.querySelector('.gd-vol-dlg')
    return d ? { value: d.querySelector('.gd-vol-input')?.value, open: true } : { open: false }
  }
  const setVol = (v) => {
    const inp = document.querySelector('.gd-vol-input')
    if (!inp) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(inp, String(v))
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  const okBtn = () => {
    const b = [...document.querySelectorAll('.gd-vol-dlg .btn')].find((x) => x.textContent.trim() === '确定')
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  return { text, body, findCell, ctx, menuItem, menu, clickCell, clickAt, selCount, volLabels, dlg, setVol, okBtn }
})()`

const LOAD = await ev(`(() => {
  const lines = ['[Metadata]','Title = vol','','[Files]','path = ""','audio = ""','',
    '[Define]','hitsound soft-hitclap Aa = default.soft-hitclap','',
    '[Timing]','0,bpm(120),4,0,0','',
    '[Hitsound]','#0','/<v=58> Aa = = =/','#2000','/Aa = = =/','']
  const s = window.__store.getState()
  const id = s.addFile('vol.hs', lines.join('\\n'))
  s.setActive(id)
  window.__store.getState().setEditorMode('grid')
  return 'ok'
})()`)
console.log('LOAD', LOAD)
await wait(1300)
// 这一组用例测的是「数字」显示 + 右键改音量，先切到数字模式
await setVolMode('显示数字')
console.log(
  'MODE',
  await ev(`JSON.stringify({ gap: getComputedStyle(document.querySelector('.gd-cells')).gap, pref: localStorage.getItem('hsstudio.display') })`),
)
console.log('LABELS', await ev(`JSON.stringify(${MOD}.volLabels())`))
await shotEl('.gd-row', 'ui-grid-volume-labels.png', 3, 6)
{
  const box = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector('.gd-row').getBoundingClientRect()
      return JSON.stringify({ x: Math.max(0, Math.floor(r.x)), y: Math.floor(r.y) - 2, width: 300, height: Math.ceil(r.height) + 4 })
    })()`),
  )
  const sh = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...box, scale: 8 } })
  if (sh?.result?.data) fs.writeFileSync(path.join(ROOT, 'ui-grid-volume-zoom.png'), Buffer.from(sh.result.data, 'base64'))
  console.log('ZOOMOK')
}

// 右键小 1 第 2 拍 → 修改音量
console.log('CTX', await ev(`${MOD}.ctx(1, 2)`))
await wait(300)
console.log('MENU', await ev(`JSON.stringify([...document.querySelectorAll('.edit-menu-item')].map((x) => x.textContent.trim()))`))
console.log('CLICK', await ev(`${MOD}.menuItem('修改音量')`))
await wait(300)
console.log('DLG', await ev(`JSON.stringify(${MOD}.dlg())`))
await shotEl('.gd-vol-dlg', 'ui-grid-volume-dialog.png', 2, 8)

console.log('SET', await ev(`${MOD}.setVol(42)`))
await wait(150)
console.log('OK', await ev(`${MOD}.okBtn()`))
await wait(600)
console.log('AFTER1', await ev(`${MOD}.body()`))
console.log('DLG_OPEN', await ev(`!!document.querySelector('.gd-vol-dlg')`))
console.log('LABELS2', await ev(`JSON.stringify(${MOD}.volLabels())`))

// 再改同一个位置：预填 42，改成 30
console.log('CTX2', await ev(`${MOD}.ctx(1, 2)`))
await wait(300)
console.log('CLICK2', await ev(`${MOD}.menuItem('修改音量')`))
await wait(300)
console.log('PREFILL', await ev(`JSON.stringify(${MOD}.dlg())`))
console.log('SET2', await ev(`${MOD}.setVol(30)`))
await wait(150)
console.log('OK2', await ev(`${MOD}.okBtn()`))
await wait(600)
console.log('AFTER2', await ev(`${MOD}.body()`))

// 空格子上设音量
console.log('CTX3', await ev(`${MOD}.ctx(1, 3)`))
await wait(300)
console.log('CLICK3', await ev(`${MOD}.menuItem('修改音量')`))
await wait(300)
console.log('SET3', await ev(`${MOD}.setVol(55)`))
await wait(150)
console.log('OK3', await ev(`${MOD}.okBtn()`))
await wait(600)
console.log('AFTER3', await ev(`${MOD}.body()`))
console.log('LABELS3', await ev(`JSON.stringify(${MOD}.volLabels())`))
console.log(
  'VTITLES',
  await ev(`JSON.stringify([...document.querySelectorAll('.gd-cell')]
    .map((c) => c.getAttribute('title') || '')
    .filter((t) => t.includes('音量'))
    .map((t) => t.split('·').slice(1, 3).join('·').trim() + ' → ' + (t.match(/音量 \\d+/) || [''])[0]))`),
)

// 右键「删除音量」：只在左侧有音量的格子上出现
console.log('CTX_NO_VOL', await ev(`${MOD}.ctx(2, 1)`))
await wait(320)
console.log('MENU_NO_VOL', await ev(`JSON.stringify(${MOD}.menu())`))

console.log('CTX_DEL', await ev(`${MOD}.ctx(1, 2)`))
await wait(320)
console.log('MENU_DEL', await ev(`JSON.stringify(${MOD}.menu())`))
console.log('MENUSHOT', await shotEl('.edit-menu', 'ui-grid-menu-delvol.png', 2, 8))
console.log('CLICK_DEL', await ev(`${MOD}.menuItem('删除音量')`))
await wait(700)
console.log('AFTER_DEL', await ev(`${MOD}.body()`))
console.log('LABELS_DEL', await ev(`JSON.stringify(${MOD}.volLabels())`))

// 撤销：删掉的 <v=30> 要回来
console.log(
  'UNDO',
  await ev(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    return 'ok'
  })()`),
)
await wait(700)
console.log('AFTER_UNDO', await ev(`${MOD}.body()`))

// 多选删两处：58 那格 + 30/55 那格
console.log('SEL1', await ev(`${MOD}.clickCell(1, 1)`))
await wait(200)
console.log('SEL2', await ev(`${MOD}.clickCell(1, 3, { shiftKey: true })`))
await wait(250)
console.log('SEL_COUNT', await ev(`${MOD}.selCount()`))
console.log('CTX_MULTI', await ev(`${MOD}.ctx(1, 3)`))
await wait(320)
console.log('MENU_MULTI', await ev(`JSON.stringify(${MOD}.menu())`))
console.log('CLICK_MULTI', await ev(`${MOD}.menuItem('删除音量')`))
await wait(700)
console.log('AFTER_MULTI', await ev(`${MOD}.body()`))
console.log('LABELS_MULTI', await ev(`JSON.stringify(${MOD}.volLabels())`))
await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); return 'ok' })()`)
await wait(600)

// 越界输入：确定要禁用
console.log('CTX4', await ev(`${MOD}.ctx(2, 1)`))
await wait(300)
console.log('CLICK4', await ev(`${MOD}.menuItem('修改音量')`))
await wait(300)
console.log('SET120', await ev(`${MOD}.setVol(120)`))
await wait(150)
console.log('OK120', await ev(`${MOD}.okBtn()`))
await wait(200)
console.log('DLG_STILL', await ev(`JSON.stringify(${MOD}.dlg())`))
await ev(`document.querySelector('.gd-vol-dlg .btn')?.click()`)
await wait(200)

await shotEl('.gd-row', 'ui-grid-volume-final.png', 3, 6)

// 单选改音量 = 从这一格一直管到下一条 <v> 之前（等价于文本里只加一条 <v>）
console.log(
  'LOAD_SPAN',
  await ev(`(() => {
    const mk = (marks, notes) => {
      const out = []
      for (let k = 0; k < 16; k++) {
        if (marks[k] !== undefined) out.push('<v=' + marks[k] + '>')
        out.push(notes[k] || '=')
      }
      return '/' + out.join(' ') + '/'
    }
    const lines = ['[Metadata]','Title = span','','[Files]','path = ""','audio = ""','',
      '[Define]','hitsound soft-hitclap Aa = default.soft-hitclap','',
      '[Timing]','0,bpm(120),4,0,0','',
      '[Hitsound]','#0', mk({ 0: 58, 4: 30 }, { 0: 'Aa', 8: 'Aa' }), '#2000', mk({}, { 0: 'Aa' }), '']
    const s = window.__store.getState()
    const id = s.addFile('span.hs', lines.join('\\n'))
    s.setActive(id)
    return 'ok'
  })()`),
)
await wait(1300)

console.log('CTX_SPAN', await ev(`${MOD}.ctx(1, 1)`))
await wait(320)
console.log('CLICK_SPAN', await ev(`${MOD}.menuItem('修改音量')`))
await wait(320)
console.log('PREFILL_SPAN', await ev(`JSON.stringify(${MOD}.dlg())`))
console.log('SET_SPAN', await ev(`${MOD}.setVol(70)`))
await wait(150)
console.log('OK_SPAN', await ev(`${MOD}.okBtn()`))
await wait(700)
console.log('AFTER_SPAN', await ev(`${MOD}.body()`))
console.log(
  'SPAN_COUNT',
  await ev(`JSON.stringify({
    v70: (${MOD}.text().match(/<v=70>/g) || []).length,
    v58: (${MOD}.text().match(/<v=58>/g) || []).length,
    v30: (${MOD}.text().match(/<v=30>/g) || []).length,
    // 第二小节没有 <v>，会继承 70
    m2: [...new Set(window.__store.getState().doc.events.filter((e) => e.time >= 2000).map((e) => e.volume))],
  })`),
)

// 多选：连续 4 格只在段首写一条 <v=55>，段尾后面补回 70
console.log('SEL_A', await ev(`${MOD}.clickAt(1, 3)`))
await wait(180)
console.log('SEL_B', await ev(`${MOD}.clickAt(1, 3, 3, { shiftKey: true })`))
await wait(250)
console.log('SEL_N', await ev(`${MOD}.selCount()`))
console.log('CTX_MULTI2', await ev(`${MOD}.ctx(1, 3)`))
await wait(320)
console.log('MENU_MULTI2', await ev(`JSON.stringify(${MOD}.menu())`))
console.log('CLICK_MULTI2', await ev(`${MOD}.menuItem('修改音量')`))
await wait(300)
console.log('SET_MULTI', await ev(`${MOD}.setVol(55)`))
await wait(150)
console.log('OK_MULTI', await ev(`${MOD}.okBtn()`))
await wait(700)
console.log('AFTER_MULTI2', await ev(`${MOD}.body()`))
console.log(
  'MULTI_COUNT',
  await ev(`JSON.stringify({
    v55: (${MOD}.text().match(/<v=55>/g) || []).length,
    v70: (${MOD}.text().match(/<v=70>/g) || []).length,
  })`),
)
console.log('SPAN_SHOT', await shotEl('.gd-row', 'ui-grid-vol-span.png', 3, 6))

// 选中小节最后一拍：下一个小节开头要补回原音量（多选不该影响下一小节）
console.log('SEL_LAST_A', await ev(`${MOD}.clickAt(1, 4)`))
await wait(180)
console.log('SEL_LAST_B', await ev(`${MOD}.clickAt(1, 4, 3, { shiftKey: true })`))
await wait(250)
console.log('SEL_LAST_N', await ev(`${MOD}.selCount()`))
console.log('CTX_LAST', await ev(`${MOD}.ctx(1, 4)`))
await wait(320)
console.log('CLICK_LAST', await ev(`${MOD}.menuItem('修改音量')`))
await wait(300)
console.log('SET_LAST', await ev(`${MOD}.setVol(45)`))
await wait(150)
console.log('OK_LAST', await ev(`${MOD}.okBtn()`))
await wait(800)
console.log('AFTER_LAST', await ev(`${MOD}.body()`))
console.log(
  'M2_VOL2',
  await ev(`JSON.stringify([...new Set(window.__store.getState().doc.events.filter((e) => e.time >= 2000).map((e) => e.volume))])`),
)

// 切到「不显示」→ 间距回到 4px、标签和音量条都消失
await setVolMode('不显示')
console.log(
  'AFTER_OFF',
  await ev(`JSON.stringify({
    gap: getComputedStyle(document.querySelector('.gd-cells')).gap,
    labels: document.querySelectorAll('.gd-vol').length,
    bars: document.querySelectorAll('.gd-vbar').length,
    pref: localStorage.getItem('hsstudio.display'),
  })`),
)
await ev(`localStorage.removeItem('hsstudio.display'); 1`)
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
process.exit(0)
