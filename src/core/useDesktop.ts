/**
 * 桌面端桥接 hook：把 Electron 原生菜单动作 / 关闭请求接到 store 与命令层。
 * 浏览器下 desktopApi() 返回 null，整个 hook 是空操作，不影响现有行为。
 */
import { useEffect } from 'react'
import { useStore } from '../store'
import { desktopApi, isDesktop } from './desktop'
import {
  bundleSoundsToChartDir,
  exportCsv,
  exportJson,
  exportOsu,
  exportOsuPackage,
  exportTxt,
  newChart,
  openChartDir,
  openDemo,
  openFiles,
  openChartFolder,
  importOsu,
  importOsuSounds,
  saveActive,
} from './actions'
import { engine } from '../audio/engine'
import { openAppSettings } from '../components/AppSettingsDialog'
import { openReview, type ReviewKind } from '../components/ReviewDialog'

export { isDesktop }

/** 关窗前的未保存提醒：返回 true 表示可以关了 */
async function handleCloseRequest(): Promise<void> {
  const api = desktopApi()
  if (!api) return
  const s = useStore.getState()
  const dirty = s.files.filter((f) => f.dirty)
  if (!dirty.length) {
    await api.confirmClose()
    return
  }
  const names = dirty.map((f) => f.name).join('、')
  const choice = await api.messageBox({
    type: 'warning',
    buttons: ['保存并退出', '直接退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '未保存的改动',
    message: '有未保存的改动，要保存吗？',
    detail: `${names}\n\n「保存并退出」会写回已打开的磁盘文件；从未保存过的会先让你选位置。`,
  })
  if (choice === 2) return // 取消：不关
  if (choice === 0) {
    // 逐个脏文件保存；任何一个在另存为对话框里被取消，就放弃关闭
    for (const f of dirty) {
      const cur = useStore.getState()
      if (cur.activeId !== f.id) cur.setActive(f.id)
      const ok = await saveActive(false)
      if (!ok) return
    }
  }
  await api.confirmClose()
}

export function useDesktopBridge() {
  useEffect(() => {
    const api = desktopApi()
    if (!api) return
    const off = api.onMenu((action, ...args) => {
      const s = useStore.getState()
      switch (action) {
        case 'new':
          return newChart()
        case 'open':
          return void openFiles()
        case 'openChartFolder':
          return void openChartFolder()
        case 'openFolder':
          // 打开资源文件夹 = 触发侧栏的「按 [Files] 自动载入」
          return (window as any).__autoLoadFolder && (window as any).__autoLoadFolder()
        case 'demo':
          return openDemo()
        case 'save':
          return void saveActive(false)
        case 'saveAs':
          return void saveActive(true)
        case 'openChartDir':
          return void openChartDir()
        case 'bundleSounds':
          return void bundleSoundsToChartDir()
        case 'import':
          return void importOsu()
        case 'importSounds':
          return void importOsuSounds()
        case 'exportOsuPackage':
          return void exportOsuPackage()
        case 'exportOsu':
          return void exportOsu()
        case 'exportCsv':
          return void exportCsv()
        case 'exportJson':
          return void exportJson()
        case 'exportTxt':
          return void exportTxt()
        case 'reparse':
          return s.reparse()
        case 'settings':
          return openAppSettings()
        case 'view':
          return s.setSidebar(args[0])
        case 'panel':
          return s.setPanel(args[0])
        case 'theme':
          return s.setTheme(args[0])
        case 'toggle':
          return engine.toggle()
        case 'seek0':
          return engine.seek(0)
        case 'metronome':
          return engine.setMetronome(!engine.metronome)
        case 'typeSound':
          return s.setTypeSound(!s.typeSound)
        case 'review':
          return openReview((args[0] as ReviewKind) || 'usage')
        case 'openUserData':
          return void (async () => {
            const p = await api.getPrefs()
            void p
          })()
        case 'close-requested':
          return void handleCloseRequest()
        default:
          return undefined
      }
    })

    // 原生菜单里的勾选项（主题 / 节拍器 / 输入音效）需要跟随实际状态，
    // 只在值真正变化时同步，避免播放时每个 tick 都发一次 IPC。
    let last = ''
    const syncMenuState = () => {
      const cur = useStore.getState()
      const key = `${cur.theme}|${engine.metronome}|${cur.typeSound}`
      if (key === last) return
      last = key
      api.setMenuState({ theme: cur.theme, metronome: engine.metronome, typeSound: cur.typeSound })
    }
    syncMenuState()
    const offStore = useStore.subscribe(syncMenuState)
    const offEngine = engine.subscribe(syncMenuState)

    return () => {
      off()
      offStore()
      offEngine()
    }
  }, [])
}
