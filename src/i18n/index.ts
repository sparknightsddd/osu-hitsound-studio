/**
 * 轻量 i18n：msgid = 中文原文，语言包是 `.lang`（JSON）。
 *
 * 为什么用中文原文当 key：
 *   - 代码里直接 `t('保存')`，不用维护一套 key 命名；
 *   - 翻译缺失时自动回落到中文，不会出现 `menu.file.save` 这种生硬文本；
 *   - `.lang` 文件谁都能改：`{ "id": "en-US", "name": "English", "messages": { "保存": "Save" } }`。
 *
 * 语言包来源：
 *   - 内置：`src/i18n/langs/*.lang`（构建时打进包里）；
 *   - 已安装：Electron 下放在 `userData/langs/*.lang`；浏览器下存 localStorage。
 *
 * 切换语言时把 store 的 uiRev +1，整棵树重渲染（组件里不需要各自订阅）。
 */
import { useStore } from '../store'
import { desktopApi } from '../core/desktop'
import zhCN from './langs/zh-CN.lang?raw'
import enUS from './langs/en-US.lang?raw'

export interface LangPack {
  /** BCP-47 风格，如 zh-CN / en-US */
  id: string
  /** 语言自己的名字，如 简体中文 / English */
  name: string
  author?: string
  version?: number
  /** msgid（中文原文）→ 译文 */
  messages: Record<string, string>
  /** 内置包没有这个字段；安装的包记一下文件名 */
  file?: string
}

const LS_LANG = 'hss.lang'
const LS_PACKS = 'hss.langs'

let builtin: LangPack[] = []
let installed: LangPack[] = []
let current: LangPack = { id: 'zh-CN', name: '简体中文', messages: {} }
let ready = false

const subs = new Set<() => void>()
function emit() {
  subs.forEach((f) => f())
  // 让整棵 React 树重渲染（t() 是普通函数，没有自己的 hook）
  try {
    useStore.getState().bumpUi()
  } catch {
    /* store 还没就绪时忽略 */
  }
}

/** 解析并校验一个 .lang 文本 */
export function parseLang(text: string, file?: string): LangPack {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('语言包必须是一个对象')
  const id = String(raw.id || '').trim()
  const name = String(raw.name || '').trim()
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(id)) throw new Error(`id "${id}" 不合法（示例：en-US）`)
  if (!name) throw new Error('缺少 name（语言自己的名字）')
  if (!raw.messages || typeof raw.messages !== 'object' || Array.isArray(raw.messages))
    throw new Error('缺少 messages（{ "中文原文": "译文" }）')
  const messages: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw.messages)) {
    if (typeof v === 'string' && v) messages[k] = v
  }
  return {
    id,
    name,
    author: raw.author ? String(raw.author) : undefined,
    version: Number(raw.version) || 1,
    messages,
    file,
  }
}

/** 语言包列表：内置在前，同 id 的安装包覆盖内置（方便用户改翻译） */
export function listLangs(): LangPack[] {
  const map = new Map<string, LangPack>()
  for (const p of [...builtin, ...installed]) map.set(p.id, p)
  return [...map.values()].sort((a, b) => {
    // 中文永远排第一，其余按名字
    if (a.id === 'zh-CN') return -1
    if (b.id === 'zh-CN') return 1
    return a.name.localeCompare(b.name)
  })
}

export function currentLang(): LangPack {
  return current
}

/** 内置语言包（删不掉，改翻译请装一个同 id 的 .lang 覆盖） */
export function isBuiltinLang(id: string): boolean {
  return builtin.some((p) => p.id === id)
}

/** msgid → 当前语言文本；缺失时回落到中文原文 */
export function t(msg: string, vars?: Record<string, string | number>): string {
  let s = current.messages[msg]
  if (s === undefined) s = msg
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
  }
  return s
}

/** 订阅语言变化（设置页用；普通组件靠 uiRev 重渲染） */
export function subscribeLang(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

function persist(id: string) {
  try {
    localStorage.setItem(LS_LANG, id)
  } catch {
    /* ignore */
  }
}

/** 设置界面语言；找不到包就回落到中文 */
export function setLang(id: string, opts: { persist?: boolean } = {}) {
  const pack = listLangs().find((p) => p.id === id) || listLangs().find((p) => p.id === 'zh-CN')
  if (!pack) return
  current = pack
  if (opts.persist !== false) persist(pack.id)
  try {
    document.documentElement.lang = pack.id
  } catch {
    /* ignore */
  }
  // 原生菜单也跟着换
  void desktopApi()?.setAppLang?.(pack.id)
  emit()
}

function readBrowserPacks(): LangPack[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PACKS) || '{}') as Record<string, string>
    return Object.entries(raw).flatMap(([id, text]) => {
      try {
        return [parseLang(text, id)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function saveBrowserPack(text: string) {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PACKS) || '{}') as Record<string, string>
    const pack = parseLang(text)
    raw[pack.id] = text
    localStorage.setItem(LS_PACKS, JSON.stringify(raw))
    return pack
  } catch (e) {
    throw e
  }
}

/**
 * 启动时初始化：注册内置包 → 读已安装包 → 恢复上次选的语言。
 * 重复调用安全（只跑一次）。
 */
export async function initI18n(): Promise<void> {
  if (ready) return
  ready = true
  // 内置包在模块加载时已经解析过；这里只补已安装的 .lang
  const api = desktopApi()
  if (api?.listLangs) {
    try {
      const r = await api.listLangs()
      installed = (r.files || []).flatMap((f) => {
        try {
          return [parseLang(f.text, f.file)]
        } catch {
          return []
        }
      })
    } catch {
      installed = []
    }
  } else {
    installed = readBrowserPacks()
  }
  const saved = (() => {
    try {
      return localStorage.getItem(LS_LANG) || 'zh-CN'
    } catch {
      return 'zh-CN'
    }
  })()
  const pack = listLangs().find((p) => p.id === saved) || listLangs()[0]
  current = pack
  try {
    document.documentElement.lang = pack.id
  } catch {
    /* ignore */
  }
  // 让原生菜单和界面保持一致（也把选择写进 prefs，下次启动直接生效）
  void desktopApi()?.setAppLang?.(pack.id)
  emit()
}

/** 安装一个 .lang（文本）；返回解析后的语言包 */
export async function installLangText(text: string): Promise<LangPack> {
  const pack = parseLang(text)
  const api = desktopApi()
  if (api?.saveLang) {
    const r = await api.saveLang(pack.id, text)
    if (!r.ok) throw new Error(r.error || '保存语言包失败')
    installed = installed.filter((p) => p.id !== pack.id).concat({ ...pack, file: `${pack.id}.lang` })
  } else {
    saveBrowserPack(text)
    installed = installed.filter((p) => p.id !== pack.id).concat(pack)
  }
  emit()
  return pack
}

/** 删除已安装语言包（内置的删不掉） */
export async function removeLang(id: string): Promise<boolean> {
  if (builtin.some((p) => p.id === id)) return false
  const api = desktopApi()
  if (api?.deleteLang) {
    const r = await api.deleteLang(id)
    if (!r.ok) return false
  } else {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_PACKS) || '{}') as Record<string, string>
      delete raw[id]
      localStorage.setItem(LS_PACKS, JSON.stringify(raw))
    } catch {
      return false
    }
  }
  installed = installed.filter((p) => p.id !== id)
  if (current.id === id) setLang('zh-CN')
  emit()
  return true
}

/** 读磁盘上的 .lang 文件（安装用）；浏览器模式返回 null */
export async function pickLangFile(): Promise<{ name: string; text: string } | null> {
  const api = desktopApi()
  if (!api) return null
  const res = await api.openFiles({
    title: t('安装语言包'),
    filters: [{ name: t('语言包 (*.lang)'), extensions: ['lang'] }],
  })
  const f = res.files?.[0]
  if (res.canceled || !f?.path) return null
  const r = await api.readText(f.path)
  if (!r.ok || r.text == null) throw new Error(r.error || '读取语言包失败')
  return { name: f.name, text: r.text }
}

/** 打开语言包文件夹（Electron） */
export async function openLangFolder(): Promise<boolean> {
  const api = desktopApi()
  if (!api?.openLangDir) return false
  const r = await api.openLangDir()
  return r.ok
}

// 内置语言包在模块加载时就注册好：首屏不用等异步初始化，listLangs() 也随时可用
try {
  builtin = [
    parseLang(zhCN, 'zh-CN.lang'),
    parseLang(enUS, 'en-US.lang'),
  ]
} catch (e) {
  // 内置包坏了也不能让整个界面起不来
  console.error('[i18n] failed to parse built-in language packs', e)
  builtin = [parseLang('{"id":"zh-CN","name":"简体中文","messages":{}}', 'zh-CN.lang')]
}
// 先按上次保存的语言显示，已安装的语言包由 initI18n() 补上
try {
  const saved = localStorage.getItem(LS_LANG)
  if (saved) current = builtin.find((p) => p.id === saved) || current
} catch {
  /* ignore */
}

// 调试/自动化入口：CDP 测试和语言包作者可以用它快速切换、检查覆盖率
if (typeof window !== 'undefined') {
  ;(window as any).__i18n = {
    setLang,
    listLangs,
    currentLang,
    installLangText,
    removeLang,
    t,
  }
}
