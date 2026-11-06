/**
 * 桌面端桥接层。
 *
 * 同一个应用要同时跑在浏览器（vite dev / 静态部署）和 Electron 客户端里，
 * 所以所有「本地文件」能力都在这里收口：
 *   - Electron：走 window.desktop（真实文件系统读写、原生对话框）
 *   - 浏览器 ：回退到 <input type=file> 选文件 + Blob 下载
 *
 * 上层（AutoLoad / TitleBar / SideBar）只认这里的 API，不关心底下是哪条路。
 */
import type { PickedEntry } from './fileMatch'

/** 一个 .osu 难度的元信息（由主进程扫描同目录得出） */
export interface OsuDifficultyInfo {
  name: string
  path: string
  size: number
  mtimeMs: number
  title: string
  artist: string
  creator: string
  version: string
  hp: number
  cs: number
  ar: number
  od: number
  starRating: number
  objectCount: number
}

export interface OsuDifficultyList {
  ok: boolean
  dir?: string
  difficulties?: OsuDifficultyInfo[]
  error?: string
}

// ---------------------------------------------------------------------------
// osu! 谱面库（左侧第 5 个图标）
// ---------------------------------------------------------------------------

/** 谱面集里的一个难度（仅文件名 / 路径 / 难度名，不读全文） */
export interface MapsetDifficulty {
  name: string
  path: string
  version: string
}

/** 一个谱面集（Songs 目录下的一个文件夹） */
export interface MapsetEntry {
  /** 文件夹名，osu! 里形如 `12345 Artist - Title` */
  folder: string
  path: string
  /** 有效修改时间（ms）：max(文件夹 mtime, 顶层 .osu 最大 mtime)，排序用 */
  mtimeMs: number
  title: string
  artist: string
  creator: string
  diffCount: number
  difficulties: MapsetDifficulty[]
}

export interface MapsetPage {
  ok: boolean
  songsFolder: string
  total: number
  offset: number
  hasMore: boolean
  mapsets: MapsetEntry[]
  error?: string
}

/** osu! 当前打开的谱面（由窗口标题反查 Songs 目录得到） */
export interface CurrentMapsetResult {
  ok: boolean
  /** folder_found | no_process | no_match | songs_folder_not_found | error */
  status: string
  message: string
  songsFolder?: string
  /** editor = 编辑器窗口；playing = 歌曲选择/播放窗口 */
  source?: string
  mapset: MapsetEntry | null
  titles?: string[]
}

export interface DesktopApi {
  isElectron: boolean
  platform: string
  openFiles: (opts?: any) => Promise<{ canceled: boolean; files: { name: string; path: string }[] }>
  openFolder: (opts?: any) => Promise<{ canceled: boolean; dir: string }>
  saveFile: (opts?: any) => Promise<{ canceled: boolean; path: string }>
  /** 以「文件夹」为单位打开歌曲目录，并顺着 AudioFilename 解析出歌曲音频 */
  loadChartFolder: (opts?: any) => Promise<{
    canceled: boolean
    dir: string
    charts?: {
      name: string
      path: string
      ext: string
      editable: boolean
      size: number
      mtimeMs: number
      audioRef?: string
      audioPath?: string
    }[]
    audios?: { name: string; path: string; relPath: string; size: number; depth: number }[]
    song?: { path: string; relPath: string; name: string; fromChart: string } | null
    error?: string
  }>
  /**
   * 以某个谱面文件为基准，重新解析它引用的歌曲音频与音效样本。
   *
   * 切换谱面时用：同一个歌曲目录里的多份谱面往往引用同一首歌，但
   * 音效样本是各自独有的，必须按当前谱面的 [Files] / [Define] 重新配对。
   */
  resolveChartAssets: (opts: { chartPath: string; dir?: string; audio?: string }) => Promise<{
    ok: boolean
    dir: string
    /** 歌曲音频路径（谱面 AudioFilename 解析出来的） */
    songPath?: string
    songName?: string
    songRel?: string
    /** 目录内全部音频（递归，含音效样本） */
    assets?: { name: string; path: string; relPath: string; size: number }[]
    error?: string
  }>
  /**
   * 导出音效谱：直接写进 [Files] path。
   * 文件名 `<artist> - <title> (<creator>) [[EZHS]].osu`，重名时难度名递增；
   * 音效同名且内容不同会返回 conflict，不写任何文件。
   */
  exportOsuPackage: (opts: {
    dir: string
    artist: string
    title: string
    creator: string
    text: string
    /** 导出前删掉本谱之前生成的 [[EZHS*]].osu */
    cleanOld?: boolean
    files: { to: string; from: string[]; defaults: string[]; mix: boolean; mixMeta?: unknown }[]
  }) => Promise<{
    ok: boolean
    dir?: string
    osuPath?: string
    /** 实际使用的难度名，如 `[EZHS]` / `[EZHS1]` */
    diff?: string
    /** 新写出的音效数 */
    written?: number
    /** 内容一致、跳过的音效数 */
    skipped?: number
    /** 本次清理掉的旧 .osu（cleanOld 打开时） */
    removed?: string[]
    /** 同名但内容不同的文件（有值时 ok=false，且什么都没写） */
    conflict?: boolean
    conflicts?: string[]
    errors?: string[]
    error?: string
  }>
  messageBox: (opts: {
    type?: string
    buttons: string[]
    defaultId?: number
    cancelId?: number
    title?: string
    message: string
    detail?: string
  }) => Promise<number>
  exists: (p: string) => Promise<{ exists: boolean; size?: number; mtimeMs?: number; isFile?: boolean }>
  /** 读文件算内容哈希（音色去重用） */
  hashFile: (p: string) => Promise<{ ok: boolean; hash?: string; size?: number; error?: string }>
  /** 粗略解析音频时长（毫秒）；解析不出来时 durationMs 为 0 */
  audioDuration: (p: string) => Promise<{ ok: boolean; durationMs: number; error?: string }>
  /** 列出某个 .osu 同目录下的所有难度（元信息，用于导入时挑难度） */
  listOsuDifficulties: (p: string) => Promise<OsuDifficultyList>
  /** 自动探测 osu! Songs 目录（注册表 → osu! 配置 → 常见安装位置） */
  osuDetectSongsFolder: () => Promise<{ folder: string }>
  /** 按 Mapset Verifier 的顺序分页列出 Songs 下的谱面集 */
  osuListMapsets: (opts: {
    songsFolder?: string
    offset?: number
    limit?: number
    search?: string
  }) => Promise<MapsetPage>
  /** 读取 osu! 当前打开的谱面集 */
  osuCurrentMapset: (opts: { songsFolder?: string }) => Promise<CurrentMapsetResult>
  readText: (p: string) => Promise<{ ok: boolean; text?: string; path?: string; name?: string; error?: string }>
  writeText: (p: string, text: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  readBinary: (p: string) => Promise<{ ok: boolean; data?: Uint8Array; name?: string; size?: number; error?: string }>
  /** 复制文件到指定路径（源文件不动）；目录不存在会自动创建 */
  copyFile: (from: string, to: string) => Promise<{ ok: boolean; same?: boolean; size?: number; error?: string }>
  /** 移动文件（跨盘会退化成复制 + 删除） */
  moveFile: (from: string, to: string) => Promise<{ ok: boolean; same?: boolean; error?: string }>
  /** 读 WAV 的 HSSM 块（混音来源信息）；没有就 meta: null */
  wavMeta: (p: string) => Promise<{ ok: boolean; meta?: import('./osuSounds').MixMeta | null; error?: string }>
  /** 已绑定音效的持久化副本（存 userData/samples） */
  sampleWrite?: (name: string, data: Uint8Array) => Promise<{ ok: boolean; size?: number; error?: string }>
  sampleRead?: (name: string) => Promise<{ ok: boolean; data?: Uint8Array; size?: number }>
  sampleDelete?: (name: string) => Promise<{ ok: boolean }>
  sampleList?: () => Promise<{ ok: boolean; names?: string[] }>
  /** 已安装的语言包（userData/langs/*.lang 的原文） */
  listLangs?: () => Promise<{ ok: boolean; files: { file: string; text: string }[]; dir?: string; error?: string }>
  /** 写入一个语言包（文件名固定为 <id>.lang） */
  saveLang?: (id: string, text: string) => Promise<{ ok: boolean; error?: string }>
  deleteLang?: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** 打开语言包文件夹 */
  openLangDir?: () => Promise<{ ok: boolean; dir?: string; error?: string }>
  /** 把界面语言同步给主进程（原生菜单用） */
  setAppLang?: (id: string) => Promise<boolean>
  listDir: (root: string, opts?: any) => Promise<{ ok: boolean; files?: { path: string; relPath: string; name: string; size: number }[]; root?: string; error?: string }>
  getPrefs: () => Promise<Record<string, any>>
  setPrefs: (patch: Record<string, any>) => Promise<boolean>
  openPath: (p: string) => Promise<boolean>
  /** 用系统默认程序打开链接（`osu://edit/…` 这类自定义协议也走它） */
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>
  /** 拖进窗口的文件 → 磁盘路径（Electron 32 起没有 `File.path` 了） */
  pathForFile?: (file: File) => string
  version: () => Promise<{ electron: string; app: string }>
  confirmClose: () => Promise<boolean>
  /** 系统剪贴板（浏览器下没有这两个方法，调用方会退回 navigator） */
  clipboardReadText?: () => Promise<string>
  clipboardWriteText?: (text: string) => Promise<unknown>
  onMenu: (handler: (action: string, ...args: any[]) => void) => () => void
  /** 把「主题 / 节拍器 / 输入音效」的勾选状态同步给原生菜单 */
  setMenuState: (st: { theme?: string; metronome?: boolean; typeSound?: boolean }) => void
}

/** 拿不到就说明跑在浏览器里 */
export function desktopApi(): DesktopApi | null {
  const d = (globalThis as any).desktop
  return d && d.isElectron ? (d as DesktopApi) : null
}

export const IS_DESKTOP = !!desktopApi()

/** 是否跑在 Electron 客户端里（避免各处循环 import 时重复判断） */
export function isDesktop(): boolean {
  return IS_DESKTOP
}

/**
 * 用系统默认程序打开链接。
 *
 * Electron 走主进程的 `shell.openExternal`，这样 `osu://edit/mm:ss:xxx`
 * 才能唤起 osu!；浏览器里只能试 `window.open`（没装 osu! 时不会有反应）。
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const api = desktopApi()
  if (api?.openExternal) {
    try {
      const r = await api.openExternal(url)
      return !!r?.ok
    } catch {
      return false
    }
  }
  try {
    window.open(url, '_blank', 'noopener')
    return true
  } catch {
    return false
  }
}

/**
 * 拖进窗口的 File → 磁盘路径。
 *
 * Electron 32 起 `File.path` 已经被删掉，得让主进程用 `webUtils.getPathForFile` 取；
 * 浏览器里拿不到路径，返回空串（调用方据此提示「请用音效库的 +」）。
 */
export function filePathOf(file: File): string {
  const api = desktopApi()
  if (api?.pathForFile) {
    try {
      return api.pathForFile(file) || ''
    } catch {
      return ''
    }
  }
  const legacy = (file as { path?: unknown }).path
  return typeof legacy === 'string' ? legacy : ''
}

// ---------------------------------------------------------------------------
// 浏览器回退：选文件 / 下载
// ---------------------------------------------------------------------------

/** 弹出一次性的 <input type=file>，返回用户选中的 File 列表（用完即销毁） */
export function pickFilesBrowser(opts: { directory?: boolean; accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'
    if (opts.accept) input.accept = opts.accept
    input.multiple = opts.multiple !== false
    if (opts.directory) {
      ;(input as any).webkitdirectory = ''
      ;(input as any).directory = ''
    }
    let settled = false
    const done = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done([...(input.files || [])]))
    // 用户取消对话框：窗口重新获得焦点时如果还没 change，就当作取消
    window.addEventListener(
      'focus',
      () => setTimeout(() => done([]), 300),
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/**
 * 让用户在本地挑一个文件夹，返回可交给 fileMatch 匹配的条目。
 * Electron：列目录后按需读二进制（大目录也只读匹配上的文件）。
 * 浏览器：走 <input webkitdirectory>。
 */
export async function pickAssetEntries(exts?: string[]): Promise<PickedEntry[]> {
  const api = desktopApi()
  if (api) {
    const res = await api.openFolder({ title: '选择歌曲文件夹' })
    if (res.canceled || !res.dir) return []
    const listed = await api.listDir(res.dir, exts ? { exts } : undefined)
    if (!listed.ok || !listed.files) return []
    // 先把路径信息给出去，真正读内容推迟到匹配命中之后（见 readEntryFile）
    return listed.files.map((f) => ({
      file: makeLazyFile(f.path, f.name, f.size),
      path: f.relPath.toLowerCase(),
      name: f.name,
    }))
  }
  const files = await pickFilesBrowser({ directory: true })
  return files.map(toPickedEntry)
}

/** 单个文件选择（导入谱面）。默认只列 .hs —— .osu 不是本程序的编辑格式 */
export async function pickChartFiles(): Promise<{ name: string; file: File; path?: string }[]> {
  const api = desktopApi()
  if (api) {
    const res = await api.openFiles({
      title: '打开 .hs 谱面',
      filters: [{ name: '本程序可编辑的谱面 (.hs)', extensions: ['hs'] }],
    })
    if (res.canceled) return []
    const out: { name: string; file: File; path?: string }[] = []
    for (const f of res.files) {
      const bin = await api.readBinary(f.path)
      if (!bin.ok || !bin.data) continue
      out.push({ name: f.name, file: new File([bin.data as BlobPart], f.name), path: f.path })
    }
    return out
  }
  const files = await pickFilesBrowser({ accept: '.hs', multiple: true })
  return files.map((f) => ({ name: f.name, file: f }))
}

/** .osu 只读选择（从原谱导入参考数据） */
export async function pickOsuFiles(): Promise<{ name: string; file: File; path?: string }[]> {
  const api = desktopApi()
  if (api) {
    const res = await api.openFiles({
      title: '从 .osu 导入（原谱不会被修改）',
      filters: [{ name: 'osu! 谱面（只读）', extensions: ['osu'] }],
    })
    if (res.canceled) return []
    const out: { name: string; file: File; path?: string }[] = []
    for (const f of res.files) {
      const bin = await api.readBinary(f.path)
      if (!bin.ok || !bin.data) continue
      out.push({ name: f.name, file: new File([bin.data as BlobPart], f.name), path: f.path })
    }
    return out
  }
  const files = await pickFilesBrowser({ accept: '.osu', multiple: true })
  return files.map((f) => ({ name: f.name, file: f }))
}

/** 浏览器侧：把 File 变成 PickedEntry（与 entriesFromFiles 同规则） */
export function toPickedEntry(file: File): PickedEntry {
  const rp = (file as any).webkitRelativePath || ''
  const raw = rp || file.name
  let p = raw.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const i = p.indexOf('/')
  if (i > 0) p = p.slice(i + 1)
  const j = p.lastIndexOf('/')
  return { file, path: p, name: j >= 0 ? p.slice(j + 1) : p }
}

/**
 * 惰性 File：只带路径信息，第一次真正读内容时才走 IPC。
 * 这样几千个音频文件的大目录不会一次性全读进内存。
 */
function makeLazyFile(fullPath: string, name: string, size: number): File {
  let cache: File | null = null
  const load = async (): Promise<File> => {
    if (cache) return cache
    const api = desktopApi()
    if (!api) throw new Error('lazy file 只在 Electron 下可用')
    const bin = await api.readBinary(fullPath)
    if (!bin.ok || !bin.data) throw new Error(bin.error || `读取失败：${fullPath}`)
    cache = new File([bin.data as BlobPart], name)
    return cache
  }

  // 造一个表面上是 File、实际上延迟加载内容的对象。
  // 下游 engine 只会用到 .name/.size/.arrayBuffer()，其余属性给了合理兜底。
  const lazy: any = {
    __lazyPath: fullPath,
    get name() {
      return name
    },
    get size() {
      return size
    },
    get type() {
      return ''
    },
    get lastModified() {
      return 0
    },
    get webkitRelativePath() {
      return ''
    },
    slice: (_a?: number, _b?: number) => {
      throw new Error('lazy file 不支持 slice，请先 await materializeFile()')
    },
    arrayBuffer: async () => (await load()).arrayBuffer(),
    text: async () => (await load()).text(),
    stream: () => {
      throw new Error('lazy file 不支持 stream，请先 await materializeFile()')
    },
  }
  // 让它能通过 instanceof File 判断（下游有 file instanceof File 之类的地方）
  Object.setPrototypeOf(lazy, File.prototype)
  return lazy as File
}

/** 把惰性 File 变成真正的 File（读内容）。非惰性对象原样返回。 */
export async function materializeFile(f: File): Promise<File> {
  const p = (f as any).__lazyPath
  if (!p) return f
  // 触发一次真实读取，拿到缓存好的 File
  await f.arrayBuffer()
  const api = desktopApi()
  if (!api) return f
  const bin = await api.readBinary(p)
  if (!bin.ok || !bin.data) throw new Error(bin.error || `读取失败：${p}`)
  return new File([bin.data as BlobPart], f.name)
}
