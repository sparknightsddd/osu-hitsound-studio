/**
 * 验证：拖动时间轴底部滑块时，主画布（音效行）是否跟着左右平移。
 * 用合成 PointerEvent 在 mini canvas 上从 20px 拖到 220px，
 * 比较主画布前后像素数据 + 时间显示是否没被 seek。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9361
const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)

async function waitWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page')
        if (page) return page.webSocketDebuggerUrl
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('electron CDP 未就绪')
}

const fail = (msg) => {
  console.log('FAIL', msg)
  child.kill()
  process.exit(1)
}

try {
  const ws = new WebSocket(await waitWs())
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
  const send = (method, params = {}) => {
    const msg = { id: ++id, method, params }
    ws.send(JSON.stringify(msg))
    return new Promise((res) => pending.set(msg.id, res))
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await new Promise((r) => setTimeout(r, 2500))
  // 先强制渲染一帧，确保布局/ResizeObserver 已经跑过
  try {
    await send('Page.captureScreenshot', { format: 'png' })
  } catch {}
  await new Promise((r) => setTimeout(r, 500))

  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      const st = window.__store;
      if (st) {
        const s0 = st.getState();
        if (s0.panel !== 'timeline') s0.setPanel('timeline');
        if (!s0.panelOpen) s0.togglePanel();
      }
      await new Promise((r3) => setTimeout(r3, 400));
      const cs = [...document.querySelectorAll('.timeline-wrap canvas')];
      if (cs.length < 2)
        return JSON.stringify({
          error: 'canvas 不足 ' + cs.length,
          all: document.querySelectorAll('canvas').length,
          text: (document.body.innerText || '').slice(0, 160),
        });
      const main = cs[0], mini = cs[1];
      const timeEl = document.querySelector('.tl-toolbar .mono');
      const beforePx = main.toDataURL();
      const beforeMini = mini.toDataURL();
      const beforeTime = timeEl ? timeEl.textContent : '';
      const rect = mini.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const fire = (type, x) => mini.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 7, pointerType: 'mouse', isPrimary: true, buttons: 1,
      }));
      fire('pointerdown', rect.left + 20);
      for (let k = 1; k <= 8; k++) fire('pointermove', rect.left + 20 + k * 25);
      fire('pointerup', rect.left + 220);
      await new Promise((r2) => setTimeout(r2, 300));
      const afterPx = main.toDataURL();
      const afterMini = mini.toDataURL();
      const afterTime = timeEl ? timeEl.textContent : '';
      return JSON.stringify({
        beforeTime, afterTime,
        timeUnchanged: beforeTime === afterTime,
        pixelsChanged: beforePx !== afterPx,
        miniChanged: beforeMini !== afterMini,
        miniW: Math.round(rect.width),
        mainSize: main.width + 'x' + main.height,
        miniSize: mini.width + 'x' + mini.height,
        events: (window.__store ? window.__store.getState().files.length : -1),
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 140),
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  const out = r.result?.result?.value
  console.log('RESULT', out)
  const o = JSON.parse(out || '{}')
  if (o.error) fail(o.error)
  if (!o.pixelsChanged) fail('主画布没有变化（没有平移）')
  if (!o.timeUnchanged) fail('拖动滑块时不该 seek 播放头')
  console.log('PASS 拖动滑块 -> 音效行跟着平移，且播放头没有被移动')
  // 顺手存一张截图，方便看滑块样式
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const b64 = shot.result?.data
  if (b64) {
    const out = process.argv[2] || path.join(ROOT, 'ui-scrollbar.png')
    fs.writeFileSync(out, Buffer.from(b64, 'base64'))
    console.log('SHOT', out)
  }
  ws.close()
  child.kill()
  process.exit(0)
} catch (e) {
  fail(e.message)
}
