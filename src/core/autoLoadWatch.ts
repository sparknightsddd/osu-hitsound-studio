/**
 * 文本驱动的音频自动加载：文本里只要出现可解析的音频路径，就立即从磁盘载入。
 *
 * 以前只有「切换谱面 / 启动恢复 / 手动点按钮」才会扫目录配对 —— 在编辑器里
 * 手写 [Files] path / audio、给 [Define] 补路径时什么都不会发生，表现就是
 * 「音频不加载了」。这里监听解析结果（doc），新出现的绝对路径直接读盘载入，
 * 不再依赖目录扫描。
 *
 * 仅 Electron 下生效（浏览器读不到任意本地路径，仍走侧栏手动选目录）。
 */
import { useStore } from '../store'
import { engine } from '../audio/engine'
import { desktopApi } from './desktop'
import { resolvePath } from './parse'
import { keySampleName } from './keysound'

/** 一个待载入目标 */
interface Target {
  /** 磁盘真实路径（保留大小写，读文件用） */
  diskPath: string
  /** 缓存键（统一分隔符 + 小写） */
  key: string
  /** 引擎里的样本名；歌曲为空 */
  sampleName?: string
  /** 日志/提示用的展示名 */
  label: string
}

function stripQuotes(p: string): string {
  return p.replace(/^["']|["']$/g, '').trim()
}

function isAbs(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/** 缓存键：统一分隔符、小写（Windows 路径不区分大小写） */
function normKey(p: string): string {
  return stripQuotes(p).replace(/\//g, '\\').toLowerCase()
}

/** Windows 盘符/UNC 路径统一反斜杠（resolvePath 拼出来的可能是混合分隔符），Unix 原样 */
function diskPath(p: string): string {
  const s = stripQuotes(p)
  return /^[A-Za-z]:/.test(s) || s.startsWith('\\\\') ? s.replace(/\//g, '\\') : s
}

/** 从当前解析结果收集所有能落成绝对路径的音频（歌曲 + 音效 + keysound） */
function collectTargets(): Target[] {
  const { doc } = useStore.getState()
  const out: Target[] = []
  const base = stripQuotes(doc.settings.Path || doc.baseDir || '')

  // 1) 歌曲：[Files] path + audio（audio 自身是绝对路径时直接用）
  const audioRaw = stripQuotes(doc.settings.Audio || doc.settings.Song || '')
  if (audioRaw) {
    const p = resolvePath(base, audioRaw)
    if (isAbs(p)) out.push({ diskPath: diskPath(p), key: normKey(p), label: `歌曲 ${audioRaw}` })
  }

  for (const h of doc.hitsounds) {
    // default.xxx 走内置库；sf2/sf3/sfz/单一音频用 key layout 整体载入，不在这里逐个绑定
    if (!h.name || h.defaultRef || h.keys?.mode === 'singlefile' || h.soundFont) continue
    // 2) hitsound 单文件（keysound 单文件/音色库整体走 autoLoadAssets 的 key layout）
    if (h.kind === 'hitsound' && h.resolvedPath && isAbs(h.resolvedPath)) {
      out.push({
        diskPath: diskPath(h.resolvedPath),
        key: normKey(h.resolvedPath),
        sampleName: h.name,
        label: h.name,
      })
    }
    // 3) keysound 多文件：每个音高一个 wav/ogg
    if (h.keyFiles) {
      for (const [midi, raw] of h.keyFiles) {
        const p = resolvePath(base, stripQuotes(raw))
        if (isAbs(p)) {
          out.push({
            diskPath: diskPath(p),
            key: normKey(p),
            sampleName: keySampleName(h.name, midi),
            label: `${h.name}(${midi})`,
          })
        }
      }
    }
  }
  return out
}

let seq = 0
let timer: number | null = null
/** 已处理过的路径缓存键 -> 是否成功；失败过就不再重试（除非文本里写法变了） */
const processed = new Map<string, boolean>()
/** 缓存属于哪份谱面 —— 切谱会 unbindAll，缓存必须跟着作废重新配对 */
let processedFor = ''
/** 本次会话已载入过的歌曲路径（切谱不清歌曲，避免重复读大文件） */
const songDone = new Set<string>()

function log(msg: string) {
  useStore.getState().log(msg)
}

async function run() {
  timer = null
  const api = desktopApi()
  if (!api) return
  const s = useStore.getState()
  if (processedFor !== s.activeId) {
    processedFor = s.activeId
    processed.clear()
  }
  const targets = collectTargets()
  if (!targets.length) return

  const my = ++seq
  const bindings = { ...useStore.getState().bindings }
  const loaded: string[] = []
  for (const t of targets) {
    // 缓存键必须带上样本名：同一个文件改代号后（Aa → Bb）路径没变，
    // 只按路径去重会把新代号当成「已处理过」直接跳过，表现就是改名后不加载。
    const ck = `${t.sampleName || ''}\u0000${t.key}`
    if (processed.has(ck)) continue
    if (!t.sampleName && songDone.has(t.key)) {
      processed.set(ck, true)
      continue
    }
    const bin = await api.readBinary(t.diskPath)
    if (my !== seq) return // 期间文本又变了/切谱了 → 丢弃这轮
    if (!bin.ok || !bin.data) {
      processed.set(ck, false)
      log(`✗ 按文本路径载入 ${t.label} 失败：读不到 ${t.diskPath}`)
      continue
    }
    const fileName = t.diskPath.replace(/\\/g, '/').split('/').pop() || t.diskPath
    try {
      const file = new File([bin.data as BlobPart], fileName)
      if (t.sampleName) {
        await engine.bindSample(t.sampleName, file, false)
        bindings[t.sampleName] = {
          name: t.sampleName,
          fileName,
          size: bin.data.byteLength,
          auto: true,
        }
      } else {
        await engine.loadSong(file)
        songDone.add(t.key)
      }
      processed.set(ck, true)
      loaded.push(t.label)
    } catch (err) {
      processed.set(ck, false)
      log(`✗ 按文本路径载入 ${t.label} 失败：${fileName} 解码不了（${String(err).slice(0, 120)}）`)
    }
  }
  if (my !== seq) return
  useStore.getState().setBindings(bindings)
  if (loaded.length) log(`按文本路径自动载入：${loaded.join('、')}`)
}

function schedule() {
  if (timer != null) window.clearTimeout(timer)
  // 文本解析本身有 180ms 防抖，这里再缓 300ms：等用户把一行路径敲完再读盘
  timer = window.setTimeout(() => void run(), 300)
}

let started = false

/** 启动监视（App 挂载时调用一次，重复调用无效） */
export function startAutoLoadWatch() {
  if (started || typeof window === 'undefined') return
  started = true
  useStore.subscribe((st, prev) => {
    // doc 只在（重新）解析后换引用；activeId 变化也要跟一轮（新谱的路径要载入）
    if (st.doc !== prev.doc || st.activeId !== prev.activeId) schedule()
  })
}
