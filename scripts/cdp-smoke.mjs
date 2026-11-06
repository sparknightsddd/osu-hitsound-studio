const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9334
const { spawn } = await import('node:child_process')
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--user-data-dir=C:/Users/31443/AppData/Local/Temp/hsstudio-cdp2', 'about:blank'], { stdio: 'ignore' })
async function waitWs(){for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok)return (await r.json()).webSocketDebuggerUrl}catch{}await new Promise(r=>setTimeout(r,250))}throw new Error('no ws')}
const wsUrl = await waitWs()
const ws = new WebSocket(wsUrl)
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let id=0;const pending=new Map()
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}}
function send(method,params={},sid){const msg={id:++id,method,params};if(sid)msg.sessionId=sid;ws.send(JSON.stringify(msg));return new Promise(res=>pending.set(msg.id,res))}
const {result}=await send('Target.createTarget',{url:'about:blank'})
const {result:att}=await send('Target.attachToTarget',{targetId:result.targetId,flatten:true})
const sid=att.sessionId
const errs=[]
await send('Runtime.enable',{},sid)
// 收集 console/exceptions
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.method==='Runtime.exceptionThrown'){errs.push(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text)};if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error'){errs.push('console.error: '+JSON.stringify(m.params.args?.map(a=>a.value||a.description)))}
  if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}}
await send('Page.enable',{},sid)
await send('Page.navigate',{url:'http://127.0.0.1:5173/'},sid)
await new Promise(r=>setTimeout(r,4000))
async function ev(expr){const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true},sid);return r.result?.result?.value}
const out = await ev(`(() => {
  const canvas = document.querySelectorAll('.timeline-wrap canvas').length
  const num = !!document.querySelector('input[type=number]')
  const prog = !!document.querySelector('.timeline-wrap canvas:nth-of-type(2)')
  const tl = document.querySelector('.tl-toolbar')?.textContent || ''
  return { canvas, numInput: num, hasProgress: prog, hasDivLabel: tl.includes('细分'), hasPct: tl.includes('%') }
})()`)
console.log('SMOKE', JSON.stringify(out))
console.log('ERRORS', errs.length ? errs.join('\n') : '(none)')
ws.close(); chrome.kill(); process.exit(0)
