/**
 * 端到端验证音频自动加载：
 * 1) 打开歌曲文件夹 → 歌曲 + 音效样本都应载入
 * 2) 从一个谱切到另一个谱 → 歌曲与音效应跟着换，不能还用上一份谱的
 *
 * 与 cdp-osu-import 一样，靠主进程的 HSS_TEST_OPEN_FILES / HSS_TEST_OPEN_FOLDER 钩子
 * 跳过原生对话框。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { readdirSync } = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const SONG_DIR = process.argv[2] || 'E:/osu/Songs/2267616 Atarayo - Boku wa (TV Size)'
const OUT = process.argv[3] || path.join(ROOT, 'audio-load-e2e.png')
const PORT = 9362

const env = {
  ...process.env,
  NODE_ENV: 'production',
  HSS_DISABLE_GPU: '1',
  HSS_USER_DATA: 'C:/tmp/hss-userdata-audio',
  HSS_TEST_OPEN_FOLDER: SONG_DIR,
  // 「从 .osu 导入音效」要选的文件：优先取该目录下唯一的 .osu
  HSS_TEST_OPEN_FILES: (() => {
    try {
      const osus = readdirSync(SONG_DIR).filter((n) => /\.osu$/i.test(n))
      return osus.length ? path.join(SONG_DIR, osus[0]) : ''
    } catch {
      return ''
    }
  })(),
}
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  ELECTRON,
  [
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
  ],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)
const logs = []
child.stdout.on('data', (d) => logs.push('[out] ' + d.toString().trim()))
child.stderr.on('data', (d) => logs.push('[err] ' + d.toString().trim()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log(a.join(' '))

async function getJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`)
  return r.ok ? r.json() : null
}

try {
  let browserWs = null
  for (let i = 0; i < 100 && !browserWs; i++) {
    try {
      const v = await getJson('/json/version')
      if (v?.webSocketDebuggerUrl) browserWs = v.webSocketDebuggerUrl
    } catch {}
    if (!browserWs) await sleep(300)
  }
  if (!browserWs) throw new Error('CDP 未就绪')
  say('WS', browserWs)

  const ws = new WebSocket(browserWs)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
    setTimeout(() => rej(new Error('ws open 超时')), 15000)
  })
  let id = 0
  let sessionId = null
  const pending = new Map()
  const errs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
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
      setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); r({ timeout: true }) } }, 15000)
    })
  }
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.timeout) return { error: 'CDP 超时' }
    if (r.error) return { error: JSON.stringify(r.error) }
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') }
    return { value: r.result?.result?.value }
  }

  const targets = await send('Target.getTargets', {}, false)
  const pages = (targets.result?.targetInfos || []).filter((t) => t.type === 'page')
  if (!pages.length) throw new Error('没有 page target')
  const attached = await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true }, false)
  sessionId = attached.result.sessionId
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(2500)

  const ping = await evalJs('1+1')
  say('PING', JSON.stringify(ping))
  if (ping.error) { say('LOG', JSON.stringify(logs.slice(0, 10))); throw new Error('Runtime 域不通') }

  const state = `(() => {
    const s = window.__store.getState();
    const eng = window.__engine;
    return JSON.stringify({
      files: s.files.map(f => ({ name: f.name, path: f.path || '', id: f.id })),
      active: (s.files.find(f => f.id === s.activeId) || {}).name,
      defines: s.doc.hitsounds.length,
      events: s.doc.events.length,
      song: eng ? eng.songName : '(no-engine)',
      hasSong: eng ? !!eng.hasSong : false,
      songDur: eng ? Math.round(eng.durationMs || 0) : 0,
      samples: eng && eng.boundSampleNames ? eng.boundSampleNames() : [],
      bindings: Object.keys(s.bindings || {}),
    });
  })()`

  // 1) 先走「从 .osu 导入音效」造一份带 [Define] 的谱（这份才需要音效样本），
  //    顺带验证导入后有没有自动把该目录的音频配上。
  say('IMPORT', JSON.stringify(await evalJs(`(async () => {
    const b = [...document.querySelectorAll('button[title]')].find(x => /导入音效/.test(x.getAttribute('title')||''));
    if (!b) return 'no-button';
    b.click(); return 'clicked';
  })()`)))
  await sleep(2500)
  say('PICK', JSON.stringify(await evalJs(`(() => {
    const r = document.querySelector('.osu-diff-row') || (window.__store.getState().files.length > 1 ? null : null);
    if (!r) return 'no-row (可能只有一份难度，已自动选中)';
    r.click(); return 'picked';
  })()`)))
  await sleep(7000)
  const afterImport = await evalJs(state)
  say('AFTER_IMPORT', afterImport.value ?? afterImport.error)

  // 2) 切到另一份谱（demo），样本应该被清掉、歌曲也不该继续用上一份谱的
  say('SWITCH', JSON.stringify(await evalJs(`(() => {
    const s = window.__store.getState();
    const other = s.files.find(f => f.name !== s.files.find(x => x.id === s.activeId)?.name);
    if (!other) return 'no-other';
    s.setActive(other.id);
    return 'switched:' + other.name;
  })()`)))
  await sleep(6000)
  const afterSwitch = await evalJs(state)
  say('AFTER_SWITCH', afterSwitch.value ?? afterSwitch.error)

  // 3) 再切回刚才那份，样本与歌曲都应恢复
  say('SWITCH_BACK', JSON.stringify(await evalJs(`(() => {
    const s = window.__store.getState();
    const back = s.files.find(f => /Kinomi/.test(f.name));
    if (!back) return 'no-back';
    s.setActive(back.id);
    return 'back:' + back.name;
  })()`)))
  await sleep(6000)
  const afterBack = await evalJs(state)
  say('AFTER_BACK', afterBack.value ?? afterBack.error)

  const logsOut = await evalJs(`JSON.stringify((window.__store.getState().output || []).slice(-22))`)
  say('LOGS', logsOut.value ?? logsOut.error)

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (shot.result?.data) fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
  say('SHOT', OUT)
  if (errs.length) say('PAGE_ERRORS', JSON.stringify(errs.slice(0, 6)))
} catch (e) {
  say('FAILED', String(e?.stack || e))
} finally {
  try { child.kill() } catch {}
  const bad = logs.filter((l) => /error|Error|ERR_/.test(l))
  if (bad.length) say('PROC_LOG', bad.slice(0, 8).join('\n'))
  await sleep(300)
  process.exit(0)
}