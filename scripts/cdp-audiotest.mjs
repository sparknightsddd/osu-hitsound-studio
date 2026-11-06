// 用 CDP 驱动 headless Chrome，实测两条播放路径（WebAudio 音效 / <audio> 歌曲）
// 用法: node scripts/cdp-audiotest.mjs [chrome路径]
const CHROME =
  process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const URL_APP = 'http://127.0.0.1:5173/'

const { spawn } = await import('node:child_process')

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-cdp',
    'about:blank',
  ],
  { detached: false, stdio: 'ignore' },
)

async function waitForWs(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Chrome 调试端口未就绪')
}

const wsUrl = await waitForWs()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params }
  if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg))
  return new Promise((res) => pending.set(msg.id, res))
}

const { result } = await send('Target.createTarget', { url: 'about:blank' })
const sessionId = result.targetId
const { result: att } = await send('Target.attachToTarget', { targetId: sessionId, flatten: true })
const sid = att.sessionId

async function evalJs(expr) {
  const r = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true },
    sid,
  )
  if (r.result?.exceptionDetails) {
    return { __error: r.result.exceptionDetails.exception?.description || 'eval error' }
  }
  if (r.result?.result?.value !== undefined) return r.result.result.value
  return r.result
}

await send('Page.enable', {}, sid)
await send('Page.navigate', { url: URL_APP }, sid)
await new Promise((r) => setTimeout(r, 3500))

const probe = `(async () => {
  const E = window.__engine
  const out = { hasEngine: !!E }
  if (!E) return out

  // ---- 构造一个 1 秒 440Hz 正弦 WAV ----
  function makeWav(seconds, freq) {
    const sr = 44100, n = Math.floor(sr * seconds)
    const buf = new ArrayBuffer(44 + n * 2)
    const v = new DataView(buf)
    const w = (o, s) => { for (let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)) }
    w(0,'RIFF'); v.setUint32(4, 36+n*2, true); w(8,'WAVE'); w(12,'fmt ')
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true)
    v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true)
    w(36,'data'); v.setUint32(40, n*2, true)
    for (let i=0;i<n;i++) v.setInt16(44+i*2, Math.round(Math.sin(2*Math.PI*freq*i/sr)*20000), true)
    return buf
  }
  const file = new File([makeWav(1, 440)], 'test.wav', { type: 'audio/wav' })

  // ---- A. WebAudio 音效路径 ----
  try {
    await E.bindSample('T', file)
    out.bindOk = true
  } catch (e) { out.bindError = String(e && e.message || e) }
  out.hasSound = E.hasSound('T')
  const b = E.bufferFor('T')
  out.buffer = b ? { dur: +b.duration.toFixed(3), ch: b.numberOfChannels, sr: b.sampleRate } : null
  const ctx = E.ensureCtx()
  out.ctx = { state: ctx.state, sr: ctx.sampleRate, t: +ctx.currentTime.toFixed(3) }
  try { await ctx.resume() } catch (e) {}
  out.ctxAfterResume = ctx.state
  out.masterGain = E.masterVolume
  out.playReturn = E.playSample('T', 100)

  // ---- B. <audio> 歌曲路径 ----
  try {
    await E.loadSong(file)
    out.loadSongOk = true
  } catch (e) { out.loadSongError = String(e && e.message || e) }
  const el = E.songEl
  if (!el) { out.songEl = null } else {
    out.songEl = { src: el.src.slice(0, 24), volume: el.volume, muted: el.muted, rate: el.playbackRate, inDom: document.contains(el) }
    await new Promise((r) => { 
      if (el.readyState >= 1) return r()
      el.addEventListener('loadedmetadata', r, { once: true })
      el.addEventListener('error', r, { once: true })
      setTimeout(r, 3000)
    })
    out.songEl.readyState = el.readyState
    out.songEl.duration = el.duration
    out.songEl.error = el.error ? { code: el.error.code, msg: el.error.message } : null
    out.songEl.networkState = el.networkState
    E.play()
    await new Promise((r) => setTimeout(r, 500))
    out.songEl.pausedAfterPlay = el.paused
    out.songEl.currentTimeAfterPlay = el.currentTime
    E.pause()
  }

  // ---- C. 默认音效路径（对照） ----
  out.defaultRefs = [...E.defaultBuffers.keys()]
  out.customNames = E.sampleNames()
  return out
})()`

const res = await evalJs(probe)
console.log(JSON.stringify(res, null, 2))

ws.close()
chrome.kill()
process.exit(0)
