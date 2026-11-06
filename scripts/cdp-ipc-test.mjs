/**
 * 真·文件系统 IPC 功能测试（连到已运行的 Electron）：
 * 写文件 -> 读回 -> 列目录 -> 读二进制，全部走主进程 fs。
 */
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default

const PORT = 9355
const LOG = path.join(process.cwd(), 'electron-ipc-test.log')
try { fs.unlinkSync(LOG) } catch {}
const say = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hss-'))
const FILE = path.join(TMP, 'round-trip.hs.txt').replace(/\\/g, '/')
const CONTENT = '[Metadata]\nTitle=IPC 测试\n[Hitsound]\n/K/\n'

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
await send('Runtime.enable')

const ev = async (expr, label) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  say(label, r.result?.result?.value ?? JSON.stringify(r.result))
}

// 1) 写
await ev(`window.desktop.writeText(${JSON.stringify(FILE)}, ${JSON.stringify(CONTENT)}).then(r=>JSON.stringify(r))`, 'WRITE')
// 2) 读回
await ev(`window.desktop.readText(${JSON.stringify(FILE)}).then(r=>JSON.stringify({ok:r.ok, same: r.text === ${JSON.stringify(CONTENT)}, len: (r.text||'').length, name: r.name}))`, 'READ')
// 3) 列目录
await ev(`window.desktop.listDir(${JSON.stringify(TMP.replace(/\\\\/g,'/'))}).then(r=>JSON.stringify({ok:r.ok, files:(r.files||[]).map(f=>({rel:f.relPath,name:f.name,size:f.size}))}))`, 'LISTDIR')
// 4) 读二进制（应拿到与文本一致的长度）
await ev(`window.desktop.readBinary(${JSON.stringify(FILE)}).then(r=>JSON.stringify({ok:r.ok, bytes: r.data ? r.data.length : 0, name:r.name}))`, 'READBIN')
// 5) 原生确认框（不实际等待用户，验证通道存在）
await ev(`(typeof window.desktop.messageBox === 'function') ? 'messageBox:ok' : 'messageBox:missing'`, 'MSGBOX')
// 6) 菜单回调订阅
await ev(`(() => { const off = window.desktop.onMenu(()=>{}); const ok = typeof off === 'function'; off(); return 'onMenu:' + ok })()`, 'ONMENU')

// 收尾：删掉临时文件
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
ws.close()
process.exit(0)
