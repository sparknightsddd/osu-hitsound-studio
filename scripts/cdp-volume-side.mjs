/** 侧栏（音频与试听）里的平铺版音量控件检查 */
const PORT = 9361
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => {
  const m = { id: ++id, method, params }
  ws.send(JSON.stringify(m))
  return new Promise((r) => pending.set(m.id, r))
}
const ev = async (expr, label) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(label, r.result?.result?.value)
  return r.result?.result?.value
}

// 切到「音频与试听」侧栏
await ev(`(() => { const s = window.__store.getState(); s.setSidebar('audio'); return s.sidebar })()`, 'SIDEBAR')
await new Promise((r) => setTimeout(r, 600))
await ev(`(() => JSON.stringify({
  panels: document.querySelectorAll('.vol-panel').length,
  rows: [...document.querySelectorAll('.vol-panel .vol-row')].map(r => ({
    label: r.querySelector('.vol-label').textContent,
    val: r.querySelector('.vol-val').textContent,
  })),
}))()`, 'SIDE_ROWS')

// 改侧栏里的「音乐」滑杆，看引擎跟上没有
await ev(`(() => {
  const rows = [...document.querySelectorAll('.vol-panel .vol-row')];
  const r = rows.find(x => x.querySelector('.vol-label').textContent === '音乐');
  if (!r) return 'NO_ROW';
  const inp = r.querySelector('input[type=range]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '0.25');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  const e = window.__engine;
  return JSON.stringify({ song: e.songVolume, songBusGain: e.songBus ? Number(e.songBus.gain.value.toFixed(3)) : null });
})()`, 'SIDE_SET')

ws.close()
process.exit(0)
