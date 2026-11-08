import { create } from 'zustand'
import { dirname, migrateSongToFiles, parseChart } from './core/parse'
import type { ChartDoc } from './core/types'
import { DEMO, TEMPLATE } from './samples/demo'
import { applyChartSettingsToText } from './core/chartDefaults'
import { engine, type BindingInfo } from './audio/engine'

export interface FileItem {
  id: string
  name: string
  content: string
  /** 磁盘上的真实路径（Electron 下打开文件/保存过之后才有；为空表示只在内存/localStorage 里） */
  path?: string
  /** 相对上次存盘内容是否有改动（关闭前提醒用） */
  dirty?: boolean
  /** 上次存盘时的内容快照，用来判断 dirty */
  saved?: string
}

const LS_FILES = 'hss.files'
const LS_THEME = 'hss.theme'
const LS_BINDINGS = 'hss.bindings'
const LS_ACTIVE = 'hss.active'
const LS_TYPESOUND = 'hss.typeSound'
const LS_SIDEBARW = 'hss.sidebarWidth'
const LS_EDITORMODE = 'hss.editorMode'

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

function loadFiles(): FileItem[] {
  try {
    const raw = localStorage.getItem(LS_FILES)
    if (raw) {
      const arr = JSON.parse(raw) as FileItem[]
      if (Array.isArray(arr) && arr.length) return migrate(arr)
    }
  } catch {
    /* ignore */
  }
  return [{ id: uid(), name: 'example.hs', content: DEMO }]
}

/** 打开已存文件时顺手做一次旧格式迁移（Song -> [Files]） */
function migrate(files: FileItem[]): FileItem[] {
  return files.map((f) => {
    const next = migrateSongToFiles(f.content)
    const base = next === f.content ? f : { ...f, content: next }
    // saved 快照不落盘（否则 localStorage 直接double）；重载后以当前内容为基线
    return { ...base, saved: base.content, dirty: base.dirty ?? false }
  })
}

/** 写回 localStorage；saved 快照不落盘，避免每份谱面占两份空间 */
function persistFiles(files: FileItem[]) {
  try {
    const slim = files.map(({ id, name, content, path, dirty }) => ({ id, name, content, path, dirty }))
    localStorage.setItem(LS_FILES, JSON.stringify(slim))
  } catch {
    /* 配额满了也不该影响编辑 */
  }
}

function loadTheme(): ThemePref {
  const t = localStorage.getItem(LS_THEME)
  return t === 'dark' || t === 'auto' ? t : 'light'
}

function loadTypeSound(): boolean {
  try {
    return localStorage.getItem(LS_TYPESOUND) !== '0'
  } catch {
    return true
  }
}

function loadBindings(): Record<string, BindingInfo> {
  try {
    return JSON.parse(localStorage.getItem(LS_BINDINGS) || '{}')
  } catch {
    return {}
  }
}

/** 侧栏宽度（资源管理器那列），双击分隔条可恢复默认 260 */
export const SIDEBAR_DEFAULT_WIDTH = 260

function loadSidebarWidth(): number {
  const n = Number(localStorage.getItem(LS_SIDEBARW))
  return Number.isFinite(n) && n >= 150 ? n : SIDEBAR_DEFAULT_WIDTH
}

export type SidebarView = 'explorer' | 'audio' | 'settings' | 'mapsets' | 'sounds'
export type PanelView = 'problems' | 'timeline' | 'samples' | 'output'
/** 主编辑区：文本编辑 / 格子编辑 */
export type EditorMode = 'text' | 'grid'
/** 主题偏好：auto = 跟随系统 prefers-color-scheme */
export type ThemePref = 'light' | 'dark' | 'auto'

interface State {
  /**
   * 单纯用来「叫醒」一次视图的版本号：显示偏好这类不经过 store 的设置改完后，
   * `setState({})` 不会让 useSyncExternalStore 重新渲染，只能动一个真实字段。
   */
  uiRev: number
  bumpUi: () => void
  files: FileItem[]
  activeId: string
  theme: ThemePref
  /** 系统当前是否深色（供 theme='auto' 解析用，随系统实时更新） */
  systemDark: boolean
  sidebar: SidebarView
  sidebarOpen: boolean
  /** 资源管理器列宽（px），拖侧栏分隔条调整 */
  sidebarWidth: number
  panel: PanelView
  panelOpen: boolean
  panelHeight: number
  /** 每拍等分数（时间轴网格和格子视图共用） */
  div: number
  /** 播放时视图是否跟随光标（时间轴和格子共用） */
  follow: boolean
  /** 格子视图的画笔类型：单击型（先选格子再点音效）/ 双击型（双击音效再点格子） */
  brushMode: 'single' | 'double'
  /** 双击型当前锁定的音效代号 */
  brushPin: string
  /** 格子视图当前编辑的 keysound 乐器（'' = hitsound） */
  ksInst: string
  /** 格子视图的输入范围起点（MIDI）：A~L 依次对应该音起的 12 个半音 */
  ksBase: number
  editorMode: EditorMode
  doc: ChartDoc
  bindings: Record<string, BindingInfo>
  output: string[]
  cursor: { line: number; col: number; sel: number }
  audioTick: number
  typeSound: boolean

  setActive: (id: string) => void
  updateContent: (id: string, content: string) => void
  /** 把当前内容标记为「已存盘」，并记住磁盘路径 */
  markSaved: (id: string, path: string) => void
  /** 从磁盘打开文件后登记路径（此时内容与磁盘一致，不算脏） */
  attachPath: (id: string, path: string, content?: string) => void
  reparse: () => void
  newFile: (name?: string, content?: string) => void
  closeFile: (id: string) => void
  renameFile: (id: string, name: string) => void
  deleteFile: (id: string) => void
  addFile: (name: string, content: string) => string
  setTheme: (t: ThemePref) => void
  setSidebar: (v: SidebarView) => void
  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  setPanel: (v: PanelView) => void
  setEditorMode: (m: EditorMode) => void
  togglePanel: () => void
  setPanelHeight: (h: number) => void
  setDiv: (n: number) => void
  setFollow: (v: boolean) => void
  setBrushMode: (m: 'single' | 'double') => void
  setBrushPin: (n: string) => void
  setKsInst: (n: string) => void
  setKsBase: (n: number) => void
  log: (msg: string) => void
  clearLog: () => void
  setCursor: (c: State['cursor']) => void
  setBindings: (b: Record<string, BindingInfo>) => void
  bumpAudio: () => void
  setTypeSound: (v: boolean) => void
}

/**
 * 切换谱面时的音频重载回调。
 *
 * 由 commands 层（`actions.ts`）在模块加载时注册进来。
 * store 不直接 import actions —— 那会形成 actions -> store -> actions 的循环依赖。
 */
type ActiveHook = (file: { id: string; name: string; path?: string } | undefined) => void
let onActiveChange: ActiveHook | null = null

export function setActiveHook(fn: ActiveHook) {
  onActiveChange = fn
}

/** 解析当前谱面；已载入音频时把小节网格铺到歌曲结束 */
function parseDoc(content: string, filePath?: string) {
  return parseChart(content, {
    audioDurationMs: engine.hasSong ? engine.durationMs : undefined,
    // 没有 [Files] path 时，相对路径以 .hs 所在目录为基准（打包给别人的谱子靠它）
    baseDir: filePath ? dirname(filePath) : undefined,
  })
}

/** auto 时按系统深浅色解析出实际主题 */
export function resolveTheme(t: ThemePref, systemDark: boolean): 'light' | 'dark' {
  return t === 'auto' ? (systemDark ? 'dark' : 'light') : t
}
/** 组件里渲染用的选择器：拿实际生效的主题（编辑器/时间轴画布只认 light|dark） */
export const selectResolvedTheme = (s: State) => resolveTheme(s.theme, s.systemDark)

const initialFiles = loadFiles()
const initialActive =
  (localStorage.getItem(LS_ACTIVE) && initialFiles.find((f) => f.id === localStorage.getItem(LS_ACTIVE))?.id) ||
  initialFiles[0].id

export const useStore = create<State>((set, get) => ({
  uiRev: 0,
  bumpUi: () => set((s) => ({ uiRev: s.uiRev + 1 })),
  files: initialFiles,
  activeId: initialActive,
  theme: loadTheme(),
  systemDark:
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  sidebar: 'explorer',
  sidebarOpen: true,
  sidebarWidth: loadSidebarWidth(),
  panel: 'timeline',
  panelOpen: true,
  panelHeight: 300,
  div: 4,
  follow: true,
  brushMode: 'single',
  brushPin: '',
  ksInst: '',
  ksBase: 60,
  editorMode: (localStorage.getItem(LS_EDITORMODE) === 'grid' ? 'grid' : 'text') as EditorMode,
  doc: (() => {
    const f = initialFiles.find((x) => x.id === initialActive)
    return parseDoc(f?.content ?? '', f?.path)
  })(),
  bindings: loadBindings(),
  output: [],
  cursor: { line: 1, col: 1, sel: 0 },
  audioTick: 0,
  typeSound: loadTypeSound(),

  setActive: (id) => {
    const cur = get().activeId
    localStorage.setItem(LS_ACTIVE, id)
    const f = get().files.find((x) => x.id === id)
    set({ activeId: id, doc: parseDoc(f?.content ?? '', f?.path) })
    engine.setEvents(get().doc)
    // 切到另一份谱面时，歌曲与音效样本都得跟着换，
    // 否则会一直用上一份谱的音频。同一份谱重复点击不重载。
    if (cur !== id) void onActiveChange?.(f)
  },
  updateContent: (id, content) => {
    set((s) => ({
      files: s.files.map((f) => {
        if (f.id !== id) return f
        // saved 为空表示从来没存过盘 —— 那也算脏，关闭时要提醒
        const base = f.saved ?? ''
        return { ...f, content, dirty: content !== base }
      }),
    }))
    persistFiles(get().files)
  },
  markSaved: (id, p) => {
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, path: p, saved: f.content, dirty: false } : f)),
    }))
    persistFiles(get().files)
  },
  attachPath: (id, p, content) => {
    set((s) => ({
      files: s.files.map((f) => {
        if (f.id !== id) return f
        const next = content ?? f.content
        return { ...f, path: p, content: next, saved: next, dirty: false }
      }),
    }))
    persistFiles(get().files)
    const s = get()
    if (s.activeId === id) {
      const file = s.files.find((f) => f.id === id)
      const doc = parseDoc(file?.content ?? '', file?.path)
      set({ doc })
      engine.setEvents(doc)
    }
  },
  reparse: () => {
    const s = get()
    const f = s.files.find((x) => x.id === s.activeId)
    const doc = parseDoc(f?.content ?? '', f?.path)
    set({ doc })
    engine.setEvents(doc)
  },
  newFile: (name, content) => {
    const id = get().addFile(name || 'untitled.hs', content ?? applyChartSettingsToText(TEMPLATE))
    get().setActive(id)
  },
  addFile: (name, content) => {
    const id = uid()
    set((s) => ({ files: [...s.files, { id, name, content: migrateSongToFiles(content) }] }))
    persistFiles(get().files)
    return id
  },
  closeFile: (id) => {
    const s = get()
    const files = s.files
    if (files.length <= 1) return
    const idx = files.findIndex((f) => f.id === id)
    const next = files[idx + 1] || files[idx - 1]
    set({ files: files.filter((f) => f.id !== id) })
    if (s.activeId === id) get().setActive(next.id)
    persistFiles(get().files)
  },
  renameFile: (id, name) => {
    set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, name } : f)) }))
    persistFiles(get().files)
  },
  deleteFile: (id) => get().closeFile(id),
  setTheme: (t) => {
    localStorage.setItem(LS_THEME, t)
    set({ theme: t })
  },
  setSidebar: (v) => set((s) => ({ sidebar: v, sidebarOpen: s.sidebar === v ? !s.sidebarOpen : true })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (w) => {
    // 不给主编辑区留出最小可用宽度的话就顶到上限
    const max = Math.max(240, Math.min(720, window.innerWidth - 380))
    const v = Math.round(Math.max(150, Math.min(max, w)))
    localStorage.setItem(LS_SIDEBARW, String(v))
    set({ sidebarWidth: v })
  },
  setPanel: (v) => set((s) => ({ panel: v, panelOpen: s.panel === v ? !s.panelOpen : true })),
  setEditorMode: (m) => {
    localStorage.setItem(LS_EDITORMODE, m)
    set({ editorMode: m })
  },
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelHeight: (h) => set({ panelHeight: Math.max(120, Math.min(700, h)) }),
  setDiv: (n) => set({ div: Math.max(1, Math.min(64, Math.round(n) || 1)) }),
  setFollow: (v) => set({ follow: v }),
  setBrushMode: (m) => set({ brushMode: m }),
  setBrushPin: (n) => set({ brushPin: n }),
  setKsInst: (n) => set({ ksInst: n }),
  // 锚点是「八度的 C」：C1(24) ~ C8(108)；A0–B0 直接点琴键
  setKsBase: (n) => set({ ksBase: Math.max(24, Math.min(108, Math.round(n) || 60)) }),
  log: (msg) => {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    set((s) => ({ output: [...s.output.slice(-199), `[${t}] ${msg}`] }))
  },
  clearLog: () => set({ output: [] }),
  setCursor: (c) => set({ cursor: c }),
  setBindings: (b) => {
    localStorage.setItem(LS_BINDINGS, JSON.stringify(b))
    set({ bindings: b })
  },
  bumpAudio: () => set((s) => ({ audioTick: s.audioTick + 1 })),
  setTypeSound: (v) => {
    localStorage.setItem(LS_TYPESOUND, v ? '1' : '0')
    set({ typeSound: v })
  },
}))

// 跟随系统主题：系统切换深浅色时更新 systemDark（theme='auto' 的组件会跟着重渲染）
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', (e) => useStore.setState({ systemDark: e.matches }))
}

// 恢复已保存的音效文件
const names = Object.keys(loadBindings())
if (names.length) engine.loadPersisted(names)

// 调试/自动化入口：让端到端脚本能直接读 store 状态（生产构建同样保留，无副作用）
// 调试/自动化入口：让端到端脚本能直接读 store 与音频引擎状态（生产构建同样保留，无副作用）
if (typeof window !== 'undefined') {
  ;(window as any).__store = useStore
  ;(window as any).__engine = engine
}
