/**
 * 关闭谱面标签时的「保存 / 不保存 / 取消」。
 *
 * 分三次启动应用（HSS_TEST_MESSAGEBOX 分别返回 2 / 1 / 0）：
 *   - 取消：标签留着，改动还在，磁盘不动；
 *   - 不保存：标签关掉，磁盘不动；
 *   - 保存：写回磁盘后关掉，且**不会**再弹「文件已存在，是否覆盖？」。
 * 顺带检查弹窗确实是三个按钮、未保存标签的圆点在 hover 时变成 ×。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))

const DISK = `[Metadata]
Title = close test

[Files]
audio = ""

[Define]
hitsound custom Aa = default.normal-hitnormal

[Timing]
0,bpm(120),4,0,0

[Hitsound]
/Aa = = =/
`
const CLEAN = DISK.replace('close test', 'other')

let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

/** 跑一次应用，answer = messageBox 的返回索引 */
async function run(answer, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsclose-'))
  const chart = path.join(dir, 'a.hs')
  fs.writeFileSync(chart, DISK, 'utf8')
  const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HSS_USER_DATA: USERDATA,
    HSS_TEST_MESSAGEBOX: String(answer),
  }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(
    ELECTRON,
    ['.', `--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const dialogs = []
  let buf = ''
  child.stdout.on('data', (b) => {
    buf += b.toString()
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('[messagebox]')) dialogs.push(line.replace('[messagebox] ', ''))
    }
  })

  let wsUrl = ''
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
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
  if (!wsUrl) throw new Error('CDP 未就绪')

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

  await send('Runtime.enable')
  await wait(3200)

  // 造两份谱：a.hs 关联磁盘并改脏，b.hs 干净的对照
  const setup = JSON.parse(
    await ev(`(() => {
      const s = window.__store.getState()
      const a = s.addFile('a.hs', ${JSON.stringify(DISK)})
      s.attachPath(a, ${JSON.stringify(chart.replace(/\\/g, '/'))}, ${JSON.stringify(DISK)})
      s.updateContent(a, ${JSON.stringify(DISK + '\n/Aa Aa/\n')})
      const b = s.addFile('b.hs', ${JSON.stringify(CLEAN)})
      s.setActive(a)
      return JSON.stringify({ a, b, names: window.__store.getState().files.map((f) => f.name) })
    })()`),
  )
  await wait(900)

  // 标签按钮：脏标签是圆点，hover 才变 ×
  const mark = JSON.parse(
    await ev(`(() => {
      const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.name')?.textContent === 'a.hs')
      const btn = tab.querySelector('.x')
      const tab2 = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.name')?.textContent === 'b.hs')
      return JSON.stringify({
        dirty: btn.classList.contains('dirty'),
        dot: !!btn.querySelector('.dot'),
        svg: getComputedStyle(btn.querySelector('svg')).display,
        cleanHasDot: !!tab2.querySelector('.dot'),
        rect: (() => { const r = tab.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })(),
      })
    })()`),
  )
  T('未保存的标签显示圆点', mark.dirty && mark.dot, JSON.stringify(mark))
  T('圆点状态下 × 图标隐藏', mark.svg === 'none', mark.svg)
  T('干净的标签没有圆点', !mark.cleanHasDot)

  // 鼠标移到标签上：圆点消失、× 出现
  // 先从旁边挪一下再进标签，避免「坐标没变」时浏览器不更新 hover 状态
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mark.rect.x - 40, y: mark.rect.y })
  await wait(120)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mark.rect.x, y: mark.rect.y })
  await wait(450)
  const hover = JSON.parse(
    await ev(`(() => {
      const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.name')?.textContent === 'a.hs')
      const btn = tab.querySelector('.x')
      return JSON.stringify({ dot: getComputedStyle(btn.querySelector('.dot')).display, svg: getComputedStyle(btn.querySelector('svg')).display })
    })()`),
  )
  T('hover 时圆点藏起来、换成 ×', hover.dot === 'none' && hover.svg !== 'none', JSON.stringify(hover))

  // 点 ×
  await ev(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.name')?.textContent === 'a.hs')
    tab.querySelector('.x').click()
    return 'ok'
  })()`)
  await wait(1200)

  const after = JSON.parse(
    await ev(`(() => {
      const s = window.__store.getState()
      const a = s.files.find((f) => f.name === 'a.hs')
      return JSON.stringify({
        names: s.files.map((f) => f.name),
        active: s.files.find((f) => f.id === s.activeId)?.name || '',
        keptEdit: a ? a.content.includes('/Aa Aa/') : null,
        dirty: a ? !!a.dirty : null,
      })
    })()`),
  )
  const disk = fs.readFileSync(chart, 'utf8')

  // 再点一次干净标签的 ×：不该弹窗
  await ev(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.name')?.textContent === 'b.hs')
    tab?.querySelector('.x')?.click()
    return 'ok'
  })()`)
  await wait(600)
  const names2 = JSON.parse(await ev(`JSON.stringify(window.__store.getState().files.map((f) => f.name))`))

  child.kill()
  await wait(400)
  ws.close()
  return { after, disk, dialogs, names2, errors }
}

const base = 9440
// 2 = 取消
{
  const r = await run(2, base)
  console.log('CANCEL', JSON.stringify({ names: r.after.names, kept: r.after.keptEdit, dialogs: r.dialogs, errors: r.errors }))
  T('取消：弹窗是 保存 / 不保存 / 取消 三个按钮', r.dialogs[0] === JSON.stringify({ buttons: ['保存', '不保存', '取消'], title: '未保存的改动' }), r.dialogs[0] || '(无)')
  T('取消：标签还开着', r.after.names.includes('a.hs'), r.after.names.join(','))
  T('取消：改动还在', r.after.keptEdit === true && r.after.dirty === true, String(r.after.keptEdit))
  T('取消：磁盘没被写', r.disk === DISK, r.disk.length + 'B')
  T('取消：干净标签点 × 不弹窗（全程只有 1 次）', r.dialogs.length === 1 && !r.names2.includes('b.hs'), `${r.dialogs.length}/${r.names2.join(',')}`)
}

// 1 = 不保存
{
  const r = await run(1, base + 1)
  console.log('DISCARD', JSON.stringify({ names: r.after.names, dialogs: r.dialogs, errors: r.errors }))
  T('不保存：标签关掉了', !r.after.names.includes('a.hs'), r.after.names.join(','))
  T('不保存：磁盘没被写', r.disk === DISK)
  T('不保存：只弹了一次窗', r.dialogs.length === 1, String(r.dialogs.length))
  T('不保存：打开的谱还在（b.hs）', r.after.names.includes('b.hs'), r.after.names.join(','))
}

// 0 = 保存
{
  const r = await run(0, base + 2)
  console.log('SAVE', JSON.stringify({ names: r.after.names, dialogs: r.dialogs, errors: r.errors }))
  T('保存：标签关掉了', !r.after.names.includes('a.hs'), r.after.names.join(','))
  T('保存：改动写回磁盘', r.disk.includes('/Aa Aa/') && r.disk !== DISK, r.disk.split('\n').slice(-3).join(' / '))
  T('保存：没有再弹「文件已存在」', r.dialogs.length === 1 && r.dialogs[0].includes('保存'), `${r.dialogs.length} / ${r.dialogs.join(' | ')}`)
  T('保存：没有运行时异常', r.errors.length === 0, r.errors.slice(0, 3).join(' | '))
}

console.log(`RESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
