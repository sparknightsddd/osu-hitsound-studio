/**
 * Electron 主进程：窗口 + 原生菜单 + 真实文件读写 + 关闭前未保存提醒。
 *
 * 渲染进程一律通过 preload 暴露的 window.desktop 调用，不直接 require('fs')。
 * 开发模式连 http://127.0.0.1:5173（Vite dev server），生产模式加载 dist/index.html。
 */
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { readWav } = require('./wav-mix.cjs')
const { exportPackage } = require('./osu-export.cjs')

// 开发模式由 electron-dev.cjs 显式注入 VITE_DEV_SERVER_URL；
// 没注入就走 dist（所以 `vite build && electron .` 直接跑生产产物）
const IS_DEV = !!process.env.VITE_DEV_SERVER_URL
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'

let win = null
/** 已经走完「未保存提醒」流程、允许真正关闭了 */
let closeConfirmed = false

/** 最近一次打开的目录，持久化到 userData 下，下次打开对话框直接落在这里 */
function prefPath() {
  return path.join(app.getPath('userData'), 'prefs.json')
}

async function loadPrefs() {
  try {
    return JSON.parse(await fsp.readFile(prefPath(), 'utf8'))
  } catch {
    return {}
  }
}
async function savePrefs(p) {
  try {
    await fsp.writeFile(prefPath(), JSON.stringify(p, null, 2), 'utf8')
  } catch {
    /* 写不进去不影响使用 */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#ffffff',
    title: 'osu Hitsound Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 允许载入本地音频/图片，file:// 下也能 decode
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  // Ctrl+, 打开设置（菜单项没有用 accelerator，见上面的说明）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (mod && !input.alt && !input.shift && (input.key === ',' || input.code === 'Comma')) {
      event.preventDefault()
      send('menu:settings')
    }
  })

  if (IS_DEV) {
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 关闭前未保存提醒：
  // 主进程无法同步读到渲染进程的状态，所以改成异步握手 ——
  // 先拦下 close 并通知渲染进程，渲染进程自己判断脏不脏、弹原生确认框、保存，
  // 全部处理完再回调 app:confirmClose，那时才真正销毁窗口。
  win.on('close', (e) => {
    if (closeConfirmed) return
    e.preventDefault()
    if (win && !win.isDestroyed()) win.webContents.send('app:close-requested')
  })

  win.on('closed', () => {
    win = null
  })

  // 外部链接交给系统浏览器，别在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** 原生菜单里那几项「有状态」的勾选，由渲染进程通过 menu:setState 同步过来 */
const menuState = { theme: 'auto', metronome: false, typeSound: true }

/**
 * 原生菜单语言。
 *
 * 渲染进程切语言时通过 `app:setLang` 同步过来；启动时从 prefs.json 恢复。
 * 只有内置的 zh-CN / en-US 会翻译原生菜单，第三方 .lang 只影响页面内容。
 */
let appLang = 'zh-CN'
const isEN = () => String(appLang).toLowerCase().startsWith('en')
/** 原生菜单里的双语文本：M('中文', 'English') */
const M = (zh, en) => (isEN() ? en : zh)

/** 原生菜单：所有操作通过 send 转发给渲染进程，渲染进程自己决定怎么做 */
function buildMenu() {
  const act = (channel, ...args) => ({
    click: () => send('menu:' + channel, ...args),
  })
  const themeItem = (key, label) => ({
    label,
    type: 'checkbox',
    checked: menuState.theme === key,
    click: () => send('menu:theme', key),
  })

  const template = [
    {
      label: M('文件', 'File'),
      submenu: [
        { label: M('新建音效谱', 'New hitsound chart'), accelerator: 'CmdOrCtrl+N', ...act('new') },
        { label: M('打开歌曲文件夹…（含音频）', 'Open song folder… (with audio)'), accelerator: 'CmdOrCtrl+O', ...act('openChartFolder') },
        { label: M('打开 .hs 文件…', 'Open .hs file…'), accelerator: 'CmdOrCtrl+I', ...act('open') },
        { label: M('从 .osu 导入（另存为 .hs，原谱只读）', 'Import from .osu (save as .hs, read-only source)'), ...act('import') },
        { label: M('从 .osu 导入音效…', 'Import hitsounds from .osu…'), accelerator: 'CmdOrCtrl+Shift+I', ...act('importSounds') },
        { label: M('导入 MIDI / musictxt 到 [Keysound]…', 'Import MIDI / musictxt into [Keysound]…'), ...act('importKeysound') },
        { label: M('打开示例谱面', 'Open sample chart'), ...act('demo') },
        { type: 'separator' },
        { label: M('保存', 'Save'), accelerator: 'CmdOrCtrl+S', ...act('save') },
        { label: M('另存为…', 'Save as…'), accelerator: 'CmdOrCtrl+Shift+S', ...act('saveAs') },
        { type: 'separator' },
        { label: M('打开谱面文件夹', 'Open chart folder'), ...act('openChartDir') },
        { label: M('将所有音效复制到谱面文件夹内（改名为代号）', 'Copy all hitsounds into chart folder (rename to codes)'), ...act('bundleSounds') },
        { type: 'separator' },
        { label: M('导出音效包（写入 [Files] path）', 'Export hitsound package (into [Files] path)'), accelerator: 'CmdOrCtrl+E', ...act('exportOsuPackage') },
        { label: M('把音效写入 .osu…（替代 Hitsound Copier）', 'Write hitsounds into .osu… (Hitsound Copier replacement)'), ...act('writeOsuHitsounds') },
        { label: M('另存为 .osu…（不复制音效）', 'Save as .osu… (no sound files)'), ...act('exportOsu') },
        { label: M('导出时间轴 CSV', 'Export timeline CSV'), ...act('exportCsv') },
        { label: M('导出音效映射 JSON', 'Export sound map JSON'), ...act('exportJson') },
        { label: M('导出音效映射 TXT', 'Export sound map TXT'), ...act('exportTxt') },
        { type: 'separator' },
        { label: M('打开资源文件夹…', 'Open samples folder…'), accelerator: 'CmdOrCtrl+Shift+O', ...act('openFolder') },
        { type: 'separator' },
        { role: 'quit', label: M('退出', 'Quit') },
      ],
    },
    {
      label: M('编辑', 'Edit'),
      submenu: [
        { role: 'undo', label: M('撤销', 'Undo') },
        { role: 'redo', label: M('重做', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: M('剪切', 'Cut') },
        { role: 'copy', label: M('复制', 'Copy') },
        { role: 'paste', label: M('粘贴', 'Paste') },
        { role: 'selectAll', label: M('全选', 'Select all') },
        { type: 'separator' },
        { label: M('重新解析谱面', 'Reparse chart'), accelerator: 'F5', ...act('reparse') },
        { type: 'separator' },
        // 快捷键写进标题、自己拦：Electron 的 accelerator 文案由系统生成，
        // 中文 Windows 上会显示成「Ctrl+逗号」，没法随界面语言切换。
        { label: `${M('设置…', 'Settings…')} (${process.platform === 'darwin' ? '⌘,' : 'Ctrl+,'})`, ...act('settings') },
      ],
    },
    {
      label: M('视图', 'View'),
      submenu: [
        { label: M('资源管理器', 'Explorer'), accelerator: 'CmdOrCtrl+B', ...act('view', 'explorer') },
        { label: M('谱面库（osu! Songs）', 'Beatmap library (osu! Songs)'), ...act('view', 'mapsets') },
        { label: M('音频与试听', 'Audio & preview'), ...act('view', 'audio') },
        { label: M('设定', 'Chart settings'), ...act('view', 'settings') },
        { type: 'separator' },
        { label: M('问题面板', 'Problems'), ...act('panel', 'problems') },
        { label: M('时间轴', 'Timeline'), ...act('panel', 'timeline') },
        { label: M('音效库', 'Sound library'), ...act('panel', 'samples') },
        { label: M('输出', 'Output'), ...act('panel', 'output') },
        { type: 'separator' },
        themeItem('light', M('浅色主题', 'Light theme')),
        themeItem('dark', M('深色主题', 'Dark theme')),
        themeItem('auto', M('跟随系统', 'Follow system')),
        { type: 'separator' },
        { role: 'reload', label: M('重新加载', 'Reload') },
        { role: 'toggleDevTools', label: M('开发者工具', 'Developer tools') },
        { role: 'togglefullscreen', label: M('全屏', 'Full screen') },
      ],
    },
    {
      label: M('播放', 'Playback'),
      submenu: [
        { label: M('播放 / 暂停', 'Play / Pause'), accelerator: 'Space', ...act('toggle') },
        { label: M('回到开头', 'Go to start'), accelerator: 'Home', ...act('seek0') },
        { type: 'separator' },
        { label: M('节拍器', 'Metronome'), type: 'checkbox', checked: menuState.metronome, ...act('metronome') },
        {
          label: M('输入字符后播放音效', 'Play sound when typing'),
          type: 'checkbox',
          checked: menuState.typeSound,
          ...act('typeSound'),
        },
      ],
    },
    {
      label: M('审阅', 'Review'),
      submenu: [
        { label: M('音效使用次数统计', 'Hitsound usage report'), ...act('review', 'usage') },
        { label: M('槽位冲突检测', 'Slot conflict check'), ...act('review', 'conflict') },
        { label: M('重复槽位音效检测', 'Duplicate slot sounds'), ...act('review', 'dup') },
      ],
    },
    {
      label: M('帮助', 'Help'),
      submenu: [
        { label: M('在资源管理器中显示配置目录', 'Show config folder'), ...act('openUserData') },
        { type: 'separator' },
        { role: 'about', label: M('关于', 'About') },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 渲染进程同步「主题 / 节拍器 / 输入音效」的勾选状态 */
ipcMain.on('menu:setState', (_e, st) => {
  if (!st) return
  let changed = false
  for (const k of ['theme', 'metronome', 'typeSound']) {
    if (st[k] !== undefined && menuState[k] !== st[k]) {
      menuState[k] = st[k]
      changed = true
    }
  }
  if (changed) buildMenu()
})

// ---------------- IPC ----------------

/** 打开文件对话框（可多选），返回 { canceled, files: [{name, path}] } */
ipcMain.handle('dialog:openFiles', async (_e, opts = {}) => {
  const prefs = await loadPrefs()
  // 自动化测试钩子：HSS_TEST_OPEN_FILES 给出逗号分隔的路径，跳过原生对话框直接返回
  if (process.env.HSS_TEST_OPEN_FILES) {
    const files = process.env.HSS_TEST_OPEN_FILES.split(';').filter(Boolean).map((p) => ({
      name: path.basename(p),
      path: p,
    }))
    return { canceled: !files.length, files }
  }
  const res = await dialog.showOpenDialog(win, {
    title: opts.title || '打开谱面',
    defaultPath: opts.defaultPath || prefs.lastDir || app.getPath('documents'),
    filters: opts.filters || [
      { name: '本程序可编辑的谱面 (.hs)', extensions: ['hs'] },
      { name: 'osu! 谱面（只读）', extensions: ['osu'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  })
  if (res.canceled) return { canceled: true, files: [] }
  const files = res.filePaths.map((p) => ({ name: path.basename(p), path: p }))
  if (files.length) await savePrefs({ ...prefs, lastDir: path.dirname(files[0].path) })
  return { canceled: false, files }
})

const AUDIO_EXT = /\.(mp3|ogg|wav|flac|m4a|aac|opus|mp4|webm|sf2|sf3|sfz)$/i

/**
 * 从 .osu / .hs 文本里抠出音频文件名（osu! 叫 AudioFilename，本程序 [Files] 里叫 audio）。
 * 只取第一行，忽略注释。
 */
function parseAudioRef(text) {
  const re = /^[ \t]*(?:AudioFilename|audio)[ \t]*[:=][ \t]*(.+)$/im
  const m = re.exec(text)
  if (!m) return ''
  return m[1].trim().replace(/^["']|["']$/g, '')
}

/**
 * 打开一个歌曲文件夹：以「文件夹」为基本单位列出其中所有谱面，
 * 并顺着 .osu / .hs 里的 AudioFilename 字段把歌曲音频一起找出来。
 *
 * 返回 {
 *   canceled, dir,
 *   charts: [{name, path, ext, editable, size, mtimeMs, audioRef, audioPath}],
 *   audios: [{name, path, relPath, size}],      // 目录内所有音频（含各谱引用的）
 *   song:   {path, relPath, name, fromChart} | null   // 最佳匹配的歌曲音频
 * }
 *   - *.hs  → editable: true   本程序自己的可编辑格式
 *   - *.osu → editable: false  osu! 原谱，仅作只读参考，绝不回写
 */
/**
 * 递归收集目录下的所有音频文件。
 *
 * osu! 歌曲目录常见 `song/audio.mp3` + `song/hitsounds/*.wav` 的结构，
 * 只扫顶层会漏掉全部音效样本，导致「打开文件夹只加载了歌曲」。
 *
 * @returns { list, byName } list 是相对路径（正斜杠）列表；byName 是「小写文件名 -> 完整路径」
 */
async function collectAudioFiles(root, maxDepth = 3) {
  const list = []
  const byName = new Map()
  const walk = async (cur, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!e.isFile() || !AUDIO_EXT.test(e.name)) continue
      let st
      try {
        st = await fsp.stat(full)
      } catch {
        continue
      }
      const rel = path.relative(root, full).replace(/\\/g, '/')
      // 同名文件保留先找到的那个，避免子目录里的同名音频覆盖顶层的
      if (!byName.has(e.name.toLowerCase())) byName.set(e.name.toLowerCase(), full)
      list.push({ name: e.name, path: full, relPath: rel, size: st.size, depth })
    }
  }
  await walk(root, 0)
  list.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { list, byName }
}

/** 按 AudioFilename（可能是纯文件名，也可能带子目录）在音频表里找对应文件 */
function matchAudioByRef(audioByName, audioRef) {
  const base = path.basename(audioRef).toLowerCase()
  const exact = audioByName.get(base)
  if (exact) return exact
  // 退一步：主名相同、扩展名不同的近似匹配
  const stem = base.replace(/\.[^.]+$/, '')
  for (const [k, v] of audioByName) {
    if (k.replace(/\.[^.]+$/, '') === stem) return v
  }
  return ''
}

ipcMain.handle('folder:loadCharts', async (_e, opts = {}) => {
  const prefs = await loadPrefs()
  let dir = opts.dir || ''
  // 自动化测试钩子：直接用指定目录，跳过原生对话框
  if (!dir && process.env.HSS_TEST_OPEN_FOLDER) dir = process.env.HSS_TEST_OPEN_FOLDER
  if (!dir) {
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || '打开歌曲文件夹（其中存放 .hs 谱面与 .osu 原谱）',
      defaultPath: prefs.lastDir || app.getPath('documents'),
      properties: ['openDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return { canceled: true, dir: '', charts: [], audios: [] }
    dir = res.filePaths[0]
  }

  const charts = []
  let audios = []
  try {
    const names = await fsp.readdir(dir)

    // 1) 收音频（递归，含子目录里的音效样本）
    const collected = await collectAudioFiles(dir)
    audios = collected.list
    const audioByName = collected.byName

    // 2) 再收谱面（只看顶层，osu! 惯例谱面与歌曲同级），并顺手解析它引用的音频
    for (const n of names) {
      const m = /\.(hs|osu)$/i.exec(n)
      if (!m) continue
      const full = path.join(dir, n)
      const st = await fsp.stat(full)
      if (!st.isFile()) continue

      let audioRef = ''
      let audioPath = ''
      try {
        // 谱面通常不大，直接读文本头部即可
        const buf = await fsp.readFile(full)
        audioRef = parseAudioRef(buf.toString('utf8'))
      } catch {
        /* 读不出就留空，不影响谱面本身载入 */
      }
      if (audioRef) audioPath = matchAudioByRef(audioByName, audioRef)

      charts.push({
        name: n,
        path: full,
        ext: m[1].toLowerCase(),
        editable: m[1].toLowerCase() === 'hs',
        size: st.size,
        mtimeMs: st.mtimeMs,
        audioRef,
        audioPath,
      })
    }
  } catch (err) {
    return {
      canceled: false,
      dir,
      charts: [],
      audios: [],
      error: String(err && err.message ? err.message : err),
    }
  }

  charts.sort((a, b) => a.name.localeCompare(b.name))

  // 3) 选一个"代表歌曲音频"：优先取第一个能解析到的谱面所引用的音频
  let song = null
  const withAudio = charts.filter((c) => c.audioPath)
  if (withAudio.length) {
    // 有 .hs 就优先用 .hs 引用的（那是本程序正在编辑的那份）
    const pick = withAudio.find((c) => c.editable) || withAudio[0]
    const f = audios.find((a) => a.path === pick.audioPath)
    song = {
      path: pick.audioPath,
      relPath: f ? f.relPath : path.basename(pick.audioPath),
      name: f ? f.name : path.basename(pick.audioPath),
      fromChart: pick.name,
    }
  } else if (audios.length) {
    // 没有谱面引用，退而求其次：取第一个「像歌曲」的音频。
    // 递归收集后目录里可能混着一堆音色样本，优先挑顶层的常见音乐格式。
    const SONG_PREF = ['.mp3', '.ogg', '.flac', '.m4a', '.wav']
    const SF_EXT = new Set(['.sf2', '.sf3', '.sfz'])
    const top = audios.filter((a) => !a.depth)
    const pool = (top.length ? top : audios).filter((a) => !SF_EXT.has(path.extname(a.name).toLowerCase()))
    const a =
      pool.find((x) => SONG_PREF.includes(path.extname(x.name).toLowerCase())) ||
      pool.find((x) => path.extname(x.name).toLowerCase() !== '.wav') ||
      pool[0]
    song = { path: a.path, relPath: a.relPath, name: a.name, fromChart: '' }
  }

  await savePrefs({ ...prefs, lastDir: dir })
  return { canceled: false, dir, charts, audios, song }
})

/**
 * 以某个谱面为基准，重新解析它引用的歌曲音频 + 目录里的音效样本。
 *
 * 切换谱面时用：同一个歌曲目录里的多份谱面往往引用同一首歌，
 * 但音效样本各自独有，必须按当前谱面重新配对，
 * 否则会出现「切到另一个谱，音效还是上一个谱的」。
 */
ipcMain.handle('folder:resolveAssets', async (_e, opts = {}) => {
  try {
    const chartPath = String(opts.chartPath || '')
    // chartPath 可以为空 —— 从 .osu 导入出来的 .hs 没挂原路径，
    // 这时只要给出它 [Files] path 里的来源目录即可。
    const dir = opts.dir || (chartPath ? path.dirname(chartPath) : '')
    if (!dir) return { ok: false, dir: '', assets: [], error: '缺少谱面路径或目录' }
    const { list, byName } = await collectAudioFiles(dir)

    let songPath = ''
    let audioRef = ''
    if (chartPath) {
      try {
        const buf = await fsp.readFile(chartPath)
        audioRef = parseAudioRef(buf.toString('utf8'))
      } catch {
      /* 谱面读不出来就只返回音效样本 */
      }
      if (audioRef) songPath = matchAudioByRef(byName, audioRef)
    } else {
      // 只有目录没有谱面：优先按调用方给的 [Files] audio 文件名精确匹配，
      // 匹配不到才退化成「挑一个像歌曲的顶层音频」。
      // （只看启发式的话，目录里有多个音频时会挑错，表现就是「导入后音频对不上」）
      const ref = String(opts.audio || '').trim()
      if (ref) songPath = matchAudioByRef(byName, ref) || ''
      if (!songPath) {
        const SONG_PREF = ['.mp3', '.ogg', '.flac', '.m4a', '.wav']
        const SF_EXT = new Set(['.sf2', '.sf3', '.sfz'])
        const top = list.filter((a) => !a.depth)
        const pool = (top.length ? top : list).filter((a) => !SF_EXT.has(path.extname(a.name).toLowerCase()))
        const a =
          pool.find((x) => SONG_PREF.includes(path.extname(x.name).toLowerCase())) ||
          pool.find((x) => path.extname(x.name).toLowerCase() !== '.wav') ||
          pool[0]
        if (a) songPath = a.path
      }
    }

    const songFile = songPath ? list.find((a) => a.path === songPath) : null
    return {
      ok: true,
      dir,
      songPath: songPath || undefined,
      songName: songFile ? songFile.name : songPath ? path.basename(songPath) : undefined,
      songRel: songFile ? songFile.relPath : undefined,
      assets: list.map(({ name, path: p, relPath, size }) => ({ name, path: p, relPath, size })),
    }
  } catch (e) {
    return { ok: false, dir: '', assets: [], error: String(e && e.message ? e.message : e) }
  }
})

/** 选择文件夹（用于按 [Files] 自动配对音效） */
ipcMain.handle('dialog:openFolder', async (_e, opts = {}) => {
  const prefs = await loadPrefs()
  const res = await dialog.showOpenDialog(win, {
    title: opts.title || '选择歌曲文件夹',
    defaultPath: opts.defaultPath || prefs.lastDir || app.getPath('documents'),
    properties: ['openDirectory'],
  })
  if (res.canceled) return { canceled: true, dir: '' }
  await savePrefs({ ...prefs, lastDir: res.filePaths[0] })
  return { canceled: false, dir: res.filePaths[0] }
})

/** 保存对话框，返回路径或 null */
ipcMain.handle('dialog:saveFile', async (_e, opts = {}) => {
  // 自动化测试钩子：直接返回指定路径，跳过原生对话框
  if (process.env.HSS_TEST_SAVE_FILE) return { canceled: false, path: process.env.HSS_TEST_SAVE_FILE }
  const prefs = await loadPrefs()
  const res = await dialog.showSaveDialog(win, {
    title: opts.title || '保存谱面',
    defaultPath: opts.defaultPath || path.join(prefs.lastDir || app.getPath('documents'), opts.name || 'chart.hs.txt'),
    filters: opts.filters || [
      { name: '音效谱', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  if (res.canceled || !res.filePath) return { canceled: true, path: '' }
  await savePrefs({ ...prefs, lastDir: path.dirname(res.filePath) })
  return { canceled: false, path: res.filePath }
})

/** 读 WAV 里的 HSSM 混音信息（重新导入时还原混音前的音效） */
ipcMain.handle('fs:wavMeta', async (_e, p) => {
  try {
    const w = readWav(String(p))
    return { ok: true, meta: w && w.meta ? w.meta : null }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

/** 内置默认音效目录（开发 → public，打包 → dist） */
function defaultHitSoundDir() {
  const cands = [
    path.join(__dirname, '..', 'dist', 'osudefaulthitsound'),
    path.join(__dirname, '..', 'public', 'osudefaulthitsound'),
  ]
  return cands.find((p) => fs.existsSync(p)) || ''
}

/**
 * 导出音效谱：直接写进 [Files] path。
 *
 * 编号和文件清单已经由渲染进程算好（[Define] 的代号 → (set, hit, index)），
 * 这里负责命名、重名检查和落盘，细节见 electron/osu-export.cjs。
 */
ipcMain.handle('export:osuPackage', async (_e, opts = {}) => {
  try {
    return exportPackage({ ...(opts || {}), defaultDir: defaultHitSoundDir() })
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

/**
 * 列出一个 .osu 文件同目录下所有难度的元信息，供「从 .osu 导入音效」时挑选。
 * 只读头部，不解析物件。
 */
function readOsuMeta(text) {
  const head = text.slice(0, 4000)
  const kv = (section) => {
    const m = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'i').exec(head)
    const o = {}
    if (!m) return o
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return o
  }
  const meta = kv('Metadata')
  const diff = kv('Difficulty')
  const sec = /\[HitObjects\]([\s\S]*?)(?=\n\[|$)/i.exec(text)
  const objectCount = sec ? sec[1].split(/\r?\n/).filter((l) => /^\s*-?\d+\s*,/.test(l)).length : 0
  return {
    title: meta.Title || '',
    artist: meta.Artist || '',
    creator: meta.Creator || '',
    version: meta.Version || '(未命名难度)',
    hp: Number(diff.HPDrainRate) || 0,
    cs: Number(diff.CircleSize) || 0,
    ar: Number(diff.ApproachRate) || 0,
    od: Number(diff.OverallDifficulty) || 0,
    starRating: Number(diff.StarRating) || 0,
    objectCount,
  }
}

/**
 * 是不是正经 .osu（挡住「txt 改名」）：第一行是 `osu file format vN`，
 * 且至少有一个已知段落。和渲染进程 src/core/osuFile.ts 的判定保持一致。
 */
function looksLikeOsu(text) {
  const body = String(text || '').replace(/^\uFEFF/, '')
  const first = body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('//'))
  if (!first || !/^osu file format v\d+\s*$/i.test(first.trim())) return false
  return /^\[(General|Editor|Metadata|Difficulty|Events|TimingPoints|Colours|HitObjects)\]\s*$/im.test(body)
}

ipcMain.handle('osu:listDifficulties', async (_e, filePath) => {
  try {
    const dir = path.dirname(filePath)
    const names = (await fsp.readdir(dir)).filter((n) => /\.osu$/i.test(n))
    const out = []
    for (const n of names) {
      const full = path.join(dir, n)
      try {
        const st = await fsp.stat(full)
        if (!st.isFile()) continue
        const text = await fsp.readFile(full, 'utf8')
        // 不是真的 .osu 就不列出来（否则用户在难度列表里会选到一坨文本）
        if (!looksLikeOsu(text)) continue
        const meta = readOsuMeta(text)
        out.push({ name: n, path: full, size: st.size, mtimeMs: st.mtimeMs, ...meta })
      } catch {
        /* 单个难度读失败就跳过 */
      }
    }
    out.sort((a, b) => (a.starRating - b.starRating) || a.name.localeCompare(b.name))
    return { ok: true, dir, difficulties: out }
  } catch (err) {
    return { ok: false, difficulties: [], error: String(err && err.message ? err.message : err) }
  }
})

// ---------------- osu! Songs 谱面库 ----------------
//
// 侧栏「谱面库」用的三个能力，排序规则对齐 Mapset Verifier：
//   按「有效修改时间」倒序 —— 取 max(文件夹自身 mtime, 顶层 *.osu 的最大 mtime)。
// NTFS 下原地编辑已有文件并不会更新文件夹 mtime（只有新建/删除/重命名才会），
// 所以只看文件夹 mtime 会把「刚在编辑器里改过、但没新增文件」的谱面排在后面。

/** 缓存排序结果：Songs 目录动辄几千个文件夹，每次请求都全量 stat 会卡 */
const MAPSET_SORT_TTL_MS = 5000
let mapsetSortCache = { dir: '', count: -1, at: 0, folders: [] }

/**
 * 解码 Windows 命令行工具（reg 等）的输出。
 *
 * 中文 Windows 上这些工具往管道里写的是 OEM 代码页（GBK），不是 UTF-8。
 * 直接当 UTF-8 读，中文就变成 `���`；反过来，本来就是合法 UTF-8 的内容
 * （路径里带重音字母之类）按 GBK 解又会错。所以先试 UTF-8，只有出现
 * 非法字节（U+FFFD）时才按 GBK 再解一次。
 */
function decodeConsole(buf) {
  if (typeof buf === 'string') return buf
  if (!buf) return ''
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

/** 注册表只探一次（'' = 探过但没找到），避免每次打开谱面库都再跑一遍 reg */
let osuExeProbed = false
let osuExeFound = ''

/** 从注册表 HKEY_CLASSES_ROOT\osu\DefaultIcon 拿 osu!.exe 安装路径 */
function osuExeFromRegistry() {
  if (process.platform !== 'win32') return ''
  if (osuExeProbed) return osuExeFound
  osuExeProbed = true
  try {
    // stderr 必须显式收掉：.osu 没关联到 osu! 时 reg 会往 stderr 写一行 GBK 中文
    // （「错误: 系统找不到指定的注册表项或值。」）。execFileSync 默认把子进程的
    // stderr 直接继承给父进程，于是开发模式的 cmd 里就冒出一串 `���: ...` 乱码。
    const buf = require('node:child_process').execFileSync(
      'reg',
      ['query', 'HKCR\\osu\\DefaultIcon', '/ve'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 4000 },
    )
    const out = decodeConsole(buf)
    for (const line of out.split(/\r?\n/)) {
      const i = line.search(/REG_SZ|REG_EXPAND_SZ/)
      if (i < 0) continue
      let v = line.slice(i).replace(/^REG_(EXPAND_)?SZ\s*/, '').trim()
      v = v.replace(/^"|"$/g, '')
      // 值是 `"D:\osu!\osu!.exe",0` 这种「路径,图标序号」形式
      const exe = v.replace(/,-?\d+$/, '').trim()
      if (exe && /\.exe$/i.test(exe)) {
        osuExeFound = exe
        return exe
      }
    }
  } catch {
    /* 没装 / 没权限 / reg 不在 PATH 里都算探测失败 */
  }
  return ''
}

/**
 * 从 osu! 安装目录里的 `osu!.<用户名>.cfg` 读歌曲目录。
 * cfg 里是 `BeatmapDirectory = Songs`（相对安装目录），也可能是绝对路径。
 */
function osuSongsFromCfg(osuDir) {
  try {
    const cfg = require('node:fs')
      .readdirSync(osuDir)
      .find((n) => /^osu!\..+\.cfg$/i.test(n))
    if (!cfg) return ''
    const text = require('node:fs').readFileSync(path.join(osuDir, cfg), 'utf8')
    const m = /^\s*BeatmapDirectory\s*[=:]\s*(.+)$/im.exec(text)
    if (!m) return ''
    const v = m[1].trim().replace(/^["']|["']$/g, '')
    if (!v) return ''
    return path.isAbsolute(v) ? v : path.join(osuDir, v)
  } catch {
    return ''
  }
}

/** 本机可用的盘符根目录（从 C 开始，跳过软驱 A/B，避免读可移动介质时卡住） */
function driveRoots() {
  if (process.platform !== 'win32') return []
  const roots = []
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = String.fromCharCode(c) + ':\\'
    try {
      if (require('node:fs').existsSync(root)) roots.push(root)
    } catch {
      /* 不可读的盘符直接跳过 */
    }
  }
  return roots
}

/** 自动探测 osu! Songs 目录；探测不到返回空串（由 UI 提示用户手动指定） */
function detectSongsFolder() {
  const fsSync = require('node:fs')
  const candidates = []
  const push = (p) => {
    if (p) candidates.push(p)
  }

  try {
    const exe = osuExeFromRegistry()
    if (exe) {
      const dir = path.dirname(exe)
      push(osuSongsFromCfg(dir))
      push(path.join(dir, 'Songs'))
    }
  } catch {
    /* ignore */
  }

  try {
    const local = process.env.LOCALAPPDATA || ''
    const home = process.env.USERPROFILE || ''
    if (local) push(path.join(local, 'osu!', 'Songs'))
    if (home) push(path.join(home, 'AppData', 'Local', 'osu!', 'Songs'))
  } catch {
    /* ignore */
  }

  // 兜底：osu! 经常就直接装在某个盘符根目录下（E:\osu、D:\osu! 各种写法都有），
  // 注册表读不到（未关联 / 权限 / 便携版）时用这一招兜住。
  // 以「目录里有 osu!.exe」为准，避免误命中 osu! 相关的其它文件夹。
  for (const root of driveRoots()) {
    try {
      for (const name of fsSync.readdirSync(root)) {
        if (!/^osu/i.test(name)) continue
        const dir = path.join(root, name)
        try {
          if (!fsSync.existsSync(path.join(dir, 'osu!.exe'))) continue
        } catch {
          continue
        }
        push(osuSongsFromCfg(dir))
        push(path.join(dir, 'Songs'))
      }
    } catch {
      /* 盘符读不了就跳过 */
    }
  }

  for (const c of candidates) {
    try {
      if (c && fsSync.existsSync(c)) return c
    } catch {
      /* 单个候选不可读就跳过 */
    }
  }
  return ''
}

/** 优先用设置里指定的路径，否则自动探测 */
function resolveSongsFolder(override) {
  if (override && require('node:fs').existsSync(override)) return override
  return detectSongsFolder()
}

/**
 * 一个谱面集文件夹的「有效修改时间」= max(文件夹 mtime, 顶层 *.osu 的最大 mtime)。
 * 只看 .osu：编辑器每次保存都会重写它们，而音频/背景/音效文件数量多且无意义。
 */
async function effectiveMtimeMs(dirPath, dirMtimeMs) {
  let latest = dirMtimeMs
  try {
    const names = await fsp.readdir(dirPath)
    for (const n of names) {
      if (!/\.osu$/i.test(n)) continue
      try {
        const st = await fsp.stat(path.join(dirPath, n))
        if (st.mtimeMs > latest) latest = st.mtimeMs
      } catch {
        /* 单个文件 stat 失败忽略 */
      }
    }
  } catch {
    /* 目录读不了就用文件夹自身时间 */
  }
  return latest
}

/** 按 Mapset Verifier 的顺序（有效修改时间倒序）列出 Songs 下所有谱面集文件夹 */
async function sortedMapsetFolders(songsFolder) {
  const entries = await fsp.readdir(songsFolder, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(songsFolder, e.name))

  const now = Date.now()
  if (
    mapsetSortCache.dir === songsFolder &&
    mapsetSortCache.count === dirs.length &&
    now - mapsetSortCache.at < MAPSET_SORT_TTL_MS
  ) {
    return mapsetSortCache.folders
  }

  // 限量并发：全量串行 stat 在几千个文件夹时要好几秒
  const out = []
  const queue = dirs.slice()
  const worker = async () => {
    for (;;) {
      const d = queue.shift()
      if (!d) return
      let st
      try {
        st = await fsp.stat(d)
      } catch {
        continue
      }
      out.push({ path: d, folder: path.basename(d), mtimeMs: await effectiveMtimeMs(d, st.mtimeMs) })
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker))
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  mapsetSortCache = { dir: songsFolder, count: dirs.length, at: now, folders: out }
  return out
}

/** 从 `Artist - Title (Creator) [Diff].osu` 这种文件名里抠出难度名 */
function diffNameFromFileName(fileName) {
  const m = /\[([^\]]+)\]\.osu$/i.exec(fileName)
  return m ? m[1] : fileName.replace(/\.osu$/i, '')
}

/**
 * 读一个谱面集的元信息：取目录里第一个非空的 .osu 解析 [Metadata]，
 * 并顺带列出全部难度（难度名直接从文件名方括号里取，避免把每个 .osu 都读一遍）。
 */
async function readMapsetMeta(folderPath) {
  let names = []
  try {
    names = (await fsp.readdir(folderPath)).filter((n) => /\.osu$/i.test(n))
  } catch {
    return null
  }
  if (!names.length) return null

  let text = ''
  for (const n of names) {
    try {
      const t = await fsp.readFile(path.join(folderPath, n), 'utf8')
      if (t && t.trim()) {
        text = t
        break
      }
    } catch {
      /* 读不出就换下一个 */
    }
  }
  if (!text) return null

  const meta = readOsuMeta(text)
  const difficulties = names
    .map((n) => ({ name: n, path: path.join(folderPath, n), version: diffNameFromFileName(n) }))
    .sort((a, b) => a.version.localeCompare(b.version))
  return {
    title: meta.title || '',
    artist: meta.artist || '',
    creator: meta.creator || '',
    diffCount: names.length,
    difficulties,
  }
}

ipcMain.handle('osu:detectSongsFolder', async () => ({ folder: detectSongsFolder() }))

ipcMain.handle('osu:listMapsets', async (_e, opts = {}) => {
  const override = opts.songsFolder || ''
  const songsFolder = resolveSongsFolder(override)
  if (!songsFolder) {
    return { ok: false, songsFolder: '', total: 0, hasMore: false, mapsets: [], error: 'songs_folder_not_found' }
  }
  const offset = Math.max(0, Number(opts.offset) || 0)
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 60))
  const search = String(opts.search || '').trim().toLowerCase()

  try {
    const folders = await sortedMapsetFolders(songsFolder)
    const slice = folders.slice(offset, offset + limit)
    const mapsets = []
    for (const f of slice) {
      try {
        const meta = await readMapsetMeta(f.path)
        if (!meta) continue
        const hay = `${meta.title} - ${meta.artist} | ${meta.creator} (${f.folder})`.toLowerCase()
        if (search && !hay.includes(search)) continue
        mapsets.push({
          folder: f.folder,
          path: f.path,
          mtimeMs: f.mtimeMs,
          title: meta.title,
          artist: meta.artist,
          creator: meta.creator,
          diffCount: meta.diffCount,
          difficulties: meta.difficulties,
        })
      } catch {
        /* 单个谱面集解析失败不影响整页 */
      }
    }
    return {
      ok: true,
      songsFolder,
      total: folders.length,
      offset,
      hasMore: offset + slice.length < folders.length,
      mapsets,
    }
  } catch (err) {
    return {
      ok: false,
      songsFolder,
      total: 0,
      offset,
      hasMore: false,
      mapsets: [],
      error: String(err && err.message ? err.message : err),
    }
  }
})

const { execFile } = require('node:child_process')

/** 跑一次 PowerShell 拿 stdout（失败返回空串，不抛） */
function runPs(script, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      // encoding: null → 拿到原始 Buffer 再按控制台代码页解码。
      // 直接 String(stdout) 会把 GBK 的中文歌名读成乱码，窗口标题就匹配不上谱面。
      { windowsHide: true, timeout, maxBuffer: 1024 * 1024 * 8, encoding: null },
      (err, stdout) => resolve(err ? '' : decodeConsole(stdout)),
    )
  })
}

/**
 * 列出所有有窗口标题的进程。
 * 「osu 正在打开的谱面」在 stable 里只体现在窗口标题上：
 * 编辑器是 `osu! - xxx.osu`，歌曲选择/播放是 `osu! - Artist - Title`。
 */
async function osuWindowTitles() {
  if (process.platform !== 'win32') return []
  // 自动化测试钩子：用分号分隔的假窗口标题，跳过 PowerShell
  if (process.env.HSS_TEST_OSU_TITLES) {
    return process.env.HSS_TEST_OSU_TITLES.split(';')
      .filter(Boolean)
      .map((title) => ({ pid: '0', exePath: '', title }))
  }
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() -ne '' } | " +
    "ForEach-Object { $_.Id.ToString() + '|' + $_.Path + '|' + $_.MainWindowTitle }"
  const out = await runPs(script)
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const i1 = t.indexOf('|')
    if (i1 < 0) continue
    const i2 = t.indexOf('|', i1 + 1)
    const pid = t.slice(0, i1)
    const exePath = i2 > 0 ? t.slice(i1 + 1, i2) : ''
    const title = i2 > 0 ? t.slice(i2 + 1) : t.slice(i1 + 1)
    rows.push({ pid, exePath, title })
  }
  return rows.filter((r) => /^osu!/i.test(r.title.trim()))
}

/** 在 Songs 下找包含某个 .osu 文件名的谱面集文件夹（和 Mapset Verifier 同一招） */
async function findFolderByOsuName(songsFolder, osuFileName) {
  const entries = await fsp.readdir(songsFolder, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(songsFolder, e.name)
    try {
      await fsp.access(path.join(full, osuFileName))
      return full
    } catch {
      /* 不在这一夹 */
    }
  }
  return ''
}

/** 按 `Artist - Title` 文本在 Songs 下匹配谱面集（非编辑器窗口的兜底） */
async function findFolderByMetadata(songsFolder, metaText) {
  const needle = metaText.toLowerCase()
  if (!needle) return ''
  const entries = await fsp.readdir(songsFolder, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    // 文件夹名本身就是 `12345 Artist - Title`，先做一次便宜的字符串比对
    if (e.name.toLowerCase().includes(needle)) return path.join(songsFolder, e.name)
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(songsFolder, e.name)
    const meta = await readMapsetMeta(full)
    if (!meta) continue
    const hay = `${meta.artist} - ${meta.title}`.toLowerCase()
    if (hay && hay.includes(needle)) return full
  }
  return ''
}

ipcMain.handle('osu:currentMapset', async (_e, opts = {}) => {
  const songsFolder = resolveSongsFolder(opts.songsFolder || '')
  if (!songsFolder) {
    return { ok: false, status: 'songs_folder_not_found', message: '未能确定 osu! Songs 目录', mapset: null }
  }
  try {
    const titles = await osuWindowTitles()
    if (!titles.length) {
      return {
        ok: true,
        status: 'no_process',
        message: '没有检测到正在运行的 osu!',
        songsFolder,
        mapset: null,
      }
    }

    // `osu! - xxx` / `osu!b20250101 - xxx` / `osu!cuttingedge - xxx` 统一剥掉前缀
    const stripPrefix = (title) =>
      title
        .trim()
        .replace(/^osu!(?:cuttingedge|stable|beta|lazer)?\s*(?:b\d+)?\s*[-–—]?\s*/i, '')
        .trim()

    // 1) 编辑器窗口：`osu! - ...xxx.osu`
    for (const t of titles) {
      const m = /([^\\/:*?"<>|\r\n]+?\.osu)\s*$/i.exec(stripPrefix(t.title))
      if (!m) continue
      const dir = await findFolderByOsuName(songsFolder, m[1])
      if (!dir) continue
      const meta = await readMapsetMeta(dir)
      return {
        ok: true,
        status: 'folder_found',
        message: `来自 osu! 窗口标题：${m[1]}`,
        songsFolder,
        source: 'editor',
        mapset: {
          folder: path.basename(dir),
          path: dir,
          title: meta?.title || '',
          artist: meta?.artist || '',
          creator: meta?.creator || '',
          diffCount: meta?.diffCount || 0,
          difficulties: meta?.difficulties || [],
          mtimeMs: 0,
        },
      }
    }

    // 2) 歌曲选择 / 播放窗口：`osu! - Artist - Title`
    for (const t of titles) {
      const metaText = stripPrefix(t.title)
      if (!metaText || /\.osu$/i.test(metaText)) continue
      const dir = await findFolderByMetadata(songsFolder, metaText)
      if (!dir) continue
      const meta = await readMapsetMeta(dir)
      return {
        ok: true,
        status: 'folder_found',
        message: `来自 osu! 窗口标题：${metaText}`,
        songsFolder,
        source: 'playing',
        mapset: {
          folder: path.basename(dir),
          path: dir,
          title: meta?.title || '',
          artist: meta?.artist || '',
          creator: meta?.creator || '',
          diffCount: meta?.diffCount || 0,
          difficulties: meta?.difficulties || [],
          mtimeMs: 0,
        },
      }
    }

    return {
      ok: true,
      status: 'no_match',
      message: '检测到 osu!，但没能在 Songs 里定位到对应谱面集',
      songsFolder,
      titles: titles.map((t) => t.title),
      mapset: null,
    }
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      message: String(err && err.message ? err.message : err),
      songsFolder,
      mapset: null,
    }
  }
})

ipcMain.handle('fs:hash', async (_e, p) => {
  try {
    const crypto = require('node:crypto')
    const buf = await fsp.readFile(p)
    return { ok: true, hash: crypto.createHash('sha1').update(buf).digest('hex'), size: buf.length }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
})

ipcMain.handle('fs:exists', async (_e, p) => {
  try {
    const st = await fsp.stat(p)
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }
  } catch {
    return { exists: false }
  }
})

/**
 * 粗略解析音频时长（毫秒）。
 *
 * 只需要「这首歌有多长」来判断最后一条红线是否还继承拍号，
 * 不需要精确到样本，所以只解析帧头：MP3 走 Xing/VBRI 帧或 CBR 估算，
 * OGG 走最后一页 granule position，其它格式读不到就返回 0 让调用方退化处理。
 */
function parseAudioDurationMs(buf, ext) {
  try {
    const e = (ext || '').toLowerCase()
    if (e === '.mp3' || e === '.mp2') return mp3DurationMs(buf)
    if (e === '.ogg' || e === '.oga') return oggDurationMs(buf)
  } catch {
    /* 解析失败按 0 处理 */
  }
  return 0
}

const MP3_BITRATES = {
  // [V1L1, V1L2, V1L3, V2L1, V2L2&3, V2L3?] 简化：按常见版本给索引
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
}
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

function mp3DurationMs(buf) {
  // 找第一帧同步头
  let i = 0
  while (i < buf.length - 4) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) break
    i++
  }
  if (i >= buf.length - 4) return 0
  const h = buf[i + 1]
  const verBits = (h >> 3) & 3 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (h >> 1) & 3 // 1=Layer3
  if (layerBits !== 1) return 0
  const ver = verBits === 3 ? 3 : 2
  const brIdx = (buf[i + 2] >> 4) & 0xf
  const srIdx = (buf[i + 2] >> 2) & 3
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return 0
  const bitrate = (MP3_BITRATES[ver] || MP3_BITRATES[3])[brIdx] * 1000
  const rate = (MP3_RATES[ver] || MP3_RATES[3])[srIdx]
  if (!bitrate || !rate) return 0

  const cbrFallback = () => Math.round(((buf.length - i) * 8 * 1000) / bitrate)

  // Xing/Info 帧头：VBR 下带总帧数，比按字节数估算准得多。
  // 偏移随版本变化：MPEG1 是 36 字节侧信息，MPEG2/2.5 是 21 字节。
  const sideInfo = ver === 3 ? 36 : 21
  for (const base of [i + 4 + sideInfo, i + 4 + 32]) {
    if (base + 12 > buf.length) continue
    const tag = buf.slice(base, base + 4).toString('latin1')
    if (tag !== 'Xing' && tag !== 'Info') continue
    const flags = buf.readUInt32BE(base + 4)
    if (flags & 1) {
      const frames = buf.readUInt32BE(base + 8)
      if (frames > 0) {
        // MPEG1 Layer3 每帧 1152 个样本，MPEG2/2.5 是 576
        return Math.round(((frames * (ver === 3 ? 1152 : 576)) / rate) * 1000)
      }
    }
    break
  }
  return cbrFallback()
}

function oggDurationMs(buf) {
  // granule position 记在最后一页页头的最后 8 字节（小端）
  const pos = buf.lastIndexOf(Buffer.from('OggS'), buf.length - 4)
  if (pos < 0 || pos + 14 > buf.length) return 0
  const lo = buf.readUInt32LE(pos + 6)
  const hi = buf.readUInt32LE(pos + 10)
  const granule = hi * 4294967296 + lo
  // osu! 的 ogg 绝大多数是 48kHz；拿不到更准的采样率就用它（误差 < 0.1%）
  return Math.round((granule / 48000) * 1000)
}

ipcMain.handle('fs:audioDuration', async (_e, p) => {
  try {
    const st = await fsp.stat(p)
    // 大文件只读头尾，够算时长了
    const fsp2 = require('node:fs/promises')
    const fh = await fsp2.open(p, 'r')
    let buf
    if (st.size <= 4 * 1024 * 1024) {
      buf = Buffer.alloc(st.size)
      await fh.read(buf, 0, st.size, 0)
    } else {
      const head = Buffer.alloc(1024 * 1024)
      await fh.read(head, 0, head.length, 0)
      const tailLen = 1024 * 1024
      const tail = Buffer.alloc(tailLen)
      await fh.read(tail, 0, tailLen, st.size - tailLen)
      buf = Buffer.concat([head, tail])
    }
    await fh.close()
    return { ok: true, durationMs: parseAudioDurationMs(buf, path.extname(p)) }
  } catch (e) {
    return { ok: false, durationMs: 0, error: String(e && e.message ? e.message : e) }
  }
})

ipcMain.handle('fs:readText', async (_e, p) => {
  try {
    return { ok: true, text: await fsp.readFile(p, 'utf8'), path: p, name: path.basename(p) }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

/** 写文本文件（覆盖写回原文件） */
ipcMain.handle('fs:writeText', async (_e, p, text) => {
  try {
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, text, 'utf8')
    return { ok: true, path: p }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

/** 读二进制，返回 Uint8Array（渲染进程里包成 File 用，逻辑与浏览器选文件完全一致） */
ipcMain.handle('fs:readBinary', async (_e, p) => {
  try {
    const buf = await fsp.readFile(p)
    return { ok: true, data: buf, name: path.basename(p), size: buf.length }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

/** 同一个路径（Windows 大小写不敏感） */
function sameFilePath(a, b) {
  const n = (p) => path.resolve(String(p)).replace(/\//g, '\\')
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/**
 * 复制文件（目标目录不存在就建）。
 * 「所有音效收进谱面文件夹」用它把源文件复制成 `<代号>.<扩展名>`，
 * 源文件本身一个字节都不动。
 */
ipcMain.handle('fs:copyFile', async (_e, from, to) => {
  try {
    if (sameFilePath(from, to)) return { ok: true, same: true }
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
    const st = await fsp.stat(to)
    return { ok: true, size: st.size }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

/**
 * 移动文件。跨盘时 rename 会 EXDEV，退化成复制 + 删除；
 * Windows 上目标已存在时 rename 可能 EPERM，先删目标再试一次（调用方已确认覆盖）。
 */
ipcMain.handle('fs:moveFile', async (_e, from, to) => {
  try {
    if (sameFilePath(from, to)) return { ok: true, same: true }
    await fsp.mkdir(path.dirname(to), { recursive: true })
    try {
      await fsp.rename(from, to)
    } catch (err) {
      const code = err && err.code
      if (code === 'EXDEV') {
        await fsp.copyFile(from, to)
        await fsp.unlink(from)
      } else if (code === 'EPERM' || code === 'EEXIST') {
        await fsp.rm(to, { force: true })
        await fsp.rename(from, to)
      } else {
        throw err
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

/**
 * 已绑定音效的持久化副本。
 *
 * 原来放在渲染进程的 IndexedDB 里，但打包后是用 loadFile 打开的（file:// 源），
 * Chromium 在 file:// 下不给用 IndexedDB —— 写入直接挂住/报 UnknownError，
 * 表现就是「重开程序以后之前加载的音效全没了」。改成落到 userData/samples。
 */
function sampleDir() {
  const d = path.join(app.getPath('userData'), 'samples')
  try {
    fs.mkdirSync(d, { recursive: true })
  } catch {
    /* 建不出来就让后面的读写各自报错 */
  }
  return d
}

/** 音效名 → 文件名（`ks:piano#60` 这类要转义，不能直接当文件名） */
function sampleFile(name) {
  return path.join(sampleDir(), encodeURIComponent(String(name))) + '.bin'
}

ipcMain.handle('sample:write', async (_e, name, data) => {
  try {
    const buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    await fsp.writeFile(sampleFile(name), buf)
    return { ok: true, size: buf.length }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

ipcMain.handle('sample:read', async (_e, name) => {
  try {
    const buf = await fsp.readFile(sampleFile(name))
    return { ok: true, data: buf, size: buf.length }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('sample:delete', async (_e, name) => {
  try {
    await fsp.unlink(sampleFile(name))
  } catch {
    /* 本来就没有 */
  }
  return { ok: true }
})

ipcMain.handle('sample:list', async () => {
  try {
    const items = await fsp.readdir(sampleDir())
    const names = []
    for (const n of items) {
      if (!n.endsWith('.bin')) continue
      try {
        names.push(decodeURIComponent(n.slice(0, -4)))
      } catch {
        /* 不是我们写的文件就跳过 */
      }
    }
    return { ok: true, names }
  } catch {
    return { ok: true, names: [] }
  }
})

/**
 * 递归列出目录下的音频/资源文件。
 * 返回 [ {path, relPath, name, size} ]，relPath 相对根目录、分隔符统一为 /。
 */
ipcMain.handle('fs:listDir', async (_e, root, opts = {}) => {
  const maxFiles = opts.maxFiles || 4000
  const exts = opts.exts || ['.wav', '.ogg', '.mp3', '.flac', '.sf2', '.sf3', '.osu', '.txt']
  const out = []
  const stack = [root]
  try {
    while (stack.length && out.length < maxFiles) {
      const dir = stack.pop()
      let items = []
      try {
        items = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const it of items) {
        if (out.length >= maxFiles) break
        if (it.name.startsWith('.')) continue
        const full = path.join(dir, it.name)
        if (it.isDirectory()) {
          stack.push(full)
          continue
        }
        if (!exts.includes(path.extname(it.name).toLowerCase())) continue
        let st
        try {
          st = await fsp.stat(full)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        let rel = path.relative(root, full).replace(/\\/g, '/')
        if (rel.startsWith('./')) rel = rel.slice(2)
        out.push({ path: full, relPath: rel, name: it.name, size: st.size })
      }
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), files: out }
  }
  return { ok: true, files: out, root }
})

/** 原生确认框：返回被点按钮的索引 */
let msgBoxSeq = 0
ipcMain.handle('dialog:messageBox', async (_e, opts = {}) => {
  // 自动化测试钩子：HSS_TEST_MESSAGEBOX="0,0,1" 按顺序返回按钮索引，最后一项会一直复用
  if (process.env.HSS_TEST_MESSAGEBOX !== undefined) {
    const seq = process.env.HSS_TEST_MESSAGEBOX.split(',').map((x) => (Number(x) || 0))
    const pick = seq[Math.min(msgBoxSeq++, seq.length - 1)]
    // 测试靠这行核对弹窗有几个按钮、按钮文案是什么
    console.log('[messagebox]', JSON.stringify({ buttons: opts.buttons || [], title: opts.title || '' }))
    return pick
  }
  const res = await dialog.showMessageBox(win, {
    type: (opts.type || 'warning'),
    buttons: opts.buttons || ['确定'],
    defaultId: opts.defaultId || 0,
    cancelId: typeof opts.cancelId === 'number' ? opts.cancelId : (opts.buttons || ['确定']).length - 1,
    title: opts.title || '',
    message: opts.message || '',
    detail: opts.detail || '',
  })
  return res.response
})

/** 渲染进程处理完未保存提醒后调用，真正关闭窗口 */
ipcMain.handle('app:confirmClose', () => {
  closeConfirmed = true
  if (win && !win.isDestroyed()) win.close()
  return true
})

/**
 * 应用设置文本文件 `settings.cfg` 的位置。
 *
 * - HSS_SETTING_FILE：自动化测试指定临时路径
 * - 打包后的绿色版：就是 exe 旁边的那份（release/osu-hitsound-studio/settings.cfg），
 *   整个文件夹拷走配置也跟着走；
 * - 开发模式：userData/settings.cfg
 *
 * 只读目录（例如放进 Program Files）写不进去时，自动退到 userData，
 * 并记在 settingsFallback 里，本次运行后续的读写/打开目录都用它。
 */
let settingsFallback = null

function userSettingsFile() {
  return path.join(app.getPath('userData'), 'settings.cfg')
}

function settingsFile() {
  const forced = process.env.HSS_SETTING_FILE
  if (forced) return forced
  if (settingsFallback) return settingsFallback
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'settings.cfg')
  return userSettingsFile()
}

/** 语言包目录：userData/langs（没有就建） */
function langDir() {
  const d = path.join(app.getPath('userData'), 'langs')
  try {
    fs.mkdirSync(d, { recursive: true })
  } catch {
    /* ignore */
  }
  return d
}

ipcMain.handle('langs:list', async () => {
  const dir = langDir()
  const files = []
  try {
    const names = await fsp.readdir(dir)
    for (const n of names) {
      if (!/\.lang$/i.test(n)) continue
      try {
        files.push({ file: n, text: await fsp.readFile(path.join(dir, n), 'utf8') })
      } catch {
        /* 单个读不了就跳过 */
      }
    }
    return { ok: true, files, dir }
  } catch (err) {
    return { ok: false, files: [], dir, error: String(err && err.message ? err.message : err) }
  }
})

ipcMain.handle('langs:save', async (_e, id, text) => {
  try {
    const safe = String(id || '').trim()
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(safe)) return { ok: false, error: 'invalid id' }
    const dir = langDir()
    await fsp.writeFile(path.join(dir, `${safe}.lang`), String(text), 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

ipcMain.handle('langs:delete', async (_e, id) => {
  try {
    const safe = String(id || '').trim()
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(safe)) return { ok: false, error: 'invalid id' }
    await fsp.rm(path.join(langDir(), `${safe}.lang`), { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

ipcMain.handle('langs:openDir', async () => {
  const dir = langDir()
  const err = await shell.openPath(dir)
  return { ok: !err, dir, error: err || undefined }
})

/** 渲染进程切语言：记住选择并重建原生菜单 */
ipcMain.handle('app:setLang', async (_e, id) => {
  appLang = String(id || 'zh-CN')
  const prefs = await loadPrefs()
  await savePrefs({ ...prefs, lang: appLang })
  buildMenu()
  return true
})

ipcMain.handle('app:getPrefs', () => loadPrefs())
ipcMain.handle('app:setPrefs', async (_e, patch) => {
  const prefs = await loadPrefs()
  await savePrefs({ ...prefs, ...patch })
  return true
})
ipcMain.handle('app:openPath', async (_e, p) => {
  // 自动化测试：不真的弹资源管理器
  if (process.env.HSS_TEST_OPENPATH) return true
  try {
    await shell.openPath(p)
    return true
  } catch {
    return false
  }
})
/**
 * 用系统默认程序打开链接。
 * 格子视图的「在 osu! Editor 中打开」用它唤起 `osu://edit/mm:ss:xxx`。
 * 只放行 http(s) / osu / mailto，别让它变成任意协议启动器。
 */
ipcMain.handle('app:openExternal', async (_e, url) => {
  const s = String(url ?? '')
  if (!/^(https?:|osu:|mailto:)/i.test(s)) return { ok: false, error: 'unsupported protocol' }
  try {
    await shell.openExternal(s)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : String(err) }
  }
})
// ---- settings.cfg（应用设置的文本持久化）----
ipcMain.handle('settings:path', () => settingsFile())
ipcMain.handle('settings:load', async () => {
  const p = settingsFile()
  try {
    return { ok: true, path: p, text: await fsp.readFile(p, 'utf8'), exists: true }
  } catch (err) {
    // exe 旁边没有、但 userData 里有一份（只读目录的退路 / 之前版本留下的）→ 继续用那份
    if (err && err.code === 'ENOENT' && p !== userSettingsFile()) {
      try {
        const text = await fsp.readFile(userSettingsFile(), 'utf8')
        settingsFallback = userSettingsFile()
        return { ok: true, path: settingsFallback, text, exists: true }
      } catch {
        /* 两份都没有，按“首次运行”处理 */
      }
    }
    if (err && err.code === 'ENOENT') return { ok: true, path: p, text: '', exists: false }
    return { ok: false, path: p, text: '', exists: false, error: err && err.message ? String(err.message) : String(err) }
  }
})
ipcMain.handle('settings:save', async (_e, text) => {
  const p = settingsFile()
  // 统一 LF，别让 Windows 记事本改过的 CRLF 一直留在文件里
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const write = async (f) => {
    await fsp.mkdir(path.dirname(f), { recursive: true })
    await fsp.writeFile(f, body, 'utf8')
  }
  try {
    await write(p)
    return { ok: true, path: p }
  } catch (err) {
    // 只读目录：退到 userData，别让整个设置保存失败
    if (p !== userSettingsFile()) {
      try {
        await write(userSettingsFile())
        settingsFallback = userSettingsFile()
        return { ok: true, path: settingsFallback, fallback: true }
      } catch (err2) {
        return { ok: false, path: settingsFallback, error: err2 && err2.message ? String(err2.message) : String(err2) }
      }
    }
    return { ok: false, path: p, error: err && err.message ? String(err.message) : String(err) }
  }
})
ipcMain.handle('settings:openDir', async () => {
  const p = settingsFile()
  if (!process.env.HSS_TEST_OPENPATH) {
    try {
      await shell.openPath(path.dirname(p))
    } catch {
      /* 打不开资源管理器不算错误 */
    }
  }
  return true
})

ipcMain.handle('app:version', () => ({ electron: process.versions.electron, app: app.getVersion() }))
ipcMain.handle('app:clipboardRead', () => clipboard.readText())
ipcMain.handle('app:clipboardWrite', (_e, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

// 沙箱 / 虚拟机 / 远程桌面环境下 GPU 进程可能起不来（exit_code=-1073741819），
// 会连带渲染进程无法创建。这里直接关掉硬件加速，代价只是动画没那么顺。
if (process.env.HSS_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('in-process-gpu')
}
// 磁盘缓存目录不可写时（只读用户目录 / 沙箱）Electron 会反复报错，挪到临时目录
if (process.env.HSS_USER_DATA) {
  app.setPath('userData', process.env.HSS_USER_DATA)
}

app.whenReady().then(async () => {
  try {
    const p = await loadPrefs()
    if (p && p.lang) appLang = String(p.lang)
  } catch {
    /* 读不到就用中文 */
  }
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
