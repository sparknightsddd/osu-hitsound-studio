/**
 * i18n 端到端：
 *  - 默认中文；切到 en-US 后整棵界面变英文；
 *  - 已安装的 .lang（userData/langs）能列出来并切换；
 *  - 运行时 installLangText 会写盘，removeLang 会删掉；
 *  - 语言包缺翻译时回落到中文。
 */
const { spawn } = await import('node:child_process')
const path = (await import('node:path')).default
const fs = (await import('node:fs')).default
const os = (await import('node:os')).default
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)

const ROOT = process.cwd()
const ELECTRON = require2(path.join(ROOT, 'node_modules', 'electron'))
const PORT = 9746
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hsuserdata-'))
const LANGDIR = path.join(USERDATA, 'langs')
fs.mkdirSync(LANGDIR, { recursive: true })

const prePack = {
  id: 'xx-XX',
  name: 'Testish',
  author: 'Tester',
  version: 1,
  messages: { 保存: 'STORE' },
}
fs.writeFileSync(path.join(LANGDIR, 'xx-XX.lang'), JSON.stringify(prePack), 'utf8')

const env = { ...process.env, NODE_ENV: 'production', HSS_USER_DATA: USERDATA }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
)
async function waitWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const p = (await r.json()).find((t) => t.type === 'page')
        if (p) return p.webSocketDebuggerUrl
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('cdp')
}
const ws = new WebSocket(await waitWs())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.text || 'exception')
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    errors.push(d.params.args?.map((a) => a.value ?? a.description).join(' '))
}
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params }
  ws.send(JSON.stringify(msg))
  return new Promise((r) => pending.set(msg.id, r))
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) console.log('EVAL_ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
await send('Runtime.enable')
await send('Page.enable')
await wait(3000)
await ev(`window.__store.getState().setEditorMode('grid')`)
await wait(900)

const UI = `(() => {
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || ''
  const texts = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.trim())
  return {
    lang: document.documentElement.lang,
    save: txt('.titlebar .tb-btn'),
    exportPkg: txt('.titlebar .tb-btn.primary'),
    tabs: texts('.panel-tabs button'),
    activity: [...document.querySelectorAll('.activitybar button')].map((b) => b.getAttribute('title')),
    status: txt('.statusbar'),
    gridHint: txt('.gd-foot .hint'),
  }
})()`

const before = await ev(UI)
console.log('BEFORE', JSON.stringify(before))
T('默认界面是中文', before.lang === 'zh-CN' && before.save === '保存', `${before.lang} / ${before.save}`)

// 已安装的 .lang 能被列出来
const list = await ev(`window.__i18n.listLangs().map((p) => p.id)`)
console.log('LANGS', JSON.stringify(list))
T('内置 zh-CN / en-US', list.includes('zh-CN') && list.includes('en-US'), JSON.stringify(list))
T(
  '内置繁中 / 日 / 韩 / 俄',
  ['zh-TW', 'ja-JP', 'ko-KR', 'ru-RU'].every((x) => list.includes(x)),
  JSON.stringify(list),
)
T('userData/langs 里的语言包被加载', list.includes('xx-XX'), JSON.stringify(list))

// 切到英文
await ev(`window.__i18n.setLang('en-US')`)
await wait(500)
const en = await ev(UI)
console.log('EN', JSON.stringify(en))
T('html lang = en-US', en.lang === 'en-US', en.lang)
T('标题栏按钮变英文', en.save === 'Save' && en.exportPkg === 'Export sound package', `${en.save} / ${en.exportPkg}`)
T('底部面板页签英文', ['Problems', 'Timeline', 'Sound library', 'Output'].every((x) => en.tabs.includes(x)), JSON.stringify(en.tabs))
T('左侧活动栏提示英文', en.activity.some((x) => x === 'Explorer (Ctrl+B)'), JSON.stringify(en.activity.slice(0, 3)))
T('状态栏英文', en.status.includes('Ln 1, Col 1'), en.status)
T('网格底部提示英文', en.gridHint.includes('Ctrl+F'), en.gridHint.slice(0, 80))
T('主进程重建英文菜单', (await ev(`window.desktop.setAppLang('en-US')`)) === true)

// 设置窗口里的语言页
await ev(`window.__openAppSettings()`)
await wait(400)
await ev(`[...document.querySelectorAll('.set-tab')].find((b) => /Language/.test(b.textContent))?.click()`)
await wait(300)
const setInfo = await ev(`(() => {
  const sel = document.querySelector('.set-dialog select')
  return {
    value: sel?.value,
    options: sel ? [...sel.options].map((o) => o.value + ':' + o.textContent) : [],
    title: document.querySelector('.set-dialog .osu-diff-head')?.textContent || '',
  }
})()`)
console.log('SETTINGS', JSON.stringify(setInfo))
T('语言页选中 en-US', setInfo.value === 'en-US', setInfo.value)
T('列表中能看到第三方语言包', setInfo.options.some((o) => o.startsWith('xx-XX:')), JSON.stringify(setInfo.options))
T('语言页标题英文', /language/i.test(setInfo.title) && !/[一-龥]/.test(setInfo.title), setInfo.title)

// 六个页签都不该再有中文（语言自己的名字、JSON 示例除外）
const cjkTabs = []
for (let i = 0; i < 6; i++) {
  await ev(`document.querySelectorAll('.set-tab')[${i}]?.click()`)
  await wait(150)
  const bad = await ev(`(() => {
    const out = []
    const walk = (n) => {
      if (n.nodeType === 3) {
        const s = n.textContent.trim()
        const langNames = ['简体中文', '繁體中文', '日本語', '한국어', 'Русский']
        if (/[\u4e00-\u9fff]/.test(s) && !langNames.some((n) => s.includes(n)) && !s.includes('"messages"'))
          out.push(s.slice(0, 80))
        return
      }
      if (n.nodeType !== 1) return
      for (const c of n.childNodes) walk(c)
    }
    walk(document.querySelector('.set-dialog'))
    return out
  })()`)
  cjkTabs.push(bad)
}
console.log('CJK_TABS', JSON.stringify(cjkTabs))
T('设置窗 6 页没有残留中文', cjkTabs.every((x) => x.length === 0), JSON.stringify(cjkTabs))

await ev(`document.querySelector('.set-dialog .osu-diff-cancel')?.click()`)
await wait(300)

// 四个新语言包：标题/文案确实换了语言
{
  const cases = [
    ['zh-TW', '設定'],
    ['ja-JP', '設定'],
    ['ko-KR', '설정'],
    ['ru-RU', 'Настройки'],
  ]
  for (const [id, word] of cases) {
    await ev(`window.__i18n.setLang(${JSON.stringify(id)})`)
    await wait(350)
    const lang = await ev(`document.documentElement.lang`)
    const title = await ev(`window.__i18n.t('设置')`)
    T(`${id} 生效`, lang === id && title === word, `${lang} / ${title}`)
  }
}

// 跟随系统：模拟系统语言为俄语，选择 auto 后应解析成 ru-RU
await ev(`Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['ru-RU'] }); 1`)
await ev(`window.__i18n.setLang('auto')`)
await wait(400)
const auto = {
  lang: await ev(`document.documentElement.lang`),
  sel: await ev(`window.__i18n.langSelection()`),
  save: await ev(`window.__i18n.t('保存')`),
}
console.log('AUTO', JSON.stringify(auto))
T('auto 保留为跟随系统', auto.sel === 'auto', auto.sel)
T('auto 按系统语言解析成 ru-RU', auto.lang === 'ru-RU', auto.lang)
T('auto 后文案是俄语', auto.save === 'Сохранить', auto.save)

// 设置页下拉框里要有「跟随系统」选项，且选中 auto
await ev(`window.__openAppSettings()`)
await wait(400)
await ev(`[...document.querySelectorAll('.set-tab')].find((b) => /Язык|Language/.test(b.textContent))?.click()`)
await wait(300)
const autoSel = await ev(`(() => {
  const sel = document.querySelector('.set-dialog select')
  return JSON.stringify({ value: sel?.value, hasAuto: [...(sel?.options || [])].some((o) => o.value === 'auto') })
})()`)
T('设置页有「跟随系统」且选中它', JSON.parse(autoSel).value === 'auto' && JSON.parse(autoSel).hasAuto, autoSel)
await ev(`document.querySelector('.set-dialog .osu-diff-cancel')?.click()`)
await wait(300)

// 切到第三方语言包：只有 保存 被翻译，其余回落中文
await ev(`window.__i18n.setLang('xx-XX')`)
await wait(400)
const xx = await ev(UI)
console.log('XX', JSON.stringify({ lang: xx.lang, save: xx.save, tabs: xx.tabs }))
T('第三方语言包生效（保存 → STORE）', xx.save === 'STORE', xx.save)
T('未翻译的词条回落中文', xx.tabs.includes('问题') && xx.tabs.includes('时间轴'), JSON.stringify(xx.tabs))

// 运行时安装 → 写盘；删除 → 删文件
const yy = { id: 'yy-YY', name: 'Yish', messages: { 保存: 'SAVE2' } }
const inst = await ev(`window.__i18n.installLangText(${JSON.stringify(JSON.stringify(yy))}).then((p) => p.id)`)
await wait(300)
T('installLangText 返回 id', inst === 'yy-YY', String(inst))
T('语言包写进 userData/langs', fs.existsSync(path.join(LANGDIR, 'yy-YY.lang')), fs.readdirSync(LANGDIR).join(','))
const list2 = await ev(`window.__i18n.listLangs().map((p) => p.id)`)
T('列表里出现新语言包', list2.includes('yy-YY'), JSON.stringify(list2))
await ev(`window.__i18n.removeLang('yy-YY')`)
await wait(300)
T('removeLang 删掉文件', !fs.existsSync(path.join(LANGDIR, 'yy-YY.lang')), fs.readdirSync(LANGDIR).join(','))

// 切回中文
await ev(`window.__i18n.setLang('zh-CN')`)
await wait(400)
const zh = await ev(UI)
T('切回中文', zh.lang === 'zh-CN' && zh.save === '保存', `${zh.lang} / ${zh.save}`)

// 截图：英文界面
await ev(`window.__i18n.setLang('en-US')`)
await wait(400)
await ev(`window.__openAppSettings()`)
await wait(400)
await ev(`[...document.querySelectorAll('.set-tab')].find((b) => /Language/.test(b.textContent))?.click()`)
await wait(300)
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
if (shot?.result?.data) {
  fs.writeFileSync(path.join(ROOT, 'ui-i18n-language.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('SHOT ok')
}

console.log('ERRORS', JSON.stringify(errors.slice(0, 5)))
child.kill()
await wait(500)
try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch {}
process.exit(0)
