/**
 * 应用命令层：新建 / 打开 / 保存 / 导入 / 导出。
 * HTML 菜单（TitleBar）和 Electron 原生菜单都调这里，保证两条路行为一致。
 * Electron 下走真实文件读写；浏览器下回退到 <input> 选文件 + Blob 下载。
 */
import { useStore, setActiveHook } from '../store'
import { engine } from '../audio/engine'
import { desktopApi, materializeFile, pickChartFiles, pickOsuFiles } from './desktop'
import { basename, dirname, parseChart, resolvePath } from './parse'
import { joinDir, planSoundBundle, samePath } from './bundle'
import { findDuplicateSound } from './dupSound'
import {
  download,
  fromOsu,
  slotLabel,
  toSampleMapJson,
  toSampleMapText,
  toTimelineCsv,
} from './exporter'
import { DEMO, TEMPLATE } from '../samples/demo'
import { applyChartSettingsToText } from './chartDefaults'
import { osuFileName, planOsuExport, setExportTranslator } from './osuExport'
import { collectOsuSampleIndices, parseOsuTargetTimeline, patchOsuText } from './osuPatch'
import { planSubSlots } from './subSlotPlan'
import { fmtOsuTime } from './time'
import { loadExportPrefs } from './exportPrefs'
import { blankHitsoundHs, desktopOsuEnv, renderOsuSoundsHs } from './osuToHs'
import { extractOsuSounds, soundCodeKey } from './osuSounds'
import { countCodes, pickSoundPlan } from '../components/SoundImportDialog'
import { pickAddSound, type ExistingDef } from '../components/AddSoundDialog'
import {
  loadComboColors,
  loadComboPrefs,
  loadTimingPrefs,
  planDefaultColors,
  planDefaultNames,
} from './importPrefs'
import { pickOsuDifficulty } from '../components/OsuDifficultyPicker'
import { pickChart } from '../components/ChartPicker'
import { matchHitsounds, matchKeysounds, matchSong, type PickedEntry } from './fileMatch'
import { loadKeysoundLibrary, type LibraryReader } from '../audio/keysoundLibrary'
import { parseColorToken } from './colors'
import { osuFileProblem, type OsuFileProblem } from './osuFile'
import { editHitsoundDefineText } from './defineEdit'
import { slotFromFileName } from './soundSlots'
import { isCodeName } from './codes'
import { t } from '../i18n'
import type { ChartDoc, SubSlot } from './types'

function log(msg: string) {
  useStore.getState().log(msg)
}

// osuExport 是纯计算模块，不能直接 import i18n；在这里把 t() 注进去，
// 导出/写入时的槽位错误与提示就会跟界面语言一起切换。
setExportTranslator(t)

/** 磁盘上一个音频条目的描述（主进程扫描出来的） */
export interface DiskAudioEntry {
  name: string
  path: string
  relPath: string
  size: number
}

/**
 * 把磁盘上扫到的音频条目读成 File，拼成 fileMatch 认识的 PickedEntry。
 *
 * fileMatch 的匹配规则（完整相对路径 > 路径后缀 > 纯文件名）在
 * 「用户手动选文件夹」和「自动扫磁盘目录」两条路上是同一套，
 * 所以统一转成 PickedEntry 就能复用。
 */
async function entriesFromDisk(audios: DiskAudioEntry[]): Promise<PickedEntry[]> {
  const api = desktopApi()
  if (!api) return []
  const out: PickedEntry[] = []
  for (const a of audios) {
    const bin = await api.readBinary(a.path)
    if (!bin.ok || !bin.data) continue
    out.push({ file: new File([bin.data as BlobPart], a.name), path: a.relPath.toLowerCase(), name: a.name })
  }
  return out
}

/** 自动加载结果，供日志汇总 */
export interface AutoLoadReport {
  songOk: boolean
  songName: string
  sampleOk: number
  sampleTotal: number
  keyOk: number
  keyTotal: number
  libNotes: string[]
}

/**
 * 按当前谱面的 [Files] / [Define]，把磁盘上的音频自动配对并载入。
 *
 * 「打开歌曲文件夹」和「切换到另一份谱面」都走这里 ——
 * 后者尤其重要：同一个歌曲目录里的多份谱面常常引用同一首歌，
 * 但音效样本各自独有，不重新配对就会出现「切了谱但音效还是上一份的」。
 *
 * @param audios 目录里递归扫到的全部音频（歌曲 + 音效样本）
 * @param songPath 已知要当歌曲用的那个文件（通常是谱面 AudioFilename 解析出来的）
 */
export async function autoLoadAssets(
  audios: DiskAudioEntry[],
  songPath?: string,
): Promise<AutoLoadReport> {
  const doc = useStore.getState().doc
  const rep: AutoLoadReport = {
    songOk: false,
    songName: '',
    sampleOk: 0,
    sampleTotal: 0,
    keyOk: 0,
    keyTotal: 0,
    libNotes: [],
  }
  const entries = await entriesFromDisk(audios)
  if (!entries.length) return rep

  // 1) 歌曲：优先用调用方指定的（谱面 AudioFilename 解析出来的），否则按 [Files] 匹配
  const song = songPath
    ? (() => {
        const meta = audios.find((a) => a.path === songPath)
        if (!meta) return null
        return { relPath: meta.relPath, file: entries.find((e) => e.path === meta.relPath.toLowerCase())?.file ?? null }
      })()
    : matchSong(doc, entries)
  if (song?.file) {
    try {
      await engine.loadSong(song.file)
      rep.songOk = true
      rep.songName = song.file.name
    } catch {
      rep.songOk = false
    }
  }

  const bindings = { ...useStore.getState().bindings }

  // 2) 音效样本：逐个按 [Define] 里写的相对路径配对
  const ms = matchHitsounds(doc, entries)
  rep.sampleTotal = ms.length
  for (const m of ms) {
    if (!m.file || !m.target.name) continue
    try {
      await engine.bindSample(m.target.name, m.file, false)
      bindings[m.target.name] = {
        name: m.target.name,
        fileName: m.file.name,
        size: m.file.size,
        auto: true,
      }
      rep.sampleOk++
    } catch {
      /* 单个解码失败不打断其它 */
    }
  }

  // 3) keysound 的音高样本与音色库
  const { files: ksFiles, libs } = matchKeysounds(doc, entries)
  rep.keyTotal = ksFiles.length
  for (const m of ksFiles) {
    if (!m.file) continue
    try {
      await engine.bindSample(m.keyName, m.file, false)
      rep.keyOk++
    } catch {
      /* 同上 */
    }
  }
  const apiBin = async (p: string): Promise<ArrayBuffer | null> => {
    const api = desktopApi()
    if (!api) return null
    const r = await api.readBinary(p)
    if (!r.ok || !r.data) return null
    const d = r.data
    return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer
  }
  for (const l of libs) {
    if (!l.file) {
      rep.libNotes.push(`乐器 ${l.instrument} ✗ 没找到 "${l.relPath}"`)
      continue
    }
    const path = l.target.resolvedPath || ''
    if (!path) {
      rep.libNotes.push(`乐器 ${l.instrument} ✗ 音色库路径为空`)
      continue
    }
    const dir = dirname(path)
    const joinRel = (rel: string) => {
      const r = rel.replace(/\\/g, '/')
      if (/^[a-z]:\//i.test(r) || r.startsWith('//') || r.startsWith('/')) return r
      const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
      return d ? `${d}/${r}` : r
    }
    const findEntry = (rel: string) => {
      const p = rel.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
      const base = p.split('/').pop() || p
      return (
        entries.find((e) => e.path === p) ||
        entries.find((e) => e.path.endsWith('/' + p)) ||
        entries.find((e) => e.name.toLowerCase() === base) ||
        null
      )
    }
    const readAny = async (p: string): Promise<ArrayBuffer | null> => {
      const direct = await apiBin(p)
      if (direct) return direct
      const hit = findEntry(p)
      if (!hit) return null
      return (await materializeFile(hit.file)).arrayBuffer()
    }
    const reader: LibraryReader = {
      readMain: async () => (await apiBin(path)) || (l.file ? (await materializeFile(l.file)).arrayBuffer() : null),
      resolve: joinRel,
      readPath: readAny,
    }
    const res = await loadKeysoundLibrary(l.instrument, l.target, reader)
    rep.libNotes.push(res.note)
  }

  useStore.getState().setBindings(bindings)
  return rep
}

/** 把自动加载结果写进日志 */
export function logAutoLoad(tag: string, r: AutoLoadReport) {
  if (r.songOk) log(`${tag} 歌曲 ✓ ${r.songName}`)
  if (r.sampleTotal) {
    log(
      r.sampleOk
        ? `${tag} 音效 ✓ 自动绑定 ${r.sampleOk}/${r.sampleTotal} 个`
        : `${tag} 音效 ✗ 0/${r.sampleTotal} 命中，检查 [Files] path 是否指向歌曲目录`,
    )
  }
  if (r.keyTotal) {
    log(`${tag} Keysound ${r.keyOk ? '✓' : '✗'} ${r.keyOk}/${r.keyTotal} 个音高样本`)
  }
  r.libNotes.forEach((n) => log(`${tag} ${n}`))
}

/**
 * 切换谱面时重载音频（注册给 store 的 setActive 钩子）。
 *
 * 只有「能从磁盘定位到谱面所在目录」时才自动重载：
 * - 有 path 的（从文件夹打开 / 打开过 .hs）→ 扫目录、重新配对；
 * - 没 path 的（新建、从未存过盘的导入结果）→ 清掉旧绑定，避免继续用上一份谱的音效。
 */
let reloadSeq = 0
async function reloadAudioForChart(
  file: { id: string; name: string; path?: string } | undefined,
  opts: { keepSamples?: boolean } = {},
) {
  const api = desktopApi()
  const store = useStore.getState()

  if (opts.keepSamples) {
    // 启动恢复：这些样本是从 userData/samples 里按 bindings 恢复出来的，正是这份谱的，
    // 不能像切谱那样清掉；只把「当前 [Define] 里已经没有的代号」剔除，免得带上一份谱的残留。
    const live = new Set<string>()
    for (const h of store.doc.hitsounds) if (h.name) live.add(h.name)
    const cur = store.bindings || {}
    const next: typeof cur = {}
    for (const [k, v] of Object.entries(cur)) if (live.has(k)) next[k] = v
    if (Object.keys(next).length !== Object.keys(cur).length) store.setBindings(next)
  } else {
    // 切谱：先清掉上一份谱的样本。放在最前面是必须的：
    // 后面重新配对是异步的，这期间旧样本还在，不清就会串到新谱里。
    engine.unbindAll()
    store.setBindings({})
  }
  if (!api || !file) return

  // 谱面来源有两种：磁盘上的 .hs（有 path），以及从 .osu 导入出来的 .hs
  // （没挂原路径，但 [Files] path 里记着来源目录）。后者照样能自动加载。
  const chartPath = file.path || ''
  // settings.Path 的值带引号（`"E:/..."`），先剥掉引号再统一分隔符
  const filesDir = String(store.doc.settings.Path || store.doc.baseDir || '')
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const dir = !chartPath && /^[a-z]:\//i.test(filesDir) ? filesDir : ''
  if (!chartPath && !dir) {
    // 启动恢复时不清样本，也就没什么可提示的
    if (!opts.keepSamples) log(`切换到 ${file.name}：该谱未关联磁盘文件或来源目录，已清空上一份谱的音频`)
    return
  }

  const my = ++reloadSeq
  try {
    // 导入出来的 .hs 没挂原路径，只能靠 [Files] path + audio 定位；
    // 把 audio 一起传过去，避免主进程按「猜一个像歌曲的文件」挑错。
    const audioRef = String(store.doc.settings.Audio || store.doc.settings.Song || '')
    const res = chartPath
      ? await api.resolveChartAssets({ chartPath })
      : await api.resolveChartAssets({ chartPath: '', dir, audio: audioRef })
    // 加载过程中用户又切了别的谱 → 丢弃这次结果
    if (my !== reloadSeq || useStore.getState().activeId !== file.id) return
    if (!res.ok || !res.assets?.length) {
      log(`切换到 ${file.name}：目录里没找到音频（${res.dir || dir}）`)
      return
    }
    const r = await autoLoadAssets(res.assets as DiskAudioEntry[], res.songPath)
    if (my !== reloadSeq || useStore.getState().activeId !== file.id) return
    logAutoLoad(`切换到 ${file.name}：`, r)
    if (!r.songOk) log(`  ⚠ 歌曲没载入（[Files] audio = ${audioRef || '空'}）`)
    if (!r.songOk && !r.sampleTotal) log('  （没有可用的音频，检查 [Files] path 与文件名是否匹配）')
  } catch (err) {
    log(`✗ 切换到 ${file.name} 时重载音频失败：${String(err)}`)
  }
}

// store 不 import actions（会循环依赖），这里反向注册
setActiveHook(reloadAudioForChart)

/**
 * 启动时把当前谱面的音频挂上。
 *
 * 恢复上次会话时 activeId 是直接从 localStorage 读的，没走 setActive，
 * 所以钩子不会触发 —— 表现就是「打开程序后时间轴显示未载入歌曲」。
 */
export function reloadActiveAudio() {
  const s = useStore.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  if (!f) return
  // 纯内存谱（没存过盘、也没有 [Files] path）就别扫了，免得每次启动刷一条「未关联磁盘文件」
  const p = String(s.doc.settings.Path || s.doc.baseDir || '').replace(/^["']|["']$/g, '')
  if (!f.path && !p) return
  // 保留刚从 userData/samples 恢复出来的样本，只按磁盘补上缺的
  void reloadAudioForChart(f, { keepSamples: true })
}

/** 保证保存时用 .hs 扩展名（.hs 才是本程序的可编辑格式） */
export function ensureHsExt(name: string): string {
  if (/\.hs$/i.test(name)) return name
  const stem = name.replace(/\.(hs\.)?txt$/i, '').replace(/\.osu$/i, '')
  return stem + '.hs'
}

/** 当前激活文件的导出基名（去掉 .hs / 旧的 .hs.txt / .txt 后缀） */
export function baseName(): string {
  const s = useStore.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  return (f?.name.replace(/\.(hs\.)?txt$/i, '').replace(/\.hs$/i, '') || 'chart') as string
}

/** 本次会话已确认写过的路径，避免每次 Ctrl+S 都弹窗 */
const writtenThisSession = new Set<string>()

/**
 * 写盘前的防覆盖闸门（Electron 专用）。
 *
 * 只有**往别人的文件上写**才问：`ownPath` 是这份谱自己已经关联的路径，
 * 写回自己的文件属于正常保存（Ctrl+S），不再弹「文件已存在，是否覆盖？」。
 * 目标存在、且不是本次会话刚写出的路径时，弹窗要求确认；
 * 确认后先把原文件内容复制成 <name>.bak，再覆盖。
 * @returns true = 可以安全写入
 */
async function guardOverwrite(target: string, ownPath = ''): Promise<boolean> {
  const api = desktopApi()
  if (!api) return true
  if (ownPath && samePath(target, ownPath)) return true
  if (writtenThisSession.has(target)) return true
  let st: { exists: boolean; size?: number }
  try {
    st = await api.exists(target)
  } catch {
    return true
  }
  if (!st?.exists) return true

  const name = target.split(/[\\/]/).pop() || target
  const btn = await api.messageBox({
    type: 'warning',
    buttons: ['覆盖', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '文件已存在',
    message: `「${name}」已存在，是否覆盖？`,
    detail: '覆盖前会自动在同目录保留一份 .bak 备份。',
  })
  if (btn !== 0) {
    log(`✗ 已取消写入，未改动 ${name}`)
    return false
  }
  try {
    const old = await api.readText(target)
    if (old.ok && typeof old.text === 'string') {
      await api.writeText(target + '.bak', old.text)
      log(`已备份原文件为 ${name}.bak`)
    }
  } catch {
    /* 备份失败不阻断覆盖 */
  }
  return true
}

/**
 * 保存当前文件。
 * @param saveAs true = 强制另存为（弹出路径选择）
 * @returns 是否真的存盘成功（用户取消对话框时返回 false）
 */
export async function saveActive(saveAs = false): Promise<boolean> {
  const s = useStore.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  if (!f) return false
  const api = desktopApi()

  if (!api) {
    // 浏览器：写回 localStorage（本来就在自动存），再给一份 .txt 下载
    download(f.name, f.content)
    s.markSaved(f.id, f.path || '')
    log('已保存到浏览器本地' + (f.path ? '' : '（未关联磁盘文件）'))
    return true
  }

  let target = saveAs ? '' : f.path || ''
  if (!target) {
    const res = await api.saveFile({
      name: ensureHsExt(f.name),
      title: saveAs ? '另存为' : '保存谱面',
      filters: [{ name: '本程序可编辑的谱面 (.hs)', extensions: ['hs'] }],
    })
    if (res.canceled || !res.path) return false
    target = res.path
  }
  if (!(await guardOverwrite(target, f.path || ''))) return false
  const r = await api.writeText(target, f.content)
  if (!r.ok) {
    log(`✗ 保存失败：${r.error}`)
    return false
  }
  writtenThisSession.add(target)
  s.markSaved(f.id, target)
  log(`✓ 已保存 ${target}`)
  return true
}

/**
 * 浏览器下的「保存 / 不保存 / 取消」：没有原生三按钮对话框，
 * 用两段 confirm 凑出同样的三个结果（0 保存 / 1 不保存 / 2 取消）。
 */
async function askCloseInBrowser(name: string): Promise<0 | 1 | 2> {
  const save = window.confirm(
    `${t('「{name}」有未保存的改动。', { name })}\n\n${t('点「确定」= 保存后关闭；点「取消」= 再选要不要丢弃改动。')}`,
  )
  if (save) return 0
  const discard = window.confirm(
    `${t('不保存改动，直接关闭「{name}」？', { name })}\n\n${t('点「确定」= 丢弃改动并关闭；点「取消」= 留在编辑器里。')}`,
  )
  return discard ? 1 : 2
}

/**
 * 关闭一份谱面（标签栏 / 资源管理器上的 ×）。
 *
 * 有未保存改动时给三个选择：**保存 / 不保存 / 取消**；
 * 选「保存」但另存为被取消或写盘失败时，谱面保持打开，不丢内容。
 * @returns 是否真的关掉了
 */
export async function closeChart(id: string): Promise<boolean> {
  const s = useStore.getState()
  const f = s.files.find((x) => x.id === id)
  if (!f) return false
  if (s.files.length <= 1) {
    log(t('这是最后一份谱面，先新建一份再关它'))
    return false
  }

  if (!f.dirty) {
    useStore.getState().closeFile(id)
    return true
  }

  const api = desktopApi()
  const choice = api
    ? await api.messageBox({
        type: 'question',
        buttons: [t('保存'), t('不保存'), t('取消')],
        defaultId: 0,
        cancelId: 2,
        title: t('未保存的改动'),
        message: t('「{name}」有未保存的改动，要保存吗？', { name: f.name }),
        detail: f.path
          ? `${t('「保存」会写回')} ${f.path}\n${t('「不保存」会丢弃这次的改动。')}`
          : t('这份谱还没存过盘；选「保存」会让你先挑一个位置。'),
      })
    : await askCloseInBrowser(f.name)

  if (choice === 2) return false // 取消：停留在编辑器里，改动都还在
  if (choice === 0) {
    // 保存的是「要关的这一份」，先切过去（没保存过时 saveActive 会弹另存为）
    const cur = useStore.getState()
    if (cur.activeId !== id) cur.setActive(id)
    if (!(await saveActive(false))) return false
  }
  useStore.getState().closeFile(id)
  log(t('已关闭 {name}', { name: f.name }))
  return true
}

/**
 * 打开 .hs 谱面（可编辑格式）。
 * .hs 才会被关联磁盘路径、从而被 Ctrl+S 写回。
 */
export async function openFiles() {
  const picked = await pickChartFiles()
  if (!picked.length) return
  for (const p of picked) {
    const text = await p.file.text()
    const id = useStore.getState().addFile(p.name, text)
    if (p.path) useStore.getState().attachPath(id, p.path)
    useStore.getState().setActive(id)
    log(`已打开 ${p.name}`)
  }
}

/**
 * 拖文件进窗口：打开拖进来的 .hs 谱面（可编辑，关联磁盘路径，Ctrl+S 写回原文件）。
 * 和「打开 .hs 文件…」走同一套 addFile + attachPath，只是文件来自 drop 而不是选择框。
 */
export async function openDroppedCharts(
  files: { name: string; file: File; path?: string }[],
): Promise<boolean> {
  if (!files.length) return false
  let last = ''
  for (const f of files) {
    const text = await f.file.text()
    const st = useStore.getState()
    const id = st.addFile(f.name, text)
    if (f.path) st.attachPath(id, f.path)
    st.setActive(id)
    last = id
    log(t('已打开 {name}', { name: f.name }))
  }
  return !!last
}

/**
 * 以「文件夹」为单位打开歌曲目录。
 * - *.hs  → 直接载入，可编辑，Ctrl+S 写回原文件
 * - *.osu → 只读参考：解析成新的 .hs 文档，但绝不关联原 .osu 路径，永不回写
 * - 顺带读 .osu / .hs 里的 AudioFilename，把歌曲音频自动载入播放器
 */
export async function openChartFolder() {
  const api = desktopApi()
  if (!api) {
    log('浏览器模式无法直接打开文件夹，请改用「打开 .hs 文件」或「从 .osu 导入」')
    return
  }
  const res = await api.loadChartFolder()
  if (res.canceled || !res.dir) return
  const charts = res.charts || []
  const audios = res.audios || []
  if (res.error) log(`✗ 读取目录失败：${res.error}`)
  if (!charts.length && !audios.length) {
    log(`目录中没有 .hs / .osu / 音频文件：${res.dir}`)
    return
  }

  const s = useStore.getState()
  let firstEditable = ''
  let opened = 0
  let readOnly = 0

  for (const c of charts) {
    const bin = await api.readBinary(c.path)
    if (!bin.ok || !bin.data) {
      log(`✗ 读取失败：${c.name}（${bin.error || ''}）`)
      continue
    }
    const text = new TextDecoder('utf-8').decode(bin.data)

    if (c.editable) {
      const id = s.addFile(c.name, text)
      s.attachPath(id, c.path)
      if (!firstEditable) firstEditable = id
      opened++
    } else {
      // .osu：只读导入为一份独立的 .hs 文档，不挂原路径
      // 但要把来源目录写进 [Files] path，之后切到这份谱时才能自动载入音频
      const dir = c.path.replace(/[\\/]+$/, '').replace(/[^\\/]+$/, '')
      const r = fromOsu(text, TEMPLATE, dir, { inheritMs: loadTimingPrefs().inheritMs })
      const id = s.addFile(c.name.replace(/\.osu$/i, '') + '.hs', r.text)
      if (!firstEditable) firstEditable = id
      readOnly++
      log(`  只读导入 ${c.name}：${r.timingCount} 条红线（源文件不会被修改）`)
    }
  }

  if (firstEditable) s.setActive(firstEditable)
  log(
    `已打开文件夹 ${res.dir}：${opened} 个 .hs 可编辑，${readOnly} 个 .osu 只读导入，${audios.length} 个音频文件`,
  )

  // ---- 自动载入歌曲 + 音效样本（递归扫到的全部音频都参与配对）----
  if (res.song?.path) {
    const r = await autoLoadAssets(audios as DiskAudioEntry[], res.song.path)
    const from = res.song.fromChart ? `（来自 ${res.song.fromChart} 的 AudioFilename）` : '（目录中唯一的音频）'
    if (r.songOk) log(`✓ 已载入歌曲音频：${r.songName} ${from}`)
    else log(`✗ 歌曲音频载入失败：${res.song.name}`)
    logAutoLoad('·', r)
    if (!r.songOk && !r.sampleTotal) log('  （目录里没有可用的音频，检查 [Files] path 与文件名是否匹配）')
  } else if (charts.some((c) => c.audioRef)) {
    // 谱面里写了音频名，但目录中找不到对应文件
    const miss = charts.find((c) => c.audioRef && !c.audioPath)
    log(`✗ 谱面引用的音频「${miss?.audioRef}」不在该目录中`)
    // 歌曲没找到，但音效样本可能还在，照样按 [Define] 配对
    if (firstEditable) {
      const r = await autoLoadAssets(audios as DiskAudioEntry[])
      logAutoLoad('·', r)
    }
  } else {
    log('目录中未找到音频文件')
  }
}

/** 从 .osu 导入为新的 .hs 文档（原 .osu 全程只读） */
export async function importOsu() {
  const picked = await pickOsuFiles()
  if (!picked.length) return
  for (const p of picked) {
    const text = await p.file.text()
    // 记录来源目录，写进 [Files] path，之后能自动载入该目录下的歌曲与音效
    const dir = p.path ? p.path.replace(/[\\/]+$/, '').replace(/[^\\/]+$/, '') : ''
    const r = fromOsu(text, TEMPLATE, dir, { inheritMs: loadTimingPrefs().inheritMs })
    const id = useStore.getState().addFile(p.name.replace(/\.osu$/i, '') + '.hs', r.text)
    useStore.getState().setActive(id)
    // 音频统一交给 setActive 的钩子加载（同样避免并发两次 loadSong）
    log(
      `已从 ${p.name} 导入为 .hs：${r.timingCount} 条红线${r.skippedGreen ? `，忽略 ${r.skippedGreen} 条绿线` : ''}（原 .osu 未关联，保存不会写回）`,
    )
  }
}

/** 读完一个 .osu 后自动把该目录的音频配上（导入流程末尾共用的一步） */

/**
 * 从一个具体的 .osu 导入音效，生成一份可编辑的 .hs。
 *
 * .osu 全程只读：不共享文件句柄、不 attachPath，保存只会写出新的 .hs。
 * 目录里有多个难度时会先弹难度选择器（只有一个难度则直接过）。
 * @returns 是否真的导入成功（取消 / 读取失败都算 false）
 */
/**
 * 算 file 相对 dir 的路径（分隔符统一成 `/`）。
 * 正常情况 .osu 就在 dir 里，返回文件名；不在 dir 下时退回纯文件名。
 */
export function relativeToDir(dir: string, file: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = file.replace(/\\/g, '/')
  if (d && f.toLowerCase().startsWith(d.toLowerCase() + '/')) return f.slice(d.length + 1)
  return f.split('/').pop() || f
}

/** 把 osuFileProblem 的原因翻成一句话 */
function osuProblemText(p: OsuFileProblem): string {
  return p === 'empty'
    ? t('文件是空的')
    : p === 'header'
      ? t('开头没有 “osu file format vN” 这一行')
      : t('没有 [General] / [TimingPoints] / [HitObjects] 之类的段落')
}

/**
 * 检查一份 .osu 内容，不合格就弹窗说明。
 * @returns true = 可以继续导入
 */
export async function verifyOsuText(text: string, name: string): Promise<boolean> {
  const problem = osuFileProblem(text)
  if (!problem) return true
  log(t('✗ {name} 不是有效的 osu! 谱面：{reason}', { name, reason: osuProblemText(problem) }))
  await desktopApi()?.messageBox({
    type: 'warning',
    buttons: ['知道了'],
    defaultId: 0,
    cancelId: 0,
    title: t('无法读取 .osu'),
    message: t('「{name}」不是有效的 osu! 谱面', { name }),
    detail: `${osuProblemText(problem)}\n\n${t('如果只是把别的文件改了后缀，请换一份真正的 .osu。')}`,
  })
  return false
}

export async function importOsuFile(filePath: string): Promise<boolean> {
  try {
    // 有磁盘路径时，先让用户在同目录的多个难度里挑一个
    const chosen = await pickOsuDifficulty(filePath)
    if (!chosen) {
      log(`已取消导入 ${filePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}`)
      return false
    }
    const bin = await desktopApi()?.readBinary(chosen)
    if (!bin?.ok || !bin.data) {
      log(`✗ 读取失败：${chosen}`)
      return false
    }
    const name = chosen.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'chart.osu'
    const text = new TextDecoder('utf-8').decode(bin.data)
    // 挡住「txt 改名成 .osu」：读不出来就别往下走
    if (!(await verifyOsuText(text, name))) return false

    const dir = chosen.replace(/[\\/]+$/, '').replace(/[^\\/]+$/, '')
    const env = desktopOsuEnv(dir, chosen, name)
    // [Files] ImportOsu：写相对 [Files] path 的 .osu 文件名，网格里显示原谱物件时间轴
    const importOsuRel = relativeToDir(dir, chosen)

    // 先只做提取，拿到去重后的音效列表，让用户挑白板 + 改代号，再渲染正文。
    const ex = await extractOsuSounds(text, env)
    let out: ReturnType<typeof renderOsuSoundsHs>
    if (!ex.codes.length) {
      // 没有任何音效事件：不开设置框，直接生成带元数据/Timing 的骨架
      out = renderOsuSoundsHs(ex, { path: dir, importOsu: importOsuRel })
    } else {
      const counts = countCodes(ex.codes, ex.sounds)
      const rows = ex.codes.map((code) => ({
        code,
        key: soundCodeKey(code),
        count: counts.get(soundCodeKey(code)) || 0,
      }))
      // 先按「设置 → 导入默认代号」里的偏好分配。
      // 白板只认设置里显式写了 `=` 的组合 —— 不再自动把 hitnormal 当白板，
      // 那样会让人以为某个音效「不见了」（其实是没代号、正文留空）。
      const preset = planDefaultNames(ex.codes, loadComboPrefs())
      const plan = await pickSoundPlan(rows, name, {
        whiteboard: preset.whiteboard,
        names: preset.names,
      })
      if (!plan) {
        log(`已取消导入 ${name}`)
        return false
      }
      out = renderOsuSoundsHs(ex, {
        path: dir,
        importOsu: importOsuRel,
        whiteboard: plan.whiteboard,
        codeNames: plan.names,
        // 12 个槽位各配一个颜色，写进 [Define] 第五段（时间轴/格子按它上色）
        codeColors: planDefaultColors(ex.codes, loadComboColors()),
      })
    }
    const r = { ...ex, ...out }

    const id = useStore.getState().addFile(ensureHsExt(name), r.text)
    useStore.getState().setActive(id)

    // 音频由 setActive 的钩子（reloadAudioForChart）统一加载 —— 这里再调一次
    // 会和钩子并发跑两遍：两次 loadSong 会互相 revoke objectURL，偶尔把音频搞成
    // 「载入了但没声/对不上」的脱节状态。

    if (!r.sounds.length) {
      log(`${name}：没有解析到任何音效事件（HitObjects 段为空或已损坏），已生成空白骨架`)
      return true
    }
    const d = r.difficulties[0]
    const bits = [`${r.placed} 个音效事件`, `${r.codes.length} 个音效代码`, `${d?.title || ''} [${d?.version || ''}]`]
    if (r.unplaced) bits.push(`${r.unplaced} 个无法对齐网格已跳过`)
    if (r.splitVolume) bits.push(`${r.splitVolume} 处同刻不同音量已错开半格`)
    if (r.skippedNoTiming) bits.push(`${r.skippedNoTiming} 个物件前没有 Timing 点`)
    log(`已从 ${name} 导入音效：${bits.join('，')}`)
    // 时值单位分布：让人一眼看出这份谱用了哪些节奏精度
    const units = Object.entries(r.timeUnits || {})
      .map(([u, n]) => `${u === '1' ? '整拍' : `1/${u}`}×${n}`)
      .join('、')
    if (units) log(`  · 时值单位按小节自适应：${units}`)
    log('  · auto 采样组已按所在红/绿线区域解析；滑条头/折返点/尾按各自毫秒时间分别取区域')
    log('  · 内容完全相同的音色文件已合并为同一个音效代码')
    log(`  · [Files] ImportOsu = "${importOsuRel}"（网格模式格子下方会显示原谱物件时间轴）`)
    return true
  } catch (err) {
    log(`✗ 从 ${filePath} 导入音效失败：${String(err)}`)
    return false
  }
}

/**
 * 从谱面库直接导入一个谱面集（省去「文件 → 导入」那几步）。
 *
 * @param dir 谱面集文件夹（Songs 下的一层）
 * @param knownDifficulties 列表里已经拿到的难度清单，省一次目录扫描
 */
export async function importMapset(dir: string, knownDifficulties?: { path: string }[]): Promise<void> {
  const api = desktopApi()
  if (!api) {
    log('浏览器模式无法读取 osu! Songs 目录，请用「从 .osu 导入音效」')
    return
  }
  let files = (knownDifficulties || []).map((d) => d.path).filter((p) => /\.osu$/i.test(p))
  if (!files.length) {
    const listed = await api.listDir(dir, { exts: ['.osu'], maxFiles: 64 })
    files = (listed.files || [])
      .map((f) => f.path)
      .filter((p) => /\.osu$/i.test(p))
      .sort((a, b) => a.localeCompare(b))
  }
  if (!files.length) {
    log(`✗ 该谱面集里没有 .osu 文件：${dir}`)
    return
  }
  await importOsuFile(files[0])
}

/**
 * 从 .osu 导入音效，生成一份可编辑的 .hs。
 *
 * .osu 全程只读：不共享文件句柄、不 attachPath，保存只会写出新的 .hs。
 * 若不选文件，则直接创建一份空白音效谱。
 */
export async function importOsuSounds() {
  const picked = await pickOsuFiles()
  if (!picked.length) {
    const id = useStore.getState().addFile('untitled.hs', blankHitsoundHs())
    useStore.getState().setActive(id)
    log('未选择 .osu，已创建空白音效谱')
    return
  }

  for (const p of picked) {
    if (p.path) await importOsuFile(p.path)
    else {
      // 浏览器模式：只有 File 对象，没有磁盘路径，走不了难度选择器
      const text = await p.file.text()
      if (!(await verifyOsuText(text, p.name))) continue
      const env = desktopOsuEnv('', '', p.name)
      const ex = await extractOsuSounds(text, env)
      const out = renderOsuSoundsHs(ex, {
        path: '',
        codeColors: planDefaultColors(ex.codes, loadComboColors()),
      })
      const r = { ...ex, ...out }
      const id = useStore.getState().addFile(ensureHsExt(p.name), r.text)
      useStore.getState().setActive(id)
      log(`已从 ${p.name} 导入音效`)
    }
  }
}

/**
 * 「把这个音频文件加进 [Define]」的统一入口：音效库的 + 按钮和
 * 直接拖进窗口的 .wav / .ogg 都走这里 —— 弹窗、校验、写回、绑定样本完全一致。
 *
 * 返回 false 表示用户取消（或者没有打开的谱面）。
 */
/**
 * 谱面里已经用掉的代号 → 现在的定义。
 * 弹窗拿它做「替换」提示，也会用它的槽位/颜色给同名代号预填。
 */
function existingDefsOf(doc: ChartDoc): Record<string, ExistingDef> {
  const existing: Record<string, ExistingDef> = {}
  for (const h of doc.hitsounds) {
    if (!h.name) continue
    const slotText = slotLabel(h)
    existing[h.name] = {
      slots: h.alts.filter((a) => !a.custom && a.sampleSet && a.hitType).map((a) => `${a.sampleSet}-${a.hitType}`),
      color: h.color,
      line: `hitsound ${slotText} ${h.name} = ${h.value}${h.color ? ` ${h.color.toUpperCase()}` : ''}`,
    }
  }
  return existing
}

export async function addSoundFileDialog(file: { name: string; path: string }): Promise<boolean> {
  const s = useStore.getState()
  const active = s.files.find((x) => x.id === s.activeId)
  if (!active) {
    log('✗ 没有打开的谱面，先打开或新建一份再添加音效')
    return false
  }
  // 用当前正文重新解析一份：切谱/刚改过时 store 里的 doc 可能还差 180ms
  const doc = parseChart(active.content, { baseDir: active.path ? dirname(active.path) : undefined })

  /**
   * 文件层面重复：同一份音频已经挂在某个代号上了。
   * 这种情况基本都不是用户想要的（一个音色不用定义两次），先拦一下。
   */
  const dup = await findDuplicateSound(doc, file.path)
  if (dup) {
    log(`✗ 音效已存在：${file.name} → 代号 ${dup}`)
    const api = desktopApi()
    await api?.messageBox({
      type: 'info',
      buttons: ['知道了'],
      defaultId: 0,
      cancelId: 0,
      title: '该音效已存在',
      message: `该音效已存在，代号为 ${dup}`,
      detail: `${file.name} 和 [Define] 里 ${dup} 用的是同一个文件。`,
    })
    return false
  }

  const existing = existingDefsOf(doc)
  // 文件名本身就是槽位（soft-hitnormal.wav / default.normal-hitclap.wav）时先把槽位勾上
  const guess = slotFromFileName(file.name)
  const plan = await pickAddSound({
    fileName: file.name,
    existing,
    initial: guess ? { slots: [guess] } : undefined,
  })
  if (!plan) return false
  // 替换已有代号时保留它的副槽位（弹窗只编辑主槽位）
  const oldDef = doc.hitsounds.find((h) => h.name === plan.name)
  return addHitsoundDefine({
    fileName: file.name,
    filePath: file.path,
    slots: plan.slots,
    name: plan.name,
    color: plan.color,
    subSlots: oldDef?.subSlots,
  })
}

/**
 * 把一行 hitsound 定义写进当前谱面的 [Define]。
 *
 * 代号已经存在时**原地替换**那一行：行号、顺序都不变，
 * 正文里引用这个代号的地方自动指向新音效。
 */
function writeDefineLine(line: string, nm: string): { ok: boolean; replacing: boolean } {
  const s = useStore.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  if (!f) {
    log('✗ 没有打开的谱面，先新建或导入一份再加音效')
    return { ok: false, replacing: false }
  }
  if (!isCodeName(nm)) {
    log(`✗ 代号 "${nm}" 不符合命名规则（只能用英文字母，大小写不限）`)
    return { ok: false, replacing: false }
  }
  // 用当前正文重新解析：store 里的 doc 有 180ms 防抖，刚编辑过代码时位置/路径
  // 可能还是旧的，直接按旧位置替换会切到别的定义行（表现就是“样本路径被改了”）。
  const doc = parseChart(f.content, { baseDir: f.path ? dirname(f.path) : undefined })
  const replacing = doc.hitsounds.find((h) => h.name === nm)

  if (replacing) {
    s.updateContent(f.id, f.content.slice(0, replacing.from) + line + f.content.slice(replacing.to))
    return { ok: true, replacing: true }
  }

  const lines = f.content.split('\n')
  const isSection = (l: string) => /^\s*\[[A-Za-z][A-Za-z0-9]*\]\s*$/.test(l)
  const di = lines.findIndex((l) => /^\s*\[Define\]\s*$/i.test(l))
  if (di >= 0) {
    let end = di + 1
    while (end < lines.length && !isSection(lines[end])) end++
    let at = end
    while (at > di + 1 && !lines[at - 1].trim()) at--
    lines.splice(at, 0, line)
  } else {
    // 没有 [Define]：放在 [Files] 段之后，找不到 [Files] 就放文件开头
    const fi = lines.findIndex((l) => /^\s*\[Files\]\s*$/i.test(l))
    let at = 0
    if (fi >= 0) {
      at = fi + 1
      while (at < lines.length && !isSection(lines[at])) at++
    }
    lines.splice(at, 0, '', '[Define]', line)
  }
  s.updateContent(f.id, lines.join('\n'))
  return { ok: true, replacing: false }
}

/**
 * 往当前谱面的 [Define] 里加一条提示音定义（音效库上半层的 + 按钮）。
 *
 * 代号已经用过时不是拒绝，而是**原地替换**那一条定义：行号、顺序都不变，
 * 正文里引用这个代号的地方自动换成新音效（弹窗里会先给用户看「原来 / 换成」）。
 *
 * 路径优先写成相对 [Files] path 的形式（音效就在谱面目录树里时），否则写绝对路径；
 * 写完顺手把样本绑定到这个代号，能立刻试听。
 */
export async function addHitsoundDefine(opts: {
  fileName: string
  filePath: string
  slots: string[]
  name: string
  /** 可选颜色（#RRGGBB / 英文名 / 已归一化的 hex），不填就写在默认色上 */
  color?: string
  /** 复制已有音效时一并带过去的副槽位 */
  subSlots?: SubSlot[]
}): Promise<boolean> {
  const s = useStore.getState()
  const nm = opts.name.trim()
  const active = s.files.find((x) => x.id === s.activeId)
  if (!active) {
    log('✗ 没有打开的谱面，先新建或导入一份再加音效')
    return false
  }
  // 同上：刚编辑过 [Files] path / [Define] 时，store 里的 doc 可能还没跟上
  const freshDoc = parseChart(active.content, { baseDir: active.path ? dirname(active.path) : undefined })

  // 路径：在 [Files] path 目录树里就写相对路径，否则写绝对路径
  const root = String(freshDoc.settings.Path || freshDoc.baseDir || '')
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const abs = opts.filePath.replace(/\\/g, '/')
  let value = abs
  if (root && abs.toLowerCase().startsWith(root.toLowerCase() + '/')) value = abs.slice(root.length + 1)

  const mainSlot = opts.slots.length ? opts.slots.join('|') : 'custom'
  const subs = (opts.subSlots || []).filter((x, i, arr) => arr.indexOf(x) === i)
  const slot = subs.length ? `${mainSlot}|${subs.join('|')}` : mainSlot
  // 颜色是可选的第五段：`... = "x.wav" #FF0000`；认不出来就当没填（默认色）
  const color = opts.color ? parseColorToken(opts.color) : null
  /**
   * 同一个代号再次选到**同一个文件**时，保留用户原来的写法：
   * 原来写的是 `sub/foo.ogg` 就还写相对路径，原来写绝对路径也照旧。
   * 否则每次“换文件”都会把相对/绝对、斜杠风格来回改一遍。
   */
  const old = freshDoc.hitsounds.find((h) => h.name === nm && h.kind === 'hitsound')
  const sameFile =
    !!old &&
    !!old.resolvedPath &&
    old.resolvedPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
      abs.replace(/\/+$/, '').toLowerCase()
  const valueText = sameFile ? old!.value : `"${value}"`
  const line = `hitsound ${slot} ${nm} = ${valueText}${color ? ` ${color.toUpperCase()}` : ''}`

  const w = writeDefineLine(line, nm)
  if (!w.ok) return false

  // 顺手绑定样本：立刻能试听，导出/自动载入也认得它
  try {
    const bin = await desktopApi()?.readBinary(opts.filePath)
    if (bin?.ok && bin.data) {
      const file = new File([bin.data as BlobPart], opts.fileName)
      await engine.bindSample(nm, file)
      const b = { ...useStore.getState().bindings }
      b[nm] = { name: nm, fileName: opts.fileName, size: file.size, auto: true }
      useStore.getState().setBindings(b)
    }
  } catch {
    /* 绑定失败不影响 [Define] 写入 */
  }

  log(
    `${w.replacing ? '已替换音效' : '已添加音效'}：${line}${
      (sameFile ? !/^["']?(?:[A-Za-z]:[\\/]|[\\/])/.test(old!.value) : value !== abs)
        ? '（相对 [Files] path）'
        : ''
    }`,
  )
  return true
}

/**
 * 往 [Define] 里加一条**内置默认音效**定义：`= default.xxx`（不带引号，解析器按前缀识别）。
 *
 * 音效库下半层的 + 用它：不涉及磁盘文件，所以不用绑定样本 ——
 * 解析后 App 会把 defaultRef 塞给引擎，试听/导出都用内置 wav。
 */
export async function addBuiltinSoundDefine(opts: {
  /** 内置音效引用名，如 normal-hitnormal */
  ref: string
  slots: string[]
  name: string
  color?: string
  subSlots?: SubSlot[]
}): Promise<boolean> {
  const nm = opts.name.trim()
  const mainSlot = opts.slots.length ? opts.slots.join('|') : 'custom'
  const subs = (opts.subSlots || []).filter((x, i, arr) => arr.indexOf(x) === i)
  const slot = subs.length ? `${mainSlot}|${subs.join('|')}` : mainSlot
  const color = opts.color ? parseColorToken(opts.color) : null
  const line = `hitsound ${slot} ${nm} = default.${opts.ref}${color ? ` ${color.toUpperCase()}` : ''}`

  const w = writeDefineLine(line, nm)
  if (!w.ok) return false
  log(`${w.replacing ? '已替换音效' : '已添加音效'}：${line}（内置默认音效）`)
  return true
}

export interface DefineEditResult {
  ok: boolean
  /** 失败原因（ok=false 时有） */
  error?: string
  /** 正文里同步改掉的引用数（改名时才有） */
  changes?: number
}

/**
 * 改一条 hitsound 定义：槽位和 / 或代号。
 *
 * 改代号时会**同步改正文**：[Hitsound] 段里所有独立的代号 token（`Aa`、
 * `[Aa Ab]`、`Aa<v=80>` 都算）一起换掉；`Aab` 这种别的代号不会被误伤。
 * 只动这一行定义 + [Hitsound] 段，[Keysound] 与其它段落不碰。
 */
export function editHitsoundDefine(
  code: string,
  opts: { name?: string; slots?: string[]; color?: string | null } = {},
): DefineEditResult {
  const s = useStore.getState()
  const f = s.files.find((x) => x.id === s.activeId)
  if (!f) return { ok: false, error: t('没有打开的谱面，先打开或新建一份') }

  // 用正文重新解析：store 里的 doc 可能还差 180ms
  const res = editHitsoundDefineText(f.content, code, opts, f.path ? dirname(f.path) : undefined)
  if (!res.ok || res.text === undefined) {
    const nextName = (opts.name ?? code).trim()
    const msg =
      res.error === 'notFound'
        ? t('找不到代号 {name}', { name: code })
        : res.error === 'dup'
          ? t('代号 {name} 已经被占用', { name: nextName })
          : res.error === 'badName'
            ? t('代号只能用英文字母，大小写不限')
            : res.error === 'badColor'
              ? t('颜色看不懂：写 #RRGGBB 或 red / green / blue…')
              : t('这一行不是标准的 hitsound 定义，改不了')
    return { ok: false, error: msg }
  }

  if (res.text !== f.content) s.updateContent(f.id, res.text)
  const name = (opts.name ?? code).trim()
  log(
    res.changes
      ? t('已更新音效 {name}：正文同步了 {n} 处', { name, n: res.changes })
      : t('已更新音效 {name}', { name }),
  )
  return { ok: true, changes: res.changes ?? 0 }
}

/** 音效库下半层的 +：先选槽位/代号，再把 `default.xxx` 写进 [Define] */
export async function addBuiltinSoundDialog(ref: string): Promise<boolean> {
  const s = useStore.getState()
  const active = s.files.find((x) => x.id === s.activeId)
  if (!active) {
    log('✗ 没有打开的谱面，先打开或新建一份再添加音效')
    return false
  }
  // 用当前正文重新解析一份：切谱/刚改过时 store 里的 doc 可能还差 180ms
  const doc = parseChart(active.content, { baseDir: active.path ? dirname(active.path) : undefined })
  // `default.soft-hitnormal` 这种引用名本身就带着槽位，弹窗里直接勾上
  const guess = slotFromFileName(`default.${ref}`)
  const plan = await pickAddSound({
    fileName: `default.${ref}`,
    existing: existingDefsOf(doc),
    value: `default.${ref}`,
    initial: guess ? { slots: [guess] } : undefined,
  })
  if (!plan) return false
  const oldDef = doc.hitsounds.find((h) => h.name === plan.name)
  return addBuiltinSoundDefine({
    ref,
    slots: plan.slots,
    name: plan.name,
    color: plan.color,
    subSlots: oldDef?.subSlots,
  })
}

/**
 * 把当前谱面某个代号引用的音频「复制」到另一个已经打开的谱面。
 *
 * 流程和需求一致：
 *   1. 弹窗列出其他已打开的谱面；
 *   2. 切到选中的谱面（相当于点它的标签）；
 *   3. 弹出「输入代号 + 选槽位」窗口（和 + 按钮 / 拖入音频同一个），
 *      代号、槽位、颜色预填源谱里的定义；
 *   4. 确认后照常写入目标谱面的 [Define]，并绑定样本。
 *
 * 音频文件不复制、不移动：目标谱面直接引用同一个文件（和从别处导入一致）。
 */
export async function copySoundToOtherChart(code: string): Promise<boolean> {
  const api = desktopApi()
  if (!api) {
    log('浏览器模式读不到磁盘上的音频，没法把音效带到别的谱面')
    return false
  }
  const s = useStore.getState()
  const active = s.files.find((f) => f.id === s.activeId)
  if (!active) return false
  // 用当前正文重新解析一份：刚改过 [Define] 时 store 里的 doc 可能还差 180ms
  const doc = parseChart(active.content, { baseDir: active.path ? dirname(active.path) : undefined })
  const def = doc.hitsounds.find((h) => h.name === code)
  if (!def) {
    log(`✗ 当前谱面里没有代号 ${code}`)
    return false
  }
  if (def.kind !== 'hitsound') {
    log(`✗ ${code} 是 keysound 定义，暂不支持复制到其他谱面`)
    return false
  }
  if (def.defaultRef || !def.path || !def.resolvedPath) {
    log(`✗ ${code} 用的是内置 default 音效，没有可以带过去的文件`)
    return false
  }
  if (def.keyFiles && def.keyFiles.size) {
    log(`✗ ${code} 是 keysound 多文件定义，暂不支持复制到其他谱面`)
    return false
  }
  const filePath = def.resolvedPath
  if (!/^[A-Za-z]:[\\/]/.test(filePath) && !filePath.startsWith('\\\\') && !filePath.startsWith('/')) {
    log(`✗ ${code} 的路径还是相对路径（这份谱面没保存过），先保存一次再复制`)
    return false
  }
  const exists = await api.exists(filePath)
  if (!exists.exists) {
    log(`✗ 找不到 ${code} 的音频文件：${filePath}`)
    await api.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '找不到音效文件',
      message: `${code} 指向的文件不存在`,
      detail: filePath,
    })
    return false
  }
  const fileName = basename(filePath)

  const others = s.files.filter((f) => f.id !== s.activeId)
  if (!others.length) {
    log('✗ 没有其他打开的谱面可以接收这个音效')
    await desktopApi()?.messageBox({
      type: 'info',
      buttons: ['知道了'],
      title: '没有其他谱面',
      message: '先把要接收音效的谱面也打开',
      detail: '顶部标签栏里至少要再有一份谱面（打开 .hs / 从 .osu 导入都行）。',
    })
    return false
  }

  const slots = def.alts
    .filter((a) => !a.custom && a.sampleSet && a.hitType)
    .map((a) => `${a.sampleSet}-${a.hitType}`)
  const charts = others.map((f) => {
    const d = parseChart(f.content, { baseDir: f.path ? dirname(f.path) : undefined })
    return {
      id: f.id,
      name: f.name,
      path: f.path,
      defines: d.hitsounds.filter((h) => h.name).length,
      events: d.events.length,
    }
  })
  const targetId = await pickChart({ title: `将音效 ${code} 复制到…`, charts })
  if (!targetId) return false

  const target = useStore.getState().files.find((f) => f.id === targetId)
  if (!target) return false
  // 和点标签一样切过去；setActive 会同步把 doc 换成目标谱面
  useStore.getState().setActive(targetId)

  /** 目标谱面已有的代号：弹窗里显示「替换」提示，并允许沿用它们的槽位 */
  const existing: Record<string, ExistingDef> = {}
  for (const h of useStore.getState().doc.hitsounds) {
    if (!h.name) continue
    const slotText = slotLabel(h)
    existing[h.name] = {
      slots: h.alts.filter((a) => !a.custom && a.sampleSet && a.hitType).map((a) => `${a.sampleSet}-${a.hitType}`),
      color: h.color,
      line: `hitsound ${slotText} ${h.name} = ${h.value}${h.color ? ` ${h.color.toUpperCase()}` : ''}`,
    }
  }

  const plan = await pickAddSound({
    fileName,
    existing,
    initial: {
      name: code,
      slots,
      color: def.color ? def.color.toUpperCase() : undefined,
    },
  })
  if (!plan) {
    log(`已切到 ${target.name}，取消复制音效 ${code}`)
    return false
  }
  return addHitsoundDefine({
    fileName,
    filePath,
    slots: plan.slots,
    name: plan.name,
    color: plan.color,
    subSlots: def.subSlots,
  })
}

/** 新建谱面 */
export function newChart() {
  useStore.getState().newFile('new.hs', applyChartSettingsToText(TEMPLATE))
  log('已新建谱面')
}

/** 打开示例谱面 */
export function openDemo() {
  const s = useStore.getState()
  const f = s.files.find((x) => x.name === 'example.hs')
  if (f) {
    s.updateContent(f.id, DEMO)
    s.setActive(f.id)
  } else s.newFile('example.hs', DEMO)
  log('已载入示例谱面')
}

// ---------------- 导出 ----------------

/** 导出内容：Electron 下弹保存对话框直接写盘，浏览器下走下载 */
async function exportText(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const api = desktopApi()
  if (!api) {
    download(filename, content, mime)
    log(`已导出 ${filename}`)
    return
  }
  const res = await api.saveFile({ name: filename, title: `导出 ${filename}` })
  if (res.canceled || !res.path) return
  if (!(await guardOverwrite(res.path))) return
  const r = await api.writeText(res.path, content)
  if (r.ok) writtenThisSession.add(res.path)
  log(r.ok ? `✓ 已导出 ${res.path}` : `✗ 导出失败：${r.error}`)
}

export function exportOsu() {
  const doc = useStore.getState().doc
  const plan = planOsuExport(doc, { slotOrder: loadExportPrefs().slotOrder })
  if (plan.errors.length) {
    log(`✗ 有 ${plan.errors.length} 个音效槽位问题，先处理再导出：`)
    for (const e of plan.errors.slice(0, 8)) log('  ' + e)
    return
  }
  // 和「导出音效包」用同一套命名规则，别再默认成 hitsound.osu
  return exportText(osuFileName(doc), plan.text)
}

/**
 * 导出音效包：.osu（[HitObjects] 已填）+ 按标准名复制/混音的 .wav。
 * 浏览器模式下只能下载 .osu，音效文件需要用户自己处理。
 */
export async function exportOsuPackage() {
  const api = desktopApi()
  const doc = useStore.getState().doc
  const plan = planOsuExport(doc, { slotOrder: loadExportPrefs().slotOrder })
  if (plan.errors.length) {
    log(t('✗ 有 {n} 个音效槽位问题，先处理再导出：', { n: plan.errors.length }))
    for (const e of plan.errors.slice(0, 8)) log('  ' + e)
    if (plan.errors.length > 8) log('  ' + t('…还有 {n} 条', { n: plan.errors.length - 8 }))
    return
  }
  if (plan.warnings.length) {
    for (const w of plan.warnings.slice(0, 4)) log('⚠ ' + w)
    if (plan.warnings.length > 4) log('  ' + t('…还有 {n} 条提示', { n: plan.warnings.length - 4 }))
  }
  if (doc.hitsounds.some((h) => h.subSlots?.length)) {
    log('提示：副槽位（sliderside/slidertick/successor）只在「把音效写入现有 .osu」时生效；普通导出每个音效都会生成一个圆圈。')
  }
  const dir = String(doc.settings.Path || doc.baseDir || '').replace(/^["']|["']$/g, '').trim()
  if (!dir) {
    log('✗ [Files] path 为空，不知道导出到哪个目录')
    await api?.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '无法导出',
      message: '[Files] 里没有写 path',
      detail: '导出音效包会直接写进 [Files] path 指向的文件夹，请先填好这个路径。',
    })
    return
  }
  if (!api) {
    const name = osuFileName(doc)
    download(name, plan.text, 'text/plain;charset=utf-8')
    log(`已下载 ${name}（浏览器模式不会复制音效文件）`)
    return
  }

  /**
   * 混音提示：同一时刻有多个音效落在同一个槽位上时，导出会把它们叠成一个 wav。
   * 这是有损的（原始分层只在 HSSM 里留了来源），导出前先把「哪个文件、哪些时刻」
   * 列出来让用户确认，别让他事后才发现某个音效被合掉了。
   */
  const mixFiles = plan.files.filter((f) => f.mix)
  if (mixFiles.length) {
    let total = 0
    const lines = mixFiles.map((f) => {
      const codes = (f.mixMeta?.sources || []).map((s) => s.code).filter(Boolean)
      const times = f.mixTimes || []
      total += times.length
      const head = `${f.to}${codes.length ? `（${codes.join(' + ')}）` : ''}`
      const shown = times.slice(0, 8).map((t) => fmtOsuTime(t)).join('、')
      const tail = times.length > 8 ? ` …共 ${times.length} 处` : times.length ? `（共 ${times.length} 处）` : ''
      return `${head}\n  ${shown || '（正文里没有直接落点）'}${tail}`
    })
    log(`⚠ ${mixFiles.length} 个槽位需要混音，共 ${total} 处重复槽位音效：`)
    for (const l of lines.slice(0, 6)) log('  ' + l.replace(/\n\s*/, ' · '))
    if (lines.length > 6) log(`  …还有 ${lines.length - 6} 个槽位`)
    const btn = await api.messageBox({
      type: 'info',
      buttons: ['继续导出', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '导出前确认：需要混音',
      message: `有 ${mixFiles.length} 个槽位需要混音（${total} 处重复槽位音效）`,
      detail:
        lines.slice(0, 6).join('\n') +
        (lines.length > 6 ? `\n…还有 ${lines.length - 6} 个槽位` : '') +
        '\n\n混音 = 把同一时刻叠在同一个槽位上的音效合成一个 wav。' +
        '\n导出文件里会写 HSSM 标记，重新导入这份 .osu 时能拆回原来的代号。',
    })
    if (btn !== 0) {
      log('已取消导出（没有写任何文件）')
      return
    }
  }

  const prefs = loadExportPrefs()
  const r = await api.exportOsuPackage({
    dir,
    artist: doc.metadata.Artist || doc.metadata.ArtistUnicode || '',
    title: doc.metadata.Title || doc.metadata.TitleUnicode || '',
    creator: doc.metadata.Creator || '',
    text: plan.text,
    cleanOld: prefs.cleanOld,
    files: plan.files,
  })
  if (r.conflict) {
    const list = r.conflicts || []
    log(`✗ 目录里已有 ${list.length} 个同名但内容不同的音效文件，已取消导出：`)
    for (const c of list.slice(0, 10)) log('  ' + c)
    if (list.length > 10) log(`  …还有 ${list.length - 10} 个`)
    await api.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '导出被阻止',
      message: `目录里已有 ${list.length} 个同名但内容不同的音效文件`,
      detail:
        list.slice(0, 12).join('\n') +
        (list.length > 12 ? `\n…还有 ${list.length - 12} 个` : '') +
        '\n\n请把这些文件移出目录后重试。为避免盖掉别人的音效，这次一个文件都没有写。',
    })
    return
  }
  if (!r.ok) {
    log(`✗ 导出失败：${r.error || '未知错误'}`)
    await api.messageBox({
      type: 'error',
      buttons: ['知道了'],
      title: '导出失败',
      message: r.error || '未知错误',
    })
    return
  }
  log(`✓ 已导出 ${r.osuPath}`)
  if (r.removed?.length) log(`  已清理旧导出 ${r.removed.length} 个：${r.removed.slice(0, 3).join('、')}${r.removed.length > 3 ? '…' : ''}`)
  log(
    `  难度 ${r.diff} · 物件 ${plan.objectCount} 个 · 音效组 ${plan.groups.length} 个 · 绿线 ${plan.greenLines} 条 · 新写 ${r.written ?? 0} 个 · 跳过 ${r.skipped ?? 0} 个` +
      (plan.mixCount ? ` · 混音 ${plan.mixCount} 个` : ''),
  )
  for (const e of (r.errors || []).slice(0, 6)) log('  ⚠ ' + e)
}
/**
 * 把当前音效谱直接写进一份现有的 .osu（替代 Mapping Tools 的 Hitsound Copier）。
 *
 * 默认目标是 [Files] ImportOsu 指向的原谱；没有就弹文件选择框。
 * 匹配按物件节点的毫秒时间（滑条头 / 折返点 / 滑条尾 / 转盘尾），
 * 音效文件按导出音效包同一套规则复制/混音到目标谱所在文件夹。
 */
export async function writeOsuHitsounds(): Promise<boolean> {
  const api = desktopApi()
  const doc = useStore.getState().doc
  if (!api) {
    log('✗ 浏览器模式不能直接写 .osu，请在桌面版里用这个功能')
    return false
  }

  // 目标：优先用 [Files] ImportOsu，没有就让用户挑
  let target = doc.importOsuPath || ''
  if (!target) {
    const picked = await api.openFiles({
      title: '选择要写入音效的 .osu',
      defaultPath: doc.baseDir || undefined,
      filters: [{ name: 'osu! 谱面', extensions: ['osu'] }],
      properties: ['openFile'],
    })
    if (picked.canceled || !picked.files.length) return false
    target = picked.files[0].path
  }
  const targetName = basename(target)
  const rd = await api.readText(target)
  if (!rd.ok || !rd.text) {
    log(`✗ 读取目标谱失败：${rd.error || target}`)
    return false
  }
  if (!(await verifyOsuText(rd.text, targetName))) return false

  // 目标谱已经占用的编号留出来，新音效组从后面排，避免盖掉它自己的音效
  const reserved = collectOsuSampleIndices(rd.text)
  const plan = planOsuExport(doc, {
    slotOrder: loadExportPrefs().slotOrder,
    reservedIndices: reserved,
  })
  // 「没有合法槽位」的叠音组合（w/f/c 来自不同采样组）在 osu 里无法表示：
  // 可以确认后跳过它们，其余音效照常写入；其它错误（缺定义等）仍然直接拦下。
  const skipped = plan.skippedCombos
  const skippedTimes = skipped.reduce((n, c) => n + c.count, 0)
  const noSlot = new Set(plan.noSlotErrors)
  const fatal = plan.errors.filter((e) => !noSlot.has(e))
  if (fatal.length) {
    log(t('✗ 有 {n} 个音效槽位问题，先处理再写入：', { n: fatal.length }))
    for (const e of fatal.slice(0, 8)) log('  ' + e)
    return false
  }
  const hasGlobalSub = doc.hitsounds.some(
    (h) => !h.name && h.subSlots?.some((x) => x === 'sliderside' || x === 'slidertick'),
  )
  if (!plan.samples.size && !hasGlobalSub) {
    log('✗ 这份音效谱里没有音效，没什么可写入的')
    return false
  }
  if (skipped.length) {
    const btn0 = await api.messageBox({
      type: 'warning',
      buttons: ['仍然写入（跳过这些组合）', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '部分音效无法写入',
      message: `${skipped.length} 个叠音组合没有合法槽位，共 ${skippedTimes} 个时刻不会写入`,
      detail:
        skipped
          .slice(0, 8)
          .map((c) => `[${c.names.join(' ')}] × ${c.count}（最早 ${fmtOsuTime(c.time)}）`)
          .join('\n') +
        (skipped.length > 8 ? `\n…还有 ${skipped.length - 8} 个` : '') +
        '\n\n这些组合里的 w/f/c 来自不同 soft/normal/drum 采样组，' +
        'osu 的一个物件只能写一个采样组，无法同时表达。\n' +
        '继续写入会跳过它们，其余音效正常写入。',
    })
    if (btn0 !== 0) {
      log('已取消写入 .osu')
      return false
    }
  }

  /**
   * 副槽位：主槽位落不到目标谱节点上的音效，按 slidertick > sliderside > successor
   * 的固定优先级处理。结果会删掉对应的 samples，并补绿线/音效文件。
   */
  const targetTimeline = parseOsuTargetTimeline(rd.text)
  const sub = planSubSlots(doc, plan.samples, targetTimeline, {
    usedIndices: [...plan.groups.map((g) => g.index), ...reserved],
  })
  const samples = sub.samples
  const exportFiles = [...plan.files, ...sub.files]

  const allowEmpty = hasGlobalSub || sub.placements.length > 0
  const basePatch = patchOsuText(rd.text, samples, { extraMoves: sub.moves, allowEmpty })
  if (!basePatch.ok) {
    log(`✗ 无法写入：${basePatch.error || '未知错误'}`)
    return false
  }
  const st = basePatch.stats
  const subCount = sub.placements.length
  if (!st.matchedTimes && !subCount && !sub.globalCount) {
    log(`✗ 目标谱里没有任何时间点和音效谱对上（共 ${st.eventTimes} 个时刻）`)
    log('  检查一下 ImportOsu 是不是同一份谱，或者物件时间是否被改过')
    return false
  }

  const tickCount = sub.placements.filter((p) => p.slot === 'slidertick').length
  const sideCount = sub.placements.filter((p) => p.slot === 'sliderside').length
  const succCount = sub.placements.filter((p) => p.slot === 'successor').length
  const missing = st.missingCount
    ? `${st.missingCount} 个（最早 ${fmtOsuTime(st.missingTimes[0])} 等）`
    : '0 个'
  const detail = [
    `目标：${target}`,
    `匹配：${st.matchedTimes}/${st.eventTimes} 个时刻 · ${st.objectsPatched} 个物件 / ${st.nodesPatched} 个节点（滑条边缘 ${st.edgeNodesPatched} 个）`,
    ...(subCount
      ? [`副槽位：${subCount} 个（滑条点 ${tickCount} / 滑条身 ${sideCount} / 后继 ${succCount}）`]
      : []),
    ...(sub.globalCount ? [`全局白板副槽位：${sub.globalCount} 个文件`] : []),
    `未匹配：${missing}`,
    `音效组 ${plan.groups.length} 个 · 需要复制/混音 ${exportFiles.length} 个文件${plan.mixCount ? `（${plan.mixCount} 个混音槽位）` : ''}`,
    ...(skipped.length ? [`跳过：${skipped.length} 个无法表示的叠音组合（${skippedTimes} 个时刻）`] : []),
    '',
    '「另存为新难度」会在同目录生成一份带 [HS] 的 .osu，原文件不动；',
    '「覆盖原文件」会先把原 .osu 备份成 .bak。',
  ].join('\n')
  const btn = await api.messageBox({
    type: 'info',
    buttons: ['另存为新难度…', '覆盖原文件（备份 .bak）', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '把音效写入 .osu',
    message: st.eventTimes + subCount
      ? `${targetName}：${st.matchedTimes + subCount}/${st.eventTimes + subCount} 个时刻可写入`
      : `${targetName}：写全局副槽位 ${sub.globalCount} 个文件`,
    detail,
  })
  if (btn === 2 || btn < 0) {
    log('已取消写入 .osu')
    return false
  }
  const overwrite = btn === 1

  let outPath = target
  let version = ''
  let backup = overwrite
  if (!overwrite) {
    const origVersion = /^Version:(.*)$/m.exec(rd.text)?.[1]?.trim() || ''
    const defaultName = targetName.replace(/\.osu$/i, '') + ' [HS].osu'
    const save = await api.saveFile({
      title: '写入音效到 .osu',
      name: defaultName,
      defaultPath: joinDir(dirname(target), defaultName),
      filters: [{ name: 'osu! 谱面', extensions: ['osu'] }],
    })
    if (save.canceled || !save.path) return false
    outPath = save.path
    version = basename(outPath).replace(/\.osu$/i, '') || `${origVersion} [HS]`
    // 用户如果在保存框里直接选中了原文件，也得先备份
    if (outPath.toLowerCase() === target.toLowerCase()) backup = true
  }

  const patch = patchOsuText(rd.text, samples, {
    ...(overwrite ? {} : { version }),
    extraMoves: sub.moves,
    allowEmpty,
  })
  if (!patch.ok || !patch.text) {
    log(`✗ 生成目标谱失败：${patch.error || '未知错误'}`)
    return false
  }

  const dir = dirname(outPath)
  if (!dir) {
    log(`✗ 无法确定输出目录：${outPath}`)
    return false
  }
  const r = await api.exportOsuPackage({
    dir,
    osuPath: outPath,
    backup,
    version,
    text: patch.text,
    files: exportFiles,
    artist: doc.metadata.Artist || '',
    title: doc.metadata.Title || '',
    creator: doc.metadata.Creator || '',
    cleanOld: false,
  })
  if (r.conflict) {
    const list = r.conflicts || []
    log(`✗ 目标目录里已有 ${list.length} 个同名但内容不同的音效文件，已取消：`)
    for (const c of list.slice(0, 10)) log('  ' + c)
    await api.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '写入被阻止',
      message: `目录里已有 ${list.length} 个同名但内容不同的音效文件`,
      detail:
        list.slice(0, 12).join('\n') +
        '\n\n为避免盖掉现有的音效，这次一个文件都没有写。请把这些文件移出目录后重试。',
    })
    return false
  }
  if (!r.ok) {
    log(`✗ 写入失败：${r.error || '未知错误'}`)
    await api.messageBox({
      type: 'error',
      buttons: ['知道了'],
      title: '写入失败',
      message: r.error || '未知错误',
    })
    return false
  }

  const mixCount = exportFiles.filter((f) => f.mix).length
  log(`✓ 已写入音效：${r.osuPath}`)
  if (backup) log(`  原文件已备份：${target}.bak`)
  log(
    `  ${st.matchedTimes + subCount}/${st.eventTimes + subCount} 个时刻 · ${st.objectsPatched} 个物件 / ${st.nodesPatched} 个节点` +
      (subCount ? ` · 副槽位 ${subCount} 个（滑条点 ${tickCount} / 滑条身 ${sideCount} / 后继 ${succCount}）` : '') +
      ` · 新写 ${r.written ?? 0} 个音效文件 · 跳过 ${r.skipped ?? 0} 个` +
      (mixCount ? ` · 混音 ${mixCount} 个` : ''),
  )
  if (st.missingCount) log(`  ⚠ 有 ${st.missingCount} 个时刻没找到目标物件（例如 ${fmtOsuTime(st.missingTimes[0])}）`)
  if (skipped.length) {
    log(`  ⚠ 跳过了 ${skipped.length} 个无法表示的叠音组合（${skippedTimes} 个时刻）：`)
    for (const c of skipped.slice(0, 8)) log(`    [${c.names.join(' ')}] × ${c.count}`)
  }
  return true
}

export function exportCsv() {
  return exportText(baseName() + '.timeline.csv', toTimelineCsv(useStore.getState().doc), 'text/csv;charset=utf-8')
}
export function exportJson() {
  const b = useStore.getState().bindings
  const map: Record<string, string> = {}
  Object.values(b).forEach((v) => (map[v.name] = v.fileName))
  return exportText(baseName() + '.samples.json', toSampleMapJson(useStore.getState().doc, map), 'application/json')
}
export function exportTxt() {
  return exportText(baseName() + '.samples.txt', toSampleMapText(useStore.getState().doc))
}

/**
 * 打开「谱面文件夹」：[Files] path。
 * 没写 path 时按新规则用 .hs 自己所在的目录（打包后的谱子就是这种形态）。
 */
export async function openChartDir() {
  const api = desktopApi()
  const s = useStore.getState()
  if (!api) {
    log('浏览器模式打不开本地文件夹')
    return
  }
  const dir = String(s.doc.settings.Path || s.doc.baseDir || '')
    .replace(/^["']|["']$/g, '')
    .trim()
  if (!dir) {
    log('✗ 这份谱还没保存过，也没有写 [Files] path，不知道谱面文件夹在哪')
    await api.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '找不到谱面文件夹',
      message: '没有 [Files] path，谱面也还没保存到磁盘',
      detail: '先保存一次 .hs（Ctrl+S），或者在 [Files] 里写 path。',
    })
    return
  }
  const st = await api.exists(dir)
  if (!st.exists) {
    log(`✗ 谱面文件夹不存在：${dir}`)
    await api.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '找不到谱面文件夹',
      message: '这个路径不存在',
      detail: dir,
    })
    return
  }
  const target = st.isFile ? dirname(dir) : dir
  await api.openPath(target)
  log(`已打开谱面文件夹：${target}`)
}

/**
 * 把所有音效复制进谱面文件夹，方便打包发给别人：
 *   1. 每个 [Define] 用到的音频 → 复制成 `<代号>.<扩展名>`（源文件不动）
 *   2. [Define] 里的路径改成新文件名
 *   3. 删掉 [Files] 的 path 行（之后相对 .hs 所在目录解析）
 *   4. .hs 也放进同一个文件夹
 */
export async function bundleSoundsToChartDir() {
  const api = desktopApi()
  if (!api) {
    log('浏览器模式没法复制/移动本地文件，请用桌面版')
    return
  }
  const s0 = useStore.getState()
  let f = s0.files.find((x) => x.id === s0.activeId)
  if (!f) {
    log('✗ 没有打开的谱面')
    return
  }

  // 目标目录：[Files] path（可能相对 .hs 目录）；没写就用 .hs 所在目录
  const rawPath = String(s0.doc.settings.Path || '')
    .replace(/^["']|["']$/g, '')
    .trim()
  const chartDir = f.path ? dirname(f.path) : ''
  const targetDir = rawPath ? resolvePath(chartDir, rawPath) : chartDir
  if (!targetDir) {
    log('✗ 没有 [Files] path，谱面也还没保存过，无法确定往哪个文件夹打包')
    await api.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '无法打包',
      message: '不知道该把音效放到哪个文件夹',
      detail: '先保存一次 .hs（Ctrl+S），或者在 [Files] 里写 path。',
    })
    return
  }
  if (!(await api.exists(targetDir)).exists) {
    log(`✗ 谱面文件夹不存在：${targetDir}`)
    await api.messageBox({
      type: 'warning',
      buttons: ['知道了'],
      title: '无法打包',
      message: '谱面文件夹不存在',
      detail: `${targetDir}\n\n先把 [Files] path 指到一个存在的文件夹。`,
    })
    return
  }

  // 从没存过盘的谱面：先写进目标文件夹，省得之后再挪
  if (!f.path) {
    const dest = joinDir(targetDir, ensureHsExt(f.name))
    if ((await api.exists(dest)).exists) {
      const btn = await api.messageBox({
        type: 'warning',
        buttons: ['覆盖', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '目标已存在同名谱面',
        message: `${basename(dest)} 已经存在`,
        detail: '继续会用当前内容覆盖它。',
      })
      if (btn !== 0) return
    }
    const wr = await api.writeText(dest, f.content)
    if (!wr.ok) {
      log(`✗ 写入谱面失败：${wr.error}`)
      return
    }
    useStore.getState().attachPath(f.id, dest, f.content)
    writtenThisSession.add(dest)
    f = useStore.getState().files.find((x) => x.id === f!.id)!
    log(`已把谱面写入 ${dest}`)
  }

  // 用最新内容重新解析，算出要复制/改写的清单
  const fresh = useStore.getState().files.find((x) => x.id === s0.activeId)!
  const doc = parseChart(fresh.content, { baseDir: fresh.path ? dirname(fresh.path) : undefined })
  const plan = planSoundBundle(doc, fresh.path || '')
  if (!plan.targetDir) {
    log('✗ 解析不出目标文件夹')
    return
  }
  if (!plan.copies.length && !plan.rewritten && !plan.removedPath) {
    log(`这份谱已经收在 ${plan.targetDir} 里了：音效就是代号文件名，[Files] 也没有 path`)
    return
  }

  const preview = plan.copies
    .slice(0, 8)
    .map((c) => `${basename(c.from)} → ${c.fileName}`)
    .join('\n')
  const more = plan.copies.length > 8 ? `\n…还有 ${plan.copies.length - 8} 个` : ''
  const skipNote = plan.skips.length
    ? `\n\n⚠ ${plan.skips.length} 个定义暂时跳过：${plan.skips.map((x) => x.code).join('、')}`
    : ''
  const go = await api.messageBox({
    type: 'question',
    buttons: ['开始打包', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '把所有音效收进谱面文件夹',
    message: `复制 ${plan.copies.length} 个音效到：\n${plan.targetDir}`,
    detail:
      (preview ? `${preview}${more}\n\n` : '') +
      `同时会：改写 [Define] 的路径（${plan.rewritten} 条）、` +
      (plan.removedPath ? '删掉 [Files] 的 path 行、' : '') +
      '把 .hs 放进这个文件夹。\n源文件不会被改名或删除。' +
      skipNote,
  })
  if (go !== 0) return

  // 1) 复制并改名（源文件保持原样）
  let copied = 0
  for (const c of plan.copies) {
    const r = await api.copyFile(c.from, c.to)
    if (!r.ok) {
      log(`✗ 复制失败：${basename(c.from)} → ${c.fileName}（${r.error || '未知错误'}）`)
      await api.messageBox({
        type: 'error',
        buttons: ['知道了'],
        title: '打包中断',
        message: `复制 ${c.code} 时失败`,
        detail: `${r.error || ''}\n\n已复制的 ${copied} 个文件会留在目标文件夹里，谱面没有改动。`,
      })
      return
    }
    copied++
  }

  // 2) .hs 挪进同一个文件夹，再写入改写后的正文
  const chartDest = joinDir(plan.targetDir, basename(fresh.path!))
  const moving = !samePath(fresh.path!, chartDest)
  if (moving) {
    if ((await api.exists(chartDest)).exists) {
      const btn = await api.messageBox({
        type: 'warning',
        buttons: ['覆盖', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '目标已有同名谱面',
        message: `${basename(chartDest)} 已经存在`,
        detail: '继续会覆盖它（音效已经复制完成）。',
      })
      if (btn !== 0) {
        log(`已复制 ${copied} 个音效，但取消了移动 .hs`)
        return
      }
    }
    const mv = await api.moveFile(fresh.path!, chartDest)
    if (!mv.ok) {
      log(`✗ 移动 .hs 失败：${mv.error || '未知错误'}`)
      await api.messageBox({
        type: 'error',
        buttons: ['知道了'],
        title: '打包未完成',
        message: '音效已复制，但 .hs 移动失败',
        detail: `${mv.error || ''}\n\n谱面内容没有改动，仍留在原位置。`,
      })
      return
    }
  }
  const wr = await api.writeText(chartDest, plan.text)
  if (!wr.ok) {
    log(`✗ 写入谱面失败：${wr.error}`)
    return
  }
  useStore.getState().attachPath(fresh.id, chartDest, plan.text)
  writtenThisSession.add(chartDest)

  // 3) 汇报
  log(`✓ 已打包到 ${plan.targetDir}`)
  log(`  复制并改名 ${copied} 个音效${plan.skips.length ? `，跳过 ${plan.skips.length} 个定义` : ''}`)
  log(`  [Define] 改写 ${plan.rewritten} 条 · [Files] path ${plan.removedPath ? '已删除' : '本来就没有'}`)
  log(`  .hs ${moving ? `已移动到 ${chartDest}` : '本来就在这个文件夹里'}`)
  for (const sk of plan.skips.slice(0, 5)) log(`  ⚠ ${sk.code}：${sk.reason}`)
  if (doc.audioPath && !samePath(dirname(doc.audioPath), plan.targetDir)) {
    log(`  ⚠ 歌曲不在这个文件夹里：${doc.audioPath}（发给别人前记得一起带上）`)
  }
  await api.messageBox({
    type: 'info',
    buttons: ['完成'],
    title: '打包完成',
    message: `音效已收进 ${plan.targetDir}`,
    detail:
      `复制并改名 ${copied} 个音效，[Define] 改写 ${plan.rewritten} 条` +
      `${plan.removedPath ? '，[Files] path 已删除' : ''}。\n` +
      (moving ? `谱面已移动到 ${chartDest}` : '谱面本来就在这个文件夹里') +
      (plan.skips.length ? `\n\n还有 ${plan.skips.length} 个定义没处理（见输出面板）。` : ''),
  })
}

// 调试/自动化入口：端到端脚本无法操作原生文件对话框，直接调导入命令
if (typeof window !== 'undefined') {
  ;(window as any).__importOsuFile = importOsuFile
  ;(window as any).__bundleSounds = bundleSoundsToChartDir
  ;(window as any).__openChartDir = openChartDir
  ;(window as any).__writeOsuHitsounds = writeOsuHitsounds
}
