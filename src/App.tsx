import { useEffect, useMemo, useRef } from 'react'
import { SIDEBAR_DEFAULT_WIDTH, selectResolvedTheme, useStore } from './store'
import TitleBar from './components/TitleBar'
import ActivityBar from './components/ActivityBar'
import SideBar from './components/SideBar'
import TabsBar from './components/TabsBar'
import Editor from './components/Editor'
import GridEditor from './components/GridEditor'
import BottomPanel from './components/BottomPanel'
import StatusBar from './components/StatusBar'
import OsuDifficultyPicker from './components/OsuDifficultyPicker'
import SoundImportDialog from './components/SoundImportDialog'
import KeysoundImportDialog from './components/KeysoundImportDialog'
import { reloadActiveAudio, saveActive } from './core/actions'
import { startAutoLoadWatch } from './core/autoLoadWatch'
import AppSettingsDialog from './components/AppSettingsDialog'
import AddSoundDialog from './components/AddSoundDialog'
import ChartPicker from './components/ChartPicker'
import FileDrop from './components/FileDrop'
import ReviewDialog from './components/ReviewDialog'
import EditMenuHost from './components/EditMenu'
import { engine } from './audio/engine'
import { useDesktopBridge } from './core/useDesktop'
import { isDesktop } from './core/desktop'
import { initI18n, t } from './i18n'

export default function App() {
  // 语言切换靠 bumpUi 触发整棵树重渲染
  useStore((s) => s.uiRev)
  // 渲染用「解析后」的实际主题：theme='auto' 时跟随系统深浅色
  const theme = useStore(selectResolvedTheme)
  const files = useStore((s) => s.files)
  const activeId = useStore((s) => s.activeId)
  const doc = useStore((s) => s.doc)
  const panelOpen = useStore((s) => s.panelOpen)
  const panelHeight = useStore((s) => s.panelHeight)
  const editorMode = useStore((s) => s.editorMode)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const sidebar = useStore((s) => s.sidebar)
  const active = files.find((f) => f.id === activeId)
  const content = active?.content ?? ''
  const updateContent = useStore((s) => s.updateContent)
  const reparse = useStore((s) => s.reparse)
  const resizing = useRef(false)
  /** 侧栏拖拽起点：按下时的鼠标 x 与侧栏原宽度 */
  const sidebarResizing = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Electron：接原生菜单动作 + 关闭前未保存提醒（浏览器下为空操作）
  useDesktopBridge()

  // 恢复上次会话时 activeId 是直接读出来的，不会触发 setActive 的音频钩子，
  // 这里补一次，否则一打开程序时间轴就是「未载入歌曲」。
  useEffect(() => {
    void initI18n()
    reloadActiveAudio()
    // 文本里出现音频路径就立即加载（不用再手动点「按 [Files] 自动载入」）
    startAutoLoadWatch()
  }, [])

  // Dev-only 调试钩子：把 store 挂到 window，便于 CDP 自动化验证（生产构建不包含）
  useEffect(() => {
    if ((import.meta as any).env?.DEV) (window as any).__store = useStore
  }, [])

  useEffect(() => {
    engine.setEvents(doc)
    const dm: Record<string, string> = {}
    const tune: Record<string, number> = {}
    for (const h of doc.hitsounds) {
      if (!h.name) continue
      if (h.defaultRef) dm[h.name] = h.defaultRef
      if (h.kind === 'keysound' && h.keys && h.keys.tune) tune[h.name] = h.keys.tune
    }
    engine.setDefaultMap(dm)
    engine.setKeyTune(tune)
  }, [doc])

  // 输入后延迟解析
  useEffect(() => {
    const t = window.setTimeout(() => reparse(), 180)
    return () => window.clearTimeout(t)
  }, [content, activeId, reparse])

  // 歌曲载入/切换后时长才知道，重新解析一次把网格铺到歌曲结束
  const lastDur = useRef(-1)
  useEffect(() => {
    const check = () => {
      const d = engine.hasSong ? engine.durationMs : -1
      if (d !== lastDur.current) {
        lastDur.current = d
        reparse()
      }
    }
    check()
    return engine.subscribe(check)
  }, [reparse])

  const definedNames = useMemo(() => {
    const s = new Set<string>()
    doc.hitsounds.forEach((h) => h.name && s.add(h.name))
    return s
  }, [doc])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const inEditor =
        !!el &&
        (el.classList.contains('cm-content') ||
          !!el.closest?.('.gd-wrap') ||
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT')
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        // Electron 下 Ctrl+S 由原生菜单接管（真写盘），这里只处理浏览器模式
        if (isDesktop()) {
          void saveActive(e.shiftKey)
          return
        }
        reparse()
        useStore.getState().log(t('已保存到浏览器本地'))
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        useStore.getState().toggleSidebar()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '`' || e.key.toLowerCase() === 'j')) {
        e.preventDefault()
        useStore.getState().togglePanel()
        return
      }
      if (e.key === 'F5') {
        e.preventDefault()
        reparse()
        return
      }
      if (e.code === 'Space' && !inEditor) {
        e.preventDefault()
        engine.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reparse])

  // 分隔条拖拽（底部面板 ns / 侧栏 ew）。用 Pointer 事件，鼠标和触摸（手机远程编辑）都能拖
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (resizing.current) {
        const h = window.innerHeight - e.clientY - 24
        useStore.getState().setPanelHeight(h)
      }
      const sr = sidebarResizing.current
      if (sr) useStore.getState().setSidebarWidth(sr.startW + e.clientX - sr.startX)
    }
    const up = () => {
      resizing.current = false
      sidebarResizing.current = null
      document.body.classList.remove('row-resizing', 'col-resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />
      <div className="workbench">
        <ActivityBar />
        {sidebarOpen && (
          <>
            {/* .sidebar 包裹层：CSS 里定义了 260px 竖排列，但之前一直没有实际节点，
                标题和内容变成了 workbench 的横排 flex 项（侧栏整体是坏的） */}
            <div className="sidebar" style={{ width: sidebarWidth }}>
              <SideBar />
            </div>
            <div
              className="sidebar-resizer"
              title={t('拖动调整宽度 · 双击恢复默认')}
              onPointerDown={(e) => {
                e.preventDefault()
                sidebarResizing.current = { startX: e.clientX, startW: useStore.getState().sidebarWidth }
                document.body.classList.add('col-resizing')
              }}
              onDoubleClick={() => useStore.getState().setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
            />
          </>
        )}
        <div className="main">
          <TabsBar />
          <div className="breadcrumb">
            <span>{t('工作区')}</span>
            <span>›</span>
            <b>{active?.name || '—'}</b>
            <span>›</span>
            <span>
              {doc.sections.length} {t('个段')} · {doc.events.length} {t('音符')} · {doc.usedMeasures} {t('小节')}
            </span>
            <span style={{ flex: 1 }} />
            <span className="hint">
              {t('按 Ctrl+S 保存 · Space 播放/暂停 · Ctrl+B 侧栏')}
            </span>
            <div className="mode-switch" title={t('切换主编辑区：文本 / 格子')}>
              <button
                className={editorMode === 'text' ? 'on' : ''}
                onClick={() => useStore.getState().setEditorMode('text')}
              >
                {t('文本')}
              </button>
              <button
                className={editorMode === 'grid' ? 'on' : ''}
                onClick={() => useStore.getState().setEditorMode('grid')}
              >
                {t('格子')}
              </button>
            </div>
          </div>
          {editorMode === 'text' ? (
            <Editor
              fileId={activeId}
              content={content}
              theme={theme}
              diagnostics={doc.diagnostics}
              definedNames={definedNames}
              onChange={(v) => updateContent(activeId, v)}
              onCursor={(line, col, sel) => useStore.getState().setCursor({ line, col, sel })}
              onView={(v) => ((window as any).__cmView = v)}
              onNameTyped={(name) => {
                if (!useStore.getState().typeSound) return
                engine.playSample(name, 100)
              }}
            />
          ) : (
            <div className="editor-area">
              <GridEditor
                fileId={activeId}
                doc={doc}
                theme={theme}
                onPlaySample={(n, v) => engine.playSample(n, v)}
              />
            </div>
          )}
          <div
            className="panel-resizer"
            onPointerDown={(e) => {
              e.preventDefault()
              resizing.current = true
              document.body.classList.add('row-resizing')
            }}
            style={{ display: panelOpen ? 'block' : 'none' }}
          />
          {panelOpen && (
            <div className="panel" style={{ height: panelHeight }}>
              <BottomPanel />
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <OsuDifficultyPicker />
      <SoundImportDialog />
      <KeysoundImportDialog />
      <AppSettingsDialog />
      <AddSoundDialog />
      <ChartPicker />
      <ReviewDialog />
      <FileDrop />
      <EditMenuHost />
    </div>
  )
}
