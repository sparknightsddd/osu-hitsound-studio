/**
 * 音效库（左侧第 6 个图标）。
 *
 * 读设置里指定的音效文件夹，按**子文件夹树**展示 .wav / .ogg：
 * 点文件夹才展开，里面的文件带 ▶ 试听、+ 添加到 [Define]。
 * 直接放在某一层的文件收在一个「本目录」节点里（和资源管理器那种树一致）。
 *
 * 「+」会弹窗选槽位（可多选，不选=custom）并填代号，见 AddSoundDialog。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { t } from '../i18n'
import { engine } from '../audio/engine'
import { addBuiltinSoundDialog, addSoundFileDialog } from '../core/actions'
import { BUILTIN_SOUND_REFS } from '../core/builtinSounds'
import { desktopApi } from '../core/desktop'
import {
  fmtSize,
  getSoundFolder,
  listSoundFiles,
  setSoundFolder,
  type SoundFileEntry,
} from '../core/soundLibrary'
import { IconFolder } from './Icons'

interface DirNode {
  name: string
  /** 相对音效根目录的路径（根为空串） */
  path: string
  dirs: DirNode[]
  files: SoundFileEntry[]
}

function buildTree(files: SoundFileEntry[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] }
  for (const f of files) {
    const parts = f.relPath.split('/')
    parts.pop()
    let cur = root
    for (const p of parts) {
      let next = cur.dirs.find((d) => d.name === p)
      if (!next) {
        next = { name: p, path: cur.path ? `${cur.path}/${p}` : p, dirs: [], files: [] }
        cur.dirs.push(next)
      }
      cur = next
    }
    cur.files.push(f)
  }
  const sortDir = (d: DirNode) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    d.files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    d.dirs.forEach(sortDir)
  }
  sortDir(root)
  return root
}

function countFiles(d: DirNode): number {
  return d.files.length + d.dirs.reduce((n, c) => n + countFiles(c), 0)
}

/** 过滤后还剩多少个文件（目录行上的计数也跟着筛） */
function countMatches(d: DirNode, key: string): number {
  if (!key) return countFiles(d)
  const self = d.files.filter((f) => f.name.toLowerCase().includes(key)).length
  return self + d.dirs.reduce((n, c) => n + countMatches(c, key), 0)
}

/** 递归判断目录下有没有命中过滤词的文件 */
function dirHasMatch(d: DirNode, key: string): boolean {
  if (!key) return true
  return d.files.some((f) => f.name.toLowerCase().includes(key)) || d.dirs.some((c) => dirHasMatch(c, key))
}

export default function SoundLibrary() {
  const log = useStore((s) => s.log)
  const [folder, setFolder] = useState('')
  const [files, setFiles] = useState<SoundFileEntry[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [playing, setPlaying] = useState('')
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  const booted = useRef(false)

  const load = async (dir: string) => {
    if (!dir) {
      setFiles([])
      return
    }
    setBusy(true)
    setErr('')
    try {
      const r = await listSoundFiles(dir)
      setFiles(r.files)
      // 默认只展开根层：根目录下直接放文件时把「本目录」也展开，否则一片空的
      const tree = r.files.length ? buildTree(r.files) : null
      setOpenKeys(new Set(tree && !tree.dirs.length ? ['#self'] : []))
      if (!r.ok)
        setErr(
          r.error === 'browser'
            ? t('浏览器模式读不到本地文件夹')
            : t('读取失败：{err}', { err: r.error || '' }),
        )
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      const p = await getSoundFolder()
      setFolder(p)
      if (p) await load(p)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tree = useMemo(() => buildTree(files), [files])
  const key = q.trim().toLowerCase()

  const toggle = (k: string) =>
    setOpenKeys((s) => {
      const next = new Set(s)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  /** 展开目录时顺带把它自己的「本目录」也展开 —— 点一下就能看到音效，不用点两次 */
  const toggleDir = (path: string) =>
    setOpenKeys((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        next.add(`${path}#self`)
      }
      return next
    })

  const chooseFolder = async () => {
    const api = desktopApi()
    if (!api) {
      log('✗ 浏览器模式读不到本地文件夹，请用桌面版')
      return
    }
    const r = await api.openFolder({ title: '选择音效文件夹' })
    if (r.canceled || !r.dir) return
    setFolder(r.dir)
    await setSoundFolder(r.dir)
    await load(r.dir)
    log(`音效库目录：${r.dir}`)
  }

  const preview = async (f: SoundFileEntry) => {
    const api = desktopApi()
    if (!api) return
    setPlaying(f.path)
    try {
      const bin = await api.readBinary(f.path)
      if (!bin.ok || !bin.data) {
        log(`✗ 读取失败：${f.name}`)
        return
      }
      const file = new File([bin.data as BlobPart], f.name)
      const ok = await engine.previewFile(file)
      if (!ok) log(`✗ 试听失败（解码不了）：${f.name}`)
    } catch (e) {
      log(`✗ 试听失败：${String(e)}`)
    } finally {
      window.setTimeout(() => setPlaying(''), 350)
    }
  }

  const add = async (f: SoundFileEntry) => {
    // 和「把文件拖进窗口」走同一套：弹窗选槽位/代号 → 写进 [Define] → 绑定样本
    await addSoundFileDialog({ name: f.name, path: f.path })
  }

  /** 下半层的 ▶：试听 public 里的内置 wav，不绑定成任何代号 */
  const previewBuiltin = async (ref: string) => {
    setPlaying(`default:${ref}`)
    try {
      if (ref === 'blank') {
        log(t('default.blank 是官方静音文件，本来就没有声音'))
        return
      }
      const ok = await engine.previewDefault(ref)
      if (!ok) log(`✗ ${t('试听失败')}：default.${ref}`)
    } catch (e) {
      log(`✗ ${t('试听失败')}：${String(e)}`)
    } finally {
      window.setTimeout(() => setPlaying(''), 350)
    }
  }

  /** 下半层的 +：弹窗选槽位/代号，写进 [Define] 的是 `= default.xxx` */
  const addBuiltin = async (ref: string) => {
    await addBuiltinSoundDialog(ref)
  }

  /** 内置默认音效按过滤词筛（不区分大小写，`default.` 前缀也算在内） */
  const builtins = useMemo(
    () => BUILTIN_SOUND_REFS.filter((ref) => !key || `default.${ref}`.includes(key)),
    [key],
  )

  const FileRow = ({ f, depth }: { f: SoundFileEntry; depth: number }) => (
    <div
      className={`sl-item ${playing === f.path ? 'playing' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      title={f.path}
    >
      <div className="sl-name" title={f.name}>
        {f.name}
      </div>
      <span className="sl-size mono">{fmtSize(f.size)}</span>
      <button className="sl-btn" title={t('试听')} onClick={() => void preview(f)}>
        ▶
      </button>
      <button className="sl-btn add" title={t('添加到 [Define]')} onClick={() => void add(f)}>
        +
      </button>
    </div>
  )

  /** 递归渲染：目录行 + 展开后的「本目录」与子目录 */
  const DirView = ({ node, depth }: { node: DirNode; depth: number }) => {
    const selfKey = `${node.path || ''}#self`
    const selfOpen = key ? true : openKeys.has(selfKey)
    const shownFiles = key ? node.files.filter((f) => f.name.toLowerCase().includes(key)) : node.files
    const dirs = node.dirs.filter((d) => dirHasMatch(d, key))
    return (
      <>
        {shownFiles.length > 0 && (
          <>
            <div
              className="sl-folder"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => toggle(selfKey)}
              title={t('直接放在这个目录里的文件')}
            >
              <span className={`sl-chev ${selfOpen ? 'open' : ''}`}>›</span>
              <IconFolder className="sm" />
              <span className="sl-fname">{t('本目录')}</span>
              <span className="sl-count2">{shownFiles.length}</span>
            </div>
            {selfOpen && shownFiles.map((f) => <FileRow key={f.path} f={f} depth={depth + 1} />)}
          </>
        )}
        {dirs.map((d) => {
          const open = key ? true : openKeys.has(d.path)
          return (
            <div key={d.path}>
              <div className="sl-folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggleDir(d.path)}>
                <span className={`sl-chev ${open ? 'open' : ''}`}>›</span>
                <IconFolder className="sm" />
                <span className="sl-fname">{d.name}</span>
                <span className="sl-count2">{countFiles(d)}</span>
              </div>
              {open && <DirView node={d} depth={depth + 1} />}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <>
      <div className="ms-bar">
        <input
          className="ms-search"
          placeholder={t('过滤文件名（会自动展开）')}
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className="icon-btn"
          title={t('重新扫描')}
          onClick={() => void load(folder)}
          disabled={busy || !folder}
        >
          <svg className="i" viewBox="0 0 24 24">
            <path d="M20 12a8 8 0 1 1-2.3-5.6" />
            <path d="M20 4v4h-4" />
          </svg>
        </button>
      </div>

      <div className="ms-path" title={folder || t('未设置')}>
        <span className="ms-path-text mono">{folder || t('未设置音效文件夹')}</span>
        <button className="btn small" onClick={() => void chooseFolder()}>
          {t('选择…')}
        </button>
      </div>

      {err && <div className="ms-msg err">⚠ {err}</div>}
      {busy && <div className="ms-msg">{t('正在读取…')}</div>}
      {!busy && !folder && (
        <div className="ms-msg">
          {t('还没有指定音效文件夹。点上面的「选择…」，或到')} <b>{t('设置 → 音效库')}</b> {t('里填一个目录。')}
        </div>
      )}
      {!busy && folder && !files.length && <div className="ms-msg">{t('这个目录里没有 .wav / .ogg')}</div>}

      {files.length > 0 && (
        <div className="sl-count hint">
          {t('共 {n} 个音效', { n: files.length })}
          {key ? t('（筛出 {n} 个）', { n: countMatches(tree, key) }) : ''}
        </div>
      )}

      <div className="sl-list">
        {files.length > 0 && <DirView node={tree} depth={0} />}

        {/* 分隔线：上面是音效文件夹里的文件，下面换成内置的官方默认音效 */}
        <div
          className="sl-split"
          title={t('编辑器内置的 osu! 官方默认音效，谱面里写成 = default.xxx 就能直接用')}
        >
          <span className="sl-split-label">{t('默认音效')}</span>
          <span className="sl-split-line" />
          <span className="sl-split-count">{builtins.length}</span>
        </div>
        {builtins.map((ref) => (
          <div
            key={ref}
            className={`sl-item builtin ${playing === `default:${ref}` ? 'playing' : ''}`}
            title={`default.${ref}`}
          >
            <div className="sl-name mono" title={`default.${ref}`}>
              {`default.${ref}`}
            </div>
            {ref === 'blank' ? (
              <span className="sl-size sl-badge mute">{t('静音')}</span>
            ) : (
              // 占位：没有徽标时也要占住那一列，否则按钮会往左串
              <span />
            )}
            <button className="sl-btn" title={t('试听')} onClick={() => void previewBuiltin(ref)}>
              ▶
            </button>
            <button className="sl-btn add" title={t('添加到 [Define]')} onClick={() => void addBuiltin(ref)}>
              +
            </button>
          </div>
        ))}
        {!builtins.length && (
          <div className="sl-builtin-empty">{t('没有匹配的默认音效')}</div>
        )}
      </div>
    </>
  )
}
