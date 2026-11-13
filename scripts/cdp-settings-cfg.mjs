/**
 * settings.cfg 端到端：
 *  1) 首次启动 → userData 下自动生成 settings.cfg（含八个段、12 个组合）
 *  2) 设置窗口改一项并保存 → 文件对应行的值跟着变
 *  3) 手动改文件（主题 / Timing / 显示）→ 重启后生效，且启动不会把文件覆盖回去
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9755
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hss-cfg-'))
const CFG = path.join(USERDATA, 'settings.cfg')

let pass = 0
let fail = 0
function T(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

let child = null
let ws = null
let seq = 0
const pending = new Map()

async function launch() {
  const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: USERDATA }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HSS_SETTING_FILE
  child = spawn(
    ELECTRON,
    ['.', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + USERDATA, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let page = null
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        page = (await r.json()).find((t) => t.type === 'page')
        if (page) break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!page) throw new Error('CDP 未就绪')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  // 等 React 挂载（initSettingsFile 在 render 之前跑完，这里看到 __store 就说明文件已处理）
  for (let i = 0; i < 60; i++) {
    if (await ev('!!window.__store')) break
    await new Promise((r) => setTimeout(r, 150))
  }
  await wait(600)
}

function send(method, params = {}) {
  const msg = { id: ++seq, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text }
  return r.result?.result?.value
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function closeApp() {
  try {
    ws?.close()
  } catch {}
  try {
    child?.kill()
  } catch {}
  ws = null
  child = null
  // 等端口真的释放，否则第二次启动会连到旧进程
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`)
    } catch {
      return
    }
    await wait(200)
  }
}

function readCfg() {
  try {
    return fs.readFileSync(CFG, 'utf8')
  } catch {
    return ''
  }
}

function cfgValue(text, section, key) {
  const lines = text.split(/\r?\n/)
  let cur = ''
  for (const line of lines) {
    const m = /^\s*\[([^\]]+)\]/.exec(line)
    if (m) {
      cur = m[1].toLowerCase()
      continue
    }
    if (cur !== section.toLowerCase()) continue
    const kv = /^\s*([^=#;]+?)\s*=\s*(.*?)\s*$/.exec(line)
    if (!kv || kv[1].toLowerCase() !== key.toLowerCase()) continue
    // 去掉行尾注释（引号里的 # 不算），再去引号
    const raw = kv[2]
    let inQ = false
    let cut = raw.length
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (c === '"') inQ = !inQ
      else if (!inQ && (c === '#' || c === ';') && (i === 0 || /\s/.test(raw[i - 1]))) {
        cut = i
        break
      }
    }
    return raw.slice(0, cut).trim().replace(/^"|"$/g, '')
  }
  return null
}

try {
  // ---------- 1) 首次启动 ----------
  console.log('\n[1] 首次启动自动生成')
  await launch()
  const p = await ev('window.desktop.settingsPath()')
  T('settingsPath 指向 userData/settings.cfg', String(p).replace(/\\/g, '/').toLowerCase() === CFG.replace(/\\/g, '/').toLowerCase(), String(p))
  T('settings.cfg 已生成', fs.existsSync(CFG), CFG)

  const text = readCfg()
  T('带文件头注释', text.includes('osu Hitsound Studio · settings.cfg'))
  for (const sec of ['[General]', '[Appearance]', '[Language]', '[Import]', '[ImportColors]', '[Timing]', '[Export]', '[Chart]']) {
    T(`包含 ${sec}`, text.includes(sec))
  }
  T('12 个组合代号占 12 行', (text.match(/^(soft|normal|drum)-hit(normal|whistle|finish|clap)\s*=/gm) || []).length === 24, String((text.match(/^(soft|normal|drum)-hit(normal|whistle|finish|clap)\s*=/gm) || []).length))
  T('槽位顺序写了 9 个', (cfgValue(text, 'Export', 'SlotOrder') || '').split(',').filter(Boolean).length === 9)
  T('PreferredIndex 是 {..} 形式', (cfgValue(text, 'Chart', 'PreferredIndex') || '').includes('{'), cfgValue(text, 'Chart', 'PreferredIndex'))

  const loaded = await ev(
    `window.desktop.loadSettings().then(r => JSON.stringify({ ok: r.ok, exists: r.exists, path: r.path, len: r.text.length }))`,
  )
  const lj = JSON.parse(String(loaded))
  T('IPC 读回来和磁盘一致', lj.exists && lj.len === text.length, loaded)

  // ---------- 2) 设置窗口保存 ----------
  console.log('\n[2] 设置窗口保存写回文件')
  await ev('window.__openAppSettings()')
  await wait(500)
  const tabOk = await ev(`(() => {
    const b = [...document.querySelectorAll('.set-tab')].find(x => x.textContent.includes('Timing'))
    if (!b) return false
    b.click()
    return true
  })()`)
  T('设置窗口打开并切到 Timing 页', tabOk === true)
  await wait(300)
  const beforeAlpha = cfgValue(readCfg(), 'Timing', 'ColorAlphaByVol')
  T('保存前 ColorAlphaByVol = true', String(beforeAlpha).trim() === 'true', String(beforeAlpha))
  const clicked = await ev(`(() => {
    const box = [...document.querySelectorAll('.set-body .set-check')].find(x => x.textContent.includes('不透明度'))
    const input = box && box.querySelector('input[type=checkbox]')
    if (!input) return ''
    input.click()
    return String(input.checked)
  })()`)
  T('取消勾选「不透明度随音量」', clicked === 'false', String(clicked))
  await ev(`document.querySelector('.si-ok')?.click()`)
  await wait(900)
  const afterAlpha = cfgValue(readCfg(), 'Timing', 'ColorAlphaByVol')
  T('文件里的 ColorAlphaByVol 变成 false', String(afterAlpha).trim() === 'false', String(afterAlpha))
  T('保存后设置窗口关闭', (await ev(`!!document.querySelector('.set-dialog')`)) === false)
  T('其它段还在（没被写残）', readCfg().includes('[ImportColors]') && readCfg().includes('[Chart]'))

  // ---------- 2.5) 手改 + 重新读取（不重启） ----------
  console.log('\n[2.5] 重新读取按钮')
  fs.writeFileSync(CFG, readCfg().replace(/^(InheritMs\s*=\s*).*$/m, '$12222'), 'utf8')
  await ev('window.__openAppSettings()')
  await wait(400)
  await ev(`[...document.querySelectorAll('.set-tab')].find(x => x.textContent.trim() === '常规')?.click()`)
  await wait(250)
  const reloadBtn = await ev(`(() => {
    const b = [...document.querySelectorAll('.set-body .btn')].find(x => x.textContent.trim() === '重新读取')
    if (!b) return false
    b.click()
    return true
  })()`)
  T('常规页有「重新读取」按钮', reloadBtn === true)
  await wait(700)
  const t2 = await ev(`localStorage.getItem('hsstudio.timing') || ''`)
  T('重新读取后 InheritMs 立即变成 2222', String(t2).includes('2222'), String(t2))
  const msg = await ev(`document.querySelector('.set-body')?.textContent.includes('已重新读取')`)
  T('界面给出「已重新读取」提示', msg === true)
  await ev(`document.querySelector('.osu-diff-cancel')?.click()`)
  await wait(300)

  await closeApp()

  // ---------- 3) 手改 → 重启生效 ----------
  console.log('\n[3] 手改文件后重启')
  const hand = readCfg()
    .replace(/^(Theme\s*=\s*).*$/m, '$1"dark"')
    .replace(/^(InheritMs\s*=\s*).*$/m, '$11234')
    .replace(/^(ColorAlphaByVol\s*=\s*).*$/m, '$1true')
    .replace(/^(soft-hitnormal\s*=\s*).*$/m, '$1"Zz"')
  fs.writeFileSync(CFG, hand, 'utf8')
  T('手改后的文件写入成功', fs.readFileSync(CFG, 'utf8').includes('1234'))

  await launch()
  const state = await ev(`(() => {
    const t = localStorage.getItem('hsstudio.timing') || ''
    const codes = localStorage.getItem('hsstudio.importCodes') || ''
    const theme = localStorage.getItem('hss.theme')
    const display = window.__displayPrefs.get()
    return JSON.stringify({ theme, timing: t, codes, display, attr: document.documentElement.getAttribute('data-theme') })
  })()`)
  const st = JSON.parse(String(state))
  T('主题按文件改成 dark', st.theme === 'dark', String(st.theme))
  T('页面 data-theme 也是 dark', st.attr === 'dark', String(st.attr))
  T('InheritMs 应用成 1234', st.timing.includes('1234'), st.timing)
  T('导入代号应用成 Zz', st.codes.includes('Zz'), st.codes)
  T('显示偏好跟着文件走（true）', st.display.colorAlphaByVol === true, JSON.stringify(st.display))
  await wait(400)
  T('启动不会把手改的文件覆盖回去', readCfg().includes('1234') && readCfg().includes('"dark"'))

  await closeApp()
} catch (e) {
  fail++
  console.log('  ✗ 运行出错：', e && e.stack ? e.stack.split('\n')[0] : String(e))
  await closeApp()
}

try {
  fs.rmSync(USERDATA, { recursive: true, force: true })
} catch {}

console.log(`\n${fail ? `${fail} 项失败` : '全部通过'}（${pass} 项）`)
process.exit(fail ? 1 : 0)
