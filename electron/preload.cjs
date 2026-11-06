/**
 * preload：只把必要的 IPC 通道包成 window.desktop，渲染进程不直接碰 node/electron。
 * 所有能力在浏览器（纯 web dev）下不存在，renderer 侧靠 typeof 判断自动回退。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  /** 是否在 Electron 客户端里运行 */
  isElectron: true,
  platform: process.platform,

  // ---- 对话框 ----
  openFiles: (opts) => ipcRenderer.invoke('dialog:openFiles', opts),
  openFolder: (opts) => ipcRenderer.invoke('dialog:openFolder', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  loadChartFolder: (opts) => ipcRenderer.invoke('folder:loadCharts', opts),
  resolveChartAssets: (opts) => ipcRenderer.invoke('folder:resolveAssets', opts),
  exportOsuPackage: (opts) => ipcRenderer.invoke('export:osuPackage', opts),
  messageBox: (opts) => ipcRenderer.invoke('dialog:messageBox', opts),

  // ---- 文件读写 ----
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  hashFile: (p) => ipcRenderer.invoke('fs:hash', p),
  audioDuration: (p) => ipcRenderer.invoke('fs:audioDuration', p),
  listOsuDifficulties: (p) => ipcRenderer.invoke('osu:listDifficulties', p),
  // ---- osu! 谱面库（按 Mapset Verifier 的顺序）----
  osuDetectSongsFolder: () => ipcRenderer.invoke('osu:detectSongsFolder'),
  osuListMapsets: (opts) => ipcRenderer.invoke('osu:listMapsets', opts),
  osuCurrentMapset: (opts) => ipcRenderer.invoke('osu:currentMapset', opts),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),
  writeText: (p, text) => ipcRenderer.invoke('fs:writeText', p, text),
  readBinary: (p) => ipcRenderer.invoke('fs:readBinary', p),
  /** 复制文件（不改名源文件）；「所有音效收进谱面文件夹」用 */
  copyFile: (from, to) => ipcRenderer.invoke('fs:copyFile', from, to),
  /** 移动文件（跨盘自动退化） */
  moveFile: (from, to) => ipcRenderer.invoke('fs:moveFile', from, to),
  wavMeta: (p) => ipcRenderer.invoke('fs:wavMeta', p),
  // 已绑定音效的持久化副本（file:// 下 IndexedDB 不可用，改存 userData/samples）
  sampleWrite: (name, data) => ipcRenderer.invoke('sample:write', name, data),
  sampleRead: (name) => ipcRenderer.invoke('sample:read', name),
  sampleDelete: (name) => ipcRenderer.invoke('sample:delete', name),
  sampleList: () => ipcRenderer.invoke('sample:list'),
  listDir: (root, opts) => ipcRenderer.invoke('fs:listDir', root, opts),

  // ---- 语言包 ----
  listLangs: () => ipcRenderer.invoke('langs:list'),
  saveLang: (id, text) => ipcRenderer.invoke('langs:save', id, text),
  deleteLang: (id) => ipcRenderer.invoke('langs:delete', id),
  openLangDir: () => ipcRenderer.invoke('langs:openDir'),
  setAppLang: (id) => ipcRenderer.invoke('app:setLang', id),

  // ---- 应用 ----
  getPrefs: () => ipcRenderer.invoke('app:getPrefs'),  setPrefs: (patch) => ipcRenderer.invoke('app:setPrefs', patch),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  /** 用系统默认程序打开链接（osu://edit/… 唤起 osu! 编辑器） */
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  /**
   * 拖进窗口的文件 → 磁盘路径。
   * Electron 32 起 File.path 没了，只能走 webUtils.getPathForFile。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  version: () => ipcRenderer.invoke('app:version'),
  confirmClose: () => ipcRenderer.invoke('app:confirmClose'),

  /**
   * 系统剪贴板：走主进程（Electron 20 起 renderer 默认 sandbox，
   * preload 里拿不到 clipboard 模块）。
   */
  clipboardReadText: () => ipcRenderer.invoke('app:clipboardRead'),
  clipboardWriteText: (text) => ipcRenderer.invoke('app:clipboardWrite', text),

  /** 把主题 / 节拍器 / 输入音效的勾选状态同步给原生菜单 */
  setMenuState: (st) => ipcRenderer.send('menu:setState', st),

  /** 订阅原生菜单动作 / 关闭请求 */
  onMenu: (handler) => {
    const chans = [
      'menu:new',
      'menu:open',
      'menu:openFolder',
      'menu:openChartFolder',
      'menu:save',
      'menu:saveAs',
      'menu:openChartDir',
      'menu:bundleSounds',
      'menu:import',
      'menu:importSounds',
      'menu:exportOsu',
      'menu:exportOsuPackage',
      'menu:exportCsv',
      'menu:exportJson',
      'menu:exportTxt',
      'menu:demo',
      'menu:reparse',
      'menu:settings',
      'menu:view',
      'menu:panel',
      'menu:theme',
      'menu:toggle',
      'menu:seek0',
      'menu:metronome',
      'menu:typeSound',
      'menu:review',
      'menu:openUserData',
    ]
    const listeners = chans.map((c) => {
      const fn = (_e, ...args) => handler(c.replace(/^menu:/, ''), ...args)
      ipcRenderer.on(c, fn)
      return [c, fn]
    })
    const closeFn = () => handler('close-requested')
    ipcRenderer.on('app:close-requested', closeFn)
    // 返回取消订阅函数
    return () => {
      listeners.forEach(([c, fn]) => ipcRenderer.removeListener(c, fn))
      ipcRenderer.removeListener('app:close-requested', closeFn)
    }
  },
})
