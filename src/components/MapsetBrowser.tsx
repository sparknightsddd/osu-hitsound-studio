/**
 * 侧栏「谱面库」：左栏第 5 个图标。
 *
 * 直接从 osu! Songs 目录读全部谱面集，按 Mapset Verifier 的顺序排
 * （有效修改时间倒序 = 最近动过的在最上面），顶部单列 osu! 当前打开的谱面。
 * 点一行就直接导入，省掉「文件 → 导入 → 挑文件」三步。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconFolder,
  IconMapset,
  IconPlay,
  IconRefresh,
  IconSettings,
} from './Icons'
import { desktopApi, isDesktop, type CurrentMapsetResult, type MapsetEntry } from '../core/desktop'
import {
  currentMapset,
  fmtAgo,
  getSongsFolder,
  listMapsets,
  mapsetLabel,
} from '../core/osuMapsets'
import { importMapset } from '../core/actions'
import { openAppSettings } from './AppSettingsDialog'
import { t } from '../i18n'

const PAGE = 60
/** 带搜索词时一次多取一些：过滤是在服务端按页做的，页太小会漏 */
const PAGE_SEARCH = 300

export default function MapsetBrowser() {
  const [songsFolder, setSongs] = useState('')
  const [items, setItems] = useState<MapsetEntry[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')

  const [cur, setCur] = useState<CurrentMapsetResult | null>(null)
  const [curLoading, setCurLoading] = useState(false)

  const seq = useRef(0)
  const offsetRef = useRef(0)

  /** 拉一页谱面集；reset=true 时从头开始；folderOverride 供「设置里刚改完路径」时立刻用新值 */
  const load = useCallback(
    async (reset: boolean, search: string, folderOverride?: string) => {
      if (!isDesktop()) {
        setError('浏览器模式无法读取 osu! Songs 目录（请用桌面版）')
        return
      }
      const my = ++seq.current
      const useFolder = folderOverride ?? songsFolder
      if (reset) {
        setLoading(true)
        offsetRef.current = 0
      } else {
        setLoadingMore(true)
      }
      setError('')
      const limit = search ? PAGE_SEARCH : PAGE
      const usedOffset = reset ? 0 : offsetRef.current
      const page = await listMapsets({
        songsFolder: useFolder || undefined,
        offset: usedOffset,
        limit,
        search: search || undefined,
      })
      if (my !== seq.current) return
      setLoading(false)
      setLoadingMore(false)
      if (!page.ok) {
        setError(
          page.error === 'songs_folder_not_found'
            ? '没找到 osu! Songs 目录，去「设置」里手动指定'
            : page.error || '读取失败',
        )
        setItems([])
        setTotal(0)
        setHasMore(false)
        return
      }
      if (page.songsFolder && page.songsFolder !== useFolder) setSongs(page.songsFolder)
      // 服务端是按「未过滤的页」推进的，所以这里也推进 limit 而不是命中条数
      offsetRef.current = usedOffset + limit
      setItems((prev) => (reset ? page.mapsets : [...prev, ...page.mapsets]))
      setTotal(page.total)
      setHasMore(page.hasMore)
    },
    [songsFolder],
  )

  const refreshCurrent = useCallback(
    async (folderOverride?: string) => {
      if (!isDesktop()) return
      setCurLoading(true)
      const r = await currentMapset((folderOverride ?? songsFolder) || undefined)
      setCur(r)
      setCurLoading(false)
    },
    [songsFolder],
  )

  // 进入视图时：确定 Songs 目录 → 拉首页 + 读当前谱面
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    let alive = true
    void (async () => {
      const dir = await getSongsFolder()
      if (!alive) return
      setSongs(dir)
      await load(true, '')
      if (!alive) return
      await refreshCurrent()
    })()
    return () => {
      alive = false
    }
    // 只在挂载时跑一次：Songs 目录变化由下面的刷新按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 搜索词防抖
  useEffect(() => {
    if (!booted.current) return
    const t = window.setTimeout(() => void load(true, q), 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const doImport = async (m: MapsetEntry) => {
    setBusy(m.path)
    try {
      await importMapset(m.path, m.difficulties)
    } finally {
      setBusy('')
    }
  }

  const openFolder = (p: string) => {
    void desktopApi()?.openPath(p)
  }

  return (
    <>
      <div className="ms-bar">
        <input
          className="ms-search"
          placeholder={t('搜索 标题 / 艺术家 / 创作者')}
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className="icon-btn"
          title={t('刷新列表（会重新读取设置里的 Songs 目录）')}
          onClick={() => {
            void (async () => {
              const dir = await getSongsFolder()
              setSongs(dir)
              await load(true, q, dir)
              await refreshCurrent(dir)
            })()
          }}
        >
          <IconRefresh className="sm" />
        </button>
        <button className="icon-btn" title={t('在设置里修改 Songs 目录')} onClick={() => openAppSettings()}>
          <IconSettings className="sm" />
        </button>
      </div>

      <div className="ms-path mono" title={songsFolder || t('未设置')}>
        <IconMapset className="sm" />
        <span className="ms-path-text">{songsFolder || t('未设置 Songs 目录')}</span>
        {songsFolder && (
          <button className="icon-btn" title={t('在资源管理器中打开')} onClick={() => openFolder(songsFolder)}>
            <IconFolder className="sm" />
          </button>
        )}
      </div>

      {/* ---- osu! 当前打开的谱面 ---- */}
      <div className="section ms-current">
        <h4>
          {t('osu! 当前谱面')}
          <button className="icon-btn" title={t('重新检测')} onClick={() => void refreshCurrent()}>
            <IconRefresh className="sm" />
          </button>
        </h4>
        {curLoading && !cur && <div className="hint">{t('正在检测…')}</div>}
        {cur?.mapset ? (
          <MapsetRow
            m={cur.mapset}
            tag={cur.source === 'editor' ? t('编辑器') : t('正在播放')}
            busy={busy}
            onImport={() => void doImport(cur.mapset!)}
            onOpen={() => openFolder(cur.mapset!.path)}
          />
        ) : (
          <div className="hint">
            {cur?.message || t('点击右侧按钮检测 osu! 当前打开的谱面')}
            {cur?.titles?.length ? (
              <>
                <br />
                {t('窗口标题：')}{cur.titles.join(' / ')}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* ---- 全部谱面集 ---- */}
      <div className="sidebar-title ms-list-head">
        <span>
          {t('全部谱面集 · {n} 个', { n: total })}
          {q ? t('（匹配 {n}）', { n: items.length }) : ''}
        </span>
        <span className="hint">{t('按最近修改排序')}</span>
      </div>

      {error && <div className="ms-msg err">⚠ {error}</div>}
      {loading && <div className="ms-msg">{t('正在读取…')}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="ms-msg">
          {q ? t('没有匹配的谱面集') : t('这个目录里还没有谱面集')}
        </div>
      )}

      <div className="ms-list">
        {items.map((m) => (
          <MapsetRow
            key={m.path}
            m={m}
            busy={busy}
            onImport={() => void doImport(m)}
            onOpen={() => openFolder(m.path)}
          />
        ))}
      </div>

      {hasMore && !loading && (
        <button className="ms-more" disabled={loadingMore} onClick={() => void load(false, q)}>
          {loadingMore ? '正在加载…' : `加载更多（还有 ${Math.max(0, total - items.length)} 个）`}
        </button>
      )}
    </>
  )
}

function MapsetRow({
  m,
  busy,
  tag,
  onImport,
  onOpen,
}: {
  m: MapsetEntry
  busy: string
  tag?: string
  onImport: () => void
  onOpen: () => void
}) {
  const isBusy = busy === m.path
  return (
    <div
      className={`ms-item ${isBusy ? 'busy' : ''}`}
      title={`${m.folder}\n${m.artist} - ${m.title}${m.creator ? ` / ${m.creator}` : ''}\n${m.diffCount} 个难度`}
      onClick={onImport}
    >
      <div className="ms-line1">
        <span className="ms-title">{mapsetLabel(m)}</span>
        {tag ? <span className="ms-tag">{tag}</span> : null}
      </div>
      <div className="ms-line2">
        <span className="ms-sub mono">{m.folder}</span>
        <span className="ms-meta">
          {m.diffCount} 难度{m.mtimeMs ? ` · ${fmtAgo(m.mtimeMs)}` : ''}
        </span>
      </div>
      <div className="act">
        <button
          className="ms-go"
          title={t('在资源管理器中打开')}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          <IconFolder className="sm" />
        </button>
      </div>
      {isBusy && <span className="ms-busy">{t('导入中…')}</span>}
      {!isBusy && (
        <span className="ms-go-hint" title={t('点击直接导入')}>
          <IconPlay className="sm" />
        </span>
      )}
    </div>
  )
}
