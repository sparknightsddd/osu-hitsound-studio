/** 重载 Electron 页面并抓取加载期 console / 异常，定位空白屏原因 */
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const PORT = 9355
const LOG = path.join(process.cwd(), 'electron-reload.log')
try { fs.unlinkSync(LOG) } catch {}
const say = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n')

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })

let id = 0
const pending = new Map()
const msgs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled')
    msgs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? (a.preview && a.preview.description) ?? '').join(' ')}`)
  else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    msgs.push(`[EXC] ${d.text} | ${d.exception?.description ?? ''} | at ${d.lineNumber}:${d.columnNumber} ${d.url || ''}`)
  } else if (m.method === 'Log.entryAdded') {
    msgs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`)
  }
}
const send = (method, params = {}) => {
  const m = { id: ++id, method, params }
  ws.send(JSON.stringify(m))
  return new Promise((r) => pending.set(m.id, r))
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 4000))

const st = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    ready: document.readyState,
    root: document.getElementById('root')?.children.length ?? -1,
    htmlLen: document.body.innerHTML.length,
    scripts: [...document.scripts].map(s=>s.src||'inline'),
    text: (document.body.innerText||'').slice(0,200),
  })`,
  returnByValue: true,
})
say('STATE', st.result?.result?.value)
say('--- console/exception ---')
say(msgs.slice(0, 40).join('\n') || '(无)')
ws.close()
process.exit(0)
