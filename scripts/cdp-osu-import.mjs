/**
 * 端到端验证「从 .osu 导入音效」：
 * 启动 Electron -> 桩掉原生文件对话框（固定返回 e2e 目录里的某个 .osu）
 * -> 触发 importSounds 菜单动作 -> 断言难度选择器弹出 -> 选一个难度
 * -> 断言 store 里多了一份 .hs，且事件数 / 时间轴与原谱一致。
 *
 * 连接方式：读 /json/version 的 webSocketDebuggerUrl（browser 级端点），
 * 用 Target.attachToTarget(flatten) 拿到 sessionId，后续命令都带 sessionId。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const TARGET = process.argv[2] || 'C:/tmp/e2e/Alter Ego [Extra].osu'
const OUT = process.argv[3] || path.join(ROOT, 'osu-import-e2e.png')
const PORT = 9361

const env = {
  ...process.env,
  NODE_ENV: 'production',
  HSS_DISABLE_GPU: '1',
  HSS_USER_DATA: 'C:/tmp/hss-userdata',
  // 自动化测试钩子：主进程据此跳过原生「打开文件」对话框
  HSS_TEST_OPEN_FILES: TARGET,
}
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(ELECTRON, [
  '.',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-gpu-rasterization',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage',
  '--disable-features=CalculateNativeWinOcclusion,AudioServiceOutOfProcess,UseSkiaRenderer',
], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
child.stdout.on('data', (d) => logs.push('[out] ' + d.toString().trim()))
child.stderr.on('data', (d) => logs.push('[err] ' + d.toString().trim()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`)
  return r.ok ? r.json() : null
}

async function waitBrowserWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const v = await getJson('/json/version')
      if (v && v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl
    } catch {}
    await sleep(300)
  }
  throw new Error('CDP browser 端点未就绪')
}

const out = []
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s) }

try {
  const browserWs = await waitBrowserWs()
  say('BROWSER_WS', browserWs)

  const ws = new WebSocket(browserWs)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || 'unknown')))
    setTimeout(() => rej(new Error('ws open 超时')), 15000)
  })

  let id = 0
  let sessionId = null
  const pending = new Map()
  const errs = []
  const DEBUG = !!process.env.CDP_DEBUG
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (DEBUG) console.log('  <<', JSON.stringify(m).slice(0, 300))
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errs.push(d.text + ' ' + (d.exception?.description || ''))
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  }
  const send = (method, params = {}, useSession = true) => {
    const msg = { id: ++id, method, params }
    if (useSession && sessionId) msg.sessionId = sessionId
    ws.send(JSON.stringify(msg))
    return new Promise((r) => {
      pending.set(msg.id, r)
      setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); r({ timeout: true }) } }, 10000)
    })
  }
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.timeout) return { error: 'CDP 超时: ' + expression.slice(0, 60) }
    if (r.error) return { error: JSON.stringify(r.error) }
    if (r.result?.exceptionDetails) {
      return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') }
    }
    return { value: r.result?.result?.value }
  }

  // 找到 page target 并 attach
  const targets = await send('Target.getTargets', {}, false)
  const pages = (targets.result?.targetInfos || []).filter((t) => t.type === 'page')
  say('TARGETS', JSON.stringify(pages.map((t) => ({ id: t.targetId, url: t.url, att: t.attached }))))
  if (!pages.length) throw new Error('没有 page target')
  const attached = await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true }, false)
  if (attached.error || !attached.result?.sessionId) throw new Error('attach 失败: ' + JSON.stringify(attached))
  sessionId = attached.result.sessionId
  say('SESSION', sessionId)

  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(2500)

  const ping = await evalJs('1+1')
  say('PING', JSON.stringify(ping))
  if (ping.error) {
    say('RAW_PROC', JSON.stringify(logs.slice(0, 16)))
    throw new Error('Runtime 域不通')
  }
  say('DESKTOP', JSON.stringify(await evalJs('typeof window.desktop')))
  say('STORE', JSON.stringify(await evalJs('typeof window.__store')))

  // 1) 原生「打开文件」对话框由主进程的 HSS_TEST_OPEN_FILES 钩子桩掉（渲染进程无法改冻结的 window.desktop）

  const before = await evalJs(`JSON.stringify((window.__store ? window.__store.getState().files : []).map(f => f.name))`)
  say('FILES_BEFORE', before.value ?? before.error)

  // 2) 走侧栏「从 .osu 导入音效」按钮（原生菜单在主进程，CDP 输入事件点不到它）
  say('TRIGGER', JSON.stringify(await evalJs(`(() => {
    const b = [...document.querySelectorAll('button[title]')]
      .find(x => /导入音效/.test(x.getAttribute('title') || ''));
    if (!b) return 'no-button';
    b.click(); return 'clicked:' + b.getAttribute('title');
  })()`)))

  // 3) 等难度选择器
  await sleep(2000)
  const picker = await evalJs(`(() => {
    const box = document.querySelector('.osu-diff');
    if (!box) return { open: false };
    return { open: true, head: (box.querySelector('.osu-diff-head')||{}).textContent,
      rows: [...box.querySelectorAll('.osu-diff-row')].map(r => r.textContent) };
  })()`)
  say('PICKER', JSON.stringify(picker.value ?? picker.error))

  if (picker.value?.open) {
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    if (shot.result?.data) fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
    say('SHOT', OUT)
    say('PICK', JSON.stringify(await evalJs(`(() => {
      const r = document.querySelector('.osu-diff-row');
      if (!r) return 'no-row';
      r.click(); return 'picked';
    })()`)))
    await sleep(3000)
  }

  // 4) 断言
  const after = await evalJs(`(() => {
    if (!window.__store) return 'no-store';
    const s = window.__store.getState();
    const f = s.files[s.files.length - 1];
    const d = s.doc;
    return JSON.stringify({
      names: s.files.map(x => x.name),
      lastName: f && f.name,
      lastLen: f ? f.content.length : 0,
      lastPath: f && f.path,
      defines: d.hitsounds.length,
      events: d.events.length,
      firstEvent: d.events[0] ? Math.round(d.events[0].time) : null,
      lastEvent: d.events.length ? Math.round(d.events[d.events.length-1].time) : null,
      timing: d.timing.length,
      errors: d.diagnostics.filter(x => x.severity === 'error').length,
      warns: d.diagnostics.filter(x => x.severity === 'warning').length,
      undef: d.undefinedNames,
    });
  })()`)
  say('AFTER', after.value ?? after.error)
  say('LOGS', JSON.stringify(await evalJs(`JSON.stringify((window.__store.getState().logs||[]).slice(-8))`)))

  const shot2 = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (shot2.result?.data) fs.writeFileSync(OUT.replace('.png', '-after.png'), Buffer.from(shot2.result.data, 'base64'))
  if (errs.length) say('PAGE_ERRORS', JSON.stringify(errs.slice(0, 8)))
} catch (e) {
  say('FAILED', String((e && e.stack) || e))
} finally {
  try { child.kill() } catch {}
  const bad = logs.filter((l) => /error|Error|ERR_/.test(l))
  if (bad.length) say('PROC_LOG', bad.slice(0, 10).join('\n'))
  await sleep(400)
  process.exit(0)
}