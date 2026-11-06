/**
 * 音量控制实测：四条通道（总/音乐/音效/节拍器）+ 静音，
 * 检查 UI 控件存在、拖动能改到引擎、音频图里各总线增益随之变化，并截图。
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9361
const DIR = 'C:/Users/31443/WorkBuddy/2026-09-08-00-44-02'
const OUT = process.argv[2] || `${DIR}/volume-controls.png`
const { spawn } = await import('node:child_process')
const { writeFileSync } = await import('node:fs')

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-vol',
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function waitWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('chrome ws 未就绪')
}
const wsUrl = await waitWs()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.consoleAPICalled')
    logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
  else if (m.method === 'Runtime.exceptionThrown') logs.push(`[EXC] ${m.params.exceptionDetails.text}`)
}
const send = (method, params = {}, sid) => {
  const msg = { id: ++id, method, params }
  if (sid) msg.sessionId = sid
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}

const { result } = await send('Target.createTarget', { url: 'about:blank' })
const { result: att } = await send('Target.attachToTarget', { targetId: result.targetId, flatten: true })
const sid = att.sessionId
await send('Page.enable', {}, sid)
await send('Runtime.enable', {}, sid)
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 2, mobile: false }, sid)
await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, sid)
await new Promise((r) => setTimeout(r, 5000))

const ev = async (expr, label) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid)
  const v = r.result?.result?.value
  console.log(label, typeof v === 'string' ? v : JSON.stringify(v))
  return v
}

// 0) 先看页面整体状态（面板是不是时间轴视图）
await ev(`(() => JSON.stringify({
  title: document.title,
  hasToolbar: !!document.querySelector('.tl-toolbar'),
  toolbarText: (document.querySelector('.tl-toolbar')?.innerText || '').slice(0, 200),
  volCtl: document.querySelectorAll('.vol-ctl').length,
  volRow: document.querySelectorAll('.vol-row').length,
  storePanel: window.__store ? window.__store.getState().panel : 'no-store',
  storePanelOpen: window.__store ? window.__store.getState().panelOpen : 'no-store',
}))()`, 'DIAG')

// 1) 工具条里的音量控件
await ev(`(() => {
  const ctl = document.querySelector('.vol-ctl');
  if (!ctl) return 'NO_VOL_CTL';
  return JSON.stringify({
    hasMuteBtn: !!ctl.querySelector('.tl-btn'),
    inlineSliders: ctl.querySelectorAll('input[type=range]').length,
    popBtnText: [...ctl.querySelectorAll('.tl-btn')].map(b=>b.textContent.trim()),
    labels: [...ctl.querySelectorAll('.vol-label')].map(s=>s.textContent),
  })
})()`, 'TOOLBAR')

// 2) 展开音量面板
await ev(`(() => {
  const btns = [...document.querySelectorAll('.vol-ctl .tl-btn')];
  const b = btns.find(x => x.textContent.includes('音量'));
  if (!b) return 'NO_POP_BTN';
  b.click();
  return 'CLICKED';
})()`, 'OPEN_POP')
await new Promise((r) => setTimeout(r, 400))

await ev(`(() => {
  const pop = document.querySelector('.vol-pop');
  if (!pop) return 'NO_POP';
  return JSON.stringify([...pop.querySelectorAll('.vol-row')].map(r => ({
    label: r.querySelector('.vol-label').textContent,
    val: r.querySelector('.vol-val').textContent,
  })))
})()`, 'POP_ROWS')

// 3) 改四个滑杆 -> 看引擎字段 + 实际增益节点
await ev(`(() => {
  const pop = document.querySelector('.vol-pop');
  const rows = [...pop.querySelectorAll('.vol-row')];
  const want = { '总音量': 0.55, '音乐': 0.42, '音效': 0.33, '节拍器': 0.77 };
  const set = (row, v) => {
    const inp = row.querySelector('input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, String(v));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const r of rows) {
    const key = r.querySelector('.vol-label').textContent;
    if (want[key] !== undefined) set(r, want[key]);
  }
  const e = window.__engine;
  return JSON.stringify({
    master: e.masterVolume, song: e.songVolume, sfx: e.hitsoundVolume, metro: e.metronomeVolume,
  })
})()`, 'SET_VALUES')
await new Promise((r) => setTimeout(r, 300))

// 4) 音频图里真实增益（要先把 ctx 建出来）
await ev(`(() => {
  const e = window.__engine;
  const ctx = e.ensureCtx();
  // 从 destination 反查不方便，直接读引擎内部总线（字段名是私有的但运行时可见）
  const g = (n) => (n ? Number(n.gain.value.toFixed(3)) : null);
  return JSON.stringify({
    ctxState: ctx.state,
    master: g(e.master), sfxBus: g(e.sfxBus), metroBus: g(e.metroBus), songBus: g(e.songBus),
  })
})()`, 'GAIN_NODES')

// 5) 静音：master 应压到 0，且原值保留
await ev(`(() => {
  const e = window.__engine;
  const before = e.masterVolume;
  e.setMuted(true);
  const muted = e.master.gain.value;
  e.setMuted(false);
  return JSON.stringify({ before, mutedGain: muted, restored: e.master.gain.value, keep: e.masterVolume })
})()`, 'MUTE')

// 6) 刷新后是否记住
await ev(`(() => JSON.stringify({
  master: localStorage.getItem('hss.vol.master'),
  song: localStorage.getItem('hss.vol.song'),
  sfx: localStorage.getItem('hss.vol.sfx'),
  metro: localStorage.getItem('hss.vol.metro'),
}))()`, 'PERSIST')

await new Promise((r) => setTimeout(r, 300))
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sid)
const data = shot.result?.data
if (data) { writeFileSync(OUT, Buffer.from(data, 'base64')); console.log('SAVED', OUT) }
else console.log('SHOT_FAILED')

console.log('\n=== console ===')
console.log(logs.length ? logs.slice(0, 20).join('\n') : '(无)')
ws.close()
chrome.kill()
process.exit(0)
